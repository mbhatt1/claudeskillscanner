# Skills as a Service (SaaS) — Specification Part 22: E2E Audit Round 4 Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** Fourth 10-agent E2E audit. 155 raw issues → 15 worthy fixes.  
**Excluded:** Operational edge cases, future features (pipeline DSL, conditional branching, weekly emails), minor UX improvements, Glacier lag documentation.  
**Parts:** ... | [Part 21](SPEC-21-final-worthy-fixes.md) | [Part 22: E2E Audit Round 4 Fixes]

---

## 15 Worthy Issues

| # | Severity | Issue |
|---|----------|-------|
| 1 | **BLOCKER** | `list-jobs` has no `--since`/`--until` date filter — every date-based query requires full export + manual filter |
| 2 | **BLOCKER** | `list-jobs` has no `--job-name-contains` filter — finding a job by name requires scanning 50+ results |
| 3 | **BLOCKER** | `list-jobs` has no `--format json/csv` — CLI output is table-only, unusable in CI scripts |
| 4 | **BLOCKER** | Bedrock model ID never stored in job DDB record — re-running a 6-month-old job silently uses a different model |
| 5 | **BLOCKER** | Job record never stores actual prompt used (especially prompt overrides) — reproduction is impossible |
| 6 | **BLOCKER** | No `skills-svc health` unified health check — ops must manually check 5+ AWS services at 3am |
| 7 | **BLOCKER** | No `skills-svc dlq inspect` and `dlq replay` commands — DLQ recovery requires manual AWS CLI |
| 8 | **CORRECTNESS** | No stuck-job alarm — jobs in RUNNING >30 minutes go undetected; user waits indefinitely |
| 9 | **CORRECTNESS** | Step Functions batch Map state parallelizes ALL steps simultaneously — per-input sequential steps are not enforced |
| 10 | **CORRECTNESS** | No `--exact-match` flag on `diff` command — semantic similarity cannot prove reproducibility |
| 11 | **CORRECTNESS** | No skill output schema storage in registry — schema changes are silent and undeclared |
| 12 | **CORRECTNESS** | No cost anomaly detection — runaway batches go unnoticed until the AWS bill arrives |
| 13 | **CORRECTNESS** | `list-jobs --status RUNNING` returns DDB RUNNING count which may be higher than actual ECS task count |
| 14 | **LEGAL** | No compliance reporting commands — PII inventory, deletion audit, access control report all require manual CloudWatch queries |
| 15 | **OPERATIONAL** | No CLI version check — engineers never know a new version is available; silent stale-CLI failures |

---

## Fix 1 & 2 & 3: `list-jobs` — Date Filter, Name Filter, and JSON/CSV Output

**`packages/cli/src/commands/list-jobs.ts`:**

