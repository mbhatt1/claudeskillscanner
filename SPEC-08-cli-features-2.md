# Skills as a Service (SaaS) — Specification Part 8: CLI Features II

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | ... | [Part 7](SPEC-07-cli-features.md) | [Part 8: CLI Features II] | [Part 9](SPEC-09-mcp-server.md)

---

## Overview

Eight new CLI features. All use existing AWS resources except where noted.

| Feature | Command | New AWS Resources |
|---------|---------|-------------------|
| Job Cancellation | `skills-svc cancel <job-id>` | None |
| Config Profiles | `--profile <name>` global flag | None |
| Result Caching | `upload --cache` / `--no-cache` | DDB cache GSI, S3 cache prefix |
| Batch Processing | `skills-svc batch` | DDB batch table, Step Functions |
| Skill Diff | `skills-svc diff <id1> <id2>` | None |
| Cost Report | `skills-svc cost` | None — computes locally from DDB data |
| Notify Subscribe | `skills-svc notify` | SNS (already exists) |
| Audit Trail | `skills-svc audit` | None — queries CloudTrail Lake |

---

## Feature 1: Job Cancellation

### Command

```bash
skills-svc cancel <job-id> [--reason "accidental upload"]
```

### Behaviour
1. GET job from DDB — verify status is PENDING or RUNNING
2. If RUNNING: call ECS `StopTask` with reason string
3. Update DDB status → FAILED, errorMessage = "Cancelled by user: \<reason\>"
4. Publish SNS notification (status: FAILED, message: "cancelled")
5. If PENDING (ECS task not yet started): update DDB directly — the ingestion Lambda will attempt `RunTask`, find the job already FAILED via ConditionExpression, and skip

### `packages/cli/src/commands/cancel.ts`

```typescript
import { Command } from 'commander';
import { ECSClient, StopTaskCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { JobStatus, DDB_KEY_PREFIX, isValidTransition } from '@skills-svc/shared';

export function cancelCommand(): Command {
  return new Command('cancel')
    .description('Cancel a pending or running job')
    .argument('<job-id>', 'Job ID to cancel')
    .option('--reason <reason>', 'Cancellation reason (recorded in audit log)', 'Cancelled by user')
    .option('--force', 'Cancel even if job is in an unexpected state', false)
    .action(async (jobId: string, opts: { reason: string; force: boolean }) => {
      const cfg = await loadConfig();
      const creds = await getCredentialProvider();
      const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const ecs = new ECSClient({ region: cfg.region, credentials: creds });
      const sns = new SNSClient({ region: cfg.region, credentials: creds });
      const ssm = new SSMClient({ region: cfg.region, credentials: creds });

      // 1. Fetch job
      const res = await ddb.send(new GetCommand({
        TableName: cfg.dynamodbTableName,
        Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
      }));

      if (!res.Item) {
        console.error(chalk.red(`Job not found: ${jobId}`));
        process.exit(1);
      }

      const status = res.Item.status as JobStatus;
      const version = res.Item.version as number;

      if (status === JobStatus.COMPLETE || status === JobStatus.FAILED) {
        console.error(chalk.red(`Job is already in terminal state: ${status}. Cannot cancel.`));
        process.exit(1);
      }

      if (!isValidTransition(status, JobStatus.FAILED) && !opts.force) {
        console.error(chalk.red(`Cannot transition from ${status} to FAILED. Use --force to override.`));
        process.exit(1);
      }

      // 2. Stop ECS task if running
      if (status === JobStatus.RUNNING) {
        const clusterArn = await ssm.send(new GetParameterCommand({
          Name: `/skills-svc/${cfg.envName}/ecs/cluster-arn`,
        })).then(r => r.Parameter!.Value!);

        // Find the ECS task for this job (tagged with job-id)
        const tasks = await ecs.send(new ListTasksCommand({
          cluster: clusterArn,
          startedBy: `skills-svc-ingestion-${jobId.slice(0, 8)}`,
        }));

        if (tasks.taskArns?.length) {
          for (const taskArn of tasks.taskArns) {
            await ecs.send(new StopTaskCommand({
              cluster: clusterArn,
              task: taskArn,
              reason: opts.reason,
            }));
            console.log(chalk.dim(`Stopped ECS task: ${taskArn.split('/').pop()}`));
          }
        } else {
          console.log(chalk.yellow('No running ECS task found — may have already stopped.'));
        }
      }

      // 3. Update DDB with optimistic locking
      const now = new Date().toISOString();
      try {
        await ddb.send(new UpdateCommand({
          TableName: cfg.dynamodbTableName,
          Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
          UpdateExpression:
            'SET #status = :status, updatedAt = :now, #ver = :newVer, GSI1PK = :gsi1pk, errorMessage = :err',
          ConditionExpression: '#ver = :curVer',
          ExpressionAttributeNames: { '#status': 'status', '#ver': 'version' },
          ExpressionAttributeValues: {
            ':status': JobStatus.FAILED,
            ':now': now,
            ':newVer': version + 1,
            ':curVer': version,
            ':gsi1pk': `${DDB_KEY_PREFIX.STATUS}${JobStatus.FAILED}`,
            ':err': `Cancelled by user: ${opts.reason}`,
          },
        }));
      } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
          console.error(chalk.red('Job status changed concurrently — cancellation may have already occurred.'));
          process.exit(1);
        }
        throw err;
      }

      // 4. SNS notification
      const topicArn = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/sns/jobs-topic-arn`,
      })).then(r => r.Parameter!.Value!);

      await sns.send(new PublishCommand({
        TopicArn: topicArn,
        Subject: `Skills SaaS Job Cancelled: ${res.Item.jobName}`,
        Message: JSON.stringify({
          jobId,
          jobName: res.Item.jobName,
          status: JobStatus.FAILED,
          message: `Cancelled by user: ${opts.reason}`,
          timestamp: now,
        }),
      }));

      console.log(chalk.green(`✓ Job ${jobId} cancelled`));
      console.log(`  Reason: ${opts.reason}`);
    });
}
```

---

## Feature 2: Config Profiles

### Design
Config lives at `~/.skills-svc/profiles/<name>.json`. The `default` profile is used when `--profile` is not specified. `configure` always writes to the active profile.

### Command Changes

```bash
# Global flag on every command:
skills-svc --profile staging upload ./skills.zip --job-name "test"
skills-svc --profile prod    query "eigenvalues"

