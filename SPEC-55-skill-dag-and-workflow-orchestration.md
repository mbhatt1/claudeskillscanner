# SPEC-55 — Skill DAG & Workflow Orchestration

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-02 (ECS runner), SPEC-49 (job groups), SPEC-53 (MCP sagas)
**Related:** SPEC-39 (eval), SPEC-44 (contracts), SPEC-54 (SDK)

> SPEC-53 sagas chain MCP tool calls. This is the *layer above* — declarative DAGs of skills where one skill's output is another's input, with fan-out/fan-in, conditional steps, retries, and aggregate budgets.

---

## 1. Concepts

- **Workflow:** a versioned, named DAG of skill invocations
- **Node:** one skill invocation
- **Edge:** dataflow `producer.output[path] → consumer.input[path]`
- **Run:** an execution of a workflow against a specific input

Workflows are first-class citizens with their own DDB records, observability, signing, and marketplace listing.

---

## 2. Workflow Definition

YAML (or JSON) under `workflows/`:

```yaml
# workflows/security-triage.workflow.yml
schema_version: 1
id: security-triage
version: 1.2.0
inputs:
  repo: { type: string, required: true }
nodes:
  scan:
    skill: security-review@^1.4
    input:
      source: "{{ inputs.repo }}"
    timeout: 30m
  classify:
    skill: cwe-classifier@^0.5
    input:
      findings: "{{ scan.outputs.findings }}"
    depends_on: [scan]
  triage_high:
    skill: triage-recommender@^2.0
    if: "{{ classify.outputs.has_high }}"
    input:
      findings: "{{ classify.outputs.high }}"
    depends_on: [classify]
  summarize:
    skill: report-writer@^1.0
    input:
      scan: "{{ scan.outputs.findings }}"
      classification: "{{ classify.outputs }}"
      triage: "{{ triage_high.outputs }}"      # may be null when triage_high skipped
    depends_on: [classify, triage_high]
outputs:
  report: "{{ summarize.outputs.report_uri }}"
  findings_count: "{{ classify.outputs.count }}"
budget:
  max_cost_usd: 10.00
  max_wall_seconds: 3600
retry:
  default: { attempts: 2, backoff: exponential }
on_error:
  - match: { code: COST_CAP_EXCEEDED }
    action: abort
  - match: { code: TRANSIENT }
    action: retry
```

Templating is **restricted JSON-path** (`{{ node.outputs.path }}`) — not a general-purpose template engine; deterministic, side-effect free.

---

## 3. Validation

`skills-svc workflow validate workflows/security-triage.workflow.yml`:
- Schema valid
- DAG acyclic
- All referenced skills exist and version ranges resolve
- All `depends_on` covered by dataflow or explicit declaration
- All `inputs.*` consumed somewhere (warn if unused)
- All node `input` paths exist in producer's `output_schema`
- `if` predicates type-check against producer's output

Schema source of truth: skill manifests publish `input_schema` and `output_schema` (zod-derived JSON Schema, SPEC-44 §3).

---

## 4. Engine

```
WorkflowSubmitter (Lambda)
  │ create WORKFLOW#/RUN# records, build plan
  ▼
Step Functions Express  (state-machine compiled from DAG)
  │ Map states for fan-out
  │ Task states invoke ingestion via SDK
  ▼
Per-node SQS message → existing IngestionLambda → ECS runner
  │ on completion: ResultsProcessor publishes to internal EventBridge bus
  ▼
Step Functions resumes (waitForTaskToken pattern)
```

Why Step Functions: rich retry/error handling, visible execution graph, ≤ 25k state transitions/run sufficient for DAGs up to ~5k nodes. Existing per-job pipeline reused — workflow engine is *orchestration only*, not a second execution engine.

---

## 5. Dataflow

Producer node writes outputs to `s3://skills-svc-results/{job_id}/output.json` (existing). Workflow engine, on completion, **does not move data** — it passes S3 URIs + JSON-path hints to the consumer. Consumer SDK resolves the path lazily:

```ts
// In consumer skill
const findings = await ctx.inputRef('findings').resolve();   // fetches from S3, caches
```

For large outputs, consumers stream. For small (< 1 MB), engine inlines into the SQS message.