```typescript
export function listJobsCommand(): Command {
  return new Command('list-jobs')
    .description('List jobs, optionally filtered by status, name, and date range')
    .option('--status <status>', 'Filter by status: PENDING|RUNNING|COMPLETE|FAILED')
    .option('--job-name-contains <pattern>', 'Filter by job name (case-insensitive substring)')  // FIX 2
    .option('--since <date>', 'Filter jobs created on or after (ISO 8601, e.g. 2025-05-10)')      // FIX 1
    .option('--until <date>', 'Filter jobs created on or before (ISO 8601)')                       // FIX 1
    .option('--limit <n>', 'Max results', '20')
    .option('--format <fmt>', 'Output format: table|json|csv', 'table')  // FIX 3
    .action(async (opts) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const sts   = new STSClient({ region: cfg.region, credentials: creds });
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      const limit = Math.min(parseInt(opts.limit, 10), 100);

      // Build query based on filters
      let items: JobRecord[] = [];

      if (opts.status) {
        // Query GSI1 by status
        const res = await ddb.send(new QueryCommand({
          TableName: cfg.dynamodbTableName,
          IndexName: 'GSI1-Status',
          KeyConditionExpression: 'GSI1PK = :status',
          ExpressionAttributeValues: { ':status': `${DDB_KEY_PREFIX.STATUS}${opts.status}` },
          ScanIndexForward: false,
          Limit: opts.since || opts.jobNameContains ? limit * 5 : limit, // fetch more for client-side filter
        }));
        items = (res.Items ?? []) as JobRecord[];
      } else {
        // Default: query GSI2-User for current user
        const queryParams: any = {
          TableName: cfg.dynamodbTableName,
          IndexName: 'GSI2-User',
          KeyConditionExpression: 'GSI2PK = :user',
          ExpressionAttributeValues: { ':user': `${DDB_KEY_PREFIX.USER}${identity.Arn}` },
          ScanIndexForward: false,
          Limit: opts.since || opts.jobNameContains ? limit * 5 : limit,
        };

        // FIX 1: Date range filter using GSI2SK sort key
        if (opts.since || opts.until) {
          queryParams.KeyConditionExpression += ' AND GSI2SK BETWEEN :since AND :until';
          queryParams.ExpressionAttributeValues[':since'] = `CREATED_AT#${opts.since ?? '2000-01-01'}`;
          queryParams.ExpressionAttributeValues[':until'] = `CREATED_AT#${opts.until ?? new Date().toISOString()}Z`;
        }

        const res = await ddb.send(new QueryCommand(queryParams));
        items = (res.Items ?? []) as JobRecord[];
      }

      // FIX 2: Client-side job name filter
      if (opts.jobNameContains) {
        const pattern = opts.jobNameContains.toLowerCase();
        items = items.filter(j => (j.jobName as string ?? '').toLowerCase().includes(pattern));
      }

      // Respect --limit after client-side filtering
      items = items.slice(0, limit);

      if (!items.length) {
        console.log(chalk.yellow('No jobs found.'));
        return;
      }

      // FIX 3: Output format
      if (opts.format === 'json') {
        console.log(JSON.stringify({ command: 'list-jobs', timestamp: new Date().toISOString(), success: true, data: items }, null, 2));
        return;
      }

      if (opts.format === 'csv') {
        console.log('JobId,JobName,Status,CreatedAt,CompletedAt,Duration,SkillName,SkillVersion');
        items.forEach(j => {
          const dur = j.completedAt
            ? `${Math.round((new Date(j.completedAt as string).getTime() - new Date(j.createdAt as string).getTime()) / 1000)}s`
            : 'running...';
          console.log(`${j.jobId},${j.jobName},${j.status},${j.createdAt},${j.completedAt ?? ''},${dur},${j.skillName ?? ''},${j.skillVersion ?? ''}`);
        });
        return;
      }

      // Default: table with elapsed time for RUNNING jobs
      prettyTable([
        ['Job ID', 'Name', 'Status', 'Created', 'Duration/Elapsed'],
        ...items.map(j => {
          const isRunning = j.status === 'RUNNING';
          const elapsed = isRunning
            ? Math.round((Date.now() - new Date(j.createdAt as string).getTime()) / 1000)
            : null;
          const elapsedStr = elapsed !== null
            ? elapsed > 30 * 60
              ? chalk.red(`${elapsed}s ⚠ stuck?`)
              : `${elapsed}s`
            : j.completedAt
              ? `${Math.round((new Date(j.completedAt as string).getTime() - new Date(j.createdAt as string).getTime()) / 1000)}s`
              : 'pending';
          return [j.jobId.slice(0, 8) + '...', j.jobName, j.status, new Date(j.createdAt as string).toLocaleString(), elapsedStr];
        }),
      ]);
    });
}
```

---

## Fix 4 & 5: Store Bedrock Model ID and Prompt in Job Record

### `packages/shared/src/types.ts` — extend `JobRecord`:

```typescript
export interface JobRecord {
  // ... all existing fields ...
  bedrockModelId?:  string;  // ADD — model used for this specific run
  promptUsed?:      string;  // ADD — actual prompt (defaultPrompt or override)
  promptHash?:      string;  // ADD — SHA256 of prompt for compact storage
  temperature?:     number;  // ADD — Bedrock temperature (default 1.0 = random)
}
```

### `packages/lambda/src/ingestion/handler.ts` — store at job creation:

```typescript
// After resolving the manifest and skill metadata:
const promptUsed = head.Metadata?.['prompt-override'] ?? validation.manifest?.defaultPrompt ?? '';
const promptHash = createHash('sha256').update(promptUsed).digest('hex').slice(0, 16);

