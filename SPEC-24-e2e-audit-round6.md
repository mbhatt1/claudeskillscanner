# SPEC-24 — E2E Audit Round 6: 150 Issues Found, 30 Worthy Fixes

**Supersedes:** SPEC-23 on all overlapping topics.  
**Scope:** 10-agent parallel E2E audit. Agents found 150 issues total across:
onboarding, batch, scheduling, skill versioning, monitoring, GDPR compliance,
MCP integration, IAM security, knowledge store query, and CLI upgrade flows.  
**Policy:** Blocking and correctness issues only. Operational edge cases excluded.

---

## Fix 1 — `ANTHROPIC_API_KEY` Never Injected Into ECS Container (Every Job Fails)

**Root cause:** `runner.ts` calls `spawn('claude', [...])` with `env: { ...process.env }`.
The ECS task definition intentionally does not include `ANTHROPIC_API_KEY` as an env var
(it is a `SecureString` in SSM). But no code reads that SSM param and injects it before the
spawn. Every `claude` subprocess exits immediately with an authentication error.

**Fix in `packages/ecs-runner/src/runner.ts`:**
```typescript
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

async function getBedrockApiKey(env: string): Promise<string> {
  const ssm = new SSMClient({ region: process.env.REGION ?? 'us-east-1' });
  const res = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${env}/bedrock/api-key`,
    WithDecryption: true,
  }));
  if (!res.Parameter?.Value) throw new Error('Bedrock API key not found in SSM');
  return res.Parameter.Value;
}

export async function runSkills(extractDir: string, jobId: string, env: string): Promise<RunResult> {
  const apiKey = await getBedrockApiKey(env);
  // ...
  const proc = spawn('claude', [...args], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,   // inject — never store in task def env
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: extractDir,
  });
