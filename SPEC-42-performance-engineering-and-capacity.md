# SPEC-42 — Performance Engineering & Capacity

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-02
**Related:** SPEC-36 (SLOs), SPEC-41 (cost), SPEC-37 (DR capacity)

---

## 1. Latency Budgets (sum to SPEC-36 SLOs)

E2E "upload → indexed" SLO p95 = 5 min. Budget:

| Stage                  | p95 budget       |
|------------------------|------------------|
| Upload ack             | 200 ms           |
| SQS visibility         | 1 s              |
| IngestionLambda (warm) | 200 ms           |
| ECS task start         | 30 s (with SOCI) |
| Claude invocation      | variable (skill) |
| Result upload + EBR    | 5 s              |
| ResultsProcessor       | 5 s              |
| OpenSearch index       | 500 ms           |

E2E "query → answer" SLO p95 = 800 ms:

| Stage                 | p95 budget |
|-----------------------|------------|
| API GW + auth         | 100 ms     |
| kNN search            | 300 ms     |
| Reranker (Bedrock Haiku) | 200 ms  |
| DDB lookups           | 100 ms     |
| Network/serialization | 100 ms     |

---

## 2. Cold-Start Mitigation

- Lambda **SnapStart** when GA for Node 20 (track AWS roadmap); meanwhile use Provisioned Concurrency.
- IngestionLambda: Provisioned Concurrency = 5 during business hours via scheduled scaling.
- Bundle with esbuild: `--minify --tree-shaking=true --external:@aws-sdk/* --target=node20`; produced zips < 5 MB.
- Lazy-construct SDK v3 clients; reuse across invocations (module scope).

```ts
// packages/lambda/ingestion/clients.ts
let _ddb: DynamoDBClient | undefined;
export const ddb = () => (_ddb ??= new DynamoDBClient({ region: process.env.AWS_REGION }));
```

---

## 3. ECS Warm Pool

Maintain N=4 warm tasks long-polling SQS (20 s) to skip container start on common jobs:

```ts
// infra/lib/perf/warm-pool.ts
new ecs.FargateService(this, 'WarmRunner', {
  cluster,
  taskDefinition: skillsRunnerTaskDef,
  desiredCount: 4,
  capacityProviderStrategies: [{ capacityProvider: 'FARGATE', weight: 1 }],
  enableExecuteCommand: false,
});

new applicationautoscaling.ScalableTarget(this, 'WarmScale', {
  serviceNamespace: 'ecs',
  resourceId: `service/${cluster.clusterName}/WarmRunner`,
  scalableDimension: 'ecs:service:DesiredCount',
  minCapacity: 4, maxCapacity: 50,
}).scaleOnMetric('OnQueueDepth', {
  metric: queue.metricApproximateNumberOfMessagesVisible(),
  scalingSteps: [
    { upper: 0, change: 0 },
    { lower: 10, change: +4 },
    { lower: 50, change: +8 },
  ],
});
```

Tradeoff: warm-pool cost vs cold-start latency; tuned via `Skills/ECS/ColdStarts` metric.

---

## 4. Concurrency Model

| Component  | Concurrency knob                | Setting        |
|------------|---------------------------------|----------------|
| Lambda     | Reserved concurrency             | Ingestion=50, ResultsProcessor=100, Query=200 |
| SQS        | BatchSize, MaxBatchingWindow     | 5 msgs / 1 s   |
| ECS RunTask| Self-throttle (token bucket)     | 20 rps         |
| Bedrock    | Exp+jitter backoff on Throttle   | base=200ms, max=10s, attempts=5 |
| DDB        | On-demand                         | with auto-scaling enabled when patterns stabilize |
| OS Serverless | OCU                            | min=2, max=10 |

---

## 5. DDB Hot-Partition Avoidance

PK = `JOB#${ulid()}` (ULIDs are time-sorted but high cardinality; partition spread is even).

GSI1 (by status) uses composite SK `${status}#${ulid()}#${rand4()}` to avoid status-only hot partitions.

GSI2 (by user) — user cardinality is small but reads are sparse; OK.

---

## 6. OpenSearch Tuning

```json
PUT skills-results-2026-05
{
  "settings": {
    "index": {
      "number_of_replicas": 1,
      "refresh_interval": "5s",
      "knn": true,
      "knn.algo_param.ef_search": 100
    }
  },
  "mappings": {
    "properties": {
      "embedding": { "type": "knn_vector", "dimension": 1536,
        "method": { "name": "hnsw", "space_type": "cosinesimil", "engine": "faiss",
          "parameters": { "m": 16, "ef_construction": 512 } } },
      "job_id": { "type": "keyword" },
      "text": { "type": "text" },
      "created_at": { "type": "date" }
    }
  }
}
```