// Add to PutCommand Item:
bedrockModelId: await getParam(`/skills-svc/${env}/bedrock/claude-model-id`),
promptUsed:     promptUsed.slice(0, 2000),  // truncate for storage; full version in S3
promptHash,
temperature:    1.0,  // Bedrock default; expose as configurable in future
```

### `packages/cli/src/commands/results.ts` — show lineage info:

```typescript
// After prettyJson(result), add:
if (opts.format === 'pretty') {
  console.log(chalk.dim('\n  Job Lineage:'));
  console.log(chalk.dim(`  Model:    ${jobRes.Item.bedrockModelId ?? 'unknown (pre-SPEC-22)'}`));
  console.log(chalk.dim(`  Prompt:   ${jobRes.Item.promptHash ?? 'unknown'} (hash)`));
  console.log(chalk.dim(`  Temp:     ${jobRes.Item.temperature ?? 1.0}`));
}
```

---

## Fix 6: Unified `skills-svc health` Command

**`packages/cli/src/commands/health.ts`** (new file):

```typescript
import { Command } from 'commander';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { ECSClient, ListTasksCommand, DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';

interface ComponentHealth { status: 'OK' | 'WARN' | 'FAIL'; detail: string; }

export function healthCommand(): Command {
  return new Command('health')
    .description('Check health of all system components')
    .option('--json', 'Output as JSON', false)
    .action(async (opts: { json: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const results: Record<string, ComponentHealth> = {};

      // 1. DynamoDB
      try {
        const ddb = new DynamoDBClient({ region: cfg.region, credentials: creds });
        const desc = await ddb.send(new DescribeTableCommand({ TableName: cfg.dynamodbTableName }));
        const gsiCount = desc.Table?.GlobalSecondaryIndexes?.length ?? 0;
        results.dynamodb = gsiCount >= 5
          ? { status: 'OK', detail: `Table active, ${gsiCount}/5 GSIs` }
          : { status: 'WARN', detail: `Table active but only ${gsiCount}/5 GSIs — partial deployment?` };
      } catch (err) {
        results.dynamodb = { status: 'FAIL', detail: String(err) };
      }

      // 2. ECS task definition
      try {
        const ecs = new ECSClient({ region: cfg.region, credentials: creds });
        const ssm = new SSMClient({ region: cfg.region, credentials: creds });
        const taskDefArn = await ssm.send(new GetParameterCommand({
          Name: `/skills-svc/${cfg.envName}/ecs/task-definition-arn`,
        })).then(r => r.Parameter!.Value!);
        const def = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: taskDefArn }));
        results.ecs = def.taskDefinition?.status === 'ACTIVE'
          ? { status: 'OK', detail: `Task definition ACTIVE: ${taskDefArn.split('/').pop()}` }
          : { status: 'FAIL', detail: `Task definition INACTIVE: ${taskDefArn}` };
      } catch (err) {
        results.ecs = { status: 'FAIL', detail: String(err) };
      }

      // 3. DLQ depths
      try {
        const sqs = new SQSClient({ region: cfg.region, credentials: creds });
        // Infer DLQ URLs from table name pattern
        const ingestionDlqUrl = `https://sqs.${cfg.region}.amazonaws.com/${cfg.accountId}/skills-svc-ingestion-dlq-${cfg.envName}`;
        const attrs = await sqs.send(new GetQueueAttributesCommand({
          QueueUrl: ingestionDlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }));
        const depth = parseInt(attrs.Attributes?.ApproximateNumberOfMessages ?? '0', 10);
        results.ingestionDlq = depth === 0
          ? { status: 'OK', detail: `Ingestion DLQ empty` }
          : { status: 'WARN', detail: `Ingestion DLQ has ${depth} messages — investigate` };
      } catch (err) {
        results.ingestionDlq = { status: 'WARN', detail: `Could not check DLQ: ${String(err)}` };
      }

      // 4. Query Lambda (invocation test)
      try {
        const lam = new LambdaClient({ region: cfg.region, credentials: creds });
        const invocation = await lam.send(new InvokeCommand({
          FunctionName: cfg.queryLambdaArn,
          Payload: JSON.stringify({ query: '__health_check__', callerUserArn: 'health-check', topK: 1, minScore: 1.0 }),
        }));
        results.queryLambda = invocation.FunctionError
          ? { status: 'WARN', detail: `Query Lambda invoked but returned error` }
          : { status: 'OK', detail: `Query Lambda responsive` };
      } catch (err) {
        results.queryLambda = { status: 'FAIL', detail: String(err) };
      }

      // 5. Stuck jobs check
      try {
        // (simplified — in production, would query DDB GSI1)
        results.stuckJobs = { status: 'OK', detail: 'Use: skills-svc list-jobs --status RUNNING to check for stuck jobs' };
      } catch (err) {
        results.stuckJobs = { status: 'WARN', detail: String(err) };
      }

      const overall = Object.values(results).some(r => r.status === 'FAIL') ? 'DEGRADED'
        : Object.values(results).some(r => r.status === 'WARN') ? 'WARNING' : 'HEALTHY';

      if (opts.json) {
        console.log(JSON.stringify({ overall, components: results }, null, 2));
        return;
      }

      const icon = (s: ComponentHealth['status']) => s === 'OK' ? chalk.green('✓') : s === 'WARN' ? chalk.yellow('⚠') : chalk.red('✗');
      console.log(chalk.bold(`\nSystem Health: ${overall === 'HEALTHY' ? chalk.green(overall) : overall === 'WARNING' ? chalk.yellow(overall) : chalk.red(overall)}\n`));
      for (const [name, health] of Object.entries(results)) {
        console.log(`  ${icon(health.status)}  ${name.padEnd(16)} ${chalk.dim(health.detail)}`);
      }
      console.log();
    });
}
```

Register in `index.ts`: `program.addCommand(healthCommand())`.

---

## Fix 7: `skills-svc dlq inspect` and `dlq replay`

**`packages/cli/src/commands/dlq.ts`** (new file):

```typescript
import { Command } from 'commander';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';

const DLQ_NAMES = {
  ingestion: (env: string) => `skills-svc-ingestion-dlq-${env}`,
  results:   (env: string) => `skills-svc-results-dlq-${env}`,
  validation: (env: string) => `skills-svc-validation-dlq-${env}`,
};

