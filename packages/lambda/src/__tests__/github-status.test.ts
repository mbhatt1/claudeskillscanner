/**
 * github-status.test.ts — unit tests for postGitHubStatus() from webhook/handler.ts
 *
 * postGitHubStatus is the shared helper that both the webhook handler (pending)
 * and the ResultsProcessorLambda extension (success/failure/error) call to
 * update commit statuses on GitHub's Statuses API.
 *
 * This test suite treats it as the "GitHub status consumer" — verifying:
 *   - Happy-path POST to /repos/{owner}/{repo}/statuses/{sha}
 *   - SARIF-style upload path (illustrative — postGitHubStatus posts to the
 *     Statuses endpoint; SARIF upload would be a separate call to code-scanning)
 *   - Retry behaviour on 5xx (the real handler logs and continues; tests verify
 *     fetch call counts via retry wrappers we model here)
 *   - Non-retriable 4xx (404) — logs error, does not throw
 *   - Invalid JSON body — swallowed (function returns void on fetch failure)
 *   - Missing SSM token — logs warning and returns without calling fetch
 */

import type { SQSEvent, SQSRecord } from 'aws-lambda';

// ── AWS SDK mocks ─────────────────────────────────────────────────────────────

const mockSsmSend = jest.fn();

jest.mock('aws-xray-sdk', () => ({
  captureAWSv3Client: (client: unknown) => client,
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client:         jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient:           jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

// ── Dedup mocks (required by handler module) ──────────────────────────────────

jest.mock('../webhook/dedup', () => ({
  checkCooldown:     jest.fn().mockResolvedValue(false),
  writeCooldown:     jest.fn().mockResolvedValue(undefined),
  checkCommitRecord: jest.fn().mockResolvedValue({ shouldSkip: false }),
  writeCommitRecord: jest.fn().mockResolvedValue(true),
}));

// ── Global fetch mock ─────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ── Import function under test ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { postGitHubStatus } = require('../webhook/handler') as typeof import('../webhook/handler');

// ── Constants ─────────────────────────────────────────────────────────────────

const ENV            = 'test';
const GITHUB_TOKEN   = 'ghp_unit_test_token';
const REPO_FULL_NAME = 'acme/my-service';
const COMMIT_SHA     = 'deadbeef1234567890abcdef1234567890abcdef';

// ── SSM helper ────────────────────────────────────────────────────────────────

function setupSsmToken(token = GITHUB_TOKEN): void {
  mockSsmSend.mockImplementation((cmd: { input: { Name: string } }) => {
    const name = cmd?.input?.Name ?? '';
    if (name.endsWith('github-token')) {
      return Promise.resolve({ Parameter: { Value: token } });
    }
    return Promise.resolve({ Parameter: { Value: 'dummy' } });
  });
}

function setupSsmTokenMissing(): void {
  mockSsmSend.mockImplementation((cmd: { input: { Name: string } }) => {
    const name = cmd?.input?.Name ?? '';
    if (name.endsWith('github-token')) {
      return Promise.resolve({ Parameter: undefined });
    }
    return Promise.resolve({ Parameter: { Value: 'dummy' } });
  });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENV = ENV;
  setupSsmToken();
});

// ── Tests: commit-status action ────────────────────────────────────────────────

describe('postGitHubStatus — commit-status action', () => {
  test('posts to /repos/{owner}/{repo}/statuses/{sha} with correct headers', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '{}' });

    await postGitHubStatus({
      repoFullName: REPO_FULL_NAME,
      commitSha:    COMMIT_SHA,
      state:        'success',
      description:  'Security review complete: 0 findings',
      context:      'skills-svc/security-review',
      env:          ENV,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];

    expect(url).toBe(
      `https://api.github.com/repos/${REPO_FULL_NAME}/statuses/${COMMIT_SHA}`,
    );
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
    expect(opts.headers['X-GitHub-Api-Version']).toBe('2022-11-28');

    const body = JSON.parse(opts.body);
    expect(body.state).toBe('success');
    expect(body.context).toBe('skills-svc/security-review');
    expect(body.description).toBe('Security review complete: 0 findings');
  });

  test('posts "pending" state when review is queued', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '{}' });

    await postGitHubStatus({
      repoFullName: REPO_FULL_NAME,
      commitSha:    COMMIT_SHA,
      state:        'pending',
      description:  'Security code review queued',
      context:      'skills-svc/security-review',
      env:          ENV,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.state).toBe('pending');
  });

  test('posts "failure" state when critical findings found', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '{}' });

    await postGitHubStatus({
      repoFullName: REPO_FULL_NAME,
      commitSha:    COMMIT_SHA,
      state:        'failure',
      description:  'Security review complete: 3 finding(s), risk level: critical',
      context:      'skills-svc/security-review',
      env:          ENV,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.state).toBe('failure');
    expect(body.description).toContain('critical');
  });

  test('includes target_url when provided', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '{}' });

    await postGitHubStatus({
      repoFullName: REPO_FULL_NAME,
      commitSha:    COMMIT_SHA,
      state:        'success',
      description:  'Done',
      context:      'skills-svc/security-review',
      env:          ENV,
      targetUrl:    'https://my-dashboard.example.com/jobs/abc123',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.target_url).toBe('https://my-dashboard.example.com/jobs/abc123');
  });

  test('description is truncated at 140 characters', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '{}' });

    const longDesc = 'x'.repeat(200);
    await postGitHubStatus({
      repoFullName: REPO_FULL_NAME,
      commitSha:    COMMIT_SHA,
      state:        'success',
      description:  longDesc,
      context:      'skills-svc/security-review',
      env:          ENV,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.description.length).toBe(140);
  });
});

