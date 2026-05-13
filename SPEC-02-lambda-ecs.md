# Skills as a Service (SaaS) — Specification Part 2: Lambda & ECS Implementation

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | [Part 2: Lambda & ECS] | [Part 3](SPEC-03-knowledge-store-cli.md) | [Part 4](SPEC-04-qa-layers-1-50.md) | [Part 5](SPEC-05-qa-layers-51-100-deployment.md)

---

## 1. StorageStack (`infra/lib/storage-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface StorageStackProps extends cdk.StackProps {
  envName: string;
  uploadsBucketKey: kms.Key;
  resultsBucketKey: kms.Key;
  dynamodbKey: kms.Key;
}

export class StorageStack extends cdk.Stack {
  public readonly uploadsBucket: s3.Bucket;
  public readonly resultsBucket: s3.Bucket;
  public readonly artifactsBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;
  public readonly jobsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { envName, account, region } = { ...props, account: this.account, region: this.region };

    // Access logs bucket — must use SSE-S3 (not KMS) per AWS requirement for server access logs
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      bucketName: `skills-svc-access-logs-${account}-${region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // intentional — AWS restriction for log delivery
      enforceSSL: true,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [{
        id: 'expire-old-logs',
        expiration: cdk.Duration.days(365),
      }],
    });

    const sharedBucketProps = (key: kms.Key, logPrefix: string): s3.BucketProps => ({
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      enforceSSL: true,
      versioned: true,
      serverAccessLogsBucket: this.accessLogsBucket,
      serverAccessLogsPrefix: logPrefix,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [{
        id: 'intelligent-tiering',
        transitions: [{
          storageClass: s3.StorageClass.INTELLIGENT_TIERING,
          transitionAfter: cdk.Duration.days(30),
        }],
        noncurrentVersionExpiration: cdk.Duration.days(90),
        noncurrentVersionTransitions: [{
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(30),
        }],
      }],
    });

    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      bucketName: `skills-svc-uploads-${account}-${region}`,
      ...sharedBucketProps(props.uploadsBucketKey, 'uploads-access-logs/'),
    });

    this.resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      bucketName: `skills-svc-results-${account}-${region}`,
      ...sharedBucketProps(props.resultsBucketKey, 'results-access-logs/'),
    });

    this.artifactsBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `skills-svc-artifacts-${account}-${region}`,
      ...sharedBucketProps(props.uploadsBucketKey, 'artifacts-access-logs/'),
    });

    // DynamoDB Single-Table Design
    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: `skills-svc-jobs-${account}-${region}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dynamodbKey,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI1: query by status
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-Status',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: query by user
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-User',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Write SSM parameters
    new ssm.StringParameter(this, 'ParamTableName', {
      parameterName: `/skills-svc/${envName}/dynamodb/table-name`,
      stringValue: this.jobsTable.tableName,
    });
    new ssm.StringParameter(this, 'ParamUploadsBucket', {
      parameterName: `/skills-svc/${envName}/s3/uploads-bucket`,
      stringValue: this.uploadsBucket.bucketName,
    });
    new ssm.StringParameter(this, 'ParamResultsBucket', {
      parameterName: `/skills-svc/${envName}/s3/results-bucket`,
      stringValue: this.resultsBucket.bucketName,
    });
  }
}
```

---

## 2. MessagingStack (`infra/lib/messaging-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface MessagingStackProps extends cdk.StackProps {
  envName: string;
  messagingKey: kms.Key;
  uploadsBucket: s3.Bucket;
}

