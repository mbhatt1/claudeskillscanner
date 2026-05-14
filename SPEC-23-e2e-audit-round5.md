# SPEC-23 — E2E Audit Round 5: Blocking & Correctness Fixes

**Supersedes:** SPEC-22 on all overlapping topics.  
**Scope:** 5-agent parallel audit across skill execution failure recovery, skill registry push/run,
multi-tenant isolation, CDK deploy/rollback, and cost/quota management flows.  
**Policy:** Only blocking or correctness issues included — no operational edge cases.

---

## Fix 1 — ECS `startedBy` Carries `jobId` (EventBridge ECS Tags Are Unreliable)

**Root cause:** `ResultsProcessorLambda` reads `jobId` from ECS task tags in the EventBridge event.
ECS task-level tags are only propagated to EventBridge if the cluster has `EnableTagsOnTaskLaunch` set,
which is not configured in `ECSStack`. Without tags in the event, `jobId` is `undefined`,
the handler returns early, and the job is stuck in `RUNNING` forever.

**Fix — encode `jobId` in `startedBy` (always present in EventBridge events):**

In `packages/lambda/src/ingestion/handler.ts`:
```typescript
// Encode full jobId UUID in startedBy (ECS limit is 36 chars — exactly a UUID):
await ecs.send(new RunTaskCommand({
  ...runTaskInput,
  startedBy: jobId,          // was: `skills-svc-${jobId.slice(0,8)}`
}));
```

In `packages/lambda/src/results-processor/handler.ts`:
```typescript
interface EcsTaskDetail {
  taskArn:     string;
  clusterArn:  string;
  lastStatus:  string;
  startedBy:   string;
  stoppedReason?: string;
  containers:  Array<{ exitCode?: number; name: string; reason?: string }>;
  tags?:       Array<{ key: string; value: string }>;
}

// Parse jobId from startedBy (always populated by ECS):
const jobId = isValidUUID(detail.startedBy) ? detail.startedBy : undefined;
if (!jobId) {
  console.warn(JSON.stringify({ event: 'no_job_id', taskArn: detail.taskArn, startedBy: detail.startedBy }));
  return;
}
```

---

## Fix 2 — Reverse DDB Write / ECS Submit Order (Prevent Orphaned PENDING Jobs)

**Root cause:** `IngestionLambda` writes the DDB job record first, then calls `RunTaskCommand`.
If `RunTaskCommand` fails, the DDB record is permanently orphaned in `PENDING`. SQS retry hits
`ConditionalCheckFailedException` (same PK) and silently returns — never re-submitting ECS.
Additionally, `RunTaskCommand` can return HTTP 200 with a non-empty `failures[]` array without
throwing — this case is never checked.

**Fix in `packages/lambda/src/ingestion/handler.ts`:**
```typescript
// Step 1: Submit ECS FIRST
const runTaskResponse = await ecs.send(new RunTaskCommand({ ...runTaskInput, startedBy: jobId }));

// Step 2: Check for soft failures in ECS response (HTTP 200 but task not launched)
if (runTaskResponse.failures?.length) {
  const reason = runTaskResponse.failures.map(f => f.reason).join('; ');
  throw new Error(`ECS RunTask returned failures: ${reason}`);
  // Throwing here causes SQS to retry (message stays visible).
  // DDB was never written, so retry will attempt ECS submit again.
}

const ecsTaskArn = runTaskResponse.tasks?.[0]?.taskArn;
if (!ecsTaskArn) throw new Error('ECS RunTask returned no task ARN');

// Step 3: Write DDB AFTER ECS succeeds
await ddb.send(new PutCommand({
  TableName: tableName,
  Item: { ...jobItem, ecsTaskArn },
  ConditionExpression: 'attribute_not_exists(PK)',
}));
```

---

## Fix 3 — `isValidTransition` Must Allow `PENDING→FAILED` (Pre-Start ECS Crashes)

**Root cause:** If an ECS task fails before starting (image pull error, `CannotPullContainerError`,
capacity failure), the task emits a STOPPED event while the job is still in `PENDING` status.
If `isValidTransition` only allows `RUNNING→FAILED`, the `ResultsProcessorLambda` silently
returns early — the job is stuck in `PENDING` forever with no SNS notification.

**Fix in `packages/shared/src/constants.ts`:**
```typescript
export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  const allowed: Record<JobStatus, JobStatus[]> = {
    [JobStatus.PENDING]:  [JobStatus.RUNNING, JobStatus.FAILED], // FAILED added: pre-start crash
    [JobStatus.RUNNING]:  [JobStatus.COMPLETE, JobStatus.FAILED],
    [JobStatus.COMPLETE]: [],
    [JobStatus.FAILED]:   [],
  };
  return allowed[from]?.includes(to) ?? false;
}
```

