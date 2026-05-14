# SPEC-35: Final Gap Closure — Cross-Spec Reconciliation, Operational Hardening, and Authoritative Resolution

**Status:** Authoritative. Supersedes conflicting items in SPEC-01 through SPEC-34c as enumerated below.
**Audit basis:** Parallel review of all 35 prior specs (SPEC-01..SPEC-34c) by 10 independent agents. ~200 gaps identified across 14 categories. This spec closes every gap with prescriptive fixes, or explicitly defers with a tracked rationale.
**Reading order:** This spec is the single source of truth for any topic it covers. Where it conflicts with a prior spec, this spec wins. Where it is silent, the most recent prior spec wins.

---

## Index

0. Supersession Matrix
1. Schema Reconciliation (JobStatus, JobRecord, RunResult, QueryRequest/Response, SearchResult)
2. Authoritative File Manifest & Anti-Manifest (files that must / must-not exist)
3. SSM Parameter Registry (single source of truth)
4. IAM, KMS, and Encryption-Context Closure
5. CDK Stack Dependency Graph & Deploy Order
6. CLI Surface Reconciliation (flags, exit codes, errors, env vars)
7. MCP Server Closure (errors, dedup, CORS, auth, EventBridge)
8. Code-Review Subsystem Closure (SPEC-25/26/28/29 gaps; replaces missing SPEC-27)
9. Skill Registry Lifecycle (signing, deprecation, version constraints, retention)
10. Knowledge Store & Backfill Closure
11. Observability (tracing, metrics, logs, dashboards)
12. Operational Runbooks (deploy, incident, break-glass, rotation, DR)
13. Multi-Region, Cost Controls, Data Retention, GDPR/PII
14. QA Test Runner Closure (QA-101..QA-400, including SPEC-23/24)
15. Anti-Patterns & Reversal Tax (work to undo from prior specs)
16. Open Questions Still Deferred (with owners & dates)

---

## 0. Supersession Matrix

The following table is authoritative. When implementing, use the listed "Authoritative spec" only; ignore the same topic in any "Superseded by" spec listed below it.

| Topic | Authoritative spec/section | Supersedes |
|---|---|---|
| AOSS hybrid query, post_filter, per-user filter | SPEC-30 Fix A | SPEC-03 §3.4–3.5, SPEC-05 QA-062, SPEC-09 search wiring |
| Envelope encryption context (must include `userArn`) | SPEC-30 Fix D + §4.6 here | SPEC-06 §4 |
| EventBridge rule for ECS task completion | SPEC-32 B14 + §7.5 here | SPEC-30 D-3 (S3Event variant) |
| MCP authentication | SPEC-29 Fix 2 + SPEC-32 B1..B7 | SPEC-09 §1, SPEC-13 Fix 12 (Claude Desktop), SPEC-28 Fix 2 cache TTL |
| Deployment runbook & stack order | §5 here | SPEC-12 Fix 30, SPEC-13 Fix 4 |
| KMS uploads key parameter | §3 here (`/skills-svc/{env}/kms/uploads-key-arn`) | SPEC-15 Fix 21 rename, SPEC-18 Fix 8 |
| Cache key computation for skill artifacts | §3 here (S3 ChecksumSHA256, no download) | SPEC-15 Fix 10 (download zip) |
| JobStatus enum | §1.1 here (QUEUED, RUNNING, COMPLETE, FAILED) | SPEC-03:454 (PENDING) — all references rename PENDING→QUEUED |
| QueryRequest / QueryResponse / SearchResult shapes | §1.3 here | SPEC-03 §4.1, SPEC-30 Fix A/B |
| CLI Claude Desktop MCP authorizer | §15 here (anti-manifest: must not exist) | SPEC-13 Fix 12 |
| Bedrock model parameter SSM path | §3 here (`/skills-svc/{env}/bedrock/claude-model-id`); api-key path removed | SPEC-24 Fix 1 (api-key path is wrong) |
| Skill artifact integrity & signing | §9.1 here | SPEC-10 §2 (silent) |
| Skill deprecation lifecycle | §9.2 here | SPEC-10 §3, SPEC-20 Fix 5 |
| Cache key collision policy | §6.5 here | SPEC-08 §cache (silent) |

---

## 1. Schema Reconciliation

### 1.1 `JobStatus` enum (authoritative)

```ts
// packages/shared/src/types.ts
export enum JobStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  COMPLETE = 'COMPLETE',
  FAILED = 'FAILED',
}
```

**Required edits:** every occurrence of `JobStatus.PENDING` in SPEC-03 (lines 471, 485, 745, 888, 900) and in any package, lambda, or test maps to `QUEUED`. No code path may reference `PENDING`. CI lint rule: `grep -R "JobStatus.PENDING" packages infra` MUST return zero matches (added to qa-run-all.sh as QA-401).

### 1.2 `JobRecord` (DDB item shape — final)

```ts
export interface JobRecord {
  PK: string;          // "JOB#<jobId>"
  SK: string;          // "META"
  GSI1PK: string;      // "STATUS#<JobStatus>"
  GSI1SK: string;      // "<ISO8601 createdAt>"
  GSI2PK: string;      // "USER#<userArn>"          ← required (multi-tenant)
  GSI2SK: string;      // "<ISO8601 createdAt>"
  jobId: string;
  userArn: string;     // SPEC-30 Fix D, required
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  sfnExecutionArn?: string;
  bedrockModelId?: string;
  promptHash?: string;     // SHA-256 of full prompt (use for audit; raw prompt NEVER persisted)
  temperature?: number;
  ttl?: number;            // §13.3
  schemaVersion: number;   // §1.6
}
```

