/**
 * handler.test.ts — unit tests for packages/lambda/src/webhook/handler.ts
 *
 * Mocks:
 *   - aws-xray-sdk          (captureAWSv3Client → identity)
 *   - @aws-sdk/client-s3    (S3Client + PutObjectCommand)
 *   - @aws-sdk/client-ssm   (SSMClient + GetParameterCommand)
 *   - ./dedup               (checkCooldown, writeCooldown, checkCommitRecord, writeCommitRecord)
 *   - global fetch          (GitHub status API)
 */

import { createHmac } from 'crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ── AWS SDK mocks ─────────────────────────────────────────────────────────────

const mockS3Send  = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('aws-xray-sdk', () => ({
  captureAWSv3Client: (client: unknown) => client,
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client:        jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient:         jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

// ── Dedup helpers mocks ───────────────────────────────────────────────────────

const mockCheckCooldown     = jest.fn();
const mockWriteCooldown     = jest.fn();
const mockCheckCommitRecord = jest.fn();
const mockWriteCommitRecord = jest.fn();

jest.mock('../dedup', () => ({
  checkCooldown:     (...args: unknown[]) => mockCheckCooldown(...args),
  writeCooldown:     (...args: unknown[]) => mockWriteCooldown(...args),
  checkCommitRecord: (...args: unknown[]) => mockCheckCommitRecord(...args),
  writeCommitRecord: (...args: unknown[]) => mockWriteCommitRecord(...args),
}));

// ── Global fetch mock ─────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ── Import handler under test (after mocks are in place) ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('../handler') as typeof import('../handler');

// ── Constants ─────────────────────────────────────────────────────────────────

const ENV            = 'test';
const GITHUB_SECRET  = 'super-secret-github';
const GITLAB_SECRET  = 'super-secret-gitlab';
const GITHUB_TOKEN   = 'ghp_testtoken';
const UPLOADS_BUCKET = 'test-uploads-bucket';
const FINDINGS_TABLE = 'test-findings-table';
const REPO_FULL_NAME = 'acme/my-repo';
const COMMIT_SHA     = 'aabbccdd1122334455667788aabbccdd11223344';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeHmac(body: string, secret = GITHUB_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makePrBody(action = 'opened'): string {
  return JSON.stringify({
    action,
    pull_request: {
      head: {
        sha:  COMMIT_SHA,
        repo: { clone_url: `https://github.com/${REPO_FULL_NAME}.git` },
      },
    },
    repository: { full_name: REPO_FULL_NAME },
  });
}

function makeTagPushBody(): string {
  return JSON.stringify({
    ref:        'refs/tags/v1.0.0',
    after:      COMMIT_SHA,
    repository: {
      clone_url: `https://github.com/${REPO_FULL_NAME}.git`,
      full_name: REPO_FULL_NAME,
    },
  });
}

function makeBranchPushBody(ref = 'refs/heads/main'): string {
  return JSON.stringify({
    ref,
    after:      COMMIT_SHA,
    repository: {
      clone_url: `https://github.com/${REPO_FULL_NAME}.git`,
      full_name: REPO_FULL_NAME,
    },
  });
}

function makeGitHubEvent(
  overrides: Partial<{
    body: string;
    sig: string;
    event: string;
    path: string;
  }> = {},
): APIGatewayProxyEventV2 {
  const body = overrides.body ?? makePrBody();
  return {
    headers: {
      'x-hub-signature-256': overrides.sig ?? makeHmac(body),
      'x-github-event':      overrides.event ?? 'pull_request',
      'content-type':        'application/json',
    },
    rawPath:              overrides.path ?? '/webhook/github',
    body,
    requestContext:       {} as never,
    isBase64Encoded:      false,
    version:              '2.0',
    routeKey:             '$default',
    rawQueryString:       '',
  } as APIGatewayProxyEventV2;
}

function makeGitLabEvent(
  body: string,
  token = GITLAB_SECRET,
): APIGatewayProxyEventV2 {
  return {
    headers: {
      'x-gitlab-token': token,
      'content-type':   'application/json',
    },
    rawPath:         '/webhook/gitlab',
    body,
    requestContext:  {} as never,
    isBase64Encoded: false,
    version:         '2.0',
    routeKey:        '$default',
    rawQueryString:  '',
  } as APIGatewayProxyEventV2;
}

// SSM param map — returns sensible defaults for every param key
function ssmDefault(name: string): string {
  if (name.endsWith('github-secret'))     return GITHUB_SECRET;
  if (name.endsWith('gitlab-secret'))     return GITLAB_SECRET;
  if (name.endsWith('github-token'))      return GITHUB_TOKEN;
  if (name.endsWith('uploads-bucket'))    return UPLOADS_BUCKET;
  if (name.endsWith('findings-table-name')) return FINDINGS_TABLE;
  return 'unknown-param';
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  process.env.ENV = ENV;

  // Default SSM: return Parameter.Value based on the name key
  mockSsmSend.mockImplementation((cmd: { input: { Name: string } }) => {
    const name = cmd?.input?.Name ?? '';
    return Promise.resolve({ Parameter: { Value: ssmDefault(name) } });
  });

  // Default S3: success
  mockS3Send.mockResolvedValue({});

  // Default dedup: no cooldown, no existing record, claim succeeds
  mockCheckCooldown.mockResolvedValue(false);
  mockWriteCooldown.mockResolvedValue(undefined);
  mockCheckCommitRecord.mockResolvedValue({ shouldSkip: false });
  mockWriteCommitRecord.mockResolvedValue(true);

  // Default fetch: GitHub status API 201
  mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '' });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitHub webhook handler', () => {
  test('valid pull_request opened → 202, S3 written, pending status posted', async () => {
    const body = makePrBody('opened');
    const evt  = makeGitHubEvent({ body });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(202);
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty('jobId');
    expect(parsed.message).toMatch(/submitted/i);

    // S3 PutObject should have been called once
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const s3Call = mockS3Send.mock.calls[0][0];
    expect(s3Call.input.Bucket).toBe(UPLOADS_BUCKET);
    expect(s3Call.input.Key).toMatch(/^reviews\//);
    expect(s3Call.input.Metadata?.['input-mode']).toBe('git');
    expect(s3Call.input.Metadata?.['github-repo']).toBe(REPO_FULL_NAME);

    // Pending status should have been posted to GitHub
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, fetchOpts] = mockFetch.mock.calls[0];
    expect(url).toContain(`/repos/${REPO_FULL_NAME}/statuses/${COMMIT_SHA}`);
    const fetchBody = JSON.parse(fetchOpts.body);
    expect(fetchBody.state).toBe('pending');
    expect(fetchOpts.headers.Authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
  });

  test('invalid HMAC signature → 401', async () => {
    const body = makePrBody('opened');
    const evt  = makeGitHubEvent({ body, sig: 'sha256=deadbeef' });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toMatch(/signature/i);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('wrong-length HMAC signature → 401 (timing-safe pad branch)', async () => {
    const body = makePrBody('opened');
    // Shorter than the real signature — tests the padEnd branch
    const evt = makeGitHubEvent({ body, sig: 'sha256=abc' });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(401);
  });

  test('pull_request action=closed → 200 with Ignoring message, no S3 write', async () => {
    const body = makePrBody('closed');
    const evt  = makeGitHubEvent({ body });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toMatch(/Ignoring/);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('push to refs/tags/v1.0.0 → 202 (tag push accepted)', async () => {
    const body = makeTagPushBody();
    const sig  = makeHmac(body);
    const evt  = makeGitHubEvent({ body, sig, event: 'push' });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(202);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
    // Metadata should carry refs/tags context
    const s3Call = mockS3Send.mock.calls[0][0];
    expect(s3Call.input.Metadata?.['input-mode']).toBe('git');
  });

  test('push to refs/heads/main → 200 (non-tag push ignored)', async () => {
    const body = makeBranchPushBody('refs/heads/main');
    const sig  = makeHmac(body);
    const evt  = makeGitHubEvent({ body, sig, event: 'push' });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toMatch(/non-tag/i);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('duplicate commit (shouldSkip=true) → 200 with existing jobId, no S3 write', async () => {
    const existingJobId = 'existing-job-uuid-1234';
    mockCheckCommitRecord.mockResolvedValue({
      shouldSkip: true,
      existing:   { jobId: existingJobId, status: 'RUNNING' },
    });

    const body = makePrBody('opened');
    const evt  = makeGitHubEvent({ body });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body);
    expect(parsed.jobId).toBe(existingJobId);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('cooldown active → 200 immediately, no S3 write', async () => {
    mockCheckCooldown.mockResolvedValue(true);

    const body = makePrBody('opened');
    const evt  = makeGitHubEvent({ body });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).message).toMatch(/cooldown/i);
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockCheckCommitRecord).not.toHaveBeenCalled();
  });

  test('pull_request synchronize → 202, scope stored in S3 body', async () => {
    const body = makePrBody('synchronize');
    const evt  = makeGitHubEvent({ body });

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(202);
    expect(mockS3Send).toHaveBeenCalledTimes(1);

    // Verify S3 body contains expected fields
    const s3Input = mockS3Send.mock.calls[0][0].input;
    const s3Body  = JSON.parse(s3Input.Body);
    expect(s3Body.repoFullName).toBe(REPO_FULL_NAME);
    expect(s3Body.commitSha).toBe(COMMIT_SHA);
    expect(s3Body.triggeredBy).toBe('github-webhook');
    expect(s3Body.event).toBe('pull_request');
  });
});

describe('GitLab webhook handler', () => {
  const mergeRequestBody = JSON.stringify({
    object_kind: 'merge_request',
    object_attributes: {
      action:      'open',
      last_commit: { id: COMMIT_SHA },
    },
    project: {
      id:       42,
      http_url: 'https://gitlab.com/acme/my-repo.git',
    },
  });

  test('valid merge_request with correct token → 202', async () => {
    const evt = makeGitLabEvent(mergeRequestBody, GITLAB_SECRET);

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(202);
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty('jobId');

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const s3Input = mockS3Send.mock.calls[0][0].input;
    expect(s3Input.Metadata?.['gitlab-project-id']).toBe('42');
    expect(s3Input.Metadata?.['input-mode']).toBe('git');
  });

  test('GitLab wrong token → 401', async () => {
    const evt = makeGitLabEvent(mergeRequestBody, 'wrong-token');

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body).error).toMatch(/token/i);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('GitLab timing-safe comparison — correct-length wrong token → 401', async () => {
    // Token is same length as the real secret but contains different bytes
    const sameLength = GITLAB_SECRET.replace(/./g, 'x'); // same length, all x
    const evt = makeGitLabEvent(mergeRequestBody, sameLength);

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    // The handler uses !== comparison for GitLab (simpler), so this must still be 401
    expect(result.statusCode).toBe(401);
  });

  test('GitLab token shorter than real secret → 401', async () => {
    const evt = makeGitLabEvent(mergeRequestBody, 'short');

    const result = await handler(evt, {} as never, jest.fn()) as { statusCode: number; body: string };

    expect(result.statusCode).toBe(401);
  });
});