```

Add `ssm:GetParameter` on this specific path to `ecsTaskRole` in `security-stack.ts`:
```typescript
this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadBedrockApiKey',
  actions: ['ssm:GetParameter'],
  resources: [
    `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/*/bedrock/api-key`,
  ],
}));
```

---

## Fix 2 — `hybrid` Query Type Requires AOSS Search Pipeline (Every `skills-svc query` Returns 400)

**Root cause:** OpenSearch Serverless does not support the `hybrid` query type without a
configured search pipeline (`normalization-processor`). `searcher.ts` sends
`query: { hybrid: { queries: [...] } }` — AOSS returns `400 Unknown query [hybrid]`.
No search pipeline is ever created by any spec.

**Fix — replace `hybrid` with standard `bool.should` combining kNN and BM25 (no pipeline needed):**

```typescript
// packages/knowledge-store/src/searcher.ts
body: {
  size: topK,
  from: from ?? 0,
  query: {
    bool: {
      should: [
        {
          knn: {
            result_embedding: {
              vector: embedding,
              k: topK * 2,
            },
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
      filter: [{ term: { user_arn: callerUserArn } }],
      minimum_should_match: 1,
    },
  },
  post_filter: { term: { user_arn: callerUserArn } },
  min_score: minScore,
  track_total_hits: true,
  _source: ['job_id', 'job_name', 'user_arn', 's3_result_key', 'result_summary',
            'created_at', 'skill_names'],
},
```

If true hybrid normalization is needed later, also add a search pipeline bootstrap to
`bootstrap-index/handler.ts` after index creation:
```typescript
await client.http.put({ path: '/_search/pipeline/skills-hybrid-pipeline', body: {
  phase_results_processors: [{
    'normalization-processor': {
      normalization:  { technique: 'min_max' },
      combination:    { technique: 'arithmetic_mean', parameters: { weights: [0.7, 0.3] } },
    },
  }],
}});
```

---

## Fix 3 — `query/handler.ts` Never Implemented (QueryLambda Deployment Fails at Handler Resolution)

**Root cause:** `LambdaStack` declares `handler: 'query/handler.handler'` but
`packages/lambda/src/query/handler.ts` does not appear in any spec. The Lambda deployment
succeeds but every invocation throws `Runtime.ImportModuleError`.

**New file `packages/lambda/src/query/handler.ts`:**
```typescript
import { APIGatewayProxyEventV2WithIAMAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { hybridSearch } from '@skills-svc/knowledge-store';

export const handler = async (
  event: APIGatewayProxyEventV2WithIAMAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const start = Date.now();

  // Server-enforced identity — from API Gateway IAM auth (SPEC-23 Fix 24)
  // Falls back to payload for direct Lambda:Invoke path (legacy)
  const callerUserArn =
    event.requestContext?.authorizer?.iam?.userArn ??
    (JSON.parse(event.body ?? '{}') as { filterByUser?: string }).filterByUser ?? '';

  if (!callerUserArn) {
    return { statusCode: 401, body: JSON.stringify({ error: 'callerUserArn required' }) };
  }

  const body = JSON.parse(event.body ?? '{}') as {
    query?: string;
    topK?: number;
    minScore?: number;
    from?: number;
  };

  if (!body.query) {
    return { statusCode: 400, body: JSON.stringify({ error: 'query is required' }) };
  }

  const topK     = Math.min(Math.max(1, body.topK ?? 5), 20);
  const minScore = Math.min(Math.max(0, body.minScore ?? 0.5), 1);
  const from     = Math.max(0, body.from ?? 0);

  const results = await hybridSearch(body.query, callerUserArn, topK, minScore, from);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ results, queryDurationMs: Date.now() - start, from, hasMore: results.length === topK }),
  };
};
```

---

## Fix 4 — `batch-submit/handler.ts` and `batch-status/handler.ts` Never Implemented

**Root cause:** `BatchStack` declares these Lambda handlers, and the Step Functions state
machine calls them, but no spec provides their implementation. The batch pipeline cannot
function at all.

**New file `packages/lambda/src/batch-submit/handler.ts`:**
```typescript
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'crypto';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: {
  skillsS3Bucket: string; skillsS3Key: string;
  batchId: string; batchJobName: string; userArn: string;
  input: { s3Key: string; originalFile: string; index: number };
  inputIndex: number;
}) => {
  const jobId  = randomUUID();
  const runKey = `uploads/batch/${event.batchId}/${event.inputIndex}-${jobId}.zip`;

  // Copy skills zip to per-run key → triggers S3 event → SQS → IngestionLambda
  await s3.send(new CopyObjectCommand({
    Bucket:            event.skillsS3Bucket,
    CopySource:        `${event.skillsS3Bucket}/${event.skillsS3Key}`,
    Key:               runKey,
    ServerSideEncryption: 'aws:kms',
    MetadataDirective: 'REPLACE',
    Metadata: {
      'job-name':         `${event.batchJobName}-${event.inputIndex}`,
      'user-arn':         event.userArn,
      'batch-id':         event.batchId,
      'batch-input-file': event.input.originalFile,
      'batch-input-index': String(event.inputIndex),
    },
  }));

  // Write placeholder to batch table (ingestion Lambda will write real jobId after it
  // creates the DDB job record; it reads batch-id from S3 metadata and updates this row)
  await ddb.send(new PutCommand({
    TableName: process.env.BATCH_TABLE_NAME!,
    Item: {
      PK: `BATCH#${event.batchId}`, SK: `JOB#${event.inputIndex}`,
      jobId, inputFile: event.input.originalFile,
      status: 'PENDING', createdAt: new Date().toISOString(),
      runKey,
    },
    ConditionExpression: 'attribute_not_exists(SK)',
  }));

  return { jobId, batchId: event.batchId, inputIndex: event.inputIndex, status: 'PENDING' };
};
```

**New file `packages/lambda/src/batch-status/handler.ts`:**
```typescript
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: {
  jobId: string; batchId: string; inputIndex: number;
}) => {
  const res = await ddb.send(new GetCommand({
    TableName: process.env.JOBS_TABLE_NAME!,
    Key: { PK: `JOB#${event.jobId}`, SK: 'METADATA' },
  }));
  const status = (res.Item?.status as string | undefined) ?? 'PENDING';
  return { ...event, status };
};
```

Also: fix `StateMachineType` from `EXPRESS` to `STANDARD` in `batch-stack.ts`
(EXPRESS has a 5-minute cap; batch jobs run up to 25 minutes):
```typescript
stateMachineType: sfn.StateMachineType.STANDARD,  // was EXPRESS
```

And fix `batch list` which uses invalid `begins_with(PK, ...)` — add a `GSI1-UserBatches`
GSI to `batchTable`:
```typescript
batchTable.addGlobalSecondaryIndex({
  indexName:      'GSI1-UserBatches',
  partitionKey:   { name: 'userArn', type: dynamodb.AttributeType.STRING },
  sortKey:        { name: 'createdAt', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['batchId', 'batchName', 'status', 'totalJobs', 'completedJobs', 'failedJobs'],
});
```

---

## Fix 5 — EventBridge Scheduler Role Has Wrong IAM (`s3:PutObject` Instead of `lambda:InvokeFunction`)

**Root cause:** The `schedulerRole` in `MessagingStack` grants `s3:PutObject` — a vestigial
permission from an earlier design where the scheduler wrote directly to S3. The current design
invokes a Lambda. EventBridge Scheduler needs both a resource-based policy on the Lambda
AND a role-level `lambda:InvokeFunction` permission.

**Fix in `infra/lib/messaging-stack.ts`:**
```typescript
// REPLACE s3:PutObject and kms: statements with:
schedulerRole.addToPolicy(new iam.PolicyStatement({
  sid: 'InvokeScheduleTriggerLambda',
  actions: ['lambda:InvokeFunction'],
  resources: [
    `arn:aws:lambda:${this.region}:${this.account}:function:skills-svc-schedule-trigger-${this.account}`,
  ],
}));
```

Also: update the `SchedulerRole` IAM resource ARN to match the `skill-schedules/` prefix
introduced in SPEC-19 Fix 5 (old `uploads/scheduled/*` resource is now wrong):
```typescript
// LambdaStack schedule-trigger role — fix S3 read prefix:
this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadScheduledZip',
  actions: ['s3:GetObject', 's3:CopyObject'],
  resources: [
    `arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/skill-schedules/*`,
    `arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/uploads/*`,
  ],
}));
```

---

## Fix 6 — Schedule Cron Expression Missing 6-Field Validation (EventBridge Rejects 5-Field Unix Cron)

**Root cause:** EventBridge Scheduler requires 6-field cron syntax
`(min hour day-of-month month day-of-week year)`. The user-facing example uses standard Unix
5-field cron, e.g. `"0 9 * * MON"`. Wrapping it in `cron(...)` and calling
`CreateScheduleCommand` produces an AWS validation error with no helpful message.

**Fix in `packages/cli/src/commands/schedule.ts`:**
```typescript
function validateEventBridgeCron(cron: string): { valid: boolean; error?: string } {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 6) {
    return {
      valid: false,
      error:
        `EventBridge Scheduler requires 6-field cron syntax:\n` +
        `  min  hour  day-of-month  month  day-of-week  year\n` +
        `  Example: "0 9 ? * MON *"  (not Unix 5-field "0 9 * * MON")\n` +
        `  Your expression has ${fields.length} fields.`,
    };
  }
  const [, , dom, , dow] = fields;
  if (dom !== '?' && dow !== '?') {
    return {
      valid: false,
      error: 'day-of-month and day-of-week cannot both be non-"?" simultaneously.',
    };
  }
  return { valid: true };
}

// In schedule create action, before CreateScheduleCommand:
const cronValidation = validateEventBridgeCron(opts.cron);
if (!cronValidation.valid) {
  console.error(chalk.red(`Invalid cron: ${cronValidation.error}`));
  process.exit(1);
}
```

---

## Fix 7 — Schedule Authorization: No Ownership Check on Update/Delete/Enable/Disable

**Root cause:** `schedule update`, `delete`, `enable`, and `disable` call EventBridge Scheduler
APIs without verifying that the caller owns the schedule. User A can delete User B's schedule
by name (enumerable via `schedule list`). `schedule list` returns all schedules in the group
with no per-user filtering.

**Fix — store ownership metadata in DDB at creation time and enforce on mutations:**

In `schedule create`, after `CreateScheduleCommand`:
```typescript
await ddb.send(new PutCommand({
  TableName: cfg.dynamodbTableName,
  Item: {
    PK: `SCHEDULE#${scheduleName}`, SK: 'METADATA',
    scheduleName, scheduleId, ownerArn: identity.Arn!,
    createdAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
  },
  ConditionExpression: 'attribute_not_exists(PK)',
}));
```

In `schedule delete/update/enable/disable`, before calling Scheduler API:
```typescript
const meta = await ddb.send(new GetCommand({
  TableName: cfg.dynamodbTableName,
  Key: { PK: `SCHEDULE#${scheduleName}`, SK: 'METADATA' },
}));
if (!meta.Item) {
  console.error(chalk.red(`Schedule not found: ${scheduleName}`));
  process.exit(1);
}
if (meta.Item.ownerArn !== identity.Arn) {
  console.error(chalk.red(`Access denied: schedule "${scheduleName}" belongs to ${meta.Item.ownerArn}`));
  process.exit(1);
}
```

For `schedule list` — filter by GSI2-User or DDB schedule metadata:
```typescript
// Filter results client-side by ownerArn:
const owned = await Promise.all(
  (res.Schedules ?? []).map(async s => {
    const meta = await ddb.send(new GetCommand({
      TableName: cfg.dynamodbTableName,
      Key: { PK: `SCHEDULE#${s.Name}`, SK: 'METADATA' },
    }));
    return meta.Item?.ownerArn === identity.Arn ? s : null;
  })
).then(r => r.filter(Boolean));
```

Also fix `UpdateScheduleCommand` in enable/disable to preserve `ScheduleExpressionTimezone`
(currently dropped, silently resetting timezone to UTC):
```typescript
await scheduler.send(new UpdateScheduleCommand({
  Name: scheduleName, GroupName: groupName,
  ScheduleExpression: existing.ScheduleExpression!,
  ScheduleExpressionTimezone: existing.ScheduleExpressionTimezone,  // ADD
  FlexibleTimeWindow: existing.FlexibleTimeWindow!,
  Target: existing.Target!,
  State: action === 'enable' ? 'ENABLED' : 'DISABLED',
}));
```

---

## Fix 8 — SemVer Build Metadata (`+`) Produces NaN DDB Sort Keys in `padSemver`

**Root cause:** `padSemver("1.0.0+build.42")` splits on `-` then tries to parse
`"0+build.42"` as `Number` → `NaN`. DDB sort keys become `"NaN.NaN.NaN.Z"`, corrupting
the `latestVersion` pointer for any version with build metadata.

**Fix in `packages/shared/src/types.ts`:**
```typescript
export function padSemver(version: string): string {
  const withoutBuild = version.split('+')[0];       // strip build metadata first
  const [coreStr, prerelease] = withoutBuild.split('-', 2);
  const [major = 0, minor = 0, patch = 0] = coreStr.split('.').map(Number);
  const core = [major, minor, patch].map(n => String(n).padStart(3, '0')).join('.');
  return prerelease ? `${core}.A.${prerelease}` : `${core}.Z`;
}

// Also reject build metadata at push time to prevent confusion:
export function isValidSemver(version: string): boolean {
  if (version.includes('+')) return false;  // build metadata unsupported
  return SEMVER_REGEX.test(version);
}
```

---

## Fix 9 — Skill Deprecation SNS Notification Never Published (Validator Lambda Only Fires on Push)

**Root cause:** SPEC-20 Fix 4 places the deprecation SNS publish inside
`skill-validator/handler.ts` — which is triggered by S3 `ObjectCreated`. Deprecation never
creates an S3 object, so the notification is never published.

**Fix — publish SNS directly from `packages/cli/src/commands/skill.ts` deprecate action:**
```typescript
// After the DDB UpdateCommand succeeds:
const skillEventsTopicArn = await ssm.send(new GetParameterCommand({
  Name: `/skills-svc/${cfg.envName}/sns/skill-events-topic-arn`,
})).then(r => r.Parameter!.Value!);

await new SNSClient({ region: cfg.region, credentials: creds }).send(new PublishCommand({
  TopicArn: skillEventsTopicArn,
  Subject:  `Skill Deprecated: ${name}@${version}`,
  Message:  JSON.stringify({
    skillName: name, version,
    deprecatedBy:     identity.Arn,
    deprecationMsg:   opts.message,
    suggestedVersion: opts.suggest ?? null,
    timestamp: new Date().toISOString(),
  }),
  MessageAttributes: {
    eventType: { DataType: 'String', StringValue: 'deprecation' },
    skillName:  { DataType: 'String', StringValue: name },
  },
}));
```

Add `sns:Publish` on the skill-events topic to `userRole` in `SecurityStack`:
```typescript
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'PublishSkillEvents',
  actions: ['sns:Publish'],
  resources: [`arn:aws:sns:${this.region}:${this.account}:skills-svc-skill-events-*`],
}));
```

---

## Fix 10 — `ECS:TaskFailures` CloudWatch Alarm References Metric Never Emitted (Alarm Always Green)

**Root cause:** `MonitoringStack` declares an alarm on `skills-svc/ECS:TaskFailures` but no
Lambda or ECS code ever emits `PutMetricData` with that namespace/metric. The alarm always
shows `NO_DATA` / `NOT_BREACHING` — it never fires even during mass job failures.

**Fix — emit metric in `packages/lambda/src/results-processor/handler.ts`:**
```typescript
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
const cw = new CloudWatchClient({});

// After status update, if job failed:
if (!succeeded) {
  await cw.send(new PutMetricDataCommand({
    Namespace: 'skills-svc/ECS',
    MetricData: [{
      MetricName: 'TaskFailures',
      Value: 1,
      Unit: 'Count',
      Dimensions: [{ Name: 'Environment', Value: env }],
      Timestamp: new Date(),
    }],
  }));
}
```

Also add a failure-rate alarm (20% threshold) to `MonitoringStack`:
```typescript
new cloudwatch.Alarm(this, 'JobFailureRateAlarm', {
  alarmName: `skills-svc-${envName}-job-failure-rate`,
  metric: new cloudwatch.MathExpression({
    expression: 'failures / invocations * 100',
    usingMetrics: {
      failures:    props.resultsProcessorFn.metricErrors({ period: cdk.Duration.minutes(5) }),
      invocations: props.resultsProcessorFn.metricInvocations({ period: cdk.Duration.minutes(5) }),
    },
    period: cdk.Duration.minutes(5),
  }),
  threshold: 20,
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
}).addAlarmAction(alarmAction);
```

Add `cloudwatch:PutMetricData` to `resultsLambdaRole`:
```typescript
this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'PutMetrics',
  actions: ['cloudwatch:PutMetricData'],
  resources: ['*'],
  conditions: { StringEquals: { 'cloudwatch:namespace': ['skills-svc/ECS', 'skills-svc/AOSS'] } },
}));
```

---

## Fix 11 — `health` Command `stuckJobs` Check Is a Hardcoded OK Placeholder

**Root cause:** SPEC-22 Fix 6 `health.ts` unconditionally sets
`stuckJobs: { status: 'OK', detail: 'Use: skills-svc list-jobs...' }`.
During an incident with 40 jobs stuck >30 minutes, `health` reports HEALTHY.

**Fix — query GSI1-Status for RUNNING jobs older than 30 minutes:**
```typescript
// In health command, replace placeholder:
try {
  const ddb2 = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
  const running = await ddb2.send(new QueryCommand({
    TableName: cfg.dynamodbTableName,
    IndexName: 'GSI1-Status',
    KeyConditionExpression: 'GSI1PK = :running',
    ExpressionAttributeValues: { ':running': 'STATUS#RUNNING' },
  }));
  const now = Date.now();
  const stuck = (running.Items ?? []).filter(
    item => now - new Date(item.createdAt as string).getTime() > 30 * 60 * 1000
  );
  results.stuckJobs = stuck.length === 0
    ? { status: 'OK',   detail: `${running.Items?.length ?? 0} running, none stuck >30min` }
    : { status: 'FAIL', detail: `${stuck.length} job(s) stuck >30min: ${stuck.map(j => j.jobId).slice(0,3).join(', ')}` };
} catch (err) {
  results.stuckJobs = { status: 'WARN', detail: `Could not query stuck jobs: ${String(err)}` };
}
```

---

## Fix 12 — `UserRole` Missing SQS, ECS, and CloudTrail Permissions (health/dlq/audit/cancel All Fail)

**Root cause:** `health` calls `sqs:GetQueueAttributes` and `ecs:DescribeTaskDefinition`.
`dlq inspect/replay` calls `sqs:ReceiveMessage/DeleteMessage/SendMessage`. `cancel` calls
`ecs:ListTasks/StopTask`. `audit` calls `cloudtrail:LookupEvents`. None of these are granted
to `userRole` in `SecurityStack`.

**Fix in `infra/lib/security-stack.ts`:**
```typescript
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'SQSDLQOperations',
  actions: [
    'sqs:GetQueueAttributes', 'sqs:ReceiveMessage',
    'sqs:DeleteMessage', 'sqs:SendMessage', 'sqs:GetQueueUrl',
  ],
  resources: [
    `arn:aws:sqs:${this.region}:${this.account}:skills-svc-ingestion-dlq-*`,
    `arn:aws:sqs:${this.region}:${this.account}:skills-svc-results-dlq-*`,
    `arn:aws:sqs:${this.region}:${this.account}:skills-svc-ingestion-*`,
  ],
}));
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ECSCancelInspect',
  actions: ['ecs:ListTasks', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:DescribeTaskDefinition'],
  resources: [
    `arn:aws:ecs:${this.region}:${this.account}:cluster/skills-svc-${envName}`,
    `arn:aws:ecs:${this.region}:${this.account}:task/skills-svc-${envName}/*`,
    `arn:aws:ecs:${this.region}:${this.account}:task-definition/skills-svc-runner-${envName}:*`,
  ],
}));
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'CloudTrailAudit',
  actions: ['cloudtrail:LookupEvents'],
  resources: ['*'],   // LookupEvents has no resource-level restriction
}));
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'BedrockHealthCheck',
  actions: ['bedrock:ListFoundationModels'],
  resources: ['*'],
}));
```

---

## Fix 13 — GDPR `delete-user` Not a Subcommand of `compliance` + Missing Critical Deletion Steps

**Root cause (1):** SPEC-20 Fix 2 registers `deleteUserCommand()` as a top-level command.
SPEC-22 Fix 14 creates `complianceCommand()` with `pii-report` and `show-retention` but
NOT `delete-user`. `skills-svc compliance delete-user` returns `unknown command`.

**Root cause (2):** The `delete-user` implementation omits: (a) OpenSearch delete-by-query,
(b) upload zip deletion from S3, (c) paginating `ListObjectVersions`, (d) stopping running ECS
tasks before DDB deletion, (e) cancelling EventBridge schedules, (f) an IAM role with deletion
permissions, and (g) a durable audit receipt.

**Fix (1) — wire into compliance command:**
```typescript
// packages/cli/src/commands/compliance.ts
import { deleteUserCommand } from './delete-user';
cmd.addCommand(deleteUserCommand());  // ADD

// packages/cli/src/index.ts — REMOVE standalone registration:
// program.addCommand(deleteUserCommand());
```

**Fix (2) — add missing deletion steps to `packages/cli/src/commands/delete-user.ts`:**
```typescript
// Step 0: Cancel EventBridge schedules (prevents re-creation of deleted user's data)
// (see Fix 7 for schedule ownership DDB; query by ownerArn)

// Step 1: Stop running ECS tasks
const runningJobs = allItems.filter(item => item.status === 'RUNNING');
for (const job of runningJobs) {
  const tasks = await ecs.send(new ListTasksCommand({
    cluster: clusterArn, startedBy: job.jobId as string,
  }));
  for (const taskArn of tasks.taskArns ?? []) {
    if (!opts.dryRun) await ecs.send(new StopTaskCommand({
      cluster: clusterArn, task: taskArn, reason: `GDPR deletion: ${userArn}`,
    }));
  }
}

// Step 2: Delete all S3 objects (uploads + results), paginating ListObjectVersions
async function deleteAllVersions(s3: S3Client, bucket: string, prefix: string): Promise<void> {
  let keyMarker: string | undefined, versionIdMarker: string | undefined;
  do {
    const res = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker,
    }));
    const toDelete = [
      ...(res.Versions ?? []).map(v => ({ Key: v.Key!, VersionId: v.VersionId })),
      ...(res.DeleteMarkers ?? []).map(d => ({ Key: d.Key!, VersionId: d.VersionId })),
    ];
    for (let i = 0; i < toDelete.length; i += 1000) {
      const delRes = await s3.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: toDelete.slice(i, i + 1000) },
      }));
      if (delRes.Errors?.length) throw new Error(
        `S3 delete failed for ${delRes.Errors.length} objects: ${delRes.Errors[0].Message}`
      );
    }
    keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
    versionIdMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
  } while (keyMarker);
}

// Step 3: Delete OpenSearch documents
await osClient.deleteByQuery({
  index: indexName,
  body: { query: { term: { user_arn: userArn } } },
  refresh: true,
});

// Step 4: Write durable audit receipt to CloudWatch Logs
const receipt = { deletionId: randomUUID(), userArn, requestedBy: operatorArn,
  completedAt: new Date().toISOString(), jobsDeleted: allItems.length,
  s3ObjectsDeleted: deletedCount, schedulesDeleted: scheduleCount };
await cwl.send(new PutLogEventsCommand({
  logGroupName: `/skills-svc/${cfg.envName}/compliance/gdpr-deletions`,
  logStreamName: `deletion-${new Date().toISOString().slice(0, 10)}`,
  logEvents: [{ timestamp: Date.now(), message: JSON.stringify(receipt) }],
}));
console.log(chalk.bold(`\n  Deletion Receipt ID: ${chalk.cyan(receipt.deletionId)}`));
```

Add a dedicated `complianceOperatorRole` in `SecurityStack` with
`dynamodb:DeleteItem`, `s3:DeleteObject`, `s3:DeleteObjectVersion`,
`aoss:APIAccessAll`, `scheduler:DeleteSchedule`, `ecs:ListTasks/StopTask`,
`cloudwatch:PutLogEvents` — `userRole` does not have these and should not.

---

## Fix 14 — MCP `submit_job` Returns No Job ID (Poll Loop Impossible)

**Root cause:** The MCP `submit_job` tool returns the S3 key and says "poll `list_jobs` to
find your job ID" — but `list_jobs` returns all the caller's jobs with no correlation token.
A polling agent cannot reliably find the specific just-submitted job.

**Fix in `packages/lambda/src/mcp/tools/submit-job.ts`:**
```typescript
const jobId = randomUUID();   // generate pre-upload

await s3.send(new PutObjectCommand({
  ...params,
  Metadata: {
    'job-name':   jobName,
    'user-arn':   callerArn,
    'mcp-job-id': jobId,       // ingestion Lambda honours this as the jobId
  },
}));

return [{
  type: 'text',
  text: [
    '✅ Job submitted.',
    '',
    `Job ID:   ${jobId}`,
    `Job Name: ${jobName}`,
    `ETA:      10–30 seconds to RUNNING, 2–10 min to COMPLETE`,
    '',
    `Poll: call job_status with job_id="${jobId}"`,
  ].join('\n'),
}];
```

Update `packages/lambda/src/ingestion/handler.ts` to honour the metadata-provided ID:
```typescript
const mcpJobId = head.Metadata?.['mcp-job-id'];
const jobId = (mcpJobId && isValidUUID(mcpJobId)) ? mcpJobId : randomUUID();
```

---

## Fix 15 — MCP IAM SigV4: `env` Field Is Ignored for HTTP Transport (All MCP Tool Calls Return 403)

**Root cause:** The `env` field in `mcp.json` is a `stdio`-transport concept (sets subprocess
env vars). For `type: "http"` transport, the `env` field is silently ignored by the MCP client.
Requests arrive at API Gateway unsigned → IAM authorizer rejects with 403. Every MCP tool call
fails in production.

**Fix — switch to Lambda authorizer with short-lived API keys that the CLI manages:**

`infra/lib/mcp-stack.ts`:
```typescript
// Replace HttpIamAuthorizer with Lambda authorizer using X-API-Key header:
const tokenAuthFn = new lambda.Function(this, 'MCPTokenAuthFn', {
  ...sharedProps,
  handler: 'mcp-auth/handler.handler',
  memorySize: 128,
  timeout: cdk.Duration.seconds(5),
});

const tokenAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer(
  'TokenAuthorizer', tokenAuthFn, {
    authorizerName:  'skills-svc-token-authorizer',
    identitySource:  ['$request.header.X-API-Key'],
    resultsCacheTtl: cdk.Duration.minutes(5),
  }
);
```

`packages/lambda/src/mcp-auth/handler.ts` (new) — validates tokens stored in DDB:
```typescript
export const handler = async (event: APIGatewayRequestAuthorizerEventV2) => {
  const token = event.headers?.['x-api-key'];
  if (!token) return { isAuthorized: false };
  const item = await ddb.send(new GetCommand({
    TableName: process.env.JOBS_TABLE_NAME!, Key: { PK: `MCPTOKEN#${token}`, SK: 'META' },
  }));
  if (!item.Item || new Date(item.Item.expiresAt as string) < new Date()) {
    return { isAuthorized: false };
  }
  return {
    isAuthorized: true,
    context: { callerUserArn: item.Item.userArn as string },
  };
};
```

`packages/cli/src/commands/mcp-config.ts` — generate and store token:
```typescript
const token = randomBytes(32).toString('hex');
const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(); // 8h
await ddb.send(new PutCommand({
  TableName: cfg.dynamodbTableName,
  Item: { PK: `MCPTOKEN#${token}`, SK: 'META', userArn: identity.Arn!, expiresAt, ttl: ... },
}));
// Write to mcp.json as x-api-key header (supported by HTTP MCP transport):
mcpConfig.mcpServers['skills-as-a-service'].transport.headers = { 'X-API-Key': token };
```

---

## Fix 16 — MCP Tool Input Schemas Use `type: 'string'` for Numeric Parameters

**Root cause:** `query_knowledge_store` `top_k` and `min_score` are declared `type: 'string'`.
Per JSON Schema (which MCP uses for tool input validation), numeric parameters must be
`type: 'number'` with `minimum`/`maximum` annotations. LLMs may pass numeric values that fail
strict schema validation in compliant clients.

**Fix in all affected tool schemas:**
```typescript
// packages/lambda/src/mcp/tools/query.ts:
top_k: {
  type: 'number', minimum: 1, maximum: 20, default: 5,
  description: 'Number of results to return (1–20)',
},
min_score: {
  type: 'number', minimum: 0, maximum: 1, default: 0.5,
  description: 'Minimum relevance score (0.0–1.0)',
},
from: {
  type: 'number', minimum: 0, default: 0,
  description: 'Pagination offset (0-based)',
},

// packages/lambda/src/mcp/tools/list-jobs.ts:
limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },

// packages/lambda/src/mcp/tools/get-result.ts:
summary_only: { type: 'boolean', default: false },

// In execute(), coerce to correct type to handle both string and number inputs:
topK: Math.min(Math.max(1, Number(args.top_k ?? 5)), 20),
minScore: Math.min(Math.max(0, Number(args.min_score ?? 0.5)), 1),
```

---

## Fix 17 — `ComprehendPII` IAM SID Not in `WILDCARD_EXCEPTION_SIDS` (CDK Synth Fails)

**Root cause:** SPEC-06 §9 adds `{ sid: 'ComprehendPII', resources: ['*'] }` to
`resultsLambdaRole`. The `NoWildcardIAMAspect` only exempts `XRayWrite`.
`cdk synth --strict` fails with `[NoWildcardIAM] Statement "ComprehendPII" uses Resource: '*'`,
blocking all deployments.

**Fix in `infra/aspects/no-wildcard-iam.ts`:**
```typescript
const WILDCARD_EXCEPTION_SIDS = new Set([
  'XRayWrite',      // AWS X-Ray — no resource-level restrictions
  'ComprehendPII',  // Comprehend DetectPiiEntities — no resource-level restrictions
]);
```

---

## Fix 18 — No Permission Boundary on `UserRole` (Privilege Escalation Risk)

**Root cause:** Any user who assumes `userRole` and has lateral access to IAM write operations
(via another path) can create new IAM entities beyond the skills-svc boundary. No permission
boundary exists to cap the maximum effective permissions of the role.

**Fix in `infra/lib/security-stack.ts`:**
```typescript
const userPermissionBoundary = new iam.ManagedPolicy(this, 'UserRolePermissionBoundary', {
  managedPolicyName: `skills-svc-user-boundary-${envName}`,
  statements: [
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject', 's3:GetObject', 's3:HeadObject',
        'dynamodb:GetItem', 'dynamodb:Query',
        'lambda:InvokeFunction',
        'logs:GetLogEvents', 'logs:DescribeLogStreams', 'logs:FilterLogEvents',
        'cloudformation:DescribeStacks', 'sts:GetCallerIdentity',
        'sqs:GetQueueAttributes', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:SendMessage',
        'ecs:ListTasks', 'ecs:StopTask', 'ecs:DescribeTasks', 'ecs:DescribeTaskDefinition',
        'cloudtrail:LookupEvents', 'bedrock:ListFoundationModels',
        'scheduler:*', 'sns:Subscribe', 'sns:Unsubscribe', 'sns:ListSubscriptionsByTopic',
        'ssm:GetParameter', 'ssm:GetParameters',
        'kms:Decrypt', 'kms:GenerateDataKey',
      ],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: [
        'iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy',
        'iam:CreateUser', 'iam:CreateAccessKey', 'iam:CreatePolicy',
      ],
      resources: ['*'],
    }),
  ],
});

this.userRole = new iam.Role(this, 'UserRole', {
  roleName:             `skills-svc-user-${envName}`,
  assumedBy:            new iam.AccountRootPrincipal(),
  permissionsBoundary:  userPermissionBoundary,   // ADD
  maxSessionDuration:   cdk.Duration.hours(8),
});
```

---

## Fix 19 — ECR CVE Gate Allows Up to 5 HIGH-Severity CVEs

**Root cause:** SPEC-06 §8 CI gate uses `if [ "$HIGH" -gt 5 ]; then exit 1; fi`.
A container with 5 HIGH CVEs (CVSS ≥ 7.0, e.g. remote code execution in OpenSSL or Node.js
runtime) is deployed to production. For a system executing user-uploaded code in ECS, HIGH
CVEs in the container runtime are a direct exploit vector.

**Fix in `scripts/ecr-cve-gate.sh`:**
```bash
if [ "$CRITICAL" -gt 0 ]; then
  echo "BLOCKED: $CRITICAL critical CVE(s)" && exit 1
fi
if [ "$HIGH" -gt 0 ]; then     # FIX: was -gt 5
  echo "BLOCKED: $HIGH high CVE(s)" && exit 1
fi
```

Also add the CVE gate to PRs targeting `main` (currently only runs on `develop` and tags):
```yaml
if: github.event_name == 'pull_request' || github.ref == 'refs/heads/develop' || startsWith(github.ref, 'refs/tags/v')
```

---

## Fix 20 — Audit Bucket Missing Object Lock (Audit Trail Can Be Deleted)

**Root cause:** `ComplianceStack` `auditLogBucket` has a lifecycle expiration rule but no
Object Lock. An administrator with `s3:PutLifecycleConfiguration` can shorten retention to
1 day and delete all audit logs. The SCP `DenyAuditTampering` does not deny
`s3:PutLifecycleConfiguration`.

**Fix in `infra/lib/compliance-stack.ts`:**
```typescript
const auditLogBucket = new s3.Bucket(this, 'AuditLogBucket', {
  bucketName:     `skills-svc-audit-${this.account}-${this.region}`,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption:     s3.BucketEncryption.S3_MANAGED,
  enforceSSL:     true,
  versioned:      true,
  objectLockEnabled: true,                          // ADD
  objectLockDefaultRetention: {
    mode:     s3.ObjectLockMode.COMPLIANCE,         // ADD — root cannot delete
    duration: cdk.Duration.days(2555),              // 7 years
  },
  removalPolicy:  cdk.RemovalPolicy.RETAIN,
  lifecycleRules: [{
    id: 'glacier-after-90',
    transitions: [{ storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) }],
  }],
});
```

Add to SCP `DenyAuditTampering`:
```typescript
{
  Sid: 'DenyAuditBucketLifecycle',
  Effect: 'Deny',
  Action: ['s3:PutLifecycleConfiguration', 's3:PutBucketVersioning', 's3:DeleteObject'],
  Resource: ['arn:aws:s3:::skills-svc-audit-*', 'arn:aws:s3:::skills-svc-audit-*/*'],
},
```

---

## Fix 21 — `configure` Command Overwrites Entire Config File (Destroys Manually-Set Fields)

**Root cause:** `configure.ts` always calls `saveConfig(cfg)` with a freshly constructed
object. Any user-customized fields not discoverable from SSM (e.g., custom overrides, migrated
v1 keys) are silently discarded.

**Fix — merge with existing config:**
```typescript
// packages/cli/src/commands/configure.ts
const existing: Partial<CliConfig> = existsSync(profilePath(opts.profile))
  ? JSON.parse(readFileSync(profilePath(opts.profile), 'utf-8'))
  : {};

