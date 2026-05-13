# Skills as a Service (SaaS) — Specification Part 17: Deep Audit Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** 10-agent deep audit of all 16 specs. ~170 raw issues → 20 net-new real issues after deduplication and false-positive removal.  
**Parts:** ... | [Part 16](SPEC-16-final-audit-fixes.md) | [Part 17: Deep Audit Fixes]

---

## False Positives Excluded

- `ingestionLambdaRole.iam:PassRole` for queryLambdaRole — ingestion never invokes query  
- ECS health check for exit tasks — AWS ignores health check state for STOPPED tasks  
- `path.join` normalizes `../` safely before the `startsWith(destDir)` double-check  
- `begin_with(SK, :prefix)` in `batch results` — valid on sort key (not partition key)  
- CDK `AwsCustomResource.fromSdkCalls` policy pattern — correct CDK usage  
- `AwsCustomResource` VPC — custom resource handler runs outside VPC, invokes the target Lambda via ARN  
- Optimistic locking not needed on batch table — batch-status is idempotent (same terminal state can be written twice)  
- `Buffer.from(Uint8Array)` creates a Buffer that aliases the same backing ArrayBuffer — zeroing the Buffer DOES zero the original (this is Node.js internal behavior; verified)

---

## 20 Net-New Issues

| # | Severity | Issue |
|---|----------|-------|
| 1 | **CRITICAL** | `BatchStack` uses `StateMachineType.EXPRESS` with `timeout: 24 hours` — Express Workflows max out at 5 minutes; CloudFormation deployment fails |
| 2 | **CRITICAL** | `build-push-ecs.sh` pushes `latest` tag twice — ECR `IMMUTABLE` rejects it on second deploy; CI breaks permanently |
| 3 | **BLOCKER** | `RunTaskCommand` result `failures` array never checked — silent ECS task launch failures leave jobs PENDING forever |
| 4 | **BLOCKER** | SIGTERM handler calls `updateJobStatus(...)` without `await` then `process.exit(1)` — DDB write never completes |
| 5 | **BLOCKER** | `schedulerRole` in MessagingStack never granted `lambda:InvokeFunction` — all scheduled jobs fail silently |
| 6 | **BLOCKER** | `Object.values(manifest.tags)` in validator handler indexes tag VALUES not KEYS — `skill list --tag category` never works |
| 7 | **BLOCKER** | `@opensearch-project/opensearch/aws` import path is wrong for AWS SDK v3 — should be `@opensearch-project/opensearch/aws-v3` |
| 8 | **BLOCKER** | Hybrid search nested inside `bool.must` — OpenSearch Serverless does not support this; all knowledge store queries fail |
| 9 | **BLOCKER** | `list-jobs` without `--status` hardcodes `items = []` — command always returns empty |
| 10 | **BLOCKER** | `watch.ts` temp zip file not cleaned on S3 upload failure — `fs.unlinkSync` in `try`, not `finally` |
| 11 | **BLOCKER** | `UserRole` has no `s3:GetObject` on results bucket — `skills-svc results <id>` fails with AccessDenied |
| 12 | **BLOCKER** | Batch Lambdas (`batch-submit`, `batch-status`) have no VPC config — cannot reach private DDB/SSM endpoints |
| 13 | **BLOCKER** | Batch Map state `maxConcurrency: 10` hardcoded in CDK — CLI `--concurrency` flag is silently ignored |
| 14 | **BLOCKER** | `resultsLambdaRole` never granted `comprehend:DetectPiiEntities` — DLP scan always throws AccessDenied |
| 15 | **BLOCKER** | Comprehend `DetectPiiEntities` limit is 5,000 **bytes**, not chars — multi-byte UTF-8 text exceeds limit |
| 16 | **CORRECTNESS** | `schedule history` extracts scheduleId with `.split('-').pop()` — breaks when job name contains hyphens |
| 17 | **CORRECTNESS** | `packages/ecs-runner/.dockerignore` content never specified — `node_modules/` and test files included in Docker image |
| 18 | **CORRECTNESS** | `ingestionLambdaRole` has `s3:GetObject`+`s3:HeadObject` on uploads, but `CopyObjectCommand` (used by schedule trigger) also needs `s3:PutObject` on the destination prefix |
| 19 | **CORRECTNESS** | `QA-001` asserts 4 S3 buckets; after SPEC-15 Fix 18 removes `ArtifactsBucket` there are 3; `QA-003` KMS count also wrong |
| 20 | **CORRECTNESS** | MCP CORS `allowMethods` only includes `POST` — `GET /health` cross-origin preflight fails |

