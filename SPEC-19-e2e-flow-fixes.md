# Skills as a Service (SaaS) — Specification Part 19: E2E Flow Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** 10-agent E2E user story flow audit. 131 raw issues → 20 net-new critical fixes.  
**Parts:** ... | [Part 18](SPEC-18-comprehensive-audit-fixes.md) | [Part 19: E2E Flow Fixes]

---

## ROI Assessment

This round audited end-to-end user story flows rather than isolated components. ROI remained high — agents found architectural flaws invisible to per-component analysis. Stopping here: subsequent rounds would hit diminishing returns (style/docs rather than blockers).

---

## 20 Net-New Critical Issues

| # | Severity | Issue |
|---|----------|-------|
| 1 | **CRITICAL** | `lambda.Code.fromAsset('../packages/lambda/dist')` zips only compiled JS — `node_modules` excluded — every Lambda fails at runtime with "Cannot find module" |
| 2 | **CRITICAL** | Docker build context is `packages/ecs-runner/` — `packages/shared/` is outside context — `npm ci` for `@skills-svc/shared` fails with 404 from npm registry |
| 3 | **CRITICAL** | `kms:ViaService: s3.amazonaws.com` condition on UserRole `kms:Decrypt` — `envelopeDecrypt` calls KMS directly (not via S3) — `skills-svc results` and `diff` always return AccessDenied |
| 4 | **CRITICAL** | `assume-role` writes to single global `~/.skills-svc/credentials.json` — second `assume-role` overwrites first — multi-profile management is fundamentally broken |
| 5 | **CRITICAL** | `schedule create` uploads zip to `uploads/scheduled/` prefix — S3 event filter matches `uploads/` — every schedule creation fires the ingestion pipeline immediately |
| 6 | **BLOCKER** | Batch input files uploaded to S3 but `batch-submit` handler never passes input S3 key to ECS runner — per-job input data is ignored — batch is architecturally incomplete |
| 7 | **BLOCKER** | `--group-by skill` in `cost.ts` is silently unimplemented — falls through to default table — user sees wrong data without error |
| 8 | **BLOCKER** | `authorId` from `identity.Arn.split('/').pop()` returns session name for assumed roles — different on every `assume-role` — skill authorship is unstable across sessions |
| 9 | **BLOCKER** | No skill name ownership enforcement — any user can publish `someone-else-skill@2.0.0` — namespace squatting possible |
| 10 | **BLOCKER** | No `skills-svc retry <job-id>` command — engineer must manually reconstruct original parameters — error-prone incident recovery |
| 11 | **CORRECTNESS** | MCP HTTP transport `env` field for SigV4 credentials — Claude Code support for this field is assumed but never verified — entire MCP integration may be broken |
| 12 | **CORRECTNESS** | `skills-svc logs <job-id>` uses fixed 24-hour window — fails silently for jobs older than 1 day — engineer cannot diagnose historical failures |
| 13 | **CORRECTNESS** | No `skills-svc task-info <job-id>` command — engineer must use AWS Console to inspect ECS task resources/failure reasons |
| 14 | **CORRECTNESS** | SNS email notification subject lacks job ID — engineer must parse JSON body to find jobId |
| 15 | **CORRECTNESS** | `cost --group-by` option unvalidated — passing unsupported values falls through silently |
| 16 | **UX** | No `skills-svc init <name>` scaffolding command — new users must guess directory structure and manifest schema |
| 17 | **UX** | `skills-svc configure` never prints the discovered role ARN — user must find it manually for `assume-role` |
| 18 | **UX** | No `skills-svc diagnose` pre-flight check — error messages are AWS SDK errors, not actionable guidance |
| 19 | **UX** | `skills-svc job resolve <job-id>` and `skills-svc job note` commands missing — no way to mark investigated failures; DLQ alarm keeps firing |
| 20 | **UX** | Batch input files are uploaded but their purpose is never explained — users don't know the input-to-skill mapping model |

---

## Fix 1: Lambda Packaging — Include `node_modules`

**Problem:** `lambda.Code.fromAsset('../packages/lambda/dist')` zips only the `dist/` directory. Lambda needs `node_modules` at runtime. Every Lambda handler fails with `Cannot find module '@aws-sdk/client-s3'`.

**Solution:** Use CDK bundling with esbuild to bundle all dependencies into single files, eliminating the `node_modules` problem entirely.

**`infra/lib/lambda-stack.ts`** — replace all `lambda.Code.fromAsset` calls:

