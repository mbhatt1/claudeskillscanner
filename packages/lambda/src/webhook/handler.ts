/**
 * handler.ts — GitHub/GitLab Webhook Lambda
 *
 * Changes vs. the SPEC-25 baseline:
 *
 * GAP 3 fix — commit-level idempotency:
 *   Before issuing an S3 PutObject, we:
 *     1. checkCooldown (GAP 6 guard — fast path)
 *     2. checkCommitRecord — if COMPLETE or RUNNING, return 200 with existing jobId
 *     3. writeCommitRecord(status=PENDING) with a conditional write to claim the job
 *     4. If the conditional write is lost to a race, re-read and return existing jobId
 *   Only then do we proceed with S3 upload and GitHub status post.
 *
 * GAP 6 fix — per-(repo, commit) burst cooldown:
 *   checkCooldown runs before any DDB/S3 work. If the key exists (within 60 s
 *   of the first webhook for this SHA), we return 200 immediately.
 *   writeCooldown runs right after the cooldown check passes (first receipt).
 */

import { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { captureAWSv3Client } from 'aws-xray-sdk';
import { createHmac, timingSafeEqual, randomUUID } from 'crypto';
import {
  checkCooldown,
  writeCooldown,
  checkCommitRecord,
  writeCommitRecord,
} from './dedup';

const s3  = captureAWSv3Client(new S3Client({}));
const ssm = captureAWSv3Client(new SSMClient({}));

// ── SSM parameter cache (5-minute warm cache) ─────────────────────────────────

const paramCache = new Map<string, { value: string; ts: number }>();

async function getParam(name: string): Promise<string> {
  const now    = Date.now();
  const cached = paramCache.get(name);
  if (cached && now - cached.ts < 300_000) return cached.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM param not found: ${name}`);
  paramCache.set(name, { value, ts: now });
  return value;
}

function response(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ── GitHub webhook handler ─────────────────────────────────────────────────────

async function handleGitHub(
  headers: Record<string, string | undefined>,
  rawBody: string,
  env: string,
): Promise<APIGatewayProxyResultV2> {

  // ── 1. Validate HMAC-SHA256 signature ─────────────────────────────────────
  const sigHeader = headers['x-hub-signature-256'] ?? '';
  const secret    = await getParam(`/skills-svc/${env}/webhook/github-secret`);
  const expected  = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  const sigBuffer = Buffer.from(sigHeader.padEnd(expected.length));
  const expBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
    console.warn(JSON.stringify({ event: 'github_signature_invalid' }));
    return response(401, { error: 'Invalid signature' });
  }

  const event = headers['x-github-event'];
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  let repoUrl: string | undefined;
  let commitSha: string | undefined;
  let repoFullName: string | undefined;

  if (event === 'pull_request') {
    const action: string = payload.action;
    if (!['opened', 'synchronize', 'reopened'].includes(action)) {
      return response(200, { message: `Ignoring pull_request action: ${action}` });
    }
    repoUrl      = payload.pull_request?.head?.repo?.clone_url as string;
    commitSha    = payload.pull_request?.head?.sha as string;
    repoFullName = payload.repository?.full_name as string;
  } else if (event === 'push') {
    const ref: string = payload.ref ?? '';
    if (!ref.startsWith('refs/tags/')) {
      return response(200, { message: `Ignoring push to non-tag ref: ${ref}` });
    }
    repoUrl      = payload.repository?.clone_url as string;
    commitSha    = payload.after as string;
    repoFullName = payload.repository?.full_name as string;
  } else {
    return response(200, { message: `Ignoring event: ${event}` });
  }

  if (!repoUrl || !commitSha || !repoFullName) {
    return response(400, { error: 'Missing required fields in GitHub payload' });
  }

  const findingsTable  = await getParam(`/skills-svc/${env}/dynamodb/findings-table-name`);
  const uploadsBucket  = await getParam(`/skills-svc/${env}/s3/uploads-bucket`);
  const packageName    = repoFullName.replace('/', '_');

  // ── 2. GAP 6 — per-(repo, commit) cooldown check ──────────────────────────
  const inCooldown = await checkCooldown(findingsTable, repoFullName, commitSha);
  if (inCooldown) {
    // Absorb the burst — return 200 so GitHub does not retry
    return response(200, { message: 'Duplicate webhook within cooldown window — skipped' });
  }

  // Write the cooldown marker before proceeding (TTL=60 s)
  await writeCooldown(findingsTable, repoFullName, commitSha);

  // ── 3. GAP 3 — commit-level idempotency check ─────────────────────────────
  const commitCheck = await checkCommitRecord(findingsTable, packageName, commitSha);
  if (commitCheck.shouldSkip && commitCheck.existing) {
    const existing = commitCheck.existing;
    console.log(JSON.stringify({
      event: 'github_webhook_deduplicated',
      repoFullName,
      commitSha,
      existingJobId: existing.jobId,
      existingStatus: existing.status,
    }));
    return response(200, {
      message: `Review already ${existing.status.toLowerCase()} for this commit`,
      jobId: existing.jobId,
    });
  }

  // ── 4. Claim the job by writing COMMIT# marker (PENDING, conditional) ─────
  const jobId = randomUUID();

  const claimed = await writeCommitRecord(
    findingsTable,
    packageName,
    commitSha,
    jobId,
    commitSha,   // sourceRef = commitSha
  );

  if (!claimed) {
    // Race: another Lambda already claimed this job — re-read and return it
    const recheck = await checkCommitRecord(findingsTable, packageName, commitSha);
    if (recheck.existing) {
      return response(200, {
        message: 'Review already submitted for this commit (concurrent request)',
        jobId: recheck.existing.jobId,
      });
    }
    // Extremely unlikely — existing record vanished; fall through and let caller retry
    return response(200, { message: 'Concurrent submission detected — please retry if needed' });
  }

  // ── 5. Submit review job via S3 metadata → SQS → ECS pipeline ─────────────
  const s3Key = `reviews/${packageName}/${commitSha.slice(0, 8)}/${jobId}/trigger.json`;

  await s3.send(new PutObjectCommand({
    Bucket: uploadsBucket,
    Key: s3Key,
    Body: JSON.stringify({
      jobId,
      triggeredBy: 'github-webhook',
      repoUrl,
      commitSha,
      repoFullName,
      event,
    }),
    ContentType: 'application/json',
    Metadata: {
      'input-mode':           'git',
      'package-name':         packageName,
      'package-version':      commitSha.slice(0, 8),
      'github-repo':          repoFullName,
      'github-commit-sha':    commitSha,
      'job-name':             `github-${packageName}-${commitSha.slice(0, 8)}`,
      'user-arn':             'webhook',
      'git-url':              repoUrl,
      'git-ref':              commitSha,
    },
  }));

  // ── 6. Post "pending" GitHub status check ─────────────────────────────────
  await postGitHubStatus({
    repoFullName,
    commitSha,
    state:       'pending',
    description: 'Security code review queued',
    context:     'skills-svc/security-review',
    env,
  });

  console.log(JSON.stringify({ event: 'github_webhook_processed', jobId, repoFullName, commitSha }));
  return response(202, { jobId, message: 'Review job submitted' });
}

// ── GitLab webhook handler ─────────────────────────────────────────────────────

async function handleGitLab(
  headers: Record<string, string | undefined>,
  rawBody: string,
  env: string,
): Promise<APIGatewayProxyResultV2> {

  // ── 1. Validate GitLab token ───────────────────────────────────────────────
  const tokenHeader = headers['x-gitlab-token'] ?? '';
  const secret      = await getParam(`/skills-svc/${env}/webhook/gitlab-secret`);
  if (tokenHeader !== secret) {
    console.warn(JSON.stringify({ event: 'gitlab_token_invalid' }));
    return response(401, { error: 'Invalid token' });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  const objectKind: string = payload.object_kind;
  let repoUrl: string | undefined;
  let commitSha: string | undefined;
  let projectId: string | undefined;

  if (objectKind === 'merge_request') {
    const action: string = payload.object_attributes?.action;
    if (!['open', 'update', 'reopen'].includes(action)) {
      return response(200, { message: `Ignoring merge_request action: ${action}` });
    }
    repoUrl   = payload.project?.http_url as string;
    commitSha = payload.object_attributes?.last_commit?.id as string;
    projectId = String(payload.project?.id ?? '');
  } else if (objectKind === 'tag_push') {
    repoUrl   = payload.project?.http_url as string;
    commitSha = payload.checkout_sha as string;
    projectId = String(payload.project?.id ?? '');
  } else {
    return response(200, { message: `Ignoring object_kind: ${objectKind}` });
  }

  if (!repoUrl || !commitSha || !projectId) {
    return response(400, { error: 'Missing required fields in GitLab payload' });
  }

  const findingsTable = await getParam(`/skills-svc/${env}/dynamodb/findings-table-name`);
  const uploadsBucket = await getParam(`/skills-svc/${env}/s3/uploads-bucket`);
  const packageName   = `gitlab_${projectId}`;
  const repoFullName  = `gitlab/${projectId}`;

  // ── 2. GAP 6 — cooldown check ─────────────────────────────────────────────
  const inCooldown = await checkCooldown(findingsTable, repoFullName, commitSha);
  if (inCooldown) {
    return response(200, { message: 'Duplicate webhook within cooldown window — skipped' });
  }
  await writeCooldown(findingsTable, repoFullName, commitSha);

  // ── 3. GAP 3 — commit-level idempotency ───────────────────────────────────
  const commitCheck = await checkCommitRecord(findingsTable, packageName, commitSha);
  if (commitCheck.shouldSkip && commitCheck.existing) {
    const existing = commitCheck.existing;
    console.log(JSON.stringify({
      event: 'gitlab_webhook_deduplicated',
      projectId,
      commitSha,
      existingJobId: existing.jobId,
      existingStatus: existing.status,
    }));
    return response(200, {
      message: `Review already ${existing.status.toLowerCase()} for this commit`,
      jobId: existing.jobId,
    });
  }

  // ── 4. Claim the job ───────────────────────────────────────────────────────
  const jobId = randomUUID();

  const claimed = await writeCommitRecord(
    findingsTable,
    packageName,
    commitSha,
    jobId,
    commitSha,
  );

  if (!claimed) {
    const recheck = await checkCommitRecord(findingsTable, packageName, commitSha);
    if (recheck.existing) {
      return response(200, {
        message: 'Review already submitted for this commit (concurrent request)',
        jobId: recheck.existing.jobId,
      });
    }
    return response(200, { message: 'Concurrent submission detected — please retry if needed' });
  }

  // ── 5. Submit review job ───────────────────────────────────────────────────
  const s3Key = `reviews/${packageName}/${commitSha.slice(0, 8)}/${jobId}/trigger.json`;

  await s3.send(new PutObjectCommand({
    Bucket: uploadsBucket,
    Key: s3Key,
    Body: JSON.stringify({ jobId, triggeredBy: 'gitlab-webhook', repoUrl, commitSha, projectId }),
    ContentType: 'application/json',
    Metadata: {
      'input-mode':          'git',
      'package-name':        packageName,
      'package-version':     commitSha.slice(0, 8),
      'gitlab-project-id':   projectId,
      'gitlab-commit-sha':   commitSha,
      'job-name':            `gitlab-${projectId}-${commitSha.slice(0, 8)}`,
      'user-arn':            'webhook',
      'git-url':             repoUrl,
      'git-ref':             commitSha,
    },
  }));

  console.log(JSON.stringify({ event: 'gitlab_webhook_processed', jobId, projectId, commitSha }));
  return response(202, { jobId, message: 'Review job submitted' });
}

// ── GitHub Checks API helper ──────────────────────────────────────────────────

interface GitHubStatusParams {
  repoFullName: string;
  commitSha: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  description: string;
  context: string;
  env: string;
  targetUrl?: string;
}

export async function postGitHubStatus(params: GitHubStatusParams): Promise<void> {
  let token: string;
  try {
    token = await getParam(`/skills-svc/${params.env}/webhook/github-token`);
  } catch {
    console.warn(JSON.stringify({
      event: 'github_token_missing',
      message: 'No GitHub token in SSM — skipping status post',
    }));
    return;
  }

  const url  = `https://api.github.com/repos/${params.repoFullName}/statuses/${params.commitSha}`;
  const body = {
    state:       params.state,
    description: params.description.slice(0, 140),
    context:     params.context,
    ...(params.targetUrl ? { target_url: params.targetUrl } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:        `Bearer ${token}`,
      Accept:               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type':       'application/json',
      'User-Agent':         'skills-svc-webhook/1.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(JSON.stringify({
      event:  'github_status_post_failed',
      status: res.status,
      body:   await res.text().catch(() => ''),
    }));
  } else {
    console.log(JSON.stringify({
      event:     'github_status_posted',
      state:     params.state,
      commitSha: params.commitSha,
    }));
  }
}

