/**
 * suppress.test.ts — Jest tests for packages/cli/src/commands/review/suppress.ts
 *
 * suppress.ts does not yet exist on disk — these tests are written against the
 * interface specified in SPEC-26 Gap 7 and drive the implementation.
 *
 * Expected public API:
 *
 *   suppressFinding(
 *     ddb: DynamoDBDocumentClient,
 *     tableName: string,
 *     packageName: string,
 *     version: string,
 *     findingId: string,
 *     opts: { reason: string; allVersions?: boolean; suppressedBy: string },
 *   ): Promise<void>
 *
 *   unsuppressFinding(
 *     ddb: DynamoDBDocumentClient,
 *     tableName: string,
 *     packageName: string,
 *     version: string,
 *     findingId: string,
 *     opts: { removeGlobalRule?: boolean },
 *   ): Promise<void>
 *
 *   buildContentHash(finding: {
 *     cwe_id: string;
 *     description: string;
 *     recommendation: string;
 *   }): string
 */

import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

// ─────────────────────────────────────────────────────────────────────────────
// Mock AWS SDK (lib-dynamodb)
// ─────────────────────────────────────────────────────────────────────────────

const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: mockSend })),
    },
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Lazy-import helpers (so mocks are in place)
// ─────────────────────────────────────────────────────────────────────────────

let suppressFinding:   (...args: any[]) => Promise<void>;
let unsuppressFinding: (...args: any[]) => Promise<void>;
let buildContentHash:  (finding: { cwe_id: string; description: string; recommendation: string }) => string;

