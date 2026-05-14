/**
 * dedup.ts — Webhook idempotency and cooldown helpers
 *
 * GAP 3: Commit-level idempotency
 *   - checkCommitRecord / writeCommitRecord use PK=PKG#{name}, SK=COMMIT#{sha}
 *   - Status values: PENDING | RUNNING | COMPLETE | FAILED
 *   - COMPLETE and RUNNING short-circuit — return existing jobId
 *   - FAILED is retryable
 *
 * GAP 6: Per-(repo, commit) webhook storm cooldown
 *   - checkCooldown / writeCooldown use PK=WEBHOOK#COOLDOWN#{sha256(repo+sha)}, SK=TS
 *   - TTL=60 seconds; if key exists within window, absorb the request
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { createHash } from 'crypto';

export type CommitReviewStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';

export interface CommitRecord {
  jobId: string;
  status: CommitReviewStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CommitCheckResult {
  /** Whether a record already exists that should block re-submission */
  shouldSkip: boolean;
  /** The existing record, if any */
  existing?: CommitRecord;
}

// ── Shared DynamoDB client (module-level singleton) ────────────────────────────

let _ddb: DynamoDBClient | undefined;
function ddb(): DynamoDBClient {
  if (!_ddb) _ddb = new DynamoDBClient({});
  return _ddb;
}

// ── Commit-level idempotency (GAP 3) ─────────────────────────────────────────

/**
 * Checks whether a review for this (packageName, commitSha) is already
 * in progress or complete.
 *
 * Returns { shouldSkip: true, existing } when status is PENDING, RUNNING, or COMPLETE.
 * Returns { shouldSkip: false } when status is FAILED (retry allowed) or record absent.
 */
export async function checkCommitRecord(
  tableName: string,
  packageName: string,
  commitSha: string,
): Promise<CommitCheckResult> {
  const pk = `PKG#${packageName}`;
  const sk = `COMMIT#${commitSha}`;

  const res = await ddb().send(new GetItemCommand({
    TableName: tableName,
    Key: {
      PK: { S: pk },
      SK: { S: sk },
    },
    // Only fetch what we need
    ProjectionExpression: 'jobId, #st, createdAt, updatedAt',
    ExpressionAttributeNames: { '#st': 'status' },
    ConsistentRead: true,
  }));

  if (!res.Item) {
    return { shouldSkip: false };
  }

  const record: CommitRecord = {
    jobId:     res.Item.jobId?.S ?? '',
    status:    (res.Item.status?.S ?? 'FAILED') as CommitReviewStatus,
    createdAt: res.Item.createdAt?.S ?? '',
    updatedAt: res.Item.updatedAt?.S ?? '',
  };

  console.log(JSON.stringify({
    event: 'commit_record_found',
    packageName,
    commitSha,
    status: record.status,
    jobId: record.jobId,
  }));

  // PENDING, RUNNING, COMPLETE → skip re-submission
  const shouldSkip = record.status !== 'FAILED';
  return { shouldSkip, existing: record };
}

/**
 * Writes the COMMIT# marker to DynamoDB with status=PENDING immediately on
 * submission — before the S3 upload — so concurrent webhook retries see it.
 *
 * Uses a conditional write (attribute_not_exists) so that only one caller
 * wins the race. If another Lambda already wrote it, the caller should treat
 * it as a duplicate and return the existing jobId.
 *
 * GSI4 attributes (sourceRef) are written here so the index is populated
 * at record creation time.
 *
 * @returns true  if the marker was written (this caller owns the job)
 * @returns false if the marker already existed (another caller already won)
 */
