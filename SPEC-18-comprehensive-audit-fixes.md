# Skills as a Service (SaaS) — Specification Part 18: Comprehensive Audit Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** Third round 10-agent deep audit. 202 raw issues → 25 net-new real issues.  
**Parts:** ... | [Part 17](SPEC-17-deep-audit-fixes.md) | [Part 18: Comprehensive Audit Fixes]

---

## False Positives Excluded

- `attribute_not_exists(PK)` in DDB ConditionExpression — `PK` is not a reserved word; no ExpressionAttributeNames mapping needed
- DDB ISSUE-006 (duplicate `:pk` in cache.ts) — already fixed by SPEC-15 Fix 5
- `glob.sync()` in batch.ts — already flagged; fix below
- ECS health check failure for exiting tasks — AWS ignores health check once task is STOPPED
- Workspace circular dependency — DAG is acyclic (shared ← lambda/cli/knowledge-store/ecs-runner)
- `AwsSigv4Signer` import (`aws-v3`) — already fixed in SPEC-17 Fix 7
- ExpressionAttributeNames for `#status` in skill validator — `status` is not a DDB reserved word; `#status` mapping is optional but harmless

---

## 25 Net-New Issues

| # | Severity | Issue |
|---|----------|-------|
| 1 | **BLOCKER** | `ComprehendPII` Sid missing from `WILDCARD_EXCEPTION_SIDS` in `NoWildcardIAMAspect` — CDK synth fails |
| 2 | **BLOCKER** | `ingestionLambdaRole` never granted DDB write on skills table — `totalRuns` increment always throws AccessDenied |
| 3 | **BLOCKER** | `mcpLambdaRole` never granted DDB GetItem/Query on skills table — `skill_ref` resolution in submit_job fails |
| 4 | **BLOCKER** | ECS custom metric `skills-svc/ECS/TaskFailures` never emitted — results-processor logs failure but never calls `PutMetricData` — ECS failure alarm always reads 0 |
| 5 | **BLOCKER** | `glob.sync()` removed in glob v10 — batch.ts uses it → runtime crash on `batch run` |
| 6 | **BLOCKER** | CLI `src/index.ts` missing `#!/usr/bin/env node` shebang — `npm install -g` produces unexecutable binary |
| 7 | **BLOCKER** | LambdaStack and ECSStack deploy in parallel but ingestion Lambda reads ECS SSM params (`ecs/cluster-arn`, `ecs/task-definition-arn`) at runtime — race condition if ECS deploys after Lambda processes first job |
| 8 | **BLOCKER** | SecurityStack never writes `/skills-svc/{env}/kms/uploads-key-id` or `/skills-svc/{env}/kms/results-key-id` SSM params — CLI skill push and ECS runner read them → SSM 404 |
| 9 | **BLOCKER** | `#ver` used in `updateJobStatus` UpdateExpression but `ExpressionAttributeNames` maps `#version` — DDB validation error on every job status update |
| 10 | **BLOCKER** | Ingestion Lambda never writes `GSI4PK` (cache key) to the job DDB record — cache feature is entirely non-functional |
| 11 | **BLOCKER** | Ingestion Lambda never writes `GSI3PK`/`GSI3SK` for scheduled jobs — schedule history query always empty |
| 12 | **BLOCKER** | `skill pull --unzip` then `skill push` roundtrip broken — `zipDirectory` adds directory name as archive prefix, not manifest at root |
| 13 | **BLOCKER** | `batch results --failed-only` loses `:pk` and `:prefix` from `ExpressionAttributeValues` — DDB query validation error |
| 14 | **CORRECTNESS** | `authorId` derived from `identity.Arn.split('/').pop()` returns session name for assumed roles — S3 skill key changes between sessions |
| 15 | **CORRECTNESS** | `submit_job` MCP tool 10MB limit is effectively 7.5MB — base64 encoding adds 33% overhead, API Gateway rejects 13.3MB payload |
| 16 | **CORRECTNESS** | `diff` command fetches S3 result without checking `status === COMPLETE` first — cryptic S3 `NoSuchKey` error for running jobs |
| 17 | **CORRECTNESS** | `validate` command never checks `.zip` extension — user passing `.tar.gz` gets magic-byte error not "must be .zip" |
| 18 | **CORRECTNESS** | `--profile` global option has no `.description()` text — help output shows `--profile <name>` with no explanation |
| 19 | **CORRECTNESS** | Root `npm run build --workspaces` runs packages in parallel — `shared` must finish before `lambda`/`knowledge-store`/`cli` start |
| 20 | **CORRECTNESS** | `packages/shared/tsconfig.json` missing `declaration: true` and `declarationMap: true` — type imports from other packages fail |
| 21 | **MONITORING** | `queryFn`, `runSkillFn`, `scheduleTriggerFn`, `skillValidatorFn` have no CloudWatch error alarms — all new Lambdas from SPEC-07+ unmonitored |
| 22 | **MONITORING** | `results-processor` never calls `PutMetricData` for ECS failures — must emit `skills-svc/ECS/TaskFailures` metric to populate the alarm |
| 23 | **MONITORING** | ECS runner log events missing `jobId` field — `zip_downloaded`, `checksum_verified`, `workspace_cleared` cannot be filtered by job |
| 24 | **MONITORING** | `BedrockRuntimeClient` in ECS runner not wrapped with `captureAWSv3Client` — Bedrock calls invisible in X-Ray |
| 25 | **MONITORING** | CloudTrail data events missing registry bucket — skill pushes not audited at data-event level |