**Race fix (closes SPEC-12 Fix 8 gap):** Job records MUST be created with a single `TransactWriteItems` containing both the `META` Put and the SFN-execution-arn placeholder. The Update-after-Put pattern is forbidden because it leaves `sfnExecutionArn` empty if SFN start fails. If SFN start fails after the transact, mark the job FAILED and write a `JOB#<jobId> / FAILURE` audit item.

### 1.3 `QueryRequest`, `QueryResponse`, `SearchResult`

```ts
export interface QueryRequest {
  callerUserArn: string;   // mandatory — replaces SPEC-03 optional `filterByUser`
  q: string;
  k?: number;              // default 20, max 100
  from?: number;           // default 0, max 1000
  filters?: { skillName?: string; tags?: Record<string,string> };
}
export interface QueryResponse {
  results: SearchResult[];
  total: number;
  from: number;
  hasMore: boolean;
  queryDurationMs: number;
  schemaVersion: number;
}
export interface SearchResult {
  jobId: string;
  userArn: string;         // SPEC-30 Fix A required
  s3ResultKey: string;     // SPEC-30 Fix A required
  score: number;
  snippet: string;
  skillName?: string;
  createdAt: string;
}
```

### 1.4 `RunResult` (ECS-runner output JSON)

Required fields: `jobId`, `userArn`, `s3ResultKey`, `bedrockModelId`, `outputs` (schema-validated), `tokensIn`, `tokensOut`, `elapsedMs`, `schemaVersion`. No optional fields. The runner MUST fail the task if any required field cannot be set rather than emitting a partial result.

### 1.5 Skill manifest (`manifest.json`)

`outputSchema` field is **required** (was optional in SPEC-22 Fix 11). Breaking-change detection: on `skill push`, the validator Lambda computes a structural diff vs the previous version's `outputSchema`; if a field is removed or its type narrows, the push MUST fail with `SKILL_SCHEMA_BREAKING_CHANGE` unless the MAJOR version was bumped.

### 1.6 `schemaVersion` field (new — universal)

All persisted JSON/DDB records (JobRecord, RunResult, SearchResult, FindingRecord, SkillVersion) carry a `schemaVersion: number` field. Migration policy in §13.5.

---

## 2. Authoritative File Manifest & Anti-Manifest

**This is the canonical file list. Anything not here is unmanaged.**

### 2.1 Required files (must exist)

```
infra/bin/app.ts
infra/lib/network-stack.ts
infra/lib/security-stack.ts
infra/lib/storage-stack.ts
infra/lib/messaging-stack.ts
infra/lib/lambda-stack.ts
infra/lib/ecs-stack.ts
infra/lib/knowledge-store-stack.ts
infra/lib/skill-registry-stack.ts
infra/lib/mcp-stack.ts
infra/lib/monitoring-stack.ts
infra/lib/compliance-stack.ts
infra/lib/code-review-stack.ts
infra/lib/aspects/no-wildcard-iam.ts
infra/lib/aspects/tagging-enforcer.ts
infra/lib/aspects/encryption-context-enforcer.ts   ← new (§4.5)
infra/test/<one file per stack>.test.ts
packages/shared/src/types.ts
packages/shared/src/constants.ts
packages/shared/src/branded.ts                     ← SPEC-34a
packages/shared/src/encryption-context.ts          ← §4.5
packages/cli/src/commands/{configure,upload,status,list-jobs,query,results,logs,assume-role,batch,diff,cost,notify,audit,schedule,watch,validate,skill,compliance,dlq,mcp,review}.ts
packages/cli/src/credentials.ts                    ← §6.6
packages/lambda/src/ingestion/handler.ts
packages/lambda/src/ingestion/validator.ts
packages/lambda/src/results-processor/handler.ts
packages/lambda/src/query/handler.ts
packages/lambda/src/bootstrap-index/handler.ts
packages/lambda/src/mcp/handler.ts
packages/lambda/src/mcp/authorizer.ts
packages/lambda/src/webhook/handler.ts
packages/lambda/src/findings-writer/handler.ts
packages/lambda/src/dlq-processor/handler.ts
packages/lambda/src/backfill/handler.ts            ← §10.3
packages/lambda/src/skill-validator/handler.ts
packages/ecs-runner/src/main.ts
packages/ecs-runner/src/extractor.ts
packages/knowledge-store/src/{client,embeddings,indexer,searcher}.ts
```

### 2.2 Anti-manifest (must NOT exist)

The following files MUST NOT exist. Their presence fails CI (QA-402, a `find` assertion):

```
packages/lambda/src/mcp-authorizer/         ← SPEC-13 Fix 12 reversal
packages/lambda/src/claude-desktop/         ← SPEC-14 reversal
infra/lib/mcp-stack.ts: any reference to `/mcp/desktop`, `lambdaAuthorizer` (API key flavour), Secrets Manager API-key secret
**any file under packages/** referencing `JobStatus.PENDING`
**any file** writing `Resource: ['*']` in an IAM policy (NoWildcardIAMAspect already enforces, but the file-level grep is QA-403)
```

---

## 3. SSM Parameter Registry

All cross-stack values are passed via SSM (CDK does not synth dynamic cross-stack refs for runtime values). Single namespace `/skills-svc/{env}/`. **Bedrock api-key path is forbidden** (closes SPEC-24 Fix 1 gap: there is no Bedrock api-key; access is by IAM).

