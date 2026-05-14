# SPEC-36 — Reliability Engineering & Progressive Delivery

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01 (architecture), SPEC-02 (Lambda+ECS), SPEC-05 (deployment)
**Related:** SPEC-37 (DR), SPEC-41 (FinOps), SPEC-42 (performance)

---

## 1. SLIs, SLOs & Error Budgets

### 1.1 Per-stage SLIs

| Stage                  | SLI                                    | Metric (EMF)                            |
|------------------------|----------------------------------------|-----------------------------------------|
| upload → ingest        | % uploads ack'd in < 2s                | `Skills/Pipeline/UploadAckLatency`      |
| ingest → run-start     | % jobs starting ECS task in < 5 min    | `Skills/Pipeline/IngestToStartLatency`  |
| run                    | % skill runs succeeding                | `Skills/Pipeline/RunSuccess`            |
| results-processing     | p95 latency < 30 s                     | `Skills/Pipeline/ProcessLatency`        |
| query                  | p50 < 400 ms, p95 < 800 ms, p99 < 2 s  | `Skills/Query/Latency`                  |
| availability           | % API requests with status < 500       | `Skills/Api/Availability`               |

### 1.2 Formal SLOs (rolling 28-day)

```yaml
slos:
  job_success_rate:        { target: 0.995,  window: 28d }
  ingestion_p95_latency:   { target_seconds: 300, p: 0.95, window: 28d }
  query_p95_latency:       { target_seconds: 0.8, p: 0.95, window: 28d }
  api_availability:        { target: 0.999,  window: 28d }
```

Error budget = `1 - SLO`. For job_success_rate that's 0.5% — ~36 failed jobs per 7,200/month at typical load.

### 1.3 Multi-window multi-burn-rate alarms

```ts
// infra/lib/reliability/slo-alarms.ts
import * as cw from 'aws-cdk-lib/aws-cloudwatch';

function burnRateAlarm(scope: Construct, name: string, opts: {
  goodMetric: cw.IMetric; badMetric: cw.IMetric;
  shortWindow: Duration; longWindow: Duration;
  burnRate: number; budgetConsumed: number;  // for documentation
  topic: sns.ITopic;
}) {
  const shortBurn = new cw.MathExpression({
    expression: 'b / (b + g)',
    usingMetrics: { b: opts.badMetric.with({ period: opts.shortWindow }),
                    g: opts.goodMetric.with({ period: opts.shortWindow }) },
  });
  const longBurn = new cw.MathExpression({ /* same with longWindow */ });
  const sloError = 0.005; // 1 - 0.995
  const threshold = sloError * opts.burnRate;
  const alarmShort = new cw.Alarm(scope, name + 'Short', {
    metric: shortBurn, threshold, evaluationPeriods: 1,
    comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
  });
  const alarmLong = new cw.Alarm(scope, name + 'Long', { metric: longBurn, threshold, evaluationPeriods: 1 });
  return new cw.CompositeAlarm(scope, name, {
    alarmRule: cw.AlarmRule.allOf(cw.AlarmRule.fromAlarm(alarmShort, cw.AlarmState.ALARM),
                                  cw.AlarmRule.fromAlarm(alarmLong,  cw.AlarmState.ALARM)),
    actionsEnabled: true,
  }).addAlarmAction(new cw_actions.SnsAction(opts.topic));
}
```

Standard pairs (Google SRE workbook):
- **Fast burn:** 14.4× burn rate, 1 h short / 5 min long → consumes 2% budget/h → page
- **Slow burn:** 6× burn rate, 6 h short / 30 min long → consumes 10% budget/6h → ticket
- **Trickle:** 1× burn rate, 3 d short / 6 h long → email weekly

### 1.4 Error-budget policy

If a 28-day window is below SLO target:
1. Freeze non-critical feature deploys until burn < 1×.
2. Required postmortem with action items linked to SLO regression.
3. Re-prioritize reliability work over features in next sprint.

---

## 2. Golden Signals & RED/USE

Each Lambda + ECS task emits EMF on every invocation:

```ts
// packages/shared/observability/emf.ts
export function emitInvocation(stage: string, outcome: 'ok' | 'err', latencyMs: number, attrs: Record<string,string> = {}) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Skills/Pipeline',
        Dimensions: [['stage', 'outcome']],
        Metrics: [
          { Name: 'Invocations', Unit: 'Count' },
          { Name: 'LatencyMs', Unit: 'Milliseconds' },
        ],
      }],
    },
    stage, outcome, ...attrs,
    Invocations: 1,
    LatencyMs: latencyMs,
  }));
}
```

USE per resource: Utilization, Saturation, Errors:
- Lambda: ConcurrentExecutions, Throttles, Errors
- ECS task: CPUUtilization, MemoryUtilization, RunningTaskCount vs DesiredCount
- DDB: ConsumedRCU/WCU vs Provisioned, ThrottledRequests
- OpenSearch Serverless: OCU, IndexingLatency, SearchLatency
- SQS: ApproximateNumberOfMessagesVisible, OldestMessageAge, NumberOfMessagesSent

Dashboard JSON shipped in `infra/lib/observability/dashboards/golden-signals.json` (one widget per signal).

---

## 3. Distributed Tracing

X-Ray + OpenTelemetry via ADOT layer. Trace propagation:

- **API → IngestionLambda:** `X-Amzn-Trace-Id` header
- **IngestionLambda → SQS:** `AWSTraceHeader` system attribute
- **SQS → ResultsProcessorLambda:** SQS message system attributes
- **Lambda → ECS:** trace ID stored as ECS task tag `trace_id`; runner picks up via task metadata endpoint
- **ECS → Bedrock:** custom subsegment per InvokeModel, annotated `model_id`, `input_tokens`, `output_tokens`
- **Lambda → OpenSearch:** custom subsegment with `query_hash`

Sampling rule (X-Ray):
```json
{
  "version": 2,
  "rules": [
    { "description": "errors", "priority": 1, "fixed_target": 1, "rate": 1.0, "service_type": "*", "http_method": "*", "url_path": "*", "service_name": "skills-svc", "attributes": { "error": "true" } },
    { "description": "baseline", "priority": 100, "fixed_target": 0, "rate": 0.01 }
  ],
  "default": { "fixed_target": 0, "rate": 0.01 }
}
```

---

## 4. On-Call

### 4.1 Severity matrix

| Sev  | Definition                                          | Response       | Comms                         |
|------|-----------------------------------------------------|----------------|-------------------------------|
| SEV1 | Service unavailable; data loss or breach            | Page < 5 min   | Public status, exec page      |
| SEV2 | Major degradation; SLO at risk                      | Page < 15 min  | Status page, eng-leadership   |
| SEV3 | Minor degradation; budget burn elevated             | Ticket + Slack | None public                   |
| SEV4 | Cosmetic, alerts, hygiene                           | Backlog        | None                          |

### 4.2 Routing

SNS topics: `skills-svc-page-sev1`, `skills-svc-page-sev2`, `skills-svc-ticket`. Each subscribes PagerDuty or OpsGenie via HTTPS. SEV1/2 also publish to a Slack channel via Chatbot.

### 4.3 Alarm hygiene

- Minimum 3 evaluation periods (no flappers)
- Every alarm has a `runbook` tag with URL
- Every alarm has an `owner` tag with team name
- Quarterly alarm review: kill alarms that haven't fired in 180 d (or haven't been actioned)
- No alarms without alarm-actions (CW Aspect rejects)

### 4.4 Page-worthy alarms (SEV1/2)

- API 5xx rate > 1% (5 min)
- IngestionLambda DLQ depth > 0 for > 5 min
- ECS service unhealthy task count > 0
- DDB ThrottledRequests > 10/min
- OpenSearch IndexingLatency p95 > 5s
- KMS key throttling
- GuardDuty HIGH/CRITICAL finding
- DR drill failure (SEV2)
- Cost anomaly > 2× (SEV3, escalate to SEV2 if sustained)

---

## 5. Runbooks (embedded)

### RB-001: Stuck SQS ingestion queue

**Symptoms:** `ApproximateAgeOfOldestMessage > 600s`, `ApproximateNumberOfMessagesVisible` flat/growing.