Also: when `isValidTransition` returns `false` for a terminal ECS exit (`newStatus === FAILED`),
still publish the SNS notification so the user is informed of the anomaly:
```typescript
if (!isValidTransition(currentStatus, newStatus)) {
  console.warn(JSON.stringify({ event: 'invalid_transition', jobId, currentStatus, newStatus }));
  if (newStatus === JobStatus.FAILED) {
    await sns.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: `[${jobId.slice(0,8)}] Job transition anomaly — check DLQ`,
      Message: JSON.stringify({ jobId, warning: `Cannot transition ${currentStatus}→${newStatus}` }),
    }));
  }
  return;
}
```

---

## Fix 4 — ResultsDLQ Processor Lambda (Jobs Stuck Forever When ResultsProcessor Fails 3×)

**Root cause:** EventBridge retries `ResultsProcessorLambda` 2 times on Lambda-level failure.
After 3 attempts the event goes to `resultsDLQ` with no consumer. The job stays in `RUNNING`
and the user receives no SNS notification — ever.

**New file `packages/lambda/src/results-dlq-processor/handler.ts`:**
```typescript
import { SQSHandler } from 'aws-lambda';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

export const handler: SQSHandler = async (event) => {
  for (const record of event.Records) {
    const body  = JSON.parse(record.body);
    const detail = body.detail ?? body;
    const jobId  = isValidUUID(detail.startedBy) ? detail.startedBy : undefined;
    if (!jobId) continue;

    const tableName = process.env.DYNAMODB_TABLE_NAME!;
    const topicArn  = process.env.TOPIC_ARN!;

    // Force FAILED — do not clobber a successful COMPLETE
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :failed, errorMessage = :msg, updatedAt = :now',
      ConditionExpression: '#status <> :complete',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':failed':   'FAILED',
        ':complete': 'COMPLETE',
        ':msg':      'ResultsProcessorLambda failed after 3 attempts — see DLQ',
        ':now':       new Date().toISOString(),
      },
    })).catch(() => {}); // ConditionalCheckFailed = already COMPLETE, ignore

    await sns.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: `[${jobId.slice(0,8)}] Job FAILED (internal processing error)`,
      Message: JSON.stringify({
        jobId, status: 'FAILED',
        message: 'Internal error after 3 retries. Inspect DLQ: skills-svc-results-dlq.',
      }),
    }));
  }
};
```

Wire in `infra/lib/lambda-stack.ts`:
```typescript
this.resultsDlqProcessorFn = new lambda.Function(this, 'ResultsDlqProcessorLambda', {
  ...sharedLambdaProps,
  handler: 'results-dlq-processor/handler.handler',
  reservedConcurrentExecutions: 2,
});
this.resultsDlqProcessorFn.addEventSourceMapping('ResultsDlqSource', {
  eventSourceArn: props.resultsDlq.queueArn,
  batchSize: 10,
});
```

---

## Fix 5 — SQS Visibility Timeout Must Exceed Total Processing Time (900 s → 2100 s)

**Root cause:** `ingestionQueue.visibilityTimeout` is 900 s (15 min). The ECS task can run up
to 25 min (1500 s). If the Lambda times out rather than returning, the SQS message becomes
re-visible after 900 s while the ECS task is still running, causing a second Lambda invocation
to attempt a second ECS submit for the same job.

**Fix in `infra/lib/messaging-stack.ts`:**
```typescript
this.ingestionQueue = new sqs.Queue(this, 'IngestionQueue', {
  // Lambda timeout 300s + ECS max duration 1500s + buffer 300s = 2100s
  visibilityTimeout: cdk.Duration.seconds(2100),
  ...rest,
});
```

---

## Fix 6 — NetworkStack Must Write VPC SSM Parameters (Ingestion Lambda Cannot Launch ECS Without Them)

**Root cause:** `NetworkStack` creates the VPC and security groups but never writes
`/skills-svc/{env}/vpc/private-subnet-ids` or `/skills-svc/{env}/vpc/ecs-sg-id` to SSM.
The `IngestionLambda` reads these exact paths at runtime. On first deploy the parameters
are absent, the Lambda throws `ParameterNotFound`, and no ECS task is ever submitted.

**Fix in `infra/lib/network-stack.ts`:**
```typescript
import * as ssm from 'aws-cdk-lib/aws-ssm';

// Add to NetworkStack constructor (after VPC + SGs created):
new ssm.StringParameter(this, 'ParamPrivateSubnetIds', {
  parameterName: `/skills-svc/${props.envName}/vpc/private-subnet-ids`,
  stringValue: this.vpc
    .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED })
    .subnetIds.join(','),
});
new ssm.StringParameter(this, 'ParamEcsSgId', {
  parameterName: `/skills-svc/${props.envName}/vpc/ecs-sg-id`,
  stringValue: this.ecsSg.securityGroupId,
});
```

---

## Fix 7 — Add `LambdaStack.addDependency(ecsStack)` (ECS SSM Params Must Exist First)

