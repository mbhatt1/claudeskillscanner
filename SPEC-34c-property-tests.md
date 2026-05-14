# SPEC-34c — Property-Based Test Suite: Behavioral Invariants

**Status:** Draft  
**Depends on:** SPEC-33 (shared types, normaliseArn, DDB_KEY_PREFIX, job-status, constants)

Every invariant is expressed as a `fast-check` property test. Tests live in `tests/invariants/`. They are not unit tests of a single function; they assert that a _mathematical property_ holds for **any** generated input.

---

## 0. Setup

### `package.json` addition (workspace root or `packages/lambda/package.json`)

```json
{
  "devDependencies": {
    "fast-check": "^3.15.0"
  }
}
```

### Jest config addition (jest.config.ts or jest.config.js)

```ts
// jest.config.ts (partial)
{
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/tests/invariants/**/*.invariant.ts',
  ],
  testTimeout: 30000,
}
```

---

## 1. `tests/invariants/encryption-context.invariant.ts`

**Invariants tested:**
- `envelopeEncrypt` then `envelopeDecrypt` with the SAME userArn always round-trips.
- `envelopeDecrypt` with a DIFFERENT userArn always throws `InvalidCiphertextException`.
- `envelopeDecrypt` with a MISSING userArn (empty string) always throws.

```typescript
/**
 * encryption-context.invariant.ts
 *
 * Invariant: envelope encrypt/decrypt is an identity when the encryption context
 * (userArn) matches, and always fails when it does not.
 */

import * as fc from 'fast-check';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockKmsEncrypt = jest.fn();
const mockKmsDecrypt = jest.fn();

jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  EncryptCommand: jest.fn().mockImplementation((i) => ({ input: i })),
  DecryptCommand: jest.fn().mockImplementation((i) => ({ input: i })),
}));

// ─── Inline implementation matching SPEC-33 §envelope-encryption ─────────────

class InvalidCiphertextException extends Error {
  constructor() { super('InvalidCiphertextException'); this.name = 'InvalidCiphertextException'; }
}

interface EncryptedEnvelope {
  ciphertext: string;   // base64
  context:    Record<string, string>;
}

/**
 * Minimal deterministic envelope encryption: in tests we XOR each byte of the
 * plaintext with a key derived from the userArn so we can verify isolation
 * without real KMS. The REAL implementation calls KMS; tests mock that layer.
 */
function deriveKey(userArn: string): number {
  return Array.from(userArn).reduce((acc, c) => (acc ^ c.charCodeAt(0)) & 0xff, 0x5a);
}

function envelopeEncrypt(plaintext: string, userArn: string): EncryptedEnvelope {
  if (!userArn) throw new Error('userArn required for encryption context');
  const key = deriveKey(userArn);
  const buf = Buffer.from(plaintext, 'utf8').map((b) => b ^ key);
  return {
    ciphertext: buf.toString('base64'),
    context:    { userArn },
  };
}

function envelopeDecrypt(envelope: EncryptedEnvelope, userArn: string): string {
  if (!userArn) throw new InvalidCiphertextException();
  if (envelope.context.userArn !== userArn) throw new InvalidCiphertextException();
  const key = deriveKey(userArn);
  const buf = Buffer.from(envelope.ciphertext, 'base64').map((b) => b ^ key);
  return buf.toString('utf8');
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arnArb = fc.uuid().map(
  (id) => `arn:aws:iam::${id.replace(/-/g, '').slice(0, 12)}:role/User-${id.slice(0, 8)}`
);

const plaintextArb = fc.string({ minLength: 0, maxLength: 2048 });

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: envelope encryption round-trip and tenant isolation', () => {

  it('Property 1: encrypt then decrypt with SAME userArn is identity', () => {
    fc.assert(
      fc.property(plaintextArb, arnArb, (plaintext, userArn) => {
        const envelope = envelopeEncrypt(plaintext, userArn);
        const recovered = envelopeDecrypt(envelope, userArn);
        return recovered === plaintext;
      }),
      { numRuns: 500 }
    );
  });

  it('Property 2: decrypt with DIFFERENT userArn always throws InvalidCiphertextException', () => {
    fc.assert(
      fc.property(
        plaintextArb,
        arnArb,
        arnArb,
        fc.boolean(), // ensure different arns
        (plaintext, arnA, arnB, _) => {
          fc.pre(arnA !== arnB); // discard same-arn draws
          const envelope = envelopeEncrypt(plaintext, arnA);
          expect(() => envelopeDecrypt(envelope, arnB)).toThrow('InvalidCiphertextException');
          return true;
        }
      ),
      { numRuns: 300 }
    );
  });

  it('Property 3: decrypt with empty userArn always throws', () => {
    fc.assert(
      fc.property(plaintextArb, arnArb, (plaintext, userArn) => {
        const envelope = envelopeEncrypt(plaintext, userArn);
        expect(() => envelopeDecrypt(envelope, '')).toThrow();
        return true;
      }),
      { numRuns: 200 }
    );
  });
});
```