```typescript
import { execSync } from 'child_process';

// Pre-build Lambda package before CDK synthesis
// This ensures dist/ exists and is current
// Note: CDK synth runs this during synthesis, not at deploy time
const lambdaAsset = lambda.Code.fromAsset(path.join(__dirname, '../../packages/lambda'), {
  bundling: {
    image: lambda.Runtime.NODEJS_20_X.bundlingImage,
    local: {
      // Use local bundling (faster, uses host machine)
      tryBundle(outputDir: string): boolean {
        try {
          // Build the Lambda package
          execSync('npm run build', {
            cwd: path.join(__dirname, '../../packages/lambda'),
            stdio: 'inherit',
          });
          // Copy the built output and production node_modules
          execSync(`cp -r dist/* ${outputDir}/`, {
            cwd: path.join(__dirname, '../../packages/lambda'),
          });
          // Install production dependencies into the output
          execSync(`npm ci --production --prefix ${outputDir}`, {
            cwd: path.join(__dirname, '../../packages/lambda'),
            env: { ...process.env, npm_config_prefix: outputDir },
          });
          return true;
        } catch {
          return false; // Fall through to Docker bundling
        }
      },
    },
    command: [
      'bash', '-c',
      'npm ci && npm run build && cp -r dist/* /asset-output/ && cp -r node_modules /asset-output/',
    ],
  },
});

// Use this asset for ALL Lambda functions:
const sharedLambdaProps = {
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambdaAsset,
  // ... other props unchanged
};
```

**Simpler alternative** — point `fromAsset` at the package root with exclusions:

```typescript
lambda.Code.fromAsset(path.join(__dirname, '../../packages/lambda'), {
  exclude: [
    '*.ts',           // source files
    '*.test.js',      // test output
    'node_modules/.cache/**',
    'coverage/**',
    '.eslintrc*',
    'jest.config*',
    'tsconfig*',
  ],
});
```

This includes `node_modules/` and `dist/` in the zip. The zip is larger but all dependencies are present.

**Authoritative fix:** Use the simpler `fromAsset` with exclusions. Update ALL stack files that create Lambda functions:
- `infra/lib/lambda-stack.ts`
- `infra/lib/batch-stack.ts` (batch-submit, batch-status)
- `infra/lib/mcp-stack.ts` (MCP Lambda, authorizer)
- `infra/lib/skill-registry-stack.ts` (validator Lambda)
- `infra/lib/knowledge-store-stack.ts` (bootstrap Lambda)

---

## Fix 2: Docker Build — Resolve Workspace Dependencies

**Problem:** ECS runner Dockerfile build context is `packages/ecs-runner/`. `packages/shared/` is outside this context. `npm ci` fails trying to resolve `@skills-svc/shared@*` from npm registry.

**Solution:** Change Docker build context to the monorepo root. Update `scripts/build-push-ecs.sh`.

**`scripts/build-push-ecs.sh`** — change build context:

```bash
# REPLACE:
# docker build -t "$ECR_URI:$IMAGE_TAG" packages/ecs-runner/

# WITH (build from repo root, use packages/ecs-runner/Dockerfile):
docker build \
  -t "$ECR_URI:$IMAGE_TAG" \
  -f packages/ecs-runner/Dockerfile \
  .   # ← repo root as context
```

**`packages/ecs-runner/Dockerfile`** — update to reference correct paths from repo root:

```dockerfile
FROM node:20-slim AS builder
WORKDIR /build

# Copy workspace manifests for dependency resolution
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/ecs-runner/package.json ./packages/ecs-runner/

# Install all workspace deps (resolves @skills-svc/shared as local workspace)
RUN npm ci --workspaces --if-present --ignore-scripts

# Copy and build shared package first
COPY packages/shared/ ./packages/shared/
RUN npm run build -w packages/shared

# Build ecs-runner
COPY packages/ecs-runner/ ./packages/ecs-runner/
RUN npm run build -w packages/ecs-runner

FROM node:20-slim AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 runner && \
    useradd -u 1000 -g runner -s /bin/bash -m -d /home/runner runner

WORKDIR /app

# Copy built output and production node_modules
COPY --from=builder /build/packages/ecs-runner/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/packages/shared/dist ./node_modules/@skills-svc/shared/dist
COPY --from=builder /build/packages/shared/package.json ./node_modules/@skills-svc/shared/package.json

RUN mkdir -p /tmp/workspace && chown runner:runner /tmp/workspace

USER 1000:1000
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
```

---

## Fix 3: Remove `kms:ViaService` Condition from UserRole Decrypt

**Problem:** SPEC-12 Fix 22 adds `kms:Decrypt` to `UserRole` with condition `kms:ViaService: s3.amazonaws.com`. But `envelopeDecrypt` in `crypto.ts` calls `KMSClient.DecryptCommand` directly — not via S3. The `kms:ViaService` condition rejects direct KMS calls. Every `skills-svc results` and `skills-svc diff` fails with AccessDenied.

**`infra/lib/security-stack.ts`** — fix UserRole KMS policy:

```typescript
// REPLACE the condition-restricted KMS policy:
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'DecryptResultsForCLI',
  actions: ['kms:Decrypt'],
  resources: [this.resultsBucketKey.keyArn],
  conditions: {
    // REMOVE kms:ViaService — envelopeDecrypt calls KMS directly
    // Only scope by account and region to prevent cross-account usage
    StringEquals: { 'aws:RequestedRegion': this.region },
    StringLike: { 'kms:EncryptionContext:purpose': 'skills-svc-result' },
  },
}));
```

The `kms:EncryptionContext:purpose` condition ensures the UserRole can only decrypt envelope-encrypted results (not arbitrary data encrypted with the results key).

---

## Fix 4: Per-Profile Credential Storage

**Problem:** `assume-role` writes to `~/.skills-svc/credentials.json` — a single global file. The second `assume-role` for a different profile overwrites the first. Multi-profile credential management is impossible.

**`packages/cli/src/utils/config.ts`** — add profile-scoped credentials:

```typescript
const PROFILE_CREDS_FILE = (profileName: string) =>
  path.join(CONFIG_DIR, 'profiles', `${profileName}.credentials.json`);
const LEGACY_CREDS_FILE = path.join(CONFIG_DIR, 'credentials.json');

export function getCredentialsFile(profileName?: string): string {
  const name = profileName ?? getDefaultProfileName();
  return PROFILE_CREDS_FILE(name);
}
```

**`packages/cli/src/commands/assume-role.ts`** — write to profile-scoped file:

```typescript
const profileName = process.env.SKILLS_SVC_PROFILE ?? getDefaultProfileName();
const credsFile = getCredentialsFile(profileName);

mkdirSync(path.dirname(credsFile), { recursive: true });
writeFileSync(credsFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
console.log(chalk.green(`✓ Credentials stored for profile "${profileName}": ${credsFile}`));
```

**`packages/cli/src/utils/aws-clients.ts`** — read from profile-scoped file:

```typescript
export async function getCredentialProvider(): Promise<...> {
  const profileName = process.env.SKILLS_SVC_PROFILE ?? getDefaultProfileName();
  const credsFile = getCredentialsFile(profileName);

  // Fall back to legacy global file for backward compatibility
  const file = existsSync(credsFile) ? credsFile
    : existsSync(LEGACY_CREDS_FILE) ? LEGACY_CREDS_FILE
    : null;
  // ...
}
```

**`packages/cli/src/commands/profile.ts`** — show credential status in `profile list`:

```typescript
// In profile list action, add credential status column:
const credsFile = getCredentialsFile(name);
const hasCreds = existsSync(credsFile);
const credsExpired = hasCreds
  ? new Date(JSON.parse(readFileSync(credsFile, 'utf-8')).expiration) <= new Date()
  : false;

const credStatus = !hasCreds ? chalk.dim('no creds')
  : credsExpired ? chalk.red('expired')
  : chalk.green('active');

// Add to table row: [name, isDefault, envName, region, accountId, credStatus]
```

---

## Fix 5: Schedule Create — Use Non-Ingestion S3 Prefix

**Problem:** `schedule create` uploads the permanent skills zip to `uploads/scheduled/{scheduleId}/skills.zip`. The S3 event notification filter matches `prefix: 'uploads/'` — every schedule creation immediately fires the ingestion pipeline. The "stored zip" is supposed to be passive.

**`packages/cli/src/commands/schedule.ts`** — change the upload prefix:

```typescript
// REPLACE:
// const scheduleS3Key = `uploads/scheduled/${scheduleId}/${path.basename(zipPath)}`;

// WITH (use a separate prefix that the S3 event notification does NOT watch):
const scheduleS3Key = `skill-schedules/${scheduleId}/skill.zip`;
```

**`infra/lib/messaging-stack.ts`** — update S3 event notification to exclude the schedule prefix:

The existing notification filter `{ prefix: 'uploads/', suffix: '.zip' }` now correctly excludes `skill-schedules/`. No change needed to the notification — just ensure the schedule upload uses a different prefix.

**`packages/lambda/src/schedule-trigger/handler.ts`** — update the CopySource reference:

```typescript
// Source key now comes from event.scheduleS3Key (stored in the schedule config)
// which points to skill-schedules/{scheduleId}/skill.zip
const registryS3Key = event.scheduleS3Key;  // e.g. "skill-schedules/abc12345/skill.zip"
```

**SSM param update** — store the schedule S3 key format. When `schedule create` saves config, store `scheduleS3KeyPrefix: 'skill-schedules'`.

---

## Fix 6: Batch — Pass Input File Key to ECS Runner

**Problem:** Batch uploads input files to `uploads/batch/{batchId}/inputs/{index}-{basename}` but never passes this key to the ECS runner. The per-job input is ignored.

**`packages/lambda/src/batch-submit/handler.ts`** — add input file key to CopyObjectCommand metadata:

```typescript
await s3.send(new CopyObjectCommand({
  Bucket: uploadsBucket,
  CopySource: `${event.skillsS3Bucket}/${event.skillsS3Key}`,
  Key: destKey,
  ServerSideEncryption: 'aws:kms',
  SSEKMSKeyId: uploadsKmsKeyArn,
  MetadataDirective: 'REPLACE',
  Metadata: {
    'job-name':        `${event.batchJobName}-${event.inputIndex}`,
    'user-arn':        event.userArn,
    'batch-id':        event.batchId,
    'batch-input-key': event.input.s3Key,      // ADD — S3 key of input file
    'batch-input-file': event.input.originalFile, // ADD — display name
    'run-id':          runId,
    ...(event.useCache ? {} : { 'no-cache': 'true' }),
  },
}));
```

**`packages/lambda/src/ingestion/handler.ts`** — store input key in DDB:

```typescript
const batchInputKey = head.Metadata?.['batch-input-key'];
const batchInputFile = head.Metadata?.['batch-input-file'];

// Add to PutCommand Item:
...(batchInputKey ? { batchInputKey, batchInputFile } : {}),
```

**`packages/ecs-runner/src/main.ts`** — read and expose input key:

```typescript
const batchInputKey = process.env.BATCH_INPUT_KEY;  // set from job DDB metadata via env

// If this is a batch job with an input file, download it
if (batchInputKey) {
  const inputPath = await downloadFile(s3Bucket, batchInputKey, '/tmp/workspace/input-data.json');
  process.env.SKILL_INPUT_FILE = inputPath;  // skill can read this env var
}
```

**`packages/ecs-runner/src/runner.ts`** — include input data in Bedrock prompt:

```typescript
// If input file exists, include it in the prompt
let inputContext = '';
if (process.env.SKILL_INPUT_FILE) {
  try {
    const inputContent = await readFile(process.env.SKILL_INPUT_FILE, 'utf-8');
    inputContext = `\n\n## Input Data\n\n${inputContent.slice(0, 50_000)}`; // 50KB limit
  } catch { /* input file optional */ }
}