**Root cause:** `bin/app.ts` declares `lambdaStack.addDependency(messaging)` but not
`lambdaStack.addDependency(ecsStack)`. CloudFormation can deploy both stacks in parallel.
If `LambdaStack` deploys first and a test message arrives in SQS, the Lambda calls
`getParam('/skills-svc/{env}/ecs/cluster-arn')` which `ECSStack` has not yet written.

**Fix in `infra/bin/app.ts`:**
```typescript
lambdaStack.addDependency(ecsStack);   // ADD — ECS SSM params must exist before Lambda is invoked
```

---

## Fix 8 — OpenSearch Index Bootstrap Custom Resource (Index Never Created)

**Root cause:** `KnowledgeStoreStack` creates the AOSS collection but never calls the
`bootstrap-index` Lambda via a Custom Resource. The collection exists with no index.
Every `indexJobResult()` call throws `index_not_found_exception`.

**Fix in `infra/lib/knowledge-store-stack.ts`:**
```typescript
import * as cr from 'aws-cdk-lib/custom-resources';

const bootstrapFn = new lambda.Function(this, 'BootstrapIndexFn', {
  functionName: `skills-svc-bootstrap-index-${this.account}`,
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'bootstrap-index/handler.handler',
  code: /* same bundled code as LambdaStack */,
  timeout: cdk.Duration.minutes(5),
  vpc: props.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [props.lambdaSg],
  environment: { ENV: envName, REGION: this.region },
  role: props.resultsLambdaRole,
});

const bootstrapProvider = new cr.Provider(this, 'BootstrapIndexProvider', {
  onEventHandler: bootstrapFn,
});

const bootstrapResource = new cdk.CustomResource(this, 'BootstrapIndex', {
  serviceToken: bootstrapProvider.serviceToken,
  properties: { RequestType: 'Create' },
});
// Must run after collection policies are applied:
bootstrapResource.node.addDependency(collection, encPolicy, netPolicy, dataPolicy);
```

Also remove `number_of_replicas` from the index settings — AOSS rejects it with HTTP 400:
```typescript
// packages/lambda/src/bootstrap-index/handler.ts — index settings:
settings: {
  index: {
    knn: true,
    'knn.algo_param.ef_search': 512,
    number_of_shards: 5,
    // REMOVED: number_of_replicas — AOSS manages replication automatically;
    // setting this causes a 400 Bad Request and the index is never created.
    refresh_interval: '5s',
  },
  // ...
}
```

---

## Fix 9 — Lambda Log Groups and VPC Flow Logs Must Have KMS Keys (EncryptionEnforcerAspect)

**Root cause:** `EncryptionEnforcerAspect` visits every `CfnLogGroup` and errors if `kmsKeyId`
is absent. Lambda functions auto-create log groups without KMS; the VPC flow log also creates
an unencrypted log group. Both cause `cdk synth --strict` to fail before any deployment.

**Fix in `infra/lib/lambda-stack.ts` — pre-create KMS-encrypted log groups:**
```typescript
// Grant CloudWatch Logs service access to lambdaEnvKey:
props.lambdaEnvKey.addToResourcePolicy(new iam.PolicyStatement({
  principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
  actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
  resources: ['*'],
  conditions: {
    ArnLike: {
      'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:*`,
    },
  },
}));

function makeLogGroup(scope: Construct, id: string, name: string, key: kms.Key) {
  return new logs.LogGroup(scope, `${id}LogGroup`, {
    logGroupName:    `/aws/lambda/${name}`,
    retention:       logs.RetentionDays.THREE_MONTHS,
    encryptionKey:   key,
    removalPolicy:   cdk.RemovalPolicy.RETAIN,
  });
}

// Pass logGroup: makeLogGroup(...) to every lambda.Function in LambdaStack.
```

**Fix in `infra/lib/network-stack.ts` — encrypted flow log group:**
```typescript
const flowLogsKey = new kms.Key(this, 'FlowLogsKey', {
  alias: `alias/skills-svc/${props.envName}/vpc-flow-logs`,
  enableKeyRotation: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});
flowLogsKey.addToResourcePolicy(new iam.PolicyStatement({
  principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
  actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
  resources: ['*'],
}));

const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
  logGroupName:  `/skills-svc/${props.envName}/vpc/flow-logs`,
  retention:     logs.RetentionDays.THREE_MONTHS,
  encryptionKey: flowLogsKey,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

new ec2.FlowLog(this, 'FlowLog', {
  resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
  trafficType:  ec2.FlowLogTrafficType.ALL,
  destination:  ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
});
```

---

## Fix 10 — `QueryLambdaRole` Missing `kms:Decrypt` (Every Query Returns AccessDenied)

**Root cause:** `queryLambdaRole` in `SecurityStack` grants `aoss:APIAccessAll` and
`bedrock:InvokeModel` but has no `kms:Decrypt` statement. The AOSS client needs to
decrypt documents using `opensearchKey`; the Lambda environment needs `lambdaEnvKey` decryption.

**Fix in `infra/lib/security-stack.ts`:**
```typescript
this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KMSDecrypt',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [
    this.opensearchKey.keyArn,
    this.lambdaEnvKey.keyArn,
  ],
}));
```

---

## Fix 11 — S3 Event Notification Causes CloudFormation Circular Dependency

**Root cause:** `MessagingStack` calls `props.uploadsBucket.addEventNotification(...)`.
CDK places the `BucketNotification` resource in `StorageStack` (the bucket's owning stack),
which references `MessagingStack`'s SQS queue ARN. Combined with
`messaging.addDependency(storage)`, this creates a CloudFormation circular dependency.
`cdk deploy --all` fails.

**Fix — move notification to a dedicated `NotificationStack`:**

`infra/lib/notification-stack.ts` (new):
```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