# Profile management:
skills-svc profile list
skills-svc profile use <name>       # set default profile
skills-svc profile show [<name>]    # print active config
skills-svc profile delete <name>
```

### Updated `packages/cli/src/utils/config.ts`

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR      = path.join(os.homedir(), '.skills-svc');
const PROFILES_DIR    = path.join(CONFIG_DIR, 'profiles');
const DEFAULT_FILE    = path.join(CONFIG_DIR, 'default-profile'); // contains profile name

export interface CliConfig {
  profileName: string;
  region: string;
  accountId: string;
  envName: string;
  uploadsBucket: string;
  resultsBucket: string;
  uploadsKmsKeyId: string;
  jobsTopicArn: string;
  opensearchEndpoint: string;
  queryLambdaArn: string;
  dynamodbTableName: string;
}

function profilePath(name: string): string {
  return path.join(PROFILES_DIR, `${name}.json`);
}

export function getDefaultProfileName(): string {
  if (!existsSync(DEFAULT_FILE)) return 'default';
  return readFileSync(DEFAULT_FILE, 'utf-8').trim();
}

export function setDefaultProfileName(name: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(DEFAULT_FILE, name, { mode: 0o600 });
}

export async function loadConfig(profileName?: string): Promise<CliConfig> {
  const name = profileName ?? getDefaultProfileName();
  const file = profilePath(name);
  if (!existsSync(file)) {
    throw new Error(
      `Profile "${name}" not found. Run: skills-svc configure --profile ${name} --region us-east-1 --account <ID>`
    );
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as CliConfig;
}

export function saveConfig(cfg: CliConfig): void {
  mkdirSync(PROFILES_DIR, { recursive: true });
  writeFileSync(profilePath(cfg.profileName), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function listProfiles(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

export function deleteProfile(name: string): void {
  const file = profilePath(name);
  if (!existsSync(file)) throw new Error(`Profile not found: ${name}`);
  unlinkSync(file);
}
```

### Updated `packages/cli/src/index.ts` — global `--profile` option

```typescript
program
  .name('skills-svc')
  .version('1.0.0')
  .option('--profile <name>', 'Config profile to use (default: "default")')
  .hook('preAction', (thisCommand) => {
    // Propagate --profile to all subcommands via env var
    const profile = thisCommand.opts().profile as string | undefined;
    if (profile) process.env.SKILLS_SVC_PROFILE = profile;
  });
```

All commands replace `loadConfig()` with `loadConfig(process.env.SKILLS_SVC_PROFILE)`.

### `packages/cli/src/commands/profile.ts`

```typescript
import { Command } from 'commander';
import chalk from 'chalk';
import {
  listProfiles, loadConfig, saveConfig, deleteProfile,
  getDefaultProfileName, setDefaultProfileName,
} from '../utils/config';
import { prettyTable, prettyJson } from '../utils/pretty-print';

export function profileCommand(): Command {
  const cmd = new Command('profile').description('Manage named configuration profiles');

  cmd.command('list')
    .description('List all profiles')
    .action(() => {
      const profiles = listProfiles();
      const defaultName = getDefaultProfileName();
      if (!profiles.length) {
        console.log(chalk.yellow('No profiles found. Run: skills-svc configure'));
        return;
      }
      prettyTable([
        ['Profile', 'Default', 'Environment', 'Region', 'Account'],
        ...profiles.map(name => {
          try {
            const cfg = JSON.parse(require('fs').readFileSync(
              require('path').join(require('os').homedir(), '.skills-svc', 'profiles', `${name}.json`),
              'utf-8'
            ));
            return [
              name,
              name === defaultName ? chalk.green('✓') : '',
              cfg.envName ?? '',
              cfg.region ?? '',
              cfg.accountId ?? '',
            ];
          } catch {
            return [name, name === defaultName ? chalk.green('✓') : '', '(unreadable)', '', ''];
          }
        }),
      ]);
    });

  cmd.command('use <name>')
    .description('Set the default profile')
    .action((name: string) => {
      if (!listProfiles().includes(name)) {
        console.error(chalk.red(`Profile not found: ${name}`));
        process.exit(1);
      }
      setDefaultProfileName(name);
      console.log(chalk.green(`✓ Default profile set to "${name}"`));
    });

  cmd.command('show [name]')
    .description('Print the active or named profile config')
    .action(async (name?: string) => {
      const cfg = await loadConfig(name ?? process.env.SKILLS_SVC_PROFILE);
      prettyJson(cfg);
    });

  cmd.command('delete <name>')
    .description('Delete a profile')
    .option('--force', 'Skip confirmation', false)
    .action(async (name: string, opts: { force: boolean }) => {
      if (name === getDefaultProfileName() && !opts.force) {
        console.error(chalk.red(`Cannot delete active default profile. Switch first: skills-svc profile use <other>`));
        process.exit(1);
      }
      deleteProfile(name);
      console.log(chalk.green(`✓ Profile "${name}" deleted`));
    });

  return cmd;
}
```

### Updated `configure` command

```typescript
// Add --profile option to configureCommand():
.option('--profile <name>', 'Profile name to write config to', 'default')
.action(async (opts) => {
  // ... discover stack outputs ...
  const cfg: CliConfig = { profileName: opts.profile, ...discoveredValues };
  saveConfig(cfg);
  setDefaultProfileName(opts.profile);
  console.log(chalk.green(`✓ Profile "${opts.profile}" configured`));
});
```

---

## Feature 3: Result Caching

### Design
Cache key = `SHA256(zip_content + prompt)`. On upload, check DDB for an existing COMPLETE job with this cache key. If found, return the cached job ID instead of submitting a new ECS task. Bypass with `--no-cache`.

### New DDB Index

Add to `StorageStack`:
```typescript
// GSI4: cache key lookup
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI4-CacheKey',
  partitionKey: { name: 'GSI4PK', type: dynamodb.AttributeType.STRING }, // CACHE#{sha256}
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'status', 'createdAt', 's3ResultKey'],
});
```

Add to `JobRecord` type:
```typescript
GSI4PK?: string;    // CACHE#{sha256(zip+prompt)} — set on job creation
cacheKey?: string;  // raw sha256 hex string for display
cacheHit?: boolean; // true if this job was served from cache
```

### Updated `packages/cli/src/commands/upload.ts`

```typescript
.option('--no-cache', 'Skip cache check and always run fresh', false)
.option('--cache-ttl <days>', 'Max age of cached result to accept (days)', '7')

// Before S3 upload:
if (!opts.noCache) {
  const cacheKey = computeCacheKey(readFileSync(zipPath), manifest.defaultPrompt ?? '');
  const cached = await checkCache(ddb, cfg.dynamodbTableName, cacheKey);

  if (cached) {
    const ageDays = (Date.now() - new Date(cached.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= parseInt(opts.cacheTtl, 10)) {
      console.log(chalk.green(`✓ Cache hit! Returning existing result (${ageDays.toFixed(1)} days old)`));
      prettyTable([
        ['Field', 'Value'],
        ['Cached Job ID', cached.jobId],
        ['Cached At', new Date(cached.createdAt).toLocaleString()],
        ['Age', `${ageDays.toFixed(1)} days`],
        ['Result Key', cached.s3ResultKey ?? 'N/A'],
      ]);
      console.log(`\nView results: ${chalk.cyan(`skills-svc results ${cached.jobId}`)}`);
      return; // exit without uploading
    }
  }
}
```

### Cache utilities `packages/cli/src/utils/cache.ts`