---

## 6. Fan-out / Fan-in

Native Map state:

```yaml
nodes:
  per_repo_scan:
    map: "{{ inputs.repos }}"             # list
    skill: security-review@^1.4
    input: { source: "{{ item }}" }
    concurrency: 10
  aggregate:
    skill: aggregator@^1.0
    input: { results: "{{ per_repo_scan.outputs }}" }   # list
    depends_on: [per_repo_scan]
```

Concurrency bounded by manifest + budget; engine throttles enqueue.

---

## 7. Conditionals & Early Exit

`if` evaluated against producer outputs:
- Truthy → node runs
- Falsy → node skipped, downstream sees `null`
- Errors during eval → node fails, on_error rules apply

Explicit `terminate` action ends workflow with a status code, useful for "no findings → skip rest":

```yaml
nodes:
  scan: { skill: security-review@^1.4, input: {...} }
  short_circuit:
    if: "{{ scan.outputs.findings.length == 0 }}"
    action: terminate
    status: NO_FINDINGS
```

---

## 8. Budgets & Limits

Workflow-level cost cap aggregates across nodes (extends SPEC-49 group budget). On cap exceeded: in-flight nodes finish; new nodes blocked; status PAUSED. Operator resume or cancel.

Wall-time cap analogous.

---

## 9. Retries & Error Routing

Per-node and workflow-default retry policies. `on_error` rules match by `code` from `SkillError` (SPEC-43 §12) and choose: retry, abort, skip-and-continue, route-to-fallback-node.

```yaml
nodes:
  scan:
    skill: security-review@^1.4
    on_error:
      - match: { code: SKL_BEDROCK_THROTTLED }
        action: retry
        attempts: 5
      - match: { code: SKL_INVALID_INPUT }
        action: route
        to: fallback_simple_scan
```

---

## 10. Observability

For each run:
- Step Functions execution graph (visualizes DAG)
- Per-node duration, cost, retries
- Workflow dashboard (CDK Aspect auto-creates) — analogous to SPEC-49 §8
- Trace propagation: workflow `run_id` flows into each node's `trace_id` baggage

EMF: `Skills/Workflow/{Invocations,Duration,Cost,FailedNodes}` dims `workflow_id,version`.

---

## 11. Workflow Marketplace

Workflows publishable like skills:
- Versioned, semver
- Signed (cosign, SPEC-40)
- Discoverable in catalog (SPEC-48) under `kind=workflow`
- Manifest declares skill range deps; resolver chooses concrete versions at run-time
- Workflow has its own eval/corpus (input → expected output)

CLI: `skills-svc workflow run security-triage --input repo=https://...`.

---

## 12. MCP Surface

```jsonc
"skills_v2.workflow_list"
"skills_v2.workflow_run"        // { workflow_id, version?, input } → run_id
"skills_v2.workflow_status"     // run_id → graph + per-node state
"skills_v2.workflow_cancel"
```

Long runs use subscription (SPEC-53 §1) on `skills://workflows/{run_id}/progress`.

---

## 13. Determinism & Replay

- Inputs to each node are content-hashed; identical hashes can replay from cache if `cache: true` set
- Run manifest captured: workflow SHA, all skill SHAs, model IDs/versions, prompt SHAs, seeds
- Replay command: `skills-svc workflow replay <run_id>` — deterministic re-run with same artifacts

---

## 14. Limits

- Max nodes: 200 per workflow
- Max fan-out: 1000 per Map state
- Max wall: 24 h
- Max depth: 30
- Max output inlined: 1 MB (else S3 URI)

These mirror Step Functions limits; engine pre-validates.

---

## 15. Acceptance Criteria

- [ ] `workflow validate` rejects cycles, type mismatches, missing schemas
- [ ] Engine runs the `security-triage` reference workflow end-to-end
- [ ] Map fan-out with concurrency limit works under load
- [ ] Conditional + early-exit observed
- [ ] Workflow budget pause/resume drilled
- [ ] Replay produces identical artifacts (modulo timestamps)
- [ ] Workflows publishable via skill-marketplace flow
- [ ] MCP `workflow_run` + progress subscription validated
- [ ] Per-workflow dashboard auto-created