---

## Fix 1: `NoWildcardIAMAspect` — Add `ComprehendPII` to Exception Set

**`infra/aspects/no-wildcard-iam.ts`:**

```typescript
const WILDCARD_EXCEPTION_SIDS = new Set([
  'XRayWrite',      // X-Ray has no resource-level restrictions (documented)
  'ComprehendPII',  // ADD — Comprehend DetectPiiEntities has no resource-level restrictions
]);
```

---

## Fix 2: `ingestionLambdaRole` — Add Skills Table Write for `totalRuns`

**`infra/lib/security-stack.ts`** — add to `ingestionLambdaRole` inline policies:

```typescript
this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'SkillsTableTotalRuns',
  actions: ['dynamodb:UpdateItem'],
  resources: [
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-skills-${this.account}-${this.region}`,
  ],
}));
```

**`packages/lambda/src/ingestion/handler.ts`** — add after successful ECS task submission:

```typescript
// Increment totalRuns on the skill META record (only for skill-referenced jobs)
if (skillName && skillVersion) {
  const skillsTableName = await getParam(`/skills-svc/${env}/registry/skills-table-name`);
  await ddb.send(new UpdateCommand({
    TableName: skillsTableName,
    Key: { PK: `SKILL#${skillName}`, SK: 'META' },
    UpdateExpression: 'ADD totalRuns :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
}
```

---

## Fix 3: `mcpLambdaRole` — Add Skills Table Read

**`infra/lib/mcp-stack.ts`** — add to `mcpLambdaRole` policies:

```typescript
mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadSkillsTableForRef',
  actions: ['dynamodb:GetItem', 'dynamodb:Query'],
  resources: [
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-skills-${this.account}-${this.region}`,
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-skills-${this.account}-${this.region}/index/*`,
  ],
}));
```

---

## Fix 4: Emit ECS Failure Metric from Results Processor

**`packages/lambda/src/results-processor/handler.ts`** — add CloudWatch metric emission on ECS failure:

```typescript
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const cloudwatch = new CloudWatchClient({});

// In the handler, after determining exitCode != 0:
if (!succeeded) {
  // Emit metric for the ECS failure alarm to consume
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: 'skills-svc/ECS',
    MetricData: [{
      MetricName: 'TaskFailures',
      Value: 1,
      Unit: 'Count',
      Dimensions: [{ Name: 'Environment', Value: env }],
    }],
  })).catch(err => console.error(JSON.stringify({ event: 'metric_emit_error', err: String(err) })));
}
```

**Add `cloudwatch:PutMetricData` to `resultsLambdaRole`:**

```typescript
this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'EmitECSMetric',
  actions: ['cloudwatch:PutMetricData'],
  resources: ['*'],  // PutMetricData has no resource-level restrictions
}));
```

Add `'EmitECSMetric'` to `WILDCARD_EXCEPTION_SIDS` in the Aspect.

**Add `@aws-sdk/client-cloudwatch` to Lambda package.json:**

```json
"@aws-sdk/client-cloudwatch": "^3.600.0"
```

---

## Fix 5: `batch.ts` — Fix `glob.sync` for glob v10

glob v10 renamed `sync` to `globSync`:

**`packages/cli/src/commands/batch.ts`:**

```typescript
// REPLACE:
// import * as glob from 'glob';
// const inputFiles = glob.sync(opts.inputs);

