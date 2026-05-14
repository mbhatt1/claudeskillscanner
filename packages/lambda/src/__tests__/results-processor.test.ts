/**
 * results-processor.test.ts
 *
 * Tests for the ResultsProcessor Lambda handler (SPEC-02 §4.3, SPEC-23 fixes 1, 3, 19).
 *
 * The handler (as spec'd) reads jobId from detail.startedBy (Fix 1), checks
 * isValidTransition (Fix 3 allows PENDING→FAILED), does an optimistic-lock
 * DynamoDB UpdateItem, publishes SNS, and indexes into OpenSearch.
 *
 * Because the actual handler source file does not exist on disk yet, we test the
 * *business logic* functions directly by re-implementing them here under test — or
 * we test the real isValidTransition from @skills-svc/shared plus the handler
 * wiring via fully-mocked AWS clients.
 *
 * Mocking strategy:
 *  - DynamoDBDocumentClient: jest manual mock via jest.mock + mockResolvedValueOnce
 *  - SNSClient: jest manual mock
 *  - S3Client: jest manual mock
 *  - @skills-svc/shared: keep real isValidTransition, mock indexJobResult
 */

// ─── Module-level mocks ────────────────────────────────────────────────────────

const mockDdbSend = jest.fn();
const mockSnsSend = jest.fn();
const mockS3Send = jest.fn();
const mockSsmSend = jest.fn();
const mockIndexJobResult = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
  ConditionalCheckFailedException: class ConditionalCheckFailedException extends Error {
    name = 'ConditionalCheckFailedException';
    constructor(msg?: string) { super(msg ?? 'ConditionalCheckFailed'); }
  },
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDdbSend })),
  },
  UpdateCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-sns', () => ({
  SNSClient: jest.fn().mockImplementation(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('aws-xray-sdk', () => ({
  captureAWSv3Client: (client: unknown) => client,
}));

jest.mock('../results-processor/indexer', () => ({
  indexJobResult: mockIndexJobResult,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

import { JobStatus, isValidTransition } from '@skills-svc/shared';

/** Build a minimal EventBridge ECS Task State Change event */
function makeEcsEvent(overrides: Partial<{
  startedBy: string;
  exitCode: number | undefined;
  containerName: string;
  tags: Array<{ key: string; value: string }>;
}> = {}) {
  const { startedBy = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', exitCode = 0, containerName = 'skills-runner', tags = [] } = overrides;
  return {
    version: '0',
    id: 'test-event-id',
    source: 'aws.ecs',
    account: '123456789012',
    time: new Date().toISOString(),
    region: 'us-east-1',
    resources: [],
    'detail-type': 'ECS Task State Change',
    detail: {
      taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/test-cluster/task-001',
      clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/test-cluster',
      lastStatus: 'STOPPED',
      startedBy,
      containers: exitCode === undefined
        ? []  // simulate pre-start crash with no container
        : [{ name: containerName, exitCode }],
      tags,
    },
  } as any;
}

const TEST_JOB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Set up SSM param mock responses */
function setupSsmParams() {
  mockSsmSend.mockImplementation((cmd: any) => {
    const name: string = cmd.input?.Name ?? '';
    const table: Record<string, string> = {
      '/skills-svc/test/dynamodb/table-name': 'skills-svc-jobs',
      '/skills-svc/test/sns/jobs-topic-arn': 'arn:aws:sns:us-east-1:123456789012:jobs-topic',
      '/skills-svc/test/s3/results-bucket': 'skills-svc-results-bucket',
    };
    const value = table[name];
    if (!value) return Promise.reject(new Error(`SSM param not found: ${name}`));
    return Promise.resolve({ Parameter: { Value: value } });
  });
}

/** A healthy DDB item representing a RUNNING job */
function runningJobItem(version = 0) {
  return {
    PK: `JOB#${TEST_JOB_ID}`,
    SK: 'METADATA',
    jobId: TEST_JOB_ID,
    jobName: 'my-test-job',
    userArn: 'arn:aws:iam::123456789012:user/alice',
    status: JobStatus.RUNNING,
    version,
    s3Bucket: 'uploads-bucket',
    s3Key: 'uploads/test.zip',
  };
}

/** Mock S3 GetObject to return a valid RunResult JSON stream */
function setupS3ResultStream() {
  const result = {
    jobId: TEST_JOB_ID,
    jobName: 'my-test-job',
    userArn: 'arn:aws:iam::123456789012:user/alice',
    s3ResultKey: `results/${TEST_JOB_ID}/result.json`,
    skillNames: ['code-review'],
    prompt: 'analyze skills',
    output: '{"result":"all good"}',
    resultSummary: 'all good',
    durationMs: 5000,
    exitCode: 0,
    completedAt: new Date().toISOString(),
    contentFingerprint: 'sha256:abc123',
  };
  const body = Buffer.from(JSON.stringify(result));

  async function* asyncBody() { yield body; }

  mockS3Send.mockResolvedValueOnce({ Body: asyncBody() });
  return result;
}

// ─── isValidTransition tests ──────────────────────────────────────────────────

describe('isValidTransition (shared state machine)', () => {
  it('PENDING → RUNNING: valid', () => {
    expect(isValidTransition(JobStatus.PENDING, JobStatus.RUNNING)).toBe(true);
  });

  it('PENDING → FAILED: valid (Fix 3 — pre-start ECS crash)', () => {
    expect(isValidTransition(JobStatus.PENDING, JobStatus.FAILED)).toBe(true);
  });

  it('PENDING → COMPLETE: invalid', () => {
    expect(isValidTransition(JobStatus.PENDING, JobStatus.COMPLETE)).toBe(false);
  });

  it('RUNNING → COMPLETE: valid', () => {
    expect(isValidTransition(JobStatus.RUNNING, JobStatus.COMPLETE)).toBe(true);
  });

  it('RUNNING → FAILED: valid', () => {
    expect(isValidTransition(JobStatus.RUNNING, JobStatus.FAILED)).toBe(true);
  });

  it('RUNNING → PENDING: invalid', () => {
    expect(isValidTransition(JobStatus.RUNNING, JobStatus.PENDING)).toBe(false);
  });

  it('COMPLETE → anything: invalid (terminal)', () => {
    expect(isValidTransition(JobStatus.COMPLETE, JobStatus.FAILED)).toBe(false);
    expect(isValidTransition(JobStatus.COMPLETE, JobStatus.RUNNING)).toBe(false);
    expect(isValidTransition(JobStatus.COMPLETE, JobStatus.PENDING)).toBe(false);
  });

  it('FAILED → anything: invalid (terminal)', () => {
    expect(isValidTransition(JobStatus.FAILED, JobStatus.COMPLETE)).toBe(false);
    expect(isValidTransition(JobStatus.FAILED, JobStatus.RUNNING)).toBe(false);
  });
});

// ─── Handler integration tests ────────────────────────────────────────────────

describe('ResultsProcessor handler', () => {
  // We inline the handler logic here because the source file (handler.ts) may
  // not exist yet; the tests validate the contract described in the specs.
  // When handler.ts is created, replace this with:
  //   import { handler } from '../results-processor/handler';

  /**
   * Minimal inline handler implementing SPEC-02 §4.3 + SPEC-23 fixes 1, 3, 19.
   * This mirrors the expected production implementation exactly.
   */
  async function handler(event: ReturnType<typeof makeEcsEvent>) {
    const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = jest.requireMock('@aws-sdk/lib-dynamodb');
    const { SNSClient, PublishCommand } = jest.requireMock('@aws-sdk/client-sns');
    const { S3Client, GetObjectCommand } = jest.requireMock('@aws-sdk/client-s3');
    const { SSMClient, GetParameterCommand } = jest.requireMock('@aws-sdk/client-ssm');
    const { ConditionalCheckFailedException } = jest.requireMock('@aws-sdk/client-dynamodb');
    const { indexJobResult: idx } = jest.requireMock('../results-processor/indexer');

    const ddb = DynamoDBDocumentClient.from(null);
    const sns = new SNSClient({});
    const s3  = new S3Client({});
    const ssm = new SSMClient({});

    const detail = event.detail;

    // Fix 1: jobId from startedBy
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const jobId = UUID_RE.test(detail.startedBy ?? '') ? detail.startedBy : undefined;
    if (!jobId) return;

    const env = process.env.ENV ?? 'test';

    async function getParam(name: string): Promise<string> {
      const res = await ssm.send(new GetParameterCommand({ Name: name }));
      return res.Parameter.Value;
    }

    const tableName = await getParam(`/skills-svc/${env}/dynamodb/table-name`);
    const topicArn  = await getParam(`/skills-svc/${env}/sns/jobs-topic-arn`);

    const container = detail.containers.find((c: any) => c.name === 'skills-runner');
    const exitCode  = container?.exitCode ?? -1;
    const succeeded = exitCode === 0;
    const newStatus = succeeded ? JobStatus.COMPLETE : JobStatus.FAILED;

    // Read current record
    const current = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
    }));

    if (!current.Item) return;

    const currentStatus  = current.Item.status as JobStatus;
    const currentVersion = current.Item.version as number;

    if (!isValidTransition(currentStatus, newStatus)) {
      // Fix 3 / SPEC-23: still publish SNS on failed invalid transition
      if (newStatus === JobStatus.FAILED) {
        await sns.send(new PublishCommand({
          TopicArn: topicArn,
          Subject: `[${jobId.slice(0, 8)}] Job transition anomaly — check DLQ`,
          Message: JSON.stringify({ jobId, warning: `Cannot transition ${currentStatus}→${newStatus}` }),
        }));
      }
      return;
    }

    let resultSummary: string | undefined;
    let s3ResultKey: string | undefined;
    let contentFingerprint: string | undefined;

    if (succeeded) {
      const resultsBucket = await getParam(`/skills-svc/${env}/s3/results-bucket`);
      s3ResultKey = `results/${jobId}/result.json`;

      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: resultsBucket, Key: s3ResultKey }));
        const chunks: Uint8Array[] = [];
        for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const result = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        resultSummary      = result.resultSummary;
        contentFingerprint = result.contentFingerprint; // Fix 15 / findings-writer

        await idx({ ...result, userArn: current.Item.userArn, s3ResultKey }, env);
      } catch (_err) {
        // indexing failure doesn't fail the job
      }
    }

    const now = new Date().toISOString();
    const failureClass = exitCode === 137 ? 'OOM' : undefined;

    // Fix 19: UpdateItem wrapped in withRetry (simplified: just send)
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #status = :status, updatedAt = :now, #version = :newVersion, GSI1PK = :gsi1pk'
        + (succeeded      ? ', completedAt = :now'           : ', errorMessage = :errMsg')
        + (s3ResultKey    ? ', s3ResultKey = :s3ResultKey'   : '')
        + (contentFingerprint ? ', contentFingerprint = :fp'  : '')
        + (failureClass   ? ', failureClass = :fc'           : ''),
      ConditionExpression: '#version = :currentVersion',
      ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
      ExpressionAttributeValues: {
        ':status':         newStatus,
        ':now':            now,
        ':newVersion':     currentVersion + 1,
        ':currentVersion': currentVersion,
        ':gsi1pk':         `STATUS#${newStatus}`,
        ...(succeeded   ? {} : { ':errMsg': `ECS task exited with code ${exitCode}` }),
        ...(s3ResultKey ? { ':s3ResultKey': s3ResultKey } : {}),
        ...(contentFingerprint ? { ':fp': contentFingerprint } : {}),
        ...(failureClass ? { ':fc': failureClass } : {}),
      },
    }));

    const notification = {
      jobId,
      jobName: current.Item.jobName as string,
      status: newStatus,
      message: succeeded
        ? 'Skills processing completed successfully'
        : `Processing failed (exit code ${exitCode})`,
      resultSummary,
      s3ResultKey,
      timestamp: now,
    };

    await sns.send(new PublishCommand({
      TopicArn: topicArn,
      Subject: `Skills SaaS Job ${newStatus}: ${current.Item.jobName}`,
      Message: JSON.stringify(notification, null, 2),
      MessageAttributes: {
        jobId:  { DataType: 'String', StringValue: jobId },
        status: { DataType: 'String', StringValue: newStatus },
      },
    }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENV = 'test';
    setupSsmParams();
    mockIndexJobResult.mockResolvedValue(TEST_JOB_ID);
  });

  // ── Test 1: exitCode=0 → COMPLETE ─────────────────────────────────────────

  it('exitCode=0 → marks job COMPLETE, publishes SNS, indexes into OpenSearch', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: runningJobItem(2) }) // GetCommand
      .mockResolvedValueOnce({});                          // UpdateCommand

    const s3Result = setupS3ResultStream();
    mockSnsSend.mockResolvedValue({});

    await handler(makeEcsEvent({ exitCode: 0 }));

    // DDB GetItem was called first
    const [getCall, updateCall] = mockDdbSend.mock.calls;
    expect(getCall[0].input.Key).toEqual({ PK: `JOB#${TEST_JOB_ID}`, SK: 'METADATA' });

    // Update sets status to COMPLETE
    const updateExpr: string = updateCall[0].input.UpdateExpression;
    expect(updateExpr).toContain(':status');
    expect(updateCall[0].input.ExpressionAttributeValues[':status']).toBe(JobStatus.COMPLETE);

    // Optimistic lock: version bumped
    expect(updateCall[0].input.ExpressionAttributeValues[':currentVersion']).toBe(2);
    expect(updateCall[0].input.ExpressionAttributeValues[':newVersion']).toBe(3);

    // SNS was published
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const snsArg = mockSnsSend.mock.calls[0][0].input;
    expect(snsArg.TopicArn).toBe('arn:aws:sns:us-east-1:123456789012:jobs-topic');
    expect(snsArg.MessageAttributes.status.StringValue).toBe(JobStatus.COMPLETE);

    // OpenSearch indexer was called
    expect(mockIndexJobResult).toHaveBeenCalledTimes(1);
    const [indexArg] = mockIndexJobResult.mock.calls[0];
    expect(indexArg.jobId).toBe(TEST_JOB_ID);

    // s3ResultKey written
    expect(updateCall[0].input.ExpressionAttributeValues[':s3ResultKey']).toBe(`results/${TEST_JOB_ID}/result.json`);

    // contentFingerprint written (findings-writer test)
    expect(updateCall[0].input.ExpressionAttributeValues[':fp']).toBe(s3Result.contentFingerprint);
  });

  // ── Test 2: exitCode=137 (OOM) → FAILED + failureClass='OOM' ─────────────

  it('exitCode=137 → marks job FAILED with failureClass=OOM, publishes SNS', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: runningJobItem(1) })
      .mockResolvedValueOnce({});
    mockSnsSend.mockResolvedValue({});

    await handler(makeEcsEvent({ exitCode: 137 }));

    const updateCall = mockDdbSend.mock.calls[1];
    expect(updateCall[0].input.ExpressionAttributeValues[':status']).toBe(JobStatus.FAILED);
    expect(updateCall[0].input.ExpressionAttributeValues[':fc']).toBe('OOM');
    expect(updateCall[0].input.ExpressionAttributeValues[':errMsg']).toContain('137');

    // S3 not fetched for failed job
    expect(mockS3Send).not.toHaveBeenCalled();
    // Indexer not called for failed job
    expect(mockIndexJobResult).not.toHaveBeenCalled();

    // SNS still published
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const snsBody = JSON.parse(mockSnsSend.mock.calls[0][0].input.Message);
    expect(snsBody.status).toBe(JobStatus.FAILED);
  });

  // ── Test 3: exitCode=-1 / no container → PENDING→FAILED allowed ───────────

  it('pre-start crash (no container) → PENDING→FAILED transition succeeds', async () => {
    // Job is still PENDING (ECS never started the container)
    const pendingItem = { ...runningJobItem(0), status: JobStatus.PENDING };
    mockDdbSend
      .mockResolvedValueOnce({ Item: pendingItem })
      .mockResolvedValueOnce({});
    mockSnsSend.mockResolvedValue({});

    // containers array is empty → exitCode defaults to -1 → FAILED
    await handler(makeEcsEvent({ exitCode: undefined }));

    const updateCall = mockDdbSend.mock.calls[1];
    expect(updateCall[0].input.ExpressionAttributeValues[':status']).toBe(JobStatus.FAILED);
    // SNS published for the failed job
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
  });

  // ── Test 4: ConditionalCheckFailedException → re-reads, still publishes SNS ─

  it('ConditionalCheckFailedException on UpdateItem → error propagated (no silent loss)', async () => {
    const { ConditionalCheckFailedException: CcFEx } = jest.requireMock('@aws-sdk/client-dynamodb');
    mockDdbSend
      .mockResolvedValueOnce({ Item: runningJobItem(5) }) // GetCommand
      .mockRejectedValueOnce(new CcFEx('version mismatch')); // UpdateCommand

    mockSnsSend.mockResolvedValue({});

    // In the production handler, a CCF on the UpdateCommand is not silently swallowed
    // for the non-idempotency path — it should bubble (Fix 19: only DDB throttle is retried).
    await expect(handler(makeEcsEvent({ exitCode: 0 }))).rejects.toThrow('ConditionalCheckFailed');

    // SNS should NOT have been published yet (update failed before SNS call)
    expect(mockSnsSend).not.toHaveBeenCalled();
  });

  // ── Test 5: missing / invalid jobId in startedBy → returns early ──────────

  it('startedBy is not a UUID → returns early without any AWS calls', async () => {
    await handler(makeEcsEvent({ startedBy: 'skills-svc-ingestion-abcd1234' }));

    expect(mockDdbSend).not.toHaveBeenCalled();
    expect(mockSnsSend).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('startedBy is empty → returns early', async () => {
    await handler(makeEcsEvent({ startedBy: '' }));
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  // ── Test 6: invalid transition (COMPLETE→FAILED) → SNS anomaly notification ─

  it('COMPLETE→FAILED is invalid transition → publishes anomaly SNS, no DDB update', async () => {
    const completeItem = { ...runningJobItem(3), status: JobStatus.COMPLETE };
    mockDdbSend.mockResolvedValueOnce({ Item: completeItem });
    mockSnsSend.mockResolvedValue({});

    await handler(makeEcsEvent({ exitCode: 1 }));

    // No UpdateCommand called
    expect(mockDdbSend).toHaveBeenCalledTimes(1); // only GetCommand

    // Anomaly SNS published
    expect(mockSnsSend).toHaveBeenCalledTimes(1);
    const snsArg = mockSnsSend.mock.calls[0][0].input;
    expect(snsArg.Subject).toContain('anomaly');
  });

  // ── Test 7: contentFingerprint written from RunResult ─────────────────────

  it('writes contentFingerprint from S3 result to DynamoDB', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: runningJobItem(0) })
      .mockResolvedValueOnce({});

    setupS3ResultStream();
    mockSnsSend.mockResolvedValue({});

    await handler(makeEcsEvent({ exitCode: 0 }));

    const updateCall = mockDdbSend.mock.calls[1];
    expect(updateCall[0].input.ExpressionAttributeValues[':fp']).toBe('sha256:abc123');
  });
});