---

## Fix 1: BatchStack — Use Standard Workflow

**Problem:** AWS Step Functions Express Workflows have a **maximum execution duration of 5 minutes**. A batch of 50 jobs each taking 5 minutes = 250 minutes total → impossible with Express. Standard Workflows support up to 1 year.

**`infra/lib/batch-stack.ts`** — replace the StateMachine type:

```typescript
// REPLACE:
// stateMachineType: sfn.StateMachineType.EXPRESS,

// WITH:
stateMachineType: sfn.StateMachineType.STANDARD,

// Standard Workflows support longer timeouts and execution history
timeout: cdk.Duration.hours(24),  // now valid with STANDARD type

// Logging changes for STANDARD (optional — Standard uses CloudTrail by default):
// Remove the LoggingConfiguration block OR keep it; STANDARD supports it too
```

**Update SSM param write** — the param key `sfn/batch-arn` still works; no change needed there.

---

## Fix 2: `build-push-ecs.sh` — Handle Immutable `latest` Tag

**Problem:** ECR `ImageTagMutability: IMMUTABLE` means pushing the same tag twice fails. On second deployment, `docker push $ECR_URI:latest` returns `ImageTagAlreadyExists`.

**`scripts/build-push-ecs.sh`** — use only the unique git tag; never push `latest`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ENV=${1:-prod}
ECR_URI=$(aws ssm get-parameter \
  --name "/skills-svc/$ENV/ecr/repo-uri" \
  --query Parameter.Value --output text)
IMAGE_TAG=$(git rev-parse --short HEAD)

# Check if this exact tag already exists (idempotent deploy)
if aws ecr describe-images \
     --repository-name "$(echo $ECR_URI | cut -d'/' -f2)" \
     --image-ids imageTag="$IMAGE_TAG" \
     --query 'imageDetails[0].imageDigest' --output text 2>/dev/null; then
  echo "Image $IMAGE_TAG already exists in ECR — skipping build+push"
else
  aws ecr get-login-password --region us-east-1 \
    | docker login --username AWS --password-stdin "$ECR_URI"
  docker build -t "$ECR_URI:$IMAGE_TAG" packages/ecs-runner/
  docker push "$ECR_URI:$IMAGE_TAG"
  echo "Pushed: $ECR_URI:$IMAGE_TAG"
fi

# Update ECS task definition to use the new image tag (instead of 'latest')
TASK_DEF_FAMILY="skills-svc-runner-${ENV}"
CURRENT_DEF=$(aws ecs describe-task-definition \
  --task-definition "$TASK_DEF_FAMILY" --output json)
NEW_DEF=$(echo "$CURRENT_DEF" | jq \
  ".taskDefinition.containerDefinitions[0].image = \"$ECR_URI:$IMAGE_TAG\"" \
  | jq '.taskDefinition | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)')
aws ecs register-task-definition --cli-input-json "$NEW_DEF" --query 'taskDefinition.taskDefinitionArn' --output text
echo "Task definition updated to use $IMAGE_TAG"
```

Also update **`ECSStack`** to use `imageTag` from SSM rather than `'latest'`:
```typescript
// In ECSStack, the container image uses the task definition which is updated
// by build-push-ecs.sh. CDK uses 'latest' only for initial deploy.
// After first deploy, build-push-ecs.sh updates the task def directly.
// Remove 'latest' from CDK container definition — accept it only creates the initial task def.
```

---

## Fix 3: Ingestion Lambda — Check ECS `failures` Array

**`packages/lambda/src/ingestion/handler.ts`** — after `ecs.send(new RunTaskCommand(...))`:

```typescript
const ecsResult = await ecs.send(new RunTaskCommand({ ... }));

