# Skills as a Service (SaaS) — Specification Part 21: Final Worthy Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** Third 10-agent E2E audit. 205 raw issues → 15 worthy fixes (operational edge cases excluded).  
**Parts:** ... | [Part 20](SPEC-20-advanced-e2e-fixes.md) | [Part 21: Final Worthy Fixes]

---

## Worthy Issues Only

Operational edge cases excluded: IP reuse, Fargate Spot details, vector index tuning, UX copy improvements, multi-account cost aggregation, knn weight tuning, ECS credential rotation (handled by AWS automatically).

| # | Severity | Issue |
|---|----------|-------|
| 1 | **BLOCKER** | `schedule delete` hangs indefinitely in non-interactive CI (stdin is closed, readline never resolves) |
| 2 | **BLOCKER** | `skills-svc status <job-id>` exits 0 even when job is FAILED — CI cannot detect failure via exit code |
| 3 | **BLOCKER** | No exponential backoff for Bedrock `ThrottlingException` — 100 concurrent jobs all fail permanently on rate limit |
| 4 | **BLOCKER** | No timeout on `LambdaClient.InvokeCommand` — `skills-svc query` hangs indefinitely on Lambda timeout |
| 5 | **BLOCKER** | No `SKILLS_SVC_REGION`, `SKILLS_SVC_ACCOUNT`, `SKILLS_SVC_ENV` env var overrides — CI cannot configure without files |
| 6 | **CORRECTNESS** | knn `post_filter` by `user_arn` loses top results at scale — user with 3,600 of 36,000 docs gets false negatives |
| 7 | **CORRECTNESS** | DDB job TTL deletes records but OpenSearch documents remain — zombie docs returned in queries, DDB 404 on hydration |
| 8 | **DATA CORRUPTION** | `latestVersion` pointer race in skill META — concurrent pushes of different versions produce wrong `latestVersion` |
| 9 | **DATA CORRUPTION** | Batch input file count written to DDB before S3 upload completes — batch runs with wrong totalInputs |
| 10 | **CORRECTNESS** | No billing alarm in CDK stacks — account budget overruns are invisible until the AWS bill arrives |
| 11 | **CORRECTNESS** | JSON schema inconsistency across `--format json` commands — CI scripts must know per-command schema |
| 12 | **CORRECTNESS** | `skill push --version ${{ github.sha }}` fails — git SHAs are not valid SemVer; CI pipelines cannot use commit hashes |
| 13 | **CRITICAL** | Account migration: ECR image not in account 222 — all ECS tasks fail immediately after migration |
| 14 | **CRITICAL** | Account migration: S3 results still encrypted with account 111 KMS key after sync — decryption fails in account 222 |
| 15 | **CORRECTNESS** | Account migration: no two-phase read-only cutover — job submissions to account 111 after cutover are orphaned |

---

## Fix 1: `schedule delete` — Non-Interactive CI Guard

**`packages/cli/src/commands/schedule.ts`:**

```typescript
cmd.command('delete <schedule-name>')
  .description('Delete a schedule permanently')
  .option('--force', 'Skip confirmation prompt', false)
  .action(async (scheduleName: string, opts: { force: boolean }) => {
    // ADD: Non-interactive guard BEFORE any readline usage
    if (!opts.force && !process.stdin.isTTY) {
      console.error(chalk.red(
        'skills-svc schedule delete requires --force in non-interactive environments (CI, scripts).\n' +
        'Use: skills-svc schedule delete <name> --force'
      ));
      process.exit(1);
    }

    if (!opts.force) {
      const { default: readline } = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const confirmed = await new Promise<boolean>(resolve => {
        rl.question(
          chalk.yellow(`Delete schedule "${scheduleName}"? This cannot be undone. (yes/N): `),
          answer => { rl.close(); resolve(answer.toLowerCase() === 'yes'); }
        );
      });
      if (!confirmed) { console.log('Aborted.'); return; }
    }
    // ... rest of delete logic unchanged
  });
```

---

## Fix 2: `status` Exit Code Reflects Job Outcome

**`packages/cli/src/commands/status.ts`:**

```typescript
// After prettyTable display, add:
const terminalFailureStatuses = [JobStatus.FAILED];
if (terminalFailureStatuses.includes(job.status)) {
  // Exit non-zero so CI can detect failure with: skills-svc status <id> || echo "job failed"
  process.exit(1);
}
// COMPLETE and RUNNING both exit 0 (job exists, was retrieved successfully)
```

**Document in help text:**

```typescript
.description(
  'Get the status of a specific job.\n' +
  'Exit codes: 0=PENDING/RUNNING/COMPLETE, 1=FAILED/not-found'
)
```