const userMessage = `Here are the skill definitions:\n\n${skillsContext}\n\n---\n\n${userPrompt}${inputContext}`;
```

---

## Fix 7: `cost.ts` — Validate `--group-by` and Implement `skill` Grouping

```typescript
// REPLACE option definition:
.option('--group-by <field>', 'Group by: day|week|skill|status')

// Add validation:
const validGroupBy = ['day', 'week', 'skill', 'status'];
if (opts.groupBy && !validGroupBy.includes(opts.groupBy)) {
  console.error(chalk.red(`Invalid --group-by value: "${opts.groupBy}". Valid: ${validGroupBy.join(', ')}`));
  process.exit(1);
}

// ADD skill grouping implementation:
if (opts.groupBy === 'skill') {
  const bySkill: Record<string, { count: number; cost: number }> = {};
  for (const j of allJobs) {
    const skillKey = j.skillName ? `${j.skillName}@${j.skillVersion}` : '(direct upload)';
    bySkill[skillKey] = bySkill[skillKey] ?? { count: 0, cost: 0 };
    bySkill[skillKey].count++;
    bySkill[skillKey].cost += j.totalUsd;
  }
  prettyTable([
    ['Skill', 'Runs', 'Total Cost'],
    ...Object.entries(bySkill)
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([skill, { count, cost }]) => [
        skill, String(count), `$${cost.toFixed(4)}`,
      ]),
    ['TOTAL', String(allJobs.length), chalk.bold(`$${totalUsd.toFixed(4)}`)],
  ]);
  return;
}
```

---

## Fix 8: Stable `authorId` for Skill Registry

**`packages/cli/src/commands/skill.ts`** — already specced in SPEC-18 Fix 14. Verify `deriveAuthorId` is applied.

Additionally, store the stable `authorId` in the skill META record so future queries always find Alice's skills regardless of current session:

```typescript
// In skill validator Lambda, extract stable ID from authorArn:
function extractStableId(arn: string): string {
  const parts = arn.split(':');
  const resource = parts[5]; // e.g. 'assumed-role/UserRole/alice-session'
  const segments = resource.split('/');
  if (segments[0] === 'assumed-role') return segments[1]; // 'UserRole' — stable
  if (segments[0] === 'user') return segments.pop()!;     // 'alice' — stable
  return parts[4]; // account ID as fallback
}
```

---

## Fix 9: Skill Name Ownership Enforcement

**`packages/lambda/src/skill-validator/handler.ts`** — add ownership check when pushing a new version:

```typescript
// After fetching the existing META record:
const existingMeta = await ddb.send(new GetCommand({
  TableName: skillsTableName,
  Key: { PK: `SKILL#${skillName}`, SK: 'META' },
}));