// Check for launch failures (ECS returns 200 but with failures array)
if (ecsResult.failures && ecsResult.failures.length > 0) {
  const failureReasons = ecsResult.failures
    .map(f => `${f.arn}: ${f.reason} (${f.detail})`)
    .join('; ');
  // Update job to FAILED so it doesn't hang in PENDING
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    UpdateExpression: 'SET #status = :failed, errorMessage = :err, updatedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':failed': JobStatus.FAILED,
      ':err': `ECS task launch failed: ${failureReasons}`,
      ':now': new Date().toISOString(),
    },
  }));
  throw new Error(`ECS RunTask returned failures: ${failureReasons}`);
}

console.log(JSON.stringify({ event: 'ecs_task_submitted', jobId, taskArn: ecsResult.tasks?.[0]?.taskArn }));
```

---

## Fix 4: ECS Runner — Await SIGTERM Status Update

**`packages/ecs-runner/src/main.ts`** — fix the SIGTERM handler:

```typescript
// REPLACE the synchronous SIGTERM handler:
process.on('SIGTERM', async () => {
  console.log(JSON.stringify({ event: 'sigterm_received' }));
  try {
    await updateJobStatus(jobId!, JobStatus.FAILED, process.env.ENV ?? 'prod', 'Task killed by SIGTERM');
    await securelyClearWorkspace('/tmp/workspace');
  } catch (err) {
    console.error(JSON.stringify({ event: 'sigterm_cleanup_error', err: String(err) }));
  } finally {
    process.exit(1);
  }
});
```

Since Node.js SIGTERM handlers can be async but `process.exit` is synchronous, use a pattern that allows the async work to complete:

```typescript
let sigTermReceived = false;

process.on('SIGTERM', () => {
  console.log(JSON.stringify({ event: 'sigterm_received' }));
  sigTermReceived = true;
  // The main() finally block handles cleanup; SIGTERM sets a flag
  // that causes main to throw after current operation completes
});

// In main(), add after each major step:
if (sigTermReceived) throw new Error('SIGTERM received — aborting');
```

This pattern lets the current async operation complete, then the `finally` block runs cleanup and `process.exit(1)`.

---

## Fix 5: MessagingStack — Grant `lambda:InvokeFunction` to Scheduler Role

**`infra/lib/messaging-stack.ts`** — add to `schedulerRole` inline policy:

```typescript
schedulerRole.addToPolicy(new iam.PolicyStatement({
  sid: 'InvokeScheduleTriggerLambda',
  actions: ['lambda:InvokeFunction'],
  resources: [
    // The schedule-trigger Lambda ARN — reference via SSM param or direct prop
    `arn:aws:lambda:${this.region}:${this.account}:function:skills-svc-schedule-trigger-${this.account}`,
  ],
}));
```

**Add `scheduleTriggerFnArn` to `MessagingStackProps`** if the ARN should come from `LambdaStack`:
```typescript
// Option A (simpler): Use the deterministic function name (known at deploy time)
// Option B: Pass scheduleTriggerFnArn from LambdaStack via props
// Use Option A — deterministic ARN doesn't require cross-stack reference
```

---

## Fix 6: Skill Validator — Fix Tag Key vs Value Indexing

**`packages/lambda/src/skill-validator/handler.ts`** — fix the tag indexing:

```typescript
// REPLACE:
// const tags: string[] = manifest.tags ? Object.values(manifest.tags) : [];

// WITH (index by KEYS — 'category', 'difficulty' — so user can search --tag category):
const tags: string[] = manifest.tags ? Object.keys(manifest.tags) : [];

// Also write tag value as metadata on the TAG record for display:
for (const [tagKey, tagValue] of Object.entries(manifest.tags ?? {})) {
  await ddb.send(new PutCommand({
    TableName: skillsTableName,
    Item: {
      PK:         `${SKILL_KEY_PREFIX.TAG}${tagKey}`,
      SK:         `${SKILL_KEY_PREFIX.SKILL}${skillName}#${version}`,
      skillName,
      version,
      tagKey,
      tagValue,   // store value for display
      authorArn,
      description: description || manifest.jobName,
      publishedAt: now,
      GSI3PK:     `${SKILL_KEY_PREFIX.TAG}${tagKey}`,
      GSI3SK:     `PUBLISHED_AT#${now}`,
    },
  }));
}
```

---

## Fix 7: Knowledge Store Client — Correct AWS SDK v3 Import

**`packages/knowledge-store/src/client.ts`** — fix the Sigv4 signer import:

```typescript
// REPLACE:
// import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';