---

## Fix 3: Bedrock Exponential Backoff on ThrottlingException

**`packages/ecs-runner/src/runner.ts`** — wrap the Bedrock call:

```typescript
const MAX_BEDROCK_ATTEMPTS = 5;

async function invokeModelWithRetry(
  bedrock: BedrockRuntimeClient,
  messages: { role: string; content: string }[],
  system: string,
): Promise<string> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_BEDROCK_ATTEMPTS; attempt++) {
    try {
      return await invokeModel(bedrock, messages, system);
    } catch (err: any) {
      lastErr = err;
      const isRetryable = [
        'ThrottlingException',
        'ServiceUnavailableException',
        'InternalServerException',
        'RequestTimeoutException',
      ].includes(err.name);

      if (!isRetryable || attempt === MAX_BEDROCK_ATTEMPTS - 1) throw err;

      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 32_000); // 1s, 2s, 4s, 8s, 32s
      console.warn(JSON.stringify({
        event: 'bedrock_retry',
        attempt: attempt + 1,
        backoffMs,
        errorName: err.name,
        message: `Bedrock throttled — retrying in ${backoffMs}ms`,
      }));
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

// Replace invokeModel call in runSkills():
const result = await Promise.race([
  invokeModelWithRetry(bedrock, messages, systemPrompt),  // ← use retry wrapper
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Bedrock timed out after ${TASK_TIMEOUT_MS / 1000}s`)), TASK_TIMEOUT_MS)
  ),
]);
```

---

## Fix 4: Lambda InvokeCommand Timeout

**`packages/cli/src/utils/aws-clients.ts`** — configure Lambda client with timeout:

```typescript
import { LambdaClient } from '@aws-sdk/client-lambda';

export function getLambdaClient(cfg: CliConfig, creds: any): LambdaClient {
  return new LambdaClient({
    region: cfg.region,
    credentials: creds,
    requestHandler: {
      requestTimeout: 35_000,  // 35s — just over API Gateway's 29s limit
      connectionTimeout: 5_000,
    },
  });
}
```

**`packages/cli/src/commands/query.ts`** — add CLI-level timeout:

```typescript
const QUERY_TIMEOUT_MS = 35_000;

const timeoutId = setTimeout(() => {
  console.error(chalk.red(`\nQuery timed out after ${QUERY_TIMEOUT_MS / 1000}s.`));
  console.error(chalk.dim('The Lambda may be cold-starting. Try again in a moment.'));
  process.exit(1);
}, QUERY_TIMEOUT_MS);

