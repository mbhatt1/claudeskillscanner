# SPEC-58: MCP Upload-and-Scan Flow

**Status:** AUTHORITATIVE — implementation spec
**Depends on:** SPEC-09, SPEC-29, SPEC-32 (MCP server), SPEC-10 (skill registry), SPEC-40 (supply chain), SPEC-45 (identity), SPEC-55 (workflows)
**Supersedes:** the implicit upload contract in SPEC-29 §6 (`submit_job` base64 path remains, but is now one of three ingress modes)

---

## 1. Problem

Today the MCP server exposes `submit_job` with a **base64-encoded zip** in the request body, capped at ~7.5MB. That works for trivial cases but fails the real security-engineer-with-Claude flow:

- **Large repos / monorepos** exceed 7.5MB even when zipped.
- **Public targets** (GitHub URLs, container images, S3 buckets) shouldn't have to be downloaded to the engineer's laptop just to ship them back up to AWS.
- **Streaming progress** is required — a 4-minute SAST scan with no signal looks frozen to the model and the model gives up.
- **One-shot scans** ("scan this repo for CWE-78") shouldn't require the model to chain `upload → submit_job → poll → get_result` correctly every time.

This spec defines three ingress modes, a streaming contract, and a `scan` convenience tool.

---

## 2. Three Ingress Modes

All three terminate in the same S3 → SQS → ECS pipeline. They differ only in how bytes get to S3.

### 2.1 Mode A — Inline (existing, unchanged)
`submit_job` with base64 zip. Hard cap **7.5MB** post-base64 (MCP message limits). Reserved for tiny skills' configs and unit-test fixtures.

### 2.2 Mode B — Presigned upload
New tool: **`upload.create`**.

```jsonc
{
  "name": "upload.create",
  "inputSchema": {
    "type": "object",
    "required": ["filename", "size_bytes", "sha256"],
    "properties": {
      "filename":    { "type": "string", "maxLength": 256 },
      "size_bytes":  { "type": "integer", "minimum": 1, "maximum": 5368709120 },  // 5 GiB
      "sha256":      { "type": "string", "pattern": "^[a-f0-9]{64}$" },
      "content_type":{ "type": "string", "default": "application/zip" }
    }
  }
}
```

Returns:
```jsonc
{
  "upload_id":   "ul_01J...",
  "method":      "PUT",
  "url":         "https://s3.../uploads/mcp/{caller}/{upload_id}/{filename}?X-Amz-...",
  "headers":     { "x-amz-server-side-encryption": "aws:kms", "x-amz-server-side-encryption-aws-kms-key-id": "..." },
  "expires_at":  "2026-05-13T18:00:00Z"
}
```

**Constraints:**
- Presigned URL TTL = **15 minutes**, single-use enforced via S3 conditional headers (`x-amz-content-sha256` must match the declared `sha256`).
- Server records `(upload_id, caller_arn, declared_sha256, declared_size, kms_key_id)` in DDB `UPLOADS#{id}` with TTL = 24h.
- Client (Claude) PUTs the bytes directly. On 2xx, calls `submit_job` with `upload_id` instead of `zip_b64`.
- `submit_job` rejects the upload if S3 object's actual `ETag`/`sha256` doesn't match the declared one.

This keeps Claude from streaming megabytes through the MCP transport.

### 2.3 Mode C — Server-side fetch
New tool: **`target.fetch`**.

```jsonc
{
  "name": "target.fetch",
  "inputSchema": {
    "type": "object",
    "required": ["kind", "uri"],
    "properties": {
      "kind": { "enum": ["git", "oci", "http", "s3"] },
      "uri":  { "type": "string", "maxLength": 2048 },
      "ref":  { "type": "string", "description": "git ref / oci tag, defaults to default branch / latest" },
      "include": { "type": "array", "items": { "type": "string" }, "maxItems": 64 },
      "exclude": { "type": "array", "items": { "type": "string" }, "maxItems": 64 }
    }
  }
}
```

Server runs the fetch inside a **separate Fargate task** (`target-fetcher` image, no scanning code, network egress allowlisted per `kind`):
- `git` → `git clone --depth 1 --filter=blob:limit=10M` to ephemeral EFS, then zip
- `oci` → `crane export` (no docker daemon)
- `http` → single GET, max 1 GiB, content-type sniffed
- `s3` → cross-account read if caller's role has access; never via MCP server's own identity

Returns the same shape as `upload.create` finalization: `{ upload_id, sha256, size_bytes, fetched_at }`. From there, `submit_job` proceeds normally.

**Why a separate task:** the MCP server Lambda has no egress to the internet (private subnets, no NAT — SPEC-01). Egress is intentional friction; fetches go through a hardened, audited path with per-`kind` allowlists.

---

## 3. Streaming Progress

SPEC-32 added MCP notifications. This spec defines the **job progress channel**.