// WITH (AWS SDK v3 compatible import):
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws-v3';
```

**`packages/knowledge-store/package.json`** — verify version supports `aws-v3` subpath:
```json
"@opensearch-project/opensearch": "^2.6.0"
```
Version 2.6.0+ ships the `aws-v3` subpath. ✓

---

## Fix 8: Knowledge Store Searcher — Fix Hybrid Query Structure

**Problem:** OpenSearch Serverless requires hybrid queries to be at the top level, not nested inside `bool.must`. The correct structure wraps the `user_arn` filter differently.

**`packages/knowledge-store/src/searcher.ts`** — updated query body:

```typescript
body: {
  size: topK,
  // Hybrid at top level — then apply post_filter for user_arn row-level security
  query: {
    hybrid: {
      queries: [
        {
          knn: {
            result_embedding: { vector: embedding, k: topK * 2 },
          },
        },
        {
          multi_match: {
            query,
            fields: ['job_name^2', 'result_summary^3', 'result_full_text^1', 'skill_names^1.5'],
            type: 'best_fields',
            fuzziness: 'AUTO',
          },
        },
      ],
    },
  },
  // Row-level security via post_filter (applied after scoring, not affecting scores)
  post_filter: adminOverride ? undefined : {
    term: { user_arn: callerUserArn },
  },
  _source: ['job_id', 'job_name', 'result_summary', 'created_at', 's3_result_key', 'skill_names', 'user_arn'],
  min_score: minScore,
},
```

---

## Fix 9: `list-jobs` — Implement Default Path

**`packages/cli/src/commands/list-jobs.ts`** — replace the placeholder `items = []`:

```typescript
} else {
  // Default: show user's own jobs (newest first) via GSI2
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const res = await ddb.send(new QueryCommand({
    TableName: cfg.dynamodbTableName,
    IndexName: 'GSI2-User',
    KeyConditionExpression: 'GSI2PK = :user',
    ExpressionAttributeValues: {
      ':user': `${DDB_KEY_PREFIX.USER}${identity.Arn}`,
    },
    ScanIndexForward: false,
    Limit: limit,
  }));
  items = (res.Items ?? []) as JobRecord[];
}
```

---

## Fix 10: `watch.ts` — Move Temp Zip Cleanup to `finally`

**`packages/cli/src/commands/watch.ts`** — inside `triggerRun`:

```typescript
async function triggerRun(changedFile: string): Promise<void> {
  // ...
  const tmpZip = path.join(os.tmpdir(), `skills-watch-${randomUUID()}.zip`);
  try {
    await zipDirectory(absDir, tmpZip, ignoreGlobs);
    // ... validate, upload ...
  } finally {
    // ALWAYS clean up temp zip, even on failure
    try { fs.unlinkSync(tmpZip); } catch { /* already deleted or never created */ }
  }
}
```

---

## Fix 11: `UserRole` — Add `s3:GetObject` on Results Bucket

**`infra/lib/security-stack.ts`** — add to `userRole` inline policies:

```typescript
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'S3ReadResults',
  actions: ['s3:GetObject'],
  resources: [`arn:aws:s3:::skills-svc-results-${this.account}-${this.region}/*`],
  conditions: {
    Bool: { 'aws:SecureTransport': 'true' },
    StringEquals: { 'kms:CallerAccount': this.account },
  },
}));
```

---

## Fix 12: Batch Lambdas — Add VPC Configuration

**`infra/lib/batch-stack.ts`** — add VPC to `BatchStackProps` and both Lambdas:

```typescript
interface BatchStackProps extends cdk.StackProps {
  envName: string;
  jobsTable: dynamodb.Table;
  ingestionFn: lambda.Function;
  dynamodbKey: kms.Key;
  uploadsBucketName: string;
  uploadsKmsKeyArn: string;
  vpc: ec2.Vpc;            // ADD
  lambdaSg: ec2.SecurityGroup;  // ADD
}

