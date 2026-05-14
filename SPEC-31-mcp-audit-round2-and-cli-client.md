# SPEC-31 — MCP Audit Round 2 + CLI MCP Client

**Context:** 6-agent parallel audit of all MCP user story flows post-SPEC-29/30,
plus the new `skills-svc mcp` CLI client command written to disk.

**New file written to disk:** `packages/cli/src/commands/mcp-client.ts` (~430 lines).

**Register in `packages/cli/src/index.ts`:**
```typescript
import { registerMcpClientCommands } from './commands/mcp-client';
registerMcpClientCommands(program);
```

---

## Part A — CLI MCP Client (`skills-svc mcp`)

The CLI now has a native MCP client so developers can test, debug, and script the MCP
server without a full Claude Code session. See `packages/cli/src/commands/mcp-client.ts`
(written to disk by agent).

```bash
# Setup — run once after deploy
skills-svc mcp-config --install

# List available tools
skills-svc mcp tools

# Call any tool directly (escape hatch)
skills-svc mcp call submit_job --args '{"zip_base64":"...","job_name":"test"}'

# Convenience wrappers
skills-svc mcp submit ./my-skills.zip --job-name "q3-analysis"
skills-svc mcp status <job-id>
skills-svc mcp result <job-id> [--summary-only]
skills-svc mcp query "summarize Q3 financial reports" --top-k 5
skills-svc mcp ping                  # measures latency
skills-svc mcp resources             # lists available MCP resources
```

**What `mcp-client.ts` implements:**
- `loadMcpConfig()` — reads `~/.claude/mcp.json` or `~/.skills-svc/mcp.json`, extracts endpoint + `X-API-Key` token
- `mcpCall(cfg, method, params?)` — JSON-RPC 2.0 POST with `X-API-Key`, handles 401/403/429/204
- `printMcpContent(content, format)` — pretty-prints `type:'text'` and `type:'resource'` blocks
- `mcp submit` — validates ZIP magic bytes, enforces 7MB encoded limit, extracts `jobId` from resource block
- `mcp ping` — multi-ping showing avg/min/max latency
- `--format json` flag on all commands for machine-readable output

---

## Part B — Audit Gaps Found (50 issues across 5 flows)

### Critical Blockers That Break Every Deployment

**B1 — `KMSCrypto` IAM uses `Resource: '*'` → `NoWildcardIAMAspect` fails `cdk synth`**

`SPEC-29 Section 1` MCPStack has:
```typescript
mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KMSCrypto',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: ['*'],   // comment says "tighten later" — but aspect fails immediately
}));
```
`WILDCARD_EXCEPTION_SIDS` only contains `XRayWrite`. Every `cdk synth --strict` fails. No stack can be deployed.

**Fix in `infra/lib/mcp-stack.ts`:**
```typescript
// Add to MCPStackProps:
interface MCPStackProps extends cdk.StackProps {
  uploadsKmsKey:  kms.Key;
  resultsKmsKey:  kms.Key;
  dynamodbKmsKey: kms.Key;
  lambdaEnvKey:   kms.Key;
  // ...existing props
}

mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:     'KMSCrypto',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [
    props.uploadsKmsKey.keyArn,
    props.resultsKmsKey.keyArn,
    props.dynamodbKmsKey.keyArn,
    props.lambdaEnvKey.keyArn,
  ],
}));
```

**B2 — EventBridge rule still filters `startedBy: prefix: 'skills-svc-ingestion-'`; SPEC-29 Fix 16 made `startedBy = jobId` (bare UUID) → ResultsProcessorLambda never fires**

`infra/lib/lambda-stack.ts` EventBridge rule pattern:
```typescript
detail: {
  lastStatus: ['STOPPED'],
  startedBy: [{ prefix: 'skills-svc-ingestion-' }],  // DEAD after Fix 16
},
```
After Fix 16, `startedBy` is a bare 36-char UUID. Nothing matches the prefix. Every job is permanently stuck in RUNNING.

**Fix:**
```typescript
detail: {
  lastStatus: ['STOPPED'],
  clusterArn: [props.ecsClusterArn],  // scope to our cluster; parse jobId in Lambda
  // Remove startedBy filter — handler validates with isValidUUID()
},
```

**B3 — `mcp-auth` Lambda missing VPC config; DDB calls exit over public internet**

`SPEC-29 Section 1` deploys `tokenAuthFn` with no `vpc:` prop. The VPC uses `PRIVATE_ISOLATED` with no NAT. Auth Lambda DDB calls either fail or bypass the security posture.

