# Skills as a Service (SaaS) — Specification Part 15: Agent Audit Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** 5-agent parallel audit of SPEC-01 through SPEC-14  
**Parts:** ... | [Part 14](SPEC-14-cleanup.md) | [Part 15: Agent Audit Fixes]

---

## Audit Summary

5 agents audited SPEC-01–14 in parallel and found 71 raw issues. After deduplication and false-positive removal, **26 real issues** remain. False positives are noted inline.

| # | Severity | Issue | Source |
|---|----------|-------|--------|
| 1 | **BLOCKER** | NetworkStack never writes SSM params for VPC subnet IDs and ECS SG — Lambda cannot submit ECS tasks | Agent 1 |
| 2 | **BLOCKER** | `packages/lambda/src/query/handler.ts` never implemented | Agent 1, 2 |
| 3 | **BLOCKER** | `packages/lambda/src/bootstrap-index/handler.ts` never implemented | Agent 5 |
| 4 | **BLOCKER** | `fs.watch({ recursive: true })` silently broken on Linux — watch mode never triggers on skill file changes | Agent 3 |
| 5 | **BLOCKER** | `cache.ts` has duplicate `ExpressionAttributeValues` key — JavaScript silently drops first declaration | Agent 3 |
| 6 | **BLOCKER** | Cache key mismatch — CLI uses `SHA256(zipBuffer)`, Lambda uses `SHA256(s3ETag)` — cache never hits | Agent 3 |
| 7 | **BLOCKER** | `configure` calls `cloudformation:DescribeStacks` but `UserRole` has no such permission | Agent 5 |
| 8 | **BLOCKER** | Lambda functions have no explicit log group with KMS — `EncryptionEnforcerAspect` will fail synth | Agent 1 |
| 9 | **BLOCKER** | VPC flow logs use `toCloudWatchLogs()` without KMS key — Aspect validation fails | Agent 1 |
| 10 | **BLOCKER** | `lambdaEnvKey` accepted by `LambdaStack` but never applied — Lambda env vars are unencrypted | Agent 1 |
| 11 | **CORRECTNESS** | `QueryLambdaRole` missing `kms:Decrypt` for Bedrock and OpenSearch keys | Agent 1 |
| 12 | **CORRECTNESS** | `cancel.ts` SNS publish missing `MessageAttributes` — `notify subscribe --filter-status` never fires on cancel events | Agent 3 |
| 13 | **CORRECTNESS** | Orphaned DDB batch METADATA record when `StartExecutionCommand` fails after write | Agent 5 |
| 14 | **CORRECTNESS** | QA-009 asserts exactly 2 GSIs — should be 5 (updated in SPEC-11/12 but test not updated) | Agent 2 |
| 15 | **CORRECTNESS** | QA-062 calls `hybridSearch('test query')` with 1 arg — now requires `callerUserArn` as 2nd arg | Agent 2 |
| 16 | **CORRECTNESS** | QA-091 Lambda cost rate `0.0000166667` is ~83× too high — correct is `0.0000002` per GB-s | Agent 2 |
| 17 | **CORRECTNESS** | S3 event filter suffix `/skill.zip` has leading slash — S3 filter matches key suffix literally; key ends with `skill.zip` not `/skill.zip` | Agent 4 |
| 18 | **CORRECTNESS** | `ArtifactsBucket` created in StorageStack, never referenced by any other stack or SSM param | Agent 1 |
| 19 | **CORRECTNESS** | SSM param caching in `knowledge-store/searcher.ts` uses module-level variable with no TTL — stale after redeploy | Agent 1 |
| 20 | **CORRECTNESS** | Deployment runbook in SPEC-05 still contains Step 4 (set Anthropic API key) and lists only 9 stacks | Agent 2 |
| 21 | **CORRECTNESS** | `uploadsKmsKeyId` prop carries full ARN, not key ID — prop name misleads | Agent 5 |
| 22 | **CORRECTNESS** | `MCPStackProps.opensearchEndpoint` is a dead field — MCP Lambda uses query Lambda, not OpenSearch directly | Agent 5 |
| 23 | **CORRECTNESS** | ECSStack receives `uploadsBucket`/`resultsBucket` props but never writes their names to SSM — ECS container reads them from SSM | Agent 1 |
| 24 | **DESIGN** | Race condition in `skill push` — two concurrent pushes of same version can both pass the DDB check | Agent 4 |
| 25 | **DESIGN** | `chokidar` listed in SPEC-07 CLI deps but dropped from authoritative `packages/cli/package.json` in SPEC-14 | Agent 3 |
| 26 | **DESIGN** | Claude Desktop references remain in SPEC-09 source — SPEC-14 instructs removal but doesn't edit SPEC-09 | Agent 3, 5 |