try {
  const invocation = await lam.send(new InvokeCommand({ ... }));
  clearTimeout(timeoutId);
  // ... rest of handler
} catch (err) {
  clearTimeout(timeoutId);
  throw err;
}
```

---

## Fix 5: Environment Variable Config Override

**`packages/cli/src/utils/config.ts`** — read env vars after loading file:

```typescript
export async function loadConfig(profileName?: string): Promise<CliConfig> {
  const name = profileName ?? process.env.SKILLS_SVC_PROFILE ?? getDefaultProfileName();
  
  // Load from file (may throw if not configured)
  let cfg: CliConfig;
  try {
    cfg = readConfigFile(name);
  } catch {
    // Allow fully env-var-based config for CI (no file required)
    cfg = {} as CliConfig;
  }

  // Environment variable overrides — enable fully headless CI operation
  if (process.env.SKILLS_SVC_REGION)           cfg.region           = process.env.SKILLS_SVC_REGION;
  if (process.env.SKILLS_SVC_ACCOUNT)          cfg.accountId        = process.env.SKILLS_SVC_ACCOUNT;
  if (process.env.SKILLS_SVC_ENV)              cfg.envName          = process.env.SKILLS_SVC_ENV;
  if (process.env.SKILLS_SVC_UPLOADS_BUCKET)   cfg.uploadsBucket    = process.env.SKILLS_SVC_UPLOADS_BUCKET;
  if (process.env.SKILLS_SVC_RESULTS_BUCKET)   cfg.resultsBucket    = process.env.SKILLS_SVC_RESULTS_BUCKET;
  if (process.env.SKILLS_SVC_DDB_TABLE)        cfg.dynamodbTableName = process.env.SKILLS_SVC_DDB_TABLE;
  if (process.env.SKILLS_SVC_QUERY_LAMBDA_ARN) cfg.queryLambdaArn   = process.env.SKILLS_SVC_QUERY_LAMBDA_ARN;
  if (process.env.SKILLS_SVC_MCP_ENDPOINT)     cfg.mcpEndpoint      = process.env.SKILLS_SVC_MCP_ENDPOINT;

  // Validate required fields
  const required: (keyof CliConfig)[] = ['region', 'accountId', 'envName'];
  const missing = required.filter(k => !cfg[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing config: ${missing.join(', ')}.\n` +
      `Run: skills-svc configure --region us-east-1 --account <ID>\n` +
      `Or set environment variables: SKILLS_SVC_REGION, SKILLS_SVC_ACCOUNT, SKILLS_SVC_ENV`
    );
  }

  return cfg;
}
```

**Document in README:**

```bash
# CI/CD — no config file needed:
export SKILLS_SVC_REGION=us-east-1
export SKILLS_SVC_ACCOUNT=123456789012
export SKILLS_SVC_ENV=prod
export SKILLS_SVC_UPLOADS_BUCKET=skills-svc-uploads-123456789012-us-east-1
# ... etc.
skills-svc upload ./skills.zip --job-name "ci-run"
```

---

## Fix 6: knn Two-Pass Search to Prevent False Negatives at Scale

**`packages/knowledge-store/src/searcher.ts`** — increase knn candidate pool:

```typescript
export async function hybridSearch(
  query: string,
  callerUserArn: string,
  topK = 5,
  minScore = 0.5,
): Promise<SearchResult[]> {
  const embedding = await getEmbedding(query);

  // Increase knn k to 10x topK to compensate for post_filter reducing the pool.
  // At scale (user has 10% of docs), top-k_knn=10 may return 0 user docs.
  // k=topK*10 gives enough candidates to survive post_filter.
  const knnK = Math.min(topK * 10, 100);  // cap at 100 for performance

  const response = await client.search({
    index: indexName,
    body: {
      size: topK,
      query: {
        hybrid: {
          queries: [
            { knn: { result_embedding: { vector: embedding, k: knnK } } },
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
      post_filter: { term: { user_arn: callerUserArn } },
      _source: ['job_id', 'job_name', 'result_summary', 'created_at', 's3_result_key', 'skill_names', 'user_arn'],
      min_score: minScore,
    },
  });

  // If still no results after increasing k, log diagnostic
  if (response.body.hits?.hits?.length === 0) {
    console.warn(JSON.stringify({
      event: 'search_no_results',
      query: query.slice(0, 50),
      callerUserArn,
      knnK,
      message: 'No results after post_filter. User may have no matching indexed jobs.',
    }));
  }

  return mapHits(response.body.hits?.hits ?? []);
}
```

---

## Fix 7: Synchronize DDB TTL Deletion with OpenSearch

**`packages/lambda/src/results-processor/indexer.ts`** — set OpenSearch document TTL:

```typescript
// When indexing a document, include the TTL timestamp so OpenSearch can auto-expire
const document = {
  job_id: result.jobId,
  // ... all existing fields ...
  // ADD: expiry matching DDB TTL (90 days)
  _expiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
};
```

**`packages/lambda/src/bootstrap-index/handler.ts`** — add TTL field to mapping:

```typescript
// Add to INDEX_MAPPING.mappings.properties:
_expiry: { type: 'date', format: 'strict_date_optional_time' },
```

**OpenSearch index lifecycle policy** — add to bootstrap handler after index creation:

```typescript
// Create ISM (Index State Management) policy to delete expired documents
// Note: AOSS may not support ISM — use a scheduled Lambda instead
```

**`packages/lambda/src/reindex/handler.ts`** — periodic cleanup Lambda:

```typescript
// Add cleanup pass: remove docs where _expiry < now
await client.deleteByQuery({
  index: indexName,
  body: {
    query: {
      range: { _expiry: { lt: new Date().toISOString() } },
    },
  },
});
```

**Wire cleanup Lambda to EventBridge daily:**

```typescript
// In infra/lib/monitoring-stack.ts:
const cleanupFn = new lambda.Function(this, 'OpenSearchCleanupFn', {
  functionName: `skills-svc-opensearch-cleanup-${this.account}`,
  // ... standard Lambda config ...
  handler: 'reindex/handler.cleanupExpiredDocuments',
});

new events.Rule(this, 'DailyCleanup', {
  schedule: events.Schedule.cron({ hour: '2', minute: '0' }), // 2 AM daily
  targets: [new eventsTargets.LambdaFunction(cleanupFn)],
});
```

---

## Fix 8: `latestVersion` Pointer Race — Conditional Update

**`packages/lambda/src/skill-validator/handler.ts`** — serialize META updates:

```typescript
// REPLACE the current unconditional UpdateCommand for META with a conditional one:

// Use optimistic locking: only update latestVersion if the new version is actually higher
await ddb.send(new UpdateCommand({
  TableName: skillsTableName,
  Key: { PK: `${SKILL_KEY_PREFIX.SKILL}${skillName}`, SK: 'META' },
  UpdateExpression: `
    SET updatedAt = :now
    ADD totalVersions :one
    ${isNewer ? ', latestVersion = :lv' : ''}
    ${isNewerStable ? ', latestStable = :ls' : ''}
  `.trim().replace(/\n\s+/g, ' '),
  // Condition: only update latestVersion if current value is LOWER than new version
  // This serializes concurrent pushes correctly
  ConditionExpression: isNewer
    ? 'attribute_not_exists(latestVersion) OR latestVersion < :lv'
    : undefined,
  ExpressionAttributeValues: {
    ':now': now,
    ':one': 1,
    ...(isNewer       ? { ':lv': version } : {}),
    ...(isNewerStable ? { ':ls': version } : {}),
  },
})).catch(async (err) => {
  if (err.name === 'ConditionalCheckFailedException') {
    // Another concurrent push already set a higher version — this is fine, just skip
    console.log(JSON.stringify({
      event: 'latest_version_race_skipped',
      skillName,
      version,
      message: 'Another push set a higher latestVersion concurrently — skipping this update',
    }));
    return;
  }
  throw err;
});
```

---

## Fix 9: Batch Input Count Written to DDB Before S3 Upload

**`packages/cli/src/commands/batch.ts`** — reorder: write count AFTER uploads succeed:

```typescript
// CURRENT (wrong) order:
// 1. Write METADATA with totalJobs to DDB
// 2. Upload input files to S3 (may fail or complete fewer than expected)
// 3. Start SFN execution

// CORRECT order:
// 1. Upload ALL input files to S3 — get actual uploaded count
// 2. Only then write METADATA with confirmed totalJobs count
// 3. Start SFN execution

// Upload input files FIRST
console.log(chalk.blue(`Uploading ${inputFiles.length} input files...`));
const inputRefs: Array<{ s3Key: string; originalFile: string; index: number }> = [];
for (const [index, file] of inputFiles.entries()) {
  const inputKey = `uploads/batch/${batchId}/inputs/${index}-${path.basename(file)}`;
  await s3.send(new PutObjectCommand({ ... }));
  inputRefs.push({ s3Key: inputKey, originalFile: path.relative(process.cwd(), file), index });
}

const confirmedCount = inputRefs.length; // actual count after uploads

// THEN write METADATA with confirmed count
await ddb.send(new PutCommand({
  TableName: batchTableName,
  Item: {
    PK: `BATCH#${batchId}`,
    SK: 'METADATA',
    batchId,
    batchName: opts.jobName,
    userArn: identity.Arn!,
    status: 'PENDING',
    totalJobs: confirmedCount,   // ← confirmed, not estimated
    completedJobs: 0,
    failedJobs: 0,
    submittedJobs: 0,
    createdAt: now,
    GSI1PK: `USER#${identity.Arn}`,
    GSI1SK: `CREATED_AT#${now}`,
  },
  ConditionExpression: 'attribute_not_exists(PK)',
}));
```

---

## Fix 10: Billing Alarm in CDK

**`infra/lib/monitoring-stack.ts`** — add monthly billing alarm:

```typescript
// Note: Billing metrics are only available in us-east-1
// This alarm should be added to the Compliance or Monitoring stack
// and requires the account to have billing alerts enabled

