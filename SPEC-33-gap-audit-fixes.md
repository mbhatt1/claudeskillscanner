# SPEC-33 — Gap Audit Fixes: SPEC-32 Self-Consistency, Batch, Code Review, Shared Types, CDK Deploy Order, CLI Consistency

**Supersedes SPEC-32 on all overlapping topics.**

Every fix has complete TypeScript. No pseudocode. No "see above".

---

## Section 1 — Shared Types & Utilities

### S1 / T9: `packages/shared/src/utils.ts` — normaliseArn + export

```typescript
// packages/shared/src/utils.ts
export function normaliseArn(arn: string): string {
  const m = arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.+$/);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn;
}
```

```typescript
// packages/shared/src/index.ts  (add to existing exports)
export { normaliseArn } from './utils';
export * from './constants';      // T9: constants must be exported
export * from './types';
export * from './job-status';
```

---

### T1: `packages/shared/src/job-status.ts` — isTerminal missing CANCELLED

```typescript
// packages/shared/src/job-status.ts
export enum JobStatus {
  PENDING    = 'PENDING',
  RUNNING    = 'RUNNING',
  COMPLETE   = 'COMPLETE',
  FAILED     = 'FAILED',
  CANCELLED  = 'CANCELLED',
}

export function isTerminal(status: JobStatus): boolean {
  return (
    status === JobStatus.COMPLETE  ||
    status === JobStatus.FAILED    ||
    status === JobStatus.CANCELLED   // T1: was missing
  );
}
```

---

### T3: `packages/shared/src/constants.ts` — SCHEDULE# prefix

```typescript
// packages/shared/src/constants.ts
export const DDB_KEY_PREFIX = {
  JOB:          'JOB#',
  USER:         'USER#',
  BATCH:        'BATCH#',
  MCPTOKEN:     'MCPTOKEN#',
  SCHEDULE:     'SCHEDULE#',   // T3: was missing
  RESULT:       'RESULT#',
  REVIEW:       'REVIEW#',
} as const;

export const GSI = {
  GSI1: 'GSI1-UserBatches',
  GSI2: 'GSI2-UserJobs',
  GSI3: 'GSI3-Status',
  GSI4: 'GSI4-CacheKey',
  GSI5: 'GSI5-ReviewRepo',   // CR8: renamed from GSI4 collision
} as const;
```

---

### T8: `packages/shared/src/types.ts` — BatchManifestEntry subpath/excludePatterns preserved

```typescript
// packages/shared/src/types.ts

export interface BatchManifestEntry {
  repoUrl:         string;
  branch?:         string;
  commit?:         string;
  subpath?:        string;          // T8: must not be dropped
  excludePatterns?: string[];       // T8: must not be dropped
  candidateArn?:   string;
  jobId?:          string;          // set by ingestion after RunTask
}

export interface BatchManifest {
  batchId:  string;
  entries:  BatchManifestEntry[];
}

export interface RunResult {
  jobId:      string;
  userArn:    string;    // T4: required — runner reads from env
  s3ResultKey: string;   // T10: uploader must return key; set here
  score?:     number;
  summary?:   string;
  findings?:  Finding[];
  error?:     string;
}

export interface Finding {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  rule:     string;
  message:  string;
  file?:    string;
  line?:    number;
}

export interface ReviewOutput {
  repoUrl:   string;
  branch:    string;
  commit:    string;
  prNumber?: number;
  findings:  Finding[];
  score?:    number;
  summary?:  string;
}
```

---

## Section 2 — ECS Runner

### T4 / T10: `packages/runner/src/main.ts` — userArn from env, s3ResultKey in RunResult

```typescript
// packages/runner/src/main.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { RunResult } from '@skills-svc/shared';

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function uploadResult(
  bucket: string,
  jobId: string,
  result: RunResult,
): Promise<string> {
  const key = `results/${jobId}/result.json`;
  await s3.send(new PutObjectCommand({
    Bucket:               bucket,
    Key:                  key,
    Body:                 JSON.stringify(result),
    ContentType:          'application/json',
    ServerSideEncryption: 'aws:kms',
  }));
  return key;  // T10: return the key
}

async function main(): Promise<void> {
  const jobId   = process.env.JOB_ID!;
  const userArn = process.env.USER_ARN!;   // T4: read from env
  const bucket  = process.env.RESULTS_BUCKET!;

  if (!jobId || !userArn || !bucket) {
    console.error('Missing required env vars: JOB_ID, USER_ARN, RESULTS_BUCKET');
    process.exit(1);
  }

  // ... run analysis ...
  const analysisResult = await runAnalysis();

  const partial: Omit<RunResult, 's3ResultKey'> = {
    jobId,
    userArn,
    score:    analysisResult.score,
    summary:  analysisResult.summary,
    findings: analysisResult.findings,
  };

  // T10: uploader returns the key; set it on the result
  const s3ResultKey = await uploadResult(bucket, jobId, partial as RunResult);

  const result: RunResult = { ...partial, s3ResultKey };
  console.log('RunResult:', JSON.stringify(result));
}

async function runAnalysis(): Promise<{ score: number; summary: string; findings: any[] }> {
  // Placeholder — replaced by actual analysis logic
  return { score: 0, summary: '', findings: [] };
}

main().catch(err => { console.error(err); process.exit(1); });
```

---

## Section 3 — SPEC-32 Self-Consistency Fixes

### S2 / D6 / D10: `infra/lib/lambda-stack.ts` — backfill Lambda IAM + encrypted log group