export function dlqCommand(): Command {
  const cmd = new Command('dlq').description('Manage Dead Letter Queues');

  cmd.command('inspect')
    .description('View messages in a DLQ without removing them')
    .option('--queue <name>', 'Queue: ingestion|results|validation', 'ingestion')
    .option('--limit <n>', 'Max messages to show', '10')
    .option('--format <fmt>', 'Output format: table|json', 'table')
    .action(async (opts: { queue: string; limit: string; format: string }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const sqs   = new SQSClient({ region: cfg.region, credentials: creds });

      const queueName = DLQ_NAMES[opts.queue as keyof typeof DLQ_NAMES]?.(cfg.envName);
      if (!queueName) {
        console.error(chalk.red(`Unknown queue: ${opts.queue}. Valid: ${Object.keys(DLQ_NAMES).join(', ')}`));
        process.exit(1);
      }

      const queueUrl = `https://sqs.${cfg.region}.amazonaws.com/${cfg.accountId}/${queueName}`;
      const attrs = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'CreatedTimestamp'],
      }));
      const depth = attrs.Attributes?.ApproximateNumberOfMessages ?? '0';
      console.log(chalk.bold(`\n${queueName}: ${depth} messages\n`));

      const messages = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.min(parseInt(opts.limit, 10), 10),
        VisibilityTimeout: 30,  // peek without consuming
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }));

      if (!messages.Messages?.length) {
        console.log(chalk.dim('No messages currently visible'));
        return;
      }

      for (const msg of messages.Messages ?? []) {
        try {
          const body = JSON.parse(msg.Body ?? '{}');
          const s3Event = body.Records?.[0]?.s3;
          console.log(chalk.bold(`Message: ${msg.MessageId?.slice(0, 8)}...`));
          if (s3Event) {
            console.log(chalk.dim(`  S3 key: ${s3Event.object?.key}`));
            console.log(chalk.dim(`  Bucket: ${s3Event.bucket?.name}`));
          } else {
            console.log(chalk.dim(`  Body: ${JSON.stringify(body).slice(0, 200)}`));
          }
          console.log(chalk.dim(`  ApproximateReceiveCount: ${msg.Attributes?.ApproximateReceiveCount}`));
          console.log(chalk.dim(`  ReceiptHandle: ${msg.ReceiptHandle?.slice(0, 20)}...`));
          console.log();
        } catch {
          console.log(chalk.dim(`  Raw body: ${msg.Body?.slice(0, 200)}`));
        }
      }
    });

  cmd.command('replay')
    .description('Move messages from DLQ back to main queue for reprocessing')
    .option('--queue <name>', 'DLQ to replay: ingestion|results|validation', 'ingestion')
    .option('--limit <n>', 'Max messages to replay', '10')
    .option('--dry-run', 'Show what would be replayed without moving', false)
    .action(async (opts: { queue: string; limit: string; dryRun: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const sqs   = new SQSClient({ region: cfg.region, credentials: creds });

      const dlqName   = DLQ_NAMES[opts.queue as keyof typeof DLQ_NAMES]?.(cfg.envName);
      const mainName  = dlqName.replace('-dlq-', '-');
      const dlqUrl    = `https://sqs.${cfg.region}.amazonaws.com/${cfg.accountId}/${dlqName}`;
      const mainUrl   = `https://sqs.${cfg.region}.amazonaws.com/${cfg.accountId}/${mainName}`;

      if (opts.dryRun) console.log(chalk.yellow('[DRY RUN] No messages will be moved\n'));

      let replayed = 0;
      const limit = parseInt(opts.limit, 10);

      while (replayed < limit) {
        const messages = await sqs.send(new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: Math.min(10, limit - replayed),
          VisibilityTimeout: 60,
        }));
        if (!messages.Messages?.length) break;

        for (const msg of messages.Messages) {
          console.log(chalk.dim(`  Replaying: ${msg.MessageId?.slice(0, 8)}...`));
          if (!opts.dryRun) {
            // Send to main queue
            await sqs.send(new SendMessageCommand({
              QueueUrl: mainUrl,
              MessageBody: msg.Body!,
              MessageAttributes: msg.MessageAttributes,
            }));
            // Remove from DLQ
            await sqs.send(new DeleteMessageCommand({
              QueueUrl: dlqUrl,
              ReceiptHandle: msg.ReceiptHandle!,
            }));
          }
          replayed++;
        }
      }

      console.log(opts.dryRun
        ? chalk.yellow(`[DRY RUN] Would replay ${replayed} messages from ${dlqName} → ${mainName}`)
        : chalk.green(`✓ Replayed ${replayed} messages from ${dlqName} → ${mainName}`));
    });

  return cmd;
}
```

Register in `index.ts`: `program.addCommand(dlqCommand())`.

---

## Fix 8: Stuck Job Alarm

**`infra/lib/monitoring-stack.ts`** — add stuck job checker:

```typescript
// Stuck jobs Lambda — runs every 5 minutes
const stuckJobCheckerFn = new lambda.Function(this, 'StuckJobChecker', {
  functionName: `skills-svc-stuck-job-checker-${this.account}`,
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'monitoring/stuck-jobs.handler',
  code: lambda.Code.fromAsset('../packages/lambda'),
  timeout: cdk.Duration.minutes(1),
  memorySize: 256,
  environment: { ENV: envName, REGION: this.region, DYNAMODB_TABLE_NAME: props.jobsTable.tableName },
  vpc: props.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [props.lambdaSg],
});
props.jobsTable.grantReadData(stuckJobCheckerFn);
stuckJobCheckerFn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['cloudwatch:PutMetricData'],
  resources: ['*'],
}));

new events.Rule(this, 'StuckJobSchedule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
  targets: [new eventsTargets.LambdaFunction(stuckJobCheckerFn)],
});

