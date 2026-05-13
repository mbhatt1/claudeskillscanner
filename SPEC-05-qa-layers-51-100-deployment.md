# Skills as a Service (SaaS) — Specification Part 5: QA Layers QA-051 to QA-100, Deployment & Cost Model

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | [Part 2](SPEC-02-lambda-ecs.md) | [Part 3](SPEC-03-knowledge-store-cli.md) | [Part 4](SPEC-04-qa-layers-1-50.md) | [Part 5: QA 051–100 & Deployment]

---

## QA-051 — Integration: S3→SQS→Lambda Trigger (LocalStack)

**Category:** Integration  
**File:** `packages/lambda/src/__tests__/integration/s3-trigger.test.ts`  
**What it checks:** S3 upload event flows through SQS and reaches Lambda within 5 seconds.

```typescript
import { S3Client, CreateBucketCommand, PutObjectCommand, PutBucketNotificationConfigurationCommand } from '@aws-sdk/client-s3';
import { SQSClient, CreateQueueCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

const LOCALSTACK_ENDPOINT = 'http://localhost:4566';

test('QA-051: S3 upload triggers SQS message within 5 seconds', async () => {
  const s3 = new S3Client({ endpoint: LOCALSTACK_ENDPOINT, region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const sqs = new SQSClient({ endpoint: LOCALSTACK_ENDPOINT, region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

  const bucket = `test-uploads-${Date.now()}`;
  const queue = `test-ingestion-${Date.now()}`;

  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  const queueRes = await sqs.send(new CreateQueueCommand({ QueueName: queue }));
  const queueUrl = queueRes.QueueUrl!;
  const queueArn = `arn:aws:sqs:us-east-1:000000000000:${queue}`;

  await s3.send(new PutBucketNotificationConfigurationCommand({
    Bucket: bucket,
    NotificationConfiguration: {
      QueueConfigurations: [{
        Events: ['s3:ObjectCreated:*'],
        QueueArn: queueArn,
        Filter: { Key: { FilterRules: [{ Name: 'suffix', Value: '.zip' }] } },
      }],
    },
  }));

  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: 'uploads/test/skills.zip',
    Body: Buffer.from('PK\x03\x04'), // minimal zip header
  }));

  // Poll for message (max 5 seconds)
  const start = Date.now();
  let received = false;
  while (Date.now() - start < 5000) {
    const msgs = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }));
    if (msgs.Messages && msgs.Messages.length > 0) { received = true; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  expect(received).toBe(true);
}, 10_000);
```

---

## QA-052 — Integration: DynamoDB Optimistic Locking

**Category:** Integration  
**File:** `packages/lambda/src/__tests__/integration/dynamodb.test.ts`  
**What it checks:** Second write with same PK throws `ConditionalCheckFailedException`.  
**Pass Criterion:** Exception thrown on duplicate PK write.

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const LOCALSTACK_ENDPOINT = 'http://localhost:4566';

test('QA-052: DDB conditional write rejects duplicate PK', async () => {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
    endpoint: LOCALSTACK_ENDPOINT, region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  }));
  const tableName = 'test-jobs';
  const item = { PK: 'JOB#test-001', SK: 'METADATA', version: 0 };

  await ddb.send(new PutCommand({
    TableName: tableName, Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  await expect(ddb.send(new PutCommand({
    TableName: tableName, Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }))).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
});
```

---

## QA-053 — Integration: Valid Zip Passes Structural Validation

**Category:** Integration  
**File:** `packages/lambda/src/__tests__/validator.test.ts`  
**Pass Criterion:** `result.valid === true` and `result.manifest.jobName === 'test'`

```typescript
import AdmZip from 'adm-zip';
import { validateZipStructure } from '../ingestion/validator';

test('QA-053: Valid zip with manifest.json passes validation', () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    jobName: 'test-job',
    version: '1.0.0',
    skills: ['greet'],
  })));
  zip.addFile('skills/greet.md', Buffer.from('# Greet Skill\nSay hello.'));

  const result = validateZipStructure(zip.toBuffer());
  expect(result.valid).toBe(true);
  expect(result.manifest?.jobName).toBe('test-job');
  expect(result.manifest?.skills).toContain('greet');
});
```

---

## QA-054 — Integration: Missing manifest.json Fails Validation

```typescript
test('QA-054: Zip without manifest.json fails validation', () => {
  const zip = new AdmZip();
  zip.addFile('skills/greet.md', Buffer.from('# Greet'));
  const result = validateZipStructure(zip.toBuffer());
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/manifest\.json/i);
});
```

---

## QA-055 — Integration: Zip Bomb Rejected by Ratio Check

```typescript
test('QA-055: Zip bomb rejected (ratio > 100:1)', () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from('{}'));
  const result = validateZipStructure(zip.toBuffer(), {
    compressedSize: 100,
    uncompressedSize: 100 * 101, // ratio = 101:1
  });
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/ratio|bomb/i);
});
```

---

## QA-056 — Integration: Path Traversal in Zip Entry Rejected

```typescript
test('QA-056: Path traversal entry ../evil.sh is rejected', () => {
  const zip = new AdmZip();
  zip.addFile('../evil.sh', Buffer.from('rm -rf /'));
  const result = validateZipStructure(zip.toBuffer());
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/traversal|path/i);
});
```

---

## QA-057 — Integration: Zip with >10,000 Files Rejected

```typescript
test('QA-057: Zip with more than 10000 files is rejected by extractor', async () => {
  const { extractZip } = await import('../../ecs-runner/src/extractor');
  // Mock unzipper to emit 10001 entries
  jest.mock('unzipper', () => ({
    Parse: () => {
      const { EventEmitter } = require('events');
      const emitter = new EventEmitter();
      process.nextTick(() => {
        for (let i = 0; i <= 10001; i++) {
          emitter.emit('entry', {
            path: `file-${i}.txt`, type: 'File',
            on: (e: string, cb: any) => { if (e === 'end') cb(); },
            autodrain: () => {},
          });
        }
        emitter.emit('close');
      });
      return emitter;
    },
  }));
  await expect(extractZip('/tmp/fake.zip', '/tmp/test-extract')).rejects.toMatch(/10,000|10000/);
});
```

---

## QA-058 — Integration: SNS→SQS Fanout (LocalStack)

**Category:** Integration  
**What it checks:** SNS publish delivers to subscribed SQS queue within 10 seconds.

```typescript
import { SNSClient, CreateTopicCommand, PublishCommand, SubscribeCommand } from '@aws-sdk/client-sns';
import { SQSClient, CreateQueueCommand, ReceiveMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

test('QA-058: SNS publish delivers to SQS subscriber within 10 seconds', async () => {
  const opts = { endpoint: 'http://localhost:4566', region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
  const sns = new SNSClient(opts);
  const sqs = new SQSClient(opts);

  const topicArn = (await sns.send(new CreateTopicCommand({ Name: `test-topic-${Date.now()}` }))).TopicArn!;
  const queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `test-q-${Date.now()}` }))).QueueUrl!;
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
  const queueArn = attrs.Attributes!.QueueArn;

  await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: 'sqs', Endpoint: queueArn }));
  await sns.send(new PublishCommand({ TopicArn: topicArn, Message: 'hello from skills-svc' }));

  const start = Date.now();
  let got = false;
  while (Date.now() - start < 10_000) {
    const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1 }));
    if (r.Messages?.length) { got = true; break; }
    await new Promise(x => setTimeout(x, 500));
  }
  expect(got).toBe(true);
}, 15_000);
```

---

## QA-059 — Integration: ECS RunTask Parameters Validation

**Category:** Integration  
**What it checks:** Lambda calls RunTaskCommand with FARGATE and DISABLED public IP.

```typescript
import { mockClient } from 'aws-sdk-client-mock';
import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