Bulk reindex path uses `refresh_interval=30s` then resets to `5s`. Force-merge to 1 segment after monthly rollover.

---

## 7. Caching Layers

- **Embedding cache** (DDB): PK=`EMB#${sha256(text)}#${model}`, value=embedding bytes, TTL 30 d. Hit-rate metric.
- **Query-result cache** (5-min TTL): in-memory LRU per Lambda container, keyed `${sha256(query)}|${filters}`.
- **Bedrock prompt cache:** see SPEC-41 §6.
- **CloudFront** in front of CLI download endpoints (skill registry artifacts) — 30-day cache.

---

## 8. Backpressure

```ts
// packages/lambda/upload-api/index.ts
const depth = await sqs.getQueueAttributes({ QueueUrl: INGEST_Q, AttributeNames: ['ApproximateNumberOfMessages'] });
if (Number(depth.Attributes!.ApproximateNumberOfMessages) > 1000) {
  return { statusCode: 429, headers: { 'Retry-After': '30' }, body: 'queue full' };
}
```

CLI implements exponential backoff with full jitter on 429. ECS scale-out throttled to N tasks/min via SQS scaling policy step bounds.

---

## 9. Load Testing

```ts
// packages/loadtest/k6/mix.js
import http from 'k6/http';
export const options = {
  scenarios: {
    steady: { executor: 'constant-arrival-rate', rate: 30, timeUnit: '1m', duration: '15m',
              preAllocatedVUs: 50, maxVUs: 200 },
    burst:  { executor: 'ramping-arrival-rate', startRate: 30, timeUnit: '1m',
              stages: [{ target: 300, duration: '5m' }, { target: 30, duration: '5m' }] },
  },
  thresholds: { http_req_duration: ['p(95)<800'], http_req_failed: ['rate<0.005'] },
};
// 80% small, 15% medium, 5% large mix
```

Run pre-release via GH Actions `loadtest.yml` against ephemeral stack; regress on > 5% p95 worsening.

---

## 10. Capacity Model

Update spreadsheet quarterly (`docs/capacity.xlsx`). Columns: peak jobs/h, avg jobs/h, p99 jobs/h, derived Lambda concurrency, Fargate vCPUs, Bedrock RPM, DDB RCU/WCU, OS OCUs. 30% headroom on each.

Service-quota tracker (see SPEC-36 §10) alarms at 70% utilization → file quota increase ticket.

---

## 11. Performance Regression Detection

CW dashboards per stage with 14-day rolling baseline (anomaly bands). Alarm: latency p95 outside band for > 30 min.

---

## 12. Profiling

- Lambda PowerTools tracer + custom subsegments.
- ECS: enable `node --prof` on-demand via AppConfig flag `runner_profile=true`; flamegraph uploaded to `s3://skills-svc-profiles/${jobId}/`.
- OpenSearch slow logs at 1s threshold to CW.

---

## 13. Memory & FD Hygiene

- Heap snapshot capture on OOM: `node --heap-prof` + signal handler that uploads on SIGTERM.
- Dockerfile: `ulimit -n 65535`.
- Lambda: monitor `MaxMemoryUsed`; alarm at > 85%.

---

## 14. Network

- All cross-service traffic uses VPC endpoints (gateway for S3/DDB; interface for everything else).
- ENI warm pool for Lambda-in-VPC: scheduled scaling pre-warms.
- S3 Transfer Acceleration: **off** (private only).
- Hyperplane ENIs for Lambda — accept connection-warmup cost on first cold start in new AZ.

---

## 15. Scaling Limits & Graceful Degradation

| Component | Breaks at...                       | Degradation mode |
|-----------|------------------------------------|------------------|
| Lambda    | account concurrency (default 1000) | Throttle uploads (429), enable reserved per-fn |
| Fargate   | account vCPU quota                 | Queue jobs longer; alert |
| Bedrock   | model RPM quota                    | Route to fallback model chain |
| OpenSearch| OCU max                            | Disable BM25 reranking; knn-only |
| DDB       | partition-key 1k WCU / 3k RCU      | Re-shard; on-demand absorbs |

Modes via AppConfig:
- `mode=read-only` — uploads return 503, queries OK
- `mode=query-only-no-ingest` — disable result indexing
- `mode=haiku-only` — force `default_model=haiku`

---

## 16. Acceptance Criteria

- [ ] Per-stage latency dashboards live
- [ ] Cold start p95 < 1.5 s (warm 200 ms)
- [ ] ECS warm pool achieves cold-start rate < 5%
- [ ] Load test passes thresholds in CI
- [ ] HNSW knn p95 < 300 ms at 1 M docs
- [ ] Quota tracker green
- [ ] Graceful degradation drilled (each mode tested in sandbox)