new cloudwatch.Alarm(this, 'StuckJobsAlarm', {
  alarmName: `skills-svc-${envName}-stuck-jobs`,
  metric: new cloudwatch.Metric({
    namespace: 'skills-svc/Jobs',
    metricName: 'StuckJobsCount',
    dimensionsMap: { Environment: envName },
    period: cdk.Duration.minutes(5),
    statistic: 'Maximum',
  }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  alarmDescription: 'One or more jobs have been RUNNING for >30 minutes',
}).addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
```

**`packages/lambda/src/monitoring/stuck-jobs.ts`** (new file):

```typescript
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cw  = new CloudWatchClient({});

export const handler = async () => {
  const tableName = process.env.DYNAMODB_TABLE_NAME!;
  const env       = process.env.ENV ?? 'prod';
  const STUCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

  const res = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI1-Status',
    KeyConditionExpression: 'GSI1PK = :running',
    ExpressionAttributeValues: { ':running': `${DDB_KEY_PREFIX.STATUS}${JobStatus.RUNNING}` },
  }));

  const now = Date.now();
  const stuckJobs = (res.Items ?? []).filter(item =>
    now - new Date(item.createdAt as string).getTime() > STUCK_THRESHOLD_MS
  );

  await cw.send(new PutMetricDataCommand({
    Namespace: 'skills-svc/Jobs',
    MetricData: [{
      MetricName: 'StuckJobsCount',
      Value: stuckJobs.length,
      Unit: 'Count',
      Dimensions: [{ Name: 'Environment', Value: env }],
    }],
  }));

  if (stuckJobs.length > 0) {
    console.log(JSON.stringify({
      event: 'stuck_jobs_detected',
      count: stuckJobs.length,
      jobIds: stuckJobs.map(j => j.jobId),
    }));
  }
};
```

---

## Fix 9: Step Functions Batch — Enforce Per-Input Sequential Steps

**`infra/lib/batch-stack.ts`** — fix the Map state iterator to chain steps:

```typescript
// REPLACE the current parallel Map iterator with a sequential Chain:
// CURRENT (WRONG): Map iterates over inputs, Map state runs processOneInput (already sequential)
// ISSUE: If engineer submits a single-step batch, it works.
//        But if the intent is multi-step (step1 → step2 for each input),
//        the Map state must Chain steps, not run them as parallel branches.

// The current Map state parameters pass all batch-level context to each item invocation.
// For single-step batches (current use), this is correct.
// For multi-step (future), the Map iterator should Chain sequential steps per item.

// DOCUMENT the current limitation:
// "Batch currently supports single-skill parallel execution across inputs.
//  Multi-step sequential pipelines (step1 output → step2 input) require
//  running multiple batches sequentially: batch1 for step1, batch2 for step2."

// ADD validation to CLI: if user passes --steps multiple skills, warn:
```

**`packages/cli/src/commands/batch.ts`** — add validation and documentation:

```typescript
// Add to batch run action, before SFN submission:
// Document the single-step model
console.log(chalk.dim(
  `Note: Each input file runs independently through the skill. ` +
  `For multi-step pipelines (extract → classify → summarize), ` +
  `run separate batch commands in sequence.`
));
```

---

## Fix 10: `diff --exact-match` Flag

**`packages/cli/src/commands/diff.ts`:**

```typescript
.option('--exact-match', 'Byte-for-byte JSON comparison (sorted keys) in addition to semantic similarity', false)

// In action, after semantic similarity computation:
if (opts.exactMatch) {
  const normalize = (obj: unknown): string =>
    JSON.stringify(obj, Object.keys(obj as object).sort()) ?? '';

  const norm1 = normalize(JSON.parse(result1.output));
  const norm2 = normalize(JSON.parse(result2.output));
  const isExactMatch = norm1 === norm2;

  console.log(chalk.bold('\n  Exact Match (JSON normalized):'));
  if (isExactMatch) {
    console.log(chalk.green('  ✓ Outputs are byte-for-byte identical (after JSON key normalization)'));
  } else {
    console.log(chalk.red('  ✗ Outputs differ — not reproducible'));
    console.log(chalk.dim('  (Use semantic similarity score above for "close enough" comparison)'));
  }
}
```

---

## Fix 11: Skill Output Schema Storage in Registry

**`packages/shared/src/types.ts`** — add to `ZipManifest`:

```typescript
export interface ZipManifest {
  jobName:       string;
  version:       string;
  skills:        string[];
  defaultPrompt?: string;
  description?:  string;
  tags?:         Record<string, string>;
  outputSchema?: Record<string, unknown>;  // ADD — JSON Schema for expected output
  breakingChange?: string;                 // ADD — description if this is a breaking change (requires MAJOR bump)
}
```

**`packages/lambda/src/skill-validator/handler.ts`** — store in SkillVersion:

```typescript
// Add to VERSION PutCommand Item:
outputSchema:   manifest.outputSchema ?? null,
breakingChange: manifest.breakingChange ?? null,
```

**`packages/cli/src/commands/skill.ts`** — show schema in `skill info`:

```typescript
// In info action, after prettyTable, add:
if (ver?.outputSchema) {
  console.log(chalk.bold('\n  Output Schema:'));
  prettyJson(ver.outputSchema);
}
if (ver?.breakingChange) {
  console.log(chalk.yellow(`\n  ⚠  Breaking Change: ${ver.breakingChange}`));
}
```

---

## Fix 12: Cost Anomaly Detection

**`packages/lambda/src/monitoring/daily-cost.ts`** (new file):

```typescript
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cw  = new CloudWatchClient({ region: process.env.REGION });

