# SPEC-37 — Disaster Recovery & Multi-Region Strategy

**Version:** 1.0.0
**Status:** AUTHORITATIVE — drop into Claude Code to implement
**Depends on:** SPEC-01 (architecture), SPEC-02 (Lambda+ECS), SPEC-06 (security hardening)
**Related:** SPEC-36 (reliability/SLO), SPEC-38 (data governance), SPEC-41 (FinOps)

---

## 1. Scope & Goals

Single-tenant Skills-as-a-Service is treated as a Tier-1 production service. This spec defines:

- Recovery Time Objective (**RTO**) and Recovery Point Objective (**RPO**) per component
- Backup strategy (AWS Backup + Vault Lock)
- Active/passive multi-region topology (primary `us-east-1`, warm-standby `us-west-2`)
- Failover orchestration (Route 53 + Step Functions)
- Drift detection, drills, runbooks

Non-goals: active/active (cost/complexity not justified at current scale), multi-cloud.

---

## 2. RTO/RPO Per Component

| Tier | Component                  | RPO    | RTO    | Mechanism                                  |
|------|----------------------------|--------|--------|--------------------------------------------|
| T1   | DynamoDB jobs table        | 5 min  | 1 h    | Global Tables + PITR                       |
| T1   | KMS CMKs                   | 0      | 0      | Multi-Region Keys                          |
| T1   | S3 results bucket          | 15 min | 2 h    | CRR + Object Lock + Versioning             |
| T1   | S3 uploads bucket          | 15 min | 2 h    | CRR + Versioning                           |
| T2   | Audit log bucket           | 0      | 1 h    | CRR (synchronous-ish via S3 Replication Time Control) |
| T2   | Secrets Manager            | 5 min  | 30 min | Replication to standby region              |
| T2   | ECR images                 | 1 h    | 0      | Cross-region replication rule              |
| T3   | OpenSearch Serverless idx  | 24 h   | 4 h    | Nightly snapshot → restore on failover     |
| T3   | SQS in-flight messages     | 0      | 30 min | Best-effort drain, idempotent re-submit    |
| T3   | EventBridge rules          | n/a    | 1 h    | CDK redeploys                              |

Anything not listed is reconstructed from CDK + above sources.

---

## 3. Backup Strategy

### 3.1 AWS Backup vault

```ts
// infra/lib/dr/backup-stack.ts
import { Stack, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';

export class BackupStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { mrKey: kms.IKey }) {
    super(scope, id, props);

    const vault = new backup.BackupVault(this, 'PrimaryVault', {
      backupVaultName: 'skills-svc-primary',
      encryptionKey: props.mrKey,
      removalPolicy: RemovalPolicy.RETAIN,
      lockConfiguration: {
        // COMPLIANCE mode: nobody (not even root) can shorten retention
        minRetention: Duration.days(7),
        maxRetention: Duration.days(2557), // ~7 years
        changeableFor: Duration.days(3),    // governance window
      },
    });

    const plan = new backup.BackupPlan(this, 'Plan', { backupVault: vault });
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'daily-35d',
      scheduleExpression: events.Schedule.cron({ hour: '5', minute: '0' }),
      deleteAfter: Duration.days(35),
      copyActions: [{
        destinationBackupVault: backup.BackupVault.fromBackupVaultArn(
          this, 'StandbyVault',
          `arn:aws:backup:us-west-2:${this.account}:backup-vault:skills-svc-standby`),
        deleteAfter: Duration.days(35),
      }],
    }));
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'weekly-12w',
      scheduleExpression: events.Schedule.cron({ weekDay: 'SUN', hour: '5' }),
      deleteAfter: Duration.days(84),
    }));
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'monthly-13m',
      scheduleExpression: events.Schedule.cron({ day: '1', hour: '5' }),
      deleteAfter: Duration.days(395),
    }));
    plan.addRule(new backup.BackupPlanRule({
      ruleName: 'annual-7y',
      scheduleExpression: events.Schedule.cron({ month: '1', day: '1', hour: '5' }),
      deleteAfter: Duration.days(2557),
    }));

    plan.addSelection('Resources', {
      resources: [
        backup.BackupResource.fromTag('skills-svc:backup', 'true'),
      ],
    });
  }
}
```

### 3.2 Monthly restore-and-verify

