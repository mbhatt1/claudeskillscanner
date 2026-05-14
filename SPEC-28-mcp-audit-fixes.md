# SPEC-28 — MCP Codepath Audit: 70 Issues Found, 28 Worthy Fixes

**Supersedes:** SPEC-09 and SPEC-24 on all MCP overlapping topics.  
**Scope:** 6-agent parallel audit across all MCP user story flows.  
**Agents covered:** client setup/auth, submit_job, job_status+get_result,
query_knowledge_store, list_jobs+cancel_job, error handling/protocol compliance.

---

## Fix 1 — MCP Lambda Missing Critical Env Vars (Every Tool Except submit_job Throws)

**Root cause:** `MCPStack` Lambda environment only has `ENV`, `REGION`, `MCP_SERVER_NAME`,
`MCP_SERVER_VERSION`. Tools read `process.env.DYNAMODB_TABLE_NAME!`, `process.env.RESULTS_BUCKET!`,
and `process.env.QUERY_LAMBDA_ARN` — all `undefined` at runtime.

**Fix in `infra/lib/mcp-stack.ts`:**
```typescript
environment: {
  NODE_OPTIONS:        '--enable-source-maps',
  ENV:                 envName,
  REGION:              this.region,
  MCP_SERVER_NAME:     'skills-as-a-service',
  MCP_SERVER_VERSION:  '1.0.0',
  DYNAMODB_TABLE_NAME: props.dynamodbTableName,   // ADD
  RESULTS_BUCKET:      props.resultsBucket,        // ADD
  QUERY_LAMBDA_ARN:    props.queryLambdaArn,       // ADD
  UPLOADS_BUCKET:      props.uploadsBucket,        // ADD
  UPLOADS_KMS_KEY_ID:  props.uploadsKmsKeyId,      // ADD — avoids SSM call per submit_job
},
```

---

## Fix 2 — MCP IAM SigV4 Auth Broken: `env` Field Ignored by HTTP Transport (Every Call Returns 403)

**Root cause (SPEC-24 Fix 15, never applied to CDK):** The `env` field in `mcp.json` is a
`stdio`-transport concept. For `type: "http"` transport it is silently ignored. Requests arrive
at API Gateway with no `Authorization` header; `HttpIamAuthorizer` returns 403 on every call.

**Fix — wire the SPEC-24 Fix 15 Lambda authorizer in `infra/lib/mcp-stack.ts`:**
```typescript
// 1. Deploy mcp-auth Lambda (packages/lambda/src/mcp-auth/handler.ts — SPEC-24 Fix 15)
const tokenAuthFn = new lambda.Function(this, 'MCPTokenAuthFn', {
  functionName: `skills-svc-mcp-auth-${envName}`,
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset('../packages/lambda/dist'),
  handler: 'mcp-auth/handler.handler',
  timeout: cdk.Duration.seconds(5),
  memorySize: 128,
  role: mcpLambdaRole,
  environment: { JOBS_TABLE_NAME: props.dynamodbTableName, ENV: envName },
});

// 2. Replace HttpIamAuthorizer with Lambda authorizer
const tokenAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer(
  'TokenAuthorizer', tokenAuthFn, {
    authorizerName:  'skills-svc-token-authorizer',
    identitySource:  ['$request.header.X-API-Key'],
    resultsCacheTtl: cdk.Duration.seconds(30),   // short TTL so revocations take effect quickly
  }
);

const api = new apigatewayv2.HttpApi(this, 'MCPAPI', {
  defaultAuthorizer: tokenAuthorizer,   // replaces HttpIamAuthorizer
  corsPreflight: {
    allowOrigins: ['https://claude.ai', '*'],
    allowMethods: [
      apigatewayv2.CorsHttpMethod.POST,
      apigatewayv2.CorsHttpMethod.OPTIONS,   // required for CORS preflight
    ],
    allowHeaders: [
      'Content-Type', 'X-API-Key', 'X-Amz-Date', 'X-Amz-Security-Token',
    ],
    maxAge: cdk.Duration.hours(1),
  },
});
```

---

## Fix 3 — `mcp-config` Writes AWS Credentials Plaintext to mcp.json (Security Risk + Ignored)

**Root cause:** `mcp-config` embeds `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
in `mcp.json` under `env`. The credentials are both a secret storage risk and completely ignored
by HTTP transport. The correct flow per SPEC-24 Fix 15: generate an opaque token, store it in DDB,
write only `headers: { "X-API-Key": token }` to `mcp.json`.

**Fix in `packages/cli/src/commands/mcp-config.ts`:**
```typescript
// Generate short-lived token
const token     = randomBytes(32).toString('hex');
const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
const ttlSecs   = Math.floor(Date.now() / 1000) + 8 * 60 * 60;  // FIX: was `...` placeholder