interface NotificationStackProps extends cdk.StackProps {
  uploadsBucket:    s3.Bucket;
  ingestionQueue:   sqs.Queue;
}

export class NotificationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NotificationStackProps) {
    super(scope, id, props);
    props.uploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(props.ingestionQueue),
      { prefix: 'uploads/', suffix: '.zip' },
    );
  }
}
```

`infra/bin/app.ts`:
```typescript
// Remove addEventNotification call from MessagingStack constructor.
// Add after both stacks are constructed:
const notificationStack = new NotificationStack(app, `SkillsSvc-${envName}-Notification`, {
  env,
  uploadsBucket:  storage.uploadsBucket,
  ingestionQueue: messaging.ingestionQueue,
});
notificationStack.addDependency(messaging);
// StorageStack dependency is transitive via uploadsBucket.
```

---

## Fix 12 — `list-jobs` GSI1 Query Returns All Users' Jobs (Missing Ownership Filter)

**Root cause:** The CLI `list-jobs --status` queries `GSI1-Status` with only
`GSI1PK = STATUS#{status}` — no `FilterExpression` on `userArn`. Alice sees Bob's jobs.

**Fix in `packages/cli/src/commands/list-jobs.ts` (status-filtered path):**
```typescript
const identity = await new STSClient({ region: cfg.region, credentials: credProvider })
  .send(new GetCallerIdentityCommand({}));

const res = await ddb.send(new QueryCommand({
  TableName:                 cfg.dynamodbTableName,
  IndexName:                 'GSI1-Status',
  KeyConditionExpression:    'GSI1PK = :gsi1pk',
  FilterExpression:          'userArn = :callerArn',    // ADD
  ExpressionAttributeValues: {
    ':gsi1pk':    `${DDB_KEY_PREFIX.STATUS}${opts.status}`,
    ':callerArn': identity.Arn!,                        // ADD
  },
  ScanIndexForward: false,
  Limit: limit * 5,  // over-fetch — FilterExpression reduces result set
}));
items = ((res.Items ?? []) as JobRecord[]).slice(0, limit);
```

The same fix applies to the MCP `list_jobs` status-filtered path. Switch it to `GSI2-User`
for server-side user scoping (avoids `Limit`-before-filter issue):
```typescript
// MCP list_jobs — always use GSI2-User for user-scoped queries:
IndexName:              'GSI2-User',
KeyConditionExpression: 'GSI2PK = :user',
FilterExpression:       status !== 'ALL' ? '#status = :status' : undefined,
ExpressionAttributeValues: {
  ':user':   `USER#${callerArn}`,
  ...(status !== 'ALL' ? { ':status': status } : {}),
},
```

---

## Fix 13 — `status`, `results` CLI Commands Missing Ownership Check

**Root cause:** `skills-svc status <job-id>` and `skills-svc results <job-id>` do a
raw `GetItem` with no assertion that `job.userArn === callerArn`. Alice can enumerate
Bob's job UUIDs (via the list-jobs gap above) and download Bob's results.

**Fix — add to both commands after `GetItem`:**
```typescript
// packages/cli/src/commands/status.ts and results.ts:
const job = res.Item as JobRecord;
const identity = await new STSClient({ region: cfg.region, credentials: creds })
  .send(new GetCallerIdentityCommand({}));

if (job.userArn !== identity.Arn!) {
  console.error(chalk.red(`Access denied: job ${jobId} does not belong to your account.`));
  process.exit(1);
}
```

---

## Fix 14 — Envelope Encryption Context Must Include `userArn` (Cross-Tenant Decryption Possible)

**Root cause:** The KMS encryption context for envelope encryption is
`{ jobId, purpose, environment }`. There is no `userArn`. Any `UserRole` holder who
learns Bob's `jobId` can call `KMSDecrypt` with the correct context and decrypt Bob's
result — because `UserRole` already has `kms:Decrypt` on `resultsBucketKey`.

**Fix in `packages/shared/src/crypto.ts` — add `userArn` to context:**
```typescript
// envelopeEncrypt and envelopeDecrypt both use this context shape:
export interface EncryptionContext {
  jobId:       string;
  userArn:     string;    // ADD — binds ciphertext to specific user
  purpose:     string;
  environment: string;
}
```

**ECS runner `packages/ecs-runner/src/main.ts` — pass `userArn` from env:**
```typescript
// Pass from ingestion Lambda's RunTask containerOverrides environment:
{ name: 'JOB_USER_ARN', value: userArn },   // ADD to ingestion/handler.ts RunTaskCommand