### 3.1 Progress notification shape
```jsonc
{
  "jsonrpc": "2.0",
  "method":  "notifications/progress",
  "params": {
    "progressToken": "job_01J...",
    "progress":      0.42,
    "total":         1.0,
    "message":       "Running semgrep (rule pack: owasp-top-10): 1247/3000 files",
    "phase":         "scan",         // ingest|scan|index|publish
    "findings_so_far": 17
  }
}
```

### 3.2 Producer side
- ECS task writes progress lines to stdout as **NDJSON** with `{phase, progress, message, findings_so_far?}`.
- A sidecar **`progress-relay`** container tails the log stream and writes to a DDB `JOB#{id}` item's `progress` attribute (DDB Streams → EventBridge → MCP server long-poll).
- Cadence: at most **1 update / 2s** per job (relay-side throttle).

### 3.3 Consumer side
- `submit_job` and `scan` (§4) accept `stream: true`. When set, the MCP server holds the request open and emits `notifications/progress` until terminal state (`completed | failed | cancelled`).
- Max stream duration = **15 min** (Lambda timeout). If the job is still running, server sends a final notification with `phase: "detached"` and returns the `job_id` so the client can re-attach via `job.attach`.
- New tool **`job.attach`**: same streaming behavior, starting from current state.

### 3.4 Cancellation
New tool **`job.cancel`**: idempotent, requires caller to own the job. Server sends ECS `StopTask` with reason `mcp-client-cancel`. Job transitions to `cancelled`; partial findings are *not* indexed.

---

## 4. The `scan` Convenience Tool

Hide the orchestration. Most security-engineer prompts are "scan X for Y" — the model shouldn't have to wire it.

```jsonc
{
  "name": "scan",
  "description": "One-shot: fetch target, run scanner skill(s), return findings. Streams progress.",
  "inputSchema": {
    "type": "object",
    "required": ["target", "scanners"],
    "properties": {
      "target": {
        "oneOf": [
          { "type": "object", "required": ["upload_id"], "properties": { "upload_id": { "type": "string" } } },
          { "type": "object", "required": ["kind", "uri"], "properties": { "kind": { "enum": ["git","oci","http","s3"] }, "uri": { "type": "string" }, "ref": { "type": "string" } } }
        ]
      },
      "scanners": {
        "type": "array",
        "minItems": 1, "maxItems": 8,
        "items": { "type": "string", "description": "skill id, e.g. 'secret-scanner@1.4.2' or 'secret-scanner' for latest signed" }
      },
      "stream": { "type": "boolean", "default": true },
      "fail_on": { "enum": ["never", "high", "critical"], "default": "never" }
    }
  }
}
```

**Semantics:**
1. If `target` is a fetch spec, invoke `target.fetch` internally; otherwise resolve `upload_id`.
2. Resolve each scanner against the signed skill registry (SPEC-10, SPEC-40). Reject unsigned or revoked skills.
3. If `scanners.length == 1`, equivalent to `submit_job` with that skill.
4. If `>1`, materialize a **fan-out workflow** (SPEC-55) with implicit `merge-findings` terminal node. Returns one `job_id` (the workflow id).
5. Stream merged progress (max of child progress, weighted).
6. Final response: structured findings + a `result_uri` pointing at the OpenSearch-backed query for the run.

This is the tool Claude should reach for **first**; `submit_job` / `workflow.run` are escape hatches.

---

## 5. Artifact Handoff From Claude Code

Claude Code clients can attach files to a chat. The MCP transport doesn't carry attachments natively. Bridge:

1. **Claude Code MCP client** detects an attachment in scope when a tool with `upload_id` in its schema is about to be called.
2. Client calls `upload.create` with the attachment's metadata, PUTs bytes to the returned URL, then injects `upload_id` into the tool arguments transparently.
3. The MCP server treats it as Mode B. The model never sees the bytes.

A client capability flag `attachments.autoUpload = true` is announced during `initialize`; servers that see this flag may surface the `target` field with `oneOf` to hint that an attachment is acceptable.

---

## 6. Authorization & Quotas

- **Per-caller quotas** (SPEC-41 finops integration):
  - Max concurrent jobs: tier-based (free=2, team=10, enterprise=100)
  - Max upload bytes / 24h: tier-based
  - `target.fetch http` rate limited to 60/hr/caller; `git` to 30/hr/caller
- All four new tools require `skills:InvokeMCP` IAM permission (SPEC-45). `target.fetch` additionally requires `skills:FetchTarget`. Separating them lets orgs disable internet-fetch while keeping uploads.
- Every tool call logs `{caller_arn, tool, args_hash, job_id?, upload_id?, outcome}` to CloudTrail Data Events.

---

## 7. Failure Modes (must be in error catalog)