A Lambda restores the most recent recovery point to a sandbox account, runs a deterministic verification (sample 10 jobs by ID, count rows, hash 100 random S3 objects, ensure parity), publishes `Skills/DR/RestoreVerified` metric, then tears down. Failure pages on-call.

```ts
// packages/lambda/dr-restore-verifier/index.ts
export const handler = async () => {
  const point = await backup.listRecoveryPoints({ BackupVaultName: 'skills-svc-primary' });
  const job  = await backup.startRestoreJob({ /* into sandbox account */ });
  await pollUntilDone(job);
  const ok = await verifyDeterministicSample();
  await cw.putMetricData({
    Namespace: 'Skills/DR',
    MetricData: [{ MetricName: 'RestoreVerified', Value: ok ? 1 : 0 }],
  });
  if (!ok) throw new Error('RESTORE-VERIFY-FAILED');
};
```

---

## 4. Multi-Region Architecture

### 4.1 Topology

```
                  Route 53 (latency + health-check failover)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
       us-east-1 (PRIMARY)         us-west-2 (WARM STANDBY)
        ┌─────────────┐             ┌─────────────┐
        │ S3 uploads  │─── CRR ────▶│ S3 uploads  │
        │ S3 results  │─── CRR ────▶│ S3 results  │
        │ DDB jobs    │◀═ Global ══▶│ DDB jobs    │
        │ KMS CMK ────┼─ MR key ────┼─ KMS CMK    │
        │ ECR images  │── rule ────▶│ ECR images  │
        │ Secrets     │── repl ────▶│ Secrets     │
        │ OS Service  │  snapshot   │ OS Service  │
        │ (HOT)       │   nightly   │ (PAUSED)    │
        │ ECS desired=N│             │ ECS desired=0│
        │ Lambda PC=M │             │ Lambda PC=0  │
        └─────────────┘             └─────────────┘
```

### 4.2 What replicates live vs cold

**Live (continuous):**
- S3 buckets — CRR with RTC (15 min SLA), KMS re-encryption to target-region MRK replica
- DynamoDB — Global Tables, eventual consistency within seconds
- KMS — Multi-Region Keys (`primary` in us-east-1, `replica` in us-west-2; same key material, separate key policies)
- ECR — replication rule, all repos
- Secrets Manager — replication rule