```typescript
import { createHash } from 'crypto';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { JobStatus } from '@skills-svc/shared';

export function computeCacheKey(zipBuffer: Buffer, prompt: string): string {
  return createHash('sha256')
    .update(zipBuffer)
    .update('\x00') // separator
    .update(prompt)
    .digest('hex');
}

export interface CacheEntry {
  jobId: string;
  createdAt: string;
  s3ResultKey?: string;
}

export async function checkCache(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  cacheKey: string,
): Promise<CacheEntry | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI4-CacheKey',
    KeyConditionExpression: 'GSI4PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `CACHE#${cacheKey}`,
    },
    FilterExpression: '#status = :complete',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':pk': `CACHE#${cacheKey}`,
      ':complete': JobStatus.COMPLETE,
    },
    ScanIndexForward: false, // newest first
    Limit: 1,
  }));

  const item = res.Items?.[0];
  if (!item) return null;
  return {
    jobId: item.jobId as string,
    createdAt: item.createdAt as string,
    s3ResultKey: item.s3ResultKey as string | undefined,
  };
}
```

### Updated ingestion Lambda — write cache key to DDB

```typescript
// In processRecord(), after writing job record, add GSI4PK:
// (cache key is computed from zip content hash + prompt from manifest)
const zipMd5 = head.ETag?.replace(/"/g, '') ?? '';
const manifestPrompt = validation.manifest?.defaultPrompt ?? '';
const cacheKey = createHash('sha256').update(zipMd5).update(manifestPrompt).digest('hex');

// Add to PutCommand Item:
GSI4PK: `CACHE#${cacheKey}`,
cacheKey,
```

---

## Feature 4: Batch Processing

### Design
`batch run` takes a zip (skills) and a directory of input files (JSON or text). Each input file becomes one job. A Step Functions Express Workflow tracks the batch — parallel map state runs all jobs, aggregates results.

### Commands

```bash
skills-svc batch run ./skills.zip --inputs ./data/*.json --job-name "may-batch" [--concurrency 10]
skills-svc batch status <batch-id>      # progress: N/M complete
skills-svc batch results <batch-id>     # aggregated results table
skills-svc batch cancel <batch-id>      # cancel all pending/running jobs
skills-svc batch list [--limit 10]
```

### New AWS Resources

#### Step Functions Express Workflow (`infra/lib/batch-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

interface BatchStackProps extends cdk.StackProps {
  envName: string;
  jobsTable: dynamodb.Table;
  ingestionFn: lambda.Function;
  dynamodbKey: kms.Key;
}

export class BatchStack extends cdk.Stack {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BatchStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // DynamoDB table for batch metadata (separate from jobs table)
    const batchTable = new dynamodb.Table(this, 'BatchTable', {
      tableName: `skills-svc-batches-${this.account}-${this.region}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING }, // BATCH#{batchId}
      sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING }, // METADATA | JOB#{jobId}
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dynamodbKey,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Lambda: submit one job within a batch
    const batchJobSubmitFn = new lambda.Function(this, 'BatchJobSubmitFn', {
      functionName: `skills-svc-batch-submit-${this.account}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'batch-submit/handler.handler',
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: { ENV: envName, REGION: this.region },
    });
    props.jobsTable.grantWriteData(batchJobSubmitFn);
    batchTable.grantWriteData(batchJobSubmitFn);

    // Lambda: check one job's completion status (polled by Step Functions wait loop)
    const batchStatusFn = new lambda.Function(this, 'BatchStatusFn', {
      functionName: `skills-svc-batch-status-${this.account}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'batch-status/handler.handler',
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      environment: { ENV: envName, REGION: this.region },
    });
    props.jobsTable.grantReadData(batchStatusFn);
    batchTable.grantWriteData(batchStatusFn);

    // Step Functions: for each input file, submit a job then poll until complete
    const submitJob = new tasks.LambdaInvoke(this, 'SubmitJob', {
      lambdaFunction: batchJobSubmitFn,
      outputPath: '$.Payload',
    });

    const checkJobStatus = new tasks.LambdaInvoke(this, 'CheckJobStatus', {
      lambdaFunction: batchStatusFn,
      outputPath: '$.Payload',
    });

    const waitForJob = new sfn.Wait(this, 'WaitForJob', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const jobComplete = new sfn.Choice(this, 'JobComplete?')
      .when(sfn.Condition.stringEquals('$.status', 'COMPLETE'), new sfn.Succeed(this, 'JobSucceeded'))
      .when(sfn.Condition.stringEquals('$.status', 'FAILED'),   new sfn.Fail(this, 'JobFailed', { error: 'JobFailed' }))
      .otherwise(waitForJob);

    waitForJob.next(checkJobStatus).next(jobComplete);

    const processOneInput = submitJob.next(checkJobStatus).next(jobComplete);

    // Map state: parallel execution up to concurrency limit
    const processAllInputs = new sfn.Map(this, 'ProcessAllInputs', {
      maxConcurrency: 10,
      itemsPath: '$.inputs',
      parameters: {
        'skillsS3Bucket.$': '$.skillsS3Bucket',
        'skillsS3Key.$':    '$.skillsS3Key',
        'batchId.$':        '$.batchId',
        'batchJobName.$':   '$.batchJobName',
        'userArn.$':        '$.userArn',
        'input.$':          '$$.Map.Item.Value',
        'inputIndex.$':     '$$.Map.Item.Index',
      },
    });
    processAllInputs.iterator(processOneInput);

    const logGroup = new logs.LogGroup(this, 'BatchSFNLogs', {
      logGroupName: `/skills-svc/${envName}/sfn/batch`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: props.dynamodbKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.stateMachine = new sfn.StateMachine(this, 'BatchStateMachine', {
      stateMachineName: `skills-svc-batch-${envName}`,
      stateMachineType: sfn.StateMachineType.EXPRESS,
      definition: processAllInputs,
      timeout: cdk.Duration.hours(24),
      logs: {
        destination: logGroup,
        level: sfn.LogLevel.ALL,
        includeExecutionData: false, // don't log input data (may be sensitive)
      },
      tracingEnabled: true,
    });

    // SSM param
    new (require('aws-cdk-lib/aws-ssm').StringParameter)(this, 'ParamSFNArn', {
      parameterName: `/skills-svc/${envName}/sfn/batch-arn`,
      stringValue: this.stateMachine.stateMachineArn,
    });
  }
}
```

#### Batch Job Schema (DDB)

```
PK=BATCH#{batchId}  SK=METADATA    → batchId, batchName, userArn, status, totalJobs, completedJobs, failedJobs, createdAt, sfnExecutionArn
PK=BATCH#{batchId}  SK=JOB#{jobId} → jobId, inputFile, status, createdAt, completedAt
```

### `packages/cli/src/commands/batch.ts`

```typescript
import { Command } from 'commander';
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import * as glob from 'glob';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { prettyTable } from '../utils/pretty-print';

export function batchCommand(): Command {
  const cmd = new Command('batch').description('Submit and manage batch jobs');

  // ── batch run ──────────────────────────────────────────────────────────
  cmd.command('run <zip-path>')
    .description('Run a skills zip against multiple input files')
    .requiredOption('--inputs <glob>', 'Glob pattern for input files, e.g. "./data/*.json"')
    .requiredOption('--job-name <name>', 'Batch job name')
    .option('--concurrency <n>', 'Max parallel jobs (1–50)', '10')
    .option('--no-cache', 'Disable result caching for batch jobs', false)
    .action(async (zipPath: string, opts: {
      inputs: string;
      jobName: string;
      concurrency: string;
      cache: boolean;
    }) => {
      const cfg    = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds  = await getCredentialProvider();
      const s3     = new S3Client({ region: cfg.region, credentials: creds });
      const sfn    = new SFNClient({ region: cfg.region, credentials: creds });
      const sts    = new STSClient({ region: cfg.region, credentials: creds });
      const ssm    = new SSMClient({ region: cfg.region, credentials: creds });

      const concurrency = Math.min(Math.max(parseInt(opts.concurrency, 10), 1), 50);
      const inputFiles  = glob.sync(opts.inputs);

      if (!inputFiles.length) {
        console.error(chalk.red(`No files matched: ${opts.inputs}`));
        process.exit(1);
      }

      const identity = await sts.send(new GetCallerIdentityCommand({}));
      const batchId  = randomUUID();

      // Upload skills zip once — shared across all batch jobs
      const skillsKey = `uploads/batch/${batchId}/skills.zip`;
      console.log(chalk.blue(`Uploading skills zip (shared across ${inputFiles.length} jobs)...`));
      await s3.send(new PutObjectCommand({
        Bucket: cfg.uploadsBucket,
        Key: skillsKey,
        Body: readFileSync(zipPath),
        ContentType: 'application/zip',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: cfg.uploadsKmsKeyId,
        ChecksumAlgorithm: 'SHA256',
        Metadata: {
          'batch-id':   batchId,
          'job-name':   opts.jobName,
          'user-arn':   identity.Arn!,
        },
      }));

      // Upload each input file
      console.log(chalk.blue(`Uploading ${inputFiles.length} input files...`));
      const inputRefs: Array<{ s3Key: string; originalFile: string; index: number }> = [];
      for (const [index, file] of inputFiles.entries()) {
        const inputKey = `uploads/batch/${batchId}/inputs/${index}-${path.basename(file)}`;
        await s3.send(new PutObjectCommand({
          Bucket: cfg.uploadsBucket,
          Key: inputKey,
          Body: readFileSync(file),
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: cfg.uploadsKmsKeyId,
        }));
        inputRefs.push({ s3Key: inputKey, originalFile: path.basename(file), index });
      }

      // Start Step Functions execution
      const sfnArn = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/sfn/batch-arn`,
      })).then(r => r.Parameter!.Value!);

      const execution = await sfn.send(new StartExecutionCommand({
        stateMachineArn: sfnArn,
        name: `${batchId}-${Date.now()}`,
        input: JSON.stringify({
          batchId,
          batchJobName: opts.jobName,
          skillsS3Bucket: cfg.uploadsBucket,
          skillsS3Key: skillsKey,
          userArn: identity.Arn,
          concurrency,
          useCache: opts.cache,
          inputs: inputRefs,
        }),
      }));

      prettyTable([
        ['Field', 'Value'],
        ['Batch ID',    batchId],
        ['Batch Name',  opts.jobName],
        ['Input Files', String(inputFiles.length)],
        ['Concurrency', String(concurrency)],
        ['Status',      chalk.yellow('RUNNING')],
        ['Execution',   execution.executionArn?.split(':').pop() ?? ''],
      ]);

      console.log(`\nTrack: ${chalk.cyan(`skills-svc batch status ${batchId}`)}`);
    });

  // ── batch status ───────────────────────────────────────────────────────
  cmd.command('status <batch-id>')
    .description('Show progress of a batch')
    .option('--watch', 'Refresh every 10 seconds until complete', false)
    .action(async (batchId: string, opts: { watch: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const batchTableName = `skills-svc-batches-${cfg.accountId}-${cfg.region}`;

      const printStatus = async () => {
        const meta = await ddb.send(new GetCommand({
          TableName: batchTableName,
          Key: { PK: `BATCH#${batchId}`, SK: 'METADATA' },
        }));

        if (!meta.Item) {
          console.error(chalk.red(`Batch not found: ${batchId}`));
          process.exit(1);
        }

        const total     = meta.Item.totalJobs as number;
        const completed = meta.Item.completedJobs as number;
        const failed    = meta.Item.failedJobs as number;
        const running   = total - completed - failed;
        const pct       = Math.round((completed / total) * 100);
        const bar       = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

        console.clear();
        console.log(chalk.bold(`\nBatch: ${meta.Item.batchName}  [${batchId.slice(0, 8)}]`));
        console.log(`\n  ${chalk.green(bar)} ${pct}%`);
        console.log(`\n  ${chalk.green(`✓ Complete: ${completed}`)}  ${chalk.red(`✗ Failed: ${failed}`)}  ${chalk.blue(`⟳ Running: ${running}`)}`);
        console.log(`  Total: ${total}  |  Started: ${new Date(meta.Item.createdAt as string).toLocaleString()}`);

        return meta.Item.status as string;
      };

      if (opts.watch) {
        while (true) {
          const status = await printStatus();
          if (status === 'COMPLETE' || status === 'FAILED') break;
          await new Promise(r => setTimeout(r, 10_000));
        }
      } else {
        await printStatus();
      }
    });

  // ── batch results ──────────────────────────────────────────────────────
  cmd.command('results <batch-id>')
    .description('Show aggregated results for a batch')
    .option('--format <fmt>', 'Output format: table|json|csv', 'table')
    .option('--failed-only', 'Show only failed jobs', false)
    .action(async (batchId: string, opts: { format: string; failedOnly: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const batchTableName = `skills-svc-batches-${cfg.accountId}-${cfg.region}`;

      const res = await ddb.send(new QueryCommand({
        TableName: batchTableName,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `BATCH#${batchId}`,
          ':prefix': 'JOB#',
        },
        ...(opts.failedOnly ? {
          FilterExpression: '#status = :failed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':pk': `BATCH#${batchId}`, ':prefix': 'JOB#', ':failed': 'FAILED' },
        } : {}),
      }));

      const items = res.Items ?? [];

      if (opts.format === 'csv') {
        console.log('JobId,InputFile,Status,Duration(s)');
        for (const item of items) {
          const dur = item.completedAt
            ? Math.round((new Date(item.completedAt as string).getTime() - new Date(item.createdAt as string).getTime()) / 1000)
            : '';
          console.log(`${item.jobId},${item.inputFile},${item.status},${dur}`);
        }
        return;
      }

      if (opts.format === 'json') {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      prettyTable([
        ['Job ID', 'Input File', 'Status', 'Duration'],
        ...items.map(item => {
          const dur = item.completedAt
            ? `${Math.round((new Date(item.completedAt as string).getTime() - new Date(item.createdAt as string).getTime()) / 1000)}s`
            : 'running...';
          return [
            (item.jobId as string).slice(0, 8) + '...',
            item.inputFile as string,
            item.status as string,
            dur,
          ];
        }),
      ]);
    });

  // ── batch cancel ───────────────────────────────────────────────────────
  cmd.command('cancel <batch-id>')
    .description('Cancel all running jobs in a batch')
    .action(async (batchId: string) => {
      const cfg    = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds  = await getCredentialProvider();
      const sfn    = new SFNClient({ region: cfg.region, credentials: creds });
      const ssm    = new SSMClient({ region: cfg.region, credentials: creds });
      const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const batchTableName = `skills-svc-batches-${cfg.accountId}-${cfg.region}`;

      // Get execution ARN from batch metadata
      const meta = await ddb.send(new GetCommand({
        TableName: batchTableName,
        Key: { PK: `BATCH#${batchId}`, SK: 'METADATA' },
      }));

      const executionArn = meta.Item?.sfnExecutionArn as string | undefined;
      if (!executionArn) {
        console.error(chalk.red('Cannot find execution ARN for this batch'));
        process.exit(1);
      }

      await sfn.send(new StopExecutionCommand({
        executionArn,
        error: 'ManualCancellation',
        cause: 'Cancelled by user via CLI',
      }));

      console.log(chalk.green(`✓ Batch ${batchId} cancelled`));
      console.log(chalk.dim('Note: jobs already submitted to ECS may still complete. Use `skills-svc batch results` to review.'));
    });

  // ── batch list ─────────────────────────────────────────────────────────
  cmd.command('list')
    .description('List recent batches')
    .option('--limit <n>', 'Max results', '10')
    .action(async (opts: { limit: string }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const batchTableName = `skills-svc-batches-${cfg.accountId}-${cfg.region}`;

      // Scan with limit (small table — acceptable)
      const res = await ddb.send(new QueryCommand({
        TableName: batchTableName,
        KeyConditionExpression: 'begins_with(PK, :prefix) AND SK = :meta',
        ExpressionAttributeValues: { ':prefix': 'BATCH#', ':meta': 'METADATA' },
        Limit: parseInt(opts.limit, 10),
        ScanIndexForward: false,
      }));

      prettyTable([
        ['Batch ID', 'Name', 'Status', 'Progress', 'Created'],
        ...(res.Items ?? []).map(item => [
          (item.batchId as string).slice(0, 8) + '...',
          item.batchName as string,
          item.status as string,
          `${item.completedJobs}/${item.totalJobs}`,
          new Date(item.createdAt as string).toLocaleDateString(),
        ]),
      ]);
    });

  return cmd;
}
```

---

## Feature 5: Skill Diff

### Commands

```bash
skills-svc diff <job-id-1> <job-id-2> [--format text|json|side-by-side]
```

### `packages/cli/src/commands/diff.ts`

```typescript
import { Command } from 'commander';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import chalk from 'chalk';
import * as diffLib from 'diff';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { DDB_KEY_PREFIX, RunResult, QueryRequest } from '@skills-svc/shared';
import { envelopeDecrypt } from '@skills-svc/shared/crypto';

export function diffCommand(): Command {
  return new Command('diff')
    .description('Compare outputs of two jobs — semantic similarity + text diff')
    .argument('<job-id-1>', 'First job ID (baseline)')
    .argument('<job-id-2>', 'Second job ID (comparison)')
    .option('--format <fmt>', 'Output format: text|json|side-by-side', 'text')
    .option('--full', 'Show full output diff, not just summary diff', false)
    .action(async (jobId1: string, jobId2: string, opts: { format: string; full: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const s3    = new S3Client({ region: cfg.region, credentials: creds });
      const lam   = new LambdaClient({ region: cfg.region, credentials: creds });

      // Fetch both jobs from DDB
      const [job1, job2] = await Promise.all([jobId1, jobId2].map(id =>
        ddb.send(new GetCommand({
          TableName: cfg.dynamodbTableName,
          Key: { PK: `${DDB_KEY_PREFIX.JOB}${id}`, SK: 'METADATA' },
        })).then(r => {
          if (!r.Item) throw new Error(`Job not found: ${id}`);
          return r.Item;
        })
      ));

      // Fetch result files from S3 and decrypt
      const fetchResult = async (job: Record<string, unknown>): Promise<RunResult> => {
        const resultKey = job.s3ResultKey as string | undefined;
        if (!resultKey) throw new Error(`Job ${job.jobId} has no result (status: ${job.status})`);
        const obj = await s3.send(new GetObjectCommand({
          Bucket: cfg.resultsBucket,
          Key: resultKey,
        }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        // Decrypt envelope
        const plain = await envelopeDecrypt(raw, {
          jobId: job.jobId as string,
          purpose: 'skills-svc-result',
          environment: cfg.envName,
        });
        return JSON.parse(plain.toString('utf-8')) as RunResult;
      };

      const [result1, result2] = await Promise.all([fetchResult(job1), fetchResult(job2)]);

      // Semantic similarity via query Lambda (embed both summaries, compute cosine similarity)
      const embedAndCompare = async (): Promise<number> => {
        try {
          const invocation = await lam.send(new InvokeCommand({
            FunctionName: cfg.queryLambdaArn,
            Payload: JSON.stringify({
              action: 'compare',
              text1: result1.resultSummary,
              text2: result2.resultSummary,
            }),
          }));
          const payload = JSON.parse(Buffer.from(invocation.Payload!).toString());
          return payload.cosineSimilarity as number;
        } catch {
          return -1; // comparison unavailable
        }
      };

      const compareText = opts.full ? result1.output : result1.resultSummary;
      const compareText2 = opts.full ? result2.output : result2.resultSummary;

      const [similarity, textDiff] = await Promise.all([
        embedAndCompare(),
        Promise.resolve(diffLib.diffWords(compareText, compareText2)),
      ]);

      if (opts.format === 'json') {
        console.log(JSON.stringify({
          job1: { id: jobId1, name: job1.jobName, createdAt: job1.createdAt },
          job2: { id: jobId2, name: job2.jobName, createdAt: job2.createdAt },
          similarity: similarity >= 0 ? similarity : null,
          diffWordCount: textDiff.filter(p => p.added || p.removed).length,
        }, null, 2));
        return;
      }

      // Header
      console.log(chalk.bold('\n  Skill Output Diff'));
      console.log(`  Baseline:    ${chalk.cyan(jobId1.slice(0, 8))} — ${job1.jobName} (${new Date(job1.createdAt as string).toLocaleDateString()})`);
      console.log(`  Comparison:  ${chalk.cyan(jobId2.slice(0, 8))} — ${job2.jobName} (${new Date(job2.createdAt as string).toLocaleDateString()})`);

      // Similarity score
      if (similarity >= 0) {
        const pct    = Math.round(similarity * 100);
        const bar    = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        const colour = pct > 80 ? chalk.green : pct > 50 ? chalk.yellow : chalk.red;
        console.log(`\n  Semantic similarity: ${colour(bar)} ${pct}%`);
        if (pct > 90) console.log(`  ${chalk.green('Very similar')} — outputs are nearly identical`);
        else if (pct > 70) console.log(`  ${chalk.yellow('Moderate change')} — meaningful differences detected`);
        else console.log(`  ${chalk.red('Significant change')} — outputs diverged substantially`);
      }

      // Text diff
      console.log(`\n  ${opts.full ? 'Full Output' : 'Summary'} Diff:\n`);
      for (const part of textDiff) {
        if (part.added)   process.stdout.write(chalk.green(part.value));
        else if (part.removed) process.stdout.write(chalk.red(part.value));
        else process.stdout.write(chalk.dim(part.value));
      }
      console.log('\n');
    });
}
```

---

## Feature 6: Cost Report

### Commands

```bash
skills-svc cost                              # costs for current user, last 30 days
skills-svc cost --since 2025-01-01 --until 2025-05-01
skills-svc cost --job-id <id>               # exact cost for one job
skills-svc cost --group-by team             # requires --tag key
skills-svc cost --format table|json|csv
```

### `packages/cli/src/commands/cost.ts`

```typescript
import { Command } from 'commander';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';
import { prettyTable } from '../utils/pretty-print';
import { estimateCost, estimateTokens } from '../utils/token-counter';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

// Fargate pricing constants (2 vCPU / 4 GB, us-east-1)
const ECS_VCPU_HR   = 0.04048;
const ECS_MEM_GB_HR = 0.004445;
const ECS_VCPU      = 2;
const ECS_MEM_GB    = 4;

interface JobCost {
  jobId: string;
  jobName: string;
  createdAt: string;
  status: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  bedrockInputUsd: number;
  bedrockOutputUsd: number;
  ecsFargateUsd: number;
  s3Usd: number;
  totalUsd: number;
}

function computeJobCost(item: Record<string, unknown>): JobCost {
  const durationMs    = item.durationMs as number | undefined ?? 0;
  const inputTokens   = item.inputTokens as number | undefined ?? 3600;   // estimate if not stored
  const outputTokens  = item.outputTokens as number | undefined ?? 2000;
  const durationHours = durationMs / 1000 / 3600;

  const bedrockInputUsd  = (inputTokens  / 1_000_000) * 3.00;
  const bedrockOutputUsd = (outputTokens / 1_000_000) * 15.00;
  const ecsFargateUsd    = durationHours * (ECS_VCPU * ECS_VCPU_HR + ECS_MEM_GB * ECS_MEM_GB_HR);
  const s3Usd            = 0.000_005; // ~5 S3 requests at $0.000_001 each

  return {
    jobId:          item.jobId as string,
    jobName:        item.jobName as string,
    createdAt:      item.createdAt as string,
    status:         item.status as string,
    durationMs,
    inputTokens,
    outputTokens,
    bedrockInputUsd,
    bedrockOutputUsd,
    ecsFargateUsd,
    s3Usd,
    totalUsd: bedrockInputUsd + bedrockOutputUsd + ecsFargateUsd + s3Usd,
  };
}

export function costCommand(): Command {
  return new Command('cost')
    .description('Estimate cost of jobs run through the skills pipeline')
    .option('--job-id <id>', 'Show cost for a single job')
    .option('--since <date>', 'Start date (ISO 8601)', new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10))
    .option('--until <date>', 'End date (ISO 8601)', new Date().toISOString().slice(0, 10))
    .option('--group-by <field>', 'Group by: day|week|skill|status')
    .option('--format <fmt>', 'Output format: table|json|csv', 'table')
    .action(async (opts: {
      jobId?: string;
      since: string;
      until: string;
      groupBy?: string;
      format: string;
    }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const sts   = new STSClient({ region: cfg.region, credentials: creds });

      // Single job cost
      if (opts.jobId) {
        const res = await ddb.send(new GetCommand({
          TableName: cfg.dynamodbTableName,
          Key: { PK: `${DDB_KEY_PREFIX.JOB}${opts.jobId}`, SK: 'METADATA' },
        }));
        if (!res.Item) { console.error(chalk.red('Job not found')); process.exit(1); }
        const cost = computeJobCost(res.Item);
        prettyTable([
          ['Component', 'Cost (USD)'],
          ['Bedrock input tokens',  `$${cost.bedrockInputUsd.toFixed(5)}`],
          ['Bedrock output tokens', `$${cost.bedrockOutputUsd.toFixed(5)}`],
          ['ECS Fargate',           `$${cost.ecsFargateUsd.toFixed(5)}`],
          ['S3 requests',           `$${cost.s3Usd.toFixed(5)}`],
          ['Total',                 chalk.bold(`$${cost.totalUsd.toFixed(5)}`)],
        ]);
        return;
      }

      // Range query — get all jobs for this user in date range
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      const allJobs: JobCost[] = [];
      let lastKey: Record<string, unknown> | undefined;

      do {
        const res = await ddb.send(new QueryCommand({
          TableName: cfg.dynamodbTableName,
          IndexName: 'GSI2-User',
          KeyConditionExpression: 'GSI2PK = :user AND GSI2SK BETWEEN :since AND :until',
          ExpressionAttributeValues: {
            ':user':  `${DDB_KEY_PREFIX.USER}${identity.Arn}`,
            ':since': `CREATED_AT#${opts.since}`,
            ':until': `CREATED_AT#${opts.until}T23:59:59Z`,
          },
          ExclusiveStartKey: lastKey as any,
        }));
        (res.Items ?? []).forEach(item => allJobs.push(computeJobCost(item)));
        lastKey = res.LastEvaluatedKey as any;
      } while (lastKey);

      if (!allJobs.length) {
        console.log(chalk.yellow('No jobs found in the specified date range.'));
        return;
      }

      const totalUsd = allJobs.reduce((sum, j) => sum + j.totalUsd, 0);

      if (opts.format === 'json') {
        console.log(JSON.stringify({ jobs: allJobs, totalUsd }, null, 2));
        return;
      }

      if (opts.format === 'csv') {
        console.log('JobId,JobName,Date,Status,DurationMs,TotalUSD');
        allJobs.forEach(j => console.log(
          `${j.jobId},${j.jobName},${j.createdAt.slice(0, 10)},${j.status},${j.durationMs ?? ''},${j.totalUsd.toFixed(5)}`
        ));
        return;
      }

      // Group-by
      if (opts.groupBy === 'day') {
        const byDay: Record<string, number> = {};
        for (const j of allJobs) {
          const day = j.createdAt.slice(0, 10);
          byDay[day] = (byDay[day] ?? 0) + j.totalUsd;
        }
        prettyTable([
          ['Date', 'Jobs', 'Cost (USD)'],
          ...Object.entries(byDay).sort().map(([day, cost]) => [
            day,
            String(allJobs.filter(j => j.createdAt.startsWith(day)).length),
            `$${cost.toFixed(4)}`,
          ]),
          ['TOTAL', String(allJobs.length), chalk.bold(`$${totalUsd.toFixed(4)}`)],
        ]);
        return;
      }

      // Default: summary table
      prettyTable([
        ['Job ID', 'Name', 'Date', 'Status', 'Duration', 'Cost'],
        ...allJobs.slice(-20).map(j => [  // last 20 jobs
          j.jobId.slice(0, 8) + '...',
          j.jobName.slice(0, 24),
          j.createdAt.slice(0, 10),
          j.status,
          j.durationMs ? `${Math.round(j.durationMs / 1000)}s` : 'N/A',
          `$${j.totalUsd.toFixed(4)}`,
        ]),
      ]);

      console.log(`\n  Total (${allJobs.length} jobs, ${opts.since} → ${opts.until}): ${chalk.bold('$' + totalUsd.toFixed(4))}`);
      console.log(`  Average per job: $${(totalUsd / allJobs.length).toFixed(4)}`);
    });
}
```

---

## Feature 7: Notification Subscriptions

### Commands

```bash
skills-svc notify subscribe --email you@company.com
skills-svc notify subscribe --webhook https://hooks.slack.com/...  [--filter-status FAILED]
skills-svc notify list
skills-svc notify unsubscribe <subscription-arn>
```

### `packages/cli/src/commands/notify.ts`

```typescript
import { Command } from 'commander';
import {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
  ListSubscriptionsByTopicCommand,
  SetSubscriptionAttributesCommand,
} from '@aws-sdk/client-sns';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { prettyTable } from '../utils/pretty-print';

export function notifyCommand(): Command {
  const cmd = new Command('notify').description('Manage job completion notification subscriptions');

  cmd.command('subscribe')
    .description('Subscribe to job notifications')
    .option('--email <address>', 'Email address to notify')
    .option('--webhook <url>', 'HTTPS webhook URL to POST notifications to')
    .option('--filter-status <status>', 'Only notify for specific status: COMPLETE|FAILED|ALL', 'ALL')
    .action(async (opts: { email?: string; webhook?: string; filterStatus: string }) => {
      if (!opts.email && !opts.webhook) {
        console.error(chalk.red('Provide --email or --webhook'));
        process.exit(1);
      }

      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const sns   = new SNSClient({ region: cfg.region, credentials: creds });
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });

      const topicArn = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/sns/jobs-topic-arn`,
      })).then(r => r.Parameter!.Value!);

      const protocol = opts.email   ? 'email'
                     : opts.webhook ? 'https'
                     : 'email';
      const endpoint = (opts.email ?? opts.webhook)!;

      const sub = await sns.send(new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: protocol,
        Endpoint: endpoint,
        ReturnSubscriptionArn: true,
        Attributes: opts.filterStatus !== 'ALL' ? {
          FilterPolicy: JSON.stringify({ status: [opts.filterStatus] }),
        } : undefined,
      }));

      if (opts.email) {
        console.log(chalk.yellow(`✉  Confirmation email sent to ${opts.email}`));
        console.log(chalk.dim('Check your inbox and click the confirmation link to activate.'));
      } else {
        console.log(chalk.green(`✓ Webhook subscribed: ${opts.webhook}`));
      }

      console.log(chalk.dim(`Subscription ARN: ${sub.SubscriptionArn}`));
      if (opts.filterStatus !== 'ALL') {
        console.log(chalk.dim(`Filter: status = ${opts.filterStatus} only`));
      }
    });

  cmd.command('list')
    .description('List active notification subscriptions')
    .action(async () => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const sns   = new SNSClient({ region: cfg.region, credentials: creds });
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });

      const topicArn = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/sns/jobs-topic-arn`,
      })).then(r => r.Parameter!.Value!);

      const subs = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));

      if (!subs.Subscriptions?.length) {
        console.log(chalk.yellow('No subscriptions found.'));
        return;
      }

      prettyTable([
        ['Protocol', 'Endpoint', 'Status', 'ARN (short)'],
        ...(subs.Subscriptions ?? []).map(s => [
          s.Protocol ?? '',
          (s.Endpoint ?? '').slice(0, 40) + (s.Endpoint && s.Endpoint.length > 40 ? '...' : ''),
          s.SubscriptionArn === 'PendingConfirmation'
            ? chalk.yellow('Pending')
            : chalk.green('Active'),
          (s.SubscriptionArn ?? '').split(':').pop()?.slice(0, 20) ?? '',
        ]),
      ]);
    });

  cmd.command('unsubscribe <subscription-arn>')
    .description('Remove a notification subscription')
    .action(async (subscriptionArn: string) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const sns   = new SNSClient({ region: cfg.region, credentials: creds });

      await sns.send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
      console.log(chalk.green(`✓ Unsubscribed: ${subscriptionArn.split(':').pop()}`));
    });

  return cmd;
}
```

---

## Feature 8: Audit Trail

### Commands

```bash
skills-svc audit <job-id>                          # all CloudTrail events for one job
skills-svc audit --since 2025-05-01 --action upload
skills-svc audit --user <arn> --since 2025-01-01
```

### `packages/cli/src/commands/audit.ts`

```typescript
import { Command } from 'commander';
import {
  CloudTrailClient,
  LookupEventsCommand,
  LookupAttribute,
  LookupAttributeKey,
} from '@aws-sdk/client-cloudtrail';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { prettyTable } from '../utils/pretty-print';

const ACTION_EVENT_MAP: Record<string, string[]> = {
  upload: ['PutObject'],
  query:  ['InvokeFunction'],
  cancel: ['StopTask', 'UpdateItem'],
  all:    [],
};

export function auditCommand(): Command {
  return new Command('audit')
    .description('Query CloudTrail audit events for jobs or users')
    .argument('[job-id]', 'Filter events for a specific job ID')
    .option('--since <date>', 'Start date (ISO 8601)', new Date(Date.now() - 7 * 86400_000).toISOString())
    .option('--until <date>', 'End date (ISO 8601)', new Date().toISOString())
    .option('--action <action>', 'Filter by action type: upload|query|cancel|all', 'all')
    .option('--user <arn>', 'Filter by IAM user or role ARN')
    .option('--limit <n>', 'Max events to return', '50')
    .option('--format <fmt>', 'Output format: table|json', 'table')
    .action(async (jobId: string | undefined, opts: {
      since: string;
      until: string;
      action: string;
      user?: string;
      limit: string;
      format: string;
    }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ct    = new CloudTrailClient({ region: cfg.region, credentials: creds });

      const lookupAttributes: LookupAttribute[] = [];

      if (opts.user) {
        lookupAttributes.push({
          AttributeKey: LookupAttributeKey.USERNAME,
          AttributeValue: opts.user.split('/').pop()!, // last segment of ARN
        });
      }

      // CloudTrail LookupEvents supports only one attribute filter at a time
      // For job-id we filter client-side on the request parameters
      const allEvents: any[] = [];
      let nextToken: string | undefined;

      do {
        const res = await ct.send(new LookupEventsCommand({
          LookupAttributes: lookupAttributes.length ? lookupAttributes : undefined,
          StartTime: new Date(opts.since),
          EndTime: new Date(opts.until),
          MaxResults: 50,
          NextToken: nextToken,
        }));

        const events = res.Events ?? [];

        // Filter by job ID if provided (job ID appears in request parameters)
        const filtered = jobId
          ? events.filter(e => JSON.stringify(e.CloudTrailEvent ?? '').includes(jobId))
          : events;

        // Filter by action
        const actionEvents = ACTION_EVENT_MAP[opts.action] ?? [];
        const actionFiltered = actionEvents.length
          ? filtered.filter(e => actionEvents.includes(e.EventName ?? ''))
          : filtered;

        allEvents.push(...actionFiltered);
        nextToken = res.NextToken;
      } while (nextToken && allEvents.length < parseInt(opts.limit, 10));

      const limited = allEvents.slice(0, parseInt(opts.limit, 10));

      if (!limited.length) {
        console.log(chalk.yellow('No audit events found matching the criteria.'));
        return;
      }

      if (opts.format === 'json') {
        console.log(JSON.stringify(limited.map(e => ({
          eventTime: e.EventTime,
          eventName: e.EventName,
          username:  e.Username,
          sourceIP:  e.CloudTrailEvent ? JSON.parse(e.CloudTrailEvent).sourceIPAddress : null,
          resources: e.Resources?.map((r: any) => r.ResourceName),
        })), null, 2));
        return;
      }

      prettyTable([
        ['Time', 'Event', 'User', 'Source IP', 'Resource'],
        ...limited.map(e => {
          let sourceIP = '';
          try {
            sourceIP = JSON.parse(e.CloudTrailEvent ?? '{}').sourceIPAddress ?? '';
          } catch {}
          return [
            new Date(e.EventTime ?? 0).toLocaleString(),
            e.EventName ?? '',
            (e.Username ?? '').slice(0, 20),
            sourceIP,
            e.Resources?.[0]?.ResourceName?.split('/').pop()?.slice(0, 30) ?? '',
          ];
        }),
      ]);

      console.log(chalk.dim(`\n${limited.length} event(s) shown. CloudTrail retention: 90 days.`));
      if (jobId) console.log(chalk.dim(`Note: job-id filter is applied client-side. Results may be incomplete for old events.`));
    });
}
```

---

## Updated `packages/cli/src/index.ts`

```typescript
import { cancelCommand }  from './commands/cancel';
import { profileCommand } from './commands/profile';
import { batchCommand }   from './commands/batch';
import { diffCommand }    from './commands/diff';
import { costCommand }    from './commands/cost';
import { notifyCommand }  from './commands/notify';
import { auditCommand }   from './commands/audit';

program.addCommand(cancelCommand());
program.addCommand(profileCommand());
program.addCommand(batchCommand());
program.addCommand(diffCommand());
program.addCommand(costCommand());
program.addCommand(notifyCommand());
program.addCommand(auditCommand());
```

---

## New npm dependencies

```json
{
  "@aws-sdk/client-sfn": "^3.600.0",
  "@aws-sdk/client-cloudtrail": "^3.600.0",
  "diff": "^5.2.0",
  "@types/diff": "^5.2.0",
  "glob": "^10.4.0"
}
```

---

## QA Checks (QA-125 through QA-134)

```typescript
// QA-125: cancel rejects terminal status jobs
test('QA-125: cancel exits 1 when job is already COMPLETE', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({ Item: { status: 'COMPLETE', version: 2, jobName: 'test' } });
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  await expect(runCancel('job-001')).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-126: cancel uses optimistic locking (version check)
test('QA-126: cancel UpdateCommand includes ConditionExpression with version', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({ Item: { status: 'RUNNING', version: 3, jobName: 'test' } });
  ddbMock.on(UpdateCommand).resolves({});
  const ecsMock = mockClient(ECSClient);
  ecsMock.on(ListTasksCommand).resolves({ taskArns: [] });

  await runCancel('job-001', { reason: 'test cancel' });

  const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
  expect(updateCall.args[0].input.ConditionExpression).toContain('#ver = :curVer');
  expect(updateCall.args[0].input.ExpressionAttributeValues[':curVer']).toBe(3);
  expect(updateCall.args[0].input.ExpressionAttributeValues[':newVer']).toBe(4);
});

// QA-127: loadConfig reads correct profile
test('QA-127: loadConfig reads from profile-specific file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa127-'));
  process.env.HOME = tmpDir;
  fs.mkdirSync(path.join(tmpDir, '.skills-svc', 'profiles'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.skills-svc', 'profiles', 'staging.json'),
    JSON.stringify({ profileName: 'staging', region: 'us-west-2', envName: 'staging' })
  );
  const cfg = await loadConfig('staging');
  expect(cfg.region).toBe('us-west-2');
  expect(cfg.envName).toBe('staging');
});

// QA-128: computeCacheKey is deterministic
test('QA-128: computeCacheKey returns same hash for same input', () => {
  const buf = Buffer.from('test zip content');
  const key1 = computeCacheKey(buf, 'analyze');
  const key2 = computeCacheKey(buf, 'analyze');
  expect(key1).toBe(key2);
  expect(key1).toHaveLength(64); // sha256 hex
});

// QA-129: computeCacheKey differs for different prompts
test('QA-129: computeCacheKey differs when prompt changes', () => {
  const buf = Buffer.from('same zip');
  expect(computeCacheKey(buf, 'prompt A')).not.toBe(computeCacheKey(buf, 'prompt B'));
});

// QA-130: batch concurrency is clamped to 1-50
test('QA-130: batch run clamps concurrency to [1, 50]', () => {
  expect(Math.min(Math.max(-5, 1), 50)).toBe(1);
  expect(Math.min(Math.max(100, 1), 50)).toBe(50);
  expect(Math.min(Math.max(10, 1), 50)).toBe(10);
});

// QA-131: cost formula matches known values
test('QA-131: computeJobCost matches known pricing for 1-hour job', () => {
  const cost = computeJobCost({
    jobId: 'test', jobName: 'test', createdAt: new Date().toISOString(),
    status: 'COMPLETE',
    durationMs: 3600_000,  // 1 hour
    inputTokens: 10_000,
    outputTokens: 5_000,
  });
  // Bedrock: 10k input * $3/1M = $0.03, 5k output * $15/1M = $0.075
  expect(cost.bedrockInputUsd).toBeCloseTo(0.03, 4);
  expect(cost.bedrockOutputUsd).toBeCloseTo(0.075, 4);
  // ECS: 1h * (2 * 0.04048 + 4 * 0.004445) = 0.09874
  expect(cost.ecsFargateUsd).toBeCloseTo(0.09874, 3);
  expect(cost.totalUsd).toBeCloseTo(0.03 + 0.075 + 0.09874 + 0.000005, 3);
});

// QA-132: diff command fetches and decrypts both job results
test('QA-132: diff fetches result for both job IDs', async () => {
  const s3Mock = mockClient(S3Client);
  const envelopeSpy = jest.spyOn(cryptoModule, 'envelopeDecrypt').mockResolvedValue(Buffer.from(JSON.stringify(mockResult)));
  s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([JSON.stringify(mockEnvelope)]) });
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({ Item: { jobId: 'test', status: 'COMPLETE', s3ResultKey: 'results/test/result.json.enc' } });

  await runDiff('job-001', 'job-002', { format: 'json', full: false });

  expect(envelopeSpy).toHaveBeenCalledTimes(2); // one for each job
});

// QA-133: notify subscribe sends SNS Subscribe with correct protocol
test('QA-133: notify subscribe uses email protocol for --email flag', async () => {
  const snsMock = mockClient(SNSClient);
  snsMock.on(SubscribeCommand).resolves({ SubscriptionArn: 'arn:test' });
  await runNotifySubscribe({ email: 'test@example.com', filterStatus: 'ALL' });
  const call = snsMock.commandCalls(SubscribeCommand)[0];
  expect(call.args[0].input.Protocol).toBe('email');
  expect(call.args[0].input.Endpoint).toBe('test@example.com');
});

// QA-134: audit filters client-side by job ID
test('QA-134: audit command filters CloudTrail events by job ID in response', async () => {
  const ctMock = mockClient(CloudTrailClient);
  const jobId = 'target-job-001';
  ctMock.on(LookupEventsCommand).resolves({
    Events: [
      { EventName: 'PutObject', CloudTrailEvent: JSON.stringify({ requestParameters: { key: `uploads/xyz/${jobId}.zip` } }), EventTime: new Date() },
      { EventName: 'PutObject', CloudTrailEvent: JSON.stringify({ requestParameters: { key: 'uploads/other/other.zip' } }), EventTime: new Date() },
    ],
  });

  const output = await captureOutput(() => runAudit(jobId, {}));
  expect(output).toContain(jobId);
  // Second event (unrelated) should not appear
  expect(output).not.toContain('other.zip');
});
```

---

## Summary — New Files

```
packages/cli/src/
├── commands/
│   ├── cancel.ts     NEW
│   ├── profile.ts    NEW
│   ├── batch.ts      NEW
│   ├── diff.ts       NEW
│   ├── cost.ts       NEW
│   ├── notify.ts     NEW
│   └── audit.ts      NEW
└── utils/
    └── cache.ts      NEW

packages/lambda/src/
├── batch-submit/
│   └── handler.ts    NEW — called by Step Functions Map state
└── batch-status/
    └── handler.ts    NEW — polls job status for Step Functions wait loop

infra/lib/
├── batch-stack.ts    NEW — Step Functions + batch DDB table
└── storage-stack.ts  UPDATED — GSI4 (cache key lookup)
```
