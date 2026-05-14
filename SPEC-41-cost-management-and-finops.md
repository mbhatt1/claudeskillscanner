# SPEC-41 — Cost Management & FinOps

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-02
**Related:** SPEC-36 (SLOs), SPEC-42 (perf), SPEC-37 (DR cost)

---

## 1. Unit Economics

Cost-per-job model:

```
job_cost = bedrock_input_tokens × $P_in/Mtok
         + bedrock_output_tokens × $P_out/Mtok
         + fargate_vcpu_seconds × $0.04048/vCPU-h
         + fargate_gb_seconds   × $0.004445/GB-h
         + lambda_gb_seconds    × $0.0000166667/GB-s
         + s3_put + s3_get
         + ddb_rcu + ddb_wcu
         + os_ocu_hours         × $0.24/OCU-h
         + kms_requests         × $0.03/10k
         + data_transfer
```

Baseline (typical job classes — measure & update quarterly):

| Class             | Bedrock | Fargate | Lambda | S3+DDB+OS | Total est. |
|-------------------|---------|---------|--------|-----------|------------|
| Small skill       | $0.02   | $0.005  | $0.001 | $0.001    | ~$0.03     |
| Medium skill      | $0.15   | $0.03   | $0.001 | $0.002    | ~$0.18     |
| Sec-review 100kLOC| $1.80   | $0.20   | $0.002 | $0.05     | ~$2.05     |

---

## 2. Bedrock Token Cost Tracking

```ts
// packages/shared/bedrock/wrapped.ts
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-opus-4-7':   { in: 15, out: 75 },   // $/Mtok
  'claude-sonnet-4-6': { in: 3,  out: 15 },
  'claude-haiku-4-5':  { in: 0.8, out: 4 },
};

export async function invokeModel(req: InvokeReq, ctx: { jobId: string; skill: string }) {
  const t0 = Date.now();
  const resp = await bedrock.invokeModel(req);
  const usage = resp.usage!;
  const p = PRICING[req.modelId];
  const usd = (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1_000_000;
  emit({
    namespace: 'Skills/Cost',
    metrics: { InputTokens: usage.input_tokens, OutputTokens: usage.output_tokens,
               EstimatedUSD: usd, LatencyMs: Date.now() - t0 },
    dims: { model_id: req.modelId, skill: ctx.skill, job_id: ctx.jobId },
  });
  await ddb.updateItem({ TableName: TABLE, Key: { PK: `JOB#${ctx.jobId}`, SK: 'META' },
    UpdateExpression: 'ADD cost_usd_estimate :u', ExpressionAttributeValues: { ':u': usd } });
  return resp;
}
```

Daily reconciliation Lambda compares `SUM(Skills/Cost/EstimatedUSD)` against Cost Explorer `service=Amazon Bedrock` filtered by tag; alerts on > 5% drift.

---

## 3. Budgets & Guardrails

```ts
// infra/lib/finops/budgets.ts
new budgets.CfnBudget(this, 'MonthlyBudget', {
  budget: { budgetName: 'skills-svc-monthly', budgetType: 'COST', timeUnit: 'MONTHLY',
            budgetLimit: { amount: 5000, unit: 'USD' } },
  notificationsWithSubscribers: [
    { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 80 },
      subscribers: [{ subscriptionType: 'SNS', address: opsTopic.topicArn }] },
    { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100 },
      subscribers: [{ subscriptionType: 'SNS', address: degradeTopic.topicArn }] },
    { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 150 },
      subscribers: [{ subscriptionType: 'SNS', address: killSwitchTopic.topicArn }] },
  ],
});
```

Degrade-mode Lambda (subscribed to 100% alarm) flips AppConfig:

```ts
await appConfig.update({ degraded_mode: true,
  default_model: 'claude-haiku-4-5',
  os_ocu_max: 4,
  sqs_throttle: 0.3 });