| Path | Writer (stack) | Reader(s) | Type | Notes |
|---|---|---|---|---|
| `/skills-svc/{env}/network/vpc-id` | NetworkStack | All VPC consumers | String | |
| `/skills-svc/{env}/network/private-subnets` | NetworkStack | LambdaStack, ECSStack | StringList | |
| `/skills-svc/{env}/storage/uploads-bucket-name` | StorageStack | LambdaStack, ECSStack, CLI | String | |
| `/skills-svc/{env}/storage/uploads-bucket-arn` | StorageStack | IAM policies | String | |
| `/skills-svc/{env}/storage/results-bucket-name` | StorageStack | ResultsProcessor, ECS, Query | String | |
| `/skills-svc/{env}/storage/jobs-table-name` | StorageStack | Lambda, MCP | String | |
| `/skills-svc/{env}/storage/skills-table-name` | StorageStack | SkillValidator, MCP | String | |
| `/skills-svc/{env}/storage/findings-table-name` | StorageStack | FindingsWriter | String | |
| `/skills-svc/{env}/kms/uploads-key-arn` | SecurityStack | All uploaders | String | **arn**, not id — closes SPEC-15 rename |
| `/skills-svc/{env}/kms/results-key-arn` | SecurityStack | All result writers/readers | String | |
| `/skills-svc/{env}/kms/registry-key-arn` | SecurityStack | SkillValidator, skill push CLI | String | |
| `/skills-svc/{env}/kms/aoss-key-arn` | SecurityStack | KnowledgeStoreStack | String | |
| `/skills-svc/{env}/messaging/ingestion-queue-url` | MessagingStack | CLI, Lambda | String | |
| `/skills-svc/{env}/messaging/results-dlq-url` | MessagingStack | DLQ processor | String | |
| `/skills-svc/{env}/messaging/notification-topic-arn` | MessagingStack | Lambda | String | |
| `/skills-svc/{env}/bedrock/claude-model-id` | LambdaStack (custom resource) | Ingestion, ECS runner | String | resolved via `ListFoundationModels` at deploy |
| `/skills-svc/{env}/knowledge-store/collection-endpoint` | KnowledgeStoreStack | Query Lambda, Indexer | String | |
| `/skills-svc/{env}/mcp/api-id` | McpStack | CLI mcp client | String | |
| `/skills-svc/{env}/mcp/endpoint` | McpStack | CLI mcp client | String | |
| `/skills-svc/{env}/regions/approved` | NetworkStack | deploy.sh, SCPs | StringList | closes SPEC-20 Fix 1 |
| `/skills-svc/{env}/aspects/encryption-context-version` | SecurityStack | Crypto helpers | String | §4.5/13.5 |

**Writer must use `aws_ssm.StringParameter` (not Token resolution).** Reader behavior: at Lambda cold start, fetch via SDK with `WithDecryption: false`, cache in-process. On miss, fail fast with `SSM_PARAM_MISSING` and a structured log entry naming the path. No silent defaults.

---

## 4. IAM, KMS, and Encryption-Context Closure

### 4.1 NoWildcardIAMAspect (SPEC-34b) — extension

Aspect MUST also reject `Action: '*'` and `Action: 'kms:*'`. Allowed exceptions: explicit `iam:PassRole` with a resource ARN, CloudWatch Logs `logs:CreateLogStream`+`logs:PutLogEvents` to a single LogGroup ARN. Any other wildcard fails synth.

### 4.2 Cross-account trust policy (closes SPEC-06 §5 gap)

For two-account deployments (control / data), `infra/lib/security-stack.ts` MUST instantiate the data-account user role with:

```ts
const trust = new iam.PrincipalWithConditions(
  new iam.AccountPrincipal(props.controlAccountId),
  { Bool: { 'aws:MultiFactorAuthPresent': 'true' },
    NumericLessThan: { 'aws:MultiFactorAuthAge': '3600' } });
```

Break-glass role (SPEC-06 §13) MUST add the same MFA condition (closes Bedrock-logging Gap 9). `MaxSessionDuration: cdk.Duration.hours(1)` is required.

### 4.3 KMS resource scoping (closes SPEC-09:144 wildcard)

McpStack and any Lambda holding KMS permissions MUST pass four explicit ARNs (uploads, results, registry, aoss) via SSM and reference them in policy `Resource:` arrays. CDK aspect added: any `Resource: ['*']` on a `kms:*` action fails synth (this is stricter than §4.1, applies even when general wildcards would be permitted).

### 4.4 KMS rotation (closes Gap §C.9 from SPEC-30 audit)

All CMKs MUST set `enableKeyRotation: true`. Add scheduled Lambda `kms-rotation-monitor` (cron daily) emitting CloudWatch metric `KMSKeyAgeDays{keyArn}`. Alarm at >395d for any key (rotation should occur at ~365d).

### 4.5 Encryption-context binding & versioning

```ts
// packages/shared/src/encryption-context.ts
export interface EncryptionContextV1 {
  v: '1';
  userArn: string;
  resource: 'uploads' | 'results' | 'registry' | 'aoss';
  resourceId: string;   // e.g. jobId or skillVersionId
}
export function buildContext(...): EncryptionContextV1 { ... }
```

`v` field is mandatory and read at decrypt time. When a future version adds fields (e.g. `tenantId`), the decrypt path MUST attempt v1 first if `v=1` is stored. A new `EncryptionContextEnforcerAspect` walks every CDK construct that calls `kms.encrypt`/`s3.upload` and statically verifies the context is built via `buildContext` (regex pattern check on synthesised code).

