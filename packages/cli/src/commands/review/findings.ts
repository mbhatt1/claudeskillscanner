/**
 * findings.ts — `skills-svc review findings <packageName>`
 *
 * GAP 13 fix: resolveLatestVersion is now a simple GetItem on the dedicated
 *   PK=PKG#<name>, SK=LATEST_REVIEWED_VERSION pointer record written by
 *   findings-writer.ts after every successful review job.
 *
 *   The old implementation used begins_with(PK, ...) as a KeyConditionExpression,
 *   which DynamoDB rejects at runtime because begins_with is only valid on the
 *   sort key, never on the partition key.
 *
 * --version latest is accepted as an explicit alias that calls resolveLatestVersion.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../utils/config';
import { makeDDBClient, makeSSMClient } from '../../utils/aws-clients';
import { FindingRecord, FindingSeverity } from '@skills-svc/shared';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FindingsOptions {
  version?: string;
  severity?: string;
  cwe?: string;
  output: string;
}

// ── Severity display helpers ───────────────────────────────────────────────────

const SEVERITY_COLORS: Record<FindingSeverity, chalk.Chalk> = {
  critical: chalk.bgRed.white.bold,
  high:     chalk.red.bold,
  medium:   chalk.yellow,
  low:      chalk.cyan,
  info:     chalk.gray,
};

function severityWeight(s: FindingSeverity): number {
  return ({ critical: 5, high: 4, medium: 3, low: 2, info: 1 } as Record<string, number>)[s] ?? 0;
}

// ── resolveLatestVersion ───────────────────────────────────────────────────────

/**
 * Returns the latest reviewed version for `packageName` by fetching the
 * dedicated pointer record written by findings-writer.ts:
 *
 *   PK = PKG#<packageName>
 *   SK = LATEST_REVIEWED_VERSION
 *
 * Throws a descriptive error when no review has ever been stored for this package.
 * Also returns the associated jobId so callers can use it for status lookups.
 */
export async function resolveLatestVersion(
  ddb: DynamoDBDocumentClient,
  findingsTable: string,
  packageName: string,
): Promise<{ version: string; jobId: string; reviewedAt: string }> {
  const res = await ddb.send(new GetCommand({
    TableName: findingsTable,
    Key: {
      PK: `PKG#${packageName}`,
      SK: 'LATEST_REVIEWED_VERSION',
    },
    // Only project what we need — avoids transferring large summary blobs.
    ProjectionExpression: 'versionRaw, jobId, reviewedAt',
  }));

  const item = res.Item;
  if (!item) {
    throw new Error(
      `No review results found for package "${packageName}". ` +
      `Run \`skills-svc review submit\` first, or specify \`--version <ver>\`.`,
    );
  }

  const version    = item['versionRaw'] as string | undefined;
  const jobId      = item['jobId']      as string | undefined;
  const reviewedAt = item['reviewedAt'] as string | undefined;

  if (!version || !jobId || !reviewedAt) {
    throw new Error(
      `Corrupt LATEST_REVIEWED_VERSION pointer for package "${packageName}" — ` +
      `missing versionRaw, jobId, or reviewedAt. Please re-run the review.`,
    );
  }

  return { version, jobId, reviewedAt };
}

// ── reviewFindings ─────────────────────────────────────────────────────────────

export async function reviewFindings(packageName: string, opts: FindingsOptions): Promise<void> {
  const config = await loadConfig();
  const ddbRaw = makeDDBClient(config);
  const ddb    = DynamoDBDocumentClient.from(ddbRaw);
  const ssm    = makeSSMClient(config);

  const env = config.env ?? 'prod';
  const findingsTable = await getParam(ssm, `/skills-svc/${env}/dynamodb/findings-table-name`);

  // Resolve the version to query.
  // --version latest is an explicit alias that calls resolveLatestVersion.
  const requestedVersion = opts.version;
  let resolvedVersion: string;

  if (!requestedVersion || requestedVersion === 'latest') {
    const ptr = await resolveLatestVersion(ddb, findingsTable, packageName);
    resolvedVersion = ptr.version;
  } else {
    resolvedVersion = requestedVersion;
  }

  // ── Query findings ──────────────────────────────────────────────────────────

  let findings: FindingRecord[];

  if (opts.cwe) {
    // Query by CWE ID across all versions of this package (GSI2).
    // GSI2PK = CWE#{cweId}, then filter by packageName in memory.
    // We filter in memory because a FilterExpression on a GSI cannot use PK conditions
    // from the base table.
    const res = await ddb.send(new QueryCommand({
      TableName: findingsTable,
      IndexName: 'GSI2-CWE',
      KeyConditionExpression: 'GSI2PK = :pk',
      FilterExpression: 'packageName = :pkg',
      ExpressionAttributeValues: {
        ':pk':  `CWE#${opts.cwe}`,
        ':pkg': packageName,
      },
    }));
    findings = (res.Items ?? []) as FindingRecord[];

  } else if (opts.severity) {
    // Query by package+version+severity (GSI1).
    const res = await ddb.send(new QueryCommand({
      TableName: findingsTable,
      IndexName: 'GSI1-Severity',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `PKG#${packageName}#${resolvedVersion}#SEV#${opts.severity}`,
      },
    }));
    findings = (res.Items ?? []) as FindingRecord[];

  } else {
    // Query all findings for this package+version using the base table PK.
    // SK begins_with 'FINDING#' correctly uses begins_with on the *sort key*,
    // which is valid DynamoDB KeyConditionExpression syntax.
    const res = await ddb.send(new QueryCommand({
      TableName: findingsTable,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk':       `PKG#${packageName}#${resolvedVersion}`,
        ':skPrefix': 'FINDING#',
      },
    }));
    findings = (res.Items ?? []) as FindingRecord[];
  }

  // ── Output ──────────────────────────────────────────────────────────────────

  if (opts.output === 'json') {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const displayVersion = requestedVersion === 'latest' || !requestedVersion
    ? `${resolvedVersion} (latest)`
    : resolvedVersion;

  if (findings.length === 0) {
    console.log(chalk.green(`\nNo findings for ${packageName}@${displayVersion}`));
    return;
  }

  const table = new Table({
    head: ['ID', 'Severity', 'CWE', 'File', 'Line', 'Description'].map(h => chalk.bold(h)),
    colWidths: [14, 10, 10, 30, 6, 60],
    wordWrap: true,
  });

  const sorted = [...findings].sort(
    (a, b) => severityWeight(b.severity) - severityWeight(a.severity),
  );

  for (const f of sorted) {
    const severityLabel = SEVERITY_COLORS[f.severity]?.(f.severity.toUpperCase()) ?? f.severity.toUpperCase();
    table.push([
      f.id,
      severityLabel,
      f.cwe_id,
      f.file,
      String(f.line),
      f.description.slice(0, 120),
    ]);
  }

  console.log(`\nFindings for ${chalk.bold(packageName)}@${displayVersion} (${findings.length} total):\n`);
  console.log(table.toString());
}

// ── Internal helper ─────────────────────────────────────────────────────────────

async function getParam(ssm: SSMClient, name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
  if (!res.Parameter?.Value) throw new Error(`SSM param not found: ${name}`);
  return res.Parameter.Value;
}