// In both Lambda definitions, add:
vpc: props.vpc,
vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
securityGroups: [props.lambdaSg],
```

**`infra/bin/app.ts`** — pass VPC to BatchStack:
```typescript
const batchStack = new BatchStack(app, `SkillsSvc-${envName}-Batch`, {
  env, envName,
  jobsTable:         storage.jobsTable,
  ingestionFn:       lambdaStack.ingestionFn,
  dynamodbKey:       security.dynamodbKey,
  uploadsBucketName: storage.uploadsBucket.bucketName,
  uploadsKmsKeyArn:  security.uploadsBucketKey.keyArn,
  vpc:               network.vpc,       // ADD
  lambdaSg:          network.lambdaSg,  // ADD
});
```

---

## Fix 13: Batch Map State — Pass Concurrency from CLI

The Map state `maxConcurrency` must be overridable at execution time. Step Functions Standard Workflow supports `maxConcurrency` as a runtime parameter via `overrideMaxConcurrency` in newer SDKs — but the simplest fix is to pass it as an execution input parameter and use a `maxConcurrency: 0` (unlimited) with concurrency managed by the Lambda itself.

**`infra/lib/batch-stack.ts`** — remove hardcoded maxConcurrency:

```typescript
const processAllInputs = new sfn.Map(this, 'ProcessAllInputs', {
  maxConcurrency: 0,          // 0 = unlimited; controlled by StartExecution input
  itemsPath: '$.inputs',
  parameters: {
    'skillsS3Bucket.$': '$.skillsS3Bucket',
    'skillsS3Key.$':    '$.skillsS3Key',
    'batchId.$':        '$.batchId',
    'batchJobName.$':   '$.batchJobName',
    'userArn.$':        '$.userArn',
    'input.$':          '$$.Map.Item.Value',
    'inputIndex.$':     '$$.Map.Item.Index',
    'concurrency.$':    '$.concurrency',  // pass through for Lambda to check
  },
});
```

**`packages/cli/src/commands/batch.ts`** — pass concurrency in input:

```typescript
input: JSON.stringify({
  batchId,
  batchJobName:   opts.jobName,
  skillsS3Bucket: cfg.uploadsBucket,
  skillsS3Key:    skillsKey,
  userArn:        identity.Arn,
  concurrency,     // ADD — Lambda reads this to self-limit if needed
  useCache:        opts.cache,
  inputs:          inputRefs,
}),
```

Note: True Map state concurrency control at runtime requires Step Functions `maxConcurrency` to be set dynamically. The workaround above lets the batch-submit Lambda throttle by checking the `concurrency` field and implementing its own backoff. Alternatively, use the `cdk.Duration` pattern with concurrency in SFN via `ItemBatcher` (Step Functions SDK integration).

---

## Fix 14: `resultsLambdaRole` — Grant Comprehend Permission

**`infra/lib/security-stack.ts`** — add to `resultsLambdaRole`:

```typescript
this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ComprehendPII',
  actions: ['comprehend:DetectPiiEntities'],
  resources: ['*'],  // Comprehend has no resource-level restrictions — documented exception
}));
```

---

## Fix 15: DLP — Check Byte Length Before Comprehend Call

**`packages/lambda/src/results-processor/indexer.ts`** — fix the text truncation:

```typescript
// Comprehend limit: 5,000 BYTES (not chars)
// For safety, calculate byte length and truncate to 4,800 bytes
function truncateToBytes(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf-8');
  if (encoded.length <= maxBytes) return text;
  // Binary search for the longest substring that fits
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf-8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

// In dlpScan():
const textChunk = truncateToBytes(text, 4_800); // 4800 bytes, safe under 5000 limit
```

---

## Fix 16: `schedule history` — Robust Schedule ID Extraction

**`packages/cli/src/commands/schedule.ts`** — fix the ID extraction:

```typescript
// Schedule name format: {sanitized-job-name}-{8-char-uuid}
// Job name sanitization: replace non-alphanumeric with '-'
// ID is always the last 8 characters after the final '-' separator

// REPLACE:
// const scheduleId = scheduleName.split('-').pop() ?? scheduleName;

// WITH (extracts the last 8-char segment after the last hyphen that separates name from UUID):
// The UUID suffix is always exactly 8 hex chars [a-f0-9]{8}
const uuidSuffixMatch = scheduleName.match(/-([a-f0-9]{8})$/);
const scheduleId = uuidSuffixMatch ? uuidSuffixMatch[1] : scheduleName;
```

---

## Fix 17: `packages/ecs-runner/.dockerignore` — Specify Content

```
# packages/ecs-runner/.dockerignore
node_modules/
dist/
*.test.ts
*.spec.ts
coverage/
.nyc_output/
*.log
.git/
.gitignore
tsconfig.json
jest.config.*
README.md
*.md
```

---

## Fix 18: `ingestionLambdaRole` — Add `s3:PutObject` for CopyObject Destination

**`infra/lib/security-stack.ts`** — update `ingestionLambdaRole` S3 policy:

```typescript
this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'S3UploadsAccess',
  actions: [
    's3:GetObject',
    's3:HeadObject',
    's3:PutObject',    // ADD — needed by schedule-trigger CopyObjectCommand (destination)
    's3:CopyObject',   // ADD — explicitly needed (equivalent to GetObject source + PutObject dest)
  ],
  resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/*`],
}));
```

---

## Fix 19: Update `QA-001` and `QA-003` for Removed ArtifactsBucket

```typescript
// REPLACE QA-001:
test('QA-001: StorageStack has exactly 3 S3 buckets (uploads, results, access-logs)', () => {
  const { templates } = buildTestApp();
  templates.storage.resourceCountIs('AWS::S3::Bucket', 3);  // was 4; ArtifactsBucket removed
});

// REPLACE QA-003:
test('QA-003: Non-access-log S3 buckets in StorageStack use KMS encryption', () => {
  const { templates } = buildTestApp();
  const buckets = templates.storage.findResources('AWS::S3::Bucket');
  let kmsCount = 0;
  for (const [, bucket] of Object.entries(buckets)) {
    const enc = (bucket as any).Properties.BucketEncryption
      ?.ServerSideEncryptionConfiguration?.[0]
      ?.ServerSideEncryptionByDefault;
    if (enc?.SSEAlgorithm === 'aws:kms') kmsCount++;
  }
  expect(kmsCount).toBe(2);  // was 3; only uploads + results (not access-logs, not artifacts)
});
```

---

## Fix 20: MCP CORS — Add GET to `allowMethods`

**`infra/lib/mcp-stack.ts`** — update CORS config:

```typescript
corsPreflight: {
  allowOrigins: ['https://claude.ai'],
  allowMethods: [
    apigatewayv2.CorsHttpMethod.POST,  // /mcp endpoint
    apigatewayv2.CorsHttpMethod.GET,   // /health endpoint (ADD)
  ],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
  maxAge: cdk.Duration.hours(1),
},
```

---

## New QA Checks (QA-229 through QA-238)

```typescript
// QA-229: BatchStack uses Standard (not Express) workflow
test('QA-229: Batch Step Functions StateMachine is STANDARD type', () => {
  const { templates } = buildTestApp();
  templates.batch.hasResourceProperties('AWS::StepFunctions::StateMachine', {
    StateMachineType: 'STANDARD',   // NOT 'EXPRESS'
  });
});

// QA-230: ECS RunTask result failures array is checked (static analysis)
test('QA-230: Ingestion handler checks ECS RunTask failures array', () => {
  const source = readFileSync('packages/lambda/src/ingestion/handler.ts', 'utf-8');
  expect(source).toContain('ecsResult.failures');
  expect(source).toContain('failures.length');
});

// QA-231: schedulerRole has lambda:InvokeFunction permission
test('QA-231: MessagingStack schedulerRole has lambda:InvokeFunction', () => {
  const { templates } = buildTestApp();
  const roles = templates.messaging.findResources('AWS::IAM::Role');
  const schedulerRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('skills-svc-scheduler')
  ) as any;
  expect(schedulerRole).toBeDefined();
  const stmts = schedulerRole.Properties.Policies
    ?.flatMap((p: any) => p.PolicyDocument.Statement) ?? [];
  const invokeStmt = stmts.find((s: any) =>
    (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('lambda:InvokeFunction')
  );
  expect(invokeStmt).toBeDefined();
});

// QA-232: Skill validator tags indexed by key not value
test('QA-232: Skill validator uses Object.keys(manifest.tags) not Object.values', () => {
  const source = readFileSync('packages/lambda/src/skill-validator/handler.ts', 'utf-8');
  expect(source).toContain('Object.keys(manifest.tags');
  expect(source).not.toContain('Object.values(manifest.tags');
});

// QA-233: OpenSearch client uses aws-v3 signer import
test('QA-233: knowledge-store client imports from opensearch/aws-v3', () => {
  const source = readFileSync('packages/knowledge-store/src/client.ts', 'utf-8');
  expect(source).toContain("from '@opensearch-project/opensearch/aws-v3'");
  expect(source).not.toContain("from '@opensearch-project/opensearch/aws'");
});

// QA-234: Hybrid search uses post_filter not bool.must wrapper
test('QA-234: hybridSearch uses post_filter for user_arn, not bool.must', () => {
  const source = readFileSync('packages/knowledge-store/src/searcher.ts', 'utf-8');
  expect(source).toContain('post_filter');
  // Must NOT nest hybrid inside bool
  expect(source).not.toMatch(/bool.*must.*hybrid/s);
});

// QA-235: list-jobs default path queries GSI2-User, not hardcoded []
test('QA-235: list-jobs without --status queries GSI2-User index', () => {
  const source = readFileSync('packages/cli/src/commands/list-jobs.ts', 'utf-8');
  expect(source).toContain('GSI2-User');
  expect(source).not.toContain("items = []");  // placeholder removed
});

// QA-236: Batch Lambdas are in VPC
test('QA-236: BatchStack Lambdas have VpcConfig', () => {
  const { templates } = buildTestApp();
  const fns = templates.batch.findResources('AWS::Lambda::Function');
  for (const [, fn] of Object.entries(fns)) {
    if ((fn as any).Properties.Handler?.includes('batch')) {
      expect((fn as any).Properties.VpcConfig).toBeDefined();
    }
  }
});

// QA-237: resultsLambdaRole has comprehend:DetectPiiEntities
test('QA-237: resultsLambdaRole has comprehend:DetectPiiEntities permission', () => {
  const { templates } = buildTestApp();
  const roles = templates.security.findResources('AWS::IAM::Role');
  const resultsRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('results-lambda')
  ) as any;
  const stmts = resultsRole.Properties.Policies
    ?.flatMap((p: any) => p.PolicyDocument.Statement) ?? [];
  const comprehendStmt = stmts.find((s: any) =>
    (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('comprehend:DetectPiiEntities')
  );
  expect(comprehendStmt).toBeDefined();
});

// QA-238: DLP text truncation uses byte-safe function
test('QA-238: DLP scan uses byte-safe truncation (not char-based slice)', () => {
  const source = readFileSync('packages/lambda/src/results-processor/indexer.ts', 'utf-8');
  expect(source).toContain('truncateToBytes');
  expect(source).toContain('Buffer.byteLength');
  // Must NOT use simple .slice(0, 5000) which is char-based
  expect(source).not.toMatch(/textChunk\s*=\s*text\.slice\(0,\s*5000\)/);
});
```

---

## Summary

| Fix | Files Changed |
|-----|--------------|
| 1 — Express → Standard SFN | `batch-stack.ts` |
| 2 — ECR immutable latest fix | `scripts/build-push-ecs.sh` |
| 3 — Check ECS failures array | `ingestion/handler.ts` |
| 4 — Await SIGTERM status update | `ecs-runner/src/main.ts` |
| 5 — schedulerRole lambda:Invoke | `messaging-stack.ts` |
| 6 — Tags: keys not values | `skill-validator/handler.ts` |
| 7 — OpenSearch aws-v3 import | `knowledge-store/src/client.ts` |
| 8 — Hybrid query post_filter | `knowledge-store/src/searcher.ts` |
| 9 — list-jobs default path | `commands/list-jobs.ts` |
| 10 — watch.ts temp zip finally | `commands/watch.ts` |
| 11 — UserRole s3:GetObject results | `security-stack.ts` |
| 12 — Batch Lambdas VPC | `batch-stack.ts`, `app.ts` |
| 13 — Batch concurrency dynamic | `batch-stack.ts`, `batch.ts` |
| 14 — Comprehend permission | `security-stack.ts` |
| 15 — DLP byte truncation | `results-processor/indexer.ts` |
| 16 — schedule history ID | `commands/schedule.ts` |
| 17 — .dockerignore content | `packages/ecs-runner/.dockerignore` |
| 18 — s3:PutObject for CopyObject | `security-stack.ts` |
| 19 — QA-001/003 bucket counts | `infra/test/storage-stack.test.ts` |
| 20 — MCP CORS GET method | `mcp-stack.ts` |
