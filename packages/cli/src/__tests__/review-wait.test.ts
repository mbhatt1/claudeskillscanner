/**
 * review-wait.test.ts
 *
 * Unit tests for `skills-svc review wait` as specified in
 * SPEC-26-code-review-gap-fixes.md (Gap 10 — CI Exit Code / Build Gate).
 *
 * Exit codes:
 *   0  — job COMPLETE, 0 findings above the configured severity threshold
 *   1  — job COMPLETE, ≥1 finding meets or exceeds the threshold
 *   2  — job FAILED
 *   3  — timeout reached before a terminal state
 *
 * Mocked AWS clients:
 *   - DynamoDBDocumentClient (GetCommand for job status + LATEST_REVIEWED_VERSION,
 *                             QueryCommand for findings)
 *   - SSMClient              (GetParameterCommand for table name resolution)
 *   - loadConfig             (returns a minimal CliConfig)
 *
 * Gap 13 regression guard:
 *   resolveLatestVersion must call GetItem on PK=PKG#<name>, SK=LATEST_REVIEWED_VERSION
 *   and must NOT use a begins_with(PK, ...) query (which DynamoDB rejects at runtime).
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';

// ── Mock loadConfig ────────────────────────────────────────────────────────────

jest.mock('../../utils/config', () => ({
  loadConfig: jest.fn().mockResolvedValue({
    region: 'us-east-1',
    envName: 'test',
    env:     'test',
    dynamodbTableName: 'test-jobs-table',
    accountId: '123456789012',
  }),
}));

// Mock aws-clients helpers
jest.mock('../../utils/aws-clients', () => ({
  getCredentialProvider: jest.fn().mockResolvedValue(undefined),
  makeDDBClient: jest.fn().mockReturnValue(
    new (require('@aws-sdk/client-dynamodb').DynamoDBClient)({}),
  ),
  makeSSMClient: jest.fn().mockReturnValue(
    new (require('@aws-sdk/client-ssm').SSMClient)({}),
  ),
}));

// ── AWS SDK client mocks ───────────────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

// ── Constants ──────────────────────────────────────────────────────────────────

const PACKAGE_NAME    = 'my-pkg';
const PACKAGE_VERSION = '2.1.0';
const JOB_ID          = 'job-abc-0001';
const FINDINGS_TABLE  = 'test-findings-table';
const JOBS_TABLE      = 'test-jobs-table';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Mock SSM to return the two table names the command fetches. */
function mockSsmTables(): void {
  ssmMock
    .on(GetParameterCommand, { Name: '/skills-svc/test/dynamodb/findings-table-name' })
    .resolves({ Parameter: { Value: FINDINGS_TABLE } });

  ssmMock
    .on(GetParameterCommand, { Name: '/skills-svc/test/dynamodb/jobs-table-name' })
    .resolves({ Parameter: { Value: JOBS_TABLE } });
}

/** Mock the LATEST_REVIEWED_VERSION pointer record (Gap 13 fix). */
function mockLatestVersionPointer(
  packageName = PACKAGE_NAME,
  version     = PACKAGE_VERSION,
  jobId       = JOB_ID,
): void {
  ddbMock
    .on(GetCommand, {
      TableName: FINDINGS_TABLE,
      Key: { PK: `PKG#${packageName}`, SK: 'LATEST_REVIEWED_VERSION' },
    })
    .resolves({
      Item: {
        PK:         `PKG#${packageName}`,
        SK:         'LATEST_REVIEWED_VERSION',
        versionRaw: version,
        version:    version,
        jobId,
        reviewedAt: new Date().toISOString(),
      },
    });
}