export async function writeCommitRecord(
  tableName: string,
  packageName: string,
  commitSha: string,
  jobId: string,
  sourceRef?: string,
): Promise<boolean> {
  const pk  = `PKG#${packageName}`;
  const sk  = `COMMIT#${commitSha}`;
  const now = new Date().toISOString();

  // TTL: 90 days from now — enough to cover any reasonable review window
  const ttl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

  try {
    await ddb().send(new PutItemCommand({
      TableName: tableName,
      Item: {
        PK:         { S: pk },
        SK:         { S: sk },
        jobId:      { S: jobId },
        status:     { S: 'PENDING' },
        createdAt:  { S: now },
        updatedAt:  { S: now },
        ttl:        { N: String(ttl) },
        // GSI4 attributes — sourceRef enables efficient lookup by git ref/SHA
        ...(sourceRef ? {
          GSI4PK: { S: `SOURCEREF#${sourceRef}` },
          GSI4SK: { S: `PKG#${packageName}` },
        } : {}),
      },
      // Only write if no record exists yet (prevents double-submission in races)
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    }));

    console.log(JSON.stringify({
      event: 'commit_record_written',
      packageName,
      commitSha,
      jobId,
      status: 'PENDING',
    }));
    return true;

  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      console.warn(JSON.stringify({
        event: 'commit_record_race_lost',
        packageName,
        commitSha,
        message: 'Another invocation already wrote the PENDING marker — treating as duplicate',
      }));
      return false;
    }
    throw err;
  }
}

// ── Per-(repo, commit) webhook storm cooldown (GAP 6) ─────────────────────────

/** How long (in seconds) to block duplicate webhooks for the same (repo, sha) */
const COOLDOWN_TTL_SECONDS = 60;

/**
 * Deterministically hashes (repoFullName + commitSha) to produce a fixed-length
 * DDB key that avoids special characters and long strings.
 */
function cooldownKey(repoFullName: string, commitSha: string): string {
  const hash = createHash('sha256')
    .update(`${repoFullName}:${commitSha}`)
    .digest('hex');
  return `WEBHOOK#COOLDOWN#${hash}`;
}

/**
 * Checks whether a cooldown record exists for this (repoFullName, commitSha).
 *
 * Returns true  → cooldown active, caller should swallow the request silently.
 * Returns false → no active cooldown, caller should proceed.
 */
export async function checkCooldown(
  tableName: string,
  repoFullName: string,
  commitSha: string,
): Promise<boolean> {
  const pk = cooldownKey(repoFullName, commitSha);

  const res = await ddb().send(new GetItemCommand({
    TableName: tableName,
    Key: {
      PK: { S: pk },
      SK: { S: 'TS' },
    },
    ProjectionExpression: 'PK',
    ConsistentRead: true,
  }));

  if (res.Item) {
    console.log(JSON.stringify({
      event: 'webhook_cooldown_hit',
      repoFullName,
      commitSha: commitSha.slice(0, 8),
    }));
    return true;
  }
  return false;
}

/**
 * Writes the cooldown marker for (repoFullName, commitSha) with a DynamoDB TTL
 * of COOLDOWN_TTL_SECONDS (60 s).
 *
 * Uses attribute_not_exists so that the first caller in a burst always wins and
 * subsequent callers simply see the key in checkCooldown.
 */
export async function writeCooldown(
  tableName: string,
  repoFullName: string,
  commitSha: string,
): Promise<void> {
  const pk  = cooldownKey(repoFullName, commitSha);
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + COOLDOWN_TTL_SECONDS;

  try {
    await ddb().send(new PutItemCommand({
      TableName: tableName,
      Item: {
        PK:          { S: pk },
        SK:          { S: 'TS' },
        repoFullName:{ S: repoFullName },
        commitSha:   { S: commitSha },
        createdAt:   { S: now },
        ttl:         { N: String(ttl) },
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    console.log(JSON.stringify({
      event: 'webhook_cooldown_written',
      repoFullName,
      commitSha: commitSha.slice(0, 8),
      ttlSeconds: COOLDOWN_TTL_SECONDS,
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Another concurrent Lambda already wrote the cooldown — that's fine
      console.log(JSON.stringify({
        event: 'webhook_cooldown_already_exists',
        repoFullName,
        commitSha: commitSha.slice(0, 8),
      }));
      return;
    }
    throw err;
  }
}