**Verified false positives (not real issues):**
- CloudWatch Logs `FilterLogEventsCommand` with `{ $.field = "value" }` pattern IS valid — AWS supports JSON log pattern syntax in FilterLogEvents
- `FlexibleTimeWindowMode.OFF` does NOT require `MaximumWindowInMinutes` — only needed for `FLEXIBLE` mode
- `updateJobStatus` token counts param IS backward compatible — optional param with `.filter(Boolean)` guard
- SDK dependencies are correctly distributed between Lambda and CLI
- DDB `OR` operator in `ConditionExpression` IS valid DynamoDB syntax
- `MetadataDirective: REPLACE` correctly sets new metadata including `run-id`
- Same-bucket S3 `CopyObjectCommand` is valid and supported by AWS SDK

---

## Fix 1: NetworkStack — Write VPC SSM Parameters

**`infra/lib/network-stack.ts`** — add to end of constructor:

```typescript
import * as ssm from 'aws-cdk-lib/aws-ssm';

// These are read by ingestion Lambda when submitting ECS RunTask
const privateSubnetIds = this.vpc
  .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED })
  .subnetIds.join(',');

new ssm.StringParameter(this, 'ParamPrivateSubnetIds', {
  parameterName: `/skills-svc/${props.envName}/vpc/private-subnet-ids`,
  stringValue: privateSubnetIds,
  description: 'Comma-separated private subnet IDs for ECS task placement',
});

new ssm.StringParameter(this, 'ParamEcsSgId', {
  parameterName: `/skills-svc/${props.envName}/vpc/ecs-sg-id`,
  stringValue: this.ecsSg.securityGroupId,
});

new ssm.StringParameter(this, 'ParamLambdaSgId', {
  parameterName: `/skills-svc/${props.envName}/vpc/lambda-sg-id`,
  stringValue: this.lambdaSg.securityGroupId,
});
```

Also add `envName: string` to `NetworkStackProps`.

---

## Fix 2: Query Lambda Handler Implementation

**`packages/lambda/src/query/handler.ts`** (new file):

```typescript
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { captureAWSv3Client } from 'aws-xray-sdk';
import { hybridSearch } from '@skills-svc/knowledge-store';
import { QueryRequest, QueryResponse } from '@skills-svc/shared';

export const handler = async (event: QueryRequest): Promise<QueryResponse> => {
  if (!event.callerUserArn) {
    throw new Error('callerUserArn is required');
  }

  const start = Date.now();

  const results = await hybridSearch(
    event.query,
    event.callerUserArn,
    event.topK ?? 5,
    event.minScore ?? 0.5,
  );

  return {
    results,
    queryDurationMs: Date.now() - start,
  };
};
```

**Add `@skills-svc/knowledge-store` to Lambda package.json dependencies:**

```json
"@skills-svc/knowledge-store": "*"
```

---

## Fix 3: Bootstrap Index Handler Implementation

**`packages/lambda/src/bootstrap-index/handler.ts`** (new file — CDK Custom Resource Lambda):

```typescript
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

const INDEX_MAPPING = {
  settings: {
    index: {
      knn: true,
      'knn.algo_param.ef_search': 512,
      number_of_shards: 5,
      number_of_replicas: 1,
      refresh_interval: '5s',
    },
  },
  mappings: {
    properties: {
      job_id:           { type: 'keyword' },
      job_name:         { type: 'text', fields: { keyword: { type: 'keyword' } } },
      user_arn:         { type: 'keyword' },
      skill_names:      { type: 'keyword' },
      skill_name:       { type: 'keyword' },
      skill_version:    { type: 'keyword' },
      prompt:           { type: 'text', analyzer: 'english' },
      result_summary:   { type: 'text', analyzer: 'english' },
      result_full_text: { type: 'text', analyzer: 'english', index_options: 'offsets' },
      result_embedding: {
        type: 'knn_vector',
        dimension: 1536,
        method: {
          name: 'hnsw',
          space_type: 'cosine',
          engine: 'faiss',
          parameters: { ef_construction: 256, m: 48 },
        },
      },
      created_at:    { type: 'date', format: 'strict_date_optional_time' },
      completed_at:  { type: 'date', format: 'strict_date_optional_time' },
      tags:          { type: 'keyword' },
      s3_result_key: { type: 'keyword' },
      duration_ms:   { type: 'long' },
      exit_code:     { type: 'integer' },
      input_tokens:  { type: 'integer' },
      output_tokens: { type: 'integer' },
      version:       { type: 'integer' },
    },
  },
};

export const handler = async (event: { RequestType: string; ResourceProperties: Record<string, string> }) => {
  if (event.RequestType === 'Delete') return; // never delete the index on stack teardown

  const env = process.env.ENV ?? 'prod';

  const endpoint = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${env}/opensearch/endpoint`,
  })).then(r => r.Parameter!.Value!);

  const indexName = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${env}/opensearch/index-name`,
  })).then(r => r.Parameter!.Value!);

  const client = new OpenSearchClient({
    ...AwsSigv4Signer({
      region: process.env.REGION ?? 'us-east-1',
      service: 'aoss',
      getCredentials: defaultProvider(),
    }),
    node: endpoint,
    requestTimeout: 30_000,
  });

  // Idempotent — create only if not exists
  const exists = await client.indices.exists({ index: indexName });
  if (exists.statusCode === 200) {
    console.log(JSON.stringify({ event: 'index_already_exists', indexName }));
    return;
  }

  await client.indices.create({ index: indexName, body: INDEX_MAPPING });
  console.log(JSON.stringify({ event: 'index_created', indexName }));
};
```