const cfg: CliConfig = {
  ...existing,                    // preserve all manually-set fields
  profileName: opts.profile,
  region:      opts.region,
  accountId:   opts.account,
  envName:     opts.env,
  // SSM-discovered values overwrite only when non-empty:
  ...Object.fromEntries(
    Object.entries({
      uploadsBucket:    get('s3/uploads-bucket'),
      resultsBucket:    get('s3/results-bucket'),
      uploadsKmsKeyId:  get('kms/uploads-key-id'),
      dynamodbTableName: get('dynamodb/table-name'),
      registryBucket:   get('registry/bucket-name'),
      skillsTableName:  get('registry/skills-table-name'),
      registryKmsKeyId: get('registry/kms-key-id'),
      jobsTopicArn:     get('sns/jobs-topic-arn'),
      opensearchEndpoint: get('opensearch/endpoint'),
      queryLambdaArn:   get('lambda/query-function-arn'),
      runSkillLambdaArn: get('lambda/run-skill-function-arn'),
      mcpEndpoint:      get('mcp/endpoint'),
      batchSfnArn:      get('sfn/batch-arn'),
    }).filter(([, v]) => Boolean(v))  // only overwrite when SSM has a value
  ),
};
saveConfig(cfg);
```

---

## Fix 22 — `watch` Command Uses `fs.watch` Instead of Chokidar + Drops Saves During Running Upload

**Root cause:** `fs.watch` with `{ recursive: true }` is unreliable on Linux (no recursive
inotify). Chokidar was declared as a dependency precisely for this. Also, when a file is
saved while an upload is in progress, `if (running) return` silently drops the change.

**Fix in `packages/cli/src/commands/watch.ts`:**
```typescript
import chokidar from 'chokidar';