// In ECS runner main.ts:
const userArn = process.env.JOB_USER_ARN!;
await envelopeEncrypt(plaintext, kmsKeyId, { jobId, userArn, purpose: 'skills-svc-result', environment: env });
```

**`ResultsProcessorLambda` — pass `userArn` from DDB job record:**
```typescript
const userArn = current.Item.userArn as string;
const plain = await envelopeDecrypt(raw, { jobId, userArn, purpose: 'skills-svc-result', environment: env });
```

---

## Fix 15 — `indexJobResult` Must Write `user_arn` to OpenSearch (Row-Level Security Is a No-Op Without It)

**Root cause:** `packages/knowledge-store/src/indexer.ts` never writes `user_arn` to the
OpenSearch document. The `hybridSearch` `bool.filter[term: {user_arn: callerArn}]` therefore
silently returns zero results for all users (field is always null), and the isolation guarantee
is completely absent. Also `s3_result_key` is never written, breaking the `results` command
after a knowledge store query.

**Fix — thread `userArn` and `s3ResultKey` through to the indexer:**

`packages/shared/src/types.ts`:
```typescript
export interface RunResult {
  jobId:        string;
  jobName:      string;
  userArn:      string;      // ADD
  s3ResultKey:  string;      // ADD
  skillNames:   string[];
  // ...existing fields...
}
```

`packages/knowledge-store/src/indexer.ts`:
```typescript
body: {
  job_id:         result.jobId,
  job_name:       result.jobName,
  user_arn:       result.userArn,       // ADD — required for hybridSearch filter
  s3_result_key:  result.s3ResultKey,   // ADD — required for results command
  skill_names:    result.skillNames,
  // ...existing fields...
},
```

`packages/lambda/src/results-processor/handler.ts` — construct `RunResult` with these fields:
```typescript
const runResult: RunResult = {
  ...parsed,
  userArn:     current.Item.userArn as string,
  s3ResultKey: s3ResultKey!,
};
```

---

## Fix 16 — `hybridSearch` Must Use `post_filter` and Remove `adminOverride` Bypass

**Root cause:** The `hybridSearch` `bool.filter` applies before kNN scoring, but kNN builds its
candidate set before filters run — Bob's vectors can appear in the candidate pool, and the filter
only reduces the returned set. The `post_filter` is the correct mechanism to enforce after scoring.
Also, the `adminOverride` parameter allows callers to bypass the `callerUserArn` check entirely.

**Fix in `packages/knowledge-store/src/searcher.ts`:**
```typescript
// Remove adminOverride parameter entirely
export async function hybridSearch(
  query:         string,
  callerUserArn: string,   // REQUIRED — no bypass
  topK  = 5,
  minScore = 0.5,
): Promise<SearchResult[]> {
  if (!callerUserArn) throw new Error('callerUserArn is required');

  // Add post_filter in addition to bool.filter:
  body: {
    size: topK * 2,  // over-fetch for post_filter reduction
    query: {
      bool: {
        must: { hybrid: { queries: [knnQuery, bm25Query] } },
        filter: [{ term: { user_arn: callerUserArn } }],
      },
    },
    post_filter: {                                   // ADD — enforced after kNN scoring
      term: { user_arn: callerUserArn },
    },
    min_score: minScore,
    _source: [...fields],
  }
```

---

## Fix 17 — MCP Lambda `KMSDecrypt` Must Name Specific Key ARNs (Not `Resource: '*'`)

**Root cause:** `mcpLambdaRole` has `kms:Decrypt` on `Resource: '*'`. The `NoWildcardIAMAspect`
flags this during `cdk synth`, and it is over-permissive — the MCP Lambda can decrypt any
account-level ciphertext.

**Fix in `infra/lib/mcp-stack.ts` — add key ARNs to `MCPStackProps` and use them:**
```typescript
interface MCPStackProps extends cdk.StackProps {
  // ...existing fields...
  resultsBucketKeyArn: string;
  uploadsBucketKeyArn: string;
  dynamodbKeyArn:      string;
  opensearchKeyArn:    string;
  lambdaEnvKeyArn:     string;
}

mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:       'KMSDecrypt',
  actions:   ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [
    props.resultsBucketKeyArn,
    props.uploadsBucketKeyArn,
    props.dynamodbKeyArn,
    props.opensearchKeyArn,
    props.lambdaEnvKeyArn,
  ],
}));