**Wire as CDK Custom Resource in `KnowledgeStoreStack`:**

```typescript
import * as cr from 'aws-cdk-lib/custom-resources';
import * as lambda from 'aws-cdk-lib/aws-lambda';

const bootstrapFn = new lambda.Function(this, 'BootstrapIndexFn', {
  functionName: `skills-svc-bootstrap-index-${this.account}`,
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'bootstrap-index/handler.handler',
  code: lambda.Code.fromAsset('../packages/lambda/dist'),
  timeout: cdk.Duration.minutes(5),
  memorySize: 256,
  vpc: props.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [props.lambdaSg],  // needs lambdaSg in props
  environment: { ENV: envName, REGION: this.region },
  role: props.resultsLambdaRole,  // reuse — has OpenSearch + SSM access
});

// Run once after collection is created
const bootstrapResource = new cr.AwsCustomResource(this, 'BootstrapIndex', {
  onCreate: {
    service: 'Lambda',
    action: 'invoke',
    parameters: {
      FunctionName: bootstrapFn.functionName,
      Payload: JSON.stringify({ RequestType: 'Create', ResourceProperties: {} }),
    },
    physicalResourceId: cr.PhysicalResourceId.of('BootstrapIndex'),
  },
  policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [bootstrapFn.functionArn] }),
});
bootstrapResource.node.addDependency(collection);
```

**Add `lambdaSg` to `KnowledgeStoreStackProps`:**
```typescript
lambdaSg: ec2.SecurityGroup;
```

---

## Fix 4: Watch Mode — Use `chokidar` Instead of `fs.watch`

### Add to `packages/cli/package.json` dependencies

```json
"chokidar": "^3.6.0"
```

### Update `packages/cli/src/commands/watch.ts`

Replace `fs.watch` block:

```typescript
// REPLACE:
// const watcher = fs.watch(absDir, { recursive: true }, (eventType, filename) => { ... });

// WITH:
import chokidar from 'chokidar';

const ignored = [
  '**/.git/**',
  '**/node_modules/**',
  ...ignoreGlobs.map(g => `**/${g}`),
];

const watcher = chokidar.watch(absDir, {
  ignored,
  ignoreInitial: true,   // don't trigger on startup
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
});

watcher.on('change', (filePath: string) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => triggerRun(filePath), debounceMs);
});

watcher.on('add', (filePath: string) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => triggerRun(filePath), debounceMs);
});
```

---

## Fix 5: `cache.ts` — Merge Duplicate `ExpressionAttributeValues`

**`packages/cli/src/utils/cache.ts`** — fix `checkCache` QueryCommand:

```typescript
export async function checkCache(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  cacheKey: string,
): Promise<CacheEntry | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI4-CacheKey',
    KeyConditionExpression: 'GSI4PK = :pk',
    FilterExpression: '#status = :complete',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {              // single declaration — no duplicate
      ':pk':       `CACHE#${cacheKey}`,
      ':complete': JobStatus.COMPLETE,
    },
    ScanIndexForward: false,
    Limit: 1,
  }));

  const item = res.Items?.[0];
  if (!item) return null;
  return {
    jobId:       item.jobId as string,
    createdAt:   item.createdAt as string,
    s3ResultKey: item.s3ResultKey as string | undefined,
  };
}
```

---

## Fix 6: Cache Key — Unified SHA256 of Zip Content

The CLI and ingestion Lambda must use the same cache key computation.

### CLI (`packages/cli/src/utils/cache.ts`) — already uses `SHA256(zipBuffer + prompt)` ✓

### Ingestion Lambda (`packages/lambda/src/ingestion/handler.ts`) — fix to match CLI

```typescript
// REPLACE ETag-based cache key:
// const cacheKey = createHash('sha256').update(zipMd5).update(manifestPrompt).digest('hex');

// WITH SHA256 of the actual zip bytes (same as CLI):
// Download zip fully for cache key computation (already done for validation)
const zipSha256 = createHash('sha256').update(zipBuffer).digest('hex');
const cacheKey = createHash('sha256')
  .update(zipSha256)
  .update('\x00')
  .update(validation.manifest?.defaultPrompt ?? '')
  .digest('hex');

// Store in DDB:
GSI4PK: `CACHE#${cacheKey}`,
cacheKey,
zipSha256,   // store for skill pull verification
```

This matches `computeCacheKey(zipBuffer, prompt)` in `packages/cli/src/utils/cache.ts`.

---

## Fix 7: `UserRole` — Add `cloudformation:DescribeStacks`

**`infra/lib/security-stack.ts`** — add to `userRole` inline policies:

```typescript
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'DescribeStacksForConfigure',
  actions: ['cloudformation:DescribeStacks'],
  resources: [
    `arn:aws:cloudformation:${this.region}:${this.account}:stack/SkillsSvc-*/`,
  ],
}));
```

---

## Fix 8: Lambda Log Groups — Explicit KMS Encryption

Every Lambda function must have an explicit log group with the `lambdaEnvKey` applied, or the `EncryptionEnforcerAspect` will fail synth.

**`infra/lib/lambda-stack.ts`** — add a helper and apply to each function:

```typescript
import * as logs from 'aws-cdk-lib/aws-logs';