// WITH (glob v10 API):
import { globSync } from 'glob';
const inputFiles = globSync(opts.inputs);
```

---

## Fix 6: CLI Entry — Add Shebang

**`packages/cli/src/index.ts`** — first line:

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
// ... rest of file unchanged
```

TypeScript preserves the shebang line in output. Verify `packages/cli/dist/index.js` starts with `#!/usr/bin/env node` after build.

---

## Fix 7: LambdaStack → ECSStack Dependency

LambdaStack reads ECS SSM params at runtime (not at deploy time), so there's no CDK circular dependency. However, to guarantee ECSStack deploys before any jobs are processed, add an explicit dependency:

**`infra/bin/app.ts`:**

```typescript
// After both stacks are created:
lambdaStack.addDependency(ecsStack);  // ADD — ingestion Lambda reads ECS SSM params
```

This makes the CDK deployment order explicit: ECSStack must complete before LambdaStack is deployed, ensuring SSM params exist when the ingestion Lambda runs.

---

## Fix 8: SecurityStack — Write Missing KMS SSM Params

**`infra/lib/security-stack.ts`** — add at end of constructor:

```typescript
import * as ssm from 'aws-cdk-lib/aws-ssm';

// These params are read by CLI (upload, skill push) and ECS runner (uploader.ts)
new ssm.StringParameter(this, 'ParamUploadsKeyArn', {
  parameterName: `/skills-svc/${envName}/kms/uploads-key-id`,  // kept as "key-id" for backward compat
  stringValue: this.uploadsBucketKey.keyArn,
  description: 'Uploads bucket KMS key ARN (named key-id for historical reasons)',
});

new ssm.StringParameter(this, 'ParamResultsKeyArn', {
  parameterName: `/skills-svc/${envName}/kms/results-key-id`,
  stringValue: this.resultsBucketKey.keyArn,
});
```

---

## Fix 9: `updateJobStatus` — Fix `#ver` vs `#version` Typo

**`packages/ecs-runner/src/job-status.ts`** — fix ExpressionAttributeNames:

```typescript
// REPLACE:
// ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },

// WITH (match what the expression actually uses):
ExpressionAttributeNames: { '#status': 'status', '#ver': 'version' },

// The UpdateExpression uses '#ver' and ConditionExpression uses '#ver':
// UpdateExpression: 'SET #status = :status, ... #ver = :nv, ...'
// ConditionExpression: '#ver = :cv'
// So '#ver' maps to 'version' — correct.
```

Alternatively, rename `#ver` → `#version` throughout and use `#version` consistently. Either way, the name in the expression and the map must match.

---

## Fix 10: Ingestion Lambda — Write Cache Key (GSI4PK)

**`packages/lambda/src/ingestion/handler.ts`** — add cache key computation and storage in PutCommand Item:

```typescript
import { createHash } from 'crypto';

// After validation (which gives us manifest and zipBuffer):
const promptForCache = validation.manifest?.defaultPrompt ?? '';
const zipSha256Hex = head.ChecksumSHA256
  ? Buffer.from(head.ChecksumSHA256, 'base64').toString('hex')
  : null;

const cacheKey = zipSha256Hex
  ? createHash('sha256')
      .update(zipSha256Hex)
      .update('\x00')
      .update(promptForCache)
      .digest('hex')
  : null;

// Add to PutCommand Item:
...(cacheKey ? { GSI4PK: `CACHE#${cacheKey}`, cacheKey, zipSha256: zipSha256Hex } : {}),
```

---

## Fix 11: Ingestion Lambda — Write GSI3 Fields for Scheduled Jobs

**`packages/lambda/src/ingestion/handler.ts`** — detect scheduled metadata and write GSI3:

```typescript
// After HeadObject:
const scheduleId = head.Metadata?.['schedule-id'];
const isScheduled = head.Metadata?.['scheduled'] === 'true';