/** Mock the job metadata record with a given status. */
function mockJobStatus(jobId: string, status: string, table = JOBS_TABLE): void {
  ddbMock
    .on(GetCommand, {
      TableName: table,
      Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
    })
    .resolves({
      Item: {
        PK:     `JOB#${jobId}`,
        SK:     'METADATA',
        jobId,
        status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
}

/**
 * Mock findings for a given job.
 * `findings` is an array of { severity } objects.
 */
function mockFindings(
  jobId: string,
  findings: Array<{ severity: string }>,
  table = FINDINGS_TABLE,
): void {
  ddbMock
    .on(QueryCommand, {
      TableName: table,
      IndexName: 'GSI3-Job',
    })
    .resolves({
      Items: findings.map((f, i) => ({
        PK:       `PKG#${PACKAGE_NAME}#${PACKAGE_VERSION}`,
        SK:       `FINDING#${i.toString().padStart(5, '0')}`,
        GSI3PK:   `JOB#${jobId}`,
        GSI3SK:   `FINDING#${i.toString().padStart(5, '0')}`,
        severity: f.severity,
      })),
    });
}

// ── Import the function under test AFTER mocks are set up ─────────────────────

import { reviewWait } from '../../commands/review/wait';

// ── Test suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useRealTimers();
  ddbMock.reset();
  ssmMock.reset();
  mockSsmTables();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Exit code 0 — COMPLETE, no findings above threshold
// ─────────────────────────────────────────────────────────────────────────────

describe('exit code 0 — job complete with no blocking findings', () => {
  test('resolves with exit code 0 when job COMPLETE and 0 findings above threshold', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, []);   // zero findings

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:         PACKAGE_VERSION,
      timeout:         30,
      failOnSeverity:  'high',
    });

    expect(exitCode).toBe(0);
  });

  test('exit code 0 when findings exist but all below threshold (medium findings, threshold=high)', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [
      { severity: 'medium' },
      { severity: 'medium' },
    ]);

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
    });

    expect(exitCode).toBe(0);
  });

  test('exit code 0 when low/info findings exist and threshold=high', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [
      { severity: 'low' },
      { severity: 'info' },
      { severity: 'info' },
    ]);

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
    });

    expect(exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exit code 1 — COMPLETE, findings at or above threshold
// ─────────────────────────────────────────────────────────────────────────────

describe('exit code 1 — blocking findings present', () => {
  test('exit code 1 when job COMPLETE with 2 critical findings and threshold=high', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [
      { severity: 'critical' },
      { severity: 'critical' },
    ]);

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
    });

    expect(exitCode).toBe(1);
  });

  test('exit code 1 when findings include high severity and threshold=high', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [
      { severity: 'high' },
      { severity: 'medium' },
    ]);

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
    });

    expect(exitCode).toBe(1);
  });

  test('exit code 1 when threshold=critical and critical finding present', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [
      { severity: 'critical' },
    ]);

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'critical',
    });

    expect(exitCode).toBe(1);
  });

  test('exit code 0 when threshold=critical and only high findings exist', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [
      { severity: 'high' },
      { severity: 'high' },
    ]);

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'critical',
    });

    expect(exitCode).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exit code 2 — job FAILED
// ─────────────────────────────────────────────────────────────────────────────

describe('exit code 2 — job FAILED', () => {
  test('resolves with exit code 2 when job status is FAILED', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'FAILED');
    // No findings expected — job didn't complete
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
    });

    expect(exitCode).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exit code 3 — timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('exit code 3 — timeout', () => {
  test('resolves with exit code 3 when timeout reached before COMPLETE', async () => {
    jest.useFakeTimers();

    mockLatestVersionPointer();
    // Job stays RUNNING forever
    mockJobStatus(JOB_ID, 'RUNNING');
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    // Start with a 1-second timeout so the test resolves quickly
    const waitPromise = reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        1,   // 1 second
      failOnSeverity: 'high',
    });

    // Advance fake timers past the 1-second timeout and all poll intervals
    jest.advanceTimersByTime(60_000);

    const exitCode = await waitPromise;

    expect(exitCode).toBe(3);

    jest.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation — invalid --fail-on-severity value
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid --fail-on-severity value', () => {
  test('invalid severity "blocker" resolves with exit code 1 and error message', async () => {
    const errorLines: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorLines.push(args.join(' '));
    });

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'blocker' as any,   // intentionally invalid
    });

    errSpy.mockRestore();

    expect(exitCode).toBe(1);
    // Must have printed a descriptive error
    const allOutput = errorLines.join('\n');
    expect(allOutput).toMatch(/blocker|invalid|severity|critical|high|medium|low/i);
  });

  test('invalid severity "urgent" also fails validation', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'urgent' as any,
    });

    errSpy.mockRestore();
    expect(exitCode).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --format json output
// ─────────────────────────────────────────────────────────────────────────────

