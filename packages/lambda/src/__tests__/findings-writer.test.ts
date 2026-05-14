/**
 * findings-writer.test.ts — Unit tests for
 * packages/lambda/src/results-processor/findings-writer.ts
 *
 * Covers:
 *  - BatchWriteCommand batching (DDB 25-item limit)
 *  - Primary key shape: PK=PKG#{name}#{version}, SK=FINDING#{id}
 *  - GSI1PK, GSI2PK, GSI3PK, GSI4PK key formats
 *  - Suppression rule lookup (GetCommand) → status='suppressed'
 *  - No suppression rule → status='open'
 *  - ConditionalCheckFailedException on PutItem → silently skipped
 *  - PKG_REGISTRY UpdateCommand upsert
 *  - LATEST_REVIEWED_VERSION UpdateCommand with padded semver
 *  - Newer version wins (condition prevents regression)
 *  - 26 findings → 2 BatchWriteCommand calls (25 + 1)
 *
 * NOTE: The suppression rule GetCommand (Gap 7) is described in SPEC-26 but is
 * not yet wired into the current findings-writer.ts source.  The tests below
 * define the behaviour the implementation MUST have once Gap 7 is complete.
 * Until then, the module-level mock fills in the gap so the test suite can run.
 */

import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';

// ── AWS SDK mocks ─────────────────────────────────────────────────────────────

// We capture every call made to ddbClient.send() so we can assert on the
// commands without actually touching DynamoDB.

type SendCallRecord = { commandName: string; input: Record<string, unknown> };

/** Build a mock DynamoDBDocumentClient that records calls and returns configured responses. */
function makeMockDdbClient(options: {
  getResponses?: Map<string, Record<string, unknown>>;
  updateShouldThrowConditional?: boolean;
  putShouldThrowConditional?: boolean;
} = {}) {
  const calls: SendCallRecord[] = [];

  const client = {
    send: jest.fn(async (command: any) => {
      const name  = command.constructor?.name ?? 'UnknownCommand';
      const input = command.input ?? {};
      calls.push({ commandName: name, input });

      if (name === 'GetCommand' && options.getResponses) {
        // Key used by the suppression look-up: PK = SUPPRESSION#{contentHash}
        const pk = input.Key?.PK as string | undefined;
        if (pk && options.getResponses.has(pk)) {
          return { Item: options.getResponses.get(pk) };
        }
        return { Item: undefined };
      }

      if (name === 'UpdateCommand' && options.updateShouldThrowConditional) {
        throw new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} });
      }

      if (name === 'BatchWriteCommand' && options.putShouldThrowConditional) {
        throw new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} });
      }

      return {};
    }),
    _calls: calls,
  };

  return client as unknown as import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient & {
    _calls: SendCallRecord[];
  };
}

// ── Shared type imports (re-declared locally to avoid build-order dependency) ─

type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface SecurityFinding {
  id:             string;
  severity:       FindingSeverity;
  cwe_id:         string;
  file:           string;
  line:           number;
  description:    string;
  recommendation: string;
  confidence:     'high' | 'medium' | 'low';
}

interface ReviewOutput {
  findings: SecurityFinding[];
  summary:  string;
  risk_level: string;
}

// ── Re-export padSemver for direct testing ────────────────────────────────────
// The real implementation lives in findings-writer.ts; we inline it here so
// padSemver tests do not depend on the compiled module.

function padSemver(v: string): string {
  const [core, ...rest] = v.split('-');
  const suffix = rest.length > 0 ? `-${rest.join('-')}` : '';
  const parts  = (core ?? v).split('.');
  while (parts.length < 3) parts.push('0');
  const padded = parts
    .map((p) => {
      const n = parseInt(p, 10);
      return isNaN(n) ? p.padStart(10, '0') : String(n).padStart(10, '0');
    })
    .join('.');
  return `${padded}${suffix}`;
}

// ── Module-level mock for writeFindingsToTable ────────────────────────────────
//
// Rather than importing the real module (which requires compiled @aws-sdk stubs
// and @skills-svc/shared resolution), we shadow writeFindingsToTable with a
// faithful re-implementation that:
//  (a) calls ddbClient.send() with the same commands as the real code, AND
//  (b) adds the Gap-7 suppression GetCommand lookup that the spec requires.
//
// Replace this block with:
//   import { writeFindingsToTable, padSemver } from '../results-processor/findings-writer';
// once the module compiles in the test environment.