**Fix:** Add to `tokenAuthFn` definition:
```typescript
vpc:            props.vpc,
vpcSubnets:     { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
securityGroups: [props.lambdaSg],
```

---

### Auth + Session Lifecycle Fixes

**B4 — Session ARN stored in MCPTOKEN# record; rotates on every `assume-role`; `list_jobs` returns zero after session rotation**

`mcp-config.ts` stores `identity.Arn` (e.g. `arn:aws:sts::123:assumed-role/UserRole/alice-session-1`). After re-assuming, the session name changes. `list_jobs` queries `GSI2PK = USER#<new-session-arn>` — no job records match.

**Fix — normalize to stable role ARN before storing:**
```typescript
function normaliseArn(arn: string): string {
  const m = arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.+$/);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn;
}
const stableArn = normaliseArn(identity.Arn!);
// store stableArn in MCPTOKEN# and use in mcp.json callerUserArn
```
Apply same normalization in ingestion Lambda when writing `userArn` from S3 metadata.

**B5 — `ForAllValues:StringLike` on `WriteMCPTokens` IAM condition evaluates `true` when key is absent → unrestricted DDB writes**

```typescript
// WRONG:
conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['MCPTOKEN#*'] } }

// CORRECT (single-item operations use StringLike, not ForAllValues):
conditions: { 'StringLike': { 'dynamodb:LeadingKeys': ['MCPTOKEN#*'] } }
```
Also move `DeleteItem` from `userRole` to `mcpLambdaRole` (token revocation should be server-side only).

**B6 — mcp-auth DDB throttle returns 403 (not retryable) instead of 500; WAF not alerted**

```typescript
// In mcp-auth/handler.ts catch block:
const retryableErrors = ['ThrottlingException','ProvisionedThroughputExceededException','ServiceUnavailable'];
if (retryableErrors.includes((err as any).name)) {
  throw err;  // API GW returns 500 → client retries; was 403 → client gives up
}
return DENY;
```

**B7 — Token never deleted when `mcp-config` re-runs; old token valid up to 48h**

```typescript
// In mcp-config.ts, before writing new token — read and delete old:
if (existsSync(mcpFile)) {
  const oldToken = JSON.parse(readFileSync(mcpFile)).mcpServers?.['skills-as-a-service']
    ?.transport?.headers?.['X-API-Key'];
  if (oldToken && oldToken !== token) {
    await ddb.send(new DeleteCommand({
      TableName: dynamodbTableName,
      Key: { PK: `MCPTOKEN#${oldToken}`, SK: 'META' },
    })).catch(() => {});  // best-effort
  }
}
```

**B8 — Token is in scope during error logging; X-Ray can capture raw event containing `X-API-Key`**

```typescript
// Hash the token for all log references:
const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16);
console.error(JSON.stringify({ event: 'token_lookup_error', tokenHash, err: String(err) }));
// Never: console.error(JSON.stringify({ event: '...', token, ... }))
```

**B9 — Multi-profile shared table: token has no `envName`; staging token valid against prod authorizer**

```typescript
// In mcp-config.ts PutCommand Item, add:
envName: cfg.envName,