beforeAll(async () => {
  // Importing after mocks are set; suppress.ts doesn't exist yet — when it does,
  // this import will resolve correctly.
  try {
    const mod = await import('../commands/review/suppress');
    suppressFinding   = mod.suppressFinding;
    unsuppressFinding = mod.unsuppressFinding;
    buildContentHash  = mod.buildContentHash;
  } catch {
    // Module not yet on disk — tests that require it will fail with a clear message.
    suppressFinding   = async () => { throw new Error('suppress.ts not yet implemented'); };
    unsuppressFinding = async () => { throw new Error('suppress.ts not yet implemented'); };
    buildContentHash  = () => { throw new Error('suppress.ts not yet implemented'); };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TABLE      = 'test-findings-table';
const PKG        = 'my-pkg';
const VERSION    = '1.2.3';
const FINDING_ID = 'FINDING#cwe-89-001';
const SUPPRESSOR = 'alice@example.com';
const REASON     = 'Confirmed not exploitable in this context';

const MOCK_FINDING = {
  PK:              `PKG#${PKG}#${VERSION}`,
  SK:              FINDING_ID,
  cwe_id:          'CWE-89',
  description:     'SQL injection via user-supplied input to query parameter',
  recommendation:  'Use parameterised queries or an ORM',
  severity:        'high',
  file:            'src/db/query.ts',
  line:            42,
  status:          'open',
  contentFingerprint: 'fp-abc123',
};

/** Build a fake DynamoDBDocumentClient whose send() is wired to mockSend. */
function makeDdb(): DynamoDBDocumentClient {
  return { send: mockSend } as unknown as DynamoDBDocumentClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// suppressFinding
// ─────────────────────────────────────────────────────────────────────────────

describe('suppressFinding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls UpdateCommand to set status=false-positive with suppressedBy/suppressedAt/suppressionReason', async () => {
    // GetCommand returns the existing finding
    mockSend.mockResolvedValueOnce({ Item: MOCK_FINDING });
    // UpdateCommand succeeds
    mockSend.mockResolvedValueOnce({});

    await suppressFinding(makeDdb(), TABLE, PKG, VERSION, FINDING_ID, {
      reason:       REASON,
      suppressedBy: SUPPRESSOR,
    });

    // First call: GetCommand to verify finding exists
    const getCall = mockSend.mock.calls[0][0];
    expect(getCall).toBeInstanceOf(GetCommand);
    expect(getCall.input.Key).toMatchObject({
      PK: `PKG#${PKG}#${VERSION}`,
      SK: FINDING_ID,
    });

    // Second call: UpdateCommand
    const updateCall = mockSend.mock.calls[1][0];
    expect(updateCall).toBeInstanceOf(UpdateCommand);
    expect(updateCall.input.TableName).toBe(TABLE);
    expect(updateCall.input.Key).toMatchObject({
      PK: `PKG#${PKG}#${VERSION}`,
      SK: FINDING_ID,
    });

    const { UpdateExpression, ExpressionAttributeValues } = updateCall.input;
    expect(UpdateExpression).toMatch(/status/);
    expect(ExpressionAttributeValues).toMatchObject(
      expect.objectContaining({
        [expect.stringMatching(/status/)]:           'false-positive',
        [expect.stringMatching(/suppressedBy/)]:     SUPPRESSOR,
        [expect.stringMatching(/suppressionReason/)]: REASON,
      }),
    );
    // suppressedAt must be set to a non-empty ISO timestamp
    const suppressedAtValue = Object.entries(ExpressionAttributeValues as Record<string, unknown>)
      .find(([k]) => k.includes('suppressedAt'))?.[1] as string | undefined;
    expect(suppressedAtValue).toBeTruthy();
    expect(new Date(suppressedAtValue!).toISOString()).toBe(suppressedAtValue);
  });

  it('also writes a PutCommand for SUPPRESSION#{contentHash} record when --all-versions is passed', async () => {
    mockSend.mockResolvedValueOnce({ Item: MOCK_FINDING }); // Get
    mockSend.mockResolvedValueOnce({});                     // Update (finding)
    mockSend.mockResolvedValueOnce({});                     // Put (suppression rule)

    await suppressFinding(makeDdb(), TABLE, PKG, VERSION, FINDING_ID, {
      reason:       REASON,
      suppressedBy: SUPPRESSOR,
      allVersions:  true,
    });

    const putCalls = mockSend.mock.calls
      .map(([cmd]: [any]) => cmd)
      .filter((cmd: any) => cmd instanceof PutCommand);

    expect(putCalls).toHaveLength(1);
    const putArg = putCalls[0];
    expect(putArg.input.TableName).toBe(TABLE);
    expect(putArg.input.Item.PK).toMatch(/^SUPPRESSION#/);
    expect(putArg.input.Item.SK).toBe('GLOBAL');
    expect(putArg.input.Item.suppressedBy).toBe(SUPPRESSOR);
    expect(putArg.input.Item.suppressionReason).toBe(REASON);
  });

  it('does NOT write a PutCommand for a suppression rule when --all-versions is NOT passed', async () => {
    mockSend.mockResolvedValueOnce({ Item: MOCK_FINDING }); // Get
    mockSend.mockResolvedValueOnce({});                     // Update

    await suppressFinding(makeDdb(), TABLE, PKG, VERSION, FINDING_ID, {
      reason:       REASON,
      suppressedBy: SUPPRESSOR,
      // allVersions omitted
    });

    const putCalls = mockSend.mock.calls
      .map(([cmd]: [any]) => cmd)
      .filter((cmd: any) => cmd instanceof PutCommand);

    expect(putCalls).toHaveLength(0);
  });

  it("throws 'Finding not found' when the finding does not exist", async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined }); // GetCommand returns nothing

    await expect(
      suppressFinding(makeDdb(), TABLE, PKG, VERSION, FINDING_ID, {
        reason:       REASON,
        suppressedBy: SUPPRESSOR,
      }),
    ).rejects.toThrow(/finding not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// unsuppressFinding
// ─────────────────────────────────────────────────────────────────────────────

describe('unsuppressFinding', () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls UpdateCommand to set status='open' and REMOVE suppressedBy/suppressedAt/suppressionReason", async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...MOCK_FINDING, status: 'false-positive' } }); // Get
    mockSend.mockResolvedValueOnce({}); // Update

    await unsuppressFinding(makeDdb(), TABLE, PKG, VERSION, FINDING_ID, {});

    const updateCall = mockSend.mock.calls
      .map(([cmd]: [any]) => cmd)
      .find((cmd: any) => cmd instanceof UpdateCommand);

    expect(updateCall).toBeDefined();
    expect(updateCall.input.Key).toMatchObject({
      PK: `PKG#${PKG}#${VERSION}`,
      SK: FINDING_ID,
    });

    const { UpdateExpression, ExpressionAttributeValues } = updateCall.input;
    // status must be reset to 'open'
    expect(Object.values(ExpressionAttributeValues as Record<string, unknown>)).toContain('open');
    // Suppression fields must be removed
    expect(UpdateExpression).toMatch(/REMOVE/i);
    expect(UpdateExpression).toMatch(/suppressedBy/);
    expect(UpdateExpression).toMatch(/suppressedAt/);
    expect(UpdateExpression).toMatch(/suppressionReason/);
  });

  it('calls DeleteCommand on SUPPRESSION# record when --remove-global-rule is passed', async () => {
    // Finding has a contentFingerprint we can use to build the suppression PK
    const findingWithHash = {
      ...MOCK_FINDING,
      status:      'false-positive',
      contentHash: 'contenthash-abc',
    };
    mockSend.mockResolvedValueOnce({ Item: findingWithHash }); // Get finding
    mockSend.mockResolvedValueOnce({});                         // Update
    mockSend.mockResolvedValueOnce({});                         // Delete suppression rule

    await unsuppressFinding(makeDdb(), TABLE, PKG, VERSION, FINDING_ID, {
      removeGlobalRule: true,
    });

    const deleteCalls = mockSend.mock.calls
      .map(([cmd]: [any]) => cmd)
      .filter((cmd: any) => cmd instanceof DeleteCommand);

    expect(deleteCalls).toHaveLength(1);
    const deleteArg = deleteCalls[0];
    expect(deleteArg.input.TableName).toBe(TABLE);
    expect(deleteArg.input.Key.PK).toMatch(/^SUPPRESSION#/);
    expect(deleteArg.input.Key.SK).toBe('GLOBAL');
  });

  it('does NOT call DeleteCommand when --remove-global-rule is NOT passed', async () => {
    mockSend.mockResolvedValueOnce({ Item: { ...MOCK_FINDING, status: 'false-positive' } });
    mockSend.mockResolvedValueOnce({}); // Update

    await unsuppressFinding(makeDdb(), TABLE, PKG, VERSION, FINDING_ID, {
      // removeGlobalRule omitted
    });

    const deleteCalls = mockSend.mock.calls
      .map(([cmd]: [any]) => cmd)
      .filter((cmd: any) => cmd instanceof DeleteCommand);

    expect(deleteCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildContentHash
// ─────────────────────────────────────────────────────────────────────────────

describe('buildContentHash', () => {
  const BASE_FINDING = {
    cwe_id:         'CWE-89',
    description:    'SQL injection via user-supplied input to query parameter',
    recommendation: 'Use parameterised queries or an ORM',
  };

  it('is deterministic — same inputs always produce the same hash', () => {
    const hash1 = buildContentHash(BASE_FINDING);
    const hash2 = buildContentHash(BASE_FINDING);
    const hash3 = buildContentHash({ ...BASE_FINDING }); // different object reference

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
  });

  it('produces a non-empty hex string', () => {
    const hash = buildContentHash(BASE_FINDING);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('produces a different hash when cwe_id differs', () => {
    const hash1 = buildContentHash(BASE_FINDING);
    const hash2 = buildContentHash({ ...BASE_FINDING, cwe_id: 'CWE-79' });
    expect(hash1).not.toBe(hash2);
  });

  it('produces a different hash when description differs', () => {
    const hash1 = buildContentHash(BASE_FINDING);
    const hash2 = buildContentHash({ ...BASE_FINDING, description: 'Different description' });
    expect(hash1).not.toBe(hash2);
  });

  it('produces a different hash when recommendation differs', () => {
    const hash1 = buildContentHash(BASE_FINDING);
    const hash2 = buildContentHash({ ...BASE_FINDING, recommendation: 'Different recommendation' });
    expect(hash1).not.toBe(hash2);
  });

  it('truncates description to 500 chars and recommendation to 200 chars for hashing', () => {
    // Two findings whose long description/recommendation differ only past the truncation
    // boundary should hash identically (spec: hash(cwe_id:desc[:500]:rec[:200]))
    const longDesc = 'A'.repeat(600);
    const longRec  = 'B'.repeat(300);

    const hash1 = buildContentHash({
      cwe_id:         'CWE-22',
      description:    longDesc,
      recommendation: longRec,
    });
    const hash2 = buildContentHash({
      cwe_id:         'CWE-22',
      description:    longDesc + 'EXTRA',     // difference past char 500
      recommendation: longRec + 'EXTRA',       // difference past char 200
    });
    // Both should hash the same because the extra suffix is beyond the slice boundary
    expect(hash1).toBe(hash2);
  });
});