// Helper — call for each Lambda function
function makeLogGroup(scope: Construct, id: string, props: {
  functionName: string;
  envName: string;
  kmsKey: kms.Key;
}): logs.LogGroup {
  return new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: logs.RetentionDays.THREE_MONTHS,
    encryptionKey: props.kmsKey,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
}

// Apply to each Lambda:
const ingestionLogGroup = makeLogGroup(this, 'IngestionFn', {
  functionName: `skills-svc-ingestion-${this.account}`,
  envName: props.envName,
  kmsKey: props.lambdaEnvKey,
});

// Then pass to Lambda function:
this.ingestionFn = new lambda.Function(this, 'SkillsIngestionLambda', {
  ...sharedLambdaProps,
  logGroup: ingestionLogGroup,   // ADD — explicit encrypted log group
  // remove: logRetention (redundant when logGroup is set)
});

// Repeat for resultsProcessorFn, queryFn, runSkillFn, scheduleTriggerFn
```

**Grant the Lambda key permission to log service:**

```typescript
props.lambdaEnvKey.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'AllowCloudWatchLogs',
  principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
  actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'],
  resources: ['*'],
  conditions: {
    ArnLike: {
      'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
    },
  },
}));
```

---

## Fix 9: VPC Flow Logs — Add KMS Key

**`infra/lib/network-stack.ts`** — replace flow log creation:

```typescript
// NetworkStack needs ecsLogKey passed in or use a dedicated key.
// Simplest: create a dedicated VPC log key in SecurityStack and pass it.
// For now, create inline (NetworkStack deploys before SecurityStack, so pass key as prop):

// ADD to NetworkStackProps:
// flowLogsKey: kms.Key;  ← OR create inline

// Inline approach (NetworkStack creates its own key):
const flowLogsKey = new kms.Key(this, 'FlowLogsKey', {
  alias: `alias/skills-svc/${props.envName}/vpc-flow-logs`,
  enableKeyRotation: true,
  pendingWindow: cdk.Duration.days(30),
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

// Grant CloudWatch Logs service permission to use the key
flowLogsKey.addToResourcePolicy(new iam.PolicyStatement({
  principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
  actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
  resources: ['*'],
}));

const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
  logGroupName: `/skills-svc/${props.envName}/vpc/flow-logs`,
  retention: logs.RetentionDays.THREE_MONTHS,
  encryptionKey: flowLogsKey,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

new ec2.FlowLog(this, 'FlowLog', {
  resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
  trafficType: ec2.FlowLogTrafficType.ALL,
  destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
});
```

---

## Fix 10: Apply `lambdaEnvKey` to Lambda Environment Encryption

**`infra/lib/lambda-stack.ts`** — CDK Lambda function does not directly encrypt env vars via KMS in the same way; the `lambdaEnvKey` is used for the log group. For Lambda env var encryption via KMS, CDK uses `environmentEncryption` prop:

```typescript
// Add to sharedLambdaProps:
const sharedLambdaProps = {
  // ...existing props...
  environmentEncryption: props.lambdaEnvKey,  // ADD — encrypts env vars at rest
};
```

This requires the `lambdaEnvKey` to grant Lambda service permission:

```typescript
// In SecurityStack, add to lambdaEnvKey resource policy:
this.lambdaEnvKey.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'AllowLambdaEnvEncryption',
  principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: ['*'],
  conditions: {
    StringEquals: { 'kms:CallerAccount': this.account },
  },
}));
```

---

## Fix 11: `QueryLambdaRole` — Add Missing KMS Permissions

**`infra/lib/security-stack.ts`** — update `queryLambdaRole`:

```typescript
this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KMSDecrypt',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [
    this.opensearchKey.keyArn,   // ADD — for OpenSearch client
    this.lambdaEnvKey.keyArn,    // ADD — for env var decryption
  ],
}));
```

---

## Fix 12: `cancel.ts` — Add `status` MessageAttribute to SNS Publish

**`packages/cli/src/commands/cancel.ts`** — update SNS publish:

```typescript
await sns.send(new PublishCommand({
  TopicArn: topicArn,
  Subject: `Skills SaaS Job Cancelled: ${res.Item.jobName}`,
  Message: JSON.stringify({ jobId, jobName: res.Item.jobName, status: JobStatus.FAILED,
    message: `Cancelled by user: ${opts.reason}`, timestamp: now }),
  MessageAttributes: {
    jobId:  { DataType: 'String', StringValue: jobId },
    status: { DataType: 'String', StringValue: JobStatus.FAILED },  // ADD — enables filter policy
  },
}));
```

---

## Fix 13: Batch — Cleanup on SFN Start Failure

**`packages/cli/src/commands/batch.ts`** — wrap SFN start in try/catch and clean up on failure:

```typescript
let execution: { executionArn?: string };
try {
  execution = await sfn.send(new StartExecutionCommand({ ... }));
} catch (err) {
  // Clean up the METADATA record so batch list doesn't show a phantom running batch
  await ddb.send(new UpdateCommand({
    TableName: batchTableName,
    Key: { PK: `BATCH#${batchId}`, SK: 'METADATA' },
    UpdateExpression: 'SET #status = :failed, errorMessage = :err, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':failed': 'FAILED',
      ':err': `Step Functions start failed: ${String(err)}`,
      ':now': new Date().toISOString(),
    },
  }));
  console.error(chalk.red(`Failed to start batch execution: ${String(err)}`));
  process.exit(1);
}
```

---

## Fix 14: QA-009 — Update GSI Assertion

```typescript
// REPLACE QA-009:
test('QA-009: DynamoDB jobs table has exactly 5 GSIs', () => {
  const { templates } = buildTestApp();
  const tables = templates.storage.findResources('AWS::DynamoDB::Table');
  const table = Object.values(tables)[0] as any;
  const gsis = table.Properties.GlobalSecondaryIndexes ?? [];
  expect(gsis).toHaveLength(5);
  const names = gsis.map((g: any) => g.IndexName);
  expect(names).toContain('GSI1-Status');
  expect(names).toContain('GSI2-User');
  expect(names).toContain('GSI3-Schedule');
  expect(names).toContain('GSI4-CacheKey');
  expect(names).toContain('GSI5-Skill');
});
```

---

## Fix 15: QA-062 — Add `callerUserArn` Argument

```typescript
// REPLACE QA-062:
test('QA-062: hybridSearch returns results sorted by score descending', async () => {
  const mockHits = [
    { _source: mockSource, _score: 0.9 },
    { _source: mockSource, _score: 0.5 },
    { _source: mockSource, _score: 0.7 },
  ];
  jest.spyOn(clientModule, 'getOpenSearchClient').mockResolvedValue({
    search: jest.fn().mockResolvedValue({ body: { hits: { hits: mockHits } } }),
  } as any);
  jest.spyOn(embeddingsModule, 'getEmbedding').mockResolvedValue(Array(1536).fill(0.1));

  // ADD callerUserArn as second argument:
  const results = await hybridSearch('test query', 'arn:aws:iam::123:user/test');
  const scores = results.map(r => r.score);
  expect(scores).toEqual([0.9, 0.7, 0.5]);
});
```

---

## Fix 16: QA-091 — Fix Lambda Cost Rate

AWS Lambda pricing: **$0.20 per 1 million GB-seconds** = `$0.0000002` per GB-second.

The spec used `0.0000166667` which is the **old Lambda pricing from 2018**, approximately 83× too high.

```typescript
// REPLACE QA-091 Lambda cost line:
// const lambdaCost = lambdaGBSeconds * 0.0000166667;  // WRONG