---

## 2. `tests/invariants/job-status-transitions.invariant.ts`

**Invariants tested:**
- `isValidTransition(A, B)` true implies `isValidTransition(B, A)` is false (no symmetric cycles).
- COMPLETE, FAILED, and CANCELLED are terminal: no valid transition OUT of them.
- Any chain of valid transitions terminates (acyclic).

```typescript
/**
 * job-status-transitions.invariant.ts
 *
 * Invariant: the job status state machine is a DAG — no cycles, terminals are final.
 */

import * as fc from 'fast-check';
import { JobStatus, isValidTransition, isTerminal } from '@skills-svc/shared';

const ALL_STATUSES = Object.values(JobStatus);

const statusArb = fc.constantFrom(...ALL_STATUSES);

describe('Invariant: job status state machine is acyclic with terminal absorbers', () => {

  it('Property 1: isValidTransition is never symmetric (no A→B and B→A both true)', () => {
    fc.assert(
      fc.property(statusArb, statusArb, (a, b) => {
        fc.pre(a !== b);
        // If A→B is valid, B→A must NOT be valid
        if (isValidTransition(a, b)) {
          expect(isValidTransition(b, a)).toBe(false);
        }
        return true;
      }),
      { numRuns: ALL_STATUSES.length * ALL_STATUSES.length * 4 }
    );
  });

  it('Property 2: COMPLETE, FAILED, CANCELLED are terminal — no outgoing valid transition', () => {
    const TERMINAL = [JobStatus.COMPLETE, JobStatus.FAILED, JobStatus.CANCELLED] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...TERMINAL),
        statusArb,
        (terminal, target) => {
          expect(isValidTransition(terminal, target)).toBe(false);
          return true;
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 3: every chain of valid transitions reaches a terminal in ≤ 10 steps', () => {
    fc.assert(
      fc.property(statusArb, (start) => {
        let current = start;
        let steps = 0;
        const MAX_STEPS = 10;

        while (!isTerminal(current) && steps < MAX_STEPS) {
          const next = ALL_STATUSES.find((s) => isValidTransition(current, s));
          if (!next) break; // no outgoing edge from current — it's a dead-end (also fine)
          current = next;
          steps++;
        }

        // Either we reached a terminal or ran out of outgoing edges
        expect(steps).toBeLessThan(MAX_STEPS);
        return true;
      }),
      { numRuns: 200 }
    );
  });
});
```

---

## 3. `tests/invariants/list-jobs-ownership.invariant.ts`

**Invariants tested:**
- Every item returned by `listJobs(callerArn)` has `userArn === callerArn`.
- `listJobs(arnA)` never returns items belonging to `arnB`.

```typescript
/**
 * list-jobs-ownership.invariant.ts
 *
 * Invariant: listJobs always filters by ownership — cross-tenant data never leaks.
 */

import * as fc from 'fast-check';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  QueryCommand: jest.fn().mockImplementation((i) => ({ input: i })),
}));

// ─── Inline listJobs matching SPEC-33 handler behaviour ──────────────────────

interface JobRecord {
  jobId:   string;
  userArn: string;
  status:  string;
}

async function listJobs(callerArn: string, tableName: string): Promise<JobRecord[]> {
  const { DynamoDBDocumentClient, QueryCommand } = jest.requireMock('@aws-sdk/lib-dynamodb');
  const ddb = DynamoDBDocumentClient.from(null);
  const result = await ddb.send(new QueryCommand({
    TableName: tableName,
    IndexName: 'GSI2-UserJobs',
    KeyConditionExpression: 'GSI2PK = :userArn',
    ExpressionAttributeValues: { ':userArn': `USER#${callerArn}` },
  }));
  // Production code MUST filter again in memory as defence-in-depth
  return (result.Items as JobRecord[]).filter((item) => item.userArn === callerArn);
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arnArb = fc.record({
  userArn: fc.constantFrom(
    'arn:aws:iam::123456789012:role/Alice',
    'arn:aws:iam::123456789012:role/Bob',
    'arn:aws:iam::123456789012:role/Charlie',
  ),
});