```

Kill switch (150%) sets `writes_enabled=false` and emails leadership.

---

## 4. Per-Job Cost Cap

```ts
// packages/ecs-runner/src/cost-guard.ts
const cap = manifest.max_cost_usd ?? 5.0;
let usd = 0;
for await (const chunk of streamModel(req)) {
  usd += chunk.usage_usd;
  if (usd > cap) {
    await reportPartial({ reason: 'COST_CAP_EXCEEDED', usd, cap });
    process.exit(2);
  }
}
```

---

## 5. Cost Anomaly Detection

AWS Cost Anomaly Detection monitor (`Service` mode) + a custom Lambda comparing today's p95 cost-per-job vs 14-day rolling median:

```ts
if (todayP95 > 2 * rollingMedian) page('cost_anomaly', { todayP95, rollingMedian });
```

---

## 6. Bedrock Optimizations

- **Prompt caching:** enable for system prompt + large repo contexts. `claude-opus-4-7` 1M-context cache (5 min TTL). Track cache-hit ratio: `Skills/Cost/CacheHitRatio` per skill. Target ≥ 60% for repeated-context skills (e.g. security review walking a repo).
- **Batch inference:** for eligible offline workloads (eval runs, periodic re-index), use Bedrock batch (50% cheaper).
- **Model routing:** triage with Haiku → escalate to Opus only when confidence threshold not met. Routing policy:

```ts
const triage = await haiku(prompt + STRUCTURED_TRIAGE_INSTR);
if (triage.requires_deep_analysis || triage.confidence < 0.8) return await opus(prompt);
return triage.result;
```

---

## 7. Right-Sizing

CDK Aspect rejects over-provisioned ECS task defs:

```ts
// infra/lib/finops/right-size-aspect.ts
class RightSizeAspect implements IAspect {
  visit(node: IConstruct) {
    if (node instanceof ecs.FargateTaskDefinition) {
      const observedP95 = lookupCloudWatch(node); // from previous 14d
      const provisioned = node.cpu;
      if (provisioned > observedP95 * 4) {
        Annotations.of(node).addError(`Over-provisioned: ${provisioned} vCPU, p95=${observedP95}`);
      }
    }
  }
}
```

Lambda memory tuned via `aws-lambda-power-tuning` Step Function output, results checked in to `infra/lib/lambda-tuning.json`.

---

## 8. OpenSearch Serverless Cost

- Min/max OCU per env: dev `{min:1, max:2}`, prod `{min:2, max:10}` (raised via AppConfig `os_ocu_max` for surge)
- Monthly index rollover (caps storage at 90-day retention × 1 active index)
- Embedding dimensionality A/B: 1536 vs 768 — measure recall@10 delta; if < 1% drop, switch (50% storage/compute savings)
- Replicas = 1 in non-prod

---

## 9. S3 Cost

```ts
resultsBucket.addLifecycleRule({
  transitions: [
    { storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(0) },
    { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(30) },
    { storageClass: s3.StorageClass.DEEP_ARCHIVE, transitionAfter: Duration.days(180) },
  ],
  expiration: Duration.days(/* per retention spec */),
});
```

Storage Lens dashboard ARN: `arn:aws:s3:us-east-1:${account}:storage-lens/skills-svc`.

---

## 10. Data Transfer Hygiene

Gateway endpoints (free): S3, DDB. Interface endpoints (paid but kills NAT cost): Bedrock, KMS, Secrets Manager, ECR API + DKR, CloudWatch Logs, STS, SQS. NAT gateway count = 0.

ECS placement strategy: `spread by attribute:ecs.availability-zone`, but prefer same-AZ for chained tasks; intra-AZ traffic is free.

---

## 11. Tagging & Cost Allocation

```ts
// infra/lib/finops/tagging-aspect.ts
class MandatoryTagsAspect implements IAspect {
  static REQUIRED = ['app', 'env', 'component', 'cost_center', 'owner'];
  visit(node: IConstruct) {
    if (!isTaggableResource(node)) return;
    for (const k of MandatoryTagsAspect.REQUIRED) {
      if (!getTag(node, k)) Annotations.of(node).addError(`Missing tag ${k}`);
    }
  }
}
```

Activate cost allocation tags in Billing console: `app`, `env`, `component`, `cost_center`, `skill_id`.

CUR exported to `s3://skills-svc-cur/`, queried via Athena (`infra/lib/finops/athena-queries.sql`), visualized in QuickSight dashboard `skills-svc-finops` (JSON definition in `infra/lib/finops/dashboards/`).

---

## 12. Weekly Showback

```ts
// packages/lambda/showback/index.ts
// Sunday 09:00 UTC
// Pulls last-7d CUR via Athena, computes: total, per-skill, per-model,
// cache-hit savings (counterfactual), top 10 jobs by cost, anomalies fired.
// Emails via SES to skills-svc-finops@.
```

---

## 13. Reserved Capacity & Savings Plans

After 3 months of stable usage:
- **1-year Compute Savings Plan** covering Fargate + Lambda baseline (commit ~50% of baseline spend)
- Rotation: review every 6 months; re-up before expiry

Bedrock: no commit tiers yet; revisit when GA.

---

## 14. Idle Resource Sweeper

```ts
// packages/lambda/sweeper/index.ts
// Daily 04:00 UTC; report-only mode in non-prod, delete in prod
// Targets:
//  - ECS tasks with state STOPPED > 7 days (none expected since they auto-clean)
//  - S3 multipart uploads > 7 days old → AbortMultipartUpload
//  - KMS keys pending deletion (warn before final)
//  - CloudWatch log groups with 0 events 90 days → delete
//  - ECR images untagged > 90 days → expire (already via lifecycle policy; verify)
//  - EBS snapshots (none expected — Fargate only — alarm if any appear)
```

---

## 15. Cost SLO

Cost SLO: cost-per-successful-job < $0.20 (rolling 28-day). Tracked alongside reliability SLO. Burn alarm at 1.5× target.

Treat cost regressions like reliability regressions: postmortem, action items, freeze new spend until back under.

---

## 16. Acceptance Criteria

- [ ] Token cost EMF emitted on every Bedrock call
- [ ] Daily reconciliation drift < 5%
- [ ] Budgets wired with 80/100/150 actions
- [ ] Cost anomaly Lambda live
- [ ] Cache-hit ratio metric > 50% for security-review skill
- [ ] Right-size Aspect blocks over-provisioned task defs
- [ ] All taggable resources pass MandatoryTagsAspect
- [ ] Weekly showback delivered for 4 consecutive weeks
- [ ] Cost SLO measured & dashboarded