// Add to PutCommand Item:
...(isScheduled && scheduleId ? {
  GSI3PK: `SCHEDULE#${scheduleId}`,
  GSI3SK: `CREATED_AT#${now}`,
} : {}),
```

---

## Fix 12: `zipDirectory` — Preserve Root Structure

**`packages/cli/src/utils/zipper.ts`** — fix how files are added to preserve manifest at archive root:

```typescript
export async function zipDirectory(
  sourceDir: string,
  outputPath: string,
  ignorePatterns: string[] = [],
): Promise<void> {
  const zip = new AdmZip();
  const absSource = path.resolve(sourceDir);

  const addDir = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // RELATIVE to sourceDir — so files are added at archive root level
      const archivePath = path.relative(absSource, fullPath);

      if (ignorePatterns.some(p => entry.name === p || entry.name.endsWith(p.replace('*', '')))) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;

      if (entry.isDirectory()) {
        addDir(fullPath);
      } else {
        // Add with path relative to sourceDir (not including sourceDir itself)
        zip.addLocalFile(fullPath, path.dirname(archivePath) === '.' ? '' : path.dirname(archivePath));
      }
    }
  };

  addDir(absSource);
  zip.writeZip(outputPath);
}
```

This ensures `sourceDir/manifest.json` → `manifest.json` (at archive root), and `sourceDir/skills/a.md` → `skills/a.md`.

---

## Fix 13: `batch results --failed-only` — Fix ExpressionAttributeValues Merge

**`packages/cli/src/commands/batch.ts`** — fix the conditional merge:

```typescript
// REPLACE the conditional spread pattern with explicit merge:
const queryParams: any = {
  TableName: batchTableName,
  KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
  ExpressionAttributeValues: {
    ':pk':     `BATCH#${batchId}`,
    ':prefix': 'JOB#',
    ...(opts.failedOnly ? { ':failed': 'FAILED' } : {}),
  },
};

if (opts.failedOnly) {
  queryParams.FilterExpression = '#status = :failed';
  queryParams.ExpressionAttributeNames = { '#status': 'status' };
}

const res = await ddb.send(new QueryCommand(queryParams));
```

---

## Fix 14: `authorId` — Use Stable Account-Scoped Identifier

**Problem:** `identity.Arn.split('/').pop()` returns `session-name` for assumed roles, which changes per-session.

**`packages/cli/src/commands/skill.ts`** — derive stable authorId:

```typescript
const identity = await sts.send(new GetCallerIdentityCommand({}));

// Use account ID + user name segment for a stable, unique identifier
// For user ARN arn:aws:iam::123:user/alice → 'alice'  
// For role ARN arn:aws:iam::123:assumed-role/UserRole/session → 'UserRole' (role name, not session)
// For root ARN arn:aws:iam::123:root → 'root'
function deriveAuthorId(arn: string): string {
  const parts = arn.split(':');
  const resourcePart = parts[5]; // e.g. 'user/alice' or 'assumed-role/UserRole/session'
  const segments = resourcePart.split('/');
  if (segments[0] === 'assumed-role') {
    return segments[1]; // role name — stable across sessions
  }
  if (segments[0] === 'user') {
    return segments[segments.length - 1]; // user name
  }
  return identity.Account!; // fallback: account ID
}

const authorId = deriveAuthorId(identity.Arn!);
```

---

## Fix 15: `submit_job` MCP — Correct Size Limit to 7.5MB

**`packages/lambda/src/mcp/tools/submit-job.ts`:**

```typescript
// REPLACE:
// const MAX_MCP_ZIP_BYTES = 10 * 1024 * 1024; // 10MB
// if (zipBuffer.length > MAX_MCP_ZIP_BYTES) {
//   throw new Error('Zip file exceeds 10MB MCP limit. Use the CLI for larger files.');
// }