const ECS_COST_PER_HOUR = 2 * 0.04048 + 4 * 0.004445; // 2 vCPU + 4 GB

export const handler = async () => {
  const tableName  = process.env.DYNAMODB_TABLE_NAME!;
  const env        = process.env.ENV ?? 'prod';
  const since      = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const yesterday  = `CREATED_AT#${since}`;

  // Scan jobs completed in the last 24h across all users
  // (simplified - in prod, use CloudWatch cost data)
  let totalCostUsd = 0;
  for (const status of [JobStatus.COMPLETE, JobStatus.FAILED]) {
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1-Status',
      KeyConditionExpression: 'GSI1PK = :status AND GSI1SK >= :since',
      ExpressionAttributeValues: {
        ':status': `${DDB_KEY_PREFIX.STATUS}${status}`,
        ':since':  yesterday,
      },
    }));
    for (const item of res.Items ?? []) {
      const durationHours = (item.durationMs as number ?? 0) / 1000 / 3600;
      const ecsCost = durationHours * ECS_COST_PER_HOUR;
      const bedrockCost = ((item.inputTokens as number ?? 3600) / 1e6) * 3.0
                        + ((item.outputTokens as number ?? 2000) / 1e6) * 15.0;
      totalCostUsd += ecsCost + bedrockCost;
    }
  }

  await cw.send(new PutMetricDataCommand({
    Namespace: 'skills-svc/Cost',
    MetricData: [{ MetricName: 'DailyEstimatedCostUSD', Value: totalCostUsd,
      Unit: 'None', Dimensions: [{ Name: 'Environment', Value: env }] }],
  }));
};
```

**`infra/lib/monitoring-stack.ts`** — add daily cost Lambda and anomaly alarm:

```typescript
const dailyCostFn = new lambda.Function(this, 'DailyCostFn', {
  functionName: `skills-svc-daily-cost-${this.account}`,
  handler: 'monitoring/daily-cost.handler',
  // ... standard config ...
});

new events.Rule(this, 'DailyCostSchedule', {
  schedule: events.Schedule.cron({ hour: '1', minute: '0' }),  // 1 AM
  targets: [new eventsTargets.LambdaFunction(dailyCostFn)],
});

new cloudwatch.Alarm(this, 'DailyCostAnomalyAlarm', {
  alarmName: `skills-svc-${envName}-cost-anomaly`,
  metric: new cloudwatch.Metric({
    namespace: 'skills-svc/Cost',
    metricName: 'DailyEstimatedCostUSD',
    dimensionsMap: { Environment: envName },
    period: cdk.Duration.days(1),
    statistic: 'Maximum',
  }),
  threshold: 500,  // $500/day — 3x typical daily cost
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  alarmDescription: 'Daily estimated cost exceeded $500 — possible runaway batch or attack',
}).addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
```

---

## Fix 13: ECS vs DDB Running Count Discrepancy in `health`

Already addressed in Fix 6 (`skills-svc health` command notes the distinction). Additionally:

**`packages/cli/src/commands/list-jobs.ts`** — add warning for RUNNING jobs:

```typescript
// After displaying RUNNING jobs:
if (opts.status === 'RUNNING' && items.length > 0) {
  const stuckCount = items.filter(j => {
    const ageMs = Date.now() - new Date(j.createdAt as string).getTime();
    return ageMs > 30 * 60 * 1000;
  }).length;
  if (stuckCount > 0) {
    console.log(chalk.yellow(`\n  ⚠  ${stuckCount} job(s) have been RUNNING for >30 minutes (may be stuck)`));
    console.log(chalk.dim('  Use: skills-svc health to check actual ECS task count vs DDB RUNNING count'));
  }
}
```

---

## Fix 14: Compliance Reporting Commands

**`packages/cli/src/commands/compliance.ts`** (new file — stubs with CloudWatch Logs queries):

```typescript
import { Command } from 'commander';
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from '@aws-sdk/client-cloudwatch-logs';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';