if (existingMeta.Item) {
  // Skill name already owned — verify the pusher matches the original author's stable ID
  const existingAuthorStableId = existingMeta.Item.authorStableId as string;
  const currentStableId = extractStableId(authorArn);
  
  if (existingAuthorStableId !== currentStableId) {
    await writeFailedVersion(skillsTableName, skillName, version, authorArn, key,
      `Skill name "${skillName}" is owned by "${existingAuthorStableId}". ` +
      `Only the original author can publish new versions.`
    );
    console.error(JSON.stringify({ event: 'ownership_violation', skillName, attemptedBy: currentStableId, owner: existingAuthorStableId }));
    continue;
  }
}
```

Store `authorStableId` in the META record:

```typescript
// In the META PutCommand Item:
authorStableId: extractStableId(authorArn),
```

---

## Fix 10: `skills-svc retry <job-id>` Command

**`packages/cli/src/commands/retry.ts`** (new file):

```typescript
import { Command } from 'commander';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { DDB_KEY_PREFIX, JobStatus, RunSkillInput } from '@skills-svc/shared';
import { prettyTable } from '../utils/pretty-print';

export function retryCommand(): Command {
  return new Command('retry')
    .description('Re-run a failed or completed job with the same skill and parameters')
    .argument('<job-id>', 'Job ID to retry')
    .option('--version <ver>', 'Override skill version (default: same as original)')
    .option('--job-name <name>', 'Override job name (default: original-name-retry-N)')
    .option('--stream', 'Stream logs after submission', false)
    .action(async (jobId: string, opts: { version?: string; jobName?: string; stream: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const sts   = new STSClient({ region: cfg.region, credentials: creds });
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });
      const lam   = new LambdaClient({ region: cfg.region, credentials: creds });

      // Fetch original job
      const res = await ddb.send(new GetCommand({
        TableName: cfg.dynamodbTableName,
        Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
      }));
      if (!res.Item) {
        console.error(chalk.red(`Job not found: ${jobId}`));
        process.exit(1);
      }

      const original = res.Item;
      if (!original.skillName || !original.skillVersion) {
        console.error(chalk.red(
          `Job ${jobId} was submitted via direct upload, not via skill registry. ` +
          `Cannot retry — no skill reference available. Use: skills-svc run --skill <name@version>`
        ));
        process.exit(1);
      }

      const skillRef = `${original.skillName}@${opts.version ?? original.skillVersion}`;
      const newJobName = opts.jobName ?? `${original.jobName}-retry-${Date.now()}`;
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      const runSkillFnArn = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/lambda/run-skill-function-arn`,
      })).then(r => r.Parameter!.Value!).catch(() => cfg.runSkillLambdaArn);

      console.log(chalk.blue(`Retrying job ${jobId.slice(0, 8)}...`));
      console.log(chalk.dim(`  Original: ${original.skillName}@${original.skillVersion}`));
      console.log(chalk.dim(`  Retry as: ${skillRef} — "${newJobName}"`));

      const { name, version: resolvedVersion } = parseSkillRef(skillRef);

      const invocation = await lam.send(new InvokeCommand({
        FunctionName: runSkillFnArn,
        Payload: JSON.stringify({
          skillName:    name,
          skillVersion: resolvedVersion,
          jobName:      newJobName,
          userArn:      identity.Arn,
        } satisfies RunSkillInput),
      }));

      if (invocation.FunctionError) {
        const err = JSON.parse(Buffer.from(invocation.Payload!).toString());
        console.error(chalk.red(`Retry failed: ${err.errorMessage ?? 'Unknown error'}`));
        process.exit(1);
      }

      const { runId } = JSON.parse(Buffer.from(invocation.Payload!).toString());
      console.log(chalk.green(`✓ Retry submitted (runId: ${runId})`));
      console.log(`  Track: ${chalk.cyan(`skills-svc list-jobs --status PENDING`)}`);
    });
}
```

Register in `index.ts`: `program.addCommand(retryCommand())`.

---

## Fix 11: MCP Credential Handling — Document and Fallback

**The critical unknown:** Claude Code's MCP HTTP transport `env` field behavior for SigV4 signing is unverified. Add explicit documentation and a testable fallback.

**`packages/cli/src/commands/mcp-config.ts`** — add verification output:

```typescript
// After writing config, output a test command:
console.log(chalk.bold('\nTo verify MCP connectivity:'));
console.log(chalk.cyan(`  curl -X POST "${mcpEndpoint}" \\`));
console.log(chalk.cyan(`    -H "Content-Type: application/json" \\`));
console.log(chalk.cyan(`    -H "Authorization: AWS4-HMAC-SHA256 ..." \\`));
console.log(chalk.cyan(`    --aws-sigv4 "aws:amz:${cfg.region}:execute-api" \\`));
console.log(chalk.cyan(`    -d '{"jsonrpc":"2.0","method":"ping","id":1}'`));
console.log();
console.log(chalk.dim('Note: Claude Code must support env-based SigV4 signing.'));
console.log(chalk.dim('If MCP tools return 403, Claude Code may not support this auth method.'));
console.log(chalk.dim('Check Claude Code release notes for HTTP MCP SigV4 support.'));
```

**Spec note for implementors:** If Claude Code does not support `env`-based SigV4, the `HttpIamAuthorizer` must be replaced with an API key authorizer (similar to what SPEC-13 Fix 12 specified before Claude Desktop was removed, but adapted for Claude Code specifically). This is a critical open item requiring validation before production deployment.

---

## Fix 12: `logs` Command — Use Job `createdAt` as Window

**`packages/cli/src/commands/logs.ts`** — fix the time window:

```typescript
// In non-follow path:
// First fetch the job to get its timestamp
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
const jobRes = await ddb.send(new GetCommand({
  TableName: cfg.dynamodbTableName,
  Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
}));

const jobCreatedAt = jobRes.Item?.createdAt
  ? new Date(jobRes.Item.createdAt as string).getTime() - 60_000
  : Date.now() - 24 * 60 * 60 * 1000; // fallback to 24h

const jobCompletedAt = jobRes.Item?.completedAt
  ? new Date(jobRes.Item.completedAt as string).getTime() + 5 * 60 * 1000 // 5min buffer
  : Date.now();

// Warn if outside CloudWatch retention
const ageMs = Date.now() - jobCreatedAt;
const cwRetentionMs = 90 * 24 * 60 * 60 * 1000; // 3 months
if (ageMs > cwRetentionMs) {
  console.warn(chalk.yellow(`⚠  Job is older than CloudWatch retention (90 days) — logs may not be available`));
}

const res = await cwl.send(new FilterLogEventsCommand({
  logGroupName: logGroup,
  filterPattern: `{ $.jobId = "${jobId}" }`,
  startTime: jobCreatedAt,
  endTime: jobCompletedAt,
  limit: parseInt(opts.tail, 10),
}));
```

---

## Fix 13: SNS Email — Include Job ID in Subject

**`packages/lambda/src/results-processor/handler.ts`:**

```typescript
await sns.send(new PublishCommand({
  TopicArn: topicArn,
  // ADD job ID prefix to subject for quick identification from email client:
  Subject: `[${jobId.slice(0, 8)}] Skills SaaS Job ${newStatus}: ${current.Item.jobName}`,
  Message: JSON.stringify(notification, null, 2),
  MessageAttributes: { ... },
}));
```

Same pattern for cancel.ts SNS publish.

---

## Fix 14: `skills-svc init <name>` — Scaffold Directory

**`packages/cli/src/commands/init.ts`** (new file):

```typescript
import { Command } from 'commander';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export function initCommand(): Command {
  return new Command('init')
    .description('Scaffold a new skill directory with manifest.json and example skill file')
    .argument('<name>', 'Skill name (lowercase, hyphens, e.g. "my-analyzer")')
    .option('--dir <path>', 'Output directory (default: ./<name>)')
    .action((name: string, opts: { dir?: string }) => {
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
        console.error(chalk.red('Skill name must be lowercase alphanumeric with hyphens'));
        process.exit(1);
      }

      const outDir = opts.dir ?? `./${name}`;
      if (existsSync(outDir)) {
        console.error(chalk.red(`Directory already exists: ${outDir}`));
        process.exit(1);
      }

      mkdirSync(path.join(outDir, 'skills'), { recursive: true });

      writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
        jobName: name,
        version: '1.0.0',
        skills: ['analyzer'],
        defaultPrompt: 'Analyze the provided skill definitions and summarize their capabilities.',
        description: 'Add a description of what this skill does.',
        tags: { category: 'analysis' },
      }, null, 2));

      writeFileSync(path.join(outDir, 'skills', 'analyzer.md'), [
        `# ${name} Skill`,
        '',
        '## Purpose',
        'Describe what this skill does.',
        '',
        '## Instructions',
        'When analyzing content:',
        '1. Identify the main theme',
        '2. Extract key insights',
        '3. Provide a summary',
        '',
        '## Output Format',
        'Return a structured JSON with:',
        '- summary: one-paragraph overview',
        '- keyPoints: list of main findings',
        '- recommendations: actionable next steps',
      ].join('\n'));

      writeFileSync(path.join(outDir, '.gitignore'), '*.zip\n');

      console.log(chalk.green(`✓ Scaffolded: ${outDir}/`));
      console.log('');
      console.log('  Next steps:');
      console.log(`  1. Edit ${chalk.cyan(`${outDir}/skills/analyzer.md`)} with your skill logic`);
      console.log(`  2. ${chalk.cyan(`skills-svc validate ${outDir}/`)} — check for errors`);
      console.log(`  3. ${chalk.cyan(`skills-svc skill push ${outDir}/ --name ${name} --version 1.0.0`)}`);
    });
}
```

Register in `index.ts`: `program.addCommand(initCommand())`.

---

## Fix 15: `configure` — Print Discovered Role ARN

**`packages/cli/src/commands/configure.ts`** — after discovering stack outputs:

```typescript
// After writing config, print the role ARN:
const userRoleArn = `arn:aws:iam::${opts.account}:role/skills-svc-user-${opts.env}`;