export class MessagingStack extends cdk.Stack {
  public readonly ingestionDLQ: sqs.Queue;
  public readonly ingestionQueue: sqs.Queue;
  public readonly resultsDLQ: sqs.Queue;
  public readonly jobsNotificationTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);

    const { envName } = props;

    this.ingestionDLQ = new sqs.Queue(this, 'IngestionDLQ', {
      queueName: `skills-svc-ingestion-dlq-${envName}`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.messagingKey,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.ingestionQueue = new sqs.Queue(this, 'IngestionQueue', {
      queueName: `skills-svc-ingestion-${envName}`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.messagingKey,
      visibilityTimeout: cdk.Duration.seconds(900), // must be >= Lambda timeout (300s)
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.ingestionDLQ,
        maxReceiveCount: 3,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.resultsDLQ = new sqs.Queue(this, 'ResultsDLQ', {
      queueName: `skills-svc-results-dlq-${envName}`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.messagingKey,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.jobsNotificationTopic = new sns.Topic(this, 'JobsNotificationTopic', {
      topicName: `skills-svc-jobs-notifications-${envName}`,
      masterKey: props.messagingKey,
      displayName: 'Skills SaaS Job Notifications',
    });

    // Deny non-TLS publish
    this.jobsNotificationTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyNonSSL',
      effect: iam.Effect.DENY,
      principals: [new iam.StarPrincipal()],
      actions: ['sns:Publish'],
      resources: [this.jobsNotificationTopic.topicArn],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));

    // S3 event notification → SQS (for zip uploads)
    this.ingestionQueue.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowS3Notification',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [this.ingestionQueue.queueArn],
      conditions: {
        ArnLike: { 'aws:SourceArn': props.uploadsBucket.bucketArn },
      },
    }));

    props.uploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.ingestionQueue),
      { prefix: 'uploads/', suffix: '.zip' },
    );

    // SSM params
    new ssm.StringParameter(this, 'ParamTopicArn', {
      parameterName: `/skills-svc/${envName}/sns/jobs-topic-arn`,
      stringValue: this.jobsNotificationTopic.topicArn,
    });
  }
}
```

---

## 3. LambdaStack (`infra/lib/lambda-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface LambdaStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  ingestionQueue: sqs.Queue;
  ingestionDLQ: sqs.Queue;
  resultsDLQ: sqs.Queue;
  jobsNotificationTopic: sns.Topic;
  jobsTable: dynamodb.Table;
  uploadsBucket: s3.Bucket;
  resultsBucket: s3.Bucket;
  ingestionLambdaRole: iam.Role;
  resultsLambdaRole: iam.Role;
  queryLambdaRole: iam.Role;
  lambdaEnvKey: any;
  ecsClusterArn?: string; // populated after ECSStack deploys — wire via SSM
  ecsTaskDefArn?: string;
}

export class LambdaStack extends cdk.Stack {
  public readonly ingestionFn: lambda.Function;
  public readonly resultsProcessorFn: lambda.Function;
  public readonly queryFn: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const { envName } = props;

    const sharedLambdaProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_229_0,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ENV: envName,
        REGION: this.region,
        POWERTOOLS_SERVICE_NAME: 'skills-as-a-service',
        LOG_LEVEL: 'INFO',
      },
    };

    // Ingestion Lambda
    this.ingestionFn = new lambda.Function(this, 'SkillsIngestionLambda', {
      ...sharedLambdaProps,
      functionName: `skills-svc-ingestion-${this.account}`,
      handler: 'ingestion/handler.handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      reservedConcurrentExecutions: 50,
      role: props.ingestionLambdaRole,
      deadLetterQueue: props.ingestionDLQ,
      deadLetterQueueEnabled: true,
      description: 'Validates zip uploads and submits ECS tasks for skill processing',
    });

    this.ingestionFn.addEventSource(new lambdaEventSources.SqsEventSource(props.ingestionQueue, {
      batchSize: 1,
      maxBatchingWindow: cdk.Duration.seconds(0),
      reportBatchItemFailures: true,
    }));

    // Results Processor Lambda
    this.resultsProcessorFn = new lambda.Function(this, 'ResultsProcessorLambda', {
      ...sharedLambdaProps,
      functionName: `skills-svc-results-${this.account}`,
      handler: 'results-processor/handler.handler',
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      reservedConcurrentExecutions: 20,
      role: props.resultsLambdaRole,
      deadLetterQueue: props.resultsDLQ,
      deadLetterQueueEnabled: true,
      description: 'Indexes ECS task results into OpenSearch and sends SNS notifications',
    });

    // EventBridge rule: ECS task state change → ResultsProcessorLambda
    const ecsStoppedRule = new events.Rule(this, 'EcsTaskStoppedRule', {
      ruleName: `skills-svc-ecs-task-stopped-${envName}`,
      description: 'Triggers results processing when ECS skills runner task stops',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          lastStatus: ['STOPPED'],
          // Filter by startedBy prefix to only catch our tasks
          startedBy: [{ prefix: 'skills-svc-ingestion-' }],
        },
      },
    });

    ecsStoppedRule.addTarget(new eventsTargets.LambdaFunction(this.resultsProcessorFn, {
      deadLetterQueue: props.resultsDLQ,
      maxEventAge: cdk.Duration.hours(2),
      retryAttempts: 2,
    }));

    // Query Lambda — invoked by CLI users via Lambda:InvokeFunction
    this.queryFn = new lambda.Function(this, 'QueryLambda', {
      ...sharedLambdaProps,
      functionName: `skills-svc-query-${this.account}`,
      handler: 'query/handler.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      reservedConcurrentExecutions: 100,
      role: props.queryLambdaRole,
      description: 'Performs hybrid knn+BM25 query against OpenSearch knowledge store',
    });

    // SSM params
    new ssm.StringParameter(this, 'ParamQueryFnArn', {
      parameterName: `/skills-svc/${envName}/lambda/query-function-arn`,
      stringValue: this.queryFn.functionArn,
    });
  }
}
```

---

## 4. Lambda Handler Implementations

### 4.1 `packages/lambda/src/ingestion/handler.ts`

```typescript
import { SQSHandler, SQSRecord, SQSBatchResponse } from 'aws-lambda';
import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { captureAWSv3Client } from 'aws-xray-sdk';
import { randomUUID } from 'crypto';
import { validateZipStructure } from './validator';
import { JobStatus, DDB_KEY_PREFIX } from '@skills-svc/shared';