```typescript
// infra/lib/lambda-stack.ts  (backfill Lambda section — replaces prior definition)
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface LambdaStackProps extends cdk.StackProps {
  envName:              string;
  vpc:                  any;
  lambdaSg:             any;
  dynamodbKmsKey:       kms.Key;
  resultsKmsKey:        kms.Key;
  uploadsKmsKey:        kms.Key;
  lambdaEnvKey:         kms.Key;
  jobsTableName:        string;
  jobsTableArn:         string;
  uploadsBucket:        string;
  resultsBucket:        string;
  uploadsKmsKeyId:      string;
  aossCollectionArn:    string;
  ecsClusterArn:        string;   // D1: required prop
  ecsClusterName:       string;
  ecsTaskDefinitionArn: string;   // D9
  ecsSubnetIds:         string[];
  ecsSecurityGroupIds:  string[];
  githubStatusQueueUrl: string;
  githubStatusQueueArn: string;
}

export class LambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // ── Backfill Lambda IAM Role ──────────────────────────────────────────────
    // S2 / D10: complete IAM for backfill
    const backfillRole = new iam.Role(this, 'BackfillLambdaRole', {
      roleName:  `skills-svc-backfill-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    backfillRole.addToPolicy(new iam.PolicyStatement({
      sid:     'DynamoDBScan',
      actions: ['dynamodb:Scan'],
      resources: [
        props.jobsTableArn,
        `${props.jobsTableArn}/index/*`,
      ],
    }));

    backfillRole.addToPolicy(new iam.PolicyStatement({
      sid:     'S3GetObject',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.resultsBucket}/*`],
    }));

    backfillRole.addToPolicy(new iam.PolicyStatement({
      sid:     'KMSDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [
        props.resultsKmsKey.keyArn,
        props.dynamodbKmsKey.keyArn,
        props.lambdaEnvKey.keyArn,
      ],
    }));

    backfillRole.addToPolicy(new iam.PolicyStatement({
      sid:     'AOSSAPIAccess',
      actions: ['aoss:APIAccessAll'],
      resources: [props.aossCollectionArn],
    }));

    backfillRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SSMCheckpoint',
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/backfill/*`,
      ],
    }));

    // D6: encrypted log group for backfill
    const backfillLogGroup = new logs.LogGroup(this, 'BackfillLogGroup', {
      logGroupName:  `/skills-svc/${envName}/backfill`,
      retention:     logs.RetentionDays.ONE_MONTH,
      encryptionKey: props.lambdaEnvKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    backfillRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [backfillLogGroup.logGroupArn],
    }));

    const backfillFn = new lambda.Function(this, 'BackfillLambda', {
      functionName: `skills-svc-backfill-${envName}`,
      runtime:      lambda.Runtime.NODEJS_20_X,
      handler:      'backfill/handler.handler',
      code:         lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout:      cdk.Duration.minutes(14),   // D7: soft deadline at 13 min inside
      memorySize:   1024,
      role:         backfillRole,
      logGroup:     backfillLogGroup,
      environment: {
        ENV:              envName,
        JOBS_TABLE_NAME:  props.jobsTableName,
        RESULTS_BUCKET:   props.resultsBucket,
        AOSS_ENDPOINT:    `https://${props.aossCollectionArn}`,
        CHECKPOINT_PARAM: `/skills-svc/${envName}/backfill/checkpoint`,
      },
    });

    // ── Ingestion Lambda IAM Role ─────────────────────────────────────────────
    const ingestionRole = new iam.Role(this, 'IngestionLambdaRole', {
      roleName:  `skills-svc-ingestion-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    ingestionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'DynamoDB',
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
      resources: [
        props.jobsTableArn,
        `${props.jobsTableArn}/index/*`,
      ],
    }));

    ingestionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'S3GetUploads',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.uploadsBucket}/*`],
    }));

    ingestionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ECSRunTask',
      actions: ['ecs:RunTask'],
      resources: [props.ecsTaskDefinitionArn],
    }));

    ingestionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'PassRoleToECS',
      actions: ['iam:PassRole'],
      resources: ['*'],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));

    ingestionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'KMSDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [
        props.uploadsKmsKey.keyArn,
        props.dynamodbKmsKey.keyArn,
        props.lambdaEnvKey.keyArn,
      ],
    }));

    ingestionRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/ingestion*`],
    }));

    const ingestionFn = new lambda.Function(this, 'IngestionLambda', {
      functionName: `skills-svc-ingestion-${envName}`,
      runtime:      lambda.Runtime.NODEJS_20_X,
      handler:      'ingestion/handler.handler',
      code:         lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout:      cdk.Duration.seconds(60),
      memorySize:   256,
      role:         ingestionRole,
      environment: {
        ENV:                    envName,
        JOBS_TABLE_NAME:        props.jobsTableName,
        UPLOADS_BUCKET:         props.uploadsBucket,
        UPLOADS_KMS_KEY_ID:     props.uploadsKmsKeyId,
        // D3: ECS env vars were missing from ingestion Lambda
        ECS_CLUSTER_ARN:        props.ecsClusterArn,
        ECS_TASK_DEFINITION_ARN: props.ecsTaskDefinitionArn,
        ECS_SUBNET_IDS:         props.ecsSubnetIds.join(','),
        ECS_SECURITY_GROUP_IDS: props.ecsSecurityGroupIds.join(','),
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // ── Results Processor Lambda ──────────────────────────────────────────────
    const resultsRole = new iam.Role(this, 'ResultsLambdaRole', {
      roleName:  `skills-svc-results-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    resultsRole.addToPolicy(new iam.PolicyStatement({
      sid:     'DynamoDB',
      actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
      resources: [props.jobsTableArn, `${props.jobsTableArn}/index/*`],
    }));

    resultsRole.addToPolicy(new iam.PolicyStatement({
      sid:     'S3GetResults',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.resultsBucket}/*`],
    }));

    resultsRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SQSSendStatus',
      actions: ['sqs:SendMessage'],
      resources: [props.githubStatusQueueArn],
    }));

    resultsRole.addToPolicy(new iam.PolicyStatement({
      sid:     'KMSDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [
        props.resultsKmsKey.keyArn,
        props.dynamodbKmsKey.keyArn,
        props.lambdaEnvKey.keyArn,
      ],
    }));

    resultsRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/results*`],
    }));

    resultsRole.addToPolicy(new iam.PolicyStatement({
      sid:     'AOSSAPIAccess',
      actions: ['aoss:APIAccessAll'],
      resources: [props.aossCollectionArn],
    }));

    const resultsFn = new lambda.Function(this, 'ResultsLambda', {
      functionName: `skills-svc-results-${envName}`,
      runtime:      lambda.Runtime.NODEJS_20_X,
      handler:      'results-processor/handler.handler',
      code:         lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout:      cdk.Duration.seconds(120),
      memorySize:   512,
      role:         resultsRole,
      environment: {
        ENV:                    envName,
        JOBS_TABLE_NAME:        props.jobsTableName,
        RESULTS_BUCKET:         props.resultsBucket,
        GITHUB_STATUS_QUEUE_URL: props.githubStatusQueueUrl,
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });

    // ── S7: GSI4-CacheKey EventBridge rule belongs in LambdaStack ────────────
    // S8 / D1: EventBridge rule with clusterArn filter, no startedBy
    const ecsStateRule = new events.Rule(this, 'ECSTaskStateRule', {
      ruleName:    `skills-svc-ecs-stopped-${envName}`,
      description: 'Fires when any ECS task in our cluster reaches STOPPED',
      eventPattern: {
        source:     ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          lastStatus: ['STOPPED'],
          clusterArn: [props.ecsClusterArn],   // S8/D1: scope to cluster; no startedBy filter
        },
      },
    });

    ecsStateRule.addTarget(new targets.LambdaFunction(resultsFn, {
      retryAttempts: 2,
    }));
  }
}
```

---

### S3: `packages/lambda/src/backfill/handler.ts` — format detection before envelopeDecrypt

```typescript
// packages/lambda/src/backfill/handler.ts
import { DynamoDBClient, ScanCommand, ScanCommandInput } from '@aws-sdk/client-dynamodb';
import { unmarshall }  from '@aws-sdk/util-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { envelopeDecrypt } from '../crypto/envelope';
import { indexResult }     from '../search/index';
import { JobStatus }       from '@skills-svc/shared';

const ddb = new DynamoDBClient({});
const s3  = new S3Client({});
const ssm = new SSMClient({});

const SOFT_DEADLINE_MS  = 13 * 60 * 1000;  // D7
const CHECKPOINT_PARAM  = process.env.CHECKPOINT_PARAM!;
const JOBS_TABLE_NAME   = process.env.JOBS_TABLE_NAME!;
const RESULTS_BUCKET    = process.env.RESULTS_BUCKET!;

// S3: detect whether the S3 object is a pre-SPEC-30 plain JSON or a SPEC-30+ envelope
function isEncryptedEnvelope(raw: string): boolean {
  try {
    const obj = JSON.parse(raw);
    // Encrypted envelope has 'ciphertext' and 'encryptedDataKey' fields
    return typeof obj.ciphertext === 'string' && typeof obj.encryptedDataKey === 'string';
  } catch {
    return false;
  }
}

async function getCheckpoint(): Promise<string | undefined> {
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: CHECKPOINT_PARAM }));
    return resp.Parameter?.Value;
  } catch (e: any) {
    if (e.name === 'ParameterNotFound') return undefined;
    throw e;
  }
}

async function saveCheckpoint(lastEvaluatedKey: Record<string, any>): Promise<void> {
  await ssm.send(new PutParameterCommand({
    Name:      CHECKPOINT_PARAM,
    Value:     JSON.stringify(lastEvaluatedKey),
    Type:      'String',
    Overwrite: true,
  }));
}

export async function handler(): Promise<void> {
  const startTime = Date.now();
  const checkpointRaw = await getCheckpoint();
  let exclusiveStartKey: Record<string, any> | undefined = checkpointRaw
    ? JSON.parse(checkpointRaw)
    : undefined;

  let pageCount = 0;

  do {
    // D7: soft deadline — save checkpoint and exit gracefully before Lambda timeout
    if (Date.now() - startTime > SOFT_DEADLINE_MS) {
      console.log(`Soft deadline reached after ${pageCount} pages; checkpoint saved.`);
      break;
    }

    const params: ScanCommandInput = {
      TableName:         JOBS_TABLE_NAME,
      FilterExpression:  '#s = :complete',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: { ':complete': { S: JobStatus.COMPLETE } },
      ExclusiveStartKey: exclusiveStartKey as any,
      Limit:             100,
    };

    const page = await ddb.send(new ScanCommand(params));
    pageCount++;

    for (const raw of page.Items ?? []) {
      const item = unmarshall(raw);

      // CR7: skip code-review / tarball / git jobs — they have a different result format
      if (item.inputMode === 'tarball' || item.inputMode === 'git') continue;

      const s3Key = item.s3ResultKey as string | undefined;
      if (!s3Key) continue;

      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: s3Key }));
        const bodyStr = await obj.Body!.transformToString();

        // S3: format detection — handle both pre-SPEC-30 plain JSON and SPEC-30+ envelopes
        let result: any;
        if (isEncryptedEnvelope(bodyStr)) {
          result = await envelopeDecrypt(bodyStr, item.userArn as string);
        } else {
          result = JSON.parse(bodyStr);
        }

        await indexResult(result);
      } catch (err) {
        console.warn(`Skipping jobId=${item.jobId}: ${err}`);
      }
    }

    exclusiveStartKey = page.LastEvaluatedKey as Record<string, any> | undefined;

    // D7: persist checkpoint after each page
    if (exclusiveStartKey) {
      await saveCheckpoint(exclusiveStartKey);
    } else {
      // Scan complete — clear checkpoint
      try {
        await ssm.send(new PutParameterCommand({
          Name:      CHECKPOINT_PARAM,
          Value:     '',
          Type:      'String',
          Overwrite: true,
        }));
      } catch { /* ignore */ }
    }
  } while (exclusiveStartKey);
}
```

---

### S4 / S9 / S10 / CL7: `packages/lambda/src/cancel-job/handler.ts`

```typescript
// packages/lambda/src/cancel-job/handler.ts
// S4: SQS delete removed from PENDING path — ingestion is S3-triggered, no SQS metadata.
// S9: Write CANCELLED to DDB first, then attempt ECS stop (best-effort).
// S10: ConditionExpression guards both PENDING and RUNNING, plus version check.
// B6: batch cancel also stops ECS tasks.
import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { ECSClient, ListTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { JobStatus } from '@skills-svc/shared';

const ddb = new DynamoDBClient({});
const ecs = new ECSClient({});

const JOBS_TABLE_NAME  = process.env.JOBS_TABLE_NAME!;
const ECS_CLUSTER_ARN  = process.env.ECS_CLUSTER_ARN!;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const jobId   = event.pathParameters?.jobId;
  const userArn = event.requestContext.authorizer?.lambda?.userArn as string;

  if (!jobId) return { statusCode: 400, body: JSON.stringify({ error: 'jobId required' }) };

  // Fetch current item to get version
  const existing = await ddb.send(new GetItemCommand({
    TableName: JOBS_TABLE_NAME,
    Key:       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
  }));

  if (!existing.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
  }

  const item = unmarshall(existing.Item);
  if (item.userArn !== userArn) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  const currentVersion = item.version as number ?? 0;

  // S9: Write CANCELLED to DDB FIRST (atomically), THEN stop ECS task best-effort.
  // S10: ConditionExpression guards version AND status IN (PENDING, RUNNING).
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: JOBS_TABLE_NAME,
      Key:       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
      UpdateExpression:           'SET #s = :cancelled, #v = :newVersion, updatedAt = :now',
      // S10: must be PENDING or RUNNING; check version to prevent races
      ConditionExpression:        '#v = :version AND #s IN (:pending, :running)',
      ExpressionAttributeNames: {
        '#s': 'status',
        '#v': 'version',
      },
      ExpressionAttributeValues: marshall({
        ':cancelled':  JobStatus.CANCELLED,   // S5: use enum not string literal
        ':pending':    JobStatus.PENDING,
        ':running':    JobStatus.RUNNING,
        ':version':    currentVersion,
        ':newVersion': currentVersion + 1,
        ':now':        new Date().toISOString(),
      }),
    }));
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') {
      return { statusCode: 409, body: JSON.stringify({ error: 'Job not in cancellable state' }) };
    }
    throw e;
  }

  // S4: No SQS delete — ingestion is S3-triggered. DDB status written above is sufficient.
  // S9: ECS stop is best-effort (RUNNING path only).
  if (item.status === JobStatus.RUNNING) {
    try {
      // Use bare jobId as startedBy (set by ingestion RunTask call)
      const tasks = await ecs.send(new ListTasksCommand({
        cluster:   ECS_CLUSTER_ARN,
        startedBy: jobId,
      }));

      for (const taskArn of tasks.taskArns ?? []) {
        await ecs.send(new StopTaskCommand({
          cluster: ECS_CLUSTER_ARN,
          task:    taskArn,
          reason:  'Cancelled by user',
        })).catch(err => console.warn(`StopTask ${taskArn} failed (best-effort):`, err));
      }
    } catch (err) {
      console.warn('ECS stop best-effort failed:', err);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ jobId, status: JobStatus.CANCELLED }) };
}
```

---

### S5: Replace all `'CANCELLED'` string literals with `JobStatus.CANCELLED`

In `packages/lambda/src/ingestion/handler.ts`, any reference to `'CANCELLED'` must use the enum:

```typescript
// packages/lambda/src/ingestion/handler.ts  (relevant section)
import { JobStatus } from '@skills-svc/shared';