### 4.6 Crypto module reconciliation

`packages/shared/src/crypto.ts` MUST require an `EncryptionContextV1` parameter (no defaulting). The version of `crypto.ts` in SPEC-06 §4 (which omits `userArn`) is **rescinded**.

---

## 5. CDK Stack Dependency Graph & Deploy Order

The graph reconciles SPEC-12 Fix 30, SPEC-13 Fix 4, and SPEC-23 Fix 6.

```
Tier 1: NetworkStack
Tier 2: SecurityStack            (depends: Network)
Tier 3: StorageStack             (depends: Security)         ── parallel with ──
        MessagingStack           (depends: Security)
Tier 4: SkillRegistryStack       (depends: Storage, Security)
        KnowledgeStoreStack      (depends: Storage, Security, Network)
Tier 5: LambdaStack              (depends: Storage, Messaging, Security, Network, SkillRegistry, KnowledgeStore)
Tier 6: EcsStack                 (depends: Storage, Security, Network)
Tier 7: McpStack                 (depends: Lambda, Storage, Security)
        CodeReviewStack          (depends: Lambda, Storage, Security, Network)
Tier 8: MonitoringStack          (depends: all)
        ComplianceStack          (depends: all)
```

`infra/bin/app.ts` MUST call `addDependency()` for every edge above. `buildTestApp()` MUST construct stacks in the same order (closes SPEC-13:814 mis-ordering). `cdk synth --strict` is the gate.

---

## 6. CLI Surface Reconciliation

### 6.1 Global flags (all commands)

`--profile <name>`, `--region <r>`, `--env <name>`, `--format <human|json|yaml>` (default human), `--quiet`, `--verbose`, `--no-color`. Closes SPEC-07/08/31 inconsistency.

### 6.2 Exit codes (universal)

```
0  success
1  user error (bad flags, validation, not-found)
2  auth/permission error (401/403)
3  remote 4xx (other)
4  remote 5xx / retry exhausted
5  timeout
6  system error (local I/O, dependency failure)
130 SIGINT
143 SIGTERM after cleanup
```

Every command MUST map its failure modes to these codes. QA-404 asserts each command's man-page lists its codes.

### 6.3 Output formats

`--format json` MUST emit the same field set as human output (no omissions) plus a `schemaVersion` integer and a top-level `kind` discriminator. JSON schemas committed under `packages/cli/schemas/`.

### 6.4 Upload-size policy (closes SPEC-31 vs SPEC-07 conflict)

Single value: **MCP encoded payload ≤ 7 MiB**, **direct upload ≤ 5 GiB via multipart**. The 5.25 MiB and 5 MiB legacy values are rescinded. CLI `validate` and `mcp submit` both enforce 7 MiB only when transport is MCP/HTTPS-JSON; raw S3 multipart uses 5 GiB.

### 6.5 Cache key & collision policy

Cache key = `sha256( skillVersionId || normalised_inputs_json || schema_version )`. Collisions are by definition impossible at SHA-256 strength; the runtime MUST nevertheless verify `inputs_json` byte-equality on cache hit before reuse and on mismatch invalidate the entry and emit metric `CacheCollisionDetected`. Cache TTL: 24 h. Eviction: LRU at 10 GiB. Closes SPEC-08 silence.

### 6.6 Credential storage

`packages/cli/src/credentials.ts` stores tokens in OS keychain (macOS `security`, Linux `secret-service`, Windows `wincred`). Plain file fallback `~/.skills-svc/credentials` is `chmod 600`. Logs MUST redact tokens via regex `(?i)(token|secret|password|authorization)["']?\s*[:=]\s*\S+`. Closes SPEC-31 B8 logging-safety extension.

### 6.7 Streaming timeouts

`--stream-timeout` (default 1800 s) applies to `upload`, `logs`, `watch`, `schedule history --follow`. SIGTERM during stream flushes buffered lines, exits 143.

---

## 7. MCP Server Closure

### 7.1 Error code map

```
-32700  parse error
-32600  invalid request
-32601  method not found
-32602  invalid params
-32603  internal error
-32000  auth failed (token invalid/expired)
-32001  auth denied (token valid, permission missing)
-32002  rate limited (retry-after header)
-32003  quota exceeded (no retry)
-32004  upstream timeout (Bedrock, AOSS)
-32005  upstream throttled
-32010  job not owned by caller
-32011  job not found
-32012  skill version not found / deprecated past sunset
-32020  schema-version unsupported
```

All MCP tools MUST return errors from this map exclusively. Closes SPEC-25/26/28/29 ambiguity.

### 7.2 Token lifecycle

- Issuance: server-side only, via `mcp token issue` CLI (admin-scoped). HS256 with key in Secrets Manager, rotated via the rotation Lambda in §12.4.
- Expiry: 8 h (matches SPEC-28). Clock skew tolerance ±60 s.
- Revocation: DDB `MCP_TOKEN#<jti>` with `revoked: true`; authorizer cache TTL **2 s** (was 30 s in SPEC-28 — reduced to keep revocation lag bounded). Closes Gap C.9.
- Logging: `jti` and `userArnHash` (SHA-256) are logged; raw token, raw userArn forbidden.

### 7.3 CORS

`allowOrigins: ['https://claude.ai']`. No wildcards. `allowCredentials: false`. Closes SPEC-09:192.

### 7.4 IAM condition operators

`ForAllValues:StringLike` is forbidden where the policy variable may be absent (it returns true on absence). Use `StringLike` for single-valued contexts. CDK lint rule added to `aspects/no-wildcard-iam.ts` to flag `ForAllValues:*` with empty-collection risk.

