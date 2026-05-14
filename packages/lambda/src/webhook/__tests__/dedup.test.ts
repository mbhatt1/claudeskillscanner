/**
 * dedup.test.ts — Jest tests for packages/lambda/src/webhook/dedup.ts
 *
 * dedup.ts uses the low-level DynamoDBClient (GetItemCommand / PutItemCommand)
 * and a module-level singleton `_ddb`. We reset the module between each test
 * group that needs a fresh mock by using jest.resetModules().
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

// ─────────────────────────────────────────────────────────────────────────────
// Mock @aws-sdk/client-dynamodb before any imports from the module under test
// ─────────────────────────────────────────────────────────────────────────────

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  // Keep the real ConditionalCheckFailedException so instanceof checks work
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal GetItemOutput with the given attribute map (or undefined Item). */
function makeGetResponse(item?: Record<string, { S?: string; N?: string }>) {
  return { Item: item };
}

const TABLE  = 'test-table';
const PKG    = 'my-pkg';
const SHA    = 'abc123def456';
const JOB_ID = 'job-xyz-001';
const REPO   = 'org/repo';

// ─────────────────────────────────────────────────────────────────────────────
// checkCommitRecord
// ─────────────────────────────────────────────────────────────────────────────

describe('checkCommitRecord', () => {
  let checkCommitRecord: typeof import('../dedup').checkCommitRecord;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-import so the module-level _ddb singleton is fresh each time
    jest.resetModules();
    jest.mock('@aws-sdk/client-dynamodb', () => {
      const actual = jest.requireActual('@aws-sdk/client-dynamodb');
      return {
        ...actual,
        DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
      };
    });
    ({ checkCommitRecord } = require('../dedup'));
  });

  it('returns shouldSkip=false when no record exists', async () => {
    mockSend.mockResolvedValueOnce(makeGetResponse(undefined));

    const result = await checkCommitRecord(TABLE, PKG, SHA);

    expect(result).toEqual({ shouldSkip: false });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('returns shouldSkip=true with existing record when status=PENDING', async () => {
    mockSend.mockResolvedValueOnce(makeGetResponse({
      jobId:     { S: JOB_ID },
      status:    { S: 'PENDING' },
      createdAt: { S: '2026-01-01T00:00:00.000Z' },
      updatedAt: { S: '2026-01-01T00:00:01.000Z' },
    }));

    const result = await checkCommitRecord(TABLE, PKG, SHA);

    expect(result.shouldSkip).toBe(true);
    expect(result.existing).toMatchObject({
      jobId:  JOB_ID,
      status: 'PENDING',
    });
  });

  it('returns shouldSkip=true when status=RUNNING', async () => {
    mockSend.mockResolvedValueOnce(makeGetResponse({
      jobId:     { S: JOB_ID },
      status:    { S: 'RUNNING' },
      createdAt: { S: '2026-01-01T00:00:00.000Z' },
      updatedAt: { S: '2026-01-01T00:01:00.000Z' },
    }));

    const result = await checkCommitRecord(TABLE, PKG, SHA);

    expect(result.shouldSkip).toBe(true);
    expect(result.existing?.status).toBe('RUNNING');
  });

  it('returns shouldSkip=true when status=COMPLETE', async () => {
    mockSend.mockResolvedValueOnce(makeGetResponse({
      jobId:     { S: JOB_ID },
      status:    { S: 'COMPLETE' },
      createdAt: { S: '2026-01-01T00:00:00.000Z' },
      updatedAt: { S: '2026-01-01T00:05:00.000Z' },
    }));

    const result = await checkCommitRecord(TABLE, PKG, SHA);

    expect(result.shouldSkip).toBe(true);
    expect(result.existing?.status).toBe('COMPLETE');
  });

  it('returns shouldSkip=false when status=FAILED (retry allowed)', async () => {
    mockSend.mockResolvedValueOnce(makeGetResponse({
      jobId:     { S: JOB_ID },
      status:    { S: 'FAILED' },
      createdAt: { S: '2026-01-01T00:00:00.000Z' },
      updatedAt: { S: '2026-01-01T00:03:00.000Z' },
    }));

    const result = await checkCommitRecord(TABLE, PKG, SHA);

    expect(result.shouldSkip).toBe(false);
    // existing record is still returned for caller reference
    expect(result.existing?.status).toBe('FAILED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeCommitRecord
// ─────────────────────────────────────────────────────────────────────────────

describe('writeCommitRecord', () => {
  let writeCommitRecord: typeof import('../dedup').writeCommitRecord;
  let GetItemCommand: any;
  let PutItemCommand: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.mock('@aws-sdk/client-dynamodb', () => {
      const actual = jest.requireActual('@aws-sdk/client-dynamodb');
      return {
        ...actual,
        DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
      };
    });
    const mod = require('@aws-sdk/client-dynamodb');
    GetItemCommand = mod.GetItemCommand;
    PutItemCommand = mod.PutItemCommand;
    ({ writeCommitRecord } = require('../dedup'));
  });

  it('returns true and calls PutItemCommand with correct PK/SK/ttl on success', async () => {
    mockSend.mockResolvedValueOnce({});

    const result = await writeCommitRecord(TABLE, PKG, SHA, JOB_ID);

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Extract the command argument
    const cmdArg = mockSend.mock.calls[0][0];
    expect(cmdArg.input.TableName).toBe(TABLE);
    expect(cmdArg.input.Item.PK.S).toBe(`PKG#${PKG}`);
    expect(cmdArg.input.Item.SK.S).toBe(`COMMIT#${SHA}`);
    expect(cmdArg.input.Item.jobId.S).toBe(JOB_ID);
    expect(cmdArg.input.Item.status.S).toBe('PENDING');
    // TTL should be roughly 90 days from now (within 5s tolerance)
    const expectedTtl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    const actualTtl   = Number(cmdArg.input.Item.ttl.N);
    expect(actualTtl).toBeGreaterThanOrEqual(expectedTtl - 5);
    expect(actualTtl).toBeLessThanOrEqual(expectedTtl + 5);
    // Conditional write guard must be present
    expect(cmdArg.input.ConditionExpression).toMatch(/attribute_not_exists/);
  });

  it('includes GSI4 attributes when sourceRef is provided', async () => {
    mockSend.mockResolvedValueOnce({});

    await writeCommitRecord(TABLE, PKG, SHA, JOB_ID, 'refs/heads/main');

    const cmdArg = mockSend.mock.calls[0][0];
    expect(cmdArg.input.Item.GSI4PK?.S).toBe('SOURCEREF#refs/heads/main');
    expect(cmdArg.input.Item.GSI4SK?.S).toBe(`PKG#${PKG}`);
  });

  it('omits GSI4 attributes when sourceRef is not provided', async () => {
    mockSend.mockResolvedValueOnce({});

    await writeCommitRecord(TABLE, PKG, SHA, JOB_ID);

    const cmdArg = mockSend.mock.calls[0][0];
    expect(cmdArg.input.Item.GSI4PK).toBeUndefined();
    expect(cmdArg.input.Item.GSI4SK).toBeUndefined();
  });

  it('returns false and does not throw on ConditionalCheckFailedException (race loss)', async () => {
    const err = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(err);

    const result = await writeCommitRecord(TABLE, PKG, SHA, JOB_ID);

    expect(result).toBe(false);
    // No throw — caller must handle gracefully
  });

  it('rethrows any other DynamoDB error', async () => {
    const networkErr = new Error('Network error');
    mockSend.mockRejectedValueOnce(networkErr);

    await expect(writeCommitRecord(TABLE, PKG, SHA, JOB_ID)).rejects.toThrow('Network error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkCooldown
// ─────────────────────────────────────────────────────────────────────────────

describe('checkCooldown', () => {
  let checkCooldown: typeof import('../dedup').checkCooldown;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.mock('@aws-sdk/client-dynamodb', () => {
      const actual = jest.requireActual('@aws-sdk/client-dynamodb');
      return {
        ...actual,
        DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
      };
    });
    ({ checkCooldown } = require('../dedup'));
  });

  it('returns false when no cooldown record exists', async () => {
    mockSend.mockResolvedValueOnce(makeGetResponse(undefined));

    const active = await checkCooldown(TABLE, REPO, SHA);

    expect(active).toBe(false);
    // Key must use PK=WEBHOOK#COOLDOWN#<hash>, SK=TS
    const cmdArg = mockSend.mock.calls[0][0];
    expect(cmdArg.input.Key.PK.S).toMatch(/^WEBHOOK#COOLDOWN#[a-f0-9]+$/);
    expect(cmdArg.input.Key.SK.S).toBe('TS');
  });

  it('returns true when a cooldown record exists', async () => {
    mockSend.mockResolvedValueOnce(makeGetResponse({ PK: { S: 'WEBHOOK#COOLDOWN#aabbcc' } }));

    const active = await checkCooldown(TABLE, REPO, SHA);

    expect(active).toBe(true);
  });

  it('produces the same PK hash for identical (repo, sha) inputs', async () => {
    mockSend.mockResolvedValue(makeGetResponse(undefined));

    await checkCooldown(TABLE, REPO, SHA);
    await checkCooldown(TABLE, REPO, SHA);

    const pk1 = mockSend.mock.calls[0][0].input.Key.PK.S;
    const pk2 = mockSend.mock.calls[1][0].input.Key.PK.S;
    expect(pk1).toBe(pk2);
  });

  it('produces different PK hashes for different (repo, sha) inputs', async () => {
    mockSend.mockResolvedValue(makeGetResponse(undefined));

    await checkCooldown(TABLE, REPO, SHA);
    await checkCooldown(TABLE, REPO, 'different-sha');

    const pk1 = mockSend.mock.calls[0][0].input.Key.PK.S;
    const pk2 = mockSend.mock.calls[1][0].input.Key.PK.S;
    expect(pk1).not.toBe(pk2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// writeCooldown
// ─────────────────────────────────────────────────────────────────────────────

describe('writeCooldown', () => {
  let writeCooldown: typeof import('../dedup').writeCooldown;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.mock('@aws-sdk/client-dynamodb', () => {
      const actual = jest.requireActual('@aws-sdk/client-dynamodb');
      return {
        ...actual,
        DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
      };
    });
    ({ writeCooldown } = require('../dedup'));
  });

  it('calls PutItemCommand with a 60-second TTL', async () => {
    mockSend.mockResolvedValueOnce({});

    await writeCooldown(TABLE, REPO, SHA);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const cmdArg = mockSend.mock.calls[0][0];
    expect(cmdArg.input.TableName).toBe(TABLE);
    expect(cmdArg.input.Item.PK.S).toMatch(/^WEBHOOK#COOLDOWN#/);
    expect(cmdArg.input.Item.SK.S).toBe('TS');

    // TTL should be ~60s from now
    const expectedTtl = Math.floor(Date.now() / 1000) + 60;
    const actualTtl   = Number(cmdArg.input.Item.ttl.N);
    expect(actualTtl).toBeGreaterThanOrEqual(expectedTtl - 5);
    expect(actualTtl).toBeLessThanOrEqual(expectedTtl + 5);

    // Conditional guard present
    expect(cmdArg.input.ConditionExpression).toMatch(/attribute_not_exists/);
  });

  it('silently swallows ConditionalCheckFailedException (concurrent write wins)', async () => {
    const err = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(err);

    // Must resolve without throwing
    await expect(writeCooldown(TABLE, REPO, SHA)).resolves.toBeUndefined();
  });

  it('rethrows any other DynamoDB error', async () => {
    const provisioningErr = new Error('ProvisionedThroughputExceededException');
    mockSend.mockRejectedValueOnce(provisioningErr);

    await expect(writeCooldown(TABLE, REPO, SHA)).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});