// WITH (account for base64 33% overhead + API GW 10MB limit):
const MAX_MCP_ZIP_BYTES = 7.5 * 1024 * 1024; // 7.5MB binary → ~10MB base64 → at API GW limit
if (zipBuffer.length > MAX_MCP_ZIP_BYTES) {
  throw new Error(
    `Zip file (${(zipBuffer.length / 1024 / 1024).toFixed(1)}MB) exceeds 7.5MB MCP limit ` +
    `(base64 encoding adds 33% overhead, hitting API Gateway's 10MB payload limit). ` +
    `Use the CLI for larger files: skills-svc run --skill ${args.skill_ref ?? 'name@version'}`
  );
}
```

---

## Fix 16: `diff` Command — Check Job Status Before S3 Fetch

**`packages/cli/src/commands/diff.ts`** — add status check in `fetchResult`:

```typescript
const fetchResult = async (job: Record<string, unknown>): Promise<RunResult> => {
  // Check status BEFORE trying to fetch from S3
  if (job.status !== JobStatus.COMPLETE) {
    throw new Error(
      `Job ${job.jobId} is not complete (status: ${job.status}). ` +
      `Use: skills-svc status ${job.jobId} to track progress.`
    );
  }
  const resultKey = job.s3ResultKey as string | undefined;
  if (!resultKey) throw new Error(`Job ${job.jobId} has no result key`);
  // ... rest of fetch unchanged
};
```

---

## Fix 17: `validate` Command — Check `.zip` Extension Early

**`packages/cli/src/commands/validate.ts`** — add before the statSync call:

```typescript
if (!zipPath.endsWith('.zip')) {
  console.error(chalk.red(`File must have .zip extension. Got: ${path.extname(zipPath) || '(no extension)'}`));
  console.error(chalk.dim('Use: skills-svc validate ./my-skills.zip'));
  process.exit(1);
}
```

---

## Fix 18: `--profile` Global Option — Add Description

**`packages/cli/src/index.ts`:**

```typescript
program
  .name('skills-svc')
  .description(
    'Skills as a Service CLI — upload skills, run them on AWS, query results.\n' +
    'Use --profile <name> to select a named config profile (default: "default").'
  )
  .version('1.0.0')
  .option('--profile <name>', 'Use named config profile (see: skills-svc profile --help)', 'default')
  .hook('preAction', (thisCommand) => {
    const profile = thisCommand.opts().profile as string | undefined;
    if (profile) process.env.SKILLS_SVC_PROFILE = profile;
  });
```

---

## Fix 19: Root `package.json` — Sequential Workspace Build

**`package.json`** at repo root — replace parallel build with sequential:

```json
{
  "scripts": {
    "build": "npm run build -w packages/shared && npm run build -w packages/knowledge-store && npm run build -w packages/lambda && npm run build -w packages/ecs-runner && npm run build -w packages/cli && npm run build -w infra",
    "build:parallel": "npm run build --workspaces --if-present",
    "test": "jest --passWithNoTests",
    "lint": "eslint packages/*/src infra/lib infra/aspects --max-warnings 0",
    "qa:all": "bash scripts/qa-run-all.sh",
    "synth": "cd infra && npx cdk synth --strict"
  }
}
```

The sequential build ensures `shared` compiles before any package that imports from it.

---

## Fix 20: `packages/shared/tsconfig.json` — Add Declaration Output

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Fix 21: MonitoringStack — Add Alarms for New Lambdas

**`infra/lib/monitoring-stack.ts`** — updated props and alarms:

```typescript
interface MonitoringStackProps extends cdk.StackProps {
  envName: string;
  ingestionFn: lambda.Function;
  resultsProcessorFn: lambda.Function;
  ingestionDLQ: sqs.Queue;
  resultsDLQ: sqs.Queue;
  alarmTopic: sns.Topic;
  // ADD new Lambdas to monitor:
  queryFn: lambda.Function;
  runSkillFn: lambda.Function;
  scheduleTriggerFn: lambda.Function;
  skillValidatorFn: lambda.Function;
}