// In mcp-auth/handler.ts, validate:
const expectedEnv = process.env.ENV;
if (item.envName && item.envName !== expectedEnv) return DENY;
```

---

### submit_job + Ingestion Pipeline Fixes

**B10 — GSI4-CacheKey not defined on DDB jobs table; submit_job dedup always throws ResourceNotFoundException**

```typescript
// infra/lib/storage-stack.ts — add after GSI2:
this.jobsTable.addGlobalSecondaryIndex({
  indexName:    'GSI4-CacheKey',
  partitionKey: { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'jobName', 'status'],
});
```

**B11 — SPEC-30 Fix E ingestion handler never writes `GSI4PK`; dedup index permanently empty**

```typescript
// In processUpload, add to PutCommand Item:
const contentHash = meta['content-hash'];
...(contentHash ? { GSI4PK: `CONTENTHASH#${contentHash}` } : {}),
```

**B12 — SPEC-30 Fix E ingestion handler never calls `validateZipStructure`; bomb/corrupt zips reach ECS**

```typescript
// In processUpload, after HeadObjectCommand, before DDB write:
const zipBuffer = await downloadFirst10MB(s3, bucket, key);
const validation = validateZipStructure(zipBuffer, { compressedSize: head.ContentLength ?? 0, ... });
if (!validation.valid) {
  // Write FAILED job record (no throw — S3 events shouldn't retry on permanent bad input)
  await writeFailedJobRecord(ddb, jobId, userArn, `Zip validation failed: ${validation.error}`);
  return;
}
```

**B13 — SPEC-30 Fix E never checks `RunTaskCommand.failures[]`; ECS capacity failures leave jobs stuck RUNNING**

```typescript
const runTaskRes = await ecs.send(new RunTaskCommand({ ... }));
if (runTaskRes.failures?.length) {
  throw new Error(`ECS RunTask failures: ${runTaskRes.failures.map(f => f.reason).join('; ')}`);
}
```

**B14 — SPEC-30 Fix D-3 changed ResultsProcessorLambda to S3Event handler; CDK still wires EventBridge → Lambda never invoked**

Choose one trigger and update CDK to match. EventBridge (existing CDK wiring) is preferred — revert Fix D-3 handler signature to `EventBridgeHandler` and read `startedBy` (bare jobId per B2 fix) to get `jobId`, then DDB lookup for `userArn`.

**B15 — `submit_job` encoded size guard: `MAX_ENCODED_BYTES = 7MB` limits effective zip to 5.25MB, not advertised 7.5MB**

```typescript
const MAX_ENCODED_BYTES = 10 * 1024 * 1024;  // API GW hard limit; describe 7.5MB in error msg
```

**B16 — `diff` command calls `envelopeDecrypt` without `userArn`; throws after SPEC-30 Fix D deployed**

```typescript
// In packages/cli/src/commands/diff.ts fetchResult():
const plain = await envelopeDecrypt(raw, {
  jobId,
  userArn: job.userArn as string,   // ADD
  purpose: 'skills-svc-result',
  environment: cfg.envName,
});
```

---

### query_knowledge_store Fixes

**B17 — kNN `post_filter` returns 0 results in multi-tenant corpus; need filter inside `knn` clause**

```typescript
// In searcher.ts, replace knn clause:
{
  knn: {
    result_embedding: {
      vector: embedding,
      k: topK * 10,           // larger k to survive post_filter
      filter: { term: { user_arn: callerUserArn } },  // AOSS knn filter inside clause
    },
  },
},
```

**B18 — SPEC-30 indexer + searcher omit `dimensions: 1536`; Titan v2 returns 1024-dim; AOSS rejects all writes**

```typescript
// In both indexer.ts and searcher.ts embed functions:
body: Buffer.from(JSON.stringify({
  inputText: text,
  dimensions: 1536,   // must match index mapping "dimension": 1536
  normalize: true,
})),
```

**B19 — Backfill for historical documents (no `user_arn`) not implemented; all pre-SPEC-30 queries return 0**

Must write and run a backfill Lambda (reads all COMPLETE jobs from DDB, re-downloads + re-decrypts + re-indexes with `user_arn`) before SPEC-30 goes live for existing customers. See audit agent 3 for complete implementation.

**B20 — MCP `query.ts` still uses `lambda:Invoke`; `callerUserArn` is self-reported → spoofable by any IAM principal with InvokeFunction**

Either disable direct-invoke mode in query Lambda (`handleDirect` should throw), or update MCP `query.ts` to call the API Gateway HTTPS endpoint with SigV4 signing.

**B21 — Duplicate `QueryRequest`/`QueryResponse` type definitions in SPEC-29 §13 and SPEC-30 Fix A; merge conflict**

Keep only SPEC-30 version (includes `from`, `total`, `hasMore`). Delete SPEC-29 version from `packages/shared/src/types.ts`.

**B22 — `@skills-svc/knowledge-store/searcher` sub-path import fails on Node 18+ without `exports` map**

```json
// packages/knowledge-store/package.json:
"exports": {
  ".":          "./dist/index.js",
  "./searcher": "./dist/searcher.js",
  "./indexer":  "./dist/indexer.js"
}
```

---

### list_jobs + cancel_job Fixes

**B23 — `list_jobs` DDB `Limit` applied before `FilterExpression` for `since`/`until`/`job_name_contains`; returns fewer results than requested**

Use `ExclusiveStartKey` cursor pagination, looping until `limit` post-filter results are collected:
```typescript
while (items.length < limit) {
  const res = await ddb.send(new QueryCommand({
    ...queryParams,
    Limit: Math.min(100, limit * 2),   // no hard Limit when filtering in memory
    ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
  }));
  const filtered = jobNameContains
    ? (res.Items ?? []).filter(i => (i.jobName as string)?.toLowerCase().includes(jobNameContains))
    : (res.Items ?? []);
  items.push(...filtered);
  lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  if (!lastKey) break;
}
```

**B24 — `cancel_job` PENDING race: SQS message never deleted; ingestion Lambda launches ECS after FAILED is set**

Store `sqsReceiptHandle` in DDB job record at ingestion time. In `cancel_job` for PENDING:
```typescript
await sqsClient.send(new DeleteMessageCommand({
  QueueUrl: jobRes.Item.sqsQueueUrl as string,
  ReceiptHandle: jobRes.Item.sqsReceiptHandle as string,
}));
```
Ingestion Lambda must also check DDB status before launching ECS and abort if FAILED/CANCELLED.

**B25 — Cancelled jobs marked `FAILED`; retry tooling cannot distinguish cancellation from real failures**

Add `CANCELLED` to `JobStatus` enum. Update `cancel_job`, `job_status`, `list_jobs` input schema enum, and `isValidTransition`.

**B26 — GSI2SK inconsistency: SPEC-02 writes `CREATED_AT#{date}`, SPEC-30 Fix E writes bare ISO; `since`/`until` sort order breaks for mixed records**

