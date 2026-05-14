// packages/ecs-runner/src/ignorer.ts
//
// Loads exclusion patterns from three sources (in order of precedence):
//   1. Hard-coded DEFAULT_EXCLUDES  — always applied
//   2. .skillsignore in the repo root  — gitignore-style patterns via minimatch
//   3. per-package excludePatterns from the batch manifest entry
//
// Usage:
//   const ignorer = await buildIgnorer(sourceDir, manifestExcludes);
//   const filtered = files.filter(f => !ignorer.isIgnored(f.relativePath));

import * as fs from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';

// ── Default exclusion list ─────────────────────────────────────────────────────

/**
 * Paths / globs that are ALWAYS excluded regardless of other configuration.
 * Patterns are tested against the relative path from the source root.
 */
export const DEFAULT_EXCLUDES: string[] = [
  // dependency trees
  'node_modules/**',
  'vendor/**',
  // build artefacts
  'dist/**',
  'build/**',
  'out/**',
  '.next/**',
  '.nuxt/**',
  // bytecode / generated caches
  '__pycache__/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/*.pyo',
  // minified / bundled JS
  '**/*.min.js',
  '**/*.min.css',
  '**/*.bundle.js',
  // generated protobuf Go files
  '**/*.pb.go',
  '**/*.pb.gw.go',
  // lock files (large, not code)
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Pipfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  '**/*.lock',
  // coverage reports
  'coverage/**',
  '.nyc_output/**',
  'htmlcov/**',
  // version control metadata (should have been stripped, but be safe)
  '.git/**',
  '.svn/**',
  // IDE / OS noise
  '.idea/**',
  '.vscode/**',
  '**/.DS_Store',
  '**/Thumbs.db',
];

// ── minimatch options ──────────────────────────────────────────────────────────

const MM_OPTS: minimatch.Options = {
  dot: true,        // match dotfiles / dot-directories
  matchBase: false, // patterns without / are NOT auto-anchored to basename
  nocase: false,
};

// ── Ignorer class ──────────────────────────────────────────────────────────────

export class Ignorer {
  private readonly patterns: string[];

  constructor(patterns: string[]) {
    // Normalise: remove blank lines and comments (# …)
    this.patterns = patterns
      .map(p => p.trim())
      .filter(p => p.length > 0 && !p.startsWith('#'));
  }

  /**
   * Returns `true` if `relativePath` should be excluded from analysis.
   * `relativePath` must use forward slashes and must NOT start with '/'.
   */
  isIgnored(relativePath: string): boolean {
    // Normalise path separators to forward-slash (Windows safety)
    const rp = relativePath.split(path.sep).join('/');

    for (const pattern of this.patterns) {
      // minimatch handles both glob patterns and plain directory names.
      // We test the full relative path AND each path segment prefix so that
      // a pattern like "node_modules" (no glob) still matches
      // "node_modules/lodash/index.js".
      if (minimatch(rp, pattern, MM_OPTS)) return true;

      // Also test whether any leading path component matches a plain-name pattern
      // (handles e.g. `vendor` matching `vendor/github.com/foo/bar.go`)
      if (!pattern.includes('/') && !pattern.includes('*')) {
        const segments = rp.split('/');
        if (segments.includes(pattern)) return true;
      }
    }

    return false;
  }
}

// ── Factory function ───────────────────────────────────────────────────────────

/**
 * Build an `Ignorer` from:
 *  - DEFAULT_EXCLUDES
 *  - `.skillsignore` file at `sourceDir/.skillsignore` (if present)
 *  - `manifestExcludes` passed from the batch manifest entry
 *
 * @param sourceDir        Absolute path to the extracted source root
 * @param manifestExcludes `excludePatterns` from `BatchManifestEntry` (optional)
 */
export async function buildIgnorer(
  sourceDir: string,
  manifestExcludes: string[] = [],
): Promise<Ignorer> {
  const patterns: string[] = [...DEFAULT_EXCLUDES];

  // Load .skillsignore
  const skillsignorePath = path.join(sourceDir, '.skillsignore');
  try {
    const raw = await fs.readFile(skillsignorePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    patterns.push(...lines);
    console.log(JSON.stringify({
      event: 'skillsignore_loaded',
      path: skillsignorePath,
      lineCount: lines.length,
    }));
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // Unexpected error — warn but continue with defaults
      console.warn(JSON.stringify({ event: 'skillsignore_read_error', err: String(err) }));
    }
    // ENOENT = file doesn't exist; silently continue
  }

  // Append per-package manifest excludes
  if (manifestExcludes.length > 0) {
    patterns.push(...manifestExcludes);
    console.log(JSON.stringify({
      event: 'manifest_excludes_applied',
      count: manifestExcludes.length,
    }));
  }

  return new Ignorer(patterns);
}