**Cold (snapshot/rebuild on failover):**
- OpenSearch Serverless — nightly snapshot to S3 (CRR'd); standby collection created on demand
- SQS — regional; in-flight drained best-effort
- Lambda/ECS — CDK redeployed to standby (already deployed, idle)

### 4.3 CDK MRK construct

```ts
// infra/lib/dr/mr-key.ts
import { CfnKey } from 'aws-cdk-lib/aws-kms';

export function primaryMrk(scope: Construct, id: string) {
  return new CfnKey(scope, id, {
    multiRegion: true,
    keyPolicy: defaultKeyPolicy(),
    enableKeyRotation: true,
  });
}

export function replicaMrk(scope: Construct, id: string, primaryArn: string) {
  return new CfnReplicaKey(scope, id, {
    primaryKeyArn: primaryArn,
    keyPolicy: defaultKeyPolicy(),
  });
}
```

---

## 5. Failover Orchestration

### 5.1 Route 53 failover

```ts
// infra/lib/dr/dns.ts
const zone = route53.HostedZone.fromLookup(this, 'Z', { domainName: 'skills-svc.example' });

new route53.CfnHealthCheck(this, 'PrimaryHC', {
  healthCheckConfig: {
    type: 'HTTPS',
    fullyQualifiedDomainName: 'api.us-east-1.skills-svc.example',
    resourcePath: '/healthz',
    requestInterval: 30,
    failureThreshold: 3,
  },
});

new route53.ARecord(this, 'PrimaryAlias', {
  zone, recordName: 'api',
  target: route53.RecordTarget.fromAlias(new targets.ApiGateway(primaryApi)),
  setIdentifier: 'primary',
  failover: route53.FailoverType.PRIMARY,
  healthCheckId: primaryHc.attrHealthCheckId,
});
new route53.ARecord(this, 'StandbyAlias', {
  zone, recordName: 'api',
  target: route53.RecordTarget.fromAlias(new targets.ApiGateway(standbyApi)),
  setIdentifier: 'standby',
  failover: route53.FailoverType.SECONDARY,
});
```

### 5.2 Failover Step Function

```json
{
  "Comment": "skills-svc failover orchestration",
  "StartAt": "DeclareFailover",
  "States": {
    "DeclareFailover": {
      "Type": "Task",
      "Resource": "arn:aws:states:::aws-sdk:appconfig:updateConfigurationProfile",
      "Parameters": { "Flag": "writes_enabled", "Region": "us-east-1", "Value": false },
      "Next": "DrainSQS"
    },
    "DrainSQS": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "drain-sqs-primary" },
      "TimeoutSeconds": 300,
      "Next": "PromoteDDB"
    },
    "PromoteDDB": {
      "Type": "Task",
      "Comment": "Global Tables are bidirectional; just flip writer region in app config",
      "Resource": "arn:aws:states:::aws-sdk:appconfig:updateConfigurationProfile",
      "Parameters": { "Flag": "ddb_writer_region", "Value": "us-west-2" },
      "Next": "RestoreOpenSearch"
    },
    "RestoreOpenSearch": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "Parameters": {
        "FunctionName": "os-restore-from-snapshot",
        "Payload": { "region": "us-west-2", "token.$": "$$.Task.Token" }
      },
      "TimeoutSeconds": 14400,
      "Next": "RepointCLI"
    },
    "RepointCLI": {
      "Type": "Task",
      "Resource": "arn:aws:states:::aws-sdk:route53:changeResourceRecordSets",
      "Parameters": { "Comment": "Route 53 health-check auto-fails over; this is belt-and-suspenders weighting." },
      "Next": "SmokeTests"
    },
    "SmokeTests": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": { "FunctionName": "post-failover-smoke" },
      "Retry": [{ "ErrorEquals": ["States.ALL"], "MaxAttempts": 3, "IntervalSeconds": 30 }],
      "Next": "Done"
    },
    "Done": { "Type": "Succeed" }
  }
}
```

Execution is gated by a 2-person SSO-MFA approval recorded in CloudTrail; the state machine is started only after a documented declaration (§9.1).

---

## 6. Data Consistency Under Failover

- **Idempotency keys.** Every CLI upload supplies `Idempotency-Key: <ULID>`. IngestionLambda upserts on DDB with `attribute_not_exists(idempotency_key)`. Replays during/after failover collapse to the same job.
- **S3 Object Lock COMPLIANCE** on results bucket — immutable for the retention period (see SPEC-38). Replication cannot violate immutability.
- **DDB write fencing** — every item carries `region_owner` (`us-east-1` | `us-west-2`); writers use a conditional `region_owner = :expected` derived from AppConfig `ddb_writer_region`. A stale primary that comes back online cannot overwrite standby's writes.
- **OpenSearch divergence window** — up to 24 h of indexed results are lost on failover. Acceptable because the data is *derived* from S3 results, which are CRR'd. A post-failover reindex backfills.

```ts
// packages/shared/ddb/write.ts
export async function putWithFence(item: JobItem) {
  const writerRegion = await appConfig.get<string>('ddb_writer_region');
  if (writerRegion !== process.env.AWS_REGION) {
    throw new Error(`region ${process.env.AWS_REGION} is not the active writer (${writerRegion})`);
  }
  return ddb.put({
    TableName: TABLE,
    Item: { ...item, region_owner: writerRegion },
    ConditionExpression: 'attribute_not_exists(PK) OR region_owner = :w',
    ExpressionAttributeValues: { ':w': writerRegion },
  });
}
```

---

## 7. DR Drills

### 7.1 Cadence
- **Monthly** — restore-and-verify (§3.2), automatic
- **Quarterly** — full game-day: declare a region loss in a sandbox account, run the entire Step Function end-to-end, run a synthetic batch of jobs against the standby, measure actual RTO/RPO
- **Annual** — surprise drill announced 1 h in advance to on-call

### 7.2 Game-day Lambda

```ts
// packages/lambda/dr-gameday/index.ts
export const handler = async (event: { mode: 'sandbox' | 'production'; dryRun: boolean }) => {
  if (event.mode === 'production' && !await twoPersonApproval()) {
    throw new Error('NEED-2P-APPROVAL');
  }
  const t0 = Date.now();
  await sfn.startExecution({ stateMachineArn: FAILOVER_SM, input: JSON.stringify(event) });
  const out = await sfn.waitForExecution(/* ... */);
  const observedRTO = (Date.now() - t0) / 1000;
  const observedRPO = await measureRPO();
  await scorecard({ observedRTO, observedRPO, target: { rto: 14400, rpo: 86400 } });
};
```

### 7.3 Scorecard fields
- declared_at, recovered_at, observed_rto_sec, observed_rpo_sec
- target_rto_sec, target_rpo_sec, slo_met (bool)
- failures: [{step, error}], action_items: [...]
- attendees, decision-maker, comms log

Scorecards written to `s3://skills-svc-dr-reports/YYYY/`.

---

## 8. Cost-Aware Standby

Standby region must stay under $X/month. Achieved by:

| Resource              | Standby state                                 |
|-----------------------|-----------------------------------------------|
| ECS service           | `desiredCount=0`; task def deployed but idle  |
| Lambda                | Provisioned concurrency = 0                   |
| OpenSearch Serverless | Collection NOT created until failover         |
| API Gateway           | Deployed, low TPS health-checks only          |
| DDB Global Table      | On-demand; reads/writes ~0 until failover     |
| S3 CRR                | Pay per replicated GB                         |
| ECR replication       | Pay per replicated GB                         |
| KMS MRK replica       | $1/key/month flat                             |

```ts
// infra/lib/dr/budget.ts
new budgets.CfnBudget(this, 'StandbyBudget', {
  budget: {
    budgetName: 'skills-svc-standby',
    budgetType: 'COST',
    timeUnit: 'MONTHLY',
    budgetLimit: { amount: 250, unit: 'USD' },
    costFilters: { TagKeyValue: ['user:env$standby'] },
  },
  notificationsWithSubscribers: [{
    notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80 },
    subscribers: [{ subscriptionType: 'SNS', address: opsTopic.topicArn }],
  }],
});
```

---

## 9. Runbooks

### 9.1 Region-loss declaration

**Who decides:** on-call IC (Incident Commander). Required signals (any TWO):
1. AWS Health Dashboard reports `service-event` for ≥2 services we depend on in primary region, lasting > 30 min with no ETA.
2. Synthetic canary fails for ≥ 15 min from ≥ 2 external probes.
3. Error budget burn rate > 50× normal for ≥ 10 min in primary.
4. Manual page from AWS TAM.

The IC opens an incident channel, pages secondary approver, fills the declaration form (timestamp, signals, expected blast radius), and only then starts the failover Step Function.

### 9.2 Failover playbook (abridged)

1. Declare (§9.1). Page #incidents, post status page.
2. Start Step Function `dr-failover` with `mode=production`.
3. Watch state-machine execution in console. Each Wait state has a runbook link.
4. After `SmokeTests`, post status page update — service restored on standby.
5. Begin failback planning (see §9.3).

### 9.3 Failback playbook

1. Wait for primary AWS Health all-clear + 4 h soak.
2. Reindex OpenSearch in primary from S3 results (`reindex-from-s3` Lambda).
3. Run drift check (§9.5). Resolve any divergence.
4. Flip `ddb_writer_region` back to `us-east-1` during a low-traffic window.
5. Drain standby SQS.
6. Scale standby ECS to 0, Lambda PC to 0.
7. Document in postmortem.

### 9.4 Single-AZ partial outage

ECS Fargate is multi-AZ (3 AZs) — capacity provider should self-heal. If not:
1. Check Service Events; if EC2-level, force `desiredCount` redeploy.
2. If OpenSearch shows AZ-bound slowness, fail over via DNS only (no DDB writer flip).

### 9.5 Drift detection cron

```ts
// infra/lib/dr/drift-cron.ts
const fn = new lambda.NodejsFunction(this, 'DriftDetector', {
  entry: 'packages/lambda/dr-drift/index.ts',
  schedule: events.Schedule.rate(Duration.hours(6)),
});
// Inside: shell out to `cdk diff --app primary` and `cdk diff --app standby`,
// compare stack templates, alarm Skills/DR/DriftDetected if any diff outside ignored keys.
```

---

## 10. Acceptance Criteria

- [ ] Monthly restore-and-verify Lambda green for 3 consecutive months
- [ ] Quarterly game-day completed with `observed_rto_sec < target` for all T1 components
- [ ] CDK drift between primary and standby stacks = 0 for 30 days
- [ ] Standby region monthly cost < budget
- [ ] All T1 components tagged `skills-svc:backup=true`
- [ ] Failover Step Function tested end-to-end in sandbox
- [ ] Runbooks reviewed quarterly by on-call rotation