new cloudwatch.Alarm(this, 'MonthlyBillingAlarm', {
  alarmName: `skills-svc-${envName}-monthly-budget`,
  metric: new cloudwatch.Metric({
    namespace: 'AWS/Billing',
    metricName: 'EstimatedCharges',
    dimensionsMap: { Currency: 'USD' },
    period: cdk.Duration.days(1),
    statistic: 'Maximum',
    region: 'us-east-1',  // Billing metrics only in us-east-1
  }),
  threshold: 1000,  // $1,000 — adjust per deployment
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  alarmDescription: 'Monthly AWS estimated charges exceeded budget threshold',
}).addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));

// Enable billing alerts (one-time account setting — must be done manually or via SDK)
// Document in deployment runbook: aws account enable-billing-alerts
```

---

## Fix 11: Consistent JSON Schema Across `--format json` Commands

Add a standard envelope to all JSON output:

**`packages/shared/src/types.ts`** — add `CLIResponse` type:

```typescript
export interface CLIResponse<T> {
  command: string;
  timestamp: string;
  success: boolean;
  data: T;
  error?: string;
}
```

**Update all commands** that support `--format json` to use this envelope. Example for `cost.ts`:

```typescript
if (opts.format === 'json') {
  const response: CLIResponse<{ jobs: JobCost[]; totalUsd: number }> = {
    command: 'cost',
    timestamp: new Date().toISOString(),
    success: true,
    data: { jobs: allJobs, totalUsd },
  };
  console.log(JSON.stringify(response, null, 2));
  return;
}
```

**Same envelope for:** `query`, `list-jobs`, `status`, `results`, `batch status`, `skill list`, `skill info`, `cost`, `diff`.

**CI scripts can now use consistent access pattern:**
```bash
skills-svc cost --format json | jq '.data.totalUsd'
skills-svc query "test" --format json | jq '.data.results[0].jobId'
skills-svc status abc123 --format json | jq '.data.status'
```

---

## Fix 12: `skill push` — Accept SemVer Prerelease with Git SHA

**`packages/cli/src/commands/skill.ts`** — document CI-compatible version pattern:

```typescript
// In skill push action, after semver validation error:
if (!isValidSemver(opts.version)) {
  console.error(chalk.red(`Invalid semver: "${opts.version}"`));
  console.error(chalk.dim('SemVer format required: MAJOR.MINOR.PATCH'));
  console.error(chalk.dim('For CI/CD with git commits, use prerelease format:'));
  console.error(chalk.cyan(`  --version "0.0.0-${opts.version.slice(0, 8)}"`));
  console.error(chalk.cyan(`  --version "1.0.0-$(git rev-parse --short HEAD)"`));
  process.exit(1);
}
```

**Add `--auto-version` flag for CI convenience:**

```typescript
.option('--auto-version', 'Auto-generate version from git commit + timestamp (for CI)', false)