// bin/app.ts — wire props from security stack outputs:
const mcpStack = new MCPStack(app, `SkillsSvc-${envName}-MCP`, {
  ...existingProps,
  resultsBucketKeyArn: security.resultsBucketKey.keyArn,
  uploadsBucketKeyArn: security.uploadsBucketKey.keyArn,
  dynamodbKeyArn:      security.dynamodbKey.keyArn,
  opensearchKeyArn:    security.opensearchKey.keyArn,
  lambdaEnvKeyArn:     security.lambdaEnvKey.keyArn,
});
```

---

## Fix 18 — Bedrock and AOSS Calls Must Retry on `ThrottlingException` / 429

**Root cause:** `packages/knowledge-store/src/embeddings.ts` (`getEmbedding`) and
`packages/ecs-runner/src/runner.ts` (Claude CLI stderr) both have zero retry on throttling.
At 50 concurrent ECS tasks all calling Bedrock, bursts exceed the per-account
Titan Embed TPM quota. Every 429 permanently crashes the indexing path or the ECS task.
AOSS `client.index()` also has no retry — OCU saturation returns HTTP 429 which silently
drops the document.

**Fix — shared retry wrapper in `packages/shared/src/retry.ts` (new):**
```typescript
const RETRYABLE_ERRORS = new Set([
  'ThrottlingException', 'ServiceUnavailableException',
  'InternalServerException', 'RequestTimeoutException',
]);

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 5,
  isRetryable = (err: any) => RETRYABLE_ERRORS.has(err?.name) || [429, 503, 504].includes(err?.statusCode),
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) throw err;
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 32_000) + Math.random() * 500;
      console.warn(JSON.stringify({ event: 'retry', attempt: attempt + 1, backoffMs: Math.round(backoffMs), errorName: err.name }));
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}
```

Apply in `embeddings.ts`:
```typescript
// MAX_INPUT_CHARS: Titan v2 limit is 8,192 tokens; at ~2.5 chars/token → 20,000 chars safe max
// (was 25,000 — 25k chars ≈ 8,333 tokens, exceeds limit → ValidationException)
const MAX_INPUT_CHARS = 20_000;

export async function getEmbedding(text: string): Promise<number[]> {
  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  return withRetry(async () => {
    const response = await bedrock.send(new InvokeModelCommand({ ... }));
    return JSON.parse(Buffer.from(response.body).toString('utf-8')).embedding;
  });
}
```

Apply in `indexer.ts`:
```typescript
await withRetry(() => client.index({ index: indexName, id: result.jobId, body: document }));
```

Apply in ECS `runner.ts`:
```typescript
// Detect Bedrock throttle in stderr and retry the Claude spawn:
const isThrottled = (stderr: string) =>
  stderr.includes('ThrottlingException') || stderr.includes('429') || stderr.includes('Too many requests');
```

---

## Fix 19 — DynamoDB `UpdateItem` in ResultsProcessor Must Retry on Write Throttle

**Root cause:** On a cold on-demand DynamoDB table, 50 concurrent `ResultsProcessorLambda`
invocations each trigger `UpdateItem` with 5 GSI fan-out (6 effective writes each).
The burst budget for a cold PAY_PER_REQUEST table can be exhausted in the first second.
`ProvisionedThroughputExceededException` propagates uncaught, EventBridge retries twice,
then the job goes to `resultsDLQ` with no COMPLETE/FAILED status written.

**Fix in `packages/lambda/src/results-processor/handler.ts`:**
```typescript
// Use withRetry from Fix 18 for all DDB writes, but do NOT retry ConditionalCheckFailedException:
await withRetry(
  () => ddb.send(new UpdateCommand({ ...updateParams })),
  5,
  (err) => {
    if (err.name === 'ConditionalCheckFailedException') return false; // correct rejection, don't retry
    return ['ProvisionedThroughputExceededException', 'RequestLimitExceeded', 'ThrottlingException'].includes(err.name);
  },
);
```

Apply the same pattern in `packages/ecs-runner/src/job-status.ts` — the ECS container also
calls `UpdateItem`.

---

## Fix 20 — ECS Concurrency Cap: Check Running Task Count Before `RunTask`

**Root cause:** `IngestionLambda` has `reservedConcurrentExecutions: 50` but each invocation
unconditionally calls `RunTaskCommand`. A burst of 500 uploaded zips can launch 50 simultaneous
ECS Fargate tasks (~$4/hr). There is no circuit breaker.

**Fix in `packages/lambda/src/ingestion/ecs-submitter.ts`:**
```typescript
import { ListTasksCommand } from '@aws-sdk/client-ecs';

const MAX_CONCURRENT_ECS_TASKS = 50;

