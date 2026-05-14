/**
 * tests/factories/finding-record.ts
 *
 * Factory functions for DynamoDB FindingRecord and related types.
 */

import { randomUUID } from 'crypto';
import {
  FindingRecord,
  FindingSeverity,
  SecurityFinding,
} from '../../packages/shared/src/types';

// ---------------------------------------------------------------------------
// Counter for generating unique, sequential finding IDs within a test run
// ---------------------------------------------------------------------------

let findingCounter = 0;
function nextFindingId(): string {
  findingCounter += 1;
  return `FINDING-${String(findingCounter).padStart(3, '0')}`;
}

/** Reset the counter between test suites if needed */
export function resetFindingCounter(): void {
  findingCounter = 0;
}

// ---------------------------------------------------------------------------
// Base factory
// ---------------------------------------------------------------------------

export function makeFindingRecord(overrides: Partial<FindingRecord> = {}): FindingRecord {
  const id = overrides.id ?? nextFindingId();
  const createdAt = overrides.createdAt ?? new Date('2026-01-15T10:05:00.000Z').toISOString();
  const ttlSeconds = Math.floor(new Date(createdAt).getTime() / 1000) + 90 * 24 * 60 * 60;

  const base: FindingRecord = {
    // SecurityFinding fields
    id,
    severity: 'medium',
    cwe_id: 'CWE-89',
    file: 'src/index.ts',
    line: 42,
    description: 'User-supplied input is concatenated directly into a SQL query without parameterization.',
    recommendation: 'Use parameterized queries or a query builder. Replace string interpolation with `pool.query(sql, [param])` syntax.',
    confidence: 'high',

    // FindingRecord extension fields
    packageName: 'test-package',
    packageVersion: '1.0.0',
    jobId: randomUUID(),
    language: 'typescript',
    sourceRef: undefined,
    createdAt,
    ttl: ttlSeconds,
  };

  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Severity-specific factories
// ---------------------------------------------------------------------------

export function makeCriticalFinding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return makeFindingRecord({
    severity: 'critical',
    cwe_id: 'CWE-78',
    file: 'src/exec.ts',
    line: 15,
    description: 'User-controlled input is passed directly to a shell command via exec(), enabling remote code execution.',
    recommendation: 'Never pass user input to shell commands. Use execFile() with an explicit argument array, or a library that does not invoke a shell.',
    confidence: 'high',
    ...overrides,
  });
}

export function makeHighFinding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return makeFindingRecord({
    severity: 'high',
    cwe_id: 'CWE-79',
    file: 'src/render.ts',
    line: 88,
    description: 'User-supplied data is rendered into HTML without escaping, enabling reflected cross-site scripting (XSS).',
    recommendation: 'Escape all user-supplied data before inserting into HTML. Use a templating engine with auto-escaping (e.g., Handlebars, Nunjucks) or DOMPurify on the client.',
    confidence: 'high',
    ...overrides,
  });
}

export function makeSuppressedFinding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  // A "suppressed" finding is represented as an info-level finding with a
  // sourceRef indicating the suppression annotation. The system does not have
  // a first-class "suppressed" status, so tests use the info severity to
  // represent acknowledged/suppressed findings.
  return makeFindingRecord({
    severity: 'info',
    cwe_id: 'CWE-326',
    file: 'src/legacy-crypto.ts',
    line: 12,
    description: 'MD5 is used for checksumming. This is not a cryptographic security context — MD5 is used solely for cache key generation.',
    recommendation: 'No action required — this use of MD5 is for non-security-sensitive checksumming. If this code ever handles password hashing or authentication tokens, migrate to bcrypt or Argon2.',
    confidence: 'low',
    sourceRef: 'suppressed:acknowledged-by-security-team-2026-01-01',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Batch factory
// ---------------------------------------------------------------------------

export function makeFindingBatch(
  count: number,
  severity: FindingSeverity = 'medium',
  baseOverrides: Partial<FindingRecord> = {},
): FindingRecord[] {
  return Array.from({ length: count }, (_, i) =>
    makeFindingRecord({
      file: `src/module-${i + 1}.ts`,
      line: (i + 1) * 10,
      ...baseOverrides,
      severity,
    }),
  );
}