// Ensure cfg.dynamodbTableName is available (may need SSM lookup if configure not run yet)
if (!cfg.dynamodbTableName) {
  cfg.dynamodbTableName = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${cfg.envName}/dynamodb/table-name`,
  })).then(r => r.Parameter!.Value!);
}

await ddb.send(new PutCommand({
  TableName: cfg.dynamodbTableName,
  Item: {
    PK:        `MCPTOKEN#${token}`,
    SK:        'META',
    userArn:   identity.Arn!,
    expiresAt,
    ttl:       ttlSecs,          // FIX: was `...` — DDB TTL must be integer epoch seconds
  },
}));

// Write mcp.json with token header — NO AWS credentials
const mcpConfig = {
  mcpServers: {
    'skills-as-a-service': {
      transport: {
        type: 'http',
        url:  mcpEndpoint,
        headers: { 'X-API-Key': token },   // supported by HTTP MCP transport
      },
      // No env field — env is stdio-only and ignored for HTTP transport
    },
  },
};
```

Add `dynamodb:PutItem` on `MCPTOKEN#*` prefix to `userRole`:
```typescript
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'WriteMCPTokens',
  actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
  resources: [jobsTableArn],
  conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['MCPTOKEN#*'] } },
}));
```

---

## Fix 4 — `mcp/handler.ts` Reads `iam.userArn` But Lambda Authorizer Puts Identity in `lambda.callerUserArn`

**Root cause:** After Fix 2 switches from `HttpIamAuthorizer` to `HttpLambdaAuthorizer`, the
caller identity moves from `event.requestContext.authorizer.iam.userArn` to
`event.requestContext.authorizer.lambda.callerUserArn`. The handler fallback to `'unknown'`
silently breaks all ownership checks.

**Fix in `packages/lambda/src/mcp/handler.ts`:**
```typescript
const callerArn =
  event.requestContext?.authorizer?.iam?.userArn ??           // IAM auth (legacy)
  (event.requestContext?.authorizer?.lambda as any)?.callerUserArn;  // Lambda auth (Fix 2)

if (!callerArn) {
  return {
    statusCode: 401,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized — valid X-API-Key required' },
      id: null,
    }),
  };
}
```

---

## Fix 5 — WAF Blocks submit_job Bodies >8KB and Headless MCP Clients with No User-Agent

**Root cause:** `AWSManagedRulesCommonRuleSet` includes `SizeRestrictions_BODY` (blocks >8KB)
and `NoUserAgent_HEADER` (blocks requests with no User-Agent). `submit_job` sends base64-encoded
zip bodies up to 13MB. Programmatic MCP agents may omit User-Agent.

**Fix in `infra/lib/mcp-stack.ts` WAF config:**
```typescript
{
  name: 'AWSManagedRulesCommonRuleSet',
  priority: 2,
  overrideAction: { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name: 'AWSManagedRulesCommonRuleSet',
      excludedRules: [
        { name: 'NoUserAgent_HEADER' },      // MCP HTTP clients may not send User-Agent
        { name: 'SizeRestrictions_BODY' },   // submit_job sends up to 13MB base64 body
      ],
    },
  },
  visibilityConfig: { /* unchanged */ },
},
```

Also fix WAF rate limiting to use per-token (not per-IP) aggregation, since multiple
agents behind a shared NAT will exhaust the IP-level limit:
```typescript
rateBasedStatement: {
  limit: 300,
  aggregateKeyType: 'CUSTOM_KEYS',
  customKeys: [{ header: { name: 'X-API-Key', textTransformations: [{ priority: 0, type: 'NONE' }] } }],
},
```

Fix WAF association dependency:
```typescript
const wafAssociation = new wafv2.CfnWebACLAssociation(this, 'MCPWAFAssociation', {
  resourceArn: `arn:aws:apigateway:${this.region}::/apis/${api.apiId}/stages/$default`,
  webAclArn: waf.attrArn,
});
wafAssociation.addDependency(waf);   // prevent race where association deploys before WAF
```

---

## Fix 6 — `submit_job` Returns No Job ID (SPEC-24 Fix 14 Never Applied to Source)

**Root cause:** `submit-job.ts` returns only the S3 key and tells the agent to use `list_jobs`
to find its job ID — racy if concurrent jobs exist, impossible to correlate deterministically.