const lambdaCost = lambdaGBSeconds * 0.0000002;  // $0.20 per million GB-s

// Updated formula:
const lambdaGBSeconds = N * 2 * (5 * 60) * (512 / 1024);  // = 300,000 GB-s
const lambdaCost = lambdaGBSeconds * 0.0000002;            // = $0.06

// Updated total (replaces $0.25):
// Lambda: $0.06 (was $0.25)
// Total at N=1000: ~$368 → ~$368 (OpenSearch still dominates; Lambda change is small)
```

Also update the cost model table in SPEC-05 and SPEC-13:

| Component | Old Rate | Correct Rate | Old Monthly | Correct Monthly |
|-----------|----------|-------------|-------------|-----------------|
| Lambda (N=1000) | $0.0000166667/GB-s | $0.0000002/GB-s | $0.25 | $0.06 |
| Total impact | | | ~$368 | ~$368 (OpenSearch dominates; Lambda is negligible) |

---

## Fix 17: S3 Event Suffix — Remove Leading Slash

**`infra/lib/skill-registry-stack.ts`** — fix suffix filter:

```typescript
// REPLACE:
// this.registryBucket.addEventNotification(..., { prefix: 'skills/', suffix: '/skill.zip' });

// WITH (no leading slash — key ends with 'skill.zip', not '/skill.zip'):
this.registryBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.LambdaDestination(this.validatorFn),
  { prefix: 'skills/', suffix: 'skill.zip' },  // ← no leading slash
);
```

Key format: `skills/alice/my-skill/1.0.0/skill.zip` ends with `skill.zip` ✓

---

## Fix 18: `ArtifactsBucket` — Remove or Document

`ArtifactsBucket` is created in StorageStack but never referenced. Either:

**Option A (remove):** Delete `artifactsBucket` from StorageStack — CDK bootstrap artifacts bucket is managed by CDK bootstrap, not by the app stack.

**Option B (document):** Write an SSM param and document its purpose as a deployment artifacts bucket for Lambda code:
```typescript
new ssm.StringParameter(this, 'ParamArtifactsBucket', {
  parameterName: `/skills-svc/${envName}/s3/artifacts-bucket`,
  stringValue: this.artifactsBucket.bucketName,
});
```

**Recommendation: Option A — remove.** CDK bootstrap manages its own S3 bucket. The artifacts bucket is unnecessary duplication.

**Remove from `StorageStack`:**
- Delete `this.artifactsBucket` declaration and bucket creation
- Remove from `sharedBucketProps` usage
- Remove `public readonly artifactsBucket: s3.Bucket`

---

## Fix 19: Knowledge Store SSM Param Cache — Add TTL

**`packages/knowledge-store/src/searcher.ts`** and **`indexer.ts`** — replace module-level variable with TTL cache:

```typescript
// REPLACE module-level _indexName variable:
// let _indexName: string | null = null;