// In constructor, extend the Lambda error alarm loop:
const lambdasToMonitor: [string, lambda.Function][] = [
  ['IngestionLambda',       props.ingestionFn],
  ['ResultsProcessorLambda', props.resultsProcessorFn],
  ['QueryLambda',           props.queryFn],
  ['RunSkillLambda',        props.runSkillFn],
  ['ScheduleTriggerLambda', props.scheduleTriggerFn],
  ['SkillValidatorLambda',  props.skillValidatorFn],
];

for (const [name, fn] of lambdasToMonitor) {
  const alarm = new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
    alarmName: `skills-svc-${envName}-${name.toLowerCase()}-errors`,
    metric: fn.metricErrors({ period: cdk.Duration.minutes(1) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: `${name} error count >= 1`,
  });
  alarm.addAlarmAction(alarmAction);
}
```

**`infra/bin/app.ts`** — pass new Lambdas to MonitoringStack:

```typescript
const monitoring = new MonitoringStack(app, `SkillsSvc-${envName}-Monitoring`, {
  env, envName,
  ingestionFn:        lambdaStack.ingestionFn,
  resultsProcessorFn: lambdaStack.resultsProcessorFn,
  ingestionDLQ:       messaging.ingestionDLQ,
  resultsDLQ:         messaging.resultsDLQ,
  alarmTopic:         messaging.jobsNotificationTopic,
  queryFn:            lambdaStack.queryFn,              // ADD
  runSkillFn:         lambdaStack.runSkillFn,            // ADD
  scheduleTriggerFn:  lambdaStack.scheduleTriggerFn,    // ADD
  skillValidatorFn:   skillRegistry.validatorFn,        // ADD (expose from SkillRegistryStack)
});
```

**Add `public readonly validatorFn` to `SkillRegistryStack`:**

```typescript
export class SkillRegistryStack extends cdk.Stack {
  public readonly registryBucket: s3.Bucket;
  public readonly skillsTable: dynamodb.Table;
  public readonly validatorFn: lambda.Function;  // ADD
```

---

## Fix 22: Results Processor — Emit ECS Failure Metric

Already specified in Fix 4. Additionally, add the metric to the CloudWatch Dashboard:

**`infra/lib/monitoring-stack.ts`** — add ECS failure metric to dashboard:

```typescript
new cloudwatch.GraphWidget({
  title: 'ECS Task Failures',
  left: [
    new cloudwatch.Metric({
      namespace: 'skills-svc/ECS',
      metricName: 'TaskFailures',
      dimensionsMap: { Environment: props.envName },
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }),
  ],
  width: 12,
}),
```

---

## Fix 23: ECS Runner — Add `jobId` to All Log Events

**`packages/ecs-runner/src/main.ts`** — pass `jobId` to all downstream functions so they include it in logs:

```typescript
// Pass jobId to downloader, extractor, runner, uploader so they log it:
const zipPath = await downloadZip(s3Bucket, s3Key, '/tmp/workspace/upload.zip', jobId);

// In downloader.ts:
export async function downloadZip(bucket: string, key: string, destPath: string, jobId: string): Promise<string> {
  // ...
  console.log(JSON.stringify({ event: 'zip_downloaded', jobId, bucket, key, destPath }));
}

// Apply same pattern: add jobId to extractor, runner, uploader, job-status log events
```

---

## Fix 24: ECS Runner — Wrap Bedrock Client with X-Ray

**`packages/ecs-runner/src/runner.ts`:**

```typescript
import { captureAWSv3Client } from 'aws-xray-sdk';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// REPLACE:
// const bedrock = new BedrockRuntimeClient({ region: process.env.REGION ?? 'us-east-1' });

// WITH:
const bedrock = captureAWSv3Client(
  new BedrockRuntimeClient({ region: process.env.REGION ?? 'us-east-1' })
);
```

**Add `aws-xray-sdk` to `packages/ecs-runner/package.json`:**

```json
"aws-xray-sdk": "^3.6.0"
```

---

## Fix 25: ComplianceStack — Add Registry Bucket to CloudTrail Data Events

**`infra/lib/compliance-stack.ts`** — update `addS3EventSelector`:

```typescript
// REPLACE:
// trail.addS3EventSelector([
//   { bucket: props.uploadsBucket },
//   { bucket: props.resultsBucket },
// ], { ... });

// WITH (add registry bucket):
trail.addS3EventSelector([
  { bucket: props.uploadsBucket },
  { bucket: props.resultsBucket },
  { bucket: props.registryBucket },   // ADD — audit all skill pushes
], {
  readWriteType: cloudtrail.ReadWriteType.ALL,
  includeManagementEvents: true,
});
```

**Add `registryBucket` to `ComplianceStackProps`:**

```typescript
interface ComplianceStackProps extends cdk.StackProps {
  envName: string;
  auditKey: kms.Key;
  uploadsBucket: s3.Bucket;
  resultsBucket: s3.Bucket;
  registryBucket: s3.Bucket;  // ADD
}
```

**`infra/bin/app.ts`** — pass registry bucket:

```typescript
const compliance = new ComplianceStack(app, `SkillsSvc-${envName}-Compliance`, {
  env, envName,
  auditKey:       security.auditKey,
  uploadsBucket:  storage.uploadsBucket,
  resultsBucket:  storage.resultsBucket,
  registryBucket: skillRegistry.registryBucket,  // ADD
});
```

---

## New QA Checks (QA-239 through QA-248)

```typescript
// QA-239: ComprehendPII Sid is in WILDCARD_EXCEPTION_SIDS
test('QA-239: NoWildcardIAMAspect includes ComprehendPII in exception set', () => {
  const source = readFileSync('infra/aspects/no-wildcard-iam.ts', 'utf-8');
  expect(source).toContain("'ComprehendPII'");
  expect(source).toContain('WILDCARD_EXCEPTION_SIDS');
});

// QA-240: SecurityStack writes KMS key SSM params
test('QA-240: SecurityStack writes uploads-key-id and results-key-id SSM params', () => {
  const { templates } = buildTestApp();
  templates.security.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/skills-svc/test/kms/uploads-key-id',
  });
  templates.security.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/skills-svc/test/kms/results-key-id',
  });
});

