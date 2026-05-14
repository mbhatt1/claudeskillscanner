# SPEC-52 — Synthetic Monitoring & External Probing

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-36 (SLOs), SPEC-37 (DR), SPEC-46 (observability)

> Internal metrics agree with themselves. External probes detect outages internal metrics can miss (DNS, TLS, control-plane partitions, regional ingress failures).

---

## 1. What to Probe

| Probe                          | Cadence | Region(s)                       | Failure Tier |
|--------------------------------|---------|---------------------------------|--------------|
| API healthcheck `/healthz`     | 1 min   | us-east-1, us-west-2, eu-west-1 | SEV2         |
| CLI end-to-end (synthetic job) | 5 min   | us-east-1                       | SEV2         |
| Query end-to-end (knownanswer) | 5 min   | us-east-1, us-west-2            | SEV2         |
| Skill registry tarball fetch   | 5 min   | us-east-1                       | SEV3         |
| MCP HTTP transport tool-list   | 5 min   | us-east-1                       | SEV2         |
| Bedrock InvokeModel (Haiku)    | 5 min   | us-east-1                       | SEV3         |
| Certificate expiry             | 6 h     | all                             | SEV3         |

Probes from **multiple external regions** detect single-region availability issues.

---

## 2. Implementation: CloudWatch Synthetics + External

### 2.1 CloudWatch Synthetics canaries

```ts
// infra/lib/synthetics/canaries.ts
new synthetics.Canary(this, 'ApiHealth', {
  schedule: synthetics.Schedule.rate(Duration.minutes(1)),
  runtime: synthetics.Runtime.SYNTHETICS_NODEJS_PUPPETEER_7_0,
  test: synthetics.Test.custom({
    code: synthetics.Code.fromAsset('packages/synthetics/api-health'),
    handler: 'index.handler',
  }),
  artifactsBucketLifecycleRules: [{ expiration: Duration.days(30) }],
  successRetentionPeriod: Duration.days(7),
  failureRetentionPeriod: Duration.days(30),
});
```

```ts
// packages/synthetics/api-health/index.ts
const synthetics = require('Synthetics');
exports.handler = async () => {
  const url = 'https://api.skills-svc.example/healthz';
  const r = await synthetics.executeHttpStep('healthz', { url, method: 'GET' }, async (resp) => {
    if (resp.statusCode !== 200) throw new Error('non-200');
    const body = JSON.parse(await resp.body());
    if (!body.ok) throw new Error('not ok');
  });
};
```

### 2.2 External probes (defense in depth)

Use a third-party (e.g., Updown.io / Pingdom / Datadog Synthetic) configured by Terraform-as-data under `infra/external-probes/` for SOC-2 evidence of independence from AWS. Endpoints + Slack/PagerDuty hookups documented.

---

## 3. CLI End-to-End Canary

Runs the real CLI in a Lambda container:

```ts
// packages/synthetics/cli-e2e/index.ts
const fixture = await s3GetObject(FIXTURE_BUCKET, 'canary-skill.zip');
const upload = await runCli(['upload', '/tmp/c.zip', '--job-name', `canary-${Date.now()}`, '--wait']);
const status = await runCli(['status', upload.jobId, '--json']);
if (status.state !== 'COMPLETED') throw new Error(`canary failed: ${status.state}`);
publish('Skills/Synthetics/CliE2E', { latencyMs: upload.elapsed, ok: 1 });
```

Uses a dedicated IAM role + a known small skill that produces a deterministic output (asserted by hash).

---

## 4. Known-Answer Query Canary

Pre-seeded query that always has the same top-3 results. Diff against expected:

```ts
const expected = ['JOB#01HX...', 'JOB#01HY...', 'JOB#01HZ...'];
const got = await runCli(['query', 'CANARY_FINGERPRINT_QUERY', '--top', '3', '--json']);
const ids = got.results.map(r => r.id);
if (!arraysEqual(ids, expected)) throw new Error('drift in top-3');
```

Catches: embedding model regressions, OpenSearch tuning regressions, ranking bugs.

---

## 5. Certificate Expiry

Lambda iterates ACM + custom-managed certs; alerts at 30, 14, 7, 1 days remaining. Same for cosign signing certs (Sigstore certs are short-lived; check Fulcio root + trust policy).

---

## 6. SLI Wiring

Each canary emits:
```
Skills/Synthetics/Probe Result {probe="api-health", region="us-east-1"}  (0|1)
Skills/Synthetics/LatencyMs   {probe, region}
```

External availability SLO derived from these:
```
external_availability = avg(Skills/Synthetics/Probe.Result) over 28d ≥ 0.999
```

Listed alongside internal SLOs in SPEC-36 dashboards.

---

## 7. Alarm Routing

- ≥ 2 of 3 external regions fail same probe for 3 datapoints → SEV2
- All probes from same region fail simultaneously → SEV3 (likely regional outage; correlate with AWS Health)
- Single-region one-off fail → suppress (no page)

Composite alarm reduces noise:

```ts
new cw.CompositeAlarm(this, 'ApiDown', {
  alarmRule: cw.AlarmRule.anyOf(
    cw.AlarmRule.allOf(useast1ApiFail, uswest2ApiFail),
    cw.AlarmRule.allOf(useast1ApiFail, euwest1ApiFail),
    cw.AlarmRule.allOf(uswest2ApiFail, euwest1ApiFail),
  ),
});
```

---

## 8. Status Page

Public-ish status page (or internal) driven by canary state. Hosted on Cloudflare/Statuspage or self-hosted Lambda generating static JSON consumed by a static site. Updates on SEV2+ incidents.

Incident comms playbook tied in (SPEC-40 §19).

---

## 9. Test for the Tests

Quarterly: deliberately break a canary (point it at a sandbox endpoint, take that endpoint down) — verify pages fire, runbook lands you on the right runbook, MTTR clock starts correctly. Documented as a chaos exercise.

---

## 10. Cost

- CW Synthetics canary: $0.0012/run. Minute cadence × 3 regions × 7 probes ≈ $11k/yr. Cut by:
  - Use 5-min cadence for non-critical
  - 1 region for cheap probes
  - Coalesce probes per canary script when sensible

---

## 11. Acceptance Criteria

- [ ] All probes deployed and green for 14 days
- [ ] External (non-AWS) probe live
- [ ] CLI E2E canary completes in < 90 s p95
- [ ] Known-answer query asserts top-3
- [ ] Cert expiry alerts fire in a sandbox-induced test
- [ ] External availability SLO measured + dashboarded
- [ ] Status page reflects canary state
- [ ] Chaos test of canary itself completed quarterly