const s3 = captureAWSv3Client(new S3Client({}));
const ddb = captureAWSv3Client(DynamoDBDocumentClient.from(new DynamoDBClient({})));
const ecs = captureAWSv3Client(new ECSClient({}));
const ssm = captureAWSv3Client(new SSMClient({}));

const paramCache = new Map<string, { value: string; ts: number }>();
const CACHE_TTL_MS = 300_000; // 5 minutes

async function getParam(name: string): Promise<string> {
  const now = Date.now();
  const cached = paramCache.get(name);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM param not found: ${name}`);
  paramCache.set(name, { value, ts: now });
  return value;
}

export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (err) {
      console.error(JSON.stringify({ event: 'record_error', messageId: record.messageId, err: String(err) }));
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  const body = JSON.parse(record.body) as { Records?: any[] };
  const s3Event = body.Records?.[0]?.s3;
  if (!s3Event) throw new Error('Not an S3 event record');

  const bucket: string = s3Event.bucket.name;
  const key: string = decodeURIComponent((s3Event.object.key as string).replace(/\+/g, ' '));
  const s3ETag: string = s3Event.object.eTag;

  const env = process.env.ENV ?? 'prod';
  const tableName = await getParam(`/skills-svc/${env}/dynamodb/table-name`);

  // Get S3 metadata
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const jobName = head.Metadata?.['job-name'] ?? 'unnamed';
  const userArn = head.Metadata?.['user-arn'] ?? 'unknown';

  // Validate zip (download first 10MB)
  const zipStream = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-10485760' }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of zipStream.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const zipBuffer = Buffer.concat(chunks);
  const validation = validateZipStructure(zipBuffer, {
    compressedSize: s3Event.object.size as number,
    uncompressedSize: s3Event.object.size as number * 10, // conservative estimate for header check
  });
  if (!validation.valid) throw new Error(`Zip validation failed: ${validation.error}`);

  const jobId = randomUUID();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days

  // Write job record — idempotent via ConditionExpression
  try {
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `${DDB_KEY_PREFIX.JOB}${jobId}`,
        SK: 'METADATA',
        GSI1PK: `${DDB_KEY_PREFIX.STATUS}${JobStatus.PENDING}`,
        GSI1SK: `CREATED_AT#${now}`,
        GSI2PK: `${DDB_KEY_PREFIX.USER}${userArn}`,
        GSI2SK: `CREATED_AT#${now}`,
        jobId,
        jobName,
        userArn,
        status: JobStatus.PENDING,
        s3Bucket: bucket,
        s3Key: key,
        s3ETag,
        createdAt: now,
        updatedAt: now,
        idempotencyKey: `ETAG#${s3ETag}`,
        version: 0,
        ttl,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(JSON.stringify({ event: 'duplicate_job', s3ETag, message: 'Already processed, skipping' }));
      return;
    }
    throw err;
  }

  // Submit ECS task
  const clusterArn = await getParam(`/skills-svc/${env}/ecs/cluster-arn`);
  const taskDefArn = await getParam(`/skills-svc/${env}/ecs/task-definition-arn`);
  const subnetIds = (await getParam(`/skills-svc/${env}/vpc/private-subnet-ids`)).split(',');
  const ecsSgId = await getParam(`/skills-svc/${env}/vpc/ecs-sg-id`);

  await ecs.send(new RunTaskCommand({
    cluster: clusterArn,
    taskDefinition: taskDefArn,
    launchType: 'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: subnetIds,
        securityGroups: [ecsSgId],
        assignPublicIp: 'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name: 'skills-runner',
        environment: [
          { name: 'JOB_ID', value: jobId },
          { name: 'S3_BUCKET', value: bucket },
          { name: 'S3_KEY', value: key },
          { name: 'ENV', value: env },
          { name: 'REGION', value: process.env.REGION ?? 'us-east-1' },
        ],
      }],
    },
    tags: [
      { key: 'job-id', value: jobId },
      { key: 'job-name', value: jobName },
      { key: 'user-arn', value: userArn },
    ],
    startedBy: `skills-svc-ingestion-${jobId.slice(0, 8)}`,
    enableExecuteCommand: false,
  }));

  console.log(JSON.stringify({ event: 'job_submitted', jobId, jobName, s3Key: key, userArn }));
}
```

---

### 4.2 `packages/lambda/src/ingestion/validator.ts`

```typescript
import AdmZip from 'adm-zip';