### 7.5 EventBridge rule for ECS completion

```ts
new events.Rule(this, 'EcsTaskCompletion', {
  eventPattern: {
    source: ['aws.ecs'],
    detailType: ['ECS Task State Change'],
    detail: {
      lastStatus: ['STOPPED'],
      clusterArn: [cluster.clusterArn],
      group: [{ prefix: 'family:skills-runner' }],   // ECS group, not startedBy
    },
  },
  targets: [new targets.LambdaFunction(resultsProcessor)],
});
```

`startedBy` is not used to match (SPEC-29 Fix 16 reduced it to a bare UUID which prefix-matching cannot key on). The handler MUST read `jobId` from `detail.overrides.containerOverrides[*].environment` (key `JOB_ID`). Closes SPEC-30 D-3 vs SPEC-32 B14 confusion.

### 7.6 mcp-auth Lambda VPC

`vpc: networkStack.vpc, vpcSubnets: { subnetType: PRIVATE_ISOLATED }` — required, no exceptions. SecurityGroup outbound 443 to KMS/SSM/DDB interface endpoints only.

### 7.7 Content-hash dedup

Dedup window: 24 h via DDB TTL on `DEDUP#<sha256>` item. Hash collisions across different zip contents are mathematically negligible; nevertheless, on hit the server MUST byte-equality-verify the new zip against the cached `s3ResultKey` HEAD `Content-Length` + first 4 KiB before reuse (closes SPEC-28 Fix 26 silence).

---

## 8. Code-Review Subsystem Closure (replaces missing SPEC-27)

### 8.1 Token estimation

For files >10 MiB, use `min(stat.size / 4, sample-based estimate)` where sample-based = `tokenize(first 64 KiB) * (stat.size / 64KiB)`. Binary files (non-UTF-8 decodable) are excluded from review with reason `BINARY_SKIPPED`. Closes SPEC-26 Gap 1.

### 8.2 Idempotency

`COMPLETE → PENDING` transition on force-push is allowed only if the new `headSha` differs AND the prior run's findings have been archived (move `FINDING#<commit>#*` items to `ARCHIVE#<commit>#*` with 90-day TTL). Closes SPEC-26 Gap 3.

### 8.3 SSH key lifecycle

`wipeSshKey()` MUST be invoked from a `finally` block AND registered with `process.on('SIGTERM'|'SIGINT'|'beforeExit')`. The `/tmp/.ssh/` directory is removed (`rm -rf`) after wipe. A Lambda-extension preStop hook (or `process.on('beforeExit')`) is the canonical place. Closes SPEC-26 Gap 5.

### 8.4 Suppression rule precedence

Precedence: `path-glob > rule-id > content-hash`. Ties broken by earliest `createdAt`. Transactional guarantee: writing a FindingRecord and applying the suppression list happen in one `TransactWriteItems`. Closes SPEC-26 Gap 7.

### 8.5 Sparse-checkout safety

Subpath MUST match `^[A-Za-z0-9_./-]+$` and resolve (after `path.resolve` against repo root) inside the repo. `..` and absolute paths fail with `INVALID_SUBPATH`. Subpath not present in tree fails with `SUBPATH_NOT_FOUND`. Monorepo cap: 5000 packages per review; above that, the run is rejected with `REPO_TOO_LARGE` and the caller is asked to use a subpath. Closes SPEC-26 Gap 12.

### 8.6 AOSS field weighting

`job_name^2`, `result_summary^3` are documented as *empirical defaults* and now driven by SSM `/skills-svc/{env}/aoss/weights` (JSON), so they are tunable without redeploy. If a document lacks `skill_names`, kNN proceeds without that bucket. `min_score: 0.2` applied before kNN re-ranking. Closes SPEC-28 Fix 12 silence.

### 8.7 Integration tests (this is what missing SPEC-27 should have been)

`tests/integration/code-review.spec.ts` MUST cover: end-to-end webhook→findings, chunk failure mid-stream (chunk 3 of 5 fails), checkpoint resume, MCP authorizer 30-s revocation, AOSS index missing `skill_names`, force-push during in-flight review, suppression-rule precedence ties, binary-file skip, monorepo cap. CI gate: green required for merge.

---

## 9. Skill Registry Lifecycle

### 9.1 Artifact integrity & signing

Every skill version stores `zipSha256` AND `manifestSignature` (SHA-256 of `manifest.json` signed by an `ecdsa-with-SHA256` key whose public part is in SSM `/skills-svc/{env}/registry/manifest-pubkey`). The validator Lambda verifies both on push; consumers (ingestion handler, ECS runner) re-verify on download. Mismatch → `SKILL_ARTIFACT_TAMPERED` (exit 6 / MCP -32603). Closes SPEC-10 §2 silence.

### 9.2 Deprecation lifecycle

```
ACTIVE → DEPRECATED → SUNSET → DELETED(metadata) | RETAINED(artifact under ObjectLock)
```

- `DEPRECATED` (operator action): writes `deprecatedAt`, `deprecationMsg`, `deprecatedByArn`. New runs allowed, emit `SkillDeprecatedUsed` metric + SNS notification.
- `SUNSET` (auto, default 90 d after `deprecatedAt`, overridable per skill): new runs rejected (-32012). Schedule runs continue to log warnings but DO NOT execute (closes SPEC-20 Fix 5 — sunset enforcement).
- `DELETED(metadata)`: 365 d after `SUNSET`, the `SkillVersion` row is `archive=true`; artifact remains under ObjectLock per compliance requirement.
- Notifications: SNS topic `skill-lifecycle-events` per env; dependents (jobs in last 30 d) get a notification on each transition.