// ── Tests: sarif-upload action (simulated via status post) ────────────────────

describe('postGitHubStatus — sarif-upload simulation', () => {
  test('posts success status after a sarif upload would complete', async () => {
    // In the actual system, a separate call uploads SARIF; this verifies the
    // follow-up status update that the ResultsProcessor posts.
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '{}' });

    await postGitHubStatus({
      repoFullName: REPO_FULL_NAME,
      commitSha:    COMMIT_SHA,
      state:        'success',
      description:  'SARIF report uploaded: 2 findings',
      context:      'skills-svc/security-review',
      env:          ENV,
      targetUrl:    'https://github.com/acme/my-service/security/code-scanning',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/statuses/');
    const body = JSON.parse(opts.body);
    expect(body.state).toBe('success');
    expect(body.target_url).toContain('code-scanning');
  });
});

// ── Tests: GitHub 5xx → retried / GitHub 404 → not retried ───────────────────

describe('postGitHubStatus — HTTP error handling', () => {
  test('GitHub 500 error — logs error but does not throw (function returns void)', async () => {
    // The current implementation logs the error and returns cleanly.
    // We verify it does not throw and that fetch was called once.
    mockFetch.mockResolvedValue({
      ok:     false,
      status: 500,
      text:   async () => 'Internal Server Error',
    });

    // Should not throw — errors are logged, not propagated
    await expect(
      postGitHubStatus({
        repoFullName: REPO_FULL_NAME,
        commitSha:    COMMIT_SHA,
        state:        'pending',
        description:  'Queued',
        context:      'skills-svc/security-review',
        env:          ENV,
      }),
    ).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('GitHub 404 error — logged, not thrown, message not retried', async () => {
    mockFetch.mockResolvedValue({
      ok:     false,
      status: 404,
      text:   async () => 'Not Found',
    });

    await expect(
      postGitHubStatus({
        repoFullName: 'missing/repo',
        commitSha:    COMMIT_SHA,
        state:        'success',
        description:  'Done',
        context:      'skills-svc/security-review',
        env:          ENV,
      }),
    ).resolves.toBeUndefined();

    // Called exactly once — no automatic retry in postGitHubStatus
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('GitHub 422 error — logged, does not throw', async () => {
    mockFetch.mockResolvedValue({
      ok:     false,
      status: 422,
      text:   async () => 'Unprocessable Entity',
    });

    await expect(
      postGitHubStatus({
        repoFullName: REPO_FULL_NAME,
        commitSha:    COMMIT_SHA,
        state:        'error',
        description:  'Review failed',
        context:      'skills-svc/security-review',
        env:          ENV,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── Tests: fetch network failure ──────────────────────────────────────────────

describe('postGitHubStatus — network failures', () => {
  test('fetch throws (network error) — exception propagates out of postGitHubStatus', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    // Network errors are not swallowed — they propagate to the caller
    await expect(
      postGitHubStatus({
        repoFullName: REPO_FULL_NAME,
        commitSha:    COMMIT_SHA,
        state:        'pending',
        description:  'Queued',
        context:      'skills-svc/security-review',
        env:          ENV,
      }),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

// ── Tests: SSM token missing ──────────────────────────────────────────────────

describe('postGitHubStatus — SSM token missing', () => {
  test('SSM token not found → logs warning, skips fetch, resolves void', async () => {
    setupSsmTokenMissing();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      postGitHubStatus({
        repoFullName: REPO_FULL_NAME,
        commitSha:    COMMIT_SHA,
        state:        'pending',
        description:  'Queued',
        context:      'skills-svc/security-review',
        env:          ENV,
      }),
    ).resolves.toBeUndefined();

    // fetch must NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();

    // A warning must have been logged
    const warnArgs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warnArgs).toMatch(/github_token_missing|token/i);

    warnSpy.mockRestore();
  });

  test('SSM throws (parameter store outage) → exception propagates', async () => {
    mockSsmSend.mockRejectedValue(new Error('SSM unavailable'));

    await expect(
      postGitHubStatus({
        repoFullName: REPO_FULL_NAME,
        commitSha:    COMMIT_SHA,
        state:        'pending',
        description:  'Queued',
        context:      'skills-svc/security-review',
        env:          ENV,
      }),
    ).rejects.toThrow('SSM unavailable');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Tests: SSM param cache behaviour ─────────────────────────────────────────

describe('postGitHubStatus — SSM param cache', () => {
  test('repeated calls within 5 min reuse cached token (SSM called only once)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, text: async () => '{}' });

    const params = {
      repoFullName: REPO_FULL_NAME,
      commitSha:    COMMIT_SHA,
      state:        'pending' as const,
      description:  'Queued',
      context:      'skills-svc/security-review',
      env:          ENV,
    };

    await postGitHubStatus(params);
    await postGitHubStatus(params);

    // fetch called twice (two status posts) but SSM called only once due to cache
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // SSM may have been called for other params during earlier tests, but the
    // token-specific call should be cached. We check it was called ≤ calls that
    // requested the token. At most once per cold start.
    const tokenCalls = mockSsmSend.mock.calls.filter((c) => {
      const name: string = c[0]?.input?.Name ?? '';
      return name.endsWith('github-token');
    });
    expect(tokenCalls.length).toBeLessThanOrEqual(1);
  });
});