export interface ZipMetaHint {
  compressedSize: number;
  uncompressedSize: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  manifest?: ZipManifest;
}

export interface ZipManifest {
  jobName: string;
  version: string;
  skills: string[];
  defaultPrompt?: string;
  tags?: Record<string, string>;
}

const MAX_COMPRESSED_BYTES = 500 * 1024 * 1024;  // 500 MB
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_COMPRESSION_RATIO = 100;
const MAX_FILE_COUNT = 10_000;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function validateZipStructure(buffer: Buffer, meta?: ZipMetaHint): ValidationResult {
  // Check magic bytes
  if (buffer.length < 4 || !buffer.slice(0, 4).equals(ZIP_MAGIC)) {
    return { valid: false, error: 'File is not a valid ZIP archive (bad magic bytes)' };
  }

  // Check compressed size
  if (meta && meta.compressedSize > MAX_COMPRESSED_BYTES) {
    return { valid: false, error: `Compressed size ${meta.compressedSize} exceeds limit of ${MAX_COMPRESSED_BYTES}` };
  }

  // Zip bomb: check uncompressed size and ratio
  if (meta) {
    if (meta.uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
      return { valid: false, error: `Uncompressed size ${meta.uncompressedSize} exceeds 2GB limit` };
    }
    if (meta.compressedSize > 0 && meta.uncompressedSize / meta.compressedSize > MAX_COMPRESSION_RATIO) {
      return { valid: false, error: `Compression ratio ${(meta.uncompressedSize / meta.compressedSize).toFixed(1)}:1 exceeds ${MAX_COMPRESSION_RATIO}:1 limit (possible zip bomb)` };
    }
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (e) {
    return { valid: false, error: `Cannot parse ZIP: ${String(e)}` };
  }

  const entries = zip.getEntries();

  // File count check
  if (entries.length > MAX_FILE_COUNT) {
    return { valid: false, error: `ZIP contains ${entries.length} files, exceeding limit of ${MAX_FILE_COUNT}` };
  }

  // Path traversal check
  for (const entry of entries) {
    const name = entry.entryName;
    if (name.startsWith('/') || name.includes('../') || name.includes('..\\')) {
      return { valid: false, error: `Path traversal detected in entry: ${name}` };
    }
  }

  // Check manifest.json exists
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    return { valid: false, error: 'manifest.json not found in ZIP root' };
  }

  // Parse and validate manifest
  let manifest: ZipManifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
  } catch (e) {
    return { valid: false, error: `manifest.json is not valid JSON: ${String(e)}` };
  }

  if (!manifest.jobName || typeof manifest.jobName !== 'string') {
    return { valid: false, error: 'manifest.json missing required field: jobName (string)' };
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    return { valid: false, error: 'manifest.json missing required field: version (string)' };
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    return { valid: false, error: 'manifest.json missing required field: skills (non-empty array)' };
  }

  // Check each listed skill exists
  for (const skill of manifest.skills) {
    const skillEntry = zip.getEntry(`skills/${skill}.md`) ?? zip.getEntry(`skills/${skill}`);
    if (!skillEntry) {
      return { valid: false, error: `Skill file not found in ZIP: skills/${skill}.md` };
    }
  }

  return { valid: true, manifest };
}
```

---

### 4.3 `packages/lambda/src/results-processor/handler.ts`

```typescript
import { EventBridgeHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { captureAWSv3Client } from 'aws-xray-sdk';
import { indexJobResult } from './indexer';
import { JobStatus, isValidTransition, SNSJobNotification, RunResult } from '@skills-svc/shared';

const s3 = captureAWSv3Client(new S3Client({}));
const ddb = captureAWSv3Client(DynamoDBDocumentClient.from(new DynamoDBClient({})));
const sns = captureAWSv3Client(new SNSClient({}));
const ssm = captureAWSv3Client(new SSMClient({}));

const paramCache = new Map<string, { value: string; ts: number }>();

async function getParam(name: string): Promise<string> {
  const now = Date.now();
  const cached = paramCache.get(name);
  if (cached && now - cached.ts < 300_000) return cached.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM param not found: ${name}`);
  paramCache.set(name, { value, ts: now });
  return value;
}

interface EcsTaskDetail {
  taskArn: string;
  clusterArn: string;
  lastStatus: string;
  startedBy: string;
  containers: Array<{ exitCode?: number; name: string }>;
  tags?: Array<{ key: string; value: string }>;
}

export const handler: EventBridgeHandler<'ECS Task State Change', EcsTaskDetail, void> = async (event) => {
  const detail = event.detail;
  const tags = detail.tags ?? [];
  const jobId = tags.find(t => t.key === 'job-id')?.value;

  if (!jobId) {
    console.warn(JSON.stringify({ event: 'no_job_id', taskArn: detail.taskArn }));
    return;
  }

  const env = process.env.ENV ?? 'prod';
  const container = detail.containers.find(c => c.name === 'skills-runner');
  const exitCode = container?.exitCode ?? -1;
  const succeeded = exitCode === 0;

  console.log(JSON.stringify({ event: 'ecs_task_stopped', jobId, exitCode, succeeded }));

  const tableName = await getParam(`/skills-svc/${env}/dynamodb/table-name`);
  const topicArn = await getParam(`/skills-svc/${env}/sns/jobs-topic-arn`);

  // Get current job record for optimistic locking
  const current = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
  }));

  if (!current.Item) {
    console.error(JSON.stringify({ event: 'job_not_found', jobId }));
    return;
  }

  const currentVersion = current.Item.version as number;
  const currentStatus = current.Item.status as JobStatus;

  const newStatus = succeeded ? JobStatus.COMPLETE : JobStatus.FAILED;

  if (!isValidTransition(currentStatus, newStatus)) {
    console.warn(JSON.stringify({ event: 'invalid_transition', jobId, currentStatus, newStatus }));
    return;
  }

  let resultSummary: string | undefined;
  let s3ResultKey: string | undefined;

  if (succeeded) {
    const resultsBucket = await getParam(`/skills-svc/${env}/s3/results-bucket`);
    s3ResultKey = `results/${jobId}/result.json`;

    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: resultsBucket, Key: s3ResultKey }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      const result: RunResult = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      resultSummary = result.resultSummary;

      // Index into OpenSearch
      await indexJobResult(result, env);
    } catch (err) {
      console.error(JSON.stringify({ event: 'indexing_error', jobId, err: String(err) }));
      // Still mark as complete — indexing failure shouldn't fail the job
    }
  }

  // Update DynamoDB with optimistic locking
  const now = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
    UpdateExpression: [
      'SET #status = :status',
      'updatedAt = :now',
      '#version = :newVersion',
      'GSI1PK = :gsi1pk',
      succeeded ? 'completedAt = :now' : 'errorMessage = :errMsg',
      s3ResultKey ? 's3ResultKey = :s3ResultKey' : '',
    ].filter(Boolean).join(', '),
    ConditionExpression: '#version = :currentVersion',
    ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
    ExpressionAttributeValues: {
      ':status': newStatus,
      ':now': now,
      ':newVersion': currentVersion + 1,
      ':currentVersion': currentVersion,
      ':gsi1pk': `STATUS#${newStatus}`,
      ...(succeeded ? {} : { ':errMsg': `ECS task exited with code ${exitCode}` }),
      ...(s3ResultKey ? { ':s3ResultKey': s3ResultKey } : {}),
    },
  }));

  // SNS notification
  const notification: SNSJobNotification = {
    jobId,
    jobName: current.Item.jobName as string,
    status: newStatus,
    message: succeeded ? 'Skills processing completed successfully' : `Processing failed (exit code ${exitCode})`,
    resultSummary,
    s3ResultKey,
    timestamp: now,
  };

  await sns.send(new PublishCommand({
    TopicArn: topicArn,
    Subject: `Skills SaaS Job ${newStatus}: ${current.Item.jobName}`,
    Message: JSON.stringify(notification, null, 2),
    MessageAttributes: {
      jobId: { DataType: 'String', StringValue: jobId },
      status: { DataType: 'String', StringValue: newStatus },
    },
  }));

  console.log(JSON.stringify({ event: 'job_processed', jobId, status: newStatus }));
};
```

---

## 5. ECSStack (`infra/lib/ecs-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface ECSStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  ecsSg: ec2.SecurityGroup;
  ecsTaskRole: iam.Role;
  ecsExecutionRole: iam.Role;
  ecsLogKey: kms.Key;
  ecrKey: kms.Key;
  uploadsBucket: s3.Bucket;
  resultsBucket: s3.Bucket;
}