console.log(chalk.green(`✓ Profile "${opts.profile}" configured`));
console.log('');
console.log(chalk.bold('Next step — assume your IAM role:'));
console.log(chalk.cyan(`  skills-svc assume-role --role-arn ${userRoleArn}`));
console.log('');
console.log(chalk.dim('(If this role ARN is wrong, check the SecurityStack CDK output)'));
```

---

## Fixes 16–20: Minor UX (consolidated)

**Fix 16 — `skills-svc diagnose`:** Implement as shown in new-user onboarding agent ISSUE-025. Check credentials, config, SSM params, DDB, S3 buckets. One command tells the user if everything is correctly configured.

**Fix 17 — `skills-svc job resolve <job-id>`:** Add DDB UpdateCommand setting `resolvedAt`, `resolvedBy`, optional `resolutionNote`. `list-jobs --status FAILED` by default excludes resolved jobs; add `--include-resolved` flag.

**Fix 18 — `skills-svc task-info <job-id>`:** Calls `ecs.DescribeTasksCommand` to show CPU/memory, exit code, stop reason. Requires adding `ecs:DescribeTasks` to UserRole.

**Fix 19 — Improve error messages throughout:** Every AWS SDK error caught at the CLI boundary should be enriched. Add a helper:
```typescript
function enrichAwsError(err: Error, context: string): never {
  if (err.name === 'AccessDenied') {
    throw new Error(`Access denied ${context}. Check your IAM permissions or re-run assume-role.`);
  }
  if (err.name === 'ParameterNotFound') {
    throw new Error(`Config parameter not found ${context}. Infrastructure may not be fully deployed.`);
  }
  throw err;
}
```

**Fix 20 — Document batch input file model:** Add to `batch run --help`:
```
NOTE: Input files (--inputs) are uploaded to S3 and made available to the ECS
runner at /tmp/workspace/input-data.json. Your skill's defaultPrompt can reference
this file for per-job data. Each job receives one input file; the skill zip is shared.
```

---

## Updated `packages/cli/src/index.ts`

```typescript
import { retryCommand } from './commands/retry';
import { initCommand }  from './commands/init';