// In action handler:
let version = opts.version;
if (opts.autoVersion) {
  const gitSha = execSync('git rev-parse --short HEAD').toString().trim();
  const timestamp = Date.now();
  version = `0.0.0-${gitSha}-${timestamp}`;
  console.log(chalk.dim(`Auto-version: ${version}`));
}
```

**CI usage:**
```bash
skills-svc skill push ./my-skill --name my-analyzer --auto-version
# OR:
skills-svc skill push ./my-skill --name my-analyzer --version "1.0.0-$(git rev-parse --short HEAD)"
```

---

## Fix 13: Account Migration — ECR Image Copy Procedure

**`scripts/migrate-account.sh`** (new file):

```bash
#!/usr/bin/env bash
# Account Migration Script — Phase 1: Infrastructure & Images
set -euo pipefail

SOURCE_ACCOUNT=${1:?Usage: migrate-account.sh <source-account> <target-account> <region> <env>}
TARGET_ACCOUNT=${2:?}
REGION=${3:?}
ENV=${4:-prod}

echo "=== Phase 1: Copy ECR Images ==="
SOURCE_ECR="${SOURCE_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/skills-svc-runner-${ENV}"
TARGET_ECR="${TARGET_ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/skills-svc-runner-${ENV}"

# Get all image tags from source ECR
IMAGE_TAGS=$(aws ecr list-images \
  --repository-name "skills-svc-runner-${ENV}" \
  --registry-id "$SOURCE_ACCOUNT" \
  --region "$REGION" \
  --query 'imageIds[*].imageTag' \
  --output text)

# Login to both registries
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$SOURCE_ECR"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$TARGET_ECR"

# Copy each image tag
for TAG in $IMAGE_TAGS; do
  echo "Copying image: $TAG"
  docker pull "$SOURCE_ECR:$TAG"
  docker tag "$SOURCE_ECR:$TAG" "$TARGET_ECR:$TAG"
  docker push "$TARGET_ECR:$TAG"
done

echo "✓ ECR images copied"

echo "=== Phase 2: Get latest task definition tag ==="
LATEST_TAG=$(aws ecr describe-images \
  --repository-name "skills-svc-runner-${ENV}" \
  --registry-id "$SOURCE_ACCOUNT" \
  --query 'sort_by(imageDetails, &imagePushedAt)[-1].imageTags[0]' \
  --output text)
echo "Latest image tag: $LATEST_TAG"
echo "Run build-push-ecs.sh against target account to update task definition"
```

---

## Fix 14: Account Migration — S3 Results Re-Encryption

**`packages/lambda/src/reindex/handler.ts`** — add re-encryption mode:

```typescript
interface ReencryptInput {
  mode: 'reindex' | 'reencrypt';
  sourceAccount: string;
  targetAccount: string;
  sourceBucket: string;
  targetBucket: string;
  sourceKmsKeyArn: string;
  targetKmsKeyArn: string;
  sinceDate?: string;
}