export class ECSStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly ecrRepo: ecr.Repository;

  constructor(scope: Construct, id: string, props: ECSStackProps) {
    super(scope, id, props);

    const { envName } = props;

    this.ecrRepo = new ecr.Repository(this, 'SkillsRunnerRepo', {
      repositoryName: `skills-svc-runner-${envName}`,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: props.ecrKey,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [{
        rulePriority: 1,
        description: 'Keep last 10 images',
        maxImageCount: 10,
        tagStatus: ecr.TagStatus.ANY,
      }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.cluster = new ecs.Cluster(this, 'SkillsCluster', {
      clusterName: `skills-svc-${envName}`,
      vpc: props.vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true,
    });

    const runnerLogGroup = new logs.LogGroup(this, 'RunnerLogGroup', {
      logGroupName: `/skills-svc/${envName}/ecs/runner`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: props.ecsLogKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'SkillsRunnerTaskDef', {
      family: `skills-svc-runner-${envName}`,
      cpu: 2048,           // 2 vCPU — valid Fargate combo with 4096 MB
      memoryLimitMiB: 4096,
      taskRole: props.ecsTaskRole,
      executionRole: props.ecsExecutionRole,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
    });

    const linuxParams = new ecs.LinuxParameters(this, 'LinuxParams', {
      initProcessEnabled: true,  // PID 1 zombie reaping
    });

    this.taskDefinition.addContainer('skills-runner', {
      image: ecs.ContainerImage.fromEcrRepository(this.ecrRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'skills-runner',
        logGroup: runnerLogGroup,
      }),
      environment: {
        NODE_ENV: 'production',
        REGION: this.region,
        // All secrets come from SSM at runtime — NO sensitive values here
      },
      readonlyRootFilesystem: true,   // QA-024
      user: '1000:1000',              // QA-023 — non-root
      linuxParameters: linuxParams,
      essential: true,
      stopTimeout: cdk.Duration.seconds(120),
      healthCheck: {
        command: ['CMD-SHELL', 'node --version || exit 1'],
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(90),
      },
      portMappings: [], // No inbound ports needed
    });

    // SSM params for Lambda to reference
    new ssm.StringParameter(this, 'ParamClusterArn', {
      parameterName: `/skills-svc/${envName}/ecs/cluster-arn`,
      stringValue: this.cluster.clusterArn,
    });
    new ssm.StringParameter(this, 'ParamTaskDefArn', {
      parameterName: `/skills-svc/${envName}/ecs/task-definition-arn`,
      stringValue: this.taskDefinition.taskDefinitionArn,
    });
    new ssm.StringParameter(this, 'ParamEcrUri', {
      parameterName: `/skills-svc/${envName}/ecr/repo-uri`,
      stringValue: this.ecrRepo.repositoryUri,
    });
  }
}
```

---

## 6. ECS Runner Container

### 6.1 `packages/ecs-runner/Dockerfile`

```dockerfile
# ---- Builder stage ----
FROM node:20-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim AS runtime

# Install system dependencies and Claude Code CLI
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
      && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@latest --ignore-scripts

# Create non-root user
RUN groupadd -g 1000 runner && \
    useradd -u 1000 -g runner -s /bin/bash -m -d /home/runner runner

# App directory
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules

# /tmp is the only writable area (root FS will be read-only)
RUN mkdir -p /tmp/workspace && chown runner:runner /tmp/workspace

USER 1000:1000

ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
```

### 6.2 `packages/ecs-runner/src/main.ts`

```typescript
import { downloadZip } from './downloader';
import { extractZip } from './extractor';
import { runSkills } from './runner';
import { uploadResults } from './uploader';
import { updateJobStatus } from './job-status';
import { JobStatus } from '@skills-svc/shared';

process.on('SIGTERM', () => {
  console.log(JSON.stringify({ event: 'sigterm_received', message: 'Graceful shutdown initiated' }));
  // Cleanup happens in main() catch block
  process.exit(1);
});

async function main(): Promise<void> {
  const jobId = process.env.JOB_ID ?? fail('JOB_ID env var required');
  const s3Bucket = process.env.S3_BUCKET ?? fail('S3_BUCKET env var required');
  const s3Key = process.env.S3_KEY ?? fail('S3_KEY env var required');
  const env = process.env.ENV ?? 'prod';

  console.log(JSON.stringify({ event: 'task_start', jobId, s3Bucket, s3Key }));

  try {
    await updateJobStatus(jobId, JobStatus.RUNNING, env);

    const zipPath = await downloadZip(s3Bucket, s3Key, '/tmp/workspace/upload.zip');
    const extractDir = await extractZip(zipPath, '/tmp/workspace/skills');
    const results = await runSkills(extractDir, jobId, env);
    const resultKey = await uploadResults(jobId, results, env);

    console.log(JSON.stringify({ event: 'task_complete', jobId, resultKey }));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ event: 'task_error', jobId, err: String(err) }));
    try {
      await updateJobStatus(jobId, JobStatus.FAILED, env, String(err));
    } catch (updateErr) {
      console.error(JSON.stringify({ event: 'status_update_error', err: String(updateErr) }));
    }
    process.exit(1);
  }
}