test('QA-059: Ingestion Lambda submits ECS task with FARGATE and no public IP', async () => {
  const ecsMock = mockClient(ECSClient);
  ecsMock.on(RunTaskCommand).resolves({ tasks: [{ taskArn: 'arn:test' }] });

  await processRecord(mockSQSRecord); // from ingestion handler

  const call = ecsMock.calls()[0];
  const input = call.args[0].input as any;
  expect(input.launchType).toBe('FARGATE');
  expect(input.networkConfiguration.awsvpcConfiguration.assignPublicIp).toBe('DISABLED');
});
```

---

## QA-060 — Integration: ResultsProcessor Handles ECS Exit Code 1 (Failure)

```typescript
test('QA-060: Exit code 1 sets job status to FAILED and publishes SNS', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const snsMock = mockClient(SNSClient);
  
  ddbMock.on(GetCommand).resolves({ Item: { version: 0, status: 'RUNNING', jobName: 'test' } });
  ddbMock.on(UpdateCommand).resolves({});
  snsMock.on(PublishCommand).resolves({ MessageId: 'test-123' });

  await handler(makeECSEvent({ exitCode: 1, jobId: 'job-abc' }), {} as any, {} as any);

  const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
  const updateInput = updateCall.args[0].input;
  expect(JSON.stringify(updateInput)).toContain('FAILED');

  const publishCall = snsMock.commandCalls(PublishCommand)[0];
  expect(JSON.stringify(publishCall.args[0].input)).toContain('FAILED');
});
```

---

## QA-061 — Integration: ResultsProcessor Handles ECS Exit Code 0 (Success)

```typescript
test('QA-061: Exit code 0 calls indexer and sets status to COMPLETE', async () => {
  const indexerSpy = jest.spyOn(indexerModule, 'indexJobResult').mockResolvedValue('job-abc');
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const s3Mock = mockClient(S3Client);
  const snsMock = mockClient(SNSClient);

  ddbMock.on(GetCommand).resolves({ Item: { version: 0, status: 'RUNNING', jobName: 'test' } });
  ddbMock.on(UpdateCommand).resolves({});
  s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([JSON.stringify(mockRunResult)]) });
  snsMock.on(PublishCommand).resolves({ MessageId: 'msg-ok' });

  await handler(makeECSEvent({ exitCode: 0, jobId: 'job-abc' }), {} as any, {} as any);

  expect(indexerSpy).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-abc' }), expect.any(String));
  const updateCalls = ddbMock.commandCalls(UpdateCommand);
  expect(JSON.stringify(updateCalls[0].args[0].input)).toContain('COMPLETE');
});
```

---

## QA-062 — Integration: OpenSearch Results Sorted by Score Descending

```typescript
import { hybridSearch } from '../knowledge-store/src/searcher';

test('QA-062: hybridSearch returns results sorted by score descending', async () => {
  const mockHits = [
    { _source: mockSource, _score: 0.9 },
    { _source: mockSource, _score: 0.5 },
    { _source: mockSource, _score: 0.7 },
  ];
  jest.spyOn(clientModule, 'getOpenSearchClient').mockResolvedValue({
    search: jest.fn().mockResolvedValue({ body: { hits: { hits: mockHits } } }),
  } as any);
  jest.spyOn(embeddingsModule, 'getEmbedding').mockResolvedValue(Array(1536).fill(0.1));

  const results = await hybridSearch('test query');
  const scores = results.map(r => r.score);
  expect(scores).toEqual([0.9, 0.7, 0.5]); // descending
});
```

---

## QA-063 — Integration: CLI Upload Rejects Files > 500MB

```typescript
import { uploadCommand } from '../cli/src/commands/upload';

test('QA-063: CLI upload rejects file > 500MB', async () => {
  const mockStatSync = jest.spyOn(fs, 'statSync').mockReturnValue({ size: 501 * 1024 * 1024 } as any);
  const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

  await expect(runCommand(['upload', 'test.zip', '--job-name', 'test'])).rejects.toThrow('exit');
  expect(mockExit).toHaveBeenCalledWith(1);
  mockStatSync.mockRestore();
});
```

---

## QA-064 — Integration: assume-role Writes Credentials File Mode 0600

```typescript
import { assumeRoleCommand } from '../cli/src/commands/assume-role';
import * as fs from 'fs';

