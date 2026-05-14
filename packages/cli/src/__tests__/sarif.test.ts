/**
 * sarif.test.ts — Unit tests for packages/cli/src/utils/sarif.ts
 *
 * Tests cover SPEC-26 Gap 9 requirements:
 *   9a  partialFingerprints.primaryLocationLineHash on every result
 *   9b  automationDetails.id format
 *   9c  versionControlProvenance when sourceRef provided
 *   9d  rule.shortDescription / rule.fullDescription never empty
 *   9e  result.suppressions for suppressed findings
 *
 * The SARIF 2.1.0 schema reference:
 *   https://schemastore.azurewebsites.net/schemas/json/sarif-2.1.0-rtm.5.json
 */

import { createHash } from 'crypto';

// ── Type stubs ─────────────────────────────────────────────────────────────────
// Matches the planned FindingRecord shape described in SPEC-26 / shared/types.ts

type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type FindingStatus   = 'open' | 'accepted' | 'false-positive' | 'remediated' | 'suppressed';

interface FindingRecord {
  id:                string;
  severity:          FindingSeverity;
  cwe_id:            string;
  file:              string;
  line:              number;
  description:       string;
  recommendation:    string;
  confidence:        'high' | 'medium' | 'low';
  packageName:       string;
  packageVersion:    string;
  jobId:             string;
  language?:         string;
  sourceRef?:        string;
  createdAt:         string;
  ttl:               number;
  // GAP 7 additions
  status?:           FindingStatus;
  suppressedBy?:     string;
  suppressedAt?:     string;
  suppressionReason?: string;
  contentFingerprint?: string;
}

interface SarifOptions {
  jobId?:        string;
  sourceRef?:    string;   // git commit SHA
  repositoryUri?: string;
  branch?:       string;
}

// ── SARIF output shape (partial — enough for test assertions) ─────────────────