const watcher = chokidar.watch(absDir, {
  ignored:       [/\.git/, /node_modules/],
  persistent:    true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: debounceMs, pollInterval: 100 },
  usePolling:    false,
});

let pendingRun = false;

const triggerRun = async (changedFile: string): Promise<void> => {
  if (running) { pendingRun = true; return; }
  pendingRun = false;
  running    = true;
  try {
    await doUpload(changedFile);
  } catch (err) {
    console.error(chalk.red(`Upload error: ${String(err)}`));
  } finally {
    running = false;
    if (pendingRun) void triggerRun(changedFile); // replay queued change
  }
};

watcher.on('change', (filePath) => {
  triggerRun(filePath).catch(err =>
    console.error(chalk.red(`Watch error: ${String(err)}`))
  );
});
```

---

## Fix 23 — `audit` Command Uses Wrong CloudTrail Event Names and Broken `LookupAttributes` Array

**Root cause:** CloudTrail `eventName` for Lambda invocations is `Invoke`, not `InvokeFunction`.
`LookupEventsCommand` silently ignores all but the first `LookupAttribute` — multiple attributes
are not AND'd server-side. The `USERNAME` attribute is wrong for assumed-role sessions
(session names differ per `AssumeRole` call).

**Fix in `packages/cli/src/commands/audit.ts`:**
```typescript
const ACTION_EVENT_MAP: Record<string, string[]> = {
  upload: ['PutObject'],
  query:  ['Invoke'],         // FIX: CloudTrail uses 'Invoke' not 'InvokeFunction'
  cancel: ['StopTask'],       // FIX: separate query needed for UpdateItem
  all:    [],
};