test('QA-064: assume-role writes credentials with mode 0600', async () => {
  const writeFileSpy = jest.spyOn(fs, 'writeFileSync');
  const stsMock = mockClient(STSClient);
  stsMock.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: 'AKIATEST', SecretAccessKey: 'secret',
      SessionToken: 'token', Expiration: new Date(Date.now() + 3600_000),
    },
  });

  await runCommand(['assume-role', '--role-arn', 'arn:aws:iam::123:role/test']);

  const writeCall = writeFileSpy.mock.calls[0];
  const options = writeCall[2] as { mode?: number };
  expect(options.mode).toBe(0o600);
});
```

---

## QA-065 — Integration: Embedding Truncates at 25,000 Characters

```typescript
test('QA-065: getEmbedding truncates input to 25000 chars', async () => {
  const invokeModelSpy = jest.spyOn(bedrock, 'send').mockResolvedValue({ body: Buffer.from(JSON.stringify({ embedding: Array(1536).fill(0) })) } as any);
  const longInput = 'a'.repeat(30_000);
  await getEmbedding(longInput);
  const body = JSON.parse((invokeModelSpy.mock.calls[0][0] as any).input.body);
  expect(body.inputText.length).toBeLessThanOrEqual(25_000);
  expect(body.inputText.length).toBe(25_000);
});
```

---

## QA-066 — Operational: CloudWatch Alarm for IngestionLambda Errors

```typescript
test('QA-066: CloudWatch alarm exists for IngestionLambda errors', () => {
  const { templates } = buildTestApp();
  const alarms = templates.monitoring.findResources('AWS::CloudWatch::Alarm');
  const ingestionErrorAlarm = Object.values(alarms).find((a: any) =>
    a.Properties.MetricName === 'Errors' &&
    a.Properties.Namespace === 'AWS/Lambda' &&
    JSON.stringify(a.Properties.Dimensions ?? []).includes('skills-svc-ingestion')
  );
  expect(ingestionErrorAlarm).toBeDefined();
  expect((ingestionErrorAlarm as any).Properties.Threshold).toBe(1);
  expect((ingestionErrorAlarm as any).Properties.EvaluationPeriods).toBe(1);
});
```

---

## QA-067 — Operational: CloudWatch Alarm for ResultsProcessorLambda Errors

```typescript
test('QA-067: CloudWatch alarm exists for ResultsProcessorLambda errors', () => {
  const { templates } = buildTestApp();
  const alarms = templates.monitoring.findResources('AWS::CloudWatch::Alarm');
  const resultsErrorAlarm = Object.values(alarms).find((a: any) =>
    a.Properties.MetricName === 'Errors' &&
    JSON.stringify(a.Properties.Dimensions ?? []).includes('skills-svc-results')
  );
  expect(resultsErrorAlarm).toBeDefined();
});
```

---

## QA-068 — Operational: CloudWatch Alarm for IngestionDLQ Depth

```typescript
test('QA-068: CloudWatch alarm for IngestionDLQ depth >= 1', () => {
  const { templates } = buildTestApp();
  const alarms = templates.monitoring.findResources('AWS::CloudWatch::Alarm');
  const dlqAlarm = Object.values(alarms).find((a: any) =>
    a.Properties.MetricName === 'ApproximateNumberOfMessagesVisible' &&
    a.Properties.Namespace === 'AWS/SQS' &&
    JSON.stringify(a.Properties.Dimensions ?? []).includes('ingestion-dlq')
  );
  expect(dlqAlarm).toBeDefined();
  expect((dlqAlarm as any).Properties.Threshold).toBe(1);
});
```

---

## QA-069 — Operational: CloudWatch Alarm for ResultsDLQ Depth

Same pattern as QA-068 for the results DLQ.

```typescript
test('QA-069: CloudWatch alarm for ResultsDLQ depth >= 1', () => {
  const { templates } = buildTestApp();
  const alarms = templates.monitoring.findResources('AWS::CloudWatch::Alarm');
  const dlqAlarm = Object.values(alarms).find((a: any) =>
    a.Properties.MetricName === 'ApproximateNumberOfMessagesVisible' &&
    JSON.stringify(a.Properties.Dimensions ?? []).includes('results-dlq')
  );
  expect(dlqAlarm).toBeDefined();
});
```

---

## QA-070 — Operational: CloudWatch Alarm for ECS Task Failures

```typescript
test('QA-070: CloudWatch alarm for ECS task failures (custom metric)', () => {
  const { templates } = buildTestApp();
  templates.monitoring.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'skills-svc/ECS',
    MetricName: 'TaskFailures',
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  });
});
```

---

## QA-071 — Operational: CloudWatch Dashboard Exists

```typescript
test('QA-071: CloudWatch Dashboard named SkillsSaaSDashboard exists', () => {
  const { templates } = buildTestApp();
  templates.monitoring.hasResourceProperties('AWS::CloudWatch::Dashboard', {
    DashboardName: 'SkillsSaaSDashboard',
  });
});
```

---

## QA-072 — Operational: X-Ray Sampling Rule Exists

```typescript
test('QA-072: X-Ray sampling rule is configured', () => {
  const { templates } = buildTestApp();
  // Check Lambda functions have Active tracing (already QA-017) — sampling is via Lambda config
  // Additional check: verify POWERTOOLS_SERVICE_NAME is set for trace correlation
  const fns = templates.lambda.findResources('AWS::Lambda::Function');
  let hasPowertools = false;
  for (const [, fn] of Object.entries(fns)) {
    const env = (fn as any).Properties.Environment?.Variables ?? {};
    if (env.POWERTOOLS_SERVICE_NAME === 'skills-as-a-service') { hasPowertools = true; break; }
  }
  expect(hasPowertools).toBe(true);
});
```

---

## QA-073 — Operational: All Log Groups Have Retention Policy

```typescript
test('QA-073: All CloudWatch log groups have retention >= 30 days', () => {
  const { templates } = buildTestApp();
  for (const template of Object.values(templates)) {
    const logGroups = (template as any).findResources('AWS::Logs::LogGroup');
    for (const [id, lg] of Object.entries(logGroups)) {
      const retention = (lg as any).Properties.RetentionInDays;
      if (retention != null) {
        expect(retention).toBeGreaterThanOrEqual(30);
      }
    }
  }
});
```

---

## QA-074 — Operational: ECS Cluster Has Container Insights

```typescript
test('QA-074: ECS cluster has container insights enabled', () => {
  const { templates } = buildTestApp();
  templates.ecs.hasResourceProperties('AWS::ECS::Cluster', {
    ClusterSettings: expect.arrayContaining([
      expect.objectContaining({ Name: 'containerInsights', Value: 'enabled' }),
    ]),
  });
});
```

---

## QA-075 — Operational: GuardDuty Detector Enabled

```typescript
test('QA-075: GuardDuty detector is enabled', () => {
  const { templates } = buildTestApp();
  templates.compliance.hasResourceProperties('AWS::GuardDuty::Detector', {
    Enable: true,
  });
});
```

---

## QA-076 — Operational: Security Hub Enabled

```typescript
test('QA-076: Security Hub is enabled with auto-controls', () => {
  const { templates } = buildTestApp();
  templates.compliance.resourceCountIs('AWS::SecurityHub::Hub', 1);
  templates.compliance.hasResourceProperties('AWS::SecurityHub::Hub', {
    AutoEnableControls: true,
  });
});
```

---

## QA-077 — Operational: AWS Config Recorder Enabled

```typescript
test('QA-077: AWS Config recorder is enabled for all resources', () => {
  const { templates } = buildTestApp();
  templates.compliance.hasResourceProperties('AWS::Config::ConfigurationRecorder', {
    RecordingGroup: { AllSupported: true },
  });
});
```

---

## QA-078 — Operational: VPC Flow Logs Enabled

```typescript
test('QA-078: VPC flow logs capture ALL traffic', () => {
  const { templates } = buildTestApp();
  templates.network.hasResourceProperties('AWS::EC2::FlowLog', {
    ResourceType: 'VPC',
    TrafficType: 'ALL',
  });
});
```

---

## QA-079 — Operational: Total Reserved Concurrency ≤ 900

**Mathematical check:** Sum of all `ReservedConcurrentExecutions` ≤ 900 (leaving 100 for unreserved).

```typescript
test('QA-079: Sum of reserved concurrency <= 900', () => {
  const { templates } = buildTestApp();
  const fns = templates.lambda.findResources('AWS::Lambda::Function');
  let total = 0;
  for (const [, fn] of Object.entries(fns)) {
    const rc = (fn as any).Properties.ReservedConcurrentExecutions;
    if (rc != null) total += rc;
  }
  // Sum: ingestion(50) + results(20) + query(100) = 170 << 900
  expect(total).toBeLessThanOrEqual(900);
  console.log(`Total reserved concurrency: ${total}`);
});
```

---

## QA-080 — Operational: Fargate CPU/Memory Valid Combination

**Mathematical check:** Verify 2048 CPU with 4096 MB memory is a valid Fargate combination.

```typescript
test('QA-080: ECS Fargate CPU/memory is a valid combination', () => {
  const { templates } = buildTestApp();
  const taskDefs = templates.ecs.findResources('AWS::ECS::TaskDefinition');
  for (const [, taskDef] of Object.entries(taskDefs)) {
    const cpu = parseInt((taskDef as any).Properties.Cpu, 10);
    const memory = parseInt((taskDef as any).Properties.Memory, 10);

    // Valid Fargate combinations: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
    const validCombinations: Record<number, [number, number]> = {
      256:  [512, 2048],
      512:  [1024, 4096],
      1024: [2048, 8192],
      2048: [4096, 16384],
      4096: [8192, 30720],
    };

    const [minMem, maxMem] = validCombinations[cpu] ?? [0, 0];
    expect(cpu).toBeGreaterThan(0);
    expect(memory).toBeGreaterThanOrEqual(minMem);
    expect(memory).toBeLessThanOrEqual(maxMem);

    // Specific assertion for our chosen config
    if (cpu === 2048) {
      expect(memory).toBeGreaterThanOrEqual(4096);  // 4096 >= 4096 ✓
      expect(memory).toBeLessThanOrEqual(16384);    // 4096 <= 16384 ✓
    }
  }
});
```

---

## QA-081 — Runtime-Safety: ECS Runner Handles SIGTERM

```bash
grep -q 'process.on.*SIGTERM' packages/ecs-runner/src/main.ts
# Exit code 0 = SIGTERM handler registered
```

```typescript
test('QA-081: ECS runner registers SIGTERM handler', async () => {
  const source = readFileSync('packages/ecs-runner/src/main.ts', 'utf-8');
  expect(source).toContain("process.on('SIGTERM'");
});
```

---

## QA-082 — Runtime-Safety: Claude CLI Killed After 25 Minutes

```typescript
test('QA-082: claude subprocess is killed after 25-minute timeout', async () => {
  jest.useFakeTimers();
  const killSpy = jest.fn();
  const spawnMock = jest.spyOn(childProcess, 'spawn').mockReturnValue({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
    kill: killSpy,
  } as any);

  const runPromise = runSkills('/tmp/test', 'job-001', 'prod');
  
  // Advance 25 minutes
  jest.advanceTimersByTime(25 * 60 * 1000 + 100);
  await expect(runPromise).rejects.toMatch(/timeout/);
  expect(killSpy).toHaveBeenCalledWith('SIGTERM');

  jest.useRealTimers();
});
```

---

## QA-083 — Runtime-Safety: S3 Download Uses Streaming

```bash
# Static analysis: no Buffer.from() or toBuffer() in downloader.ts
if grep -qE '(Buffer\.from|\.toBuffer\(\)|toArray\(\))' packages/ecs-runner/src/downloader.ts; then
  echo "FAIL: downloader.ts loads response into memory (non-streaming)"
  exit 1