| Code | Condition |
|------|-----------|
| `SKL-UP-2001` | declared sha256 doesn't match S3 object after PUT |
| `SKL-UP-2002` | upload expired (>15 min since `upload.create`) |
| `SKL-UP-2003` | declared size exceeds caller's tier limit |
| `SKL-TF-2101` | `target.fetch` URI rejected by allowlist |
| `SKL-TF-2102` | fetched artifact exceeds size limit |
| `SKL-TF-2103` | git ref not found / repo private without credentials |
| `SKL-SC-2201` | `scan` referenced unsigned/revoked scanner |
| `SKL-SC-2202` | `scan` `fail_on` threshold met (non-zero exit for CI use) |
| `SKL-JB-2301` | `job.cancel` raced terminal state |

Errors include `retryable: bool` and, for size/quota errors, a `quota_request_uri` (SPEC-56).

---

## 8. Implementation Order

1. `upload.create` + `submit_job` accepting `upload_id` (Mode B). One sprint — unblocks large repos immediately.
2. Progress relay sidecar + `notifications/progress` wiring + `job.attach` + `job.cancel`. One sprint.
3. `target.fetch` Fargate task + per-`kind` allowlists. Two sprints (security review on egress).
4. `scan` convenience tool + workflow fan-out adapter. One sprint.
5. Claude Code client capability for transparent attachment upload. Coordinated with Claude Code release.

---

## 9. Tests

Tests are **required, not optional**. Each item below must exist before the corresponding section ships. Test files live under `packages/lambda/src/mcp/__tests__/` and `packages/ecs-runner/__tests__/`; integration tests under `infra/test/integration/`.

### 9.1 Unit tests — `upload.create` (Mode B)
- `upload-create.spec.ts`
  - rejects `size_bytes > tier_max` with `SKL-UP-2003` and populates `quota_request_uri`
  - rejects malformed `sha256` (length, hex) via JSON Schema before any AWS call
  - returns presigned URL with KMS SSE headers; URL expires at exactly 15 min
  - records `UPLOADS#{id}` item with TTL=24h and `caller_arn` from `callerArn`, not from args
  - two concurrent `upload.create` calls produce distinct `upload_id`s (ULID monotonic test, 1000 iterations)
- `submit-job-with-upload-id.spec.ts`
  - rejects with `SKL-UP-2001` when S3 object sha256 ≠ declared sha256 (HeadObject mock)
  - rejects with `SKL-UP-2002` when upload record is missing / expired
  - rejects when `caller_arn` on submit ≠ `caller_arn` on upload (cross-tenant)
  - happy path: links `JOB#{id}` → `UPLOADS#{id}` and emits SQS message

### 9.2 Unit tests — `target.fetch` (Mode C)
- `target-fetch-allowlist.spec.ts` — table-driven, **must include**:
  - `http://169.254.169.254/...` → reject `SKL-TF-2101` (IMDS)
  - `http://[::1]/`, `http://127.0.0.1/`, `http://10.0.0.1/`, `http://192.168.1.1/`, `http://172.16.0.1/` → reject
  - DNS rebinding: hostname that resolves to public IP at parse time but RFC1918 at fetch time → reject (test the resolver wrapper, not just URL parsing)
  - `git@github.com:...` ssh form → reject (https only)
  - `oci://` without registry allowlist → reject
  - `s3://` cross-account without caller's role granting access → reject
- `target-fetch-size.spec.ts` — git clone exceeding `--filter=blob:limit=10M` or final zip > limit returns `SKL-TF-2102` and leaves no EFS residue
- `target-fetch-ref.spec.ts` — nonexistent ref returns `SKL-TF-2103`; default branch resolution works for repos without `main`/`master`

### 9.3 Unit tests — streaming (`notifications/progress`, `job.attach`, `job.cancel`)
- `progress-relay.spec.ts`
  - throttle: 100 NDJSON lines in 1s produce ≤1 DDB write (verify with mocked clock)
  - malformed NDJSON line is dropped, does not crash relay, increments `progress_parse_errors` metric
  - terminal phase (`completed`/`failed`/`cancelled`) flushes immediately, bypasses throttle