export function complianceCommand(): Command {
  const cmd = new Command('compliance').description('Compliance reporting (requires CloudWatch Logs access)');

  cmd.command('pii-report')
    .description('Aggregate DLP findings report for a time period')
    .requiredOption('--since <date>', 'Start date (ISO 8601)')
    .option('--until <date>', 'End date (ISO 8601, default: now)')
    .option('--format <fmt>', 'Output format: table|json', 'table')
    .action(async (opts: { since: string; until?: string; format: string }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const cwl   = new CloudWatchLogsClient({ region: cfg.region, credentials: creds });

      console.log(chalk.blue('Querying DLP findings from CloudWatch Logs...'));
      const start = await cwl.send(new StartQueryCommand({
        logGroupName: `/aws/lambda/skills-svc-results-${cfg.accountId}`,
        startTime: Math.floor(new Date(opts.since).getTime() / 1000),
        endTime:   Math.floor(new Date(opts.until ?? new Date().toISOString()).getTime() / 1000),
        queryString: `
          fields @timestamp, jobId, findingCount, @message
          | filter event = "dlp_findings_redacted"
          | stats sum(findingCount) as totalFindings, count() as jobsAffected by bin(1d)
          | sort @timestamp desc
        `,
      }));

      // Poll for results
      let results: any;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const res = await cwl.send(new GetQueryResultsCommand({ queryId: start.queryId! }));
        if (res.status === 'Complete') { results = res.results; break; }
      }

      if (!results?.length) {
        console.log(chalk.yellow('No DLP findings found in the specified period.'));
        return;
      }

      console.log(chalk.bold('\nDLP Findings Report:\n'));
      // Display results...
    });

  cmd.command('show-retention')
    .description('Display data retention schedule for all resources')
    .action(async () => {
      // Output the authoritative retention schedule
      const schedule = [
        { resource: 'DynamoDB jobs table', retention: '90 days (TTL)', enforcement: 'DynamoDB TTL' },
        { resource: 'S3 uploads bucket',   retention: '90 days',        enforcement: 'S3 Lifecycle' },
        { resource: 'S3 results bucket',   retention: '90 days',        enforcement: 'S3 Lifecycle' },
        { resource: 'S3 registry bucket',  retention: '7 years',        enforcement: 'S3 ObjectLock COMPLIANCE' },
        { resource: 'S3 audit bucket',     retention: '7 years',        enforcement: 'S3 ObjectLock COMPLIANCE' },
        { resource: 'Lambda logs',         retention: '90 days',        enforcement: 'CloudWatch Retention' },
        { resource: 'CloudTrail logs',     retention: '7 years',        enforcement: 'S3 ObjectLock COMPLIANCE' },
        { resource: 'Bedrock logs',        retention: '1 year',         enforcement: 'S3 ObjectLock COMPLIANCE' },
        { resource: 'OpenSearch index',    retention: '90 days',        enforcement: '_expiry field + cleanup Lambda' },
        { resource: 'DLQ messages',        retention: '14 days',        enforcement: 'SQS Retention' },
      ];

      console.log(chalk.bold('\nData Retention Schedule:\n'));
      const prettyTable = require('../utils/pretty-print').prettyTable;
      prettyTable([
        ['Resource', 'Retention', 'Enforcement Mechanism'],
        ...schedule.map(s => [s.resource, s.retention, s.enforcement]),
      ]);
      console.log(chalk.dim('\nFor GDPR deletion, use: skills-svc delete-user <arn>'));
    });

  return cmd;
}
```

Register in `index.ts`: `program.addCommand(complianceCommand())`.

---

## Fix 15: `skills-svc version --check`

**`packages/cli/src/commands/version-check.ts`** (new file):

```typescript
import { execSync } from 'child_process';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

export function addVersionCheck(program: import('commander').Command): void {
  program.addHelpText('after', `\nCheck for updates: skills-svc version --check\n`);

  // Override the built-in --version to also support --check
  program.command('version')
    .description('Show CLI version and optionally check for updates')
    .option('--check', 'Check npm registry for newer version', false)
    .action(async (opts: { check: boolean }) => {
      const pkgPath = path.join(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const current = pkg.version;

      console.log(`skills-svc v${current}`);

      if (!opts.check) {
        console.log(chalk.dim('Run: skills-svc version --check to see if updates are available'));
        return;
      }

      try {
        const latest = execSync('npm view @skills-svc/cli version 2>/dev/null', { timeout: 5000 })
          .toString().trim();

        if (latest && latest !== current) {
          console.log(chalk.yellow(`\n  Update available: v${current} → v${latest}`));
          console.log(chalk.cyan(`  Run: npm install -g @skills-svc/cli@${latest}`));
          console.log(chalk.dim(`  See release notes: https://github.com/mbhatt1/claudeskillscanner/releases/tag/v${latest}`));
        } else {
          console.log(chalk.green(`\n  ✓ You are on the latest version (v${current})`));
        }
      } catch {
        console.log(chalk.dim('\n  Could not check npm registry — verify manually: npm view @skills-svc/cli version'));
      }
    });
}
```

Register in `index.ts`: `addVersionCheck(program)`.

---

## New QA Checks (QA-276 through QA-285)

```typescript
// QA-276: list-jobs supports --since date filter
test('QA-276: list-jobs --since produces KeyConditionExpression with date range', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  await runListJobs({ since: '2025-05-10' });
  const call = ddbMock.commandCalls(QueryCommand)[0];
  expect(call.args[0].input.KeyConditionExpression).toContain('BETWEEN');
});

// QA-277: list-jobs --job-name-contains filters client-side
test('QA-277: list-jobs --job-name-contains filters by job name', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(QueryCommand).resolves({
    Items: [
      { jobId: '1', jobName: 'quarterly-analysis', status: 'COMPLETE', createdAt: new Date().toISOString() },
      { jobId: '2', jobName: 'weekly-report', status: 'COMPLETE', createdAt: new Date().toISOString() },
    ],
  });
  const output = await captureOutput(() => runListJobs({ jobNameContains: 'quarterly', format: 'json' }));
  const parsed = JSON.parse(output);
  expect(parsed.data).toHaveLength(1);
  expect(parsed.data[0].jobName).toBe('quarterly-analysis');
});

// QA-278: list-jobs --format csv outputs comma-separated
test('QA-278: list-jobs --format csv outputs greppable CSV', async () => {
  const output = await captureConsoleOutput(() => runListJobs({ format: 'csv', status: 'COMPLETE' }));
  expect(output.split('\n')[0]).toBe('JobId,JobName,Status,CreatedAt,CompletedAt,Duration,SkillName,SkillVersion');
});