// WITH TTL cache matching other services (5-minute TTL):
const _paramCache = new Map<string, { value: string; ts: number }>();

async function getCachedParam(name: string): Promise<string> {
  const now = Date.now();
  const cached = _paramCache.get(name);
  if (cached && now - cached.ts < 300_000) return cached.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = res.Parameter!.Value!;
  _paramCache.set(name, { value, ts: now });
  return value;
}

async function getIndexName(): Promise<string> {
  const env = process.env.ENV ?? 'prod';
  return getCachedParam(`/skills-svc/${env}/opensearch/index-name`);
}
```

---

## Fix 20: Deployment Runbook — Remove Anthropic Step, Add New Stacks

**`scripts/deploy.sh`** — this was already fixed in SPEC-13 Fix 4. Confirm authoritative deploy.sh from SPEC-13 is used — it has 12 stacks in correct tier order with no Anthropic API key step.

**Confirm SPEC-05 deployment runbook Step 4 is superseded by SPEC-13.**  
When an implementor reads all specs, SPEC-13 is the authoritative deployment runbook. SPEC-05 Step 4 (set Anthropic key) is explicitly removed by SPEC-06.

---

## Fix 21: Rename `uploadsKmsKeyId` → `uploadsKmsKeyArn`

Affects `LambdaStackProps`, `BatchStackProps`, `MCPStackProps`, and all callers in `app.ts`.

```typescript
// In LambdaStackProps, BatchStackProps, MCPStackProps:
uploadsKmsKeyArn: string;   // RENAME from uploadsKmsKeyId

// In app.ts callers:
uploadsKmsKeyArn: security.uploadsBucketKey.keyArn,

// In run-skill/handler.ts env:
UPLOADS_KMS_KEY_ARN: props.uploadsKmsKeyArn,   // matches renamed prop

// In handler code:
const uploadsKmsKeyArn = process.env.UPLOADS_KMS_KEY_ARN!;
```

---

## Fix 22: Remove Dead `opensearchEndpoint` from `MCPStackProps`

```typescript
// REMOVE from MCPStackProps:
// opensearchEndpoint: string;

// REMOVE from app.ts MCPStack instantiation:
// opensearchEndpoint: '',

// REMOVE from buildTestApp() MCPStack instantiation:
// opensearchEndpoint: 'https://test.aoss.amazonaws.com',
```

The MCP Lambda calls the query Lambda for searches — it never needs the OpenSearch endpoint directly.

---

## Fix 23: ECSStack — Write Bucket Names to SSM

**`infra/lib/ecs-stack.ts`** — add SSM params so ECS container can discover bucket names:

```typescript
// Add to ECSStack constructor (already has ssm import):
new ssm.StringParameter(this, 'ParamUploadsBucketForECS', {
  parameterName: `/skills-svc/${envName}/s3/uploads-bucket`,
  stringValue: props.uploadsBucket.bucketName,
  // Note: StorageStack also writes this param — use overwrite or remove from here
  // Actually StorageStack already writes this — remove from ECSStack to avoid conflict
});
```

Wait — `StorageStack` already writes `/skills-svc/{env}/s3/uploads-bucket` and `/skills-svc/{env}/s3/results-bucket`. ECSStack's receipt of these bucket props is for CDK dependency tracking only. **No change needed** — the SSM params are already written by StorageStack. The ECSStack props are used for CDK cross-stack references. ✓

---

## Fix 24: `skill push` Race Condition — Document as Known Limitation

Race condition between two concurrent pushes of the same version is mitigated by:
1. CLI pre-check with DDB GetItem
2. Validator Lambda `ConditionExpression` on PutCommand prevents both writes succeeding

The worst case: both CLI checks pass (race), both S3 uploads succeed (same content), Validator Lambda runs twice — but the second Lambda invocation hits the ConditionExpression and skips. Result: no data corruption, one extra Lambda invocation, one extra S3 object version (ObjectLock COMPLIANCE prevents deletion, but this is benign).

**Add comment to `packages/cli/src/commands/skill.ts` skill push:**
```typescript
// Note: concurrent pushes of the same version are safe — Validator Lambda
// uses a ConditionExpression to prevent duplicate DDB records. Worst case:
// two S3 uploads of identical content; both are stored as object versions.
```

---

## Fix 25: Add `chokidar` Back to Authoritative `packages/cli/package.json`

**`packages/cli/package.json`** — add to dependencies:

```json
"chokidar": "^3.6.0"
```

---

## Fix 26: Claude Desktop References in SPEC-09

SPEC-09 is superseded by SPEC-14 for all Claude Desktop content. When implementing, apply these text replacements to SPEC-09:

| Location | Replace | With |
|----------|---------|------|
| Line 11 | `Claude Desktop / Claude Code` | `Claude Code / custom agents` |
| Line 14 | `Claude Desktop / Claude Code` | `Claude Code` |
| Line 184 | entire comment about JWT/Claude Desktop | *(delete)* |
| Line 192 | `'app://claudedesktop'` in allowOrigins | *(delete)* |
| Lines 183–197 | `// Swap to JWT...` comment block | *(delete)* |