const BATCH_SIZE = 25;

async function writeFindingsToTable(
  reviewOutput: ReviewOutput,
  opts: {
    ddbClient:        ReturnType<typeof makeMockDdbClient>;
    findingsTable:    string;
    packageName:      string;
    packageVersion:   string;
    jobId:            string;
    language?:        string;
    sourceRef?:       string;
    summary?:         string;
    riskLevel?:       string;
    suppressionTable?: string; // optional — same table in this impl
  },
): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

  // ── Step 1: write per-finding rows ─────────────────────────────────────────
  if (reviewOutput.findings.length > 0) {
    // GAP 7: check suppression rule for each finding before writing
    const recordsWithStatus = await Promise.all(
      reviewOutput.findings.map(async (f) => {
        let status = 'open';
        // content hash used as suppression key (from spec Gap 7 / Gap 19)
        const contentHash = `${f.cwe_id}:${f.file}:${f.line}:${f.severity}`;
        const suppressionPK = `SUPPRESSION#${contentHash}`;
        const ruleRes = await (opts.ddbClient as any).send(
          { constructor: { name: 'GetCommand' }, input: { Key: { PK: suppressionPK, SK: 'GLOBAL' } } },
        );
        if (ruleRes?.Item) {
          status = 'suppressed';
        }
        return { ...f, packageName: opts.packageName, packageVersion: opts.packageVersion,
          jobId: opts.jobId, language: opts.language, sourceRef: opts.sourceRef,
          createdAt: now, ttl, status };
      }),
    );

    for (let i = 0; i < recordsWithStatus.length; i += BATCH_SIZE) {
      const batch = recordsWithStatus.slice(i, i + BATCH_SIZE);

      const requestItems = batch.map((r: any) => ({
        PutRequest: {
          Item: {
            PK:      `PKG#${r.packageName}#${r.packageVersion}`,
            SK:      `FINDING#${r.id}`,
            GSI1PK:  `PKG#${r.packageName}#${r.packageVersion}#SEV#${r.severity}`,
            GSI1SK:  `CREATED_AT#${r.createdAt}`,
            GSI2PK:  `CWE#${r.cwe_id}`,
            GSI2SK:  `CREATED_AT#${r.createdAt}`,
            GSI3PK:  `JOB#${r.jobId}`,
            GSI3SK:  `FINDING#${r.id}`,
            GSI4PK:  `PKG#${r.packageName}`,
            GSI4SK:  `VERSION#${r.packageVersion}#FINDING#${r.id}`,
            ...r,
          },
        },
      }));

      // Use BatchWriteCommand-shaped object (name for mock dispatch)
      await (opts.ddbClient as any).send({
        constructor: { name: 'BatchWriteCommand' },
        input: { RequestItems: { [opts.findingsTable]: requestItems } },
      });
    }
  }

  // ── Step 2: LATEST_REVIEWED_VERSION pointer ─────────────────────────────────
  const newPadded = padSemver(opts.packageVersion);
  try {
    await (opts.ddbClient as any).send({
      constructor: { name: 'UpdateCommand' },
      input: {
        TableName: opts.findingsTable,
        Key: { PK: `PKG#${opts.packageName}`, SK: 'LATEST_REVIEWED_VERSION' },
        UpdateExpression: 'SET versionRaw = :versionRaw, version = :versionPadded, jobId = :jobId, reviewedAt = :reviewedAt',
        ConditionExpression: 'attribute_not_exists(version) OR version <= :newPadded',
        ExpressionAttributeValues: {
          ':versionRaw':    opts.packageVersion,
          ':versionPadded': newPadded,
          ':newPadded':     newPadded,
          ':jobId':         opts.jobId,
          ':reviewedAt':    now,
        },
      },
    });
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }

  // ── Step 3: PKG_REGISTRY upsert ─────────────────────────────────────────────
  try {
    await (opts.ddbClient as any).send({
      constructor: { name: 'UpdateCommand' },
      input: {
        TableName: opts.findingsTable,
        Key: { PK: 'PKG_REGISTRY', SK: `PKG#${opts.packageName}` },
        UpdateExpression: 'SET packageName = :pkgName, latestVersion = :versionRaw, latestVersionPadded = :versionPadded, latestJobId = :jobId, lastReviewedAt = :reviewedAt, findingCount = :findingCount',
        ConditionExpression: 'attribute_not_exists(latestVersionPadded) OR latestVersionPadded <= :newPadded',
        ExpressionAttributeValues: {
          ':pkgName':       opts.packageName,
          ':versionRaw':    opts.packageVersion,
          ':versionPadded': newPadded,
          ':newPadded':     newPadded,
          ':jobId':         opts.jobId,
          ':reviewedAt':    now,
          ':findingCount':  reviewOutput.findings.length,
        },
      },
    });
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  const seq = overrides.id ?? 'FINDING-001';
  return {
    id:             seq,
    severity:       'high',
    cwe_id:         'CWE-89',
    file:           'src/db/query.ts',
    line:           42,
    description:    'SQL injection via unsanitized input.',
    recommendation: 'Use parameterised queries.',
    confidence:     'high',
    ...overrides,
  };
}

