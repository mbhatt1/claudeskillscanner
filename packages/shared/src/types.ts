// packages/shared/src/types.ts
// Shared types for the Skills as a Service system.
// Code Review types begin at the "Code Review Types" section below.

// ── Core / existing types (abbreviated stubs — see SPEC-01 through SPEC-10) ───

export enum JobStatus {
  QUEUED   = 'QUEUED',
  RUNNING  = 'RUNNING',
  COMPLETE = 'COMPLETE',
  FAILED   = 'FAILED',
}

export type InputMode = 'tarball' | 'git';

// ── Code Review Types ─────────────────────────────────────────────────────────

export type FindingSeverity  = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingConfidence = 'high' | 'medium' | 'low';
export type RiskLevel        = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type ReportFormat     = 'sarif' | 'json' | 'markdown';

export interface SecurityFinding {
  id: string;               // FINDING-NNN
  severity: FindingSeverity;
  cwe_id: string;           // e.g. "CWE-89"
  file: string;             // relative path within the repo
  line: number;
  description: string;
  recommendation: string;
  confidence: FindingConfidence;
}

export interface ReviewOutput {
  findings: SecurityFinding[];
  summary: string;
  risk_level: RiskLevel;
}

/** Stored in DynamoDB findings table */
export interface FindingRecord extends SecurityFinding {
  packageName: string;
  packageVersion: string;
  jobId: string;
  language?: string;
  sourceRef?: string;   // git commit SHA or tarball S3 key
  createdAt: string;
  ttl: number;
}

/**
 * One entry in the JSON manifest file passed to `skills-svc review batch`.
 *
 * GAP 2 addition: `excludePatterns` — per-package glob patterns that are added
 * on top of DEFAULT_EXCLUDES and any .skillsignore file found in the repo root.
 * Uses minimatch syntax (same as .gitignore, but processed by minimatch).
 *
 * Examples:
 *   ["tests/**", "docs/**", "**/*.generated.ts"]
 */
export interface BatchManifestEntry {
  name: string;
  version: string;
  /** Tarball path on disk/S3, OR "git+https://...@<sha>" */
  source: string;
  language?: string;
  /**
   * Additional glob patterns to exclude for THIS package only.
   * Appended to DEFAULT_EXCLUDES + .skillsignore patterns.
   * Uses minimatch syntax.
   */
  excludePatterns?: string[];
}

/** S3 object metadata keys for code review jobs */
export interface CodeReviewJobMetadata {
  'input-mode': InputMode;
  'package-name': string;
  'package-version': string;
  'source-ref'?: string;              // git SHA or tarball s3 key
  'github-repo'?: string;             // owner/repo
  'github-commit-sha'?: string;
  'github-installation-id'?: string;
  'gitlab-project-id'?: string;
  'gitlab-commit-sha'?: string;
}

export const FINDINGS_KEY_PREFIX = {
  PACKAGE: 'PKG#',
  FINDING: 'FINDING#',
} as const;