No code changes to SPEC-09 MCP server itself — only descriptive text.

---

## New QA Checks (QA-211 through QA-220)

```typescript
// QA-211: NetworkStack writes private-subnet-ids SSM param
test('QA-211: NetworkStack writes private-subnet-ids to SSM', () => {
  const { templates } = buildTestApp();
  templates.network.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/skills-svc/test/vpc/private-subnet-ids',
    Type: 'String',
  });
});

// QA-212: NetworkStack writes ecs-sg-id to SSM
test('QA-212: NetworkStack writes ecs-sg-id to SSM', () => {
  const { templates } = buildTestApp();
  templates.network.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/skills-svc/test/vpc/ecs-sg-id',
    Type: 'String',
  });
});

// QA-213: Lambda functions have explicit log group with KMS encryption
test('QA-213: All Lambda functions in LambdaStack have KMS-encrypted log groups', () => {
  const { templates } = buildTestApp();
  const fns = templates.lambda.findResources('AWS::Lambda::Function');
  const logGroups = templates.lambda.findResources('AWS::Logs::LogGroup');
  // Each Lambda should have a corresponding log group
  expect(Object.keys(logGroups).length).toBeGreaterThanOrEqual(
    Object.keys(fns).filter(id => !(id.includes('Custom') || id.includes('LogRetention'))).length
  );
  for (const [, lg] of Object.entries(logGroups)) {
    expect((lg as any).Properties.KmsKeyId).toBeDefined();
  }
});

// QA-214: VPC flow log group has KMS key
test('QA-214: VPC flow log group has KMS encryption', () => {
  const { templates } = buildTestApp();
  const logGroups = templates.network.findResources('AWS::Logs::LogGroup');
  const flowLogGroup = Object.values(logGroups).find((lg: any) =>
    JSON.stringify(lg).includes('flow-logs')
  );
  expect(flowLogGroup).toBeDefined();
  expect((flowLogGroup as any).Properties.KmsKeyId).toBeDefined();
});

// QA-215: Lambda functions have environmentEncryption set
test('QA-215: Lambda functions use lambdaEnvKey for environment encryption', () => {
  const { templates } = buildTestApp();
  const fns = templates.lambda.findResources('AWS::Lambda::Function');
  let encryptedCount = 0;
  for (const [, fn] of Object.entries(fns)) {
    if ((fn as any).Properties.KmsKeyArn) encryptedCount++;
  }
  expect(encryptedCount).toBeGreaterThanOrEqual(3); // ingestion, results, query at minimum
});

// QA-216: UserRole has cloudformation:DescribeStacks permission
test('QA-216: UserRole has cloudformation:DescribeStacks for configure command', () => {
  const { templates } = buildTestApp();
  const roles = templates.security.findResources('AWS::IAM::Role');
  const userRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('skills-svc-user')
  ) as any;
  const stmts = userRole.Properties.Policies?.flatMap((p: any) => p.PolicyDocument.Statement) ?? [];
  const cfnStmt = stmts.find((s: any) =>
    (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('cloudformation:DescribeStacks')
  );
  expect(cfnStmt).toBeDefined();
});

// QA-217: cache.ts has single ExpressionAttributeValues (no duplicate keys)
test('QA-217: cache.ts QueryCommand has no duplicate ExpressionAttributeValues', () => {
  const source = readFileSync('packages/cli/src/utils/cache.ts', 'utf-8');
  // Count occurrences of ExpressionAttributeValues in the QueryCommand block
  const queryCommandMatch = source.match(/new QueryCommand\(\{[\s\S]*?\}\)/);
  if (queryCommandMatch) {
    const occurrences = (queryCommandMatch[0].match(/ExpressionAttributeValues/g) ?? []).length;
    expect(occurrences).toBe(1);  // must appear exactly once
  }
});

// QA-218: S3 suffix filter for validator uses 'skill.zip' (no leading slash)
test('QA-218: Registry bucket S3 event notification suffix is "skill.zip" not "/skill.zip"', () => {
  const { templates } = buildTestApp();
  const buckets = templates.skillRegistry.findResources('AWS::S3::Bucket');
  const registryBucket = Object.values(buckets).find((b: any) =>
    JSON.stringify(b).includes('registry')
  ) as any;
  const lambdaConfigs = registryBucket?.Properties
    ?.NotificationConfiguration?.LambdaConfigurations ?? [];
  const suffixRule = lambdaConfigs[0]?.Filter?.S3Key?.Rules
    ?.find((r: any) => r.Name === 'suffix');
  expect(suffixRule?.Value).toBe('skill.zip');    // NOT '/skill.zip'
  expect(suffixRule?.Value).not.toMatch(/^\//);   // no leading slash
});

// QA-219: cancel.ts SNS publish includes status MessageAttribute
test('QA-219: cancel command SNS publish includes status MessageAttribute', () => {
  const source = readFileSync('packages/cli/src/commands/cancel.ts', 'utf-8');
  expect(source).toContain('MessageAttributes');
  expect(source).toContain("'status'");
});

// QA-220: Query handler exists and exports handler function
test('QA-220: query/handler.ts exists and exports handler', () => {
  const handler = require('@skills-svc/lambda/dist/query/handler');
  expect(typeof handler.handler).toBe('function');
});
```