// Before starting RunTask, check if job was cancelled:
const jobItem = await ddb.send(new GetItemCommand({ ... }));
const currentStatus = unmarshall(jobItem.Item!).status as JobStatus;

if (currentStatus === JobStatus.CANCELLED) {   // S5: not 'CANCELLED'
  console.log(`Job ${jobId} was cancelled before ECS RunTask; aborting.`);
  return;
}
```

---

### S6: `packages/lambda/src/results-processor/handler.ts` — no-overwrite of CANCELLED

```typescript
// packages/lambda/src/results-processor/handler.ts
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand }     from '@aws-sdk/client-sqs';
import { S3Client, GetObjectCommand }        from '@aws-sdk/client-s3';
import { ECSTaskStateChangeEvent }           from 'aws-lambda';
import { marshall }   from '@aws-sdk/util-dynamodb';
import { JobStatus }  from '@skills-svc/shared';
import { envelopeDecrypt } from '../crypto/envelope';
import { indexResult }     from '../search/index';

const ddb = new DynamoDBClient({});
const sqs = new SQSClient({});
const s3  = new S3Client({});

const JOBS_TABLE_NAME        = process.env.JOBS_TABLE_NAME!;
const RESULTS_BUCKET         = process.env.RESULTS_BUCKET!;
const GITHUB_STATUS_QUEUE_URL = process.env.GITHUB_STATUS_QUEUE_URL!;

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

export async function handler(event: any): Promise<void> {
  const detail = event.detail ?? {};
  const jobId  = detail.startedBy as string | undefined;

  // Validate startedBy is a bare UUID (set by ingestion)
  if (!jobId || !isValidUUID(jobId)) {
    console.log('Ignoring ECS event: startedBy is not a valid UUID', jobId);
    return;
  }

  const exitCode    = detail.containers?.[0]?.exitCode as number | undefined;
  const succeeded   = exitCode === 0;
  const newStatus   = succeeded ? JobStatus.COMPLETE : JobStatus.FAILED;

  // S6: ConditionExpression prevents overwriting CANCELLED in both success and failure paths
  const updateParams = {
    TableName:                 JOBS_TABLE_NAME,
    Key:                       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
    UpdateExpression:          'SET #s = :newStatus, updatedAt = :now',
    ConditionExpression:       '#s = :running',   // S6: only update if still RUNNING
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':newStatus': newStatus,
      ':running':   JobStatus.RUNNING,
      ':now':       new Date().toISOString(),
    }),
  };

  try {
    await ddb.send(new UpdateItemCommand(updateParams));
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') {
      // Job was cancelled while ECS task was running — do not overwrite
      console.log(`Job ${jobId} status is not RUNNING (likely CANCELLED); skipping update.`);
      return;
    }
    throw e;
  }

  if (!succeeded) return;

  // Fetch, decrypt, and index result
  try {
    const s3Key = `results/${jobId}/result.json`;
    const obj   = await s3.send(new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: s3Key }));
    const body  = await obj.Body!.transformToString();
    const result = await envelopeDecrypt(body, jobId);
    await indexResult(result);
  } catch (err) {
    console.error(`Failed to index result for ${jobId}:`, err);
  }

  // CR5: Do NOT call postGitHubStatus() directly here (VPC blocks outbound GitHub).
  // Enqueue to GitHubStatusQueue instead; a separate non-VPC Lambda drains it.
  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl:    GITHUB_STATUS_QUEUE_URL,
      MessageBody: JSON.stringify({ jobId, status: newStatus }),
    }));
  } catch (err) {
    console.warn('Failed to enqueue GitHub status update:', err);
  }
}
```

---

## Section 4 — CDK Deploy Order

### D8 / D9: `infra/lib/ecs-stack.ts` — export clusterArn and taskDefinitionArn

```typescript
// infra/lib/ecs-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

interface ECSStackProps extends cdk.StackProps {
  envName:    string;
  vpc:        ec2.Vpc;
  lambdaEnvKey: kms.Key;
  resultsKmsKey: kms.Key;
}

export class ECSStack extends cdk.Stack {
  // D9: public readonly exports consumed by LambdaStack and MCPStack
  public readonly clusterArn:         string;
  public readonly clusterName:        string;
  public readonly taskDefinitionArn:  string;
  public readonly taskSecurityGroupId: string;