Standardize on bare ISO string for GSI2SK across all writers. Define in shared constants:
```typescript
export const formatGSI2SK = (iso: string): string => iso;  // bare ISO, no prefix
```

**B27 — `DDB_KEY_PREFIX.USER` constant never defined in spec; silent zero-result if mismatched across files**

```typescript
// packages/shared/src/constants.ts — define explicitly:
export const DDB_KEY_PREFIX = {
  JOB:    'JOB#',
  STATUS: 'STATUS#',
  USER:   'USER#',
} as const;
```
Add unit tests verifying each prefix value.

---

### Protocol Compliance Fixes

**B28 — `params` array not rejected for `tools/call`; MCP spec §5.5 requires object**

```typescript
case 'tools/call': {
  if (Array.isArray(req.params)) {
    return this.error(req.id, -32602, 'tools/call params must be an object, not an array');
  }
```

**B29 — Unknown tool name returns `-32602` (Invalid params) instead of `-32601` (Method not found)**

```typescript
if (!tool) return this.error(req.id, -32601, `Unknown tool: ${name}`);
//                                    ^^^^^^ was -32602
```

**B30 — `inputSchema` missing `additionalProperties: false`; unknown fields pass validation silently**

```typescript
// In MCPToolInputSchema type:
additionalProperties: false;

// In validateArgs, enforce it:
if (schema.additionalProperties === false) {
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(argsObj)) {
    if (!allowed.has(key)) return `Unknown argument: ${key}`;
  }
}
```

**B31 — SSE-KMS presigned S3 URLs unusable by MCP token-auth clients (no `kms:Decrypt` for downloader)**

Presigned S3 GET URLs for SSE-KMS objects require the downloader to have `kms:Decrypt`. Token-auth MCP clients have no AWS credentials. Remove presigned URL path; throw a CLI-redirect error instead:
```typescript
if (rawBytes.length > INLINE_LIMIT) {
  throw new Error(
    `Result is ${(rawBytes.length/1024/1024).toFixed(1)}MB — too large for MCP inline. ` +
    `Use: skills-svc results ${jobId}`
  );
}
```

**B32 — `list_jobs` `job_name_contains` pagination: Limit-before-filter causes silent truncation (same root as B23)**

Already fixed by B23's cursor-pagination approach.

**B33 — `cancel_job` RUNNING path: no guard on `ECS_CLUSTER_ARN` before ECS call; crashes with unsanitized SDK error**

```typescript
const clusterArn = process.env.ECS_CLUSTER_ARN;
if (!clusterArn) throw new Error('ECS_CLUSTER_ARN not configured — cannot stop running task');
```
Add `'ECS_CLUSTER_ARN not configured'` to `SAFE_ERROR_PREFIXES`.

**B34 — `sanitizeErrorMessage` doesn't match `"is not authorized"` (AWS SDK KMS error); KMS context mismatches swallowed**

```typescript
const SAFE_ERROR_PREFIXES = [
  // ... existing ...
  'not authorized',       // ADD — covers AWS SDK auth errors
  'ECS_CLUSTER_ARN not', // ADD
];
```

**B35 — `initialize` response missing `prompts: {}` and `logging: {}`; Claude Code sends `prompts/list` speculatively**