export async function submitEcsTask(params: EcsSubmitParams): Promise<string> {
  const running = await ecs.send(new ListTasksCommand({
    cluster:       params.clusterArn,
    family:        params.taskFamily,
    desiredStatus: 'RUNNING',
  }));
  const runningCount = running.taskArns?.length ?? 0;

  if (runningCount >= MAX_CONCURRENT_ECS_TASKS) {
    // Throw → SQS returns message to queue → retried after visibilityTimeout
    throw new Error(
      `ECS concurrency cap reached (${runningCount}/${MAX_CONCURRENT_ECS_TASKS}). Will retry.`,
    );
  }

  const result = await ecs.send(new RunTaskCommand({ ...params.runTaskInput }));
  if (result.failures?.length) {
    throw new Error(`ECS RunTask failed: ${result.failures.map(f => f.reason).join('; ')}`);
  }
  return result.tasks![0].taskArn!;
}
```

Add CloudWatch alarm in `MonitoringStack`:
```typescript
new cloudwatch.Alarm(this, 'EcsRunningTasksAlarm', {
  alarmName: `skills-svc-${envName}-ecs-running-tasks`,
  metric: new cloudwatch.Metric({
    namespace:      'ECS/ContainerInsights',
    metricName:     'RunningTaskCount',
    dimensionsMap:  { ClusterName: `skills-svc-${envName}` },
    period:         cdk.Duration.minutes(1),
    statistic:      'Maximum',
  }),
  threshold:           45,  // 90% of cap
  evaluationPeriods:   2,
  comparisonOperator:  cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData:    cloudwatch.TreatMissingData.NOT_BREACHING,
}).addAlarmAction(alarmAction);
```

---

## Fix 21 — `latestVersion` DDB Update Must Use Optimistic Lock (Concurrent Pushes Corrupt Pointer)

**Root cause:** Two concurrent `skill push` calls for `1.2.0` and `1.3.0` both read
`latestVersion = 1.1.0`, both decide they are newer, and both write. The result is
non-deterministic — `latestVersion` can end up as `1.2.0` even though `1.3.0` was published.

**Fix in `packages/lambda/src/skill-validator/handler.ts`:**
```typescript
// Add ConditionExpression to the latestVersion UpdateCommand:
await ddb.send(new UpdateCommand({
  TableName: skillsTableName,
  Key: { PK: `${SKILL_KEY_PREFIX.SKILL}${skillName}`, SK: 'META' },
  UpdateExpression: `SET updatedAt = :now ADD totalVersions :one${isNewer ? ', latestVersion = :lv' : ''}${isNewerStable ? ', latestStable = :ls' : ''}`,
  ConditionExpression: 'attribute_not_exists(latestVersion) OR latestVersion = :currentLatest',
  ExpressionAttributeValues: {
    ':now':           new Date().toISOString(),
    ':one':           1,
    ':currentLatest': currentLatest ?? '',
    ...(isNewer       ? { ':lv': version } : {}),
    ...(isNewerStable ? { ':ls': version } : {}),
  },
}));
// Retry on ConditionalCheckFailedException with backoff (re-read + re-evaluate):
```

---

## Fix 22 — `extractor.ts` Fire-and-Forget `writeFile` (Files Unwritten When Runner Reads Manifest)

**Root cause:** `packages/ecs-runner/src/extractor.ts` calls `writeFile` inside an `async`
`entry.on('end', ...)` callback — the returned Promise is never awaited. The outer `Promise<void>`
resolves on `'close'` before `writeFile` completes. `runSkills()` then tries to read the
manifest file, which may not yet exist on disk.

**Fix in `packages/ecs-runner/src/extractor.ts`:**
```typescript
const writePromises: Promise<void>[] = [];

entry.on('end', () => {
  const p = import('fs/promises').then(({ writeFile }) =>
    writeFile(absolutePath, Buffer.concat(chunks))
  );
  writePromises.push(p);
});

// In the 'close' handler:
.on('close', async () => {
  try {
    await Promise.all(writePromises);
    resolve();
  } catch (err) {
    reject(err);
  }
})
```

---

## Fix 23 — `RunSkillLambda` `kms:GenerateDataKey` Over-Granted on Registry Key (Least Privilege)

**Root cause:** `runSkillLambdaRole` grants `kms:GenerateDataKey` on both `registryBucketKey`
and `uploadsBucketKey`. The Lambda only reads from the registry (needs `kms:Decrypt`) and writes
to uploads (needs `kms:GenerateDataKey`). `GenerateDataKey` on an ObjectLock COMPLIANCE bucket
violates least privilege and could allow encrypting new objects into the immutable registry.

**Fix in `infra/lib/security-stack.ts`:**
```typescript
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:       'KMSDecryptRegistryReadOnly',
  actions:   ['kms:Decrypt'],                      // read-only: no GenerateDataKey
  resources: [this.registryBucketKey.keyArn],
}));
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:       'KMSEncryptUploadsWrite',
  actions:   ['kms:GenerateDataKey', 'kms:Decrypt'],
  resources: [this.uploadsBucketKey.keyArn],
}));
// Also add s3:GetObjectVersion (required for CopyObject from versioned ObjectLock source):
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid:       'ReadRegistryVersioned',
  actions:   ['s3:GetObject', 's3:GetObjectVersion'],
  resources: [`arn:aws:s3:::skills-svc-registry-${this.account}-${this.region}/*`],
}));
```

---

## Fix 24 — `callerUserArn` in Query Lambda Is Self-Reported; Route Through API Gateway for Server-Side Identity

**Root cause:** `query/handler.ts` accepts `callerUserArn` from the request payload sent by
the CLI. Alice can craft a payload with `callerUserArn: 'arn:aws:iam::123:user/bob'` and
receive Bob's OpenSearch documents.

**Fix — move the query path to API Gateway HTTP API with IAM auth:**

`infra/lib/lambda-stack.ts`:
```typescript
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';