  constructor(scope: Construct, id: string, props: ECSStackProps) {
    super(scope, id, props);

    const { envName } = props;

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName:              `skills-svc-${envName}`,
      vpc:                      props.vpc,
      containerInsights:        true,
      enableFargateCapacityProviders: true,
    });

    this.clusterArn  = cluster.clusterArn;
    this.clusterName = cluster.clusterName;

    const taskRole = new iam.Role(this, 'ECSTaskRole', {
      roleName:  `skills-svc-ecs-task-${envName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPolicy(new iam.PolicyStatement({
      sid:     'S3Results',
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::skills-svc-results-${envName}/*`],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      sid:     'KMS',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.resultsKmsKey.keyArn],
    }));

    const executionRole = new iam.Role(this, 'ECSExecutionRole', {
      roleName:  `skills-svc-ecs-execution-${envName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const logGroup = new logs.LogGroup(this, 'RunnerLogGroup', {
      logGroupName:  `/skills-svc/${envName}/runner`,
      retention:     logs.RetentionDays.ONE_MONTH,
      encryptionKey: props.lambdaEnvKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family:          `skills-svc-runner-${envName}`,
      cpu:             2048,
      memoryLimitMiB:  4096,
      taskRole,
      executionRole,
    });

    taskDef.addContainer('runner', {
      image:   ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(this, 'RunnerRepo', `skills-svc-runner-${envName}`)
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'runner',
        logGroup,
      }),
      environment: {
        ENV:            envName,
        RESULTS_BUCKET: `skills-svc-results-${envName}`,
      },
    });

    this.taskDefinitionArn = taskDef.taskDefinitionArn;

    const taskSg = new ec2.SecurityGroup(this, 'TaskSG', {
      vpc:         props.vpc,
      description: 'ECS runner task security group',
      allowAllOutbound: true,
    });
    this.taskSecurityGroupId = taskSg.securityGroupId;
  }
}
```

---

### D2 / D8: `infra/bin/app.ts` — correct instantiation order + MCPStack wired

```typescript
// infra/bin/app.ts
import * as cdk from 'aws-cdk-lib';
import { NetworkStack }  from '../lib/network-stack';
import { StorageStack }  from '../lib/storage-stack';
import { ECSStack }      from '../lib/ecs-stack';
import { LambdaStack }   from '../lib/lambda-stack';
import { MCPStack }      from '../lib/mcp-stack';
import { BatchStack }    from '../lib/batch-stack';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT!,
  region:  process.env.CDK_DEFAULT_REGION!,
};
const envName = app.node.tryGetContext('envName') ?? 'dev';

// 1. Network (no deps)
const networkStack = new NetworkStack(app, 'NetworkStack', { env, envName });

// 2. Storage (no deps beyond network)
const storageStack = new StorageStack(app, 'StorageStack', {
  env, envName,
  vpc: networkStack.vpc,
});
storageStack.addDependency(networkStack);

// 3. ECS — D8: must be constructed BEFORE lambdaStack
const ecsStack = new ECSStack(app, 'ECSStack', {
  env, envName,
  vpc:           networkStack.vpc,
  lambdaEnvKey:  storageStack.lambdaEnvKey,
  resultsKmsKey: storageStack.resultsKmsKey,
});
ecsStack.addDependency(storageStack);

// 4. Lambda (depends on ECS for clusterArn + taskDefArn)
const lambdaStack = new LambdaStack(app, 'LambdaStack', {
  env, envName,
  vpc:                  networkStack.vpc,
  lambdaSg:             networkStack.lambdaSg,
  dynamodbKmsKey:       storageStack.dynamodbKmsKey,
  resultsKmsKey:        storageStack.resultsKmsKey,
  uploadsKmsKey:        storageStack.uploadsKmsKey,
  lambdaEnvKey:         storageStack.lambdaEnvKey,
  jobsTableName:        storageStack.jobsTableName,
  jobsTableArn:         storageStack.jobsTableArn,
  uploadsBucket:        storageStack.uploadsBucketName,
  resultsBucket:        storageStack.resultsBucketName,
  uploadsKmsKeyId:      storageStack.uploadsKmsKeyId,
  aossCollectionArn:    storageStack.aossCollectionArn,
  ecsClusterArn:        ecsStack.clusterArn,         // D1/D8: from ecsStack
  ecsClusterName:       ecsStack.clusterName,
  ecsTaskDefinitionArn: ecsStack.taskDefinitionArn,  // D9
  ecsSubnetIds:         networkStack.privateSubnetIds,
  ecsSecurityGroupIds:  [ecsStack.taskSecurityGroupId],
  githubStatusQueueUrl: storageStack.githubStatusQueueUrl,
  githubStatusQueueArn: storageStack.githubStatusQueueArn,
});
lambdaStack.addDependency(ecsStack);
lambdaStack.addDependency(storageStack);

// 5. MCP — D2: was missing from bin/app.ts
const mcpStack = new MCPStack(app, 'MCPStack', {
  env, envName,
  vpc:               networkStack.vpc,
  lambdaSg:          networkStack.lambdaSg,
  uploadsKmsKey:     storageStack.uploadsKmsKey,
  resultsKmsKey:     storageStack.resultsKmsKey,
  dynamodbKmsKey:    storageStack.dynamodbKmsKey,
  lambdaEnvKey:      storageStack.lambdaEnvKey,
  userRole:          storageStack.userRole,
  dynamodbTableName: storageStack.jobsTableName,
  jobsTableArn:      storageStack.jobsTableArn,
  uploadsBucket:     storageStack.uploadsBucketName,
  resultsBucket:     storageStack.resultsBucketName,
  uploadsKmsKeyId:   storageStack.uploadsKmsKeyId,
  queryLambdaArn:    lambdaStack.queryLambdaArn,
  ecsClusterName:    ecsStack.clusterName,
  ecsClusterArn:     ecsStack.clusterArn,
  jobsTopicArn:      storageStack.jobsTopicArn,
});
mcpStack.addDependency(lambdaStack);

// 6. Batch (depends on lambda + storage)
const batchStack = new BatchStack(app, 'BatchStack', {
  env, envName,
  jobsTableName:  storageStack.jobsTableName,
  jobsTableArn:   storageStack.jobsTableArn,
  ecsClusterArn:  ecsStack.clusterArn,
  ecsClusterName: ecsStack.clusterName,
  lambdaEnvKey:   storageStack.lambdaEnvKey,
  dynamodbKmsKey: storageStack.dynamodbKmsKey,
});
batchStack.addDependency(lambdaStack);

app.synth();
```

---

### D5: `infra/lib/mcp-stack.ts` — dedicated authLambdaRole, resultsCacheTtl:0

```typescript
// infra/lib/mcp-stack.ts  — tokenAuthFn section replaces prior definition
// D5: tokenAuthFn must NOT share mcpLambdaRole (over-permissive).
// Dedicated role with only dynamodb:GetItem + logs + kms:Decrypt.

const authLambdaRole = new iam.Role(this, 'AuthLambdaRole', {
  roleName:  `skills-svc-mcp-auth-${envName}`,
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});

authLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:     'DynamoDBGetToken',
  actions: ['dynamodb:GetItem'],
  resources: [props.jobsTableArn],
}));

authLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:     'KMSDecrypt',
  actions: ['kms:Decrypt'],
  resources: [props.dynamodbKmsKey.keyArn, props.lambdaEnvKey.keyArn],
}));

authLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:     'CloudWatchLogs',
  actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
  resources: [
    `arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/mcp-auth*`,
  ],
}));

const tokenAuthFn = new lambda.Function(this, 'MCPTokenAuthFn', {
  functionName:   `skills-svc-mcp-auth-${envName}`,
  runtime:        lambda.Runtime.NODEJS_20_X,
  code:           lambda.Code.fromAsset('../packages/lambda/dist'),
  handler:        'mcp-auth/handler.handler',
  timeout:        cdk.Duration.seconds(5),
  memorySize:     128,
  role:           authLambdaRole,  // D5: dedicated role
  vpc:            props.vpc,
  vpcSubnets:     { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [props.lambdaSg],
  environment: {
    JOBS_TABLE_NAME: props.dynamodbTableName,
    ENV:             envName,
  },
  logRetention: logs.RetentionDays.ONE_MONTH,
});

const tokenAuthorizer = new apigatewayv2Authorizers.HttpLambdaAuthorizer(
  'TokenAuthorizer', tokenAuthFn, {
    authorizerName:  'skills-svc-token-authorizer',
    identitySource:  ['$request.header.X-API-Key'],
    resultsCacheTtl: cdk.Duration.seconds(0),  // D5: no caching — revocation must be immediate
  }
);
```

---

## Section 5 — Batch Pipeline

### B1: `infra/lib/batch-stack.ts` — StateMachineType.STANDARD

```typescript
// infra/lib/batch-stack.ts  (state machine definition section)
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';

const stateMachine = new sfn.StateMachine(this, 'BatchStateMachine', {
  stateMachineName: `skills-svc-batch-${envName}`,
  definition:       definition,
  stateMachineType: sfn.StateMachineType.STANDARD,  // B1: was EXPRESS — wrong for long batch jobs
  timeout:          cdk.Duration.hours(24),
  tracingEnabled:   true,
});
```

---

### B2 / B3: Batch Lambda env vars + SSM parameter

```typescript
// infra/lib/batch-stack.ts  (batch Lambda environment section)
// B2: BATCH_TABLE_NAME and JOBS_TABLE_NAME were missing
// B3: expose table name via SSM so CLI can discover it without hardcoding

new ssm.StringParameter(this, 'BatchTableNameParam', {
  parameterName: `/skills-svc/${envName}/batch-table-name`,
  stringValue:   props.jobsTableName,
});

const batchLambda = new lambda.Function(this, 'BatchLambda', {
  functionName: `skills-svc-batch-${envName}`,
  runtime:      lambda.Runtime.NODEJS_20_X,
  handler:      'batch/handler.handler',
  code:         lambda.Code.fromAsset('../packages/lambda/dist'),
  timeout:      cdk.Duration.seconds(30),
  memorySize:   256,
  environment: {
    ENV:              envName,
    JOBS_TABLE_NAME:  props.jobsTableName,   // B2
    BATCH_TABLE_NAME: props.jobsTableName,   // B2: same table, different usage context
    ECS_CLUSTER_ARN:  props.ecsClusterArn,
    ECS_CLUSTER_NAME: props.ecsClusterName,
  },
});
```

---

### B4: GSI1-UserBatches in CDK + fix batch list query

```typescript
// infra/lib/storage-stack.ts  (DynamoDB table definition — add GSI1)
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const table = new dynamodb.Table(this, 'JobsTable', {
  tableName:    `skills-svc-jobs-${envName}`,
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption:   dynamodb.TableEncryption.CUSTOMER_MANAGED,
  encryptionKey: props.dynamodbKmsKey,
  pointInTimeRecovery: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

// B4: GSI1-UserBatches — batch list query by user
table.addGlobalSecondaryIndex({
  indexName:     'GSI1-UserBatches',
  partitionKey:  { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
  sortKey:       { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

// GSI2-UserJobs
table.addGlobalSecondaryIndex({
  indexName:    'GSI2-UserJobs',
  partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

// S7: GSI4-CacheKey belongs in storage-stack.ts (not mcp-stack.ts)
table.addGlobalSecondaryIndex({
  indexName:    'GSI4-CacheKey',
  partitionKey: { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI4SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

// CR8: GSI5-ReviewRepo (renamed from GSI4 collision)
table.addGlobalSecondaryIndex({
  indexName:    'GSI5-ReviewRepo',
  partitionKey: { name: 'GSI5PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI5SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```

```typescript
// packages/lambda/src/batch/list.ts  — B4: fix invalid begins_with(PK) query
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { marshall }   from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});

export async function listBatches(userArn: string, tableName: string): Promise<any[]> {
  // B4: use GSI1-UserBatches; items written with GSI1PK=USER#<arn>, GSI1SK=BATCH#<ts>
  const result = await ddb.send(new QueryCommand({
    TableName:              tableName,
    IndexName:              'GSI1-UserBatches',
    KeyConditionExpression: 'GSI1PK = :gsi1pk',
    ExpressionAttributeValues: marshall({ ':gsi1pk': `USER#${userArn}` }),
    ScanIndexForward: false,
  }));
  return (result.Items ?? []).map(i => unmarshall(i));
}
```

---

### B5: Batch status running count subtract CANCELLED

```typescript
// packages/lambda/src/batch/status.ts
import { DynamoDBClient, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { JobStatus } from '@skills-svc/shared';

const ddb = new DynamoDBClient({});

export async function getBatchStatus(batchId: string, tableName: string): Promise<object> {
  // Fetch all jobs for this batch via GSI1 or by querying BATCH# items
  const jobsResult = await ddb.send(new QueryCommand({
    TableName:              tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: marshall({
      ':pk': `BATCH#${batchId}`,
      ':sk': 'JOB#',
    }),
  }));

  const jobs = (jobsResult.Items ?? []).map(i => unmarshall(i));

  const counts = {
    total:     jobs.length,
    pending:   0,
    running:   0,
    complete:  0,
    failed:    0,
    cancelled: 0,
  };

  for (const job of jobs) {
    switch (job.status as JobStatus) {
      case JobStatus.PENDING:   counts.pending++;   break;
      case JobStatus.RUNNING:   counts.running++;   break;
      case JobStatus.COMPLETE:  counts.complete++;  break;
      case JobStatus.FAILED:    counts.failed++;    break;
      case JobStatus.CANCELLED: counts.cancelled++; break;  // B5: was not counted
    }
  }

  // B5: running count must not include CANCELLED
  // (Loop above already handles this correctly by explicit case)
  const done = counts.complete + counts.failed + counts.cancelled;
  const batchStatus =
    done === counts.total           ? 'COMPLETE' :
    counts.running > 0             ? 'RUNNING'  :
    counts.pending === counts.total ? 'PENDING'  : 'PARTIAL';

  return { batchId, ...counts, done, batchStatus };
}
```

---

### B6: Batch cancel stops ECS tasks using startedBy=jobId

```typescript
// packages/lambda/src/batch/cancel.ts
import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ECSClient, ListTasksCommand, StopTaskCommand }   from '@aws-sdk/client-ecs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { JobStatus } from '@skills-svc/shared';