Audit trail: every transition writes a `SKILL_AUDIT#<skill>#<version>#<txnId>` item with actor ARN, timestamp, prior/next state.

### 9.3 Version constraints

`SkillRef.version` accepts: exact (`1.2.3`), caret (`^1.2.0`), tilde (`~1.2.0`), `latest`, `latestStable`. Resolution happens at run-submission time and the resolved exact version is captured in `JobRecord.skillVersionId` (immutable for the life of the job). Yanked versions are skipped during resolution; sunset versions are skipped; deprecated-only matches fall back to error `SKILL_NO_NON_DEPRECATED_MATCH`.

### 9.4 Cross-registry conflict policy

If two registries publish the same `name`, fully-qualified names (`<registryId>/<name>`) are mandatory in `SkillRef`. The unqualified form is allowed only inside a single registry. Closes SPEC-10 §4 silence.

### 9.5 Skill author access control

Skills table adds `authorArn` and `authorOrgArn`. Push, deprecate, sunset are restricted to (a) the original `authorArn` or (b) members of `authorOrgArn` with role `SkillAdmin`. Branded type `SkillAuthorId` (extends SPEC-34a) added.

### 9.6 Artifact retention cost control

Sunset+1 year, `SkillVersion` row dropped from hot DDB; artifact remains in S3 Glacier Deep Archive (lifecycle rule). ObjectLock COMPLIANCE retains; storage tier reduces cost. Closes SPEC-10 unbounded storage.

---

## 10. Knowledge Store & Backfill Closure

### 10.1 Index bootstrap

`packages/lambda/src/bootstrap-index/handler.ts` runs as CDK Custom Resource. It creates a single non-hybrid kNN index (`results-{env}-v{N}`) with explicit mapping for `user_arn` (`keyword`), `s3_result_key` (`keyword`), `vector` (`knn_vector`, dim 1024 for Titan v2), `created_at` (`date`), `_expiry` (`date`), `skill_names` (`keyword[]`). **Titan v2 dim is 1024** — SPEC-31 B18 stated 1536; that figure is incorrect. Closes contradiction.

### 10.2 Searcher

Uses `bool.must` with `term: user_arn` (not `post_filter`, not `bool.should`) — per-user filter MUST gate kNN, not merely re-rank. The hybrid query is fully removed. Closes SPEC-30 Fix A + SPEC-24 Fix 2 ambiguity.

### 10.3 Backfill Lambda

```
Input:  { fromTimestamp, toTimestamp, batchSize=200 }
Trigger:  manual (CLI: `skills-svc admin backfill ...`)
Behaviour:
  - SQS-backed for retries; per-item idempotent on s3_result_key
  - Reads result, computes embedding, indexes with full v1 schema
  - Old documents missing user_arn → derived from jobId→JobRecord lookup; if not found, indexed with user_arn = "UNKNOWN" and emits SkippedAuditMetric
  - Emits progress to DDB BACKFILL_RUN#<runId> every 200 items
  - On Lambda timeout (14 min), enqueues continuation token; resumes
Failure recovery:
  - Per-item failures: SQS retry (3) then DLQ
  - Run-level abort: CLI `skills-svc admin backfill abort <runId>`
```

Closes SPEC-30 unfinished backfill + SPEC-33 §4 truncation.

### 10.4 Index versioning

Schema changes bump `N` in `results-{env}-v{N}`. Reader uses an alias `results-{env}` repointed atomically after backfill validation. Zero-downtime.

---

## 11. Observability

### 11.1 Tracing

X-Ray enabled on every Lambda (`tracing: lambda.Tracing.ACTIVE`). ECS task role gets `xray:PutTraceSegments`. Cross-service spans for: `mcp.tool.<name>`, `ingestion.handle`, `ecs.runner.run`, `results.process`, `query.handle`. Trace IDs propagated via `JOB_TRACE_ID` env var into ECS task overrides.

### 11.2 Metrics (CloudWatch custom namespace `SkillsSvc`)

Mandatory:
- `JobSubmitted{env,userArnHash}` (count)
- `JobCompleted{env,status}` (count)
- `JobLatencyMs{env}` (p50/p95/p99)
- `BedrockTokens{env,direction}` (sum)
- `BedrockThrottled{env}` (count)
- `MCPAuthDenied{env,reason}` (count)
- `KMSDecryptFailures{env}` (count) — alarm at >5/min
- `CacheHitRate{env}` (ratio)
- `SkillDeprecatedUsed{skill,version}` (count)
- `BackfillProgress{runId}` (gauge)
- `KMSKeyAgeDays{keyArn}` (gauge)

### 11.3 Structured logs

JSON only. Mandatory fields: `traceId`, `requestId`, `userArnHash`, `jobId?`, `latencyMs`, `level`, `msg`. Forbidden fields: raw `userArn`, raw tokens, raw prompts (use `promptHash`). CloudWatch Logs Insights saved queries committed under `infra/logs-insights/`.

### 11.4 Dashboards

One CDK construct per concern: `JobsDashboard`, `MCPDashboard`, `KnowledgeStoreDashboard`, `CostDashboard`, `SecurityDashboard`. MonitoringStack instantiates all five.

### 11.5 Alarms (page on-call)