// LookupAttributes: issue separate queries per event name and merge results:
const allRaw: CloudTrailEvent[] = [];
for (const eventName of filterEvents.length ? filterEvents : ['']) {
  const attrs: LookupAttribute[] = eventName
    ? [{ AttributeKey: LookupAttributeKey.EVENT_NAME, AttributeValue: eventName }]
    : [];
  // ... paginate and push to allRaw ...
}

// For assumed-role filtering, use client-side ARN matching:
const finalEvents = opts.user
  ? allRaw.filter(e => {
      try {
        const ev = JSON.parse(e.CloudTrailEvent ?? '{}');
        return ev.userIdentity?.arn?.includes(opts.user) ||
               ev.userIdentity?.sessionContext?.sessionIssuer?.arn?.includes(opts.user);
      } catch { return false; }
    })
  : allRaw;

// Add 90-day guard:
if (opts.since && new Date(opts.since) < new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)) {
  console.warn(chalk.yellow('⚠  CloudTrail LookupEvents only retains 90 days. Requested date is outside window.'));
}
```

---

## Fix 24 — `version --check` Command Implementation

**Root cause:** SPEC-22 Fix 15 declares `version --check` as a needed feature but provides
no code. The command is not registered in `index.ts`. A complete implementation is required.

**New file `packages/cli/src/commands/version-check.ts`:**
```typescript
import { Command }  from 'commander';
import * as https   from 'https';
import { lt as semverLt } from 'semver';
import chalk from 'chalk';