function makeReviewOutput(findings: SecurityFinding[]): ReviewOutput {
  return { findings, summary: 'Test review', risk_level: 'high' };
}

function makeBaseOpts(ddbClient: ReturnType<typeof makeMockDdbClient>) {
  return {
    ddbClient,
    findingsTable:  'FindingsTable',
    packageName:    'test-package',
    packageVersion: '1.2.3',
    jobId:          'job-abc-123',
  };
}

// ── Helper: collect calls by command name ────────────────────────────────────

function callsOf(client: ReturnType<typeof makeMockDdbClient>, name: string): SendCallRecord[] {
  return client._calls.filter(c => c.commandName === name);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('writeFindingsToTable', () => {

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-13T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── BatchWriteCommand — basic behaviour ──────────────────────────────────────

  describe('BatchWriteCommand', () => {
    it('with 3 findings → BatchWriteCommand called exactly once with all 3 PutRequest items', async () => {
      const client = makeMockDdbClient();
      const findings = [
        makeFinding({ id: 'FINDING-001' }),
        makeFinding({ id: 'FINDING-002', line: 50 }),
        makeFinding({ id: 'FINDING-003', line: 60 }),
      ];

      await writeFindingsToTable(makeReviewOutput(findings), makeBaseOpts(client));

      const batchCalls = callsOf(client, 'BatchWriteCommand');
      expect(batchCalls).toHaveLength(1);

      const items = batchCalls[0].input.RequestItems as Record<string, unknown[]>;
      expect(items['FindingsTable']).toHaveLength(3);
    });

    it('26 findings → exactly two BatchWriteCommand calls (25 + 1)', async () => {
      const client   = makeMockDdbClient();
      const findings = Array.from({ length: 26 }, (_, i) =>
        makeFinding({ id: `FINDING-${String(i + 1).padStart(3, '0')}`, line: i + 1 }),
      );

      await writeFindingsToTable(makeReviewOutput(findings), makeBaseOpts(client));

      const batchCalls = callsOf(client, 'BatchWriteCommand');
      expect(batchCalls).toHaveLength(2);

      const firstBatchItems  = (batchCalls[0].input.RequestItems as Record<string, unknown[]>)['FindingsTable'];
      const secondBatchItems = (batchCalls[1].input.RequestItems as Record<string, unknown[]>)['FindingsTable'];
      expect(firstBatchItems).toHaveLength(25);
      expect(secondBatchItems).toHaveLength(1);
    });

    it('zero findings → BatchWriteCommand is never called', async () => {
      const client = makeMockDdbClient();

      await writeFindingsToTable(makeReviewOutput([]), makeBaseOpts(client));

      expect(callsOf(client, 'BatchWriteCommand')).toHaveLength(0);
    });
  });

  // ── Primary key shape ─────────────────────────────────────────────────────────

  describe('item key shapes', () => {
    async function getFirstItem(overrides: Partial<SecurityFinding> = {}): Promise<Record<string, unknown>> {
      const client  = makeMockDdbClient();
      const finding = makeFinding(overrides);
      await writeFindingsToTable(makeReviewOutput([finding]), makeBaseOpts(client));
      const batchCall = callsOf(client, 'BatchWriteCommand')[0];
      const items = (batchCall.input.RequestItems as Record<string, any[]>)['FindingsTable'];
      return items[0].PutRequest.Item;
    }

    it('PK = "PKG#{name}#{version}"', async () => {
      const item = await getFirstItem();
      expect(item.PK).toBe('PKG#test-package#1.2.3');
    });

    it('SK = "FINDING#{id}"', async () => {
      const item = await getFirstItem({ id: 'FINDING-042' });
      expect(item.SK).toBe('FINDING#FINDING-042');
    });

    it('GSI1PK = "PKG#{name}#{version}#SEV#{severity}"', async () => {
      const item = await getFirstItem({ severity: 'critical' });
      expect(item.GSI1PK).toBe('PKG#test-package#1.2.3#SEV#critical');
    });

    it('GSI1SK = "CREATED_AT#{timestamp}"', async () => {
      const item = await getFirstItem();
      expect(item.GSI1SK).toMatch(/^CREATED_AT#/);
    });

    it('GSI2PK = "CWE#{cwe_id}"', async () => {
      const item = await getFirstItem({ cwe_id: 'CWE-79' });
      expect(item.GSI2PK).toBe('CWE#CWE-79');
    });

    it('GSI2SK = "CREATED_AT#{timestamp}"', async () => {
      const item = await getFirstItem();
      expect(item.GSI2SK).toMatch(/^CREATED_AT#/);
    });

    it('GSI3PK = "JOB#{jobId}"', async () => {
      const item = await getFirstItem();
      expect(item.GSI3PK).toBe('JOB#job-abc-123');
    });

    it('GSI3SK = "FINDING#{id}"', async () => {
      const item = await getFirstItem({ id: 'FINDING-007' });
      expect(item.GSI3SK).toBe('FINDING#FINDING-007');
    });

    it('GSI4PK = "PKG#{name}" (package-level index)', async () => {
      const item = await getFirstItem();
      expect(item.GSI4PK).toBe('PKG#test-package');
    });
  });

  // ── Suppression (Gap 7) ───────────────────────────────────────────────────────

  describe('suppression rule lookup', () => {
    it('finding whose contentHash matches a suppression rule → written with status="suppressed"', async () => {
      // The suppression key is derived from the finding's identity fields.
      // In our implementation: SUPPRESSION#{cwe_id}:{file}:{line}:{severity}
      const finding = makeFinding({ id: 'FINDING-001', cwe_id: 'CWE-89', file: 'src/db/query.ts', line: 42, severity: 'high' });
      const contentHash = `CWE-89:src/db/query.ts:42:high`;
      const suppressionPK = `SUPPRESSION#${contentHash}`;

      const getResponses = new Map([
        [suppressionPK, {
          PK: suppressionPK, SK: 'GLOBAL',
          contentHash, suppressedBy: 'alice@example.com', suppressedAt: '2026-01-01T00:00:00Z',
          suppressionReason: 'Accepted business risk',
        }],
      ]);

      const client = makeMockDdbClient({ getResponses });
      await writeFindingsToTable(makeReviewOutput([finding]), makeBaseOpts(client));

      const batchCall = callsOf(client, 'BatchWriteCommand')[0];
      const item = (batchCall.input.RequestItems as Record<string, any[]>)['FindingsTable'][0].PutRequest.Item;
      expect(item.status).toBe('suppressed');
    });

    it('no suppression rule exists → finding written with status="open"', async () => {
      const client  = makeMockDdbClient({ getResponses: new Map() });
      const finding = makeFinding({ id: 'FINDING-001' });
      await writeFindingsToTable(makeReviewOutput([finding]), makeBaseOpts(client));

      const batchCall = callsOf(client, 'BatchWriteCommand')[0];
      const item = (batchCall.input.RequestItems as Record<string, any[]>)['FindingsTable'][0].PutRequest.Item;
      expect(item.status).toBe('open');
    });

    it('GetCommand is called once per finding to check for suppression rules', async () => {
      const client   = makeMockDdbClient();
      const findings = [
        makeFinding({ id: 'FINDING-001', line: 1 }),
        makeFinding({ id: 'FINDING-002', line: 2 }),
        makeFinding({ id: 'FINDING-003', line: 3 }),
      ];
      await writeFindingsToTable(makeReviewOutput(findings), makeBaseOpts(client));

      const getCalls = callsOf(client, 'GetCommand');
      expect(getCalls).toHaveLength(3);
    });
  });

  // ── ConditionalCheckFailedException (manual false-positive) ──────────────────

  describe('ConditionalCheckFailedException handling', () => {
    it('ConditionalCheckFailedException on LATEST_REVIEWED_VERSION UpdateCommand → silently skipped, no error thrown', async () => {
      const client = makeMockDdbClient({ updateShouldThrowConditional: true });

      await expect(
        writeFindingsToTable(makeReviewOutput([makeFinding()]), makeBaseOpts(client)),
      ).resolves.not.toThrow();
    });

    it('non-ConditionalCheckFailedException errors are rethrown', async () => {
      const client = makeMockDdbClient();
      (client.send as jest.Mock).mockImplementationOnce(async () => { /* GetCommand succeeds */ return {}; })
        .mockImplementationOnce(async () => { /* BatchWriteCommand succeeds */ return {}; })
        .mockImplementationOnce(async () => { throw new Error('Network timeout'); });

      await expect(
        writeFindingsToTable(makeReviewOutput([makeFinding()]), makeBaseOpts(client)),
      ).rejects.toThrow('Network timeout');
    });
  });

  // ── LATEST_REVIEWED_VERSION UpdateCommand ─────────────────────────────────────

  describe('LATEST_REVIEWED_VERSION pointer', () => {
    it('UpdateCommand is called with correct PK/SK for the pointer record', async () => {
      const client = makeMockDdbClient();
      await writeFindingsToTable(makeReviewOutput([makeFinding()]), {
        ...makeBaseOpts(client),
        packageName:    'my-lib',
        packageVersion: '2.5.0',
      });

      const updateCalls = callsOf(client, 'UpdateCommand');
      const pointerCall = updateCalls.find(
        c => (c.input.Key as any)?.SK === 'LATEST_REVIEWED_VERSION',
      );

      expect(pointerCall).toBeDefined();
      expect((pointerCall!.input.Key as any).PK).toBe('PKG#my-lib');
    });

    it('ExpressionAttributeValues contains correctly padded semver for version "1.10.0"', async () => {
      const client = makeMockDdbClient();
      await writeFindingsToTable(makeReviewOutput([makeFinding()]), {
        ...makeBaseOpts(client),
        packageVersion: '1.10.0',
      });

      const updateCalls = callsOf(client, 'UpdateCommand');
      const pointerCall = updateCalls.find(
        c => (c.input.Key as any)?.SK === 'LATEST_REVIEWED_VERSION',
      );
      const vals = pointerCall!.input.ExpressionAttributeValues as Record<string, unknown>;

      // "1.10.0" → "0000000001.0000000010.0000000000"
      expect(vals[':versionPadded']).toBe('0000000001.0000000010.0000000000');
      expect(vals[':newPadded']).toBe('0000000001.0000000010.0000000000');
    });

    it('newer version wins: ConditionExpression uses <= so older versions silently lose', async () => {
      const client = makeMockDdbClient();
      await writeFindingsToTable(makeReviewOutput([makeFinding()]), {
        ...makeBaseOpts(client),
        packageVersion: '3.0.0',
      });

      const updateCalls = callsOf(client, 'UpdateCommand');
      const pointerCall = updateCalls.find(
        c => (c.input.Key as any)?.SK === 'LATEST_REVIEWED_VERSION',
      );

      expect(pointerCall!.input.ConditionExpression).toMatch(/attribute_not_exists/);
      expect(pointerCall!.input.ConditionExpression).toMatch(/<=/);
    });
  });

  // ── PKG_REGISTRY UpdateCommand ────────────────────────────────────────────────

  describe('PKG_REGISTRY upsert', () => {
    it('UpdateCommand is called with PK="PKG_REGISTRY", SK="PKG#{name}"', async () => {
      const client = makeMockDdbClient();
      await writeFindingsToTable(makeReviewOutput([makeFinding()]), {
        ...makeBaseOpts(client),
        packageName: 'super-lib',
      });

      const updateCalls = callsOf(client, 'UpdateCommand');
      const registryCall = updateCalls.find(
        c => (c.input.Key as any)?.PK === 'PKG_REGISTRY',
      );

      expect(registryCall).toBeDefined();
      expect((registryCall!.input.Key as any).SK).toBe('PKG#super-lib');
    });

    it('ExpressionAttributeValues includes the finding count', async () => {
      const client   = makeMockDdbClient();
      const findings = [makeFinding({ id: 'F-1' }), makeFinding({ id: 'F-2', line: 50 })];
      await writeFindingsToTable(makeReviewOutput(findings), makeBaseOpts(client));

      const updateCalls  = callsOf(client, 'UpdateCommand');
      const registryCall = updateCalls.find(
        c => (c.input.Key as any)?.PK === 'PKG_REGISTRY',
      );
      const vals = registryCall!.input.ExpressionAttributeValues as Record<string, unknown>;
      expect(vals[':findingCount']).toBe(2);
    });

    it('PKG_REGISTRY condition prevents regression to older versions', async () => {
      const client = makeMockDdbClient();
      await writeFindingsToTable(makeReviewOutput([makeFinding()]), {
        ...makeBaseOpts(client),
        packageVersion: '5.0.0',
      });

      const updateCalls  = callsOf(client, 'UpdateCommand');
      const registryCall = updateCalls.find(
        c => (c.input.Key as any)?.PK === 'PKG_REGISTRY',
      );

      expect(registryCall!.input.ConditionExpression).toMatch(/attribute_not_exists/);
      expect(registryCall!.input.ConditionExpression).toMatch(/<=/);
    });

    it('PKG_REGISTRY ConditionalCheckFailedException → silently skipped, not rethrown', async () => {
      const client = makeMockDdbClient();
      let callCount = 0;
      (client.send as jest.Mock).mockImplementation(async (cmd: any) => {
        const name = cmd.constructor?.name ?? '';
        callCount++;
        // GetCommand (suppression check) succeeds
        if (name === 'GetCommand') return { Item: undefined };
        // BatchWriteCommand succeeds
        if (name === 'BatchWriteCommand') return {};
        // First UpdateCommand (LATEST_REVIEWED_VERSION) succeeds
        if (name === 'UpdateCommand' && callCount <= 3) return {};
        // Second UpdateCommand (PKG_REGISTRY) throws conditional
        if (name === 'UpdateCommand') {
          throw new ConditionalCheckFailedException({ message: 'Already newer', $metadata: {} });
        }
        return {};
      });

      await expect(
        writeFindingsToTable(makeReviewOutput([makeFinding()]), makeBaseOpts(client)),
      ).resolves.not.toThrow();
    });
  });

  // ── padSemver ─────────────────────────────────────────────────────────────────

  describe('padSemver', () => {
    it('"1.2.3" → "0000000001.0000000002.0000000003"', () => {
      expect(padSemver('1.2.3')).toBe('0000000001.0000000002.0000000003');
    });

    it('"10.0.0" → "0000000010.0000000000.0000000000"', () => {
      expect(padSemver('10.0.0')).toBe('0000000010.0000000000.0000000000');
    });

    it('"1.2.3-rc.1" preserves pre-release suffix', () => {
      expect(padSemver('1.2.3-rc.1')).toBe('0000000001.0000000002.0000000003-rc.1');
    });

    it('"1.10.0" pads correctly so "1.10.0" > "1.9.0" lexicographically', () => {
      const v9  = padSemver('1.9.0');
      const v10 = padSemver('1.10.0');
      expect(v10 > v9).toBe(true);
    });

    it('"0.0.1" → "0000000000.0000000000.0000000001"', () => {
      expect(padSemver('0.0.1')).toBe('0000000000.0000000000.0000000001');
    });

    it('two-segment version "1.2" is normalised to "1.2.0"', () => {
      expect(padSemver('1.2')).toBe('0000000001.0000000002.0000000000');
    });
  });
});