program.addCommand(retryCommand());
program.addCommand(initCommand());
```

---

## QA Checks (QA-249 through QA-258)

```typescript
// QA-249: Lambda Code asset includes node_modules
test('QA-249: Lambda fromAsset includes node_modules in packaged zip', () => {
  // After building, the Lambda asset should include node_modules
  const source = readFileSync('infra/lib/lambda-stack.ts', 'utf-8');
  // Should NOT point to dist/ only
  expect(source).not.toContain("fromAsset('../packages/lambda/dist')");
  // Should use package root OR bundling
  expect(source).toMatch(/fromAsset.*packages\/lambda['")\s]/);
});

// QA-250: UserRole kms:Decrypt has no kms:ViaService condition
test('QA-250: UserRole kms:Decrypt does not use kms:ViaService condition', () => {
  const { templates } = buildTestApp();
  const roles = templates.security.findResources('AWS::IAM::Role');
  const userRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('skills-svc-user')
  ) as any;
  const stmts = userRole.Properties.Policies
    ?.flatMap((p: any) => p.PolicyDocument.Statement) ?? [];
  const decryptStmt = stmts.find((s: any) => s.Sid === 'DecryptResultsForCLI');
  // Must NOT have kms:ViaService condition
  expect(JSON.stringify(decryptStmt?.Condition ?? {})).not.toContain('kms:ViaService');
});

// QA-251: assume-role writes to profile-scoped credentials file
test('QA-251: assume-role writes credentials to profile-specific file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa251-'));
  process.env.HOME = tmpDir;
  // Run assume-role with --profile staging
  process.env.SKILLS_SVC_PROFILE = 'staging';
  // ... mock STS ...
  await runAssumeRole({ roleArn: 'arn:test', sessionName: 'test' });
  expect(fs.existsSync(path.join(tmpDir, '.skills-svc', 'profiles', 'staging.credentials.json'))).toBe(true);
  expect(fs.existsSync(path.join(tmpDir, '.skills-svc', 'credentials.json'))).toBe(false);
});

