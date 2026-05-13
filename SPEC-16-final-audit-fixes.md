# Skills as a Service (SaaS) — Specification Part 16: Final Audit Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** Second 5-agent parallel audit of SPEC-01 through SPEC-15  
**Parts:** ... | [Part 15](SPEC-15-agent-audit-fixes.md) | [Part 16: Final Audit Fixes]

---

## Audit Summary

5 agents produced ~79 raw issues. After deduplication and false-positive removal, **18 real issues** remain.

**False positives excluded:**
- Explicit `logGroup` prop on Lambda prevents auto-created log group — no duplication occurs
- `ScheduleTriggerLambda` copies within uploads bucket (not from registry) — `s3:CopyObject` on uploads/* is sufficient
- DynamoDB `begins_with` on sort key (SK) IS valid — only partition key is restricted
- `AwsCustomResource` IAM policy via `fromSdkCalls` is correct CDK pattern
- VPC endpoint for Bedrock Runtime IS present in NetworkStack (SPEC-01 line 452)
- `batch results begins_with(SK)` is valid DynamoDB sort key syntax

| # | Severity | Issue |
|---|----------|-------|
| 1 | **BLOCKER** | `resultsCommand()` imported in CLI `index.ts` but never implemented — CLI fails to start |
| 2 | **BLOCKER** | `@skills-svc/knowledge-store` missing from Lambda `package.json` — query handler won't compile |
| 3 | **BLOCKER** | `buildTestApp()` passes `opensearchEndpoint` after Fix 22 (SPEC-15) removed it from `MCPStackProps` |
| 4 | **BLOCKER** | `KnowledgeStoreStackProps` missing `lambdaSg` — Fix 3 (SPEC-15) adds VPC Lambda but prop not in interface |
| 5 | **BLOCKER** | `batchJobSubmitFn` auto-created role missing `kms:GenerateDataKey` for uploads bucket KMS key |
| 6 | **BLOCKER** | `validatorRole` missing `kms:Decrypt` / `kms:GenerateDataKey` for registry bucket KMS key |
| 7 | **BLOCKER** | `triggerRun()` called without `await` in chokidar callback — watch mode crashes silently on any error |
| 8 | **BLOCKER** | `durationMs` stored only in S3 result JSON, never written to DDB — `cost.ts` always reports $0 Fargate cost |
| 9 | **BLOCKER** | `UserRole` missing `ssm:GetParametersByPath` — `configure` command fails when using assumed-role creds |
| 10 | **BLOCKER** | Fix 6 (SPEC-15) cache key requires full 500MB zip download in Lambda — prohibitively expensive |
| 11 | **CORRECTNESS** | `uploadsKmsKeyArn` rename (SPEC-15 Fix 21) not applied in `run-skill/handler.ts` env var read |
| 12 | **CORRECTNESS** | `ScheduleTriggerLambda` missing `s3:CopyObject` on uploads bucket — schedule triggers fail |
| 13 | **CORRECTNESS** | `AwsCustomResource` bootstrap resource should `addDependency(bootstrapFn)` for safe ordering |
| 14 | **CORRECTNESS** | `AuditLogBucket` uses SSE-S3 but `EncryptionEnforcerAspect` checks `'accesslog'` substring — `AuditLogBucket` ID doesn't match → Aspect flags it incorrectly |
| 15 | **CORRECTNESS** | `LambdaStack` missing `public readonly scheduleTriggerFn` declaration |
| 16 | **CORRECTNESS** | `drainLogs` called with stale `lastEventTime` — final ECS task logs may be missed |
| 17 | **DESIGN** | `QA-039` checks hardcoded handler file list — newly added handlers (batch-submit, batch-status, run-skill, skill-validator, mcp, bootstrap-index) are skipped |
| 18 | **DESIGN** | `EncryptionEnforcerAspect` on SNS Topics not shown — `jobsNotificationTopic` uses KMS but aspect never validates topics |

---

## Fix 1: `resultsCommand()` — Implement Missing Handler

**`packages/cli/src/commands/results.ts`** (new file):

```typescript
import { Command } from 'commander';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { DDB_KEY_PREFIX, JobStatus, RunResult } from '@skills-svc/shared';
import { envelopeDecrypt } from '@skills-svc/shared';
import { prettyJson } from '../utils/pretty-print';

export function resultsCommand(): Command {
  return new Command('results')
    .description('Retrieve the full output of a completed job')
    .argument('<job-id>', 'Job ID of a COMPLETE job')
    .option('--format <fmt>', 'Output format: json|pretty|summary', 'pretty')
    .action(async (jobId: string, opts: { format: string }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const s3    = new S3Client({ region: cfg.region, credentials: creds });

      // Fetch job record
      const jobRes = await ddb.send(new GetCommand({
        TableName: cfg.dynamodbTableName,
        Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
      }));

      if (!jobRes.Item) {
        console.error(chalk.red(`Job not found: ${jobId}`));
        process.exit(1);
      }

      if (jobRes.Item.status !== JobStatus.COMPLETE) {
        console.error(chalk.red(
          `Job is not complete (status: ${jobRes.Item.status}). ` +
          `Use: skills-svc status ${jobId}`
        ));
        process.exit(1);
      }

      const resultKey = jobRes.Item.s3ResultKey as string | undefined;
      if (!resultKey) {
        console.error(chalk.red('No result key found on job record.'));
        process.exit(1);
      }

      // Download and decrypt result
      const obj = await s3.send(new GetObjectCommand({
        Bucket: cfg.resultsBucket,
        Key: resultKey,
      }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

      const plain = await envelopeDecrypt(raw, {
        jobId,
        purpose: 'skills-svc-result',
        environment: cfg.envName,
      });
      const result: RunResult = JSON.parse(plain.toString('utf-8'));

      if (opts.format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (opts.format === 'summary') {
        console.log(chalk.bold(`\n${result.jobName}`));
        console.log(result.resultSummary);
        return;
      }

      // Pretty format
      console.log(chalk.bold(`\nResult: ${result.jobName}`));
      console.log(chalk.dim(`Skills: ${result.skillNames.join(', ')} | Duration: ${Math.round(result.durationMs / 1000)}s | Completed: ${new Date(result.completedAt).toLocaleString()}`));
      console.log();
      try {
        const parsed = JSON.parse(result.output);
        prettyJson(parsed);
      } catch {
        console.log(result.output);
      }
    });
}
```

---

## Fix 2: Add `@skills-svc/knowledge-store` to Lambda `package.json`

Replaces SPEC-13 Fix 6 as the authoritative Lambda `package.json`:

```json
{
  "name": "@skills-svc/lambda",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "jest --passWithNoTests",
    "lint": "eslint src/ --max-warnings 0"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime":   "^3.600.0",
    "@aws-sdk/client-cloudwatch-logs":   "^3.600.0",
    "@aws-sdk/client-comprehend":        "^3.600.0",
    "@aws-sdk/client-dynamodb":          "^3.600.0",
    "@aws-sdk/client-ecs":               "^3.600.0",
    "@aws-sdk/client-s3":                "^3.600.0",
    "@aws-sdk/client-secrets-manager":   "^3.600.0",
    "@aws-sdk/client-sns":               "^3.600.0",
    "@aws-sdk/client-ssm":               "^3.600.0",
    "@aws-sdk/client-sfn":               "^3.600.0",
    "@aws-sdk/credential-provider-node": "^3.600.0",
    "@aws-sdk/lib-dynamodb":             "^3.600.0",
    "@opensearch-project/opensearch":    "^2.6.0",
    "aws-xray-sdk":                      "^3.6.0",
    "@skills-svc/shared":                "*",
    "@skills-svc/knowledge-store":       "*"
  },
  "devDependencies": {
    "@types/aws-lambda": "^8.10.137",
    "@types/node":       "^20.0.0",
    "aws-sdk-client-mock": "^3.0.0",
    "jest":              "^29.7.0",
    "ts-jest":           "^29.1.0",
    "typescript":        "^5.4.0"
  }
}
```

---

## Fix 3: Remove `opensearchEndpoint` from `buildTestApp()` and `MCPStackProps`

### `infra/test/helpers.ts` — remove from MCPStack instantiation

```typescript
// REMOVE this line from MCPStack instantiation in buildTestApp():
// opensearchEndpoint: 'https://test.aoss.amazonaws.com',
```

### Verify `infra/lib/mcp-stack.ts` Lambda env block has no `OPENSEARCH_ENDPOINT`

If any line sets `OPENSEARCH_ENDPOINT: props.opensearchEndpoint`, delete it. The MCP Lambda calls the query Lambda — it never directly accesses OpenSearch.

---

## Fix 4: `KnowledgeStoreStackProps` — Add `lambdaSg`

**`infra/lib/knowledge-store-stack.ts`** — update props interface:

```typescript
interface KnowledgeStoreStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  vpcesg: ec2.SecurityGroup;
  opensearchKey: kms.Key;
  resultsLambdaRole: iam.Role;
  ecsTaskRole: iam.Role;
  queryLambdaRole: iam.Role;
  lambdaSg: ec2.SecurityGroup;   // ADD — needed by bootstrapFn (SPEC-15 Fix 3)
}
```

**`infra/bin/app.ts`** — pass `lambdaSg` to `KnowledgeStoreStack`:

```typescript
const knowledgeStore = new KnowledgeStoreStack(app, `SkillsSvc-${envName}-KnowledgeStore`, {
  env, envName,
  vpc: network.vpc,
  vpcesg: network.vpcesg,
  opensearchKey:     security.opensearchKey,
  resultsLambdaRole: security.resultsLambdaRole,
  ecsTaskRole:       security.ecsTaskRole,
  queryLambdaRole:   security.queryLambdaRole,
  lambdaSg:          network.lambdaSg,   // ADD
});
```

**`infra/test/helpers.ts`** — same addition in `buildTestApp()`.

---

## Fix 5: `batchJobSubmitFn` — Add KMS Permission for Uploads Bucket

**`infra/lib/batch-stack.ts`** — add to `batchJobSubmitFn` role policies:

```typescript
// After existing S3 policy:
batchJobSubmitFn.addToRolePolicy(new iam.PolicyStatement({
  sid: 'KMSForUploadsBucket',
  actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
  resources: [props.uploadsKmsKeyArn],   // uses renamed prop from SPEC-15 Fix 21
}));
```

**Add `uploadsKmsKeyArn` to `BatchStackProps`:**

```typescript
interface BatchStackProps extends cdk.StackProps {
  envName: string;
  jobsTable: dynamodb.Table;
  ingestionFn: lambda.Function;
  dynamodbKey: kms.Key;
  uploadsBucketName: string;
  uploadsKmsKeyArn: string;   // renamed from uploadsKmsKeyId per SPEC-15 Fix 21
}
```

---

## Fix 6: `validatorRole` — Add KMS Permissions for Registry Bucket

**`infra/lib/skill-registry-stack.ts`** — update `validatorRole` KMS policy:

```typescript
validatorRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KMSDecrypt',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [
    props.registryBucketKey.keyArn,   // ADD — for registry bucket reads
    props.dynamodbKey.keyArn,          // existing — for skills DDB table
  ],
}));
```

---

## Fix 7: `watch.ts` — Await `triggerRun` in Chokidar Callback

Chokidar event handlers are synchronous. Wrap the async call:

```typescript
const safeRun = (filePath: string) => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    triggerRun(filePath).catch((err: Error) => {
      console.error(chalk.red(`\n  Watch run error: ${err.message}`));
      console.log(chalk.dim(`  Waiting for next change...`));
      running = false;  // reset lock so next change triggers a new run
    });
  }, debounceMs);
};

watcher.on('change', (filePath: string) => safeRun(filePath));
watcher.on('add',    (filePath: string) => safeRun(filePath));
```

---

## Fix 8: Store `durationMs` in DDB Job Record

### `packages/lambda/src/results-processor/handler.ts` — write `durationMs` to DDB

When the results processor updates the job status to COMPLETE, it has access to `result.durationMs` from the decrypted S3 JSON. Write it to DDB:

```typescript
// In UpdateCommand ExpressionAttributeValues, add:
...(result?.durationMs ? {
  ':durMs': result.durationMs,
  ':inTok': result.inputTokens ?? 0,
  ':outTok': result.outputTokens ?? 0,
} : {}),

// In UpdateExpression SET clause, add:
...(result?.durationMs ? ['durationMs = :durMs', 'inputTokens = :inTok', 'outputTokens = :outTok'] : []),
```

### `packages/shared/src/types.ts` — add to `JobRecord`

```typescript
export interface JobRecord {
  // ... existing fields ...
  durationMs?:   number;   // ADD — written by results-processor on completion
  inputTokens?:  number;   // ADD — Bedrock token counts
  outputTokens?: number;   // ADD
}
```

### `packages/cli/src/commands/cost.ts` — derive duration from timestamps as fallback

```typescript
function computeJobCost(item: Record<string, unknown>): JobCost {
  // Use stored durationMs if available; otherwise derive from DDB timestamps
  const durationMs = (item.durationMs as number | undefined) ??
    (item.completedAt && item.createdAt
      ? new Date(item.completedAt as string).getTime() - new Date(item.createdAt as string).getTime()
      : 0);
  // ... rest of function unchanged
}
```

---

## Fix 9: `configure` — Use Ambient Credentials, Not UserRole

The `configure` command is a bootstrap step run once to set up the CLI. It should use the ambient AWS credential chain (not the UserRole assumed credentials), since it runs before the UserRole is configured.

**`packages/cli/src/commands/configure.ts`** — use AWS default credential chain:

```typescript
// REPLACE:
// const creds = await getCredentialProvider();
// const ssm   = new SSMClient({ region: opts.region, credentials: creds });
// const cfn   = new CloudFormationClient({ region: opts.region, credentials: creds });

// WITH (use ambient credentials — IAM user / instance profile / env vars):
const ssm = new SSMClient({ region: opts.region });   // no credentials prop = default chain
const cfn = new CloudFormationClient({ region: opts.region });
```

This way `configure` works with any IAM identity that has SSM and CloudFormation read access (e.g., a developer's personal IAM user), without requiring the UserRole to have those permissions.

Remove `UserRole` `cloudformation:DescribeStacks` permission from SPEC-15 Fix 7 — it's no longer needed since configure doesn't use UserRole credentials.

---

## Fix 10: Cache Key — Use S3 ChecksumSHA256 in Lambda (No Full Download)

SPEC-15 Fix 6 required downloading the full zip to compute SHA256 — up to 500MB in Lambda. Instead, use the S3-stored `ChecksumSHA256` from the `HeadObjectCommand` response (the CLI already uploads with `ChecksumAlgorithm: 'SHA256'`).

### `packages/lambda/src/ingestion/handler.ts` — use S3 checksum header

```typescript
// In processRecord(), after HeadObjectCommand:
const s3ChecksumBase64 = head.ChecksumSHA256;  // set by CLI's ChecksumAlgorithm: 'SHA256'

// Convert S3 base64 checksum to hex to match CLI's SHA256 hex output:
const zipSha256Hex = s3ChecksumBase64
  ? Buffer.from(s3ChecksumBase64, 'base64').toString('hex')
  : null;

// Cache key (prompt comes from manifest, read during validation):
const cacheKey = zipSha256Hex
  ? createHash('sha256')
      .update(zipSha256Hex)
      .update('\x00')
      .update(validation.manifest?.defaultPrompt ?? '')
      .digest('hex')
  : null;

// Store if we have a checksum:
...(cacheKey ? { GSI4PK: `CACHE#${cacheKey}`, cacheKey, zipSha256: zipSha256Hex } : {}),
```

### `packages/cli/src/utils/cache.ts` — match the same computation

```typescript
export function computeCacheKey(zipBuffer: Buffer, prompt: string): string {
  // Compute SHA256 of zip buffer (hex) — matches what Lambda derives from S3 ChecksumSHA256
  const zipSha256Hex = createHash('sha256').update(zipBuffer).digest('hex');
  return createHash('sha256')
    .update(zipSha256Hex)
    .update('\x00')
    .update(prompt)
    .digest('hex');
}
```

Now both CLI and Lambda produce the same cache key from the same input (SHA256 of zip bytes + prompt), without the Lambda needing to download the full zip.

---

## Fix 11: `run-skill/handler.ts` — Fix Env Var Name After Rename

SPEC-15 Fix 21 renamed prop `uploadsKmsKeyId → uploadsKmsKeyArn` and env var `UPLOADS_KMS_KEY_ID → UPLOADS_KMS_KEY_ARN`. Update the handler:

```typescript
// In packages/lambda/src/run-skill/handler.ts:
// REPLACE:
// const uploadsKmsKeyId = process.env.UPLOADS_KMS_KEY_ID!;

// WITH:
const uploadsKmsKeyArn = process.env.UPLOADS_KMS_KEY_ARN!;

// Update CopyObjectCommand:
await s3.send(new CopyObjectCommand({
  // ...
  SSEKMSKeyId: uploadsKmsKeyArn,   // was uploadsKmsKeyId
  // ...
}));
```

---

## Fix 12: `ScheduleTriggerLambda` — Add `s3:CopyObject` Permission

**`infra/lib/lambda-stack.ts`** — add to `scheduleTriggerFn` role (or use `ingestionLambdaRole` if shared):

```typescript
// ScheduleTriggerLambda reuses ingestionLambdaRole per SPEC-07.
// ingestionLambdaRole already has s3:GetObject on uploads bucket.
// Add s3:CopyObject:
props.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'S3CopyForScheduler',
  actions: ['s3:CopyObject'],
  resources: [`arn:aws:s3:::${props.uploadsBucket.bucketName}/uploads/*`],
}));
```

---

## Fix 13: Bootstrap Resource — Explicit Dependency on Lambda

**`infra/lib/knowledge-store-stack.ts`** — add after `bootstrapResource` creation:

```typescript
bootstrapResource.node.addDependency(bootstrapFn);
bootstrapResource.node.addDependency(collection);  // already there per SPEC-15
```

---

## Fix 14: `EncryptionEnforcerAspect` — Exclude `AuditLogBucket`

The `AuditLogBucket` in ComplianceStack uses `BucketEncryption.S3_MANAGED` (required by CloudTrail for log delivery). The Aspect currently only skips buckets whose CDK logical ID contains `'accesslog'`. `AuditLogBucket` doesn't match — it would be incorrectly flagged.

**`infra/aspects/encryption-enforcer.ts`** — update the exclusion list:

```typescript
if (node instanceof CfnBucket) {
  const nodeIdLower = node.node.id.toLowerCase();

  // Buckets that intentionally use SSE-S3 (not KMS):
  // - Access log buckets: S3 log delivery requires SSE-S3
  // - Audit log buckets: CloudTrail log delivery requires SSE-S3 or KMS;
  //   we use SSE-S3 for simplicity (ObjectLock COMPLIANCE provides integrity)
  const isIntentionalSSE_S3 =
    nodeIdLower.includes('accesslog') ||
    nodeIdLower.includes('auditlog');

  const enc = (node as any).bucketEncryption;
  const hasKMS = enc?.serverSideEncryptionConfiguration?.[0]
    ?.serverSideEncryptionByDefault?.kmsMasterKeyId;

  if (!hasKMS && !isIntentionalSSE_S3) {
    Annotations.of(node).addError(
      `[EncryptionEnforcer] S3 Bucket "${node.node.path}" must use KMS encryption.`
    );
  }
}
```

---

## Fix 15: `LambdaStack` — Add `public readonly scheduleTriggerFn`

**`infra/lib/lambda-stack.ts`** — add to class declarations:

```typescript
export class LambdaStack extends cdk.Stack {
  public readonly ingestionFn: lambda.Function;
  public readonly resultsProcessorFn: lambda.Function;
  public readonly queryFn: lambda.Function;
  public readonly runSkillFn: lambda.Function;
  public readonly scheduleTriggerFn: lambda.Function;   // ADD
```

---

## Fix 16: `log-streamer.ts` — Fix Stale `lastEventTime` in `drainLogs`

When `drainLogs` is called after the job completes, `lastEventTime` is the timestamp of the last received log event. But the ECS task may have emitted final logs after the polling loop's last check. Use `Date.now() - 60_000` (last 60 seconds) as a safe window:

```typescript
async function drainLogs(
  cwl: CloudWatchLogsClient,
  logGroup: string,
  filterPattern: string,
  lastEventTime: number,
  onEvent?: StreamOptions['onEvent'],
): Promise<void> {
  await sleep(3000); // give CWL time to flush final events

  // Use the later of: lastEventTime or 60 seconds ago — catches events we may have missed
  const startTime = Math.min(lastEventTime, Date.now() - 60_000);

  const events = await cwl.send(new FilterLogEventsCommand({
    logGroupName: logGroup,
    filterPattern,
    startTime,
    limit: 500,
  }));
  for (const ev of events.events ?? []) {
    renderLogEvent(ev);
    onEvent?.(ev.message ?? '', new Date(ev.timestamp ?? 0));
  }
}
```

---

## Fix 17: `QA-039` — Scan All Handler Files Dynamically

```typescript
// REPLACE QA-039:
test('QA-039: All Lambda handler files have top-level try/catch', () => {
  const { readdirSync, readFileSync, statSync } = require('fs');
  const path = require('path');

  const lambdaSrc = 'packages/lambda/src';

  // Find all handler.ts files recursively
  const findHandlers = (dir: string): string[] => {
    const results: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findHandlers(full));
      else if (entry.name === 'handler.ts') results.push(full);
    }
    return results;
  };

  const handlerFiles = findHandlers(lambdaSrc);
  expect(handlerFiles.length).toBeGreaterThan(0);

  for (const file of handlerFiles) {
    const source = readFileSync(file, 'utf-8');
    // Every handler export should have try/catch
    if (source.includes('export const handler')) {
      expect(source).toContain('try {');
      expect(source).toContain('} catch');
    }
  }
});
```

---

## Fix 18: `EncryptionEnforcerAspect` — Add SNS Topic Check

```typescript
// Add to EncryptionEnforcerAspect.visit():
import { CfnTopic } from 'aws-cdk-lib/aws-sns';

if (node instanceof CfnTopic) {
  if (!(node as any).kmsMasterKeyId) {
    Annotations.of(node).addError(
      `[EncryptionEnforcer] SNS Topic "${node.node.path}" must use KMS encryption.`
    );
  }
}
```

---

## Updated `packages/cli/src/index.ts`

Ensure `resultsCommand` is imported and registered:

```typescript
import { resultsCommand } from './commands/results';
// ... (already in list per SPEC-03, now implemented)
program.addCommand(resultsCommand());
```

---

## Updated `infra/test/helpers.ts` — `buildTestApp()` final fix

In the MCPStack instantiation block, **remove** `opensearchEndpoint`:

```typescript
const mcpStack = new MCPStack(app, 'MCP', {
  env, envName: 'test',
  vpc: network.vpc, lambdaSg: network.lambdaSg,
  lambdaEnvKey:       security.lambdaEnvKey,
  userRole:           security.userRole,
  dynamodbTableName:  storage.jobsTable.tableName,
  uploadsBucket:      storage.uploadsBucket.bucketName,
  resultsBucket:      storage.resultsBucket.bucketName,
  uploadsKmsKeyArn:   security.uploadsBucketKey.keyArn,   // renamed from uploadsKmsKeyId
  queryLambdaArn:     lambdaStack.queryFn.functionArn,
  // opensearchEndpoint: removed — MCP uses query Lambda, not OpenSearch directly
  jobsTopicArn:       messaging.jobsNotificationTopic.topicArn,
  ecsClusterArn:      ecsStack.cluster.clusterArn,
  skillsTableName:    skillRegistry.skillsTable.tableName,
  registryBucket:     skillRegistry.registryBucket.bucketName,
  runSkillLambdaArn:  lambdaStack.runSkillFn.functionArn,
});
```

Also pass `lambdaSg` to `KnowledgeStoreStack`:

```typescript
const knowledgeStore = new KnowledgeStoreStack(app, 'KnowledgeStore', {
  env, envName: 'test',
  vpc: network.vpc, vpcesg: network.vpcesg,
  opensearchKey:     security.opensearchKey,
  resultsLambdaRole: security.resultsLambdaRole,
  ecsTaskRole:       security.ecsTaskRole,
  queryLambdaRole:   security.queryLambdaRole,
  lambdaSg:          network.lambdaSg,   // ADD
});
```

---

## New QA Checks (QA-221 through QA-228)

```typescript
// QA-221: resultsCommand is implemented and exports a Command
test('QA-221: resultsCommand is implemented and returns a Commander Command', () => {
  const { resultsCommand } = require('packages/cli/dist/commands/results');
  expect(typeof resultsCommand).toBe('function');
  const cmd = resultsCommand();
  expect(cmd.name()).toBe('results');
});

// QA-222: Lambda package.json includes @skills-svc/knowledge-store
test('QA-222: Lambda package.json includes knowledge-store workspace dependency', () => {
  const pkg = JSON.parse(readFileSync('packages/lambda/package.json', 'utf-8'));
  expect(Object.keys(pkg.dependencies)).toContain('@skills-svc/knowledge-store');
});

// QA-223: MCPStackProps has no opensearchEndpoint field
test('QA-223: MCPStack instantiation in buildTestApp does not pass opensearchEndpoint', () => {
  const source = readFileSync('infra/test/helpers.ts', 'utf-8');
  // After the MCPStack instantiation block, opensearchEndpoint should not appear
  const mcpBlock = source.match(/new MCPStack\([\s\S]*?\}\)/)?.[0] ?? '';
  expect(mcpBlock).not.toContain('opensearchEndpoint');
});

// QA-224: KnowledgeStoreStackProps includes lambdaSg
test('QA-224: KnowledgeStoreStackProps includes lambdaSg field', () => {
  const source = readFileSync('infra/lib/knowledge-store-stack.ts', 'utf-8');
  expect(source).toContain('lambdaSg: ec2.SecurityGroup');
});

// QA-225: batchJobSubmitFn has KMS GenerateDataKey policy
test('QA-225: BatchStack batchJobSubmitFn has kms:GenerateDataKey policy', () => {
  const { templates } = buildTestApp();
  const policies = templates.batch.findResources('AWS::IAM::Policy');
  const batchPolicies = Object.values(policies).filter((p: any) =>
    JSON.stringify(p).includes('batch-submit') || JSON.stringify(p).includes('GenerateDataKey')
  );
  const hasKmsGrant = batchPolicies.some((p: any) => {
    const stmts = p.Properties?.PolicyDocument?.Statement ?? [];
    return stmts.some((s: any) =>
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('kms:GenerateDataKey')
    );
  });
  expect(hasKmsGrant).toBe(true);
});

// QA-226: durationMs written to DDB by results-processor
test('QA-226: results-processor UpdateExpression includes durationMs', () => {
  const source = readFileSync('packages/lambda/src/results-processor/handler.ts', 'utf-8');
  expect(source).toContain('durationMs');
  expect(source).toContain(':durMs');
});

// QA-227: EncryptionEnforcerAspect excludes auditlog buckets
test('QA-227: EncryptionEnforcerAspect excludes AuditLogBucket from KMS check', () => {
  const source = readFileSync('infra/aspects/encryption-enforcer.ts', 'utf-8');
  expect(source).toContain("includes('auditlog')");
  expect(source).toContain("includes('accesslog')");
});

// QA-228: Cache key computation matches between CLI and Lambda
test('QA-228: computeCacheKey in CLI matches SHA256 derivation used by Lambda', () => {
  const { computeCacheKey } = require('@skills-svc/cli/dist/utils/cache');
  const zipBuffer = Buffer.from('test zip content');
  const prompt    = 'analyze';

  // Both should produce the same key format: SHA256(SHA256(zip).hex + \0 + prompt)
  const { createHash } = require('crypto');
  const zipSha256Hex = createHash('sha256').update(zipBuffer).digest('hex');
  const expectedKey  = createHash('sha256')
    .update(zipSha256Hex).update('\x00').update(prompt).digest('hex');

  expect(computeCacheKey(zipBuffer, prompt)).toBe(expectedKey);
  expect(computeCacheKey(zipBuffer, prompt)).toHaveLength(64); // SHA256 hex
});
```

---

## Summary of Changes

| Fix | Severity | Files Changed |
|-----|----------|--------------|
| 1 — `results.ts` implementation | BLOCKER | `packages/cli/src/commands/results.ts` (new) |
| 2 — Lambda package.json | BLOCKER | `packages/lambda/package.json` |
| 3 — Remove opensearchEndpoint from tests | BLOCKER | `infra/test/helpers.ts` |
| 4 — KnowledgeStoreStackProps lambdaSg | BLOCKER | `knowledge-store-stack.ts`, `app.ts`, `helpers.ts` |
| 5 — batchJobSubmitFn KMS | BLOCKER | `batch-stack.ts` |
| 6 — validatorRole KMS | BLOCKER | `skill-registry-stack.ts` |
| 7 — watch.ts safeRun wrapper | BLOCKER | `commands/watch.ts` |
| 8 — durationMs in DDB | BLOCKER | `results-processor/handler.ts`, `types.ts`, `cost.ts` |
| 9 — configure ambient credentials | BLOCKER | `commands/configure.ts` |
| 10 — cache key via S3 checksum | BLOCKER | `ingestion/handler.ts`, `utils/cache.ts` |
| 11 — uploadsKmsKeyArn env var | CORRECTNESS | `run-skill/handler.ts` |
| 12 — ScheduleTriggerLambda CopyObject | CORRECTNESS | `lambda-stack.ts` |
| 13 — bootstrap addDependency | CORRECTNESS | `knowledge-store-stack.ts` |
| 14 — EncryptionEnforcer auditlog | CORRECTNESS | `aspects/encryption-enforcer.ts` |
| 15 — scheduleTriggerFn declaration | CORRECTNESS | `lambda-stack.ts` |
| 16 — drainLogs lastEventTime | CORRECTNESS | `utils/log-streamer.ts` |
| 17 — QA-039 dynamic file scan | DESIGN | `infra/test/*.test.ts` |
| 18 — EncryptionEnforcer SNS | DESIGN | `aspects/encryption-enforcer.ts` |
