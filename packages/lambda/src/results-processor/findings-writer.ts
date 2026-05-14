/**
 * findings-writer.ts — writes per-finding records + latestVersion pointer to the
 * findings DynamoDB table, and a PKG_REGISTRY summary record for the dashboard.
 *
 * GAP 13 fix: after writing all finding rows, maintain a dedicated
 * LATEST_REVIEWED_VERSION pointer record so that CLI commands that omit
 * --version can do a simple GetItem instead of an invalid begins_with(PK,…)
 * query on the partition key.
 *
 * GAP 8 fix: also writes a PKG_REGISTRY / PKG#{name} summary record so the
 * dashboard can list every reviewed package without a table scan.
 *
 * Pointer record schema:
 *   PK  = PKG#<packageName>
 *   SK  = LATEST_REVIEWED_VERSION
 *   version    = <semver>          (padded via padSemver for string comparison)
 *   versionRaw = <original semver>
 *   jobId      = <uuid>
 *   reviewedAt = <ISO-8601>
 *
 * Registry record schema:
 *   PK  = PKG_REGISTRY
 *   SK  = PKG#<packageName>
 *   packageName, latestVersion, latestJobId, lastReviewedAt
 *
 * The conditional UpdateItem uses optimistic locking:
 *   attribute_not_exists(version) OR version <= :newPadded
 * so concurrent Lambda invocations for the same package always advance
 * the pointer forward (newest wins) and never regress it.
 */

import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { FindingRecord, ReviewOutput, SecurityFinding } from '@skills-svc/shared';

// ── padSemver ──────────────────────────────────────────────────────────────────
// Zero-pads each numeric segment to 10 digits so lexicographic string comparison
// is equivalent to semantic version ordering.  Identical to the helper used in
// SPEC-10 skill-registry.
//
// Examples:
//   "1.2.3"    → "0000000001.0000000002.0000000003"
//   "10.0.0"   → "0000000010.0000000000.0000000000"
//   "1.2.3-rc" → "0000000001.0000000002.0000000003-rc"  (pre-release suffix kept)
export function padSemver(v: string): string {
  // Split off any pre-release / build-metadata suffix after the numeric core
  const [core, ...rest] = v.split('-');
  const suffix = rest.length > 0 ? `-${rest.join('-')}` : '';
  const parts = (core ?? v).split('.');
  // Ensure at least three segments (major.minor.patch)
  while (parts.length < 3) parts.push('0');
  const padded = parts.map(p => {
    const n = parseInt(p, 10);
    return isNaN(n) ? p.padStart(10, '0') : String(n).padStart(10, '0');
  }).join('.');
  return `${padded}${suffix}`;
}

// ── WriteOptions ───────────────────────────────────────────────────────────────

export interface WriteOptions {
  ddbClient: DynamoDBDocumentClient;
  findingsTable: string;
  packageName: string;
  packageVersion: string;
  jobId: string;
  language?: string;
  sourceRef?: string;
  /** Summary text from the ReviewOutput, stored on the pointer record. */
  summary?: string;
  /** Risk level from the ReviewOutput, stored on the pointer record. */
  riskLevel?: string;
}

// ── writeFindingsToTable ───────────────────────────────────────────────────────

/**
 * 1. BatchWrite all per-finding rows (primary key + three GSIs).
 * 2. Conditionally advance the LATEST_REVIEWED_VERSION pointer.
 * 3. Upsert the PKG_REGISTRY summary record.
 */