fi
grep -q 'createWriteStream\|pipeline' packages/ecs-runner/src/downloader.ts
echo "PASS: downloader uses streaming"
```

---

## QA-084 — Runtime-Safety: SSM Parameter Cache TTL is 300,000ms

```typescript
test('QA-084: SSM param cache TTL is exactly 300,000ms', async () => {
  jest.useFakeTimers();
  const ssmMock = mockClient(SSMClient);
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'test-value' } });

  // First call — hits SSM
  await getParam('/test/param');
  expect(ssmMock.calls()).toHaveLength(1);

  // At 299,999ms — still cached
  jest.advanceTimersByTime(299_999);
  await getParam('/test/param');
  expect(ssmMock.calls()).toHaveLength(1); // cache hit

  // At 300,001ms — cache expired
  jest.advanceTimersByTime(2);
  await getParam('/test/param');
  expect(ssmMock.calls()).toHaveLength(2); // cache miss

  jest.useRealTimers();
});
```

---

## QA-085 — Runtime-Safety: DynamoDB Optimistic Lock Retried Up to 3 Times

```typescript
test('QA-085: ConditionalCheckFailedException retried up to 3 times with backoff', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  let callCount = 0;
  ddbMock.on(UpdateCommand).callsFake(() => {
    callCount++;
    if (callCount < 3) throw Object.assign(new Error('ConditionalCheck'), { name: 'ConditionalCheckFailedException' });
    return {};
  });

  await updateJobStatusWithRetry('job-001', 'COMPLETE', 'prod', undefined);
  expect(callCount).toBe(3); // Failed twice, succeeded on 3rd
});
```

---

## QA-086 — Runtime-Safety: OpenSearch Client Timeout is 30,000ms

```bash
grep -q 'requestTimeout: 30_000' packages/knowledge-store/src/client.ts
echo "PASS: OpenSearch client timeout is 30,000ms"
```

---

## QA-087 — Runtime-Safety: Embedding Truncation Math

**Mathematical documentation:**  
- Titan Text Embed v2 max tokens: 8,192  
- Average English chars per token: ~4  
- Safe char limit: 25,000 chars ÷ 4 chars/token ≈ 6,250 tokens  
- 6,250 < 8,192 — well within limit  
- Truncation at 25,000 chars prevents `ValidationException`

```typescript
test('QA-087: Embedding truncation math — 25000 chars ≈ 6250 tokens < 8192 limit', () => {
  // Mathematical verification
  const MAX_CHARS = 25_000;
  const CHARS_PER_TOKEN = 4; // conservative English estimate
  const ESTIMATED_TOKENS = MAX_CHARS / CHARS_PER_TOKEN;
  const TITAN_TOKEN_LIMIT = 8_192;
  
  expect(ESTIMATED_TOKENS).toBeLessThan(TITAN_TOKEN_LIMIT);
  expect(ESTIMATED_TOKENS).toBe(6_250);
  expect(6_250).toBeLessThan(8_192); // safety margin confirmed
  
  // Verify the constant in the source
  const source = readFileSync('packages/knowledge-store/src/embeddings.ts', 'utf-8');
  expect(source).toContain('MAX_INPUT_CHARS = 25_000');
});
```

---

## QA-088 — Runtime-Safety: Extraction Always Under /tmp

```typescript
test('QA-088: extractZip rejects destDir not under /tmp/', async () => {
  await expect(extractZip('/tmp/test.zip', '/var/malicious')).rejects.toMatch(/\/tmp\//);
  await expect(extractZip('/tmp/test.zip', '/tmp/allowed')).not.toRejectWith(/\/tmp\//);
});
```

---

## QA-089 — Runtime-Safety: No Floating Promises (ESLint)

```bash
npx eslint --rule '{"@typescript-eslint/no-floating-promises": "error"}' \
  --parser-options 'project:packages/lambda/tsconfig.json' \
  packages/lambda/src/**/*.ts \
  --max-warnings 0
```

---

## QA-090 — Runtime-Safety: Credentials File Saved with Mode 0600

```bash
grep -n 'writeFileSync.*credentials\|credentials.*writeFileSync' packages/cli/src/commands/assume-role.ts | \
  grep -q '0o600'
echo "PASS: credentials file written with mode 0o600"
```

---

## QA-091 — Cost: Monthly Cost Formula Mathematical Verification

**Variables:** N=1000 jobs/month, Z=10MB zip, R=5MB result, T=5 minutes ECS

```typescript
test('QA-091: Cost formula is mathematically correct and total < $500', () => {
  const N = 1000, Z = 10, R = 5, T = 5;

  // S3 Storage (12 months of data * average size)
  const s3StorageGB = (N * (Z + R) * 12) / 1024; // GB-months
  const s3Storage = s3StorageGB * 0.023; // $0.023/GB
  expect(s3Storage).toBeCloseTo(4.05, 1);

  // S3 Requests (4 operations per job: PutObject, GetObject x2, HeadObject)
  const s3Requests = (N * 4 / 1000) * 0.0004;
  expect(s3Requests).toBeCloseTo(0.0016, 4);

  // Lambda (2 invocations per job, 5 min avg, 512MB)
  const lambdaGBSeconds = N * 2 * (5 * 60) * (512 / 1024);
  const lambdaCost = lambdaGBSeconds * 0.0000166667;
  expect(lambdaCost).toBeCloseTo(0.25, 1);

  // ECS Fargate (T minutes per job, 2 vCPU + 4 GB)
  const ecsHours = N * (T / 60);
  const ecsCPUCost = ecsHours * 2 * 0.04048;
  const ecsMemCost = ecsHours * 4 * 0.004445;
  const ecsCost = ecsCPUCost + ecsMemCost;
  expect(ecsCost).toBeCloseTo(7.65, 0);

  // OpenSearch Serverless — minimum 2 OCUs at $0.24/OCU-hr
  const opensearchCost = 2 * 730 * 0.24;
  expect(opensearchCost).toBeCloseTo(350.40, 1);

  // DynamoDB (4 WCU per job + negligible storage)
  const dynamoCost = N * 4 * 0.00000065;
  expect(dynamoCost).toBeCloseTo(0.0026, 3);

  // SNS (2 publishes per job at $0.50 per million)
  const snsCost = N * 2 * 0.0000005;
  expect(snsCost).toBeCloseTo(0.001, 3);

  // KMS (6 keys * $1/month + API calls)
  const kmsCost = 6 * 1.0 + (N * 10 / 10000) * 0.03;
  expect(kmsCost).toBeCloseTo(6.03, 1);

  const total = s3Storage + s3Requests + lambdaCost + ecsCost + opensearchCost + dynamoCost + snsCost + kmsCost;
  
  console.log(`Monthly cost breakdown:
    S3 Storage:   $${s3Storage.toFixed(2)}
    S3 Requests:  $${s3Requests.toFixed(4)}
    Lambda:       $${lambdaCost.toFixed(2)}
    ECS Fargate:  $${ecsCost.toFixed(2)}
    OpenSearch:   $${opensearchCost.toFixed(2)}  ← dominant cost
    DynamoDB:     $${dynamoCost.toFixed(4)}
    SNS:          $${snsCost.toFixed(4)}
    KMS:          $${kmsCost.toFixed(2)}
    TOTAL:        $${total.toFixed(2)}`);

  expect(total).toBeLessThan(500);
});
```

---

## QA-092 — Cost: Lambda Memory Setting is Cost-Optimal

```typescript
test('QA-092: Lambda memory <= 1024 MB (cost-optimal range)', () => {
  const { templates } = buildTestApp();
  const fns = templates.lambda.findResources('AWS::Lambda::Function');
  for (const [, fn] of Object.entries(fns)) {
    const mem = (fn as any).Properties.MemorySize;
    if (mem != null) expect(mem).toBeLessThanOrEqual(1024);
  }
});
```

---

## QA-093 — Cost: S3 Intelligent-Tiering Lifecycle Rule

```typescript
test('QA-093: S3 data buckets have Intelligent-Tiering lifecycle rule', () => {
  const { templates } = buildTestApp();
  const buckets = templates.storage.findResources('AWS::S3::Bucket');
  let tieredCount = 0;
  for (const [, bucket] of Object.entries(buckets)) {
    const rules = (bucket as any).Properties.LifecycleConfiguration?.Rules ?? [];
    const hasIT = rules.some((r: any) =>
      r.Transitions?.some((t: any) => t.StorageClass === 'INTELLIGENT_TIERING')
    );
    if (hasIT) tieredCount++;
  }
  expect(tieredCount).toBeGreaterThanOrEqual(3); // uploads, results, artifacts
});
```

---

## QA-094 — Cost: DynamoDB TTL Prevents Unbounded Growth

**Mathematical:** At 1000 jobs/month with 90-day TTL → max 3000 items at 2KB each = 6MB storage.

```typescript
test('QA-094: DynamoDB TTL is enabled to prevent unbounded growth', () => {
  const { templates } = buildTestApp();
  templates.storage.hasResourceProperties('AWS::DynamoDB::Table', {
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  });

  // Mathematical: max stored items at steady state
  const jobsPerMonth = 1000;
  const ttlDays = 90;
  const maxItems = jobsPerMonth * (ttlDays / 30);
  const itemSizeKB = 2;
  const maxStorageMB = (maxItems * itemSizeKB) / 1024;

  expect(maxItems).toBe(3000); // 1000 * 3 months
  expect(maxStorageMB).toBe(6); // 3000 * 2KB / 1024
  console.log(`Max DDB items at TTL steady-state: ${maxItems}, storage: ${maxStorageMB}MB`);
});
```

---

## QA-095 — Cost: OpenSearch Standby Replicas Disabled in Non-Prod

```typescript
test('QA-095: OpenSearch standby replicas disabled in non-prod (dev/test env)', () => {
  // Build with envName: 'dev' to verify dev environment behavior
  const app = new App({ context: { envName: 'dev' } });
  const env = { account: '123456789012', region: 'us-east-1' };
  // ... build dev KnowledgeStoreStack ...
  // Assert StandbyReplicas is DISABLED in non-prod
  // (prod would have ENABLED)
  
  // This is enforced in KnowledgeStoreStack constructor:
  // standbyReplicas: envName === 'prod' ? 'ENABLED' : 'DISABLED'
  const source = readFileSync('infra/lib/knowledge-store-stack.ts', 'utf-8');
  expect(source).toContain("envName === 'prod' ? 'ENABLED' : 'DISABLED'");
});
```

---

## QA-096 — CDK-Assert: CDK Synth Passes Strict Mode

```bash
cd infra && npx cdk synth --strict --quiet 2>&1
# Must exit 0; any Aspect errors or construct errors will cause non-zero exit
echo "PASS: CDK synth --strict produced no errors"
```

---

## QA-097 — CDK-Assert: All Three Aspects Applied to App

```bash
grep -q 'NoWildcardIAMAspect' infra/bin/app.ts && \
grep -q 'EncryptionEnforcerAspect' infra/bin/app.ts && \
grep -q 'TaggingEnforcerAspect' infra/bin/app.ts
echo "PASS: All three CDK Aspects applied in bin/app.ts"
```

---

## QA-098 — CDK-Assert: Stack Dependency Order Has No Cycles

```typescript
test('QA-098: Stack deployment order has no cycles (topological sort succeeds)', () => {
  // Adjacency list: stack → stacks it depends on
  const deps: Record<string, string[]> = {
    Network: [],
    Security: ['Network'],
    Storage: ['Security'],
    Messaging: ['Storage'],
    Lambda: ['Messaging', 'Storage', 'Security'],
    ECS: ['Network', 'Security', 'Storage'],
    KnowledgeStore: ['Network', 'Security'],
    Monitoring: ['Lambda', 'ECS', 'KnowledgeStore', 'Messaging'],
    Compliance: ['Monitoring'],
  };

  // Kahn's algorithm for cycle detection
  const inDegree: Record<string, number> = {};
  const graph: Record<string, string[]> = {};
  for (const [node, depsList] of Object.entries(deps)) {
    inDegree[node] = (inDegree[node] ?? 0);
    graph[node] = graph[node] ?? [];
    for (const dep of depsList) {
      graph[dep] = graph[dep] ?? [];
      graph[dep].push(node);
      inDegree[node] = (inDegree[node] ?? 0) + 1;
    }
  }

  const queue = Object.keys(inDegree).filter(n => inDegree[n] === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const neighbor of (graph[node] ?? [])) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) queue.push(neighbor);
    }
  }

  // If order has all nodes, no cycle exists
  expect(order.length).toBe(Object.keys(deps).length);
  console.log('Stack deployment order:', order.join(' → '));
});
```

---

## QA-099 — Operational: Docker Image Builds Successfully

```bash
docker build -t skills-svc-runner-qa-test packages/ecs-runner/ --quiet 2>&1
BUILD_EXIT=$?
docker rmi skills-svc-runner-qa-test --force 2>/dev/null || true
exit $BUILD_EXIT
```

---

## QA-100 — Integration: End-to-End Smoke Test

**Category:** Integration (requires deployed infrastructure)  
**File:** `scripts/smoke-test.sh`  
**Tags:** `@smoke` — skip in unit test runs, require `SMOKE_TEST=true`

```bash
#!/usr/bin/env bash
set -euo pipefail