interface SarifLog {
  $schema: string;
  version: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: {
    driver: {
      name: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
  automationDetails?: { id: string };
  versionControlProvenance?: Array<{
    repositoryUri: string;
    revisionId:    string;
    branch?:       string;
  }>;
}

interface SarifRule {
  id:               string;
  name:             string;
  shortDescription: { text: string };
  fullDescription:  { text: string };
  properties?:      Record<string, unknown>;
}

interface SarifResult {
  ruleId:              string;
  level:               string;
  message:             { text: string };
  locations:           Array<{ physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }>;
  partialFingerprints: { primaryLocationLineHash: string };
  properties?:         Record<string, unknown>;
  suppressions?:       Array<{ kind: string; status?: string; justification?: string }>;
}

// ── Module under test ─────────────────────────────────────────────────────────
//
// sarif.ts does not exist yet; the import is mocked below so tests define the
// exact contract the implementation must satisfy.  When sarif.ts is written the
// mock should be replaced with:
//   import { findingsToSarif } from '../utils/sarif';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Reproduce the hash algorithm described in SPEC-26 Gap 9a. */
function expectedLineHash(file: string, line: number, cwe_id: string): string {
  return createHash('sha256')
    .update(`${file}:${line}:${cwe_id}`)
    .digest('hex')
    .slice(0, 16);
}

/** Severity → SARIF level mapping defined in SPEC-26 Gap 9. */
function expectedLevel(severity: FindingSeverity): string {
  switch (severity) {
    case 'critical': return 'error';
    case 'high':     return 'error';
    case 'medium':   return 'warning';
    case 'low':      return 'note';
    case 'info':     return 'none';
  }
}

/** Severity → security-severity score mapping. */
function expectedSecuritySeverity(severity: FindingSeverity): string {
  switch (severity) {
    case 'critical': return '9.5';
    case 'high':     return '8.0';
    case 'medium':   return '5.5';
    case 'low':      return '2.0';
    case 'info':     return '0.0';
  }
}

// ── Reference implementation (mock) ──────────────────────────────────────────
//
// This section provides a minimal correct implementation of findingsToSarif that
// satisfies every test case.  It mirrors exactly what sarif.ts must implement.
// Once the real file exists, delete this block and uncomment the import above.

const CWE_NAMES: Record<string, string> = {
  'CWE-89':  'SqlInjection',
  'CWE-79':  'CrossSiteScripting',
  'CWE-22':  'PathTraversal',
  'CWE-78':  'OsCommandInjection',
  'CWE-94':  'CodeInjection',
  'CWE-611': 'XmlExternalEntityInjection',
  'CWE-502': 'DeserializationOfUntrustedData',
  'CWE-327': 'UseOfBrokenOrRiskyAlgorithm',
  'CWE-798': 'UseOfHardcodedCredentials',
  'CWE-918': 'ServerSideRequestForgery',
};

function cweToRuleName(cweId: string): string {
  const suffix = CWE_NAMES[cweId];
  if (suffix) return `${cweId.replace('-', '')}${suffix}`;
  // fallback: CWE89 + normalised id
  return cweId.replace('-', '').replace(/[^A-Za-z0-9]/g, '');
}

function severityToLevel(sev: FindingSeverity): string {
  return expectedLevel(sev);
}

function severityToSecScore(sev: FindingSeverity): string {
  return expectedSecuritySeverity(sev);
}

function findingsToSarif(
  findings: FindingRecord[],
  packageName: string,
  packageVersion: string,
  opts: SarifOptions = {},
): SarifLog {
  const jobId = opts.jobId ?? 'unknown-job';

  // Build unique rules from distinct CWE IDs found in findings
  const ruleMap = new Map<string, SarifRule>();
  for (const f of findings) {
    if (!ruleMap.has(f.cwe_id)) {
      const ruleName = cweToRuleName(f.cwe_id);
      // Use description if we have no static name (should never be empty)
      const shortText = ruleName || f.description.slice(0, 60) || f.cwe_id;
      const fullText  = f.description || shortText;
      ruleMap.set(f.cwe_id, {
        id:               f.cwe_id,
        name:             ruleName,
        shortDescription: { text: shortText },
        fullDescription:  { text: fullText },
        properties: {
          'security-severity': severityToSecScore(f.severity),
          tags: ['security', f.cwe_id],
        },
      });
    }
  }

  const results: SarifResult[] = findings.map((f) => {
    const hash = createHash('sha256')
      .update(`${f.file}:${f.line}:${f.cwe_id}`)
      .digest('hex')
      .slice(0, 16);

    const result: SarifResult = {
      ruleId:  f.cwe_id,
      level:   severityToLevel(f.severity),
      message: { text: f.description },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region:           { startLine: f.line },
        },
      }],
      partialFingerprints: { primaryLocationLineHash: hash },
      properties: {
        severity:           f.severity,
        confidence:         f.confidence,
        'security-severity': severityToSecScore(f.severity),
      },
    };

    if (f.status === 'suppressed') {
      result.suppressions = [{
        kind:          'external',
        status:        'accepted',
        justification: f.suppressionReason ?? 'Suppressed by suppression rule',
      }];
    }

    return result;
  });

  const run: SarifRun = {
    tool: {
      driver: {
        name:  'skills-svc/security-review',
        rules: Array.from(ruleMap.values()),
      },
    },
    results,
    automationDetails: {
      id: `skills-svc/${packageName}/${packageVersion}/${jobId}`,
    },
  };

  if (opts.sourceRef && opts.repositoryUri) {
    run.versionControlProvenance = [{
      repositoryUri: opts.repositoryUri,
      revisionId:    opts.sourceRef,
      ...(opts.branch ? { branch: opts.branch } : {}),
    }];
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [run],
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    id:             'FINDING-001',
    severity:       'high',
    cwe_id:         'CWE-89',
    file:           'src/db/query.ts',
    line:           42,
    description:    'SQL injection via unsanitized user input.',
    recommendation: 'Use parameterised queries.',
    confidence:     'high',
    packageName:    'test-pkg',
    packageVersion: '1.0.0',
    jobId:          'job-abc-123',
    createdAt:      '2026-05-13T00:00:00.000Z',
    ttl:            9999999999,
    status:         'open',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('findingsToSarif', () => {

  // ── Schema / top-level structure ────────────────────────────────────────────

  describe('SARIF 2.1.0 envelope', () => {
    it('returns valid SARIF 2.1.0 with correct $schema and version fields', () => {
      const findings = [makeFinding()];
      const sarif = findingsToSarif(findings, 'my-pkg', '2.0.0', { jobId: 'j1' });

      expect(sarif.$schema).toMatch(/sarif-schema-2\.1\.0/);
      expect(sarif.version).toBe('2.1.0');
      expect(Array.isArray(sarif.runs)).toBe(true);
      expect(sarif.runs).toHaveLength(1);
    });

    it('zero findings → returns valid SARIF with empty results array', () => {
      const sarif = findingsToSarif([], 'empty-pkg', '0.1.0', { jobId: 'j-empty' });

      expect(sarif.version).toBe('2.1.0');
      expect(sarif.runs[0].results).toEqual([]);
      expect(sarif.runs[0].tool.driver.rules).toEqual([]);
    });
  });

  // ── partialFingerprints ──────────────────────────────────────────────────────

  describe('partialFingerprints.primaryLocationLineHash', () => {
    it('every result has primaryLocationLineHash that is 16 hex characters', () => {
      const findings = [
        makeFinding({ id: 'F-1', file: 'a.ts', line: 10, cwe_id: 'CWE-89' }),
        makeFinding({ id: 'F-2', file: 'b.ts', line: 20, cwe_id: 'CWE-79' }),
        makeFinding({ id: 'F-3', file: 'c.ts', line: 30, cwe_id: 'CWE-22' }),
      ];
      const sarif = findingsToSarif(findings, 'pkg', '1.0.0');

      for (const result of sarif.runs[0].results) {
        const hash = result.partialFingerprints.primaryLocationLineHash;
        expect(hash).toMatch(/^[0-9a-f]{16}$/);
      }
    });

    it('two findings with same file+line+cwe_id get the same primaryLocationLineHash', () => {
      const finding1 = makeFinding({ id: 'F-1', file: 'src/auth.ts', line: 55, cwe_id: 'CWE-89' });
      const finding2 = makeFinding({ id: 'F-2', file: 'src/auth.ts', line: 55, cwe_id: 'CWE-89',
        description: 'Slightly different description but same location+cwe' });

      const sarif = findingsToSarif([finding1, finding2], 'pkg', '1.0.0');
      const [r1, r2] = sarif.runs[0].results;

      expect(r1.partialFingerprints.primaryLocationLineHash)
        .toBe(r2.partialFingerprints.primaryLocationLineHash);
    });

    it('different file+line+cwe_id produce different primaryLocationLineHash values', () => {
      const f1 = makeFinding({ id: 'F-1', file: 'src/a.ts', line: 10,  cwe_id: 'CWE-89' });
      const f2 = makeFinding({ id: 'F-2', file: 'src/b.ts', line: 10,  cwe_id: 'CWE-89' });
      const f3 = makeFinding({ id: 'F-3', file: 'src/a.ts', line: 99,  cwe_id: 'CWE-89' });
      const f4 = makeFinding({ id: 'F-4', file: 'src/a.ts', line: 10,  cwe_id: 'CWE-79' });

      const sarif = findingsToSarif([f1, f2, f3, f4], 'pkg', '1.0.0');
      const hashes = sarif.runs[0].results.map(r => r.partialFingerprints.primaryLocationLineHash);

      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(4);
    });

    it('hash matches sha256(file:line:cwe_id).slice(0,16)', () => {
      const file   = 'lib/utils/crypto.ts';
      const line   = 77;
      const cwe_id = 'CWE-327';

      const finding = makeFinding({ file, line, cwe_id });
      const sarif   = findingsToSarif([finding], 'pkg', '1.0.0');
      const actual  = sarif.runs[0].results[0].partialFingerprints.primaryLocationLineHash;

      expect(actual).toBe(expectedLineHash(file, line, cwe_id));
    });
  });

  // ── automationDetails ────────────────────────────────────────────────────────

  describe('run.automationDetails.id', () => {
    it('equals "skills-svc/{packageName}/{version}/{jobId}"', () => {
      const sarif = findingsToSarif(
        [makeFinding()], 'my-awesome-lib', '3.2.1', { jobId: 'job-xyz-789' },
      );
      expect(sarif.runs[0].automationDetails?.id)
        .toBe('skills-svc/my-awesome-lib/3.2.1/job-xyz-789');
    });

    it('handles package name with scope (e.g. @org/lib)', () => {
      const sarif = findingsToSarif(
        [makeFinding()], '@myorg/mylib', '1.0.0-rc.1', { jobId: 'job-1' },
      );
      expect(sarif.runs[0].automationDetails?.id)
        .toBe('skills-svc/@myorg/mylib/1.0.0-rc.1/job-1');
    });
  });

  // ── versionControlProvenance ─────────────────────────────────────────────────

  describe('run.versionControlProvenance', () => {
    it('is populated with repositoryUri and revisionId when sourceRef is provided', () => {
      const sarif = findingsToSarif(
        [makeFinding()],
        'my-pkg',
        '1.0.0',
        {
          jobId:         'job-1',
          sourceRef:     'abc123def456',
          repositoryUri: 'https://github.com/myorg/myrepo',
          branch:        'main',
        },
      );

      const vcp = sarif.runs[0].versionControlProvenance;
      expect(vcp).toBeDefined();
      expect(vcp).toHaveLength(1);
      expect(vcp![0].repositoryUri).toBe('https://github.com/myorg/myrepo');
      expect(vcp![0].revisionId).toBe('abc123def456');
    });

    it('includes branch when provided alongside sourceRef', () => {
      const sarif = findingsToSarif(
        [makeFinding()],
        'my-pkg', '1.0.0',
        { jobId: 'j1', sourceRef: 'sha999', repositoryUri: 'https://github.com/o/r', branch: 'feature/x' },
      );
      expect(sarif.runs[0].versionControlProvenance![0].branch).toBe('feature/x');
    });

    it('is not included when sourceRef is absent', () => {
      const sarif = findingsToSarif([makeFinding()], 'my-pkg', '1.0.0', { jobId: 'j1' });
      expect(sarif.runs[0].versionControlProvenance).toBeUndefined();
    });

    it('is not included when repositoryUri is absent (sourceRef alone insufficient)', () => {
      const sarif = findingsToSarif(
        [makeFinding()], 'my-pkg', '1.0.0',
        { jobId: 'j1', sourceRef: 'sha-only-no-uri' },
      );
      // repositoryUri is required for a meaningful VCP entry
      expect(sarif.runs[0].versionControlProvenance).toBeUndefined();
    });
  });

  // ── Rule descriptions ────────────────────────────────────────────────────────

  describe('rule.shortDescription and rule.fullDescription', () => {
    it('are never empty strings', () => {
      const findings = [
        makeFinding({ cwe_id: 'CWE-89', description: 'SQL injection.' }),
        makeFinding({ id: 'F-2', cwe_id: 'CWE-9999', description: 'Unknown CWE.' }),
      ];
      const sarif = findingsToSarif(findings, 'pkg', '1.0.0');
      const rules = sarif.runs[0].tool.driver.rules;

      for (const rule of rules) {
        expect(rule.shortDescription.text).toBeTruthy();
        expect(rule.fullDescription.text).toBeTruthy();
        expect(rule.shortDescription.text.length).toBeGreaterThan(0);
        expect(rule.fullDescription.text.length).toBeGreaterThan(0);
      }
    });

    it('CWE-89 maps to a rule name containing "SqlInjection"', () => {
      const sarif = findingsToSarif([makeFinding({ cwe_id: 'CWE-89' })], 'pkg', '1.0.0');
      const rule  = sarif.runs[0].tool.driver.rules.find(r => r.id === 'CWE-89');

      expect(rule).toBeDefined();
      expect(rule!.name).toMatch(/SqlInjection/i);
    });

    it('deduplicated rules — same CWE appears only once even with multiple findings', () => {
      const findings = [
        makeFinding({ id: 'F-1', cwe_id: 'CWE-89', line: 10 }),
        makeFinding({ id: 'F-2', cwe_id: 'CWE-89', line: 20 }),
        makeFinding({ id: 'F-3', cwe_id: 'CWE-79', line: 30 }),
      ];
      const sarif = findingsToSarif(findings, 'pkg', '1.0.0');
      const rules = sarif.runs[0].tool.driver.rules;

      const ruleIds = rules.map(r => r.id);
      expect(ruleIds.filter(id => id === 'CWE-89')).toHaveLength(1);
      expect(rules).toHaveLength(2);
    });
  });

  // ── Severity → SARIF level mapping ──────────────────────────────────────────

  describe('severity to SARIF level mapping', () => {
    it('severity "critical" → SARIF level "error" and security-severity "9.5"', () => {
      const sarif   = findingsToSarif([makeFinding({ severity: 'critical' })], 'pkg', '1.0.0');
      const result  = sarif.runs[0].results[0];

      expect(result.level).toBe('error');
      expect((result.properties as any)?.['security-severity']).toBe('9.5');
    });

    it('severity "high" → SARIF level "error" and security-severity "8.0"', () => {
      const sarif  = findingsToSarif([makeFinding({ severity: 'high' })], 'pkg', '1.0.0');
      const result = sarif.runs[0].results[0];

      expect(result.level).toBe('error');
      expect((result.properties as any)?.['security-severity']).toBe('8.0');
    });

    it('severity "medium" → SARIF level "warning"', () => {
      const sarif  = findingsToSarif([makeFinding({ severity: 'medium' })], 'pkg', '1.0.0');
      expect(sarif.runs[0].results[0].level).toBe('warning');
    });

    it('severity "low" → SARIF level "note"', () => {
      const sarif  = findingsToSarif([makeFinding({ severity: 'low' })], 'pkg', '1.0.0');
      expect(sarif.runs[0].results[0].level).toBe('note');
    });

    it('severity "info" → SARIF level "none" and security-severity "0.0"', () => {
      const sarif  = findingsToSarif([makeFinding({ severity: 'info' })], 'pkg', '1.0.0');
      const result = sarif.runs[0].results[0];

      expect(result.level).toBe('none');
      expect((result.properties as any)?.['security-severity']).toBe('0.0');
    });
  });

  // ── Suppressions ─────────────────────────────────────────────────────────────

  describe('result.suppressions', () => {
    it('suppressed finding (status="suppressed") → suppressions array with kind="external"', () => {
      const finding = makeFinding({
        status:            'suppressed',
        suppressedBy:      'alice@example.com',
        suppressionReason: 'Accepted business risk',
      });
      const sarif  = findingsToSarif([finding], 'pkg', '1.0.0');
      const result = sarif.runs[0].results[0];

      expect(Array.isArray(result.suppressions)).toBe(true);
      expect(result.suppressions).toHaveLength(1);
      expect(result.suppressions![0].kind).toBe('external');
    });

    it('suppressed finding has status "accepted" in the suppression entry', () => {
      const finding = makeFinding({ status: 'suppressed', suppressionReason: 'Low-risk environment' });
      const sarif   = findingsToSarif([finding], 'pkg', '1.0.0');
      const sup     = sarif.runs[0].results[0].suppressions![0];

      expect(sup.status).toBe('accepted');
    });

    it('suppressed finding includes justification from suppressionReason', () => {
      const reason  = 'False positive — vendor code, not in scope';
      const finding = makeFinding({ status: 'suppressed', suppressionReason: reason });
      const sarif   = findingsToSarif([finding], 'pkg', '1.0.0');
      const sup     = sarif.runs[0].results[0].suppressions![0];

      expect(sup.justification).toBe(reason);
    });

    it('non-suppressed finding (status="open") → suppressions is absent', () => {
      const finding = makeFinding({ status: 'open' });
      const sarif   = findingsToSarif([finding], 'pkg', '1.0.0');
      const result  = sarif.runs[0].results[0];

      expect(result.suppressions).toBeUndefined();
    });

    it('finding with no status field → suppressions is absent', () => {
      const { status: _unused, ...finding } = makeFinding();
      const sarif  = findingsToSarif([finding as FindingRecord], 'pkg', '1.0.0');
      const result = sarif.runs[0].results[0];

      expect(result.suppressions).toBeUndefined();
    });

    it('mixed findings — only suppressed ones have suppressions', () => {
      const findings = [
        makeFinding({ id: 'F-1', status: 'open' }),
        makeFinding({ id: 'F-2', status: 'suppressed', line: 20 }),
        makeFinding({ id: 'F-3', status: 'open', line: 30 }),
      ];
      const sarif   = findingsToSarif(findings, 'pkg', '1.0.0');
      const results = sarif.runs[0].results;

      expect(results[0].suppressions).toBeUndefined();
      expect(results[1].suppressions).toHaveLength(1);
      expect(results[2].suppressions).toBeUndefined();
    });
  });

  // ── Result location fields ───────────────────────────────────────────────────

  describe('result location', () => {
    it('sets artifactLocation.uri to the finding file path', () => {
      const file   = 'src/services/auth/login.ts';
      const sarif  = findingsToSarif([makeFinding({ file })], 'pkg', '1.0.0');
      const result = sarif.runs[0].results[0];

      expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe(file);
    });

    it('sets region.startLine to the finding line number', () => {
      const line   = 123;
      const sarif  = findingsToSarif([makeFinding({ line })], 'pkg', '1.0.0');
      const result = sarif.runs[0].results[0];

      expect(result.locations[0].physicalLocation.region.startLine).toBe(line);
    });
  });
});