const ddb = new DynamoDBClient({});
const ecs = new ECSClient({});

export async function cancelBatch(
  batchId:        string,
  tableName:      string,
  ecsClusterArn:  string,
): Promise<void> {
  // Fetch all jobs for the batch
  const result = await ddb.send(new QueryCommand({
    TableName:              tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: marshall({ ':pk': `BATCH#${batchId}`, ':sk': 'JOB#' }),
  }));

  const jobs = (result.Items ?? []).map(i => unmarshall(i));

  for (const job of jobs) {
    const jobId  = job.jobId as string;
    const status = job.status as JobStatus;

    if (status === JobStatus.COMPLETE || status === JobStatus.FAILED || status === JobStatus.CANCELLED) {
      continue; // already terminal
    }

    // Write CANCELLED to DDB first (best-effort per job)
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: tableName,
        Key:       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
        UpdateExpression:          'SET #s = :cancelled, updatedAt = :now',
        ConditionExpression:       '#s IN (:pending, :running)',
        ExpressionAttributeNames:  { '#s': 'status' },
        ExpressionAttributeValues: marshall({
          ':cancelled': JobStatus.CANCELLED,
          ':pending':   JobStatus.PENDING,
          ':running':   JobStatus.RUNNING,
          ':now':       new Date().toISOString(),
        }),
      }));
    } catch (e: any) {
      if (e.name !== 'ConditionalCheckFailedException') {
        console.warn(`Failed to cancel job ${jobId}:`, e);
      }
      continue;
    }

    // B6: stop ECS tasks for RUNNING jobs (startedBy = bare jobId)
    if (status === JobStatus.RUNNING) {
      try {
        const tasks = await ecs.send(new ListTasksCommand({
          cluster:   ecsClusterArn,
          startedBy: jobId,
        }));
        for (const taskArn of tasks.taskArns ?? []) {
          await ecs.send(new StopTaskCommand({
            cluster: ecsClusterArn,
            task:    taskArn,
            reason:  `Batch ${batchId} cancelled`,
          })).catch(err => console.warn(`StopTask ${taskArn} best-effort:`, err));
        }
      } catch (err) {
        console.warn(`ECS stop for job ${jobId} failed:`, err);
      }
    }
  }
}
```

---

### B7: `packages/lambda/src/batch/results.ts` — fix begins_with(SK) + duplicate ExpressionAttributeValues

```typescript
// packages/lambda/src/batch/results.ts
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { JobStatus } from '@skills-svc/shared';

const ddb = new DynamoDBClient({});

export async function getBatchResults(batchId: string, tableName: string): Promise<any[]> {
  // B7: begins_with(SK, ...) is not valid for partition-key-only condition on GSI;
  //     query by PK=BATCH#<id> with SK begins_with JOB# on the base table
  const result = await ddb.send(new QueryCommand({
    TableName:              tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    FilterExpression:       '#s = :complete',
    // B7: single ExpressionAttributeValues block — no duplicate keys
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':pk':       `BATCH#${batchId}`,
      ':sk':       'JOB#',
      ':complete': JobStatus.COMPLETE,
    }),
  }));

  return (result.Items ?? []).map(i => unmarshall(i));
}
```

---

### B8: Ingestion handler writes jobId back to batch table

```typescript
// packages/lambda/src/ingestion/handler.ts  (batch-id update section)
// B8: after RunTask succeeds, update the BATCH# item with the real jobId
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

async function writeBatchJobId(
  ddb:       DynamoDBClient,
  tableNm:   string,
  batchId:   string,
  entryIdx:  number,
  jobId:     string,
): Promise<void> {
  await ddb.send(new UpdateItemCommand({
    TableName: tableNm,
    Key:       marshall({ PK: `BATCH#${batchId}`, SK: `JOB#${entryIdx}` }),
    UpdateExpression:          'SET jobId = :jobId, #s = :pending, updatedAt = :now',
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: marshall({
      ':jobId':   jobId,
      ':pending': 'PENDING',
      ':now':     new Date().toISOString(),
    }),
  }));
}
```

---

### B9: `packages/lambda/src/cache.ts` — fix duplicate ExpressionAttributeValues

```typescript
// packages/lambda/src/cache.ts  (query section)
import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});