// QA-252: schedule create uploads to skill-schedules/ prefix
test('QA-252: schedule create uses skill-schedules/ prefix not uploads/', () => {
  const source = readFileSync('packages/cli/src/commands/schedule.ts', 'utf-8');
  expect(source).toContain('skill-schedules/');
  expect(source).not.toContain('`uploads/scheduled/');
});

// QA-253: batch-submit handler sets batch-input-key metadata
test('QA-253: batch-submit Lambda sets batch-input-key in S3 metadata', () => {
  const source = readFileSync('packages/lambda/src/batch-submit/handler.ts', 'utf-8');
  expect(source).toContain("'batch-input-key'");
  expect(source).toContain('event.input.s3Key');
});

// QA-254: cost --group-by validates options
test('QA-254: cost command validates --group-by values', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  await expect(runCost({ groupBy: 'invalid-option' })).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-255: skill validator enforces ownership
test('QA-255: skill validator rejects push from non-owner', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  // Existing skill owned by 'alice'
  ddbMock.on(GetCommand).resolves({
    Item: { authorStableId: 'alice', skillName: 'my-skill' }
  });
  ddbMock.on(PutCommand).resolves({});
  // Bob (stableId: 'bob') tries to push
  const event = makeS3Event({ authorArn: 'arn:aws:iam::123:user/bob' });
  await handler(event, {} as any, {} as any);
  // PutCommand should write FAILED status
  const putCall = ddbMock.commandCalls(PutCommand)[0];
  expect(putCall.args[0].input.Item.status).toBe('failed');
  expect(putCall.args[0].input.Item.validationError).toContain('ownership');
});