**Triage:**
1. Check IngestionLambda errors — is it crashing? (`Skills/Pipeline/Invocations[outcome=err]`)
2. Check ECS RunTask throttling (CloudTrail `RunTask` events; look for `ThrottlingException`)
3. Check Lambda reserved concurrency vs invocations.

**Fix:**
- If Lambda crashing: roll back via CodeDeploy auto-rollback or manual `aws lambda update-alias --function-name X --name live --function-version <prev>`.
- If ECS throttling: request service-quota increase, set AppConfig `ecs_runtask_rps_limit` lower temporarily.
- Drain DLQ via `drain-dlq` Lambda (idempotent).

### RB-002: ECS task launch failures

**Symptoms:** `Skills/ECS/RunTaskFailed` > 0.

**Triage:** CloudTrail `RunTask` failure reasons — capacity, ENI exhaustion, image pull, IAM.

**Fix:**
- ENI exhaustion: scale subnets or use Fargate capacity provider awsvpc trunking.
- Image pull: verify ECR endpoint policy + task-execution role.
- IAM: check task role trust policy + permissions boundary.

### RB-003: OpenSearch capacity exhaustion
- Raise OCU max via AppConfig `os_ocu_max`.
- Identify hot index via `_cat/indices` style API.
- Force index rollover.

### RB-004: Bedrock throttling
- Check `Throttled` metric per model.
- Auto-route to alternate model via AppConfig `model_fallback_chain`.
- File quota increase.

### RB-005: DLQ drain
```bash
aws lambda invoke --function-name drain-dlq --payload '{"max":1000,"dry_run":false}' /tmp/out.json
```

### RB-006: KMS key rotation incident
If automatic rotation produces decrypt failures on historical data:
1. Verify CMK is set to `KeyUsage=ENCRYPT_DECRYPT`.
2. Check that consumers reference the alias not the key ID.
3. Re-issue ciphertext via re-encrypt Lambda.

---

## 6. Game Days & FIS Chaos

### 6.1 Cadence
Quarterly, alternating between:
- ECS task termination chaos
- Bedrock 429 injection
- S3 5xx injection
- OpenSearch latency injection

### 6.2 FIS template

```ts
// infra/lib/reliability/fis.ts
new fis.CfnExperimentTemplate(this, 'EcsKillChaos', {
  description: 'Terminate 25% of skills-runner tasks',
  roleArn: chaosRole.roleArn,
  stopConditions: [{ source: 'aws:cloudwatch:alarm', value: criticalSloAlarm.alarmArn }],
  targets: {
    'ecs-tasks': {
      resourceType: 'aws:ecs:task',
      selectionMode: 'PERCENT(25)',
      resourceTags: { app: 'skills-svc', service: 'skills-runner' },
    },
  },
  actions: {
    'stop-tasks': { actionId: 'aws:ecs:stop-task', targets: { Tasks: 'ecs-tasks' } },
  },
  tags: { app: 'skills-svc', kind: 'chaos' },
});
```

---

## 7. Progressive Delivery

### 7.1 AWS AppConfig flags

```ts
// infra/lib/release/appconfig.ts
const app = new appconfig.Application(this, 'AppConfig', { name: 'skills-svc' });
const env = new appconfig.Environment(app, 'Prod', { name: 'prod' });
const profile = new appconfig.HostedConfiguration(this, 'Flags', {
  application: app,
  deploymentStrategy: appconfig.DeploymentStrategy.fromDeploymentStrategyId(
    this, 'Linear20', appconfig.DeploymentStrategyId.LINEAR_20_PERCENT_EVERY_6_MINUTES,
  ),
  content: appconfig.ConfigurationContent.fromInlineJson(JSON.stringify({
    ecs_image_canary_percent: 0,
    writes_enabled: true,
    degraded_mode: false,
    model_fallback_chain: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    os_ocu_max: 10,
    deploy_freeze: false,
  })),
});
```

### 7.2 Lambda CodeDeploy canary

```ts
new codedeploy.LambdaDeploymentGroup(this, 'IngestionDG', {
  alias: ingestionLambda.currentVersion.addAlias('live'),
  deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
  alarms: [errorRateAlarm, latencyAlarm, slo.fastBurn],
  preHook: preTrafficLambda,
  postHook: postTrafficLambda,
  autoRollback: { failedDeployment: true, deploymentInAlarm: true, stoppedDeployment: true },
});
```