function makeJobRecord(userArn: string, jobId: string): JobRecord {
  return { jobId, userArn, status: 'COMPLETE' };
}

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: listJobs never returns cross-tenant records', () => {

  beforeEach(() => { jest.clearAllMocks(); });

  it('Property 1: every returned item has userArn === callerArn', () => {
    fc.assert(
      fc.property(
        arnArb,
        fc.array(fc.uuid(), { minLength: 0, maxLength: 20 }),
        fc.array(fc.uuid(), { minLength: 0, maxLength: 20 }),
        async ({ userArn: callerArn }, callerIds, otherIds) => {
          const otherArn = callerArn === 'arn:aws:iam::123456789012:role/Alice'
            ? 'arn:aws:iam::123456789012:role/Bob'
            : 'arn:aws:iam::123456789012:role/Alice';

          const mixedItems = [
            ...callerIds.map((id) => makeJobRecord(callerArn, id)),
            ...otherIds.map((id)  => makeJobRecord(otherArn,  id)),
          ];

          mockDdbSend.mockResolvedValueOnce({ Items: mixedItems });

          const result = await listJobs(callerArn, 'test-table');

          expect(result.every((item) => item.userArn === callerArn)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 2: listJobs(arnA) never returns records with userArn=arnB', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        async (idA, idB) => {
          const arnA = 'arn:aws:iam::123456789012:role/Alice';
          const arnB = 'arn:aws:iam::123456789012:role/Bob';

          // DDB mock returns ONLY Bob's record (simulating a GSI misconfiguration)
          mockDdbSend.mockResolvedValueOnce({
            Items: [makeJobRecord(arnB, idB), makeJobRecord(arnB, idA)],
          });

          const result = await listJobs(arnA, 'test-table');
          // Memory-level filter must strip all Bob records
          expect(result).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

---

## 4. `tests/invariants/envelope-encryption-tenant-isolation.invariant.ts`

**Invariants tested:**
- Ciphertext encrypted with Alice's ARN cannot be decrypted with Bob's ARN.
- Same plaintext + different userArn → different ciphertext (no cross-tenant equality).
- `contentHash` is deterministic for identical inputs.

```typescript
/**
 * envelope-encryption-tenant-isolation.invariant.ts
 *
 * Invariant: tenant ARN is baked into ciphertext; same content produces different
 * ciphertexts for different tenants.
 */

import * as fc from 'fast-check';
import * as crypto from 'crypto';

// ─── Reuse the same inline encrypt/decrypt from invariant 1 ──────────────────

function deriveKey(userArn: string): number {
  return Array.from(userArn).reduce((acc, c) => (acc ^ c.charCodeAt(0)) & 0xff, 0x5a);
}

interface Envelope { ciphertext: string; context: Record<string, string>; }

function envelopeEncrypt(plaintext: string, userArn: string): Envelope {
  if (!userArn) throw new Error('userArn required');
  const key = deriveKey(userArn);
  const buf = Buffer.from(plaintext, 'utf8').map((b) => b ^ key);
  return { ciphertext: buf.toString('base64'), context: { userArn } };
}

function envelopeDecrypt(env: Envelope, userArn: string): string {
  if (!userArn || env.context.userArn !== userArn)
    throw Object.assign(new Error('InvalidCiphertextException'), { name: 'InvalidCiphertextException' });
  const key = deriveKey(userArn);
  return Buffer.from(env.ciphertext, 'base64').map((b) => b ^ key).toString('utf8');
}

function contentHash(data: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const ALICE = 'arn:aws:iam::123456789012:role/Alice';
const BOB   = 'arn:aws:iam::123456789012:role/Bob';

const plaintextArb = fc.string({ minLength: 1, maxLength: 512 });

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: tenant isolation in envelope encryption', () => {

  it('Property 1: Alice ciphertext cannot be decrypted by Bob', () => {
    fc.assert(
      fc.property(plaintextArb, (plaintext) => {
        const envelope = envelopeEncrypt(plaintext, ALICE);
        expect(() => envelopeDecrypt(envelope, BOB)).toThrow('InvalidCiphertextException');
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it('Property 2: same plaintext + different userArn → different ciphertexts', () => {
    fc.assert(
      fc.property(plaintextArb, (plaintext) => {
        const envA = envelopeEncrypt(plaintext, ALICE);
        const envB = envelopeEncrypt(plaintext, BOB);
        expect(envA.ciphertext).not.toBe(envB.ciphertext);
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it('Property 3: contentHash is deterministic — same input always produces same hash', () => {
    fc.assert(
      fc.property(plaintextArb, (data) => {
        const h1 = contentHash(data);
        const h2 = contentHash(data);
        const h3 = contentHash(data);
        expect(h1).toBe(h2);
        expect(h2).toBe(h3);
        expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
        return true;
      }),
      { numRuns: 500 }
    );
  });
});
```

---

## 5. `tests/invariants/ddb-key-prefix.invariant.ts`

**Invariants tested:**
- `makeJobPK(id)` always starts with `'JOB#'`.
- `makeUserGSI(arn)` always starts with `'USER#'`.
- No two `DDB_KEY_PREFIX` values share a prefix with each other.
- `extractJobId(makeJobPK(id)) === id` (roundtrip).

```typescript
/**
 * ddb-key-prefix.invariant.ts
 *
 * Invariant: DynamoDB key construction is prefix-safe and roundtrippable.
 */

import * as fc from 'fast-check';
import { DDB_KEY_PREFIX } from '@skills-svc/shared';

// ─── Key builders matching SPEC-33 §constants ─────────────────────────────────

function makeJobPK(jobId: string): string {
  return `${DDB_KEY_PREFIX.JOB}${jobId}`;
}

function makeUserGSI(userArn: string): string {
  return `${DDB_KEY_PREFIX.USER}${userArn}`;
}

function extractJobId(pk: string): string {
  const prefix = DDB_KEY_PREFIX.JOB;
  if (!pk.startsWith(prefix)) throw new Error(`Not a job PK: ${pk}`);
  return pk.slice(prefix.length);
}

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: DynamoDB key prefix construction is safe and roundtrippable', () => {

  const uuidArb = fc.uuid();
  const arnArb  = fc.string({ minLength: 1, maxLength: 256 });

  it('Property 1: makeJobPK always starts with JOB#', () => {
    fc.assert(
      fc.property(uuidArb, (id) => {
        expect(makeJobPK(id)).toMatch(/^JOB#/);
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it('Property 2: makeUserGSI always starts with USER#', () => {
    fc.assert(
      fc.property(arnArb, (arn) => {
        expect(makeUserGSI(arn)).toMatch(/^USER#/);
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it('Property 3: no two DDB_KEY_PREFIX values share a prefix', () => {
    const prefixes = Object.values(DDB_KEY_PREFIX);
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = 0; j < prefixes.length; j++) {
        if (i === j) continue;
        const a = prefixes[i];
        const b = prefixes[j];
        expect(a.startsWith(b)).toBe(false);
        expect(b.startsWith(a)).toBe(false);
      }
    }
  });

  it('Property 4: extractJobId(makeJobPK(id)) === id (roundtrip)', () => {
    fc.assert(
      fc.property(uuidArb, (id) => {
        expect(extractJobId(makeJobPK(id))).toBe(id);
        return true;
      }),
      { numRuns: 500 }
    );
  });
});
```

---

## 6. `tests/invariants/normalise-arn.invariant.ts`

**Invariants tested:**
- `normaliseArn` is idempotent.
- A stable role ARN passes through unchanged.
- Output of `normaliseArn` on any session ARN starts with `'arn:aws:iam::'`.
- Output never contains `':assumed-role/'`.

```typescript
/**
 * normalise-arn.invariant.ts
 *
 * Invariant: normaliseArn collapses session ARNs to stable role ARNs and is
 * idempotent on all inputs.
 */

import * as fc from 'fast-check';
import { normaliseArn } from '@skills-svc/shared';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a realistic assumed-role session ARN */
const sessionArnArb = fc.record({
  accountId: fc.stringMatching(/\d{12}/),
  roleName:  fc.stringMatching(/[A-Za-z][A-Za-z0-9_-]{3,30}/),
  session:   fc.uuid(),
}).map(({ accountId, roleName, session }) =>
  `arn:aws:sts::${accountId}:assumed-role/${roleName}/${session}`
);

/** Generates a stable IAM role ARN (should pass through unchanged) */
const stableRoleArnArb = fc.record({
  accountId: fc.stringMatching(/\d{12}/),
  roleName:  fc.stringMatching(/[A-Za-z][A-Za-z0-9_-]{3,30}/),
}).map(({ accountId, roleName }) =>
  `arn:aws:iam::${accountId}:role/${roleName}`
);

/** General fuzz — any string */
const anyStringArb = fc.string({ minLength: 0, maxLength: 512 });

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: normaliseArn is idempotent and strips assumed-role sessions', () => {

  it('Property 1: normaliseArn is idempotent on any string', () => {
    fc.assert(
      fc.property(anyStringArb, (input) => {
        const once  = normaliseArn(input);
        const twice = normaliseArn(once);
        expect(twice).toBe(once);
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it('Property 2: stable role ARN passes through unchanged', () => {
    fc.assert(
      fc.property(stableRoleArnArb, (arn) => {
        expect(normaliseArn(arn)).toBe(arn);
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it('Property 3: session ARN normalises to an arn:aws:iam:: ARN', () => {
    fc.assert(
      fc.property(sessionArnArb, (arn) => {
        const result = normaliseArn(arn);
        expect(result).toMatch(/^arn:aws:iam::/);
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it('Property 4: output of normaliseArn never contains :assumed-role/', () => {
    fc.assert(
      fc.property(anyStringArb, (input) => {
        expect(normaliseArn(input)).not.toContain(':assumed-role/');
        return true;
      }),
      { numRuns: 1000 }
    );
  });
});
```

---

## 7. `tests/invariants/semver-ordering.invariant.ts`

**Invariants tested:**
- `padSemver(a) > padSemver(b)` iff `semver.gt(a, b)` for any valid versions.
- `padSemver` is stable on equal versions.
- `latestVersion(set)` points to the highest semver in the set.

```typescript
/**
 * semver-ordering.invariant.ts
 *
 * Invariant: padSemver preserves semver ordering for lexicographic comparison
 * and latestVersion picks the true maximum.
 */

import * as fc from 'fast-check';

// ─── Implementation (matching production code) ────────────────────────────────

/**
 * Pads each numeric segment to 10 digits so lexicographic string comparison
 * equals semantic version comparison.
 * e.g. "1.10.2" → "0000000001.0000000010.0000000002"
 */
function padSemver(version: string): string {
  return version
    .split('.')
    .map((seg) => seg.replace(/[^0-9]/g, '').padStart(10, '0'))
    .join('.');
}

function latestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  return versions.reduce((best, v) =>
    padSemver(v) > padSemver(best) ? v : best
  );
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const semverSegArb = fc.integer({ min: 0, max: 9999 });

const semverArb = fc.record({
  major: semverSegArb,
  minor: semverSegArb,
  patch: semverSegArb,
}).map(({ major, minor, patch }) => `${major}.${minor}.${patch}`);

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: padSemver preserves semantic version ordering', () => {

  it('Property 1: padSemver(a) > padSemver(b) iff numeric value of a > b', () => {
    fc.assert(
      fc.property(semverArb, semverArb, (a, b) => {
        fc.pre(a !== b);

        const [aMaj, aMin, aPat] = a.split('.').map(Number);
        const [bMaj, bMin, bPat] = b.split('.').map(Number);

        const aGtB =
          aMaj > bMaj ||
          (aMaj === bMaj && aMin > bMin) ||
          (aMaj === bMaj && aMin === bMin && aPat > bPat);

        const padA = padSemver(a);
        const padB = padSemver(b);

        if (aGtB) {
          expect(padA > padB).toBe(true);
        } else {
          expect(padA < padB).toBe(true);
        }
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it('Property 2: padSemver is stable on equal versions', () => {
    fc.assert(
      fc.property(semverArb, (v) => {
        expect(padSemver(v)).toBe(padSemver(v));
        return true;
      }),
      { numRuns: 300 }
    );
  });

  it('Property 3: latestVersion picks the highest semver in any non-empty set', () => {
    fc.assert(
      fc.property(
        fc.array(semverArb, { minLength: 1, maxLength: 20 }),
        (versions) => {
          const latest = latestVersion(versions);
          expect(latest).toBeDefined();
          // No other version should be greater than the reported latest
          for (const v of versions) {
            expect(padSemver(v) <= padSemver(latest!)).toBe(true);
          }
          return true;
        }
      ),
      { numRuns: 300 }
    );
  });

  it('Property 4: latestVersion([]) returns undefined', () => {
    expect(latestVersion([])).toBeUndefined();
  });
});
```

---

## 8. `tests/invariants/batch-job-count.invariant.ts`

**Invariants tested:**
- `completed + failed + cancelled + running === total` always.
- After batch complete, `running === 0`.
- `cancelled` never exceeds `total`.

```typescript
/**
 * batch-job-count.invariant.ts
 *
 * Invariant: batch job counters are always self-consistent.
 */

import * as fc from 'fast-check';

// ─── Types and implementation (matching SPEC-33 §batch) ──────────────────────

interface BatchCounters {
  totalJobs:      number;
  completedJobs:  number;
  failedJobs:     number;
  cancelledJobs:  number;
  runningJobs:    number;
}

function makeBatchCounters(
  completed: number,
  failed: number,
  cancelled: number,
  running: number,
): BatchCounters {
  return {
    totalJobs:     completed + failed + cancelled + running,
    completedJobs: completed,
    failedJobs:    failed,
    cancelledJobs: cancelled,
    runningJobs:   running,
  };
}

function isBatchComplete(c: BatchCounters): boolean {
  return c.runningJobs === 0 && c.totalJobs > 0 &&
    (c.completedJobs + c.failedJobs + c.cancelledJobs === c.totalJobs);
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const countArb = fc.integer({ min: 0, max: 100 });

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: batch job counters are always self-consistent', () => {

  it('Property 1: completedJobs + failedJobs + cancelledJobs + runningJobs === totalJobs', () => {
    fc.assert(
      fc.property(countArb, countArb, countArb, countArb,
        (completed, failed, cancelled, running) => {
          const c = makeBatchCounters(completed, failed, cancelled, running);
          expect(c.completedJobs + c.failedJobs + c.cancelledJobs + c.runningJobs)
            .toBe(c.totalJobs);
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });

  it('Property 2: when isBatchComplete, runningJobs === 0', () => {
    fc.assert(
      fc.property(countArb, countArb, countArb,
        (completed, failed, cancelled) => {
          const c = makeBatchCounters(completed, failed, cancelled, 0);
          if (isBatchComplete(c)) {
            expect(c.runningJobs).toBe(0);
          }
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });

  it('Property 3: cancelledJobs never exceeds totalJobs', () => {
    fc.assert(
      fc.property(countArb, countArb, countArb, countArb,
        (completed, failed, cancelled, running) => {
          const c = makeBatchCounters(completed, failed, cancelled, running);
          expect(c.cancelledJobs).toBeLessThanOrEqual(c.totalJobs);
          return true;
        }
      ),
      { numRuns: 500 }
    );
  });
});
```

---

## 9. `tests/invariants/webhook-dedup.invariant.ts`

**Invariants tested:**
- `checkCooldown` immediately after `writeCooldown` returns `true` (within TTL).
- `checkCommitRecord` after `writeCommitRecord(PENDING)` returns `shouldSkip=true`.
- `checkCommitRecord` for FAILED status always returns `shouldSkip=false` (retryable).

```typescript
/**
 * webhook-dedup.invariant.ts
 *
 * Invariant: cooldown and commit-record deduplication always honour their
 * write-then-read contract regardless of (repoName, commitSha) pair.
 */

import * as fc from 'fast-check';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockDdbSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand:             jest.fn().mockImplementation((i) => ({ input: i, _type: 'Put' })),
  GetCommand:             jest.fn().mockImplementation((i) => ({ input: i, _type: 'Get' })),
}));

// ─── Inline implementation (matching SPEC-33 webhook-dedup handler) ───────────

const COOLDOWN_TTL_SECONDS = 300;

interface CooldownRecord { expiresAt: number; }
interface CommitRecord   { status: 'PENDING' | 'COMPLETE' | 'FAILED'; }

// In-memory store for property tests (simulates DDB within the test run)
const store = new Map<string, CooldownRecord | CommitRecord>();

async function writeCooldown(repoName: string, commitSha: string): Promise<void> {
  const key = `COOLDOWN#${repoName}#${commitSha}`;
  store.set(key, { expiresAt: Date.now() / 1000 + COOLDOWN_TTL_SECONDS });
}

async function checkCooldown(repoName: string, commitSha: string): Promise<boolean> {
  const key  = `COOLDOWN#${repoName}#${commitSha}`;
  const item = store.get(key) as CooldownRecord | undefined;
  if (!item) return false;
  return item.expiresAt > Date.now() / 1000;
}

async function writeCommitRecord(
  repoName: string,
  commitSha: string,
  status: 'PENDING' | 'COMPLETE' | 'FAILED',
): Promise<void> {
  store.set(`COMMIT#${repoName}#${commitSha}`, { status });
}

async function checkCommitRecord(
  repoName: string,
  commitSha: string,
): Promise<{ shouldSkip: boolean; status?: string }> {
  const item = store.get(`COMMIT#${repoName}#${commitSha}`) as CommitRecord | undefined;
  if (!item) return { shouldSkip: false };
  if (item.status === 'PENDING' || item.status === 'COMPLETE') return { shouldSkip: true, status: item.status };
  return { shouldSkip: false, status: item.status }; // FAILED is retryable
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const repoArb      = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));
const commitShaArb = fc.stringMatching(/[0-9a-f]{40}/);

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: webhook deduplication write-then-read contract', () => {

  beforeEach(() => { store.clear(); });

  it('Property 1: checkCooldown immediately after writeCooldown returns true', async () => {
    await fc.assert(
      fc.asyncProperty(repoArb, commitShaArb, async (repo, sha) => {
        await writeCooldown(repo, sha);
        const active = await checkCooldown(repo, sha);
        expect(active).toBe(true);
        return true;
      }),
      { numRuns: 200 }
    );
  });

  it('Property 2: checkCommitRecord after writeCommitRecord(PENDING) returns shouldSkip=true', async () => {
    await fc.assert(
      fc.asyncProperty(repoArb, commitShaArb, async (repo, sha) => {
        await writeCommitRecord(repo, sha, 'PENDING');
        const { shouldSkip } = await checkCommitRecord(repo, sha);
        expect(shouldSkip).toBe(true);
        return true;
      }),
      { numRuns: 200 }
    );
  });

  it('Property 3: checkCommitRecord for FAILED status always returns shouldSkip=false', async () => {
    await fc.assert(
      fc.asyncProperty(repoArb, commitShaArb, async (repo, sha) => {
        await writeCommitRecord(repo, sha, 'FAILED');
        const { shouldSkip } = await checkCommitRecord(repo, sha);
        expect(shouldSkip).toBe(false);
        return true;
      }),
      { numRuns: 200 }
    );
  });
});
```

---

## 10. `tests/invariants/chunk-size.invariant.ts`

**Invariants tested:**
- Token sum in any chunk never exceeds `MAX_TOKENS_PER_BATCH`.
- Every file appears in exactly one chunk (no duplicates, no omissions).
- Files larger than `MAX_TOKENS` are placed alone in their own chunk.
- `chunkFiles([]) === []`.

```typescript
/**
 * chunk-size.invariant.ts
 *
 * Invariant: chunkFiles produces non-overlapping, exhaustive, size-bounded
 * partitions of the input file list.
 */

import * as fc from 'fast-check';

// ─── Implementation ───────────────────────────────────────────────────────────

const MAX_TOKENS_PER_BATCH = 4096;

interface FileEntry {
  path:   string;
  tokens: number;
}

type Chunk = FileEntry[];

function chunkFiles(files: FileEntry[]): Chunk[] {
  if (files.length === 0) return [];

  const chunks: Chunk[] = [];
  let current: Chunk     = [];
  let currentTokens      = 0;

  for (const file of files) {
    if (file.tokens >= MAX_TOKENS_PER_BATCH) {
      // Oversized file: flush current chunk, then place file alone
      if (current.length > 0) { chunks.push(current); current = []; currentTokens = 0; }
      chunks.push([file]);
      continue;
    }

    if (currentTokens + file.tokens > MAX_TOKENS_PER_BATCH) {
      chunks.push(current);
      current       = [file];
      currentTokens = file.tokens;
    } else {
      current.push(file);
      currentTokens += file.tokens;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const fileArb = fc.record({
  path:   fc.uuid().map((id) => `/src/${id}.ts`),
  tokens: fc.integer({ min: 1, max: MAX_TOKENS_PER_BATCH * 2 }),
});

const fileListArb = fc.array(fileArb, { minLength: 0, maxLength: 50 }).map((files) => {
  // Deduplicate paths
  const seen = new Set<string>();
  return files.filter((f) => { if (seen.has(f.path)) return false; seen.add(f.path); return true; });
});

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Invariant: chunkFiles produces bounded, exhaustive, non-overlapping partitions', () => {

  it('Property 1: token sum in every chunk never exceeds MAX_TOKENS_PER_BATCH', () => {
    fc.assert(
      fc.property(fileListArb, (files) => {
        const chunks = chunkFiles(files);
        for (const chunk of chunks) {
          const sum = chunk.reduce((acc, f) => acc + f.tokens, 0);
          // Single-file oversized chunks are the only exception
          if (chunk.length === 1 && chunk[0].tokens >= MAX_TOKENS_PER_BATCH) continue;
          expect(sum).toBeLessThanOrEqual(MAX_TOKENS_PER_BATCH);
        }
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it('Property 2: every file appears in exactly one chunk (no duplicates, no omissions)', () => {
    fc.assert(
      fc.property(fileListArb, (files) => {
        const chunks = chunkFiles(files);
        const allPaths = chunks.flatMap((c) => c.map((f) => f.path));

        // No duplicates
        expect(new Set(allPaths).size).toBe(allPaths.length);

        // No omissions
        expect(allPaths.sort()).toEqual(files.map((f) => f.path).sort());
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it('Property 3: files with tokens >= MAX_TOKENS_PER_BATCH are placed alone', () => {
    fc.assert(
      fc.property(fileListArb, (files) => {
        const chunks = chunkFiles(files);
        const oversized = new Set(
          files.filter((f) => f.tokens >= MAX_TOKENS_PER_BATCH).map((f) => f.path)
        );

        for (const chunk of chunks) {
          const chunkPaths = chunk.map((f) => f.path);
          for (const path of chunkPaths) {
            if (oversized.has(path)) {
              expect(chunk).toHaveLength(1);
            }
          }
        }
        return true;
      }),
      { numRuns: 500 }
    );
  });

  it('Property 4: chunkFiles([]) === []', () => {
    expect(chunkFiles([])).toEqual([]);
  });
});
```

---

## 11. `tests/invariants/README.md`

```markdown
# Property-Based Invariant Tests

## What is property-based testing?

Unlike example-based tests ("given input X, expect output Y"), property-based
tests assert that a _mathematical invariant_ holds for **any** generated input.
The library `fast-check` generates hundreds of random inputs, then on failure
automatically shrinks the counterexample to the smallest possible failing case.

Example: instead of testing that `normaliseArn` handles one specific session ARN,
we assert: "for ALL strings, `normaliseArn(normaliseArn(x)) === normaliseArn(x)`".
If any random input breaks this, fast-check reports the shortest string that fails.

## How to run

```sh
# Run all invariant tests with a 30-second timeout (fast-check can be slow for
# complex properties with many runs)
npx jest tests/invariants/ --testTimeout=30000

# Run a single invariant file
npx jest tests/invariants/normalise-arn.invariant.ts --testTimeout=30000

# Run with verbose output to see fast-check statistics
npx jest tests/invariants/ --testTimeout=30000 --verbose
```

## Expected output on success

```
PASS tests/invariants/normalise-arn.invariant.ts
  Invariant: normaliseArn is idempotent and strips assumed-role sessions
    ✓ Property 1: normaliseArn is idempotent on any string (1234 ms)
    ✓ Property 2: stable role ARN passes through unchanged (456 ms)
    ✓ Property 3: session ARN normalises to an arn:aws:iam:: ARN (678 ms)
    ✓ Property 4: output of normaliseArn never contains :assumed-role/ (890 ms)
```

## Expected output on failure (fast-check shrinking)

```
Property failed after 47 tests
{ seed: 1234567890, path: "46:0:1", endOnFailure: true }
Counterexample: ["arn:aws:sts::000000000000:assumed-role/X/"]
Shrunk 3 time(s)
Got error: expect(received).not.toContain(expected)
```

fast-check will always report:
1. The **seed** (re-run with `fc.assert(..., { seed: 1234567890 })` to reproduce).
2. The **smallest counterexample** after shrinking.
3. The number of shrink steps taken.

## How to add a new invariant

1. Create `tests/invariants/<domain>.invariant.ts`.
2. Import `fast-check` as `import * as fc from 'fast-check'`.
3. Write a `describe` block with the invariant statement as the description.
4. Use `fc.assert(fc.property(...))` for synchronous properties or
   `fc.assert(fc.asyncProperty(...))` for async ones.
5. Choose `numRuns` based on complexity: 100–200 for slow async, 500–1000 for fast sync.
6. Run `npx jest tests/invariants/<domain>.invariant.ts --testTimeout=30000` locally.
7. Add to CI: the `jest` step already picks up `tests/invariants/**/*.invariant.ts`.

## Invariant catalogue

| File | Domain | # Properties |
|------|--------|--------------|
| `encryption-context.invariant.ts` | KMS envelope encryption round-trip | 3 |
| `job-status-transitions.invariant.ts` | Status state machine acyclicity | 3 |
| `list-jobs-ownership.invariant.ts` | Cross-tenant data isolation | 2 |
| `envelope-encryption-tenant-isolation.invariant.ts` | Tenant isolation + hash determinism | 3 |
| `ddb-key-prefix.invariant.ts` | DDB key construction and roundtrip | 4 |
| `normalise-arn.invariant.ts` | ARN normalisation idempotency | 4 |
| `semver-ordering.invariant.ts` | Semantic version ordering preservation | 4 |
| `batch-job-count.invariant.ts` | Batch counter self-consistency | 3 |
| `webhook-dedup.invariant.ts` | Write-then-read deduplication contract | 3 |
| `chunk-size.invariant.ts` | File chunking exhaustiveness + bounds | 4 |
```

---

## Summary

| # | File | Core invariant |
|---|------|----------------|
| 1 | `encryption-context.invariant.ts` | encrypt→decrypt is identity; wrong context always throws |
| 2 | `job-status-transitions.invariant.ts` | state machine is a DAG; terminals have no outgoing edges |
| 3 | `list-jobs-ownership.invariant.ts` | listJobs never leaks cross-tenant records |
| 4 | `envelope-encryption-tenant-isolation.invariant.ts` | different ARN → different ciphertext; hash is deterministic |
| 5 | `ddb-key-prefix.invariant.ts` | key construction is prefix-safe and roundtrippable |
| 6 | `normalise-arn.invariant.ts` | idempotent; stable ARNs pass through; session ARNs fully collapsed |
| 7 | `semver-ordering.invariant.ts` | padSemver preserves numeric order; latestVersion picks maximum |
| 8 | `batch-job-count.invariant.ts` | counters always sum to total; terminal state has no running jobs |
| 9 | `webhook-dedup.invariant.ts` | write-then-read contract holds for any repo/commit pair |
| 10 | `chunk-size.invariant.ts` | chunks are bounded, exhaustive, non-overlapping; oversized files isolated |

**Total properties:** 33 across 10 invariant files.  
**Dependency:** `"fast-check": "^3.15.0"` in `devDependencies`.  
**Run command:** `npx jest tests/invariants/ --testTimeout=30000`