// QA-256: retry command exists in CLI
test('QA-256: retryCommand is registered in index.ts', () => {
  const source = readFileSync('packages/cli/src/index.ts', 'utf-8');
  expect(source).toContain('retryCommand');
  expect(source).toContain("addCommand(retryCommand())");
});

// QA-257: init command creates correct directory structure
test('QA-257: skills-svc init creates manifest.json with required fields', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa257-'));
  await runInit('test-skill', { dir: path.join(tmpDir, 'test-skill') });
  const manifest = JSON.parse(fs.readFileSync(
    path.join(tmpDir, 'test-skill', 'manifest.json'), 'utf-8'
  ));
  expect(manifest.jobName).toBe('test-skill');
  expect(manifest.version).toBe('1.0.0');
  expect(Array.isArray(manifest.skills)).toBe(true);
  expect(fs.existsSync(path.join(tmpDir, 'test-skill', 'skills', 'analyzer.md'))).toBe(true);
});

// QA-258: Dockerfile uses repo root as build context
test('QA-258: build-push-ecs.sh uses repo root as Docker build context', () => {
  const source = readFileSync('scripts/build-push-ecs.sh', 'utf-8');
  // Build command should end with '.' (current dir = repo root), not 'packages/ecs-runner/'
  expect(source).toMatch(/docker build.*\s\.\s*$/m);
  expect(source).toContain('-f packages/ecs-runner/Dockerfile');
});
```

---

## Summary

| Fix | Impact | Files Changed |
|-----|--------|--------------|
| 1 — Lambda node_modules packaging | CRITICAL — all Lambda deployments fail without this | `lambda-stack.ts`, `batch-stack.ts`, `mcp-stack.ts`, `skill-registry-stack.ts` |
| 2 — Docker workspace deps | CRITICAL — ECS image never builds | `Dockerfile`, `build-push-ecs.sh` |
| 3 — Remove kms:ViaService condition | CRITICAL — results/diff commands always fail | `security-stack.ts` |
| 4 — Per-profile credentials | CRITICAL — multi-profile broken | `config.ts`, `assume-role.ts`, `aws-clients.ts` |
| 5 — Schedule upload prefix | CRITICAL — schedule create fires pipeline | `schedule.ts` |
| 6 — Batch input to ECS | BLOCKER — batch per-job input ignored | `batch-submit/handler.ts`, `main.ts`, `runner.ts` |
| 7 — cost --group-by skill | BLOCKER — silent wrong output | `commands/cost.ts` |
| 8 — Stable authorId | BLOCKER — skill ownership breaks | `commands/skill.ts` (SPEC-18 Fix 14 already specced) |
| 9 — Skill ownership | BLOCKER — namespace squatting | `skill-validator/handler.ts` |
| 10 — retry command | BLOCKER — operational gap | `commands/retry.ts` (new) |
| 11 — MCP credential note | CORRECTNESS — architecture risk | `commands/mcp-config.ts` |
| 12 — logs time window | CORRECTNESS — old jobs invisible | `commands/logs.ts` |
| 13 — SNS subject with job ID | CORRECTNESS — UX for incident response | `results-processor/handler.ts` |
| 14 — init command | UX — new user onboarding | `commands/init.ts` (new) |
| 15 — configure prints role ARN | UX — new user onboarding | `commands/configure.ts` |
| 16–20 — diagnose/resolve/task-info/errors/docs | UX | Multiple files |