export async function writeFindingsToTable(
  reviewOutput: ReviewOutput,
  opts: WriteOptions,
): Promise<void> {
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year TTL

  // ── Step 1: write per-finding rows ─────────────────────────────────────────
  if (reviewOutput.findings.length > 0) {
    const records: FindingRecord[] = reviewOutput.findings.map((f: SecurityFinding) => ({
      ...f,
      packageName: opts.packageName,
      packageVersion: opts.packageVersion,
      jobId: opts.jobId,
      language: opts.language,
      sourceRef: opts.sourceRef,
      createdAt: now,
      ttl,
    }));

    const BATCH_SIZE = 25; // DynamoDB BatchWrite limit
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);

      const requestItems = batch.map((r) => ({
        PutRequest: {
          Item: {
            // Primary table key
            PK: `PKG#${r.packageName}#${r.packageVersion}`,
            SK: `FINDING#${r.id}`,
            // GSI1: query findings by package+version+severity
            GSI1PK: `PKG#${r.packageName}#${r.packageVersion}#SEV#${r.severity}`,
            GSI1SK: `CREATED_AT#${r.createdAt}`,
            // GSI2: query findings by CWE ID across all packages
            GSI2PK: `CWE#${r.cwe_id}`,
            GSI2SK: `CREATED_AT#${r.createdAt}`,
            // GSI3: query all findings that belong to a specific job
            GSI3PK: `JOB#${r.jobId}`,
            GSI3SK: `FINDING#${r.id}`,
            // All record fields (spread last so PK/SK/GSI keys win on collision)
            ...r,
          },
        },
      }));

      await opts.ddbClient.send(new BatchWriteCommand({
        RequestItems: { [opts.findingsTable]: requestItems },
      }));
    }

    console.log(JSON.stringify({
      event: 'findings_written',
      count: records.length,
      packageName: opts.packageName,
      packageVersion: opts.packageVersion,
    }));
  } else {
    console.log(JSON.stringify({
      event: 'no_findings',
      packageName: opts.packageName,
      packageVersion: opts.packageVersion,
    }));
  }

  // ── Step 2: advance the LATEST_REVIEWED_VERSION pointer ────────────────────
  //
  // We use a padded semver string for comparison so "1.10.0" > "1.9.0".
  // ConditionExpression: "advance only when we are newer or there is no pointer yet"
  //
  //   attribute_not_exists(version)   — no pointer at all yet
  //   OR #v <= :newPadded             — our version is ≥ what is stored
  //
  // This is an optimistic-lock pattern: if a concurrent Lambda for the same
  // package and a later version writes first, the condition fails (our padded
  // value < theirs) and we silently discard — the right value wins.
  const newPadded = padSemver(opts.packageVersion);

  try {
    await opts.ddbClient.send(new UpdateCommand({
      TableName: opts.findingsTable,
      Key: {
        PK: `PKG#${opts.packageName}`,
        SK: 'LATEST_REVIEWED_VERSION',
      },
      UpdateExpression: `SET #v = :versionRaw, #vp = :versionPadded, jobId = :jobId, reviewedAt = :reviewedAt`
        + (opts.summary   ? ', summary = :summary'     : '')
        + (opts.riskLevel ? ', riskLevel = :riskLevel' : ''),
      ConditionExpression: 'attribute_not_exists(#vp) OR #vp <= :newPadded',
      ExpressionAttributeNames: {
        '#v':  'versionRaw',
        '#vp': 'version',   // padded semver — used for comparison
      },
      ExpressionAttributeValues: {
        ':versionRaw':    opts.packageVersion,
        ':versionPadded': newPadded,
        ':newPadded':     newPadded,
        ':jobId':         opts.jobId,
        ':reviewedAt':    now,
        ...(opts.summary   ? { ':summary':   opts.summary   } : {}),
        ...(opts.riskLevel ? { ':riskLevel': opts.riskLevel } : {}),
      },
    }));

    console.log(JSON.stringify({
      event: 'latest_version_pointer_updated',
      packageName: opts.packageName,
      packageVersion: opts.packageVersion,
      padded: newPadded,
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // A newer version's pointer write already won — this is expected and fine.
      console.log(JSON.stringify({
        event: 'latest_version_pointer_skipped',
        packageName: opts.packageName,
        packageVersion: opts.packageVersion,
        reason: 'existing pointer is already newer',
      }));
    } else {
      // Unexpected error — rethrow so the caller can decide whether to fail the job.
      throw err;
    }
  }

  // ── Step 3: upsert PKG_REGISTRY summary record (GAP 8) ─────────────────────
  //
  // Same conditional pattern: only update when our version is ≥ what is stored,
  // so the registry always reflects the latest-reviewed version of each package.
  try {
    await opts.ddbClient.send(new UpdateCommand({
      TableName: opts.findingsTable,
      Key: {
        PK: 'PKG_REGISTRY',
        SK: `PKG#${opts.packageName}`,
      },
      UpdateExpression: `SET packageName = :pkgName, latestVersion = :versionRaw`
        + `, latestVersionPadded = :versionPadded, latestJobId = :jobId`
        + `, lastReviewedAt = :reviewedAt, findingCount = :findingCount`
        + (opts.riskLevel ? ', riskLevel = :riskLevel' : ''),
      ConditionExpression: 'attribute_not_exists(latestVersionPadded) OR latestVersionPadded <= :newPadded',
      ExpressionAttributeValues: {
        ':pkgName':        opts.packageName,
        ':versionRaw':     opts.packageVersion,
        ':versionPadded':  newPadded,
        ':newPadded':      newPadded,
        ':jobId':          opts.jobId,
        ':reviewedAt':     now,
        ':findingCount':   reviewOutput.findings.length,
        ...(opts.riskLevel ? { ':riskLevel': opts.riskLevel } : {}),
      },
    }));

    console.log(JSON.stringify({
      event: 'pkg_registry_updated',
      packageName: opts.packageName,
      packageVersion: opts.packageVersion,
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.log(JSON.stringify({
        event: 'pkg_registry_skipped',
        packageName: opts.packageName,
        packageVersion: opts.packageVersion,
        reason: 'registry already has a newer version',
      }));
    } else {
      // Non-fatal — registry write failure should not fail the overall job.
      console.error(JSON.stringify({
        event: 'pkg_registry_write_error',
        packageName: opts.packageName,
        err: String(err),
      }));
    }
  }
}