function fail(msg: string): never {
  throw new Error(msg);
}

main();
```

### 6.3 `packages/ecs-runner/src/extractor.ts`

```typescript
import { createReadStream } from 'fs';
import { mkdir } from 'fs/promises';
import * as path from 'path';
import * as unzipper from 'unzipper';

const MAX_FILES = 10_000;
const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB
const ALLOWED_PREFIX = '/tmp/'; // enforce all extractions under /tmp

export async function extractZip(zipPath: string, destDir: string): Promise<string> {
  if (!destDir.startsWith(ALLOWED_PREFIX)) {
    throw new Error(`destDir must be under ${ALLOWED_PREFIX}, got: ${destDir}`);
  }

  await mkdir(destDir, { recursive: true });

  let fileCount = 0;
  let totalSize = 0;

  await new Promise<void>((resolve, reject) => {
    createReadStream(zipPath)
      .pipe(unzipper.Parse())
      .on('entry', async (entry: unzipper.Entry) => {
        const entryPath = entry.path;
        const type = entry.type;

        // Path traversal protection
        if (entryPath.startsWith('/') || entryPath.includes('../') || entryPath.includes('..\\')) {
          entry.autodrain();
          reject(new Error(`Path traversal detected in entry: ${entryPath}`));
          return;
        }

        const absolutePath = path.join(destDir, entryPath);
        // Double-check resolved path is still under destDir
        if (!absolutePath.startsWith(path.resolve(destDir))) {
          entry.autodrain();
          reject(new Error(`Resolved path escapes destDir: ${absolutePath}`));
          return;
        }

        fileCount++;
        if (fileCount > MAX_FILES) {
          entry.autodrain();
          reject(new Error(`ZIP contains more than ${MAX_FILES} files`));
          return;
        }

        if (type === 'Directory') {
          await mkdir(absolutePath, { recursive: true });
          entry.autodrain();
        } else {
          await mkdir(path.dirname(absolutePath), { recursive: true });
          const chunks: Buffer[] = [];
          entry.on('data', (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > MAX_TOTAL_SIZE) {
              reject(new Error(`Extraction size exceeds ${MAX_TOTAL_SIZE} bytes`));
            }
            chunks.push(chunk);
          });
          entry.on('end', async () => {
            const { writeFile } = await import('fs/promises');
            await writeFile(absolutePath, Buffer.concat(chunks));
          });
          entry.on('error', reject);
        }
      })
      .on('close', resolve)
      .on('error', reject);
  });

  return destDir;
}
```

### 6.4 `packages/ecs-runner/src/runner.ts`

```typescript
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { RunResult, ZipManifest } from '@skills-svc/shared';