// ── reviewSubmit helper (also used by `review submit` CLI command) ─────────────
//
// GAP 3 also applies to the CLI path. Any caller that resolves a (packageName,
// commitSha) pair should call this before submitting to avoid duplicate ECS tasks.

export interface ReviewSubmitOptions {
  /** DynamoDB findings table name */
  findingsTable: string;
  packageName: string;
  commitSha: string;
  /** Called only when no existing COMPLETE/RUNNING/PENDING record exists. */
  submitFn: (jobId: string) => Promise<void>;
}

export interface ReviewSubmitResult {
  jobId: string;
  /** true if a new job was started; false if an existing job was reused */
  isNew: boolean;
  status: string;
}

/**
 * Idempotent review submission — shared by webhook handler and CLI `reviewSubmit`.
 *
 * 1. Checks DDB for existing COMMIT# record.
 * 2. If COMPLETE or RUNNING → returns existing jobId without calling submitFn.
 * 3. If FAILED or absent    → writes PENDING marker, then calls submitFn.
 * 4. If concurrent race lost → re-reads and returns winner's jobId.
 */
export async function reviewSubmit(opts: ReviewSubmitOptions): Promise<ReviewSubmitResult> {
  const { findingsTable, packageName, commitSha, submitFn } = opts;

  // Check for existing record
  const check = await checkCommitRecord(findingsTable, packageName, commitSha);
  if (check.shouldSkip && check.existing) {
    return {
      jobId:  check.existing.jobId,
      isNew:  false,
      status: check.existing.status,
    };
  }

  // Attempt to claim
  const jobId   = randomUUID();
  const claimed = await writeCommitRecord(findingsTable, packageName, commitSha, jobId, commitSha);

  if (!claimed) {
    // Another caller won the race
    const recheck = await checkCommitRecord(findingsTable, packageName, commitSha);
    if (recheck.existing) {
      return {
        jobId:  recheck.existing.jobId,
        isNew:  false,
        status: recheck.existing.status,
      };
    }
    // Fallback: just proceed — shouldn't normally happen
  }

  await submitFn(jobId);
  return { jobId, isNew: true, status: 'PENDING' };
}

// ── Main Lambda handler ───────────────────────────────────────────────────────

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const env     = process.env.ENV ?? 'prod';
  const rawBody = event.body ?? '';
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }

  const path = event.rawPath ?? '';

  try {
    if (path.startsWith('/webhook/github')) {
      return await handleGitHub(headers, rawBody, env);
    } else if (path.startsWith('/webhook/gitlab')) {
      return await handleGitLab(headers, rawBody, env);
    } else {
      return response(404, { error: 'Unknown webhook path' });
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'webhook_error', err: String(err) }));
    return response(500, { error: 'Internal server error' });
  }
};