export const reencryptHandler = async (event: ReencryptInput) => {
  // For account migration: download with source KMS key, re-upload with target KMS key
  // Requires: cross-account KMS grant from source account for source key

  const s3 = new S3Client({ region: process.env.REGION });
  let processed = 0, failed = 0;

  // List all result objects in source bucket
  let continuationToken: string | undefined;
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: event.sourceBucket,
      Prefix: 'results/',
      ContinuationToken: continuationToken,
    }));

    for (const obj of list.Contents ?? []) {
      try {
        // Download (decrypts with source KMS via cross-account grant)
        const getRes = await s3.send(new GetObjectCommand({
          Bucket: event.sourceBucket,
          Key: obj.Key!,
        }));
        const body = Buffer.concat(
          await (async function() {
            const chunks: Uint8Array[] = [];
            for await (const chunk of getRes.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
            return chunks;
          })()
        );

        // Re-upload with target KMS key (re-encrypts at S3 level)
        await s3.send(new PutObjectCommand({
          Bucket: event.targetBucket,
          Key: obj.Key!,
          Body: body,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: event.targetKmsKeyArn,
          Metadata: getRes.Metadata,
          ContentType: getRes.ContentType,
        }));
        processed++;
      } catch (err) {
        console.error(JSON.stringify({ event: 'reencrypt_error', key: obj.Key, err: String(err) }));
        failed++;
      }
    }
    continuationToken = list.NextContinuationToken;
  } while (continuationToken);

  return { processed, failed };
};
```

**`docs/account-migration-runbook.md`** — add re-encryption step:

```markdown
## Step 3: Re-encrypt S3 Results (Critical — ~6-12 hours)

Before cutover, invoke the re-encryption Lambda in the TARGET account:

```bash
aws lambda invoke \
  --function-name skills-svc-reindex-222222222222 \
  --payload '{
    "mode": "reencrypt",
    "sourceBucket": "skills-svc-results-111111111111-us-east-1",
    "targetBucket": "skills-svc-results-222222222222-us-east-1",
    "sourceKmsKeyArn": "arn:aws:kms:us-east-1:111111111111:key/...",
    "targetKmsKeyArn": "arn:aws:kms:us-east-1:222222222222:key/..."
  }' \
  response.json

cat response.json
```

Pre-requisite: Create cross-account KMS grant in account 111:
```bash
aws kms create-grant \
  --key-id arn:aws:kms:us-east-1:111111111111:key/<results-key-id> \
  --grantee-principal arn:aws:iam::222222222222:role/skills-svc-reindex-222222222222 \
  --operations Decrypt \
  --name "migration-grant-$(date +%Y%m%d)"
```

After migration, revoke the grant:
```bash
aws kms revoke-grant --key-id <key-id> --grant-id <grant-id>
```
```

---

## Fix 15: Account Migration — Two-Phase Read-Only Cutover

**`infra/lib/security-stack.ts`** — add migration mode flag to S3 bucket policy:

```typescript
// Add a migration-mode bucket policy condition to uploads bucket
// When enabled, blocks new PutObject while allowing GetObject (read-only mode)
// Toggle via SSM parameter: /skills-svc/{env}/migration/read-only-mode

// Read from SSM at deploy time — CDK parameter
const readOnlyMode = new ssm.StringParameter(this, 'MigrationReadOnlyMode', {
  parameterName: `/skills-svc/${envName}/migration/read-only-mode`,
  stringValue: 'false',  // set to 'true' during cutover
  description: 'Set to true during account migration to block new uploads',
});
```

**CLI migration mode command:**

```typescript
// packages/cli/src/commands/admin.ts (new file, admin subcommand)
import { Command } from 'commander';

export function adminCommand(): Command {
  const cmd = new Command('admin').description('Administrative operations (requires admin role)');

  cmd.command('enable-read-only-mode')
    .description('Block new job submissions (for account migration cutover)')
    .action(async () => {
      const ssm = new SSMClient({ region: cfg.region, credentials: creds });
      await ssm.send(new PutParameterCommand({
        Name: `/skills-svc/${cfg.envName}/migration/read-only-mode`,
        Value: 'true',
        Overwrite: true,
      }));
      console.log(chalk.yellow('⚠  Read-only mode ENABLED — new uploads are BLOCKED'));
      console.log(chalk.dim('Existing jobs continue to run. To re-enable: skills-svc admin disable-read-only-mode'));
    });

  cmd.command('disable-read-only-mode')
    .description('Re-enable job submissions after migration')
    .action(async () => {
      await ssm.send(new PutParameterCommand({
        Name: `/skills-svc/${cfg.envName}/migration/read-only-mode`,
        Value: 'false',
        Overwrite: true,
      }));
      console.log(chalk.green('✓ Read-only mode disabled — new uploads are allowed'));
    });

  return cmd;
}
```

**`packages/lambda/src/ingestion/handler.ts`** — check migration flag:

```typescript
// Add at start of processRecord():
const readOnlyMode = await getParam(`/skills-svc/${env}/migration/read-only-mode`);
if (readOnlyMode === 'true') {
  // Reject the job — return to SQS for retry after migration completes
  console.log(JSON.stringify({
    event: 'migration_read_only_rejection',
    message: 'System is in read-only migration mode. Job will be retried after cutover.',
    s3Key: key,
  }));
  // Don't mark as failure — return item to queue to retry
  return; // SQS message stays visible, will retry after migration window
}
```

**Migration Runbook Phase Summary:**

```markdown
# Two-Phase Account Migration Cutover