const TASK_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

export async function runSkills(extractDir: string, jobId: string, env: string): Promise<RunResult> {
  const manifestPath = path.join(extractDir, 'manifest.json');
  const manifest: ZipManifest = JSON.parse(await readFile(manifestPath, 'utf-8'));

  const skillsDir = path.join(extractDir, 'skills');
  const prompt = manifest.defaultPrompt ?? 'Analyze the provided skills and summarize their capabilities and example usage.';

  const startMs = Date.now();

  return new Promise<RunResult>((resolve, reject) => {
    const proc = spawn('claude', [
      '--output-format', 'json',
      '--skills-dir', skillsDir,
      '--print', prompt,
      '--no-interactive',
    ], {
      env: {
        ...process.env,
        // ANTHROPIC_API_KEY comes from SSM — must be set before spawn
      },
      cwd: extractDir,
      timeout: TASK_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Kill on timeout
    const killer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`claude process timed out after ${TASK_TIMEOUT_MS / 1000}s`));
    }, TASK_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(killer);
      const durationMs = Date.now() - startMs;

      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 2000)}`));
        return;
      }

      let output: string;
      let resultSummary: string;

      try {
        const parsed = JSON.parse(stdout);
        output = JSON.stringify(parsed);
        resultSummary = (parsed.result ?? parsed.output ?? stdout).slice(0, 1000);
      } catch {
        output = stdout;
        resultSummary = stdout.slice(0, 1000);
      }

      resolve({
        jobId,
        jobName: manifest.jobName,
        skillNames: manifest.skills,
        prompt,
        output,
        resultSummary,
        durationMs,
        exitCode: code ?? 0,
        completedAt: new Date().toISOString(),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}
```