**Fix in `packages/lambda/src/mcp/tools/submit-job.ts`:**
```typescript
const jobId = randomUUID();   // generate pre-upload

await s3.send(new PutObjectCommand({
  Bucket: bucket, Key: s3Key, Body: zipBuffer,
  ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId,
  Metadata: {
    'job-name':      jobName,
    'user-arn':      callerArn,
    'mcp-job-id':    jobId,         // ingestion Lambda honours this as the jobId
    'mcp-submitted': 'true',
  },
}));

return [{
  type: 'text',
  text: [
    '✅ Job submitted.',
    '',
    `Job ID:   ${jobId}`,
    `Job Name: ${jobName}`,
    `ETA:      10–30 seconds to RUNNING, 2–10 minutes to COMPLETE`,
    '',
    `Note: job_status returns NOT_FOUND for ~20s while the ingestion pipeline starts.`,
    `Poll:     call job_status with job_id="${jobId}"`,
  ].join('\n'),
}];
```

**Fix in `packages/lambda/src/ingestion/handler.ts`:**
```typescript
import { isValidUUID } from '@skills-svc/shared';   // ADD to shared/src/types.ts

const mcpJobId = head.Metadata?.['mcp-job-id'];
const jobId = (mcpJobId && isValidUUID(mcpJobId)) ? mcpJobId : randomUUID();
```

Add to `packages/shared/src/types.ts`:
```typescript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidUUID(v: string): boolean { return UUID_RE.test(v); }
```

---

## Fix 7 — submit_job Base64 Overhead Means Effective Zip Limit Is ~7.5MB Not 10MB

**Root cause:** API Gateway HTTP API enforces a 10MB request body limit. A 7.5MB zip
base64-encodes to ~10MB. The in-tool guard checks decoded zip size (10MB), which fires
after API Gateway has already rejected the oversized encoded body with HTTP 413.

**Fix in `packages/lambda/src/mcp/tools/submit-job.ts`:**
```typescript
const MAX_ENCODED_BYTES = 7 * 1024 * 1024; // 7MB encoded ≈ 5.25MB zip (conservative)
if (zipBase64.length > MAX_ENCODED_BYTES) {
  throw new Error(
    `Encoded zip is ${(zipBase64.length / 1024 / 1024).toFixed(1)}MB. ` +
    `API Gateway limit is 10MB; base64 overhead means the effective zip limit via MCP ` +
    `is ~7.5MB. Use \`skills-svc upload\` for larger files.`
  );
}
```

Update `zip_base64` schema description: `"max ~7.5 MB zip via MCP; use CLI for larger files"`.

---

## Fix 8 — job_status Returns Text-Only (SPEC-24 Fix 30 Never Applied)

**Root cause:** `job-status.ts` returns `[{ type: 'text', text: ... }]` only. Agents must
parse emoji-decorated prose to detect completion. SPEC-24 Fix 30 mandates a `type: 'resource'`
item with machine-readable JSON including `isTerminal` and `pollAgainInSeconds`.

**Fix in `packages/lambda/src/mcp/tools/job-status.ts`:**
```typescript
return [
  { type: 'text', text: lines.join('\n') },
  {
    type: 'resource',
    resource: {
      uri:      `skills://jobs/${jobId}`,
      mimeType: 'application/json',
      text: JSON.stringify({
        jobId,
        jobName:    job.jobName,
        status:     job.status,
        createdAt:  job.createdAt,
        updatedAt:  job.updatedAt,
        isTerminal: job.status === 'COMPLETE' || job.status === 'FAILED',
        pollAgainInSeconds: (job.status === 'PENDING' || job.status === 'RUNNING') ? 10 : null,
        ...(job.status === 'FAILED'   ? { errorMessage: job.errorMessage }            : {}),
        ...(job.status === 'COMPLETE' ? { resultAvailable: Boolean(job.s3ResultKey) } : {}),
      }),
    },
  },
];
```

Also fix the NOT_FOUND response to indicate propagation delay:
```typescript
if (!res.Item) {
  return [{
    type: 'text',
    text: `Job ${jobId} not found. If just submitted, wait 10–20 seconds for ingestion.`,
  }, {
    type: 'resource',
    resource: {
      uri: `skills://jobs/${jobId}`,
      mimeType: 'application/json',
      text: JSON.stringify({ jobId, status: 'NOT_FOUND', pollAgainInSeconds: 15, isTerminal: false }),
    },
  }];
}
```

---

## Fix 9 — get_result Decrypts Without userArn in KMS Context (Cross-Tenant Decryption Possible)

**Root cause (SPEC-23 Fix 14, not applied to MCP tool):** `envelopeDecrypt` called without
`userArn` in the encryption context. Any caller who knows Bob's `jobId` can decrypt Bob's
result. Must be deployed atomically with the ECS runner and ResultsProcessorLambda.

**Fix in `packages/lambda/src/mcp/tools/get-result.ts`:**
```typescript
const plain = await envelopeDecrypt(raw, {
  jobId,
  userArn:     callerArn,            // ADD — must match context used at encrypt time
  purpose:     'skills-svc-result',
  environment: env,
});
```

---

## Fix 10 — get_result on FAILED Job Returns Misleading "Not Complete Yet" Message

**Root cause:** All non-COMPLETE statuses get the same message, causing agents to loop
`job_status` → `get_result` forever for FAILED jobs.

**Fix in `packages/lambda/src/mcp/tools/get-result.ts`:**
```typescript
if (job.status === JobStatus.FAILED) {
  return [{
    type: 'text',
    text: [
      `Job FAILED — no result was produced.`,
      job.errorMessage ? `Error: ${job.errorMessage}` : '',
      `Do not retry get_result for this job. Submit a new job if needed.`,
    ].filter(Boolean).join('\n'),
  }];
}
if (job.status !== JobStatus.COMPLETE) {
  return [{
    type: 'text',
    text: `Job not yet complete. Status: ${job.status}. Poll job_status, then retry get_result when COMPLETE.`,
  }];
}
```

---

## Fix 11 — get_result Has No Size Guard; Large Results Crash with Lambda 502

**Root cause:** No size check before returning S3 result inline. Results >6MB exceed Lambda's
synchronous response limit, producing an opaque 502 with no MCP-compliant error body.

**Fix in `packages/lambda/src/mcp/tools/get-result.ts`:**
```typescript
const rawBytes = Buffer.concat(chunks);
const INLINE_LIMIT = 4 * 1024 * 1024; // 4MB conservative (6MB Lambda limit)