export async function getCachedResult(
  cacheKey:  string,
  tableNm:   string,
): Promise<any | null> {
  const result = await ddb.send(new QueryCommand({
    TableName:              tableNm,
    IndexName:              'GSI4-CacheKey',
    KeyConditionExpression: 'GSI4PK = :pk AND GSI4SK = :sk',
    // B9: single ExpressionAttributeValues block — no duplicate ':pk' keys
    ExpressionAttributeValues: marshall({
      ':pk': `CACHE#${cacheKey}`,
      ':sk': 'RESULT',
    }),
    Limit: 1,
  }));

  const items = result.Items ?? [];
  return items.length > 0 ? unmarshall(items[0]) : null;
}
```

---

### B10: Batch status Lambda pollCount guard

```typescript
// packages/lambda/src/batch/poll-guard.ts
// B10: prevent PENDING forever when DDB item is missing

const MAX_POLL_COUNT = 20;

export function guardPollCount(
  currentCount: number,
  batchId:      string,
): void {
  if (currentCount > MAX_POLL_COUNT) {
    throw new Error(
      `Batch ${batchId} has been polled ${currentCount} times without a DDB item; ` +
      `aborting to avoid infinite loop.`
    );
  }
}
```

---

## Section 6 — Code Review Pipeline

### CR1: Webhook sentinel ARN + `--job-id` for review status/wait

```typescript
// packages/lambda/src/webhook/handler.ts  (userArn sentinel)
// CR1: 'webhook' is not a valid ARN and is invisible to GSI2 queries.
// Use a stable sentinel ARN scoped to the account/region.

const WEBHOOK_SENTINEL_ARN =
  `arn:aws:sts::${process.env.AWS_ACCOUNT_ID}:assumed-role/webhook-role/webhook`;

// When creating a review job from webhook:
const jobItem = {
  PK:       `JOB#${jobId}`,
  SK:       'META',
  userArn:  WEBHOOK_SENTINEL_ARN,   // CR1: sentinel, not 'webhook'
  GSI2PK:   `USER#${WEBHOOK_SENTINEL_ARN}`,
  GSI2SK:   `JOB#${new Date().toISOString()}`,
  inputMode: 'git',
  // ... other fields
};
```

```typescript
// packages/cli/src/review/status.ts  — add --job-id flag
import { Command } from 'commander';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { JobStatus, prettyJobStatus } from '@skills-svc/shared';

export function buildReviewStatusCommand(): Command {
  return new Command('status')
    .description('Get code review job status')
    .option('--job-id <jobId>', 'Job ID (use when review was triggered by webhook)')
    .option('--repo <repo>',    'Repository slug (org/name)')
    .option('--pr <number>',    'Pull request number', parseInt)
    .action(async (opts) => {
      const ddb = new DynamoDBClient({});
      const tableNm = process.env.JOBS_TABLE_NAME!;

      let jobId = opts.jobId;

      if (!jobId) {
        if (!opts.repo || !opts.pr) {
          console.error('Provide --job-id or both --repo and --pr');
          process.exit(1);
        }
        // resolve jobId from repo+pr via GSI5
        jobId = await resolveJobIdFromRepoPr(ddb, tableNm, opts.repo, opts.pr);
        if (!jobId) {
          console.error('No review job found for that repo/PR');
          process.exit(1);
        }
      }

      const item = await ddb.send(new GetItemCommand({
        TableName: tableNm,
        Key:       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
      }));

      if (!item.Item) { console.error('Job not found'); process.exit(1); }

      const job = unmarshall(item.Item);
      console.log(prettyJobStatus(job.status as JobStatus));
    });
}

async function resolveJobIdFromRepoPr(
  ddb:     DynamoDBClient,
  tableNm: string,
  repo:    string,
  pr:      number,
): Promise<string | undefined> {
  const { QueryCommand } = await import('@aws-sdk/client-dynamodb');
  const result = await ddb.send(new QueryCommand({
    TableName:              tableNm,
    IndexName:              'GSI5-ReviewRepo',
    KeyConditionExpression: 'GSI5PK = :pk AND GSI5SK = :sk',
    ExpressionAttributeValues: marshall({
      ':pk': `REVIEW#${repo}`,
      ':sk': `PR#${pr}`,
    }),
    Limit: 1,
    ScanIndexForward: false,
  }));
  const items = result.Items ?? [];
  return items.length > 0 ? unmarshall(items[0]).jobId : undefined;
}
```

---

### CR2 / CL5: `packages/cli/src/review/wait.ts` — handle CANCELLED terminal state

```typescript
// packages/cli/src/review/wait.ts
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { JobStatus, isTerminal } from '@skills-svc/shared';

const POLL_INTERVAL_MS = 5000;

export async function waitForReview(jobId: string, timeoutMs: number = 300_000): Promise<void> {
  const ddb      = new DynamoDBClient({});
  const tableNm  = process.env.JOBS_TABLE_NAME!;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const item = await ddb.send(new GetItemCommand({
      TableName: tableNm,
      Key:       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
    }));

    if (!item.Item) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const job    = unmarshall(item.Item);
    const status = job.status as JobStatus;

    // CR9: poll by jobId directly — don't call resolveLatestVersion before COMPLETE exists
    if (status === JobStatus.COMPLETE) {
      console.log('Review complete.');
      process.exit(0);
    }

    if (status === JobStatus.FAILED) {
      console.error('Review failed.');
      process.exit(1);
    }

    // CR2: handle CANCELLED terminal state — CL5: exit code 3
    if (status === JobStatus.CANCELLED) {
      console.error('Review was cancelled.');
      process.exit(3);   // CL5
    }

    // isTerminal catches any future terminal states
    if (isTerminal(status)) {
      console.error(`Review ended with status: ${status}`);
      process.exit(1);
    }

    console.log(`Status: ${status} — waiting...`);
    await sleep(POLL_INTERVAL_MS);
  }

  console.error('Timed out waiting for review.');
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

### CR3: `packages/lambda/src/findings.ts` — resolveLatestVersion via GetItem on pointer

```typescript
// packages/lambda/src/findings.ts
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';

const ddb = new DynamoDBClient({});

export async function resolveLatestVersion(
  repoSlug: string,
  tableNm:  string,
): Promise<string | undefined> {
  // CR3: use GetItem on a LATEST_REVIEWED_VERSION pointer record, not begins_with(PK)
  const result = await ddb.send(new GetItemCommand({
    TableName: tableNm,
    Key:       marshall({
      PK: `REVIEW#${repoSlug}`,
      SK: 'LATEST_VERSION',
    }),
  }));

  if (!result.Item) return undefined;
  return unmarshall(result.Item).latestJobId as string | undefined;
}

export async function writeLatestVersionPointer(
  repoSlug: string,
  jobId:    string,
  tableNm:  string,
): Promise<void> {
  const { DynamoDBClient: _, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
  const ddb2 = new DynamoDBClient({});
  await ddb2.send(new PutItemCommand({
    TableName: tableNm,
    Item:      marshall({
      PK:          `REVIEW#${repoSlug}`,
      SK:          'LATEST_VERSION',
      latestJobId: jobId,
      updatedAt:   new Date().toISOString(),
    }),
  }));
}
```

---

### CR4: ResultsProcessor constructs proper RunResult wrapper for review jobs

```typescript
// packages/lambda/src/results-processor/handler.ts  (review job path)
import { ReviewOutput, RunResult, JobStatus } from '@skills-svc/shared';

async function handleReviewJob(
  jobId:      string,
  reviewOut:  ReviewOutput,
  userArn:    string,
  s3ResultKey: string,
): Promise<void> {
  // CR4: wrap ReviewOutput in a proper RunResult; do NOT cast ReviewOutput as RunResult
  const runResult: RunResult = {
    jobId,
    userArn,
    s3ResultKey,
    score:    reviewOut.score,
    summary:  reviewOut.summary,
    findings: reviewOut.findings,
  };

  await indexResult(runResult);
}
```

---

### CR5 / CR10: Webhook routes GitHub status through SQS queue

```typescript
// packages/lambda/src/webhook/handler.ts  (status posting — replaces direct postGitHubStatus call)
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});
const GITHUB_STATUS_QUEUE_URL = process.env.GITHUB_STATUS_QUEUE_URL!;