### 6.5 `packages/ecs-runner/src/downloader.ts`

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const s3 = new S3Client({});

export async function downloadZip(bucket: string, key: string, destPath: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error('Empty S3 response body');

  // Streaming download — never loads full file into memory
  await pipeline(
    res.Body as Readable,
    createWriteStream(destPath),
  );

  console.log(JSON.stringify({ event: 'zip_downloaded', bucket, key, destPath }));
  return destPath;
}
```

---

## 7. CDK Aspects

### 7.1 `infra/aspects/tagging-enforcer.ts`

```typescript
import { IAspect, Annotations, Tags } from 'aws-cdk-lib';
import { CfnResource } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

interface TaggingEnforcerProps {
  requiredTags: string[];
}

export class TaggingEnforcerAspect implements IAspect {
  constructor(private readonly props: TaggingEnforcerProps) {}

  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource)) return;

    const tags: Record<string, string> = {};
    // CfnResource tags are set via the Tags aspect — check node metadata
    for (const tagKey of this.props.requiredTags) {
      const val = Tags.of(node).add; // Tags are propagated from parent — check rendered template
      // During visit, we check if a tag key exists by inspecting cfnOptions
      const cfnTags = (node as any).tags?.renderTags?.() ?? [];
      const found = Array.isArray(cfnTags)
        ? cfnTags.some((t: any) => t.key === tagKey || t.Key === tagKey)
        : false;
      if (!found) {
        Annotations.of(node).addWarning(
          `[TaggingEnforcer] Resource "${node.node.path}" is missing required tag: ${tagKey}`
        );
      }
    }
  }
}
```

---

## 8. Package Configuration Files

### 8.1 Root `package.json`

```json
{
  "name": "skills-as-a-service",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "infra",
    "packages/shared",
    "packages/lambda",
    "packages/ecs-runner",
    "packages/knowledge-store",
    "packages/cli"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "jest --passWithNoTests",
    "lint": "eslint packages/*/src infra/lib infra/aspects --max-warnings 0",
    "qa:all": "bash scripts/qa-run-all.sh",
    "synth": "cd infra && npx cdk synth --strict"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.57.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.4.0"
  }
}
```

### 8.2 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true
  }
}
```

### 8.3 `.eslintrc.js`

```js
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  parserOptions: {
    project: ['./tsconfig.base.json', './packages/*/tsconfig.json', './infra/tsconfig.json'],
  },
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    'no-console': 'off', // Lambda/ECS use console for structured logs
  },
};
```