// QA-241: updateJobStatus uses consistent attribute name #ver
test('QA-241: job-status.ts uses #ver consistently in expression and names map', () => {
  const source = readFileSync('packages/ecs-runner/src/job-status.ts', 'utf-8');
  // Expression uses #ver
  expect(source).toContain('#ver = :nv');
  expect(source).toContain('#ver = :cv');
  // Names map uses #ver (not #version)
  expect(source).toContain("'#ver': 'version'");
  expect(source).not.toContain("'#version': 'version'");
});

// QA-242: ingestionLambdaRole has skills table write (totalRuns)
test('QA-242: ingestionLambdaRole has dynamodb:UpdateItem on skills table', () => {
  const { templates } = buildTestApp();
  const roles = templates.security.findResources('AWS::IAM::Role');
  const ingestionRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('ingestion-lambda')
  ) as any;
  const stmts = ingestionRole.Properties.Policies
    ?.flatMap((p: any) => p.PolicyDocument.Statement) ?? [];
  const skillsWrite = stmts.find((s: any) =>
    JSON.stringify(s.Resource ?? '').includes('skills-svc-skills') &&
    (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('dynamodb:UpdateItem')
  );
  expect(skillsWrite).toBeDefined();
});

// QA-243: glob import uses globSync not glob.sync
test('QA-243: batch.ts uses globSync (glob v10 API) not glob.sync', () => {
  const source = readFileSync('packages/cli/src/commands/batch.ts', 'utf-8');
  expect(source).toContain('globSync');
  expect(source).not.toContain('glob.sync(');
});

// QA-244: CLI index.ts has shebang line
test('QA-244: CLI src/index.ts starts with shebang', () => {
  const source = readFileSync('packages/cli/src/index.ts', 'utf-8');
  expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
});

// QA-245: LambdaStack depends on ECSStack
test('QA-245: LambdaStack has explicit dependency on ECSStack', () => {
  const source = readFileSync('infra/bin/app.ts', 'utf-8');
  expect(source).toContain('lambdaStack.addDependency(ecsStack)');
});

