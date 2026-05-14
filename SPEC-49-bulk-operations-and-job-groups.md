# SPEC-49 — Bulk Operations & Job Groups

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-02, SPEC-03
**Related:** SPEC-36, SPEC-41, SPEC-42

> Submitting 1000s of repos at once is a first-class workload. Without grouping, results are unmanageable and observability is per-job rather than per-batch.

---

## 1. Concepts

- **Job:** single unit of work (one zip / one repo).
- **JobGroup:** ordered collection of jobs submitted together; carries aggregate status, aggregate findings, budget, retention, and ownership.
- **GroupRun:** an execution of a group at a point in time. A group can be re-run (e.g. after a skill update); each run has its own results.

DDB schema additions:

```
PK=GROUP#{id}              SK=META         { name, owner, created_at, budget_usd, total_jobs, ... }
PK=GROUP#{id}              SK=RUN#{ulid}   { run_id, status, started_at, completed_at, jobs_total, jobs_done, ... }
PK=JOB#{id}                SK=META         { existing, plus group_id, group_run_id }
PK=GROUP#{id}/RUN#{run_id} SK=JOB#{job_id} { status, cost_usd, started_at, ended_at }
GSI3 (by group)            PK=GROUP#{id}   for listing jobs by group quickly
```

---

## 2. CLI Surface

```bash
$ skills-svc group create q3-security-audit --budget 200
group_id: 01HXX...

$ skills-svc group add 01HXX... ./repos.csv          # CSV: source_uri,name,...
✔ Queued 432 jobs

$ skills-svc group submit 01HXX...                   # starts a new GroupRun
run_id: 01HZZ...
estimated_cost: $176.40

$ skills-svc group status 01HXX...
GROUP q3-security-audit  RUN 01HZZ...
  total       432
  queued        4
  running      28
  completed   381
  failed       19
  cost_usd  $138.42 (budget $200)
  ETA        17m

$ skills-svc group results 01HXX... --format sarif > q3-merged.sarif
$ skills-svc group results 01HXX... --format csv   --findings-only > q3.csv
```

MCP tools: `skills_v2.group_create / group_add / group_submit / group_status / group_results`.

---

## 3. Submission Pipeline

```
group submit ─▶ GroupSubmitterLambda
                 │ create GROUP#/RUN# DDB items
                 │ chunk jobs (200 per chunk)
                 ▼
              SQS bulk-ingestion queue (separate from interactive queue)
                 │
                 ▼
              IngestionLambda (existing; carries group context in SQS attrs)
                 ▼
              ECS Fargate runners
```

Two queues so a single bulk submission doesn't starve interactive `upload` jobs. Both Lambdas share code; queues differ in concurrency reservation:
- `interactive`: reserved Lambda concurrency = 50, ECS scale target = aggressive
- `bulk`:        reserved Lambda concurrency = 200, ECS scale target = patient

---

## 4. Backpressure & Pacing

Group submitter throttles enqueue rate based on:
- ECS task concurrency cap (don't push more than `2 × max_tasks` ahead)
- Bedrock RPM budget for the model tier
- Group's own `--rate-limit` flag (jobs/min)

```ts
// packages/lambda/group-submitter/pacing.ts
const inflight = await countInflight(groupId);
if (inflight > 2 * MAX_TASKS) await sleep(1000);
```

---

## 5. Budget Enforcement Per Group

Group has `budget_usd`. Each completed job's cost accrues to `cost_usd_actual`. When `cost_usd_actual + cost_usd_inflight_estimate > 0.9 * budget` → emit `Skills/Group/BudgetWarn`; > budget → `BudgetExceeded` and **pause** the group (stop enqueuing). Operator may bump budget and resume.

```ts
if (groupRun.cost_usd_actual > groupRun.budget_usd) {
  await ddb.update(/* status=PAUSED, reason=BUDGET */);
  await sns.publish({ Topic: GROUP_TOPIC, Message: JSON.stringify({ event: 'group.budget_exceeded', groupId }) });
}
```

CLI: `skills-svc group resume <id> --bump-budget 50`.

---

## 6. Partial Failures & Retries

- Per-job retries: existing SQS visibility/redrive (3 attempts → DLQ).
- Per-group selective retry: `skills-svc group retry <run> --only-failed` creates a new GroupRun containing only failed jobs.
- Idempotency keys preserve dedup across retries.

---

## 7. Aggregate Results

Aggregation Lambda (triggered by GroupRun completion) computes:
- Merged SARIF (deduplicated by `{rule_id, location, fingerprint}`)
- CSV summary (severity counts per repo)
- HTML report rendered to S3 (static, presigned URL TTL 7 d)
- JSON summary with per-job links

```ts
// packages/lambda/group-aggregator/index.ts
const sarifs = await Promise.all(jobIds.map(id => loadSarif(id)));
const merged = mergeSarif(sarifs, { dedupeStrategy: 'fingerprint+rule+location' });
await s3.putObject({ Key: `groups/${groupId}/${runId}/merged.sarif`, Body: JSON.stringify(merged) });
```

---

## 8. Observability

Per-group dashboard auto-provisioned (CDK Aspect on group create):
- jobs by state (stacked area)
- cost burn vs budget (gauge + timeline)
- p50/p95 job duration
- top 10 longest jobs
- top 10 most expensive
- failure clusters (group failures by `error_code`)

Alarms (per-group, auto-created):
- failure rate > 10%
- cost burn rate > 2× expected
- ETA slips by > 50%

---

## 9. Streaming Progress

Long-running group: CLI subscribes via SSE endpoint (`/groups/{id}/events`) or MCP resource subscription (SPEC-53). Events: `job.enqueued`, `job.started`, `job.completed`, `job.failed`, `group.progress`, `group.completed`.

---

## 10. Retention

Group records inherit per-job retention (SPEC-38). Group meta + merged report kept until 30 d after the last job is purged. Erasure on a single job removes it from merged aggregates lazily (re-aggregation if requested).

---

## 11. Acceptance Criteria

- [ ] CSV ingest accepts ≥ 10k rows
- [ ] Bulk queue isolated from interactive queue (verified under load)
- [ ] Budget pause/resume works end-to-end
- [ ] Selective retry creates new GroupRun with only failed jobs
- [ ] Merged SARIF deduplicates correctly (unit-tested)
- [ ] Per-group dashboard auto-created
- [ ] Streaming progress arrives with < 5 s lag for ≥ 95% of events
- [ ] HTML report renders for groups up to 10k jobs without OOM