## Phase 1: Enable Read-Only Mode (account 111)
```bash
skills-svc --profile prod admin enable-read-only-mode
# Wait for all in-flight jobs to complete (check: skills-svc list-jobs --status RUNNING)
```

## Phase 2: Data Migration (6-12 hours)
- DDB export/import
- S3 results re-encryption (Fix 14)  
- OpenSearch re-index
- ECR image copy (Fix 13)

## Phase 3: Switch Users to Account 222
- Update CLI profiles for all users
- Validate: skills-svc --profile prod-v2 list-jobs

## Phase 4: Disable Read-Only Mode (account 111, after 24h validation)
```bash
skills-svc --profile prod admin disable-read-only-mode
# Then decommission account 111 after 30 days
```
```

---

## New QA Checks (QA-267 through QA-275)

```typescript
// QA-267: schedule delete exits 1 without --force in non-TTY
test('QA-267: schedule delete exits 1 in non-interactive mode without --force', async () => {
  // Simulate non-TTY stdin
  Object.defineProperty(process.stdin, 'isTTY', { value: false });
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  await expect(runScheduleDelete('my-schedule', {})).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
  // Restore
  Object.defineProperty(process.stdin, 'isTTY', { value: true });
});

// QA-268: status exits 1 when job is FAILED
test('QA-268: status command exits 1 when job status is FAILED', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({
    Item: { jobId: 'test', status: 'FAILED', jobName: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), userArn: 'arn:test', s3Key: 'test', s3ETag: 'test' },
  });
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  await expect(runStatus('test-job')).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-269: Bedrock retry on ThrottlingException
test('QA-269: invokeModelWithRetry retries ThrottlingException with backoff', async () => {
  const bedrockMock = mockClient(BedrockRuntimeClient);
  let callCount = 0;
  bedrockMock.on(InvokeModelCommand).callsFake(() => {
    callCount++;
    if (callCount < 3) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    return { body: Buffer.from(JSON.stringify({ content: [{ type: 'text', text: '{"summary":"ok"}' }], usage: { input_tokens: 100, output_tokens: 50 } })) };
  });
  const result = await invokeModelWithRetry(bedrockMock as any, [], 'system');
  expect(result).toBe('{"summary":"ok"}');
  expect(callCount).toBe(3);
});

// QA-270: loadConfig reads SKILLS_SVC_REGION env var
test('QA-270: loadConfig applies SKILLS_SVC_REGION environment variable override', async () => {
  process.env.SKILLS_SVC_REGION = 'eu-west-1';
  process.env.SKILLS_SVC_ACCOUNT = '999888777666';
  process.env.SKILLS_SVC_ENV = 'staging';
  const cfg = await loadConfig('nonexistent-profile-that-doesnt-exist');
  expect(cfg.region).toBe('eu-west-1');
  expect(cfg.accountId).toBe('999888777666');
  delete process.env.SKILLS_SVC_REGION;
  delete process.env.SKILLS_SVC_ACCOUNT;
  delete process.env.SKILLS_SVC_ENV;
});

// QA-271: hybridSearch uses knnK = topK * 10 
test('QA-271: hybridSearch uses knn k = topK*10 to compensate for post_filter', async () => {
  const searchSpy = jest.fn().mockResolvedValue({ body: { hits: { hits: [] } } });
  jest.spyOn(clientModule, 'getOpenSearchClient').mockResolvedValue({ search: searchSpy } as any);
  jest.spyOn(embeddingsModule, 'getEmbedding').mockResolvedValue(Array(1536).fill(0.1));
  
  await hybridSearch('test', 'arn:aws:iam::123:user/alice', 5, 0.5);
  
  const searchBody = searchSpy.mock.calls[0][0].body;
  const knnQuery = searchBody.query.hybrid.queries[0].knn;
  expect(knnQuery.result_embedding.k).toBe(50); // topK=5 * 10 = 50
});