// QA-246: zipDirectory adds manifest.json at archive root
test('QA-246: zipDirectory preserves root-level manifest.json', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa246-'));
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{"jobName":"test","version":"1.0.0","skills":[]}');
  fs.mkdirSync(path.join(tmpDir, 'skills'));
  const outZip = path.join(os.tmpdir(), 'qa246-out.zip');
  await zipDirectory(tmpDir, outZip, []);
  const zip = new AdmZip(outZip);
  const entries = zip.getEntries().map(e => e.entryName);
  expect(entries).toContain('manifest.json');  // at root, NOT 'tmpDir-name/manifest.json'
  expect(entries.find(e => e === 'manifest.json' || e === './manifest.json')).toBeTruthy();
});

// QA-247: MonitoringStack has error alarms for queryFn and runSkillFn
test('QA-247: MonitoringStack alarms cover queryFn and runSkillFn', () => {
  const { templates } = buildTestApp();
  const alarms = templates.monitoring.findResources('AWS::CloudWatch::Alarm');
  const alarmNames = Object.values(alarms).map((a: any) => a.Properties.AlarmName as string);
  expect(alarmNames.some(n => n.includes('querylambda'))).toBe(true);
  expect(alarmNames.some(n => n.includes('runskilllambda') || n.includes('runSkill'))).toBe(true);
});

// QA-248: ComplianceStack trail covers registry bucket
test('QA-248: CloudTrail data events include registry bucket', () => {
  const { templates } = buildTestApp();
  const trails = templates.compliance.findResources('AWS::CloudTrail::Trail');
  const trail = Object.values(trails)[0] as any;
  const eventSelectors = trail.Properties.EventSelectors ?? [];
  const allDataResources = eventSelectors.flatMap((es: any) => es.DataResources ?? []);
  const s3Resources = allDataResources.filter((r: any) => r.Type === 'AWS::S3::Object');
  // Should have at least 3 S3 buckets: uploads, results, registry
  expect(s3Resources.length).toBeGreaterThanOrEqual(3);
});
```

---

## Summary

| Fix | Files Changed |
|-----|--------------|
| 1 — ComprehendPII in aspect exception set | `infra/aspects/no-wildcard-iam.ts` |
| 2 — ingestionLambdaRole skills table write | `security-stack.ts`, `ingestion/handler.ts` |
| 3 — mcpLambdaRole skills table read | `mcp-stack.ts` |
| 4 — Emit ECS failure metric | `results-processor/handler.ts`, `security-stack.ts` |
| 5 — globSync for glob v10 | `commands/batch.ts` |
| 6 — Shebang in CLI index | `packages/cli/src/index.ts` |
| 7 — LambdaStack depends on ECSStack | `infra/bin/app.ts` |
| 8 — SecurityStack writes KMS SSM params | `security-stack.ts` |
| 9 — Fix #ver/#version typo | `ecs-runner/src/job-status.ts` |
| 10 — Write GSI4PK in ingestion | `ingestion/handler.ts` |
| 11 — Write GSI3PK for scheduled jobs | `ingestion/handler.ts` |
| 12 — zipDirectory root structure | `cli/src/utils/zipper.ts` |
| 13 — batch results ExpressionAttributeValues | `commands/batch.ts` |
| 14 — Stable authorId derivation | `commands/skill.ts` |
| 15 — MCP submit_job 7.5MB limit | `mcp/tools/submit-job.ts` |
| 16 — diff status check before S3 | `commands/diff.ts` |
| 17 — validate .zip extension check | `commands/validate.ts` |
| 18 — --profile option description | `cli/src/index.ts` |
| 19 — Sequential workspace build | root `package.json` |
| 20 — shared tsconfig declaration output | `packages/shared/tsconfig.json` |
| 21 — Monitor all new Lambdas | `monitoring-stack.ts`, `app.ts`, `skill-registry-stack.ts` |
| 22 — ECS failure metric in dashboard | `monitoring-stack.ts` |
| 23 — jobId in all ECS log events | `ecs-runner/src/*.ts` |
| 24 — Bedrock X-Ray capture | `ecs-runner/src/runner.ts`, `ecs-runner/package.json` |
| 25 — Registry bucket in CloudTrail | `compliance-stack.ts`, `app.ts` |