function fetchLatestVersion(timeout = 5_000): Promise<string | null> {
  return new Promise(resolve => {
    const req = https.get(
      'https://registry.npmjs.org/%40skills-svc%2Fcli/latest',
      { timeout },
      res => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body).version); } catch { resolve(null); } });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
  });
}

export function versionCheckCommand(): Command {
  return new Command('version')
    .description('Show CLI version and optionally check for updates')
    .option('--check', 'Check npm registry for a newer version')
    .action(async (opts: { check: boolean }) => {
      const { version: current } = require('../../package.json') as { version: string };
      console.log(`skills-svc v${current}`);
      if (!opts.check) return;

      process.stdout.write(chalk.dim('Checking npm registry...'));
      const latest = await fetchLatestVersion();

      if (!latest) {
        process.stdout.write(chalk.dim(' (unreachable)\n'));
        return;
      }
      process.stdout.write('\n');
      if (!semverLt(current, latest)) {
        console.log(chalk.green(`✓ You are on the latest version (${current})`));
      } else {
        console.log(chalk.yellow(`\n  Update available: ${current} → ${chalk.bold(latest)}`));
        console.log(`  Run: ${chalk.cyan('npm install -g @skills-svc/cli@latest')}`);
      }
    });
}
```

Register in `packages/cli/src/index.ts`:
```typescript
import { versionCheckCommand } from './commands/version-check';
program.addCommand(versionCheckCommand());
```

---

## Fix 25 — `list-jobs` Default Path Returns `[]` with a Placeholder Comment

**Root cause:** SPEC-03 §5.6 `list-jobs.ts` has:
```typescript
} else {
  items = []; // For brevity — implement GSI2 user-based query in practice
}
```
A user running `skills-svc list-jobs` (no `--status`) always sees "No jobs found."

**Fix — implement GSI2-User query as the default:**
```typescript
} else {
  const identity = await new STSClient({ region: cfg.region, credentials: credProvider })
    .send(new GetCallerIdentityCommand({}));
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

## Fix 26 — `upload` Command Uses `readFileSync` on Files Up to 500 MB (OOM Crash)

**Root cause:** `upload.ts` calls `Body: readFileSync(zipPath)` which loads the entire file
into the Node.js heap. For a 500 MB zip this allocates ~500 MB. Combined with `AdmZip`
validation (another ~500 MB), the CLI crashes with `JavaScript heap out of memory` for
large skill zips. The `watch` command has the same bug.

**Fix in `packages/cli/src/commands/upload.ts`:**
```typescript
import { createReadStream, statSync } from 'fs';
import { Upload } from '@aws-sdk/lib-storage';

const stat = statSync(zipPath);

const upload = new Upload({
  client: s3,
  params: {
    Bucket: cfg.uploadsBucket,
    Key: s3Key,
    Body: createReadStream(zipPath),    // streaming — O(1) memory
    ContentType: 'application/zip',
    ContentLength: stat.size,           // required when Body is a stream
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: cfg.uploadsKmsKeyId,
    ChecksumAlgorithm: 'SHA256',
    Metadata: { 'job-name': opts.jobName, 'user-arn': identity.Arn! },
  },
});

upload.on('httpUploadProgress', progress => {
  const pct = Math.round(((progress.loaded ?? 0) / stat.size) * 100);
  process.stdout.write(`\r  Uploading... ${pct}%`);
});
await upload.done();
process.stdout.write('\n');
```

Add `@aws-sdk/lib-storage` to `packages/cli/package.json`.

---

## Fix 27 — Schedule Overlap Protection (Concurrent Runs Corrupt OpenSearch Documents)

**Root cause:** No mechanism prevents the Monday 9am schedule from firing while the previous
week's run is still active. Two ECS tasks run concurrently for the same schedule, both write
OpenSearch documents for the same `scheduleId`, and the result is duplicate or corrupted
knowledge store entries.

**Fix in `packages/lambda/src/schedule-trigger/handler.ts`:**
```typescript
// Check for active run before copying the zip:
const activeRuns = await ddb.send(new QueryCommand({
  TableName: process.env.DYNAMODB_TABLE_NAME!,
  IndexName: 'GSI3-Schedule',
  KeyConditionExpression: 'GSI3PK = :sk',
  FilterExpression: '#status IN (:pending, :running)',
  ExpressionAttributeNames: { '#status': 'status' },
  ExpressionAttributeValues: {
    ':sk':      `SCHEDULE#${event.scheduleId}`,
    ':pending': 'PENDING',
    ':running': 'RUNNING',
  },
  Limit: 1,
}));