- `mcp-stream.spec.ts`
  - `submit_job { stream: true }` emits ≥1 progress notification before terminal response
  - 15-min Lambda timeout → emits `phase: "detached"` final notification with `job_id`
  - `job.attach` mid-run resumes from current `progress`, does not replay history
  - `job.cancel` is idempotent (second call returns success, not `SKL-JB-2301`)
  - `job.cancel` on already-terminal job returns `SKL-JB-2301` with `retryable: false`
  - cross-tenant `job.cancel` returns 403, not 404 (don't leak existence)

### 9.4 Unit tests — `scan` convenience tool
- `scan-resolve.spec.ts`
  - unsigned scanner rejected with `SKL-SC-2201`; revoked scanner same error, distinct sub-reason
  - `scanners: ["secret-scanner"]` resolves to latest signed version pinned at submit time (not at execute time — pin verified by snapshot)
  - `scanners.length == 1` path emits exactly one `JOB#{id}`, no workflow record
  - `scanners.length > 1` path emits one workflow row with N child jobs + `merge-findings` node
- `scan-fail-on.spec.ts`
  - `fail_on: "high"` with findings of severity `high|critical` returns `SKL-SC-2202` with `retryable: false`
  - `fail_on: "never"` returns success even with critical findings
  - threshold check runs on merged findings, not per-scanner

### 9.5 Property tests (SPEC-34c)
- `upload.create.property.ts` — fuzz `size_bytes` across [-1, 2^63]; fuzz `sha256` across {empty, wrong length, non-hex, mixed case}. Invariant: never returns a presigned URL on invalid input.
- `target.fetch.property.ts` — fuzz `uri` with [URL-from-corpus, random bytes, unicode homoglyphs of `github.com`]. Invariant: any URI resolving to a non-public IP at fetch time is rejected.
- `scan.property.ts` — generate `scanners` arrays of size 0..16 mixing valid/invalid ids. Invariant: response either succeeds with exactly N findings groups or fails with a single catalog error.

### 9.6 Integration tests (deployed stack, ephemeral env)
Run via `infra/test/integration/spec-58/`. Each test creates a scoped IAM role, runs, asserts, tears down.
- `upload-large-zip.test.ts` — generate a 1.5 GiB zip of random bytes, PUT via presigned URL, submit job, assert ECS task starts within 30s and result row appears in DDB
- `git-fetch-public.test.ts` — fetch `github.com/OWASP/NodeGoat`, run `secret-scanner@latest`, assert ≥1 finding
- `scan-fanout.test.ts` — `scan` with two scanners, assert one workflow row, two child jobs, merged result document in OpenSearch
- `cancel-mid-scan.test.ts` — start a scan, call `job.cancel` 5s in, assert ECS task in `STOPPED` within 10s, assert **zero** documents in OpenSearch for that `job_id`
- `progress-cadence.test.ts` — subscribe via `stream: true`, assert ≥1 notification every 5s for the duration of an active phase

### 9.7 Security tests (must run in CI, block merge on failure)
- `redteam-ssrf.test.ts` — exhaustive SSRF corpus against `target.fetch`:
  - all RFC1918, link-local, loopback, multicast, IPv6 ULA/link-local
  - cloud metadata endpoints: AWS `169.254.169.254`, GCP `metadata.google.internal`, Azure `169.254.169.254`, Alibaba `100.100.100.200`
  - DNS rebinding via a test-controlled authoritative server that flips A records between calls
  - HTTP redirect chains terminating at internal addresses (3xx must be re-validated, not blindly followed)
- `redteam-zip.test.ts` — uploads of:
  - zip bombs (1KB → 10GB) → ingestion Lambda rejects pre-ECS
  - path traversal (`../../etc/passwd` entries) → unzip in runner refuses
  - symlinks pointing outside extract dir → refused
- `redteam-auth.test.ts` — caller A uploads, caller B attempts `submit_job` with A's `upload_id` → `SKL-UP-2001`-class error, audit log records the attempt with `outcome: "denied"`

### 9.8 Observability assertions
Every integration test asserts the corresponding CloudTrail Data Event was emitted with `{caller_arn, tool, args_hash, outcome}` and that the structured log line for the tool call carries the same `trace_id` as the resulting ECS task definition. Missing telemetry fails the test even when functionality passes.

### 9.9 Performance / load (nightly, non-blocking)
- 50 concurrent `scan` calls, each with 100 MiB target — p95 end-to-end ≤ 10 min, no throttling errors surfaced to caller
- 1000 concurrent `upload.create` calls — p99 latency ≤ 500ms (presign is CPU-only, should be flat)

---

## 10. Acceptance Criteria

- [ ] A 1.2 GiB repo zip uploads via Mode B and runs `secret-scanner` end-to-end in <5 min wall-clock from a Claude Code session.
- [ ] `scan { target: { kind: "git", uri: "github.com/acme/api" }, scanners: ["secret-scanner","semgrep-owasp"] }` returns merged findings without the model issuing more than one tool call.
- [ ] Streaming progress arrives at the MCP client at >=1 notification/5s during active scan phases.
- [ ] `job.cancel` stops the ECS task within 10s and leaves no partial findings in OpenSearch.
- [ ] `target.fetch` cannot reach RFC1918 / link-local / metadata endpoints; verified by red-team test in CI.
- [ ] All four new tools have property tests (SPEC-34c) for input-schema invariants.
- [ ] Error catalog updated; `quota_request_uri` populated on size/quota errors.
- [ ] All tests in §9 implemented and passing; security tests (§9.7) wired as required CI checks.
