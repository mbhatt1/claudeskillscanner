# SPEC-46 — Observability Data Platform & SIEM

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-36 (SLOs/metrics)
**Related:** SPEC-38 (audit log), SPEC-40 (IR), SPEC-41 (FinOps)

---

## 1. Logging Tiers

| Tier      | Examples                              | Destination       | Retention | Cost class |
|-----------|---------------------------------------|-------------------|-----------|-----------|
| METRIC    | EMF counters/histograms               | CW Metrics        | 15 mo     | Cheap      |
| TRACE     | X-Ray segments                        | X-Ray + OTel      | 30 d      | Mid        |
| EVENT     | Structured app events (jsonl)         | CW Logs → S3      | 90 d hot, 7 y cold | Mid |
| AUDIT     | Auth, policy, data-access (SPEC-38)   | Object-Lock S3    | 7 y       | Cold       |
| DEBUG     | Verbose troubleshooting (sampled)     | CW Logs (TTL 7 d) | 7 d       | Sampled    |

DEBUG is sampled at 1% baseline, 100% when AppConfig flag `debug_full=true` or per-job `debug_full=true` is set (max 1 h auto-revert).

---

## 2. Structured Logging Contract

```ts
// packages/shared/log/contract.ts
export interface LogRecord {
  ts:         string;          // ISO-8601
  level:      'debug'|'info'|'warn'|'error';
  service:    string;          // 'ingestion-lambda', 'ecs-runner', ...
  component:  string;
  job_id?:    string;
  trace_id?:  string;
  span_id?:   string;
  user_id?:   string;
  event:      string;          // dotted: 'job.accepted', 'bedrock.invoked'
  msg:        string;
  attrs:      Record<string, unknown>;   // non-sensitive only
  redacted?:  string[];                  // names of redacted attrs
  schema:     'skills-svc.log.v1';
}
```

CDK Aspect rejects Lambdas that emit non-JSON to stdout (via lint-time check on bundled source).

---

## 3. Log Pipeline

```
Lambda/ECS  →  CloudWatch Logs (per-service log group, 7-d retention)
                       │
                       ▼  subscription filter
              Kinesis Firehose
                       │
                       ▼  Lambda transform (parse, partition, redact)
                       ▼
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      S3 (parquet) Splunk/Elastic  Athena workgroup
      (cold)        (SIEM)         (ad-hoc query)
```

Firehose buffers 60 s / 5 MB → S3 partitioned `service=/dt=YYYY-MM-DD/h=HH/`. Glue catalog auto-updated. Athena workgroup `skills-svc-logs` with $20/query result cap.

---

## 4. SIEM Integration

```ts
// infra/lib/obs/siem.ts
new firehose.CfnDeliveryStream(this, 'SiemStream', {
  deliveryStreamType: 'DirectPut',
  splunkDestinationConfiguration: {
    hecEndpoint: process.env.SPLUNK_HEC_URL,
    hecToken:    secret.secretValueFromJson('hec_token').toString(),
    s3BackupMode: 'FailedEventsOnly',
    s3Configuration: { /* fallback bucket */ },
    processingConfiguration: { enabled: true, processors: [{ type: 'Lambda', parameters: [
      { parameterName: 'LambdaArn', parameterValue: redactor.functionArn } ] }] },
  },
});
```

Splunk receives: AUDIT (always), EVENT (always), TRACE summaries (1% sampled), METRIC anomalies only.

Saved searches (Splunk):
- `SkillsSvc::AuthFailures` — failed STS AssumeRole > 10/h
- `SkillsSvc::DataAccess` — Auditor persona reads (compliance evidence)
- `SkillsSvc::ToolAbuse` — MCP tool calls outside skill manifest allowlist
- `SkillsSvc::CostSpike` — Bedrock cost/min > 2× rolling median

---

## 5. Log Redaction at Pipeline

`packages/lambda/log-redactor/index.ts` runs as Firehose transform:
1. Parse JSON; if not parseable → quarantine.
2. Walk record; for keys matching `password|secret|token|key|authorization`, replace value with `<<redacted>>`.
3. PII regex pass (SPEC-38 §2).
4. Reject SOURCE_CODE-classified blobs (return `redacted: ["source_blob"]`).

---

## 6. Sampling & Cost Control

- DEBUG: 1% baseline, ramped to 100% for incident debugging (auto-revert)
- TRACE: 1% baseline, 100% on errors
- EVENT: always-on
- AUDIT: always-on

Log-cost SLO: ingest cost ≤ 5% of total infra spend. Alarm at 7%.

CDK Aspect: any new Lambda log group without explicit retention fails synth (default 7 d for non-audit groups).

---

## 7. Ad-hoc Query

```bash
$ skills-svc logs query \
    --since 1h --service ecs-runner \
    --filter 'event="bedrock.throttled" AND attrs.model="claude-opus-4-7"'
```

Translates to CW Logs Insights or Athena depending on time range. CLI streams results.

---

## 8. Compliance Evidence Pipeline

Audit-log bucket → daily Lambda → produces SOC2 evidence pack:
- 30-day window
- Index of access events per persona
- Index of policy changes
- Hash-chain verification report

Stored in `s3://skills-svc-evidence/SOC2/YYYY-MM-DD/`.

---

## 9. Dashboards & Investigation

- **Service overview** (per service): RED metrics, p50/p95/p99 latency, error budget burn
- **Job drilldown**: filter by `job_id`; X-Ray trace + log lines + cost + SARIF
- **Cost lens**: per-service spend, top jobs
- **Security**: GuardDuty + Security Hub + Auth Athena queries
- **Skill author lens**: per-skill error rate, cost, eval scores

All dashboard JSON checked into `infra/lib/obs/dashboards/`.

---

## 10. Acceptance Criteria

- [ ] Every Lambda/ECS emits LogRecord v1
- [ ] Firehose → S3 parquet partitioned; Glue catalog up
- [ ] Splunk receiving AUDIT + EVENT
- [ ] Log redactor passes redaction tests
- [ ] Athena workgroup configured; sample queries < $20
- [ ] Log-cost SLO measured
- [ ] Daily SOC2 evidence pack generated
- [ ] CLI `logs query` works end-to-end