if (activeRuns.Items?.length) {
  console.warn(JSON.stringify({
    event: 'schedule_skipped_overlap',
    scheduleId: event.scheduleId,
    activeJobId: activeRuns.Items[0].jobId,
    message: 'Previous run still active — skipping to prevent concurrent execution',
  }));
  return;  // EventBridge Scheduler auto-retries on next cron tick; no action needed here
}
```

Also ensure `ingestionLambdaRole` has `dynamodb:Query` on `GSI3-Schedule`:
```typescript
this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'QueryGSI3ScheduleOverlap',
  actions: ['dynamodb:Query'],
  resources: [
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-jobs-.../index/GSI3-Schedule`,
  ],
}));
```

---

## Fix 28 — AOSS Indexing Failure Silently Swallowed; No Alarm; No Re-index Path

**Root cause:** When AOSS is unavailable during `indexJobResult`, the catch block logs
`indexing_error` and continues — the job is marked `COMPLETE` but never appears in query
results. There is no CloudWatch metric, no alarm, and no `needsReindex` flag on the job
record. An AOSS outage creates a silent data loss window with no operator notification.

**Fix — tag jobs needing reindex and emit metric:**
```typescript
// packages/lambda/src/results-processor/handler.ts
} catch (err) {
  console.error(JSON.stringify({ event: 'indexing_error', jobId, err: String(err) }));

  // Emit metric for ops alarm
  await cw.send(new PutMetricDataCommand({
    Namespace: 'skills-svc/AOSS',
    MetricData: [{ MetricName: 'IndexingFailures', Value: 1, Unit: 'Count',
                   Dimensions: [{ Name: 'Environment', Value: env }] }],
  }));

  // Flag job for later re-indexing
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
    UpdateExpression: 'SET needsReindex = :t, indexingError = :err',
    ExpressionAttributeValues: { ':t': true, ':err': String(err) },
  }));
}
```

Add AOSS alarm to `MonitoringStack`:
```typescript
new cloudwatch.Alarm(this, 'AossIndexingFailureAlarm', {
  alarmName:  `skills-svc-${envName}-aoss-indexing-failures`,
  metric: new cloudwatch.Metric({
    namespace: 'skills-svc/AOSS', metricName: 'IndexingFailures',
    dimensionsMap: { Environment: envName }, period: cdk.Duration.minutes(5), statistic: 'Sum',
  }),
  threshold: 1, evaluationPeriods: 1,
  alarmDescription: 'AOSS indexing failing — jobs COMPLETE but not queryable. Jobs flagged needsReindex=true.',
}).addAlarmAction(alarmAction);
```

---

## Fix 29 — Config Migration v1→v2 Silently Breaks All Commands (No Migration Logic)

**Root cause:** The v1 config at `~/.skills-svc/config.json` is never read by the v2
`loadConfig()`. After upgrade, every command throws `Profile "default" not found` with no
explanation. New v2 fields (`registryBucket`, `skillsTableName`, `runSkillLambdaArn`, etc.)
are `undefined` when cast from v1 JSON, causing runtime crashes on any command using them.

**Fix in `packages/cli/src/utils/config.ts`:**
```typescript
const LEGACY_CONFIG = path.join(CONFIG_DIR, 'config.json');

export function loadConfig(profileName?: string): CliConfig {
  const name = profileName ?? getDefaultProfileName();
  const file = profilePath(name);

  if (!existsSync(file)) {
    if (existsSync(LEGACY_CONFIG)) {
      const legacy = JSON.parse(readFileSync(LEGACY_CONFIG, 'utf-8')) as Partial<CliConfig>;
      console.warn(chalk.yellow(
        '\n⚠  CLI upgraded from v1. Migrating config to profile "default"...\n' +
        '   New v2 fields need values — run: skills-svc configure --region <r> --account <a>\n'
      ));
      const migrated: CliConfig = {
        profileName: 'default',
        region:      legacy.region ?? '',
        accountId:   legacy.accountId ?? '',
        envName:     legacy.envName ?? 'prod',
        // Fill all existing v1 fields:
        uploadsBucket:    legacy.uploadsBucket    ?? '',
        resultsBucket:    legacy.resultsBucket    ?? '',
        uploadsKmsKeyId:  legacy.uploadsKmsKeyId  ?? '',
        dynamodbTableName: legacy.dynamodbTableName ?? '',
        jobsTopicArn:     legacy.jobsTopicArn     ?? '',
        opensearchEndpoint: legacy.opensearchEndpoint ?? '',
        queryLambdaArn:   legacy.queryLambdaArn   ?? '',
        // New v2 fields — must be populated by re-running configure:
        registryBucket: '', skillsTableName: '', registryKmsKeyId: '',
        runSkillLambdaArn: '', mcpEndpoint: '', batchSfnArn: '',
      };
      mkdirSync(PROFILES_DIR, { recursive: true });
      saveConfig(migrated);
      setDefaultProfileName('default');
      return migrated;
    }
    throw new Error(
      `Profile "${name}" not found.\nRun: skills-svc configure --region us-east-1 --account <ACCOUNT_ID>`
    );
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as CliConfig;
}
```

---

## Fix 30 — `MCP job_status` Returns Free-Text Only; Agents Cannot Branch on Status Field

**Root cause:** `job-status.ts` returns `[{ type: 'text', text: lines.join('\n') }]`.
An LLM agent polling `job_status` in a loop must parse prose to detect `COMPLETE` —
fragile and wasteful. MCP supports `type: 'resource'` for structured data.

**Fix — return both text and machine-readable resource:**
```typescript
// packages/lambda/src/mcp/tools/job-status.ts
return [
  { type: 'text', text: lines.join('\n') },
  {
    type: 'resource',
    resource: {
      uri: `skills://jobs/${jobId}`,
      mimeType: 'application/json',
      text: JSON.stringify({
        jobId:      job.jobId,
        jobName:    job.jobName,
        status:     job.status,
        createdAt:  job.createdAt,
        updatedAt:  job.updatedAt,
        isTerminal: job.status === 'COMPLETE' || job.status === 'FAILED',
        pollAgainInSeconds: (job.status === 'PENDING' || job.status === 'RUNNING') ? 5 : null,
        ...(job.status === 'FAILED'   ? { errorMessage: job.errorMessage } : {}),
        ...(job.status === 'COMPLETE' ? { resultAvailable: Boolean(job.s3ResultKey) } : {}),
      }),
    },
  },
];
```

---

## Summary

| Fix | Category | Severity | Issue |
|-----|----------|----------|-------|
| 1   | ECS runner      | CRITICAL  | `ANTHROPIC_API_KEY` never injected — every ECS job fails |
| 2   | Knowledge store | BLOCKING  | `hybrid` query unsupported without search pipeline — every query returns 400 |
| 3   | Lambda          | BLOCKING  | `query/handler.ts` never implemented — Lambda crashes on invocation |
| 4   | Batch           | BLOCKING  | `batch-submit/batch-status` handlers never implemented; EXPRESS workflow 5-min cap |
| 5   | Schedule        | BLOCKING  | Scheduler IAM role has `s3:PutObject` not `lambda:InvokeFunction` |
| 6   | Schedule        | BLOCKING  | 5-field Unix cron silently rejected by EventBridge Scheduler |
| 7   | Schedule        | BLOCKING  | No ownership check on schedule CRUD; no overlap protection; `UpdateSchedule` drops timezone |
| 8   | Skill registry  | BLOCKING  | SemVer build metadata produces NaN DDB sort keys |
| 9   | Skill registry  | BLOCKING  | Deprecation SNS never published (validator only fires on push, not deprecate) |
| 10  | Monitoring      | BLOCKING  | `ECS:TaskFailures` metric never emitted; no failure-rate alarm |
| 11  | Monitoring      | BLOCKING  | `health` stuckJobs always returns OK (hardcoded placeholder) |
| 12  | IAM             | BLOCKING  | `UserRole` missing SQS/ECS/CloudTrail permissions — health/dlq/cancel/audit all fail |
| 13  | GDPR            | BLOCKING  | `delete-user` not under `compliance` subcommand; missing OpenSearch delete, paginated S3 delete, ECS stop, schedule cancel, audit receipt, IAM role |
| 14  | MCP             | BLOCKING  | `submit_job` returns no job ID — poll loop impossible |
| 15  | MCP             | BLOCKING  | `env` field ignored in HTTP MCP transport — all tool calls return 403 |
| 16  | MCP             | BLOCKING  | Tool schemas use `type: 'string'` for numeric/boolean params |
| 17  | IAM/CDK         | BLOCKING  | `ComprehendPII` not in `WILDCARD_EXCEPTION_SIDS` — CDK synth fails |
| 18  | IAM             | BLOCKING  | No permission boundary on `UserRole` — IAM escalation possible |
| 19  | CI/CD           | BLOCKING  | ECR CVE gate allows 5 HIGH severity vulnerabilities |
| 20  | Compliance      | BLOCKING  | Audit bucket lacks Object Lock — audit trail deletable |
| 21  | CLI             | BLOCKING  | `configure` overwrites entire config file (destroys manually-set fields) |
| 22  | CLI             | BLOCKING  | `watch` uses `fs.watch` (unreliable on Linux); drops saves during active upload |
| 23  | CLI             | BLOCKING  | `audit` uses wrong CloudTrail event names; `LookupAttributes` array only uses first item |
| 24  | CLI             | BLOCKING  | `version --check` command never implemented |
| 25  | CLI             | BLOCKING  | `list-jobs` default returns `[]` (GSI2 query commented out as "for brevity") |
| 26  | CLI             | BLOCKING  | `upload` uses `readFileSync` on 500 MB files — OOM crash |
| 27  | Schedule        | CORRECTNESS | No overlap protection — concurrent scheduled runs corrupt OpenSearch |
| 28  | AOSS            | BLOCKING  | Indexing failure silently swallowed; no alarm; no reindex path |
| 29  | CLI             | BLOCKING  | v1→v2 config migration missing — every command fails after upgrade |
| 30  | MCP             | CORRECTNESS | `job_status` free-text only — agents cannot branch on status field |