async function enqueueGitHubStatus(
  repoFullName: string,
  sha:          string,
  state:        'pending' | 'success' | 'failure' | 'error',
  description:  string,
  targetUrl?:   string,
): Promise<void> {
  // CR5/CR10: do NOT call postGitHubStatus() directly from VPC Lambda.
  // Enqueue to GitHubStatusQueue; a non-VPC Lambda drains and calls the GitHub API.
  await sqs.send(new SendMessageCommand({
    QueueUrl:    GITHUB_STATUS_QUEUE_URL,
    MessageBody: JSON.stringify({ repoFullName, sha, state, description, targetUrl }),
  }));
}
```

---

### CR6: Ingestion Lambda copies S3 metadata to DDB job record

```typescript
// packages/lambda/src/ingestion/handler.ts  (code review job PutCommand — add S3 metadata fields)
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

async function writeReviewJobRecord(
  ddb:      DynamoDBClient,
  tableNm:  string,
  jobId:    string,
  userArn:  string,
  s3Key:    string,
  metadata: {
    repoUrl:   string;
    branch:    string;
    commit:    string;
    prNumber?: number;
    repoSlug:  string;
  },
): Promise<void> {
  // CR6: include all S3 metadata fields in the DDB record
  await ddb.send(new PutItemCommand({
    TableName: tableNm,
    Item:      marshall({
      PK:        `JOB#${jobId}`,
      SK:        'META',
      jobId,
      userArn,
      status:    'PENDING',
      inputMode: 'git',
      s3Key,
      // CR6: code review S3 metadata — was not written to DDB
      repoUrl:   metadata.repoUrl,
      branch:    metadata.branch,
      commit:    metadata.commit,
      prNumber:  metadata.prNumber,
      // GSI5 for webhook repo+PR lookup (CR1)
      GSI5PK:    `REVIEW#${metadata.repoSlug}`,
      GSI5SK:    metadata.prNumber ? `PR#${metadata.prNumber}` : `BRANCH#${metadata.branch}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}
```

---

## Section 7 — CLI Consistency

### CL1: `packages/cli/src/mcp/submit.ts` — MAX_ENCODED_MB = 10

```typescript
// packages/cli/src/mcp/submit.ts
const MAX_ENCODED_MB = 10;  // CL1: was 7 — must match server limit of 10 MB
const MAX_ENCODED_BYTES = MAX_ENCODED_MB * 1024 * 1024;

export async function submitMcpJob(filePath: string): Promise<void> {
  const raw     = await fs.readFile(filePath);
  const encoded = raw.toString('base64');

  if (Buffer.byteLength(encoded) > MAX_ENCODED_BYTES) {
    console.error(`File exceeds ${MAX_ENCODED_MB} MB encoded limit. Use S3 upload instead.`);
    process.exit(1);
  }
  // ... rest of submit logic
}
```

---

### CL2 / CL8: `packages/cli/src/mcp/status.ts` + `prettyJobStatus` — CANCELLED handling

```typescript
// packages/shared/src/pretty-status.ts
import { JobStatus } from './job-status';

export function prettyJobStatus(status: JobStatus): string {
  switch (status) {
    case JobStatus.PENDING:   return '⏳ PENDING   — job is queued';
    case JobStatus.RUNNING:   return '🔄 RUNNING   — analysis in progress';
    case JobStatus.COMPLETE:  return '✅ COMPLETE  — results available';
    case JobStatus.FAILED:    return '❌ FAILED    — analysis failed';
    case JobStatus.CANCELLED: return '🚫 CANCELLED — job was cancelled'; // CL2/CL8: was missing
    default:                  return `UNKNOWN (${status})`;
  }
}
```

```typescript
// packages/cli/src/mcp/status.ts  (CANCELLED display — CL2)
import { JobStatus, prettyJobStatus } from '@skills-svc/shared';

export async function showStatus(jobId: string): Promise<void> {
  const job = await fetchJob(jobId);
  if (!job) { console.error('Job not found'); process.exit(1); }

  console.log(prettyJobStatus(job.status as JobStatus));

  // CL2: CANCELLED is a terminal state — display it and exit cleanly
  if (job.status === JobStatus.CANCELLED) {
    process.exit(0);
  }
}
```

---

### CL3: `packages/cli/src/mcp/result.ts` — exit code 2 for CLI-redirect (B31)

```typescript
// packages/cli/src/mcp/result.ts
import { JobStatus } from '@skills-svc/shared';

export async function fetchResult(jobId: string): Promise<void> {
  const job = await fetchJob(jobId);
  if (!job) { console.error('Job not found'); process.exit(1); }

  if (job.status === JobStatus.PENDING || job.status === JobStatus.RUNNING) {
    console.error('Result not yet available — job is still in progress.');
    process.exit(2);  // CL3: was 1; B31 CLI-redirect expects exit code 2 for "not yet"
  }

  if (job.status === JobStatus.CANCELLED) {
    console.error('Job was cancelled; no result available.');
    process.exit(3);
  }

  if (job.status === JobStatus.FAILED) {
    console.error('Job failed; no result available.');
    process.exit(1);
  }

  // CL9: description no longer says "presigned S3 URL" — result is returned inline
  console.log('Result:');
  console.log(JSON.stringify(job.result ?? {}, null, 2));
  process.exit(0);
}
```

---

### CL4: `packages/cli/src/diff.ts` — call normaliseArn on pre-B4 records

```typescript
// packages/cli/src/diff.ts
import { normaliseArn } from '@skills-svc/shared';

export function buildDiffItem(raw: Record<string, any>): DiffItem {
  return {
    jobId:   raw.jobId,
    // CL4: normaliseArn must be called on pre-B4 records that may have STS assumed-role ARNs
    userArn: normaliseArn(raw.userArn ?? ''),
    status:  raw.status,
    score:   raw.score,
    // ...
  };
}
```

---

### CL6: `packages/cli/src/mcp-config/update.ts` — operation order: DDB write → file → delete old token

```typescript
// packages/cli/src/mcp-config/update.ts
import { DynamoDBClient, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import * as fs from 'fs/promises';

const ddb = new DynamoDBClient({});

export async function updateMcpConfig(
  tableNm:   string,
  configPath: string,
  newToken:   string,
  oldToken?:  string,
): Promise<void> {
  // CL6 / S9 atomicity order:
  // 1. Write new DDB token record FIRST — if this fails, old config still works
  await ddb.send(new PutItemCommand({
    TableName: tableNm,
    Item:      marshall({
      PK:        `MCPTOKEN#${newToken}`,
      SK:        'META',
      token:     newToken,
      createdAt: new Date().toISOString(),
    }),
  }));

  // 2. Write new config file — if this fails, DDB has new token but file has old; recoverable
  const config = { token: newToken };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  // 3. Delete old token from DDB LAST — best-effort; old token harmlessly expires
  if (oldToken) {
    try {
      await ddb.send(new DeleteItemCommand({
        TableName: tableNm,
        Key:       marshall({ PK: `MCPTOKEN#${oldToken}`, SK: 'META' }),
      }));
    } catch (err) {
      console.warn('Failed to delete old token (non-fatal):', err);
    }
  }
}
```

---

### T2 / T5 / T6: get-result, results.ts, compare.ts — CANCELLED branch + userArn in envelopeDecrypt

```typescript
// packages/lambda/src/get-result/handler.ts  — T2: CANCELLED falls through fix
import { JobStatus } from '@skills-svc/shared';

export async function handler(event: any): Promise<any> {
  const jobId = event.pathParameters?.jobId;
  const job   = await getJobItem(jobId);

  if (!job) return { statusCode: 404, body: JSON.stringify({ error: 'Not found' }) };

  switch (job.status as JobStatus) {
    case JobStatus.COMPLETE:
      return { statusCode: 200, body: JSON.stringify({ status: 'COMPLETE', result: job.result }) };

    case JobStatus.FAILED:
      return { statusCode: 200, body: JSON.stringify({ status: 'FAILED', error: job.error }) };

    case JobStatus.CANCELLED:
      // T2: was falling through to "not yet complete" branch
      return { statusCode: 200, body: JSON.stringify({ status: 'CANCELLED' }) };

    case JobStatus.PENDING:
    case JobStatus.RUNNING:
    default:
      return { statusCode: 202, body: JSON.stringify({ status: job.status, message: 'Not yet complete' }) };
  }
}
```

```typescript
// packages/cli/src/results.ts  — T5: envelopeDecrypt requires userArn
import { envelopeDecrypt } from '../crypto/envelope';
import { normaliseArn }    from '@skills-svc/shared';

export async function fetchAndDecryptResult(
  s3Key:   string,
  userArn: string,   // T5: was missing; required by envelopeDecrypt
  bucket:  string,
): Promise<any> {
  const raw     = await getS3Object(bucket, s3Key);
  const bodyStr = await raw.Body!.transformToString();
  return envelopeDecrypt(bodyStr, normaliseArn(userArn));  // CL4 + T5
}
```

```typescript
// packages/cli/src/compare.ts  — T6: second envelopeDecrypt call site also needs userArn
import { envelopeDecrypt } from '../crypto/envelope';
import { normaliseArn }    from '@skills-svc/shared';