### 7.3 ECS canary via AppConfig

The IngestionLambda, on receiving an SQS message, picks task def:

```ts
// packages/lambda/ingestion/canary.ts
const canaryPct = await appConfig.getNumber('ecs_image_canary_percent');
const useCanary = (hashJobId(job.id) % 100) < canaryPct;
const taskDef = useCanary ? STABLE_TASK_DEF_ARN + ':canary' : STABLE_TASK_DEF_ARN;
```

Auto-rollback: CW alarm `RunSuccess[image=canary] < 0.99` triggers a Lambda that sets `ecs_image_canary_percent=0`.

---

## 8. Deployment Safety

- **Pre-traffic hook (Lambda):** validates new version with synthetic invocation; fails deployment on error.
- **Post-traffic hook:** runs 30-second smoke against canary, asserts no new error patterns.
- **Change-failure-rate SLO:** ≤ 15% of deploys roll back. Tracked via CodeDeploy events.
- **Freeze windows:** `deploy_freeze=true` in AppConfig blocks `cdk deploy` via a CI gate that reads the flag. Default freeze: weekends, holidays, last 3 days of quarter.
- **Blast radius limits:** No deploy may change > 10 stacks at once; CDK pipeline split into waves.

---

## 9. DORA Metrics

```ts
// packages/lambda/dora-exporter/index.ts
export const handler = async () => {
  const deploys = await codedeploy.batchGetDeployments(/* last 28d */);
  const leadTimes  = deploys.map(d => (d.completedAt! - d.createdAt!));
  const cfr        = deploys.filter(d => d.status === 'Failed' || d.rolledBack).length / deploys.length;
  const incidents  = await getSEV1SEV2Incidents();
  const mttr       = mean(incidents.map(i => i.resolvedAt - i.detectedAt));
  await cw.putMetricData({ Namespace: 'Skills/DORA', MetricData: [
    { MetricName: 'LeadTimeSeconds', Value: median(leadTimes) },
    { MetricName: 'DeployFrequency', Value: deploys.length / 28 },
    { MetricName: 'ChangeFailureRate', Value: cfr },
    { MetricName: 'MTTRSeconds', Value: mttr },
  ]});
};
```

Targets (Elite per DORA report):
- Lead time < 1 day
- Deploy frequency: on-demand
- CFR < 15%
- MTTR < 1 h

---

## 10. Capacity & Headroom

### 10.1 Quota tracker

```ts
// packages/lambda/quota-tracker/index.ts
// daily: query Service Quotas for each tracked quota, emit
//   Skills/Quotas/Utilization (dim=quota_name)
// alarm at 70% utilization
const tracked = [
  { service: 'lambda', code: 'L-B99A9384', name: 'concurrent_executions' },
  { service: 'ecs',    code: 'L-46FBEAD8', name: 'fargate_vcpus' },
  { service: 'dynamodb', code: 'L-F98FE922', name: 'account_max_rcu' },
  { service: 'bedrock', code: 'L-OPUS-RPM', name: 'opus_rpm' },
];
```

### 10.2 Headroom targets
- Lambda concurrency: ≥ 30% free
- Fargate vCPU: ≥ 30% free
- Bedrock RPM: ≥ 50% free
- DDB consumed RCU/WCU: ≤ 70% provisioned

### 10.3 Quota-increase runbook
- File request via Service Quotas console + ticket to AWS TAM.
- Track in `quota-requests.md`; review monthly.
- For Bedrock: also request multi-region capacity since standby region must absorb 100% on failover.

---

## 11. Acceptance Criteria

- [ ] All SLOs measured & dashboards live for 28 days
- [ ] Fast-burn + slow-burn alarms wired for every SLO
- [ ] X-Ray traces visible end-to-end (API → ECS → Bedrock → OpenSearch)
- [ ] First quarterly game day completed with action items closed
- [ ] DORA exporter emitting metrics
- [ ] Quota tracker green across all tracked quotas
- [ ] Every alarm has runbook + owner tags
- [ ] Lambda + ECS canary deploys exercised end-to-end with successful rollback drill