- `KMSDecryptFailures > 5/min` (p1)
- `JobLatencyMs p95 > 5min for 10min` (p2)
- `MCPAuthDenied{reason=invalid_token} > 50/min` (p2 — credential stuffing)
- `BackfillProgress` stalled > 30 min (p3)
- `DLQ depth > 0 for 5min` (p2)
- Bedrock 5xx > 10/min (p2)

---

## 12. Operational Runbooks

(Each runbook lives at `runbooks/<name>.md`. SPEC-35 specifies the obligation; runbook content is filled by ops.)

### 12.1 Deploy runbook

Tier-ordered deploy per §5; pre-deploy `cdk synth --strict` MUST pass all aspects; post-deploy: smoke test `qa-run-all.sh --post-deploy`. Rollback: `cdk deploy --rollback-on-failure` (default) plus a documented `git revert` flow. Closes SPEC-12 Fix 30 / SPEC-13 Fix 4 fight.

### 12.2 Incident response

Severity tree (P1–P4) with concrete examples. PagerDuty integration via SNS→Lambda→PD events API (token in Secrets Manager, rotation §12.4). Slack channel `#skills-svc-oncall`. Incident classifications: full outage, partial degradation, security event (containment first), data integrity (preserve evidence). Rollback decision tree included.

### 12.3 Break-glass

Role assumable only with MFA (§4.2). Session ≤ 1 h. CloudTrail filter triggers immediate Slack page on any `AssumeRole` for the break-glass role. Per-session post-mortem mandatory within 24 h. The role is **read-only by default**; mutation requires a documented exception and dual approval.

### 12.4 Secrets rotation

Rotation Lambda `secrets-rotator` (daily cron) handles: MCP signing key, PagerDuty token, webhook signing secret. AWS Secrets Manager rotation schedule 30 d. Cache invalidation: callers re-fetch on 401/403 with one retry. Closes SPEC-06 §6 cache gap.

### 12.5 DR (disaster recovery)

- **RTO/RPO targets:** RTO 4 h, RPO 1 h (DDB PITR enabled).
- **DDB:** PITR + on-demand backups every 6 h, retained 35 d.
- **S3:** versioning + lifecycle to Glacier; uploads & results buckets have cross-region replication to a passive secondary region (Tier 13).
- **Code:** every Lambda function URL pinned to immutable alias; rollback is alias flip.
- DR drill: quarterly tabletop, annual real failover.

### 12.6 DSAR / GDPR (closes Gap C.6)

`skills-svc admin dsar <userArn> --action <export|delete>` CLI:
- Export: dump all DDB items (Jobs, FINDINGS, MCP_TOKEN, SKILL_AUDIT where actor=userArn) to a single encrypted S3 zip. AOSS results dumped via scroll API.
- Delete: tombstone (set `gdprDeleted=true`, scrub PII fields), remove from AOSS, schedule S3 results for deletion after legal-hold window (default 30 d, configurable per regulator). KMS data keys re-encrypted with new context so old ciphertext is unreadable. Audit row written.
- Authentication: requires dual-approval (two break-glass actors).

---

## 13. Multi-Region, Cost, Retention, GDPR/PII

### 13.1 Multi-region

Active-passive. Primary `us-east-1`, passive `us-west-2` (configurable). DDB **not** Global Tables (cost + write-conflict risk); instead passive region keeps a PITR-restored standby. S3 CRR for `uploads`, `results`, `registry`. KMS multi-region keys for those three. Failover playbook in `runbooks/dr-failover.md`.

### 13.2 Cost controls

- Per-Lambda `reservedConcurrentExecutions`: ingestion 200 (justified: peak observed 120 in load test), query 50, mcp 200, results-processor 100, dlq 10. Documented in `infra/cost-model.md`.
- DDB on-demand with per-table autoscaling guardrails: max 5000 WCU / 5000 RCU (alarm at 80%).
- S3 lifecycle: uploads → IA at 30 d → Glacier at 90 d → delete at 365 d. Results → IA 60 d → Glacier 180 d → delete 7 y (regulatory).
- Budget alarms: `$Monthly` threshold 80%/100%/120% of forecast via AWS Budgets.

### 13.3 Data retention

`ttl` field on JobRecord = `createdAt + 30 d` (operational data). Findings retained 7 y. SkillVersion never auto-deleted (artifact ObjectLock); metadata archived after 1 y past sunset (§9.6). CloudWatch Logs retention 90 d default, 7 y for `Audit*` log groups.

### 13.4 GDPR / PII

- No raw PII in logs (§11.3).
- Bedrock invocation logging: enabled with filter — `outputDataDeliveryEnabled: true, textDataDeliveryEnabled: false` if the model invocation contains PII flags from DLP. Default to text-disabled; enable text per-env via SSM `/skills-svc/{env}/bedrock/log-text-data` (boolean). Closes SPEC-06 §12 unfiltered-log gap.
- DLP `HIGH` findings (AWS credentials, private keys) **block** indexing (return error to caller). `MEDIUM` redacts. `LOW` annotates. Closes SPEC-06 §9 ambiguity.
- DSAR handler §12.6.

### 13.5 Schema migration tooling

`scripts/migrate.ts` driven by `schemaVersion` field on every record. Migration steps committed under `infra/migrations/<NNN>-description.ts`. Backfill Lambda (§10.3) wraps migrations as needed. Test: `npm run migrate:test` runs against an ephemeral DDB Local + LocalStack S3.

---

## 14. QA Test Runner Closure

`scripts/qa-run-all.sh` MUST cover:

- QA-001..QA-100 (SPEC-04/05 existing)
- QA-101..QA-114 (SPEC-06 §12 — close runner-omission gap)
- QA-189, QA-193 (SPEC-13/14 anti-manifest)
- QA-241..QA-285 (SPEC-22)
- QA-286..QA-385 (NEW — covers all SPEC-23 and SPEC-24 fixes; numbered lists in §14.1)
- QA-386..QA-400 (NEW — SPEC-30..34c cross-cutting)
- QA-401 (no `JobStatus.PENDING`)
- QA-402 (anti-manifest grep)
- QA-403 (no IAM wildcard)
- QA-404 (exit-code coverage)
- QA-405 (every SSM param in §3 actually written by exactly one stack)
- QA-406 (cdk synth --strict passes with all aspects)
- QA-407 (every record type carries `schemaVersion`)

### 14.1 SPEC-23 / SPEC-24 fix-to-QA mapping

For each fix in SPEC-23 and SPEC-24 there MUST be one QA-NNN entry asserting the invariant the fix establishes. Mapping table committed at `infra/test/qa-mapping.csv`. CI fails if the table is missing a row for any fix listed in SPEC-23 / SPEC-24.

---

## 15. Anti-Patterns & Reversal Tax

These artefacts from prior specs MUST NOT be created, or if created, MUST be deleted:

1. `packages/lambda/src/mcp-authorizer/` (SPEC-13 Fix 12 — reversed by SPEC-14, restated here).
2. Any `/mcp/desktop` API route or API-key Secret in McpStack.
3. SPEC-09 `HttpIamAuthorizer` wiring.
4. SPEC-06 §4 `crypto.ts` without `userArn` in context.
5. SPEC-03 `JobStatus.PENDING` references.
6. SPEC-24 Fix 1 SSM path `bedrock/api-key`.
7. SPEC-15 Fix 10 cache-key approach (full-zip download); replaced by S3 ChecksumSHA256.
8. SPEC-31 B18 1536-dim Titan v2 (correct value: 1024).
9. SPEC-19 Fix 1 esbuild-bundled Lambda option (use the simpler `fromAsset` with exclusions).

Implementers who follow SPEC-01..34c in order MUST consult this list before merging each tier; CI step `scripts/reversal-tax-check.sh` greps for forbidden patterns and fails the build.

---

## 16. Open Questions Still Deferred

These items are *intentionally* not specified here and have explicit owners + dates. Each lives as a tracked issue.

| # | Topic | Owner | Decision by |
|---|---|---|---|
| 1 | Bedrock cross-region inference profile vs static region | Platform | 2026-06-01 |
| 2 | OpenSearch Serverless vs managed for scale-out beyond 1B vectors | Platform | 2026-07-01 |
| 3 | FedRAMP boundary scoping | Compliance | 2026-09-01 |
| 4 | Customer-managed encryption keys (BYOK) | Security | 2026-10-01 |
| 5 | Self-service skill registry public-beta gate | Product | 2026-08-01 |

Anything not listed here that is not specified by SPEC-01..34c after applying SPEC-35 is a defect — file as a bug, do not invent.

---

## Appendix A: One-page invariant checklist (for code review)

- [ ] `userArn` flows into every persisted record and every KMS context.
- [ ] No `JobStatus.PENDING`. Use `QUEUED`.
- [ ] No `Resource: '*'`. No `Action: '*'`. No `ForAllValues:*` with absence risk.
- [ ] No `/mcp/desktop`, no `mcp-authorizer/`.
- [ ] Every SSM read fails fast on miss with `SSM_PARAM_MISSING`.
- [ ] Every record has `schemaVersion`.
- [ ] `cdk synth --strict` passes; aspects in §4 enforce.
- [ ] Exit codes match §6.2.
- [ ] MCP errors match §7.1.
- [ ] Deprecated skills emit metric+SNS; sunset blocks new runs.
- [ ] Encryption context built only via `buildContext()`.
- [ ] X-Ray active, structured JSON logs, no raw userArn in logs.

---

## Appendix B: Spec dependency graph (textual)

```
SPEC-01 (architecture)          ── SPEC-35 §0 supersession matrix
SPEC-02 (lambda/ecs)            ── §2 file manifest is the new canonical list
SPEC-03 (knowledge store/CLI)   ── §1 schemas + §6 CLI surface
SPEC-04/05 (QA layers)          ── §14 runner + QA-401..407
SPEC-06 (security)              ── §4 IAM/KMS + §13.4 GDPR
SPEC-07/08 (CLI features)       ── §6 surface reconciliation
SPEC-09 (MCP)                   ── §7 closure (fully superseded by SPEC-29 + §7 here)
SPEC-10 (skill registry)        ── §9 lifecycle
SPEC-11..14 (consolidation)     ── §15 anti-patterns
SPEC-15..19 (audit fixes)       ── §3 SSM registry + §6.5 cache + §14 QA
SPEC-20..24 (e2e rounds)        ── §1.2 JobRecord + §14.1 fix-to-QA
SPEC-25/26 (code review)        ── §8 closure (replaces missing SPEC-27)
SPEC-28/29 (MCP rewrite)        ── §7 closure
SPEC-30 (cross-cutting)         ── §10 knowledge store + §4 encryption context
SPEC-31 (MCP round 2 + CLI)     ── §7 + §6 + §10.1 Titan-dim correction
SPEC-32 (MCP fixes)             ── §7.5 EventBridge authoritative
SPEC-33 (gap audit)             ── §10.3 backfill completed here
SPEC-34a/b/c (invariants)       ── §4.1 aspect extensions + §1.6 schemaVersion + §11 observability invariants
```

**End of SPEC-35.**