// Add HTTP API for query Lambda (same pattern as MCP):
const queryApi = new apigwv2.HttpApi(this, 'QueryApi', {
  apiName: `skills-svc-query-${envName}`,
});
queryApi.addRoutes({
  path:        '/query',
  methods:     [apigwv2.HttpMethod.POST],
  integration: new integrations.HttpLambdaIntegration('QueryFn', this.queryFn),
  authorizer:  new authorizers.HttpIamAuthorizer(),
});
// Write endpoint to SSM for CLI configure:
new ssm.StringParameter(this, 'QueryApiUrl', {
  parameterName: `/skills-svc/${envName}/query/endpoint`,
  stringValue:   queryApi.apiEndpoint,
});
```

`packages/lambda/src/query/handler.ts`:
```typescript
import { APIGatewayProxyEventV2WithIAMAuthorizer } from 'aws-lambda';

export const handler = async (event: APIGatewayProxyEventV2WithIAMAuthorizer): Promise<...> => {
  // Server-side identity from SigV4 signature — never self-reported:
  const callerUserArn = event.requestContext.authorizer.iam.userArn;
  if (!callerUserArn) throw new Error('Unauthorized');

  const body = JSON.parse(event.body ?? '{}') as { query: string; topK?: number };
  const results = await hybridSearch(body.query, callerUserArn, body.topK ?? 5);
  return { statusCode: 200, body: JSON.stringify({ results }) };
};
```

CLI `packages/cli/src/commands/query.ts` — call API endpoint with SigV4 instead of `lambda:Invoke`:
```typescript
// Use @aws-sdk/signature-v4 or the HTTP API endpoint via fetch with signed headers
// (same pattern as the MCP client in SPEC-09)
```

---

## Summary

| Fix | Category | Severity | Component |
|-----|----------|----------|-----------|
| 1   | ECS/EventBridge | BLOCKING | Use `startedBy` for `jobId` in EventBridge events |
| 2   | Ingestion flow  | BLOCKING | Reverse DDB/ECS order; check `RunTask` failures array |
| 3   | State machine   | BLOCKING | `isValidTransition` allow `PENDING→FAILED` |
| 4   | DLQ             | BLOCKING | New `ResultsDlqProcessorLambda` to finalize stuck jobs |
| 5   | SQS             | BLOCKING | Visibility timeout 900 s → 2100 s |
| 6   | CDK deploy      | BLOCKING | NetworkStack write VPC SSM params |
| 7   | CDK deploy      | BLOCKING | `LambdaStack.addDependency(ecsStack)` |
| 8   | CDK deploy      | BLOCKING | OpenSearch index bootstrap Custom Resource; remove `number_of_replicas` |
| 9   | CDK synth       | BLOCKING | Encrypted log groups for Lambda and VPC flow logs |
| 10  | IAM             | BLOCKING | `QueryLambdaRole` add `kms:Decrypt` |
| 11  | CDK deploy      | BLOCKING | S3 event notification → `NotificationStack` to break circular dep |
| 12  | Multi-tenant    | BLOCKING | `list-jobs` add `userArn` filter; MCP switch to `GSI2-User` |
| 13  | Multi-tenant    | BLOCKING | `status` + `results` commands add ownership check |
| 14  | Security        | BLOCKING | Envelope encryption context add `userArn` |
| 15  | Security        | BLOCKING | `indexJobResult` write `user_arn` + `s3_result_key` to OpenSearch |
| 16  | Security        | BLOCKING | `hybridSearch` add `post_filter`; remove `adminOverride` |
| 17  | IAM             | BLOCKING | MCP Lambda `KMSDecrypt` replace `Resource: '*'` with specific key ARNs |
| 18  | Bedrock/AOSS    | BLOCKING | Retry wrapper for `getEmbedding`, `client.index`, ECS claude spawn; fix `MAX_INPUT_CHARS` |
| 19  | DynamoDB        | BLOCKING | Retry `UpdateItem` on write throttle in `ResultsProcessorLambda` + ECS runner |
| 20  | Cost control    | BLOCKING | ECS concurrency cap before `RunTask`; CloudWatch alarm at 90% |
| 21  | Skill registry  | BLOCKING | `latestVersion` update with optimistic lock condition |
| 22  | ECS runner      | CORRECTNESS | `extractor.ts` await all `writeFile` promises before resolve |
| 23  | IAM             | CORRECTNESS | `RunSkillLambda` remove `GenerateDataKey` on registry key; add `GetObjectVersion` |
| 24  | Security        | BLOCKING | Route query Lambda through API Gateway with IAM auth for server-side identity |