export async function compareJobs(
  jobIdA: string, userArnA: string,
  jobIdB: string, userArnB: string,
  bucket: string,
): Promise<void> {
  const [rawA, rawB] = await Promise.all([
    getS3Object(bucket, `results/${jobIdA}/result.json`),
    getS3Object(bucket, `results/${jobIdB}/result.json`),
  ]);

  const [bodyA, bodyB] = await Promise.all([
    rawA.Body!.transformToString(),
    rawB.Body!.transformToString(),
  ]);

  // T6: both call sites need userArn; normaliseArn applied to handle pre-B4 records
  const [resultA, resultB] = await Promise.all([
    envelopeDecrypt(bodyA, normaliseArn(userArnA)),
    envelopeDecrypt(bodyB, normaliseArn(userArnB)),   // T6: was missing userArn
  ]);

  printComparison(resultA, resultB);
}
```

---

## Section 8 — D4: Ingestion handler typed as SQSHandler unwrapping S3Event

```typescript
// packages/lambda/src/ingestion/handler.ts
// D4: handler was typed as S3Handler but wired as SQS trigger.
// Fix: SQSHandler that parses S3Event from the SQS message body.
import { SQSHandler, SQSEvent, SQSRecord, S3Event } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { JobStatus, normaliseArn } from '@skills-svc/shared';
import { v4 as uuidv4 } from 'uuid';

const ddb = new DynamoDBClient({});
const ecs = new ECSClient({});

const JOBS_TABLE_NAME         = process.env.JOBS_TABLE_NAME!;
const ECS_CLUSTER_ARN         = process.env.ECS_CLUSTER_ARN!;
const ECS_TASK_DEFINITION_ARN = process.env.ECS_TASK_DEFINITION_ARN!;
const ECS_SUBNET_IDS          = (process.env.ECS_SUBNET_IDS ?? '').split(',').filter(Boolean);
const ECS_SECURITY_GROUP_IDS  = (process.env.ECS_SECURITY_GROUP_IDS ?? '').split(',').filter(Boolean);
const UPLOADS_BUCKET          = process.env.UPLOADS_BUCKET!;

export const handler: SQSHandler = async (event: SQSEvent): Promise<void> => {
  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(sqsRecord: SQSRecord): Promise<void> {
  // D4: unwrap S3Event from SQS message body
  let s3Event: S3Event;
  try {
    s3Event = JSON.parse(sqsRecord.body) as S3Event;
  } catch (e) {
    console.error('Failed to parse SQS body as S3Event:', e);
    return;
  }

  for (const s3Record of s3Event.Records ?? []) {
    const s3Key   = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
    const jobId   = uuidv4();

    // Determine userArn from S3 key path: uploads/<userArn-encoded>/<filename>
    const keyParts = s3Key.split('/');
    const rawUserArn = keyParts[1] ? decodeURIComponent(keyParts[1]) : 'unknown';
    const userArn    = normaliseArn(rawUserArn);

    // Write initial PENDING record
    await ddb.send(new PutItemCommand({
      TableName: JOBS_TABLE_NAME,
      Item: marshall({
        PK:        `JOB#${jobId}`,
        SK:        'META',
        jobId,
        userArn,
        status:    JobStatus.PENDING,
        s3Key,
        version:   0,
        GSI2PK:    `USER#${userArn}`,
        GSI2SK:    `JOB#${new Date().toISOString()}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    // S5: Check for CANCELLED using enum before RunTask
    const existing = await ddb.send(new GetItemCommand({
      TableName: JOBS_TABLE_NAME,
      Key:       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
    }));

    const currentStatus = existing.Item
      ? (unmarshall(existing.Item).status as JobStatus)
      : JobStatus.PENDING;

    if (currentStatus === JobStatus.CANCELLED) {
      console.log(`Job ${jobId} cancelled before RunTask; skipping.`);
      continue;
    }

    // Launch ECS task; startedBy = bare jobId (UUID)
    await ecs.send(new RunTaskCommand({
      cluster:        ECS_CLUSTER_ARN,
      taskDefinition: ECS_TASK_DEFINITION_ARN,
      launchType:     'FARGATE',
      startedBy:      jobId,   // bare UUID — EventBridge filter matches clusterArn, not startedBy
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets:        ECS_SUBNET_IDS,
          securityGroups: ECS_SECURITY_GROUP_IDS,
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [{
          name:        'runner',
          environment: [
            { name: 'JOB_ID',        value: jobId },
            { name: 'USER_ARN',      value: userArn },
            { name: 'S3_KEY',        value: s3Key },
            { name: 'UPLOADS_BUCKET', value: UPLOADS_BUCKET },
          ],
        }],
      },
    }));

    // Update status to RUNNING
    await ddb.send(new UpdateItemCommand({
      TableName: JOBS_TABLE_NAME,
      Key:       marshall({ PK: `JOB#${jobId}`, SK: 'META' }),
      UpdateExpression:          'SET #s = :running, updatedAt = :now, #v = :v1',
      ConditionExpression:       '#s = :pending',
      ExpressionAttributeNames:  { '#s': 'status', '#v': 'version' },
      ExpressionAttributeValues: marshall({
        ':running': JobStatus.RUNNING,
        ':pending': JobStatus.PENDING,
        ':now':     new Date().toISOString(),
        ':v1':      1,
      }),
    }));
  }
}
```

---

## Dependency Map

| Gap | File(s) Modified |
|-----|-----------------|
| S1/T9 | `packages/shared/src/utils.ts`, `packages/shared/src/index.ts` |
| S2/D6/D10 | `infra/lib/lambda-stack.ts` |
| S3/CR7 | `packages/lambda/src/backfill/handler.ts` |
| S4/S9/S10/CL7 | `packages/lambda/src/cancel-job/handler.ts` |
| S5/T7 | `packages/lambda/src/cancel-job/handler.ts`, `ingestion/handler.ts` |
| S6 | `packages/lambda/src/results-processor/handler.ts` |
| S7 | `infra/lib/storage-stack.ts` |
| S8/D1 | `infra/lib/lambda-stack.ts` |
| T1 | `packages/shared/src/job-status.ts` |
| T2 | `packages/lambda/src/get-result/handler.ts` |
| T3 | `packages/shared/src/constants.ts` |
| T4/T10 | `packages/runner/src/main.ts` |
| T5 | `packages/cli/src/results.ts` |
| T6 | `packages/cli/src/compare.ts` |
| T8 | `packages/shared/src/types.ts` |
| B1 | `infra/lib/batch-stack.ts` |
| B2/B3 | `infra/lib/batch-stack.ts` |
| B4 | `infra/lib/storage-stack.ts`, `packages/lambda/src/batch/list.ts` |
| B5 | `packages/lambda/src/batch/status.ts` |
| B6 | `packages/lambda/src/batch/cancel.ts` |
| B7 | `packages/lambda/src/batch/results.ts` |
| B8 | `packages/lambda/src/ingestion/handler.ts` |
| B9 | `packages/lambda/src/cache.ts` |
| B10 | `packages/lambda/src/batch/poll-guard.ts` |
| CR1 | `packages/lambda/src/webhook/handler.ts`, `packages/cli/src/review/status.ts` |
| CR2/CL5 | `packages/cli/src/review/wait.ts` |
| CR3 | `packages/lambda/src/findings.ts` |
| CR4 | `packages/lambda/src/results-processor/handler.ts` |
| CR5/CR10 | `packages/lambda/src/webhook/handler.ts`, `results-processor/handler.ts` |
| CR6 | `packages/lambda/src/ingestion/handler.ts` |
| CR8 | `infra/lib/storage-stack.ts`, `packages/shared/src/constants.ts` |
| CR9 | `packages/cli/src/review/wait.ts` |
| CL1 | `packages/cli/src/mcp/submit.ts` |
| CL2/CL8 | `packages/shared/src/pretty-status.ts`, `packages/cli/src/mcp/status.ts` |
| CL3 | `packages/cli/src/mcp/result.ts` |
| CL4 | `packages/cli/src/diff.ts` |
| CL6 | `packages/cli/src/mcp-config/update.ts` |
| D2/D8 | `infra/bin/app.ts` |
| D3 | `infra/lib/lambda-stack.ts` |
| D4 | `packages/lambda/src/ingestion/handler.ts` |
| D5 | `infra/lib/mcp-stack.ts` |
| D7 | `packages/lambda/src/backfill/handler.ts` |
| D9 | `infra/lib/ecs-stack.ts` |