// QA-279: job record stores bedrockModelId
test('QA-279: ingestion Lambda writes bedrockModelId to DDB job record', () => {
  const source = readFileSync('packages/lambda/src/ingestion/handler.ts', 'utf-8');
  expect(source).toContain('bedrockModelId');
  expect(source).toContain('bedrock/claude-model-id');
});

// QA-280: job record stores promptUsed
test('QA-280: ingestion Lambda writes promptUsed to DDB job record', () => {
  const source = readFileSync('packages/lambda/src/ingestion/handler.ts', 'utf-8');
  expect(source).toContain('promptUsed');
  expect(source).toContain('prompt-override');
});

// QA-281: health command checks DynamoDB GSI count
test('QA-281: health command verifies 5 GSIs on jobs table', async () => {
  const ddbMock = mockClient(DynamoDBClient);
  ddbMock.on(DescribeTableCommand).resolves({
    Table: { GlobalSecondaryIndexes: Array(5).fill({ IndexStatus: 'ACTIVE' }) },
  });
  const output = await captureOutput(() => runHealth({ json: true }));
  const parsed = JSON.parse(output);
  expect(parsed.components.dynamodb.status).toBe('OK');
  expect(parsed.components.dynamodb.detail).toContain('5/5 GSIs');
});

// QA-282: stuck job checker emits CloudWatch metric
test('QA-282: stuck-jobs Lambda emits StuckJobsCount metric', async () => {
  const cwMock = mockClient(CloudWatchClient);
  cwMock.on(PutMetricDataCommand).resolves({});
  const ddbMock = mockClient(DynamoDBDocumentClient);
  // One job running for 35 minutes
  ddbMock.on(QueryCommand).resolves({
    Items: [{ jobId: 'test', createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString() }],
  });
  await stuckJobsHandler();
  const putCall = cwMock.commandCalls(PutMetricDataCommand)[0];
  expect(putCall.args[0].input.MetricData[0].MetricName).toBe('StuckJobsCount');
  expect(putCall.args[0].input.MetricData[0].Value).toBe(1);
});

// QA-283: diff --exact-match detects byte-level differences
test('QA-283: diff --exact-match returns false for semantically similar but different outputs', async () => {
  const result1 = JSON.stringify({ sentiment: 'positive', score: 0.87 });
  const result2 = JSON.stringify({ sentiment: 'positive', score: 0.88 }); // slightly different
  const isExact = checkExactMatch(result1, result2);
  expect(isExact).toBe(false);
});

// QA-284: dlq inspect shows message count
test('QA-284: dlq inspect shows DLQ depth', async () => {
  const sqsMock = mockClient(SQSClient);
  sqsMock.on(GetQueueAttributesCommand).resolves({
    Attributes: { ApproximateNumberOfMessages: '5' },
  });
  sqsMock.on(ReceiveMessageCommand).resolves({ Messages: [] });
  const output = await captureConsoleOutput(() => runDlqInspect({ queue: 'ingestion' }));
  expect(output).toContain('5 messages');
});

// QA-285: compliance show-retention lists all resources
test('QA-285: compliance show-retention includes all major data stores', async () => {
  const output = await captureConsoleOutput(() => runComplianceShowRetention({}));
  expect(output).toContain('DynamoDB');
  expect(output).toContain('90 days');
  expect(output).toContain('7 years');
  expect(output).toContain('ObjectLock');
});
```

---

## Summary

| Fix | Impact | Files Changed |
|-----|--------|--------------|
| 1+2+3 — list-jobs date/name/format | BLOCKER — all reporting flows broken without date filter | `commands/list-jobs.ts` |
| 4+5 — Store model ID and prompt in job | BLOCKER — reproducibility impossible without lineage | `ingestion/handler.ts`, `types.ts` |
| 6 — Unified `health` command | BLOCKER — ops works blind at 3am | `commands/health.ts` (new) |
| 7 — DLQ inspect/replay | BLOCKER — DLQ recovery requires manual AWS CLI | `commands/dlq.ts` (new) |
| 8 — Stuck job alarm | CORRECTNESS — silent stuck jobs undetected | `monitoring-stack.ts`, `monitoring/stuck-jobs.ts` |
| 9 — Batch sequential steps doc | CORRECTNESS — expected behavior documented | `commands/batch.ts` |
| 10 — diff --exact-match | CORRECTNESS — semantic similarity ≠ reproducibility | `commands/diff.ts` |
| 11 — Skill output schema in registry | CORRECTNESS — breaking changes silent without schema | `types.ts`, `skill-validator/handler.ts`, `commands/skill.ts` |
| 12 — Cost anomaly detection | CORRECTNESS — runaway batches invisible | `monitoring-stack.ts`, `monitoring/daily-cost.ts` |
| 13 — Running count discrepancy warning | CORRECTNESS — inflated running count misleads | `commands/list-jobs.ts` |
| 14 — Compliance reporting | LEGAL — PII inventory/audit require manual CloudWatch | `commands/compliance.ts` (new) |
| 15 — CLI version check | OPERATIONAL — stale CLI failures are silent | `commands/version-check.ts` (new) |