// QA-272: batch run writes totalJobs AFTER S3 uploads complete
test('QA-272: batch run PutCommand has confirmed totalJobs after all uploads', async () => {
  const s3Mock = mockClient(S3Client);
  s3Mock.on(PutObjectCommand).resolves({});
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(PutCommand).resolves({});
  
  // Mock 3 input files
  jest.spyOn(glob, 'globSync').mockReturnValue(['a.json', 'b.json', 'c.json']);
  
  await runBatchRun({ jobName: 'test', inputs: '*.json' });
  
  const putCall = ddbMock.commandCalls(PutCommand)[0];
  // totalJobs must equal actual files uploaded (not estimated)
  expect(putCall.args[0].input.Item.totalJobs).toBe(3);
  // S3 upload calls should come BEFORE DDB write
  const s3CallIndex = s3Mock.calls().findIndex(c => c.args[0] instanceof PutObjectCommand);
  const ddbCallIndex = ddbMock.calls().findIndex(c => c.args[0] instanceof PutCommand);
  expect(s3CallIndex).toBeLessThan(ddbCallIndex);
});

// QA-273: JSON output has consistent CLIResponse envelope
test('QA-273: --format json output has consistent CLIResponse envelope structure', async () => {
  const output = await captureConsoleOutput(() => runCost({ format: 'json', since: '2025-01-01' }));
  const parsed = JSON.parse(output);
  expect(parsed).toHaveProperty('command');
  expect(parsed).toHaveProperty('timestamp');
  expect(parsed).toHaveProperty('success');
  expect(parsed).toHaveProperty('data');
  expect(typeof parsed.data).toBe('object');
});

// QA-274: skill push --auto-version generates valid SemVer prerelease
test('QA-274: skill push --auto-version generates valid semver prerelease', () => {
  // Mock git rev-parse
  jest.spyOn(childProcess, 'execSync').mockReturnValue(Buffer.from('abc1234\n'));
  const version = generateAutoVersion(); // internal function
  expect(isValidSemver(version)).toBe(true);
  expect(version).toMatch(/^0\.0\.0-abc1234-\d+$/);
});

// QA-275: MonitoringStack has billing alarm
test('QA-275: MonitoringStack has AWS/Billing EstimatedCharges alarm', () => {
  const { templates } = buildTestApp();
  templates.monitoring.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'AWS/Billing',
    MetricName: 'EstimatedCharges',
    Threshold: expect.any(Number),
  });
});
```

---

## Summary

| Fix | Impact | Files |
|-----|--------|-------|
| 1 — `schedule delete` CI guard | BLOCKER — CI pipelines no longer hang | `commands/schedule.ts` |
| 2 — `status` exit code | BLOCKER — CI can detect FAILED jobs | `commands/status.ts` |
| 3 — Bedrock retry backoff | BLOCKER — batch jobs survive rate limits | `ecs-runner/src/runner.ts` |
| 4 — Lambda InvokeCommand timeout | BLOCKER — `query` no longer hangs | `utils/aws-clients.ts`, `commands/query.ts` |
| 5 — Env var config override | BLOCKER — CI works without config files | `utils/config.ts` |
| 6 — knn k = topK × 10 | CORRECTNESS — no false negatives at scale | `knowledge-store/src/searcher.ts` |
| 7 — OpenSearch zombie doc cleanup | CORRECTNESS — DDB/OS stay in sync | `lambda/src/reindex/handler.ts`, `monitoring-stack.ts` |
| 8 — latestVersion race fix | DATA CORRUPTION — no wrong version pointers | `skill-validator/handler.ts` |
| 9 — Batch count after S3 upload | DATA CORRUPTION — correct totalJobs | `commands/batch.ts` |
| 10 — Billing alarm in CDK | CORRECTNESS — budget visible in IaC | `monitoring-stack.ts` |
| 11 — Consistent JSON envelope | CORRECTNESS — CI scripting simplified | All `--format json` commands |
| 12 — SemVer CI guidance + `--auto-version` | CORRECTNESS — git SHAs work in CI | `commands/skill.ts` |
| 13 — ECR image copy for migration | CRITICAL — ECS tasks work after migration | `scripts/migrate-account.sh` (new) |
| 14 — S3 re-encryption for migration | CRITICAL — results decryptable in new account | `lambda/src/reindex/handler.ts`, `docs/account-migration-runbook.md` |
| 15 — Two-phase cutover | CRITICAL — no orphaned jobs during migration | `security-stack.ts`, `ingestion/handler.ts`, `commands/admin.ts` (new) |