describe('--format json output', () => {
  test('json output includes passed:true when no blocking findings', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [{ severity: 'low' }]);

    const logLines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
      format:         'json',
    });

    spy.mockRestore();

    expect(exitCode).toBe(0);

    // Find the JSON output line
    const jsonLine = logLines.find(l => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    expect(parsed.passed).toBe(true);
    expect(Array.isArray(parsed.blockingFindings)).toBe(true);
    expect(parsed.blockingFindings).toHaveLength(0);
  });

  test('json output includes passed:false and blockingFindings array when findings exceed threshold', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, [
      { severity: 'critical' },
      { severity: 'high' },
      { severity: 'low' },
    ]);

    const logLines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
      format:         'json',
    });

    spy.mockRestore();

    expect(exitCode).toBe(1);

    const jsonLine = logLines.find(l => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    expect(parsed.passed).toBe(false);
    expect(Array.isArray(parsed.blockingFindings)).toBe(true);
    // critical and high are blocking at threshold=high; low is not
    expect(parsed.blockingFindings.length).toBe(2);
  });

  test('json output for FAILED job includes jobStatus:FAILED', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'FAILED');
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const logLines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(args.join(' '));
    });

    const exitCode = await reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        30,
      failOnSeverity: 'high',
      format:         'json',
    });

    spy.mockRestore();

    expect(exitCode).toBe(2);

    const jsonLine = logLines.find(l => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    expect(parsed.jobStatus).toBe('FAILED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Polling interval — 10 seconds between status checks
// ─────────────────────────────────────────────────────────────────────────────

describe('polling interval', () => {
  test('polls every 10 seconds using fake timers', async () => {
    jest.useFakeTimers();

    mockLatestVersionPointer();

    // Return RUNNING for two polls, then COMPLETE on the third
    let pollCount = 0;
    ddbMock.on(GetCommand, {
      TableName: JOBS_TABLE,
      Key: { PK: `JOB#${JOB_ID}`, SK: 'METADATA' },
    }).callsFake(() => {
      pollCount++;
      const status = pollCount < 3 ? 'RUNNING' : 'COMPLETE';
      return {
        Item: { PK: `JOB#${JOB_ID}`, SK: 'METADATA', jobId: JOB_ID, status },
      };
    });

    mockFindings(JOB_ID, []);

    const waitPromise = reviewWait(PACKAGE_NAME, {
      version:        PACKAGE_VERSION,
      timeout:        120,
      failOnSeverity: 'high',
    });

    // Advance time by 10s twice to trigger RUNNING polls
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();   // drain micro-task queue
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    // Now let the third poll (COMPLETE) land
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    const exitCode = await waitPromise;

    expect(exitCode).toBe(0);
    // Should have polled at least 3 times (2 RUNNING + 1 COMPLETE)
    expect(pollCount).toBeGreaterThanOrEqual(3);

    jest.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap 13 regression guard — resolveLatestVersion uses GetItem
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveLatestVersion — Gap 13 regression guard', () => {
  test('uses GetItem on LATEST_REVIEWED_VERSION pointer, not a begins_with query on PK', async () => {
    mockLatestVersionPointer();
    mockJobStatus(JOB_ID, 'COMPLETE');
    mockFindings(JOB_ID, []);

    await reviewWait(PACKAGE_NAME, {
      version:        undefined,   // omit version → must call resolveLatestVersion
      timeout:        30,
      failOnSeverity: 'high',
    });

    // GetCommand must have been called with the pointer key
    expect(ddbMock).toHaveReceivedCommandWith(GetCommand, {
      TableName: FINDINGS_TABLE,
      Key: {
        PK: `PKG#${PACKAGE_NAME}`,
        SK: 'LATEST_REVIEWED_VERSION',
      },
    });

    // QueryCommand must NOT have been called with a begins_with on PK
    // (that would be a DynamoDB runtime error per Gap 13 audit)
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    const invalidQuery = queryCalls.find(call => {
      const expr = (call.args[0].input as Record<string, unknown>).KeyConditionExpression as string | undefined;
      // Any query using begins_with on the PK field is the buggy pattern
      return expr?.includes('begins_with') && expr?.includes('PK');
    });

    expect(invalidQuery).toBeUndefined();
  });

  test('resolveLatestVersion throws descriptive error when no pointer record exists', async () => {
    // Return no item for the pointer
    ddbMock.on(GetCommand, {
      TableName: FINDINGS_TABLE,
      Key: { PK: `PKG#${PACKAGE_NAME}`, SK: 'LATEST_REVIEWED_VERSION' },
    }).resolves({ Item: undefined });

    await expect(
      reviewWait(PACKAGE_NAME, {
        version:        undefined,
        timeout:        30,
        failOnSeverity: 'high',
      }),
    ).rejects.toThrow(new RegExp(`${PACKAGE_NAME}|No review|not found`, 'i'));
  });
});
