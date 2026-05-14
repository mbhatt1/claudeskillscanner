/**
 * tests/factories/review-output.ts
 *
 * Factory functions for ReviewOutput — the structured JSON produced by the
 * code-review ECS skill and consumed by ResultsProcessorLambda.
 */

import { ReviewOutput, SecurityFinding, RiskLevel } from '../../packages/shared/src/types';

// ---------------------------------------------------------------------------
// Base factory
// ---------------------------------------------------------------------------

export function makeReviewOutput(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  const findings: SecurityFinding[] = overrides.findings ?? [
    {
      id: 'FINDING-001',
      severity: 'high',
      cwe_id: 'CWE-89',
      file: 'src/index.ts',
      line: 42,
      description:
        "User-supplied parameter `username` is concatenated directly into a SQL query string without parameterization, enabling SQL injection.",
      recommendation:
        "Use parameterized queries. Replace `\\`SELECT * FROM users WHERE username = '${username}'\\`` with `pool.query('SELECT * FROM users WHERE username = $1', [username])`.",
      confidence: 'high',
    },
  ];

  const risk_level: RiskLevel = overrides.risk_level ?? deriveRiskLevel(findings);

  const base: ReviewOutput = {
    findings,
    summary:
      'The codebase contains 1 high-severity vulnerability. SQL injection in the authentication module requires immediate remediation.',
    risk_level,
  };

  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Convenience factories
// ---------------------------------------------------------------------------

/** A review with no findings — clean bill of health */
export function makeEmptyReviewOutput(): ReviewOutput {
  return {
    findings: [],
    summary: 'No security vulnerabilities were identified in the reviewed source code.',
    risk_level: 'none',
  };
}

/** A review containing exactly one critical finding */
export function makeCriticalReviewOutput(): ReviewOutput {
  const criticalFinding: SecurityFinding = {
    id: 'FINDING-001',
    severity: 'critical',
    cwe_id: 'CWE-78',
    file: 'src/exec.ts',
    line: 15,
    description:
      'User-controlled input is passed directly to a shell command via exec() without sanitization, enabling remote code execution (RCE).',
    recommendation:
      'Use execFile() with an explicit argument array instead of exec(). Never interpolate user input into shell command strings. Consider using a library-level abstraction that avoids shell invocation entirely.',
    confidence: 'high',
  };

  return {
    findings: [criticalFinding],
    summary:
      'A critical remote code execution vulnerability was identified. The finding requires immediate remediation before deployment.',
    risk_level: 'critical',
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Array<SecurityFinding['severity']> = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/**
 * Derives the overall risk_level from the highest-severity finding.
 * Returns 'none' when there are no findings.
 */
function deriveRiskLevel(findings: SecurityFinding[]): RiskLevel {
  if (!findings.length) return 'none';

  for (const severity of SEVERITY_ORDER) {
    if (findings.some(f => f.severity === severity)) {
      // 'info' does not map to a named RiskLevel above 'none'
      if (severity === 'info') return 'none';
      return severity as RiskLevel;
    }
  }

  return 'none';
}
