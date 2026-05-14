/**
 * status.ts — `skills-svc review status <packageName>`
 *
 * GAP 20 fix: complete implementation of the review status command.
 *
 * Flow:
 *   1. Resolve packageName → (version, jobId) via the LATEST_REVIEWED_VERSION
 *      pointer (or use --version <ver> to fetch a specific version's pointer).
 *   2. GetItem on the main jobs table: PK=JOB#{jobId}, SK=METADATA to get
 *      job-level status, timestamps, and ECS task ARN.
 *   3. Query the findings table GSI3 (JOB#<jobId>) for a finding count breakdown
 *      by severity — this is the aggregate that `review status` displays.
 *   4. Render a human-readable status block (or --format json for CI).
 *   5. With --watch: re-render every 10 s until the job reaches a terminal state.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { loadConfig } from '../../utils/config';
import { makeDDBClient, makeSSMClient } from '../../utils/aws-clients';
import { FindingRecord, FindingSeverity } from '@skills-svc/shared';
import { resolveLatestVersion } from './findings';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface StatusOptions {
  version?: string;
  watch?: boolean;
  format?: string;
}

interface JobMetadata {
  jobId: string;
  status: string;
  packageName?: string;
  packageVersion?: string;
  jobName?: string;
  createdAt?: string;
  updatedAt?: string;
  taskArn?: string;
  errorMessage?: string;
  riskLevel?: string;
  findingCount?: number;
}

interface FindingSeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
}

interface StatusReport {
  jobId: string;
  packageName: string;
  version: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  durationSeconds?: number;
  findings: FindingSeverityCounts;
  totalFindings: number;
  riskLevel?: string;
  taskArn?: string;
  errorMessage?: string;
  resultsLink?: string;
}

// ── Terminal states ────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);

// ── reviewStatus ───────────────────────────────────────────────────────────────

export async function reviewStatus(packageName: string, opts: StatusOptions): Promise<void> {
  const config = await loadConfig();
  const ddb    = DynamoDBDocumentClient.from(makeDDBClient(config));
  const ssm    = makeSSMClient(config);
  const env    = config.env ?? 'prod';

  // Fetch both table names from SSM
  const [findingsTable, jobsTable] = await Promise.all([
    getParam(ssm, `/skills-svc/${env}/dynamodb/findings-table-name`),
    getParam(ssm, `/skills-svc/${env}/dynamodb/jobs-table-name`),
  ]);

  // ── Resolve version → jobId ───────────────────────────────────────────────
  const requestedVersion = opts.version;
  let resolvedVersion: string;
  let jobId: string;

  if (!requestedVersion || requestedVersion === 'latest') {
    const ptr = await resolveLatestVersion(ddb, findingsTable, packageName);
    resolvedVersion = ptr.version;
    jobId = ptr.jobId;
  } else {
    // For a specific version, look up its pointer record.
    // The pointer record stores the jobId for that version's most recent review.
    resolvedVersion = requestedVersion;
    const res = await ddb.send(new GetCommand({
      TableName: findingsTable,
      Key: {
        PK: `PKG#${packageName}#${requestedVersion}`,
        SK: 'LATEST_REVIEWED_VERSION',
      },
      ProjectionExpression: 'jobId',
    }));
    const item = res.Item;
    if (!item?.jobId) {
      // Fall back to the package-level latest pointer and hope version matches.
      // This handles older records written before per-version pointers existed.
      const ptr = await resolveLatestVersion(ddb, findingsTable, packageName);
      if (ptr.version !== requestedVersion) {
        throw new Error(
          `No review job found for ${packageName}@${requestedVersion}. ` +
          `Latest reviewed version is ${ptr.version}. ` +
          `Use --version ${ptr.version} or omit --version to see the latest.`,
        );
      }
      jobId = ptr.jobId;
    } else {
      jobId = item.jobId as string;
    }
  }

  // ── Poll loop (--watch) or single-shot ────────────────────────────────────
  const isWatch  = opts.watch === true;
  const isJson   = opts.format === 'json';
  let   lastStatus = '';

  const poll = async (): Promise<StatusReport> => {
    const [job, severityCounts] = await Promise.all([
      fetchJobMetadata(ddb, jobsTable, jobId),
      fetchFindingSeverityCounts(ddb, findingsTable, jobId),
    ]);

    const totalFindings = Object.values(severityCounts).reduce((a, b) => a + b, 0);

    let durationSeconds: number | undefined;
    if (job.createdAt && job.updatedAt) {
      const created = new Date(job.createdAt).getTime();
      const updated = new Date(job.updatedAt).getTime();
      if (!isNaN(created) && !isNaN(updated) && updated >= created) {
        durationSeconds = Math.round((updated - created) / 1000);
      }
    }

    const resultsLink = buildResultsLink(config, packageName, resolvedVersion, jobId);

    return {
      jobId,
      packageName,
      version: resolvedVersion,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      durationSeconds,
      findings: severityCounts,
      totalFindings,
      riskLevel: job.riskLevel,
      taskArn: job.taskArn,
      errorMessage: job.errorMessage,
      resultsLink,
    };
  };

  if (!isWatch) {
    // Single-shot output
    const report = await poll();
    printReport(report, isJson);
    // Exit code 1 if job failed — useful for CI
    if (report.status === 'FAILED') process.exit(1);
    return;
  }

  // ── Watch mode: poll every 10 s, re-render on change ─────────────────────
  if (!isJson) {
    console.log(chalk.cyan(`Watching ${packageName}@${resolvedVersion} (job ${jobId}) — Ctrl+C to stop\n`));
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const report = await poll();
    const currentStatus = report.status;

    if (currentStatus !== lastStatus || lastStatus === '') {
      if (!isJson) {
        // Clear previous lines when status changes (simple approach: just print new block)
        printReport(report, false);
      } else {
        console.log(JSON.stringify(report));
      }
      lastStatus = currentStatus;
    }

    if (TERMINAL_STATUSES.has(currentStatus)) {
      if (!isJson) {
        console.log(
          currentStatus === 'COMPLETE'
            ? chalk.green('\nReview complete.')
            : chalk.red(`\nReview ended with status: ${currentStatus}`),
        );
      }
      if (report.status === 'FAILED') process.exit(1);
      return;
    }

    // Wait 10 s before next poll
    await sleep(10_000);
  }
}

// ── Fetch job metadata from the main jobs table ────────────────────────────────

async function fetchJobMetadata(
  ddb: DynamoDBDocumentClient,
  jobsTable: string,
  jobId: string,
): Promise<JobMetadata> {
  const res = await ddb.send(new GetCommand({
    TableName: jobsTable,
    Key: {
      PK: `JOB#${jobId}`,
      SK: 'METADATA',
    },
  }));

  if (!res.Item) {
    // Job record may not exist yet (just submitted) — return QUEUED stub
    return {
      jobId,
      status: 'QUEUED',
    };
  }

  const item = res.Item;
  return {
    jobId,
    status:         (item['status']         as string | undefined) ?? 'UNKNOWN',
    packageName:     item['packageName']     as string | undefined,
    packageVersion:  item['packageVersion']  as string | undefined,
    jobName:         item['jobName']         as string | undefined,
    createdAt:       item['createdAt']       as string | undefined,
    updatedAt:       item['updatedAt']       as string | undefined,
    taskArn:         item['taskArn']         as string | undefined,
    errorMessage:    item['errorMessage']    as string | undefined,
    riskLevel:       item['riskLevel']       as string | undefined,
    findingCount:    item['findingCount']    as number | undefined,
  };
}

// ── Aggregate finding counts by severity via GSI3 ──────────────────────────────

async function fetchFindingSeverityCounts(
  ddb: DynamoDBDocumentClient,
  findingsTable: string,
  jobId: string,
): Promise<FindingSeverityCounts> {
  const counts: FindingSeverityCounts = {
    critical: 0,
    high:     0,
    medium:   0,
    low:      0,
    info:     0,
  };

  // GSI3: PK=JOB#{jobId}, SK begins_with FINDING#
  // We only need the severity field — use ProjectionExpression for efficiency.
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new QueryCommand({
      TableName: findingsTable,
      IndexName: 'GSI3-Job',
      KeyConditionExpression: 'GSI3PK = :pk AND begins_with(GSI3SK, :skPrefix)',
      ProjectionExpression: 'severity',
      ExpressionAttributeValues: {
        ':pk':       `JOB#${jobId}`,
        ':skPrefix': 'FINDING#',
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    }));

    for (const item of res.Items ?? []) {
      const sev = (item['severity'] as FindingSeverity | undefined) ?? 'info';
      if (sev in counts) {
        counts[sev]++;
      }
    }

    lastEvaluatedKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return counts;
}

// ── Render helpers ─────────────────────────────────────────────────────────────

function printReport(report: StatusReport, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const statusColor = statusChalk(report.status);

  console.log('');
  console.log(`${chalk.bold('Package:')}   ${report.packageName}@${report.version}`);
  console.log(`${chalk.bold('Job ID:')}    ${report.jobId}`);
  console.log(`${chalk.bold('Status:')}    ${statusColor(report.status)}`);

  if (report.createdAt) {
    console.log(`${chalk.bold('Created:')}   ${report.createdAt}`);
  }
  if (report.updatedAt) {
    console.log(`${chalk.bold('Updated:')}   ${report.updatedAt}`);
  }
  if (report.durationSeconds !== undefined) {
    console.log(`${chalk.bold('Duration:')}  ${formatDuration(report.durationSeconds)}`);
  }
  if (report.riskLevel) {
    const riskColor = riskChalk(report.riskLevel);
    console.log(`${chalk.bold('Risk Level:')} ${riskColor(report.riskLevel.toUpperCase())}`);
  }

  if (report.totalFindings > 0 || report.status === 'COMPLETE') {
    console.log('');
    console.log(chalk.bold('Findings by severity:'));
    console.log(`  ${chalk.bgRed.white.bold('  CRITICAL  ')}  ${report.findings.critical}`);
    console.log(`  ${chalk.red.bold('HIGH     ')}  ${report.findings.high}`);
    console.log(`  ${chalk.yellow('MEDIUM   ')}  ${report.findings.medium}`);
    console.log(`  ${chalk.cyan('LOW      ')}  ${report.findings.low}`);
    console.log(`  ${chalk.gray('INFO     ')}  ${report.findings.info}`);
    console.log(`  ${chalk.bold('─────────────────')}`);
    console.log(`  ${chalk.bold('TOTAL    ')}  ${report.totalFindings}`);
  }

  if (report.errorMessage) {
    console.log('');
    console.log(`${chalk.bold('Error:')} ${chalk.red(report.errorMessage)}`);
  }

  if (report.resultsLink) {
    console.log('');
    console.log(`${chalk.bold('Results:')} ${chalk.underline(report.resultsLink)}`);
  }

  console.log('');
}

function statusChalk(status: string): chalk.Chalk {
  switch (status) {
    case 'COMPLETE':  return chalk.green.bold;
    case 'RUNNING':   return chalk.blue.bold;
    case 'QUEUED':    return chalk.cyan;
    case 'FAILED':    return chalk.red.bold;
    case 'CANCELLED': return chalk.gray;
    default:          return chalk.white;
  }
}

function riskChalk(riskLevel: string): chalk.Chalk {
  switch (riskLevel.toLowerCase()) {
    case 'critical': return chalk.bgRed.white.bold;
    case 'high':     return chalk.red.bold;
    case 'medium':   return chalk.yellow;
    case 'low':      return chalk.cyan;
    default:         return chalk.green;
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function buildResultsLink(
  config: { region?: string },
  packageName: string,
  version: string,
  jobId: string,
): string | undefined {
  // Emit a CLI deep-link so humans can jump straight to findings.
  // This is a convenience string — not a real URL unless the team has a UI.
  return `skills-svc review findings ${packageName} --version ${version}`;
}

// ── SSM helper ─────────────────────────────────────────────────────────────────

async function getParam(ssm: SSMClient, name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
  if (!res.Parameter?.Value) throw new Error(`SSM param not found: ${name}`);
  return res.Parameter.Value;
}

// ── Sleep helper ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