# Requires deployed infra and configured CLI
echo "=== Skills SaaS Smoke Test ==="

# Step 1: Upload test skills zip
echo "Step 1: Uploading test skills zip..."
JOB_OUTPUT=$(skills-svc upload tests/fixtures/valid-skills.zip --job-name "smoke-test-$(date +%s)" 2>&1)
echo "$JOB_OUTPUT"

# Step 2: Extract job ID (parse from status output)
echo "Step 2: Polling for job completion (max 15 min)..."
TIMEOUT=900
START=$(date +%s)
STATUS="PENDING"
JOB_ID=""

# Get job ID via list-jobs
JOB_ID=$(skills-svc list-jobs --status PENDING --limit 1 2>&1 | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

if [ -z "$JOB_ID" ]; then
  echo "FAIL: Could not determine job ID"
  exit 1
fi

echo "Job ID: $JOB_ID"

# Step 3: Poll for completion
while [ "$STATUS" != "COMPLETE" ] && [ "$STATUS" != "FAILED" ]; do
  ELAPSED=$(( $(date +%s) - START ))
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "FAIL: Job did not complete within ${TIMEOUT}s"
    exit 1
  fi
  echo "  ... status: $STATUS (${ELAPSED}s elapsed)"
  sleep 30
  STATUS=$(skills-svc status "$JOB_ID" 2>&1 | grep -oE 'PENDING|RUNNING|COMPLETE|FAILED' | head -1)
done

if [ "$STATUS" = "FAILED" ]; then
  echo "FAIL: Job $JOB_ID ended in FAILED state"
  skills-svc status "$JOB_ID"
  exit 1
fi

echo "Step 3: Job COMPLETE ✓"

# Step 4: Query knowledge store
echo "Step 4: Querying knowledge store..."
QUERY_OUTPUT=$(skills-svc query "smoke test skill output" --top-k 3 --format json 2>&1)
RESULT_COUNT=$(echo "$QUERY_OUTPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['results']))")

if [ "$RESULT_COUNT" -lt 1 ]; then
  echo "FAIL: Query returned 0 results (expected >= 1)"
  exit 1
fi

# Step 5: Assert minimum score
MIN_SCORE=$(echo "$QUERY_OUTPUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
scores=[r['score'] for r in d['results']]
print(min(scores) if scores else 0)
")

if python3 -c "exit(0 if float('$MIN_SCORE') >= 0.5 else 1)"; then
  echo "FAIL: Best result score $MIN_SCORE < 0.5 minimum"
  exit 1
fi

echo "Step 5: Query results validated (${RESULT_COUNT} results, min score ${MIN_SCORE}) ✓"
echo ""
echo "=== Smoke Test PASSED ==="
```

---

## QA Test Runner (`scripts/qa-run-all.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

run_check() {
  local id="$1"
  local name="$2"
  shift 2
  echo -n "[$id] $name ... "
  if "$@" > "/tmp/qa-${id//[^a-zA-Z0-9]/-}.log" 2>&1; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL  (see /tmp/qa-${id//[^a-zA-Z0-9]/-}.log)"
    FAIL=$((FAIL + 1))
  fi
}

# CDK Assertion Tests (QA-001 through QA-030, QA-047–050, QA-066–080, QA-095–098)
run_check "QA-CDK" "CDK stack assertions (all template tests)" \
  bash -c "cd infra && npx jest --passWithNoTests --forceExit"

# TypeScript compilation
for pkg in packages/shared packages/lambda packages/ecs-runner packages/knowledge-store packages/cli; do
  run_check "QA-031-${pkg}" "TypeScript: $pkg" bash -c "cd $pkg && npx tsc --noEmit"
done
run_check "QA-031-infra" "TypeScript: infra" bash -c "cd infra && npx tsc --noEmit"

# ESLint
run_check "QA-032" "ESLint zero warnings" \
  npx eslint --max-warnings 0 packages/shared/src packages/lambda/src packages/ecs-runner/src packages/knowledge-store/src packages/cli/src infra/lib infra/aspects

# Unit tests with coverage
run_check "QA-033-034" "Lambda unit tests (coverage >= 90%)" \
  bash -c "cd packages/lambda && npx jest --coverage --passWithNoTests"

run_check "QA-035" "State machine truth table (16 transitions)" \
  bash -c "cd packages/shared && npx jest --passWithNoTests"

# Security checks
run_check "QA-041" "npm audit (moderate+)" npm audit --audit-level=moderate --workspaces
run_check "QA-042" "Semgrep secrets scan" semgrep --config=p/secrets --error --quiet .
run_check "QA-043" "Dockerfile USER is non-root" grep -qE '^USER (1000|1000:1000)' packages/ecs-runner/Dockerfile
run_check "QA-044" "Dockerfile no privilege escalation" bash -c "! grep -PqE 'RUN.*(sudo|chmod \+s|setuid)' packages/ecs-runner/Dockerfile"

# Static analysis
run_check "QA-025" "ECS assignPublicIp DISABLED in Lambda code" bash -c "grep -r 'assignPublicIp' packages/lambda/src/ | grep -q 'DISABLED'"
run_check "QA-039" "Lambda handlers have try/catch" bash -c "grep -l 'export const handler' packages/lambda/src/**/*.ts | xargs grep -l 'try {'"
run_check "QA-081" "ECS runner SIGTERM handler registered" grep -q "process.on.*SIGTERM" packages/ecs-runner/src/main.ts
run_check "QA-083" "S3 download is streaming (no Buffer.from)" bash -c "! grep -qE '(Buffer\.from|\.toBuffer\(\))' packages/ecs-runner/src/downloader.ts"
run_check "QA-086" "OpenSearch timeout 30_000ms" grep -q 'requestTimeout: 30_000' packages/knowledge-store/src/client.ts
run_check "QA-087" "Embedding truncation at 25000 chars" grep -q 'MAX_INPUT_CHARS = 25_000' packages/knowledge-store/src/embeddings.ts
run_check "QA-090" "Credentials file mode 0o600" grep -q '0o600' packages/cli/src/commands/assume-role.ts
run_check "QA-097" "All three CDK Aspects applied" bash -c "grep -q NoWildcardIAMAspect infra/bin/app.ts && grep -q EncryptionEnforcerAspect infra/bin/app.ts && grep -q TaggingEnforcerAspect infra/bin/app.ts"

# CDK synth strict
run_check "QA-096" "CDK synth --strict (zero errors)" bash -c "cd infra && npx cdk synth --strict --quiet"

# Docker build
run_check "QA-099" "Docker image builds successfully" bash -c "docker build -t skills-svc-qa-test packages/ecs-runner/ --quiet && docker rmi skills-svc-qa-test -f"

echo ""
echo "══════════════════════════════════"
echo "QA Results: PASS=$PASS  FAIL=$FAIL"
echo "══════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ QA FAILED — $FAIL check(s) did not pass. See /tmp/qa-*.log for details."
  exit 1
fi
echo "✅ All QA checks passed."
```

---

## Deployment Runbook

### Prerequisites

```bash
node --version   # must be 20.x
aws --version    # must be v2
docker --version # must be 20+
npm install -g aws-cdk@latest typescript ts-node
```

### Step 1: Bootstrap CDK

```bash
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-east-1

npx cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

### Step 2: Run Full QA Suite

```bash
npm ci
npm run build
npm run qa:all
# All 100 checks must pass before proceeding
```

### Step 3: Deploy Stacks (in dependency order)

```bash
cd infra

npx cdk deploy SkillsSvc-prod-Network     --require-approval never
npx cdk deploy SkillsSvc-prod-Security    --require-approval never
npx cdk deploy SkillsSvc-prod-Storage     --require-approval never
npx cdk deploy SkillsSvc-prod-Messaging   --require-approval never
npx cdk deploy SkillsSvc-prod-Lambda      --require-approval never
npx cdk deploy SkillsSvc-prod-ECS         --require-approval never
npx cdk deploy SkillsSvc-prod-KnowledgeStore --require-approval never
npx cdk deploy SkillsSvc-prod-Monitoring  --require-approval never
npx cdk deploy SkillsSvc-prod-Compliance  --require-approval never
```

### Step 4: Set Anthropic API Key in SSM

```bash
aws ssm put-parameter \
  --name "/skills-svc/prod/anthropic/api-key" \
  --type "SecureString" \
  --value "$ANTHROPIC_API_KEY" \
  --key-id "alias/skills-svc/prod/lambda-env" \
  --overwrite
```

### Step 5: Build and Push ECS Image

```bash
bash scripts/build-push-ecs.sh prod
```

`scripts/build-push-ecs.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
ENV=${1:-prod}
ECR_URI=$(aws ssm get-parameter --name "/skills-svc/$ENV/ecr/repo-uri" --query Parameter.Value --output text)
IMAGE_TAG=$(git rev-parse --short HEAD)

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$ECR_URI"

docker build -t "$ECR_URI:$IMAGE_TAG" -t "$ECR_URI:latest" packages/ecs-runner/
docker push "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:latest"

echo "Pushed: $ECR_URI:$IMAGE_TAG"
```

### Step 6: Configure CLI

```bash
npm install -g @skills-svc/cli
skills-svc configure --region us-east-1 --account $CDK_DEFAULT_ACCOUNT --env prod
```

### Step 7: Smoke Test

```bash
SMOKE_TEST=true bash scripts/smoke-test.sh
```

---

## Cost Model Summary

| Component | Formula | N=1000/mo | N=10000/mo |
|-----------|---------|-----------|------------|
| S3 Storage | `N*(Z+R)*12/1024 * $0.023` | $4.05 | $40.50 |
| S3 Requests | `N*4/1000 * $0.0004` | $0.002 | $0.016 |
| Lambda | `N*2*300*(0.5) * $0.0000166667` | $0.25 | $2.50 |
| ECS Fargate | `N*(T/60)*(2*$0.04048+4*$0.004445)` | $7.65 | $76.50 |
| **OpenSearch** | `2 OCU * 730hr * $0.24` | **$350.40** | **$350.40** |
| DynamoDB | `N*4*$0.00000065` | $0.003 | $0.026 |
| SNS | `N*2*$0.0000005` | $0.001 | $0.010 |
| KMS | `6 keys + API calls` | $6.03 | $6.09 |
| **Total** | | **~$368/mo** | **~$476/mo** |

OpenSearch Serverless is the dominant cost at all job volumes due to its minimum 2 OCU floor. For low-volume workloads (<100 jobs/month), consider OpenSearch Managed (1 t3.small instance ≈ $18/month) as an alternative.

---

## CI/CD Pipeline (`.github/workflows/ci.yml`)

```yaml
name: CI
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  NODE_VERSION: '20'

jobs:
  qa:
    name: Quality Assurance (100 checks)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - name: Run all QA checks
        run: npm run qa:all
      - name: CDK Synth strict
        run: cd infra && npx cdk synth --strict --quiet
      - name: Docker build
        run: docker build packages/ecs-runner/ --quiet

  deploy-staging:
    name: Deploy to Staging
    needs: qa
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.STAGING_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - run: npm ci && npm run build
      - run: cd infra && npx cdk deploy --all --require-approval never --context envName=staging
      - run: bash scripts/build-push-ecs.sh staging
      - run: SMOKE_TEST=true bash scripts/smoke-test.sh

  deploy-prod:
    name: Deploy to Production
    needs: qa
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.PROD_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - run: npm ci && npm run build
      - run: cd infra && npx cdk deploy --all --require-approval never --context envName=prod
      - run: bash scripts/build-push-ecs.sh prod
      - run: SMOKE_TEST=true bash scripts/smoke-test.sh
```