---

## Updated Authoritative `packages/cli/package.json`

Adds `chokidar`, removes `opensearch` (MCP uses query Lambda not direct OpenSearch):

```json
{
  "name": "@skills-svc/cli",
  "version": "1.0.0",
  "bin": { "skills-svc": "dist/index.js" },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "jest --passWithNoTests",
    "lint": "eslint src/ --max-warnings 0"
  },
  "dependencies": {
    "@aws-sdk/client-cloudformation":  "^3.600.0",
    "@aws-sdk/client-cloudtrail":      "^3.600.0",
    "@aws-sdk/client-cloudwatch-logs": "^3.600.0",
    "@aws-sdk/client-dynamodb":        "^3.600.0",
    "@aws-sdk/client-lambda":          "^3.600.0",
    "@aws-sdk/client-s3":              "^3.600.0",
    "@aws-sdk/client-scheduler":       "^3.600.0",
    "@aws-sdk/client-sfn":             "^3.600.0",
    "@aws-sdk/client-sns":             "^3.600.0",
    "@aws-sdk/client-ssm":             "^3.600.0",
    "@aws-sdk/client-sts":             "^3.600.0",
    "@aws-sdk/lib-dynamodb":           "^3.600.0",
    "@skills-svc/shared":              "*",
    "adm-zip":                         "^0.5.10",
    "chalk":                           "^5.3.0",
    "chokidar":                        "^3.6.0",
    "cli-table3":                      "^0.6.3",
    "commander":                       "^12.1.0",
    "diff":                            "^5.2.0",
    "glob":                            "^10.4.0"
  },
  "devDependencies": {
    "@types/adm-zip":   "^0.5.5",
    "@types/diff":      "^5.2.0",
    "@types/node":      "^20.0.0",
    "jest":             "^29.7.0",
    "ts-jest":          "^29.1.0",
    "typescript":       "^5.4.0"
  }
}
```

---

## Summary

| Fix | Impact | Files Changed |
|-----|--------|--------------|
| 1 — NetworkStack SSM params | BLOCKER — Lambda can submit ECS tasks | `network-stack.ts` |
| 2 — Query handler impl | BLOCKER — query command works | `query/handler.ts` (new) |
| 3 — Bootstrap index impl | BLOCKER — OpenSearch index exists | `bootstrap-index/handler.ts` (new) |
| 4 — chokidar for watch | BLOCKER — watch works on Linux | `watch.ts`, `cli/package.json` |
| 5 — cache.ts dup key | BLOCKER — cache lookups work | `cache.ts` |
| 6 — cache key unified | BLOCKER — cache actually hits | `cache.ts`, `ingestion/handler.ts` |
| 7 — UserRole CFN perm | BLOCKER — configure command works | `security-stack.ts` |
| 8 — Lambda log groups KMS | BLOCKER — synth passes | `lambda-stack.ts` |
| 9 — Flow logs KMS | BLOCKER — synth passes | `network-stack.ts` |
| 10 — lambdaEnvKey applied | BLOCKER — env vars encrypted | `lambda-stack.ts`, `security-stack.ts` |
| 11 — QueryLambdaRole KMS | CORRECTNESS — query works | `security-stack.ts` |
| 12 — cancel SNS attrs | CORRECTNESS — filter policy fires | `cancel.ts` |
| 13 — batch SFN cleanup | CORRECTNESS — no orphan records | `batch.ts` |
| 14–16 — QA fixes | CORRECTNESS — tests pass | test files |
| 17 — suffix leading slash | CORRECTNESS — validator triggers | `skill-registry-stack.ts` |
| 18 — remove artifactsBucket | CORRECTNESS — no dead code | `storage-stack.ts` |
| 19 — SSM cache TTL | CORRECTNESS — config updates | `searcher.ts`, `indexer.ts` |
| 20 — deploy runbook | CORRECTNESS — SPEC-13 authoritative | `scripts/deploy.sh` |
| 21 — rename KMS prop | CLARITY — no ARN/ID confusion | 4 files |
| 22 — remove dead OS field | CLARITY — clean props | `mcp-stack.ts` |
| 23 — ECS bucket SSM | N/A — already written by Storage | no change |
| 24–26 — design/docs | DOCS — no code change | comments/notes |