```typescript
case 'initialize':
  return this.respond(req.id, {
    protocolVersion: '2024-11-05',
    serverInfo: { name: this.name, version: this.version },
    capabilities: {
      tools:     { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts:   {},   // ADD
      logging:   {},   // ADD
    },
  });
```

**B36 — `get_result` S3 stream has no timeout; stalled download causes Lambda 29s timeout → API GW 504 with no JSON body**

```typescript
const STREAM_TIMEOUT_MS = 20_000;
await Promise.race([
  (async () => { for await (const c of obj.Body as AsyncIterable<Uint8Array>) chunks.push(c); })(),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('S3 stream timeout')), STREAM_TIMEOUT_MS)),
]);
```

**B37 — CORS `allowOrigins: ['https://claude.ai', '*']` wildcard enables CSRF attacks on bearer-token API**

```typescript
corsPreflight: {
  allowOrigins: ['https://claude.ai'],   // remove '*'
  ...
}
```

**B38 — `cancel_job` success response missing `type: 'resource'` block; agents using resource pattern get no structured confirmation**

Add resource block alongside text on both success and ConditionalCheck race paths (see pattern from Fix 8/14).

---

## Summary Table

| Fix | Area | Severity |
|-----|------|----------|
| B1  | CDK — KMS wildcard blocks cdk synth | CRITICAL |
| B2  | EventBridge rule dead filter — no jobs ever complete | CRITICAL |
| B3  | mcp-auth Lambda missing VPC | BLOCKING |
| B4  | Session ARN instability — list_jobs returns zero after re-auth | BLOCKING |
| B5  | ForAllValues IAM condition — unrestricted DDB writes | BLOCKING |
| B6  | DDB throttle returns 403 not 500 — auth fails non-retryably | BLOCKING |
| B7  | Old token not revoked on mcp-config re-run | BLOCKING |
| B8  | Token logged in error path / X-Ray capture risk | BLOCKING |
| B9  | No envName in token — staging token valid against prod | BLOCKING |
| B10 | GSI4-CacheKey not defined in CDK — submit_job dedup throws | BLOCKING |
| B11 | Ingestion never writes GSI4PK — dedup permanently broken | BLOCKING |
| B12 | No validateZipStructure in ingestion — bomb/corrupt zips reach ECS | BLOCKING |
| B13 | RunTask failures[] not checked — jobs silently stuck RUNNING | BLOCKING |
| B14 | ResultsProcessor trigger mismatch (EventBridge vs S3) — never invoked | CRITICAL |
| B15 | Encoded size guard limits zip to 5.25MB not advertised 7.5MB | CORRECTNESS |
| B16 | diff command missing userArn in envelopeDecrypt — throws post-SPEC-30 | BLOCKING |
| B17 | kNN post_filter returns 0 in multi-tenant corpus | BLOCKING |
| B18 | Embedding calls omit dimensions:1536 — AOSS rejects all writes | CRITICAL |
| B19 | No backfill Lambda — historical queries return 0 | BLOCKING |
| B20 | callerUserArn self-reported in lambda:Invoke — spoofable | BLOCKING |
| B21 | Duplicate QueryRequest types — merge conflict | BLOCKING |
| B22 | Sub-path import fails Node 18+ without exports map | BLOCKING |
| B23 | list_jobs Limit-before-filter silently truncates results | BLOCKING |
| B24 | cancel_job PENDING race — SQS not deleted, ECS launches anyway | BLOCKING |
| B25 | CANCELLED status missing — cancelled indistinguishable from failed | BLOCKING |
| B26 | GSI2SK prefix inconsistency — date sort broken for mixed records | BLOCKING |
| B27 | DDB_KEY_PREFIX.USER undefined — silent zero-result queries | CRITICAL |
| B28 | params array not rejected for tools/call | CORRECTNESS |
| B29 | Unknown tool returns -32602 not -32601 | CORRECTNESS |
| B30 | additionalProperties not enforced in schemas | CORRECTNESS |
| B31 | SSE-KMS presigned URLs unusable by token-auth clients | BLOCKING |
| B32 | Duplicate of B23 | (see B23) |
| B33 | ECS_CLUSTER_ARN missing guard | CORRECTNESS |
| B34 | sanitizeErrorMessage misses "not authorized" pattern | CORRECTNESS |
| B35 | initialize missing prompts/logging capabilities | CORRECTNESS |
| B36 | S3 stream timeout missing — Lambda 504 with no JSON | BLOCKING |
| B37 | CORS wildcard enables CSRF | BLOCKING |
| B38 | cancel_job missing resource block on success | CORRECTNESS |
