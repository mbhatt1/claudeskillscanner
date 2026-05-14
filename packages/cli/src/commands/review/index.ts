/**
 * index.ts — registers all `skills-svc review` subcommands with Commander.
 *
 * Subcommands:
 *   review submit <source>          — submit a single tarball or git URL for review
 *   review batch                    — submit multiple packages from a manifest
 *   review status <packageName>     — show job status (GAP 20 fix: now fully implemented)
 *   review findings <packageName>   — query per-finding results
 *   review report <packageName>     — generate SARIF / JSON / Markdown report
 *   review diff <packageName>       — compare findings between two versions
 */

import { Command } from 'commander';
import { reviewSubmit } from './submit';
import { reviewBatch } from './batch';
import { reviewStatus } from './status';
import { reviewFindings } from './findings';
import { reviewReport } from './report';
import { reviewDiff } from './diff';

export function registerReviewCommands(program: Command): void {
  const review = program
    .command('review')
    .description('Security code review commands — submit packages, query findings, and generate reports');

  // ── review submit ───────────────────────────────────────────────────────────
  review
    .command('submit <source>')
    .description(
      'Submit a single package for security code review.\n' +
      '<source> can be a local tarball/zip path or a git URL: git+https://github.com/owner/repo@<sha>',
    )
    .requiredOption('--package-name <name>',    'Package name used as the identifier in the findings table')
    .requiredOption('--package-version <ver>',  'Package version (semver or arbitrary string)')
    .option('--language <lang>',                'Primary language hint passed to the review skill (python, javascript, go, java, …)')
    .option('--skill-version <ver>',            'code-review skill version to use (default: latest)', 'latest')
    .action(async (source: string, opts: {
      packageName: string;
      packageVersion: string;
      language?: string;
      skillVersion: string;
    }) => {
      await reviewSubmit(source, opts);
    });

  // ── review batch ────────────────────────────────────────────────────────────
  review
    .command('batch')
    .description('Submit multiple packages for review from a JSON manifest file')
    .requiredOption('--manifest <file>', 'Path to JSON manifest: [{name, version, source, language?}]')
    .option('--concurrency <n>',        'Maximum concurrent uploads (1–50)', '10')
    .option('--dry-run',                'Validate the manifest and sources without submitting any jobs')
    .action(async (opts: { manifest: string; concurrency: string; dryRun?: boolean }) => {
      await reviewBatch(opts);
    });

  // ── review status ───────────────────────────────────────────────────────────
  review
    .command('status <packageName>')
    .description(
      'Show the latest review job status for a package.\n' +
      'Displays status, timestamps, duration, and finding counts by severity.\n' +
      'Use --watch to poll until the job reaches a terminal state.',
    )
    .option('--version <ver>',  'Specific package version to check (default: latest reviewed). Also accepts "latest".')
    .option('--watch',          'Poll every 10 s and re-render until the job completes or fails')
    .option('--format <fmt>',   'Output format: text|json  (json is machine-readable, useful for CI)', 'text')
    .action(async (packageName: string, opts: {
      version?: string;
      watch?: boolean;
      format?: string;
    }) => {
      await reviewStatus(packageName, opts);
    });

  // ── review findings ─────────────────────────────────────────────────────────
  review
    .command('findings <packageName>')
    .description('Query security findings for a package version')
    .option('--version <ver>',    'Package version to query (default: latest reviewed). Also accepts "latest".')
    .option('--severity <level>', 'Filter by severity: critical|high|medium|low|info')
    .option('--cwe <id>',         'Filter by CWE ID, e.g. CWE-79')
    .option('--output <format>',  'Output format: table|json', 'table')
    .action(async (packageName: string, opts: {
      version?: string;
      severity?: string;
      cwe?: string;
      output: string;
    }) => {
      await reviewFindings(packageName, opts);
    });

  // ── review report ────────────────────────────────────────────────────────────
  review
    .command('report <packageName>')
    .description('Generate a full security report in SARIF 2.1.0, JSON, or Markdown format')
    .requiredOption('--format <fmt>',     'Output format: sarif|json|markdown')
    .option('--version <ver>',            'Package version (default: latest reviewed). Also accepts "latest".')
    .option('--output-file <path>',       'Write the report to a file instead of stdout')
    .action(async (packageName: string, opts: {
      format: string;
      version?: string;
      outputFile?: string;
    }) => {
      await reviewReport(packageName, opts);
    });

  // ── review diff ──────────────────────────────────────────────────────────────
  review
    .command('diff <packageName>')
    .description('Compare security findings between two package versions — shows new, fixed, and unchanged findings')
    .requiredOption('--from <version>', 'Base version to compare from')
    .requiredOption('--to <version>',   'Target version to compare against')
    .option('--output <format>',        'Output format: table|json', 'table')
    .action(async (packageName: string, opts: {
      from: string;
      to: string;
      output: string;
    }) => {
      await reviewDiff(packageName, opts);
    });
}