if (rawBytes.length > INLINE_LIMIT) {
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: resultKey }), { expiresIn: 3600 });
  return [{
    type: 'text',
    text: [
      `Result is too large to return inline (${(rawBytes.length / 1024 / 1024).toFixed(1)} MB).`,
      `Download via presigned URL (valid 1 hour):`,
      url,
    ].join('\n'),
  }];
}
```

---

## Fix 12 — query_knowledge_store: `hybrid` Query Returns 400 on AOSS (SPEC-24 Fix 2 Not Applied)

**Root cause:** AOSS does not support the `hybrid` query type without a configured search
pipeline. `searcher.ts` sends `{ hybrid: { queries: [...] } }` → AOSS returns 400.
No search pipeline is ever created.

**Fix in `packages/knowledge-store/src/searcher.ts` (from SPEC-24 Fix 2):**
```typescript
body: {
  size: topK,
  from: from ?? 0,
  query: {
    bool: {
      should: [
        { knn: { result_embedding: { vector: embedding, k: topK * 2 } } },
        {
          multi_match: {
            query,
            fields: ['job_name^2', 'result_summary^3', 'result_full_text^1', 'skill_names^1.5'],
            type: 'best_fields', fuzziness: 'AUTO',
          },
        },
      ],
      filter: [{ term: { user_arn: callerUserArn } }],
      minimum_should_match: 1,
    },
  },
  post_filter: { term: { user_arn: callerUserArn } },   // enforced after kNN scoring
  min_score: minScore,
  track_total_hits: true,
  _source: ['job_id', 'job_name', 'user_arn', 's3_result_key',
            'result_summary', 'created_at', 'skill_names'],
},
```

---

## Fix 13 — query_knowledge_store Tool Schema: Wrong Types + Missing Pagination

**Root cause (SPEC-24 Fix 16, not applied to source):** `top_k` and `min_score` typed as
`'string'`; compliant MCP clients reject numeric values. `from` pagination offset is missing
entirely. `QueryRequest` and `QueryResponse` types lack `from`, `total`, `hasMore`.

**Fix in `packages/lambda/src/mcp/tools/query.ts` inputSchema:**
```typescript
top_k:     { type: 'number', minimum: 1, maximum: 20, default: 5,   description: 'Results to return (1–20)' },
min_score: { type: 'number', minimum: 0, maximum: 1,  default: 0.5, description: 'Minimum relevance score' },
from:      { type: 'number', minimum: 0,              default: 0,   description: 'Pagination offset (0-based)' },
```

In `execute()`:
```typescript
const topK     = Math.min(Math.max(1, Number(args.top_k ?? 5)), 20);
const minScore = Math.min(Math.max(0, Number(args.min_score ?? 0.5)), 1);
const from     = Math.max(0, Number(args.from ?? 0));
```

Add to `packages/shared/src/types.ts`:
```typescript
export interface QueryRequest {
  query: string; callerUserArn: string;
  topK?: number; minScore?: number; from?: number;   // ADD from
}
export interface QueryResponse {
  results: SearchResult[]; queryDurationMs: number;
  total?: number; hasMore?: boolean; from?: number;  // ADD
}
```

---

## Fix 14 — query_knowledge_store Response Text-Only; Agents Must Regex-Parse Results

**Root cause (SPEC-24 Fix 30 pattern):** `query.ts` returns free-text markdown table only.
Agent extracting `jobId` for `get_result` must parse prose.

**Fix in `packages/lambda/src/mcp/tools/query.ts`:**
```typescript
return [
  { type: 'text', text: formattedText },
  {
    type: 'resource',
    resource: {
      uri:      'skills://query-results',
      mimeType: 'application/json',
      text: JSON.stringify({
        total:          response.total ?? response.results.length,
        from:           response.from ?? 0,
        hasMore:        response.hasMore ?? false,
        queryDurationMs: response.queryDurationMs,
        results: response.results.map(r => ({
          jobId:         r.jobId,
          jobName:       r.jobName,
          score:         r.score,
          skillNames:    r.skillNames,
          createdAt:     r.createdAt,
          resultSummary: r.resultSummary.slice(0, 500),
        })),
      }),
    },
  },
];
```

---

## Fix 15 — list_jobs Status-Filtered Path Uses GSI1 with Limit-Before-FilterExpression (User Jobs Invisible)

**Root cause (SPEC-23 Fix 12, not applied to MCP tool):** `GSI1-Status` query with `Limit: 10`
reads 10 items, then applies `FilterExpression: 'userArn = :user'`. If those 10 items are all
from other users, the agent sees 0 results even though it has RUNNING jobs.

**Fix in `packages/lambda/src/mcp/tools/list-jobs.ts` — always use GSI2-User:**
```typescript
const res = await ddb.send(new QueryCommand({
  TableName: tableName,
  IndexName: 'GSI2-User',
  KeyConditionExpression: 'GSI2PK = :user',
  ...(status !== 'ALL' ? {
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
  } : {}),
  ExpressionAttributeValues: {
    ':user': `${DDB_KEY_PREFIX.USER}${callerArn}`,
    ...(status !== 'ALL' ? { ':status': status } : {}),
  },
  ScanIndexForward: false,
  Limit: Math.min(Math.max(1, Number(args.limit ?? 20)), 100),
}));
```

Also add missing filter fields to schema:
```typescript
since:              { type: 'string', description: 'ISO 8601 date — jobs created at or after' },
until:              { type: 'string', description: 'ISO 8601 date — jobs created at or before' },
job_name_contains:  { type: 'string', description: 'Case-insensitive substring match on job name' },
limit:              { type: 'number', minimum: 1, maximum: 100, default: 20 },  // was type: 'string'
```

Also add `type: 'resource'` to list_jobs response (same pattern as Fix 8/14).

---

## Fix 16 — cancel_job Uses Old `startedBy` Prefix; ECS Task Never Stopped

**Root cause (SPEC-23 Fix 1, not applied to cancel_job):** `cancel-job.ts` queries
`ListTasks` with `startedBy: 'skills-svc-ingestion-{8chars}'`. SPEC-23 Fix 1 changed
the ingestion Lambda to use `startedBy: jobId` (bare UUID). ECS tasks are never found.

**Fix in `packages/lambda/src/mcp/tools/cancel-job.ts`:**
```typescript
const tasks = await ecs.send(new ListTasksCommand({
  cluster:    clusterArn,
  startedBy:  jobId,   // bare UUID — matches SPEC-23 Fix 1
}));
```

---

## Fix 17 — cancel_job `ecs:ListTasks` IAM Resource Scoped to Task ARN Instead of Cluster ARN

**Root cause:** `mcp-stack.ts` grants `ecs:ListTasks` on `task/*` resource. `ListTasks` is
a cluster-level API requiring the cluster ARN as resource. Every cancel throws `AccessDenied`.

**Fix in `infra/lib/mcp-stack.ts`:**
```typescript
mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:     'ECSListTasks',
  actions: ['ecs:ListTasks'],
  resources: [
    `arn:aws:ecs:${this.region}:${this.account}:cluster/${props.ecsClusterName}`,
  ],
}));
mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:     'ECSStopTask',
  actions: ['ecs:StopTask'],
  resources: [
    `arn:aws:ecs:${this.region}:${this.account}:task/${props.ecsClusterName}/*`,
  ],
}));
```

---

## Fix 18 — cancel_job Terminal-State Rejection Returns isError: false (Agent Cannot Detect Failure)

**Root cause:** Returning a text content block with `isError: false` for "cannot cancel — already
terminal" means the agent sees a successful tool call. It does not know the cancel was rejected.

**Fix in `packages/lambda/src/mcp/tools/cancel-job.ts`:**
```typescript
if (status === JobStatus.COMPLETE || status === JobStatus.FAILED) {
  throw new Error(`Cannot cancel — job ${jobId} is already in terminal state: ${status}`);
  // server.ts catch block returns isError: true with this message
}
```

Also add `ConditionalCheckFailedException` handling for the optimistic lock race:
```typescript
} catch (err: any) {
  if (err.name === 'ConditionalCheckFailedException') {
    return [{
      type: 'text',
      text: `Job ${jobId} reached terminal state before cancellation could complete.`,
    }];
  }
  throw err;
}
```

---

## Fix 19 — `MCPContent` Type Missing `resource` Field; Fix 8/14/15 Cannot Compile

**Root cause:** `types.ts` declares `type: 'text' | 'image' | 'resource'` but has no `resource`
property. TypeScript strict mode rejects `{ type: 'resource', resource: { ... } }`.

**Fix in `packages/lambda/src/mcp/types.ts`:**
```typescript
export interface MCPEmbeddedResource {
  uri:      string;
  mimeType: string;
  text?:    string;
  blob?:    string;
}

export interface MCPContent {
  type:      'text' | 'image' | 'resource';
  text?:     string;
  data?:     string;
  mimeType?: string;
  resource?: MCPEmbeddedResource;   // ADD
}

// Also add default/minimum/maximum to property schema type:
export interface MCPToolPropertySchema {
  type:        string;
  description: string;
  enum?:       string[];
  minimum?:    number;
  maximum?:    number;
  default?:    unknown;   // ADD
}
```

---

## Fix 20 — `summary_only` Schema type: 'string'; Passing Boolean `true` Is Silently Ignored

**Root cause (SPEC-24 Fix 16, not applied to get-result.ts):** `summary_only: { type: 'string' }`
with `args.summary_only === 'true'` check — MCP clients send `true` (boolean) per JSON Schema,
which evaluates `true === 'true'` → `false`. The flag is always ignored.

**Fix in `packages/lambda/src/mcp/tools/get-result.ts`:**
```typescript
// Schema:
summary_only: { type: 'boolean', default: false, description: 'Return summary only (default: false)' },

// execute():
const summaryOnly = args.summary_only === true || args.summary_only === 'true';
```

---

## Fix 21 — `server.error()` Returns `id: undefined` Which JSON.stringify Drops (JSON-RPC 2.0 Violation)

**Root cause:** When `req.id` is `undefined` (ill-formed request), the error response has
`"id": undefined` which is silently dropped by `JSON.stringify`, violating JSON-RPC 2.0 §5
which requires `id: null` in error responses.

**Fix in `packages/lambda/src/mcp/server.ts`:**
```typescript
private error(id: unknown, code: number, message: string): MCPResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
private respond(id: unknown, result: unknown): MCPResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
```

---

## Fix 22 — `server.handle()` Never Validates `jsonrpc: "2.0"` Field

**Root cause:** The server never checks `req.jsonrpc`. A request with `jsonrpc: "1.0"` is
processed normally. Per JSON-RPC 2.0 §4, the server must return `-32600 Invalid Request`
if `jsonrpc` is not exactly `"2.0"`.

**Fix in `packages/lambda/src/mcp/server.ts`:**
```typescript
async handle(request: unknown, callerArn: string): Promise<MCPResponse | null> {
  const req = request as Partial<MCPRequest>;

  if (req.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: (req as any).id ?? null,
             error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } };
  }
  if (typeof req.method !== 'string') {
    return { jsonrpc: '2.0', id: (req as any).id ?? null,
             error: { code: -32600, message: 'Invalid Request: method must be a string' } };
  }
  if (!('id' in req)) return null;  // notification
  // ...rest unchanged
```

---

## Fix 23 — `validateArgs` Passes null Values Through; Downstream Code Throws Opaque TypeError

**Root cause:** `!(field in args)` is `true` even when `field: null`. `Buffer.from(null, 'base64')`
and `(null as string).slice(0, 128)` throw unguarded TypeErrors with internal details.

**Fix in `packages/lambda/src/mcp/server.ts`:**
```typescript
function validateArgs(args: unknown, schema: Record<string, unknown>): string | null {
  if (!args || typeof args !== 'object') return 'Arguments must be an object';
  const required = (schema.required as string[] | undefined) ?? [];
  const argsObj = args as Record<string, unknown>;
  for (const field of required) {
    if (!(field in argsObj)) return `Missing required argument: ${field}`;
    if (argsObj[field] === null || argsObj[field] === undefined) {
      return `Required argument "${field}" must not be null or undefined`;
    }
  }
  return null;
}
```

---

## Fix 24 — Tool Error Messages Leak AWS SDK Internals (Table ARNs, Request IDs)

**Root cause:** `String(err)` on AWS SDK errors includes table ARNs, KMS key ARNs, endpoint URLs,
and `RequestId` values in the message surfaced to the MCP client.

**Fix in `packages/lambda/src/mcp/server.ts`:**
```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const SAFE_PREFIXES = [
    'Access denied', 'Job not found', 'not found', 'already in terminal',
    'not yet complete', 'Job FAILED', 'Cannot cancel', 'exceeds', 'not a valid ZIP',
    'Invalid zip', 'Zip file exceeds', 'Missing required', 'must not be null',
  ];
  const isSafeMessage = SAFE_PREFIXES.some(p => msg.includes(p));
  const userMessage = isSafeMessage
    ? msg
    : 'An internal error occurred. Check server logs for details.';

  console.error(JSON.stringify({ event: 'tool_error', tool: name, err: msg, callerArn }));
  return this.respond(req.id, {
    content: [{ type: 'text', text: userMessage }],
    isError: true,
  });
}
```

---

## Fix 25 — All-Notification Batch Returns HTTP 200 `[]` Instead of HTTP 204

**Root cause (JSON-RPC 2.0 §6):** When a batch request consists entirely of notifications,
the server must not return a response. Returning `[]` with HTTP 200 is non-compliant.

**Fix in `packages/lambda/src/mcp/handler.ts`:**
```typescript
if (Array.isArray(body)) {
  const responses = await Promise.all(body.map(req => server.handle(req, callerArn)));
  const nonNull = responses.filter(r => r !== null);
  if (nonNull.length === 0) {
    return { statusCode: 204, body: '' };   // all notifications — must not return a response
  }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify(nonNull) };
}
```

---

## Fix 26 — submit_job Allows Duplicate Submissions of Same Zip (No Content-Based Idempotency)

**Root cause:** Two MCP `submit_job` calls with identical zips create two separate S3 objects
(different keys, different ETags), bypassing the ETag-based idempotency check in the
ingestion Lambda entirely. Agents retrying on transient errors create duplicate jobs and
duplicate Bedrock charges.

**Fix:** Use a SHA-256 content hash as a deduplication key:
```typescript
// In submit-job.ts, before upload:
const contentHash = createHash('sha256').update(zipBuffer).digest('hex');

// Check DDB for existing job with same content hash (within last 24h):
const existing = await ddb.send(new QueryCommand({
  TableName: cfg.dynamodbTableName,
  IndexName: 'GSI4-CacheKey',
  KeyConditionExpression: 'GSI4PK = :ck',
  ExpressionAttributeValues: { ':ck': `CONTENTHASH#${contentHash}` },
  Limit: 1,
}));
if (existing.Items?.length) {
  const prev = existing.Items[0];
  return [{
    type: 'text',
    text: `Duplicate submission detected. This zip was already submitted as job ${prev.jobId}.`,
  }, {
    type: 'resource',
    resource: {
      uri: `skills://jobs/${prev.jobId}`,
      mimeType: 'application/json',
      text: JSON.stringify({ jobId: prev.jobId, status: prev.status, isDuplicate: true }),
    },
  }];
}
```

---

## Fix 27 — CORS Missing OPTIONS Method; MCP initialize Preflight Blocked

**Root cause:** `corsPreflight.allowMethods` lists only `POST`. CORS preflights for `/mcp`
use `OPTIONS`. Browser and Claude Desktop clients fail the preflight and cannot complete
the `initialize` handshake.

**Fix in `infra/lib/mcp-stack.ts`:** Already included in Fix 2 (`CorsHttpMethod.OPTIONS` added).

---

## Fix 28 — isError: false Included in All Successful Tool Responses (Spec Says Omit When Not Error)

**Root cause:** Per MCP spec, `isError` should only be present and `true` for error results.
Including `isError: false` on every success is non-compliant noise; some clients treat it as
an error indicator.

**Fix in `packages/lambda/src/mcp/server.ts`:**
```typescript
// Success path — omit isError entirely:
return this.respond(req.id, {
  content: Array.isArray(result) ? result : [{ type: 'text', text: JSON.stringify(result) }],
  // Do NOT include isError: false
});

// Error path — keep isError: true:
return this.respond(req.id, {
  content: [{ type: 'text', text: userMessage }],
  isError: true,
});
```

---

## Summary

| Fix | Severity | Component | Issue |
|-----|----------|-----------|-------|
| 1  | CRITICAL  | CDK          | MCP Lambda missing DYNAMODB_TABLE_NAME/RESULTS_BUCKET/QUERY_LAMBDA_ARN/UPLOADS_BUCKET |
| 2  | CRITICAL  | CDK + Auth   | HttpIamAuthorizer still in MCPStack; Fix 15 Lambda authorizer never wired → 403 on every call |
| 3  | CRITICAL  | CLI          | mcp-config writes AWS credentials to mcp.json; TTL is literal `...`; token never stored |
| 4  | BLOCKING  | Lambda       | handler.ts reads iam.userArn but Lambda authorizer puts identity in lambda.callerUserArn |
| 5  | BLOCKING  | CDK + WAF    | SizeRestrictions_BODY blocks submit_job; NoUserAgent_HEADER blocks headless agents; WAF race |
| 6  | BLOCKING  | submit_job   | No jobId returned; isValidUUID undefined; SPEC-24 Fix 14 never applied to source |
| 7  | BLOCKING  | submit_job   | Base64 overhead means effective limit is ~7.5MB not 10MB; guard fires after API GW 413 |
| 8  | BLOCKING  | job_status   | Text-only response; SPEC-24 Fix 30 never applied; pollAgainInSeconds absent |
| 9  | BLOCKING  | get_result   | envelopeDecrypt missing userArn in KMS context; cross-tenant decryption possible |
| 10 | BLOCKING  | get_result   | FAILED job returns "not complete yet" — agent loops forever |
| 11 | BLOCKING  | get_result   | No size guard; results >6MB crash with Lambda 502 |
| 12 | BLOCKING  | query        | hybrid query returns AOSS 400; SPEC-24 Fix 2 never applied to searcher.ts |
| 13 | BLOCKING  | query schema | top_k/min_score typed string not number; `from` pagination missing entirely |
| 14 | BLOCKING  | query        | Text-only response; agents must regex-parse results to extract jobIds |
| 15 | BLOCKING  | list_jobs    | GSI1 + Limit-before-FilterExpression → user's own jobs invisible; missing since/until filters |
| 16 | BLOCKING  | cancel_job   | Uses old startedBy prefix; ECS task never found, never stopped |
| 17 | BLOCKING  | cancel_job   | ecs:ListTasks IAM resource is task/* not cluster/* → AccessDenied on every cancel |
| 18 | BLOCKING  | cancel_job   | Terminal-state rejection returns isError:false; agent cannot detect failure |
| 19 | BLOCKING  | types.ts     | MCPContent.resource field missing; Fix 8/14/15 fail TypeScript compilation |
| 20 | BLOCKING  | get_result   | summary_only: type:'string'; boolean `true` evaluates `=== 'true'` → false, always ignored |
| 21 | CORRECTNESS | server.ts  | error() returns id:undefined → dropped by JSON.stringify; must be id:null |
| 22 | CORRECTNESS | server.ts  | jsonrpc field never validated; non-2.0 requests processed without error |
| 23 | CORRECTNESS | server.ts  | validateArgs passes null values; downstream throws opaque TypeError |
| 24 | CORRECTNESS | server.ts  | String(err) leaks AWS table ARNs, KMS key ARNs, RequestIds to MCP client |
| 25 | CORRECTNESS | handler.ts | All-notification batch returns HTTP 200 [] instead of HTTP 204 |
| 26 | CORRECTNESS | submit_job | No content-based idempotency; same zip submitted twice creates duplicate jobs and bills |
| 27 | BLOCKING  | CDK CORS     | OPTIONS method missing from allowMethods; initialize preflight blocked (included in Fix 2) |
| 28 | CORRECTNESS | server.ts  | isError:false on success responses is non-spec; some clients treat as error |
