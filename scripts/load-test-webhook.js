/**
 * k6 load test: simulate 50 concurrent GitHub webhook deliveries per second.
 *
 * Run:
 *   k6 run --vus 50 --duration 60s scripts/load-test-webhook.js
 *
 * Required environment variables (pass with --env or export):
 *   WEBHOOK_URL    Full URL of the webhook endpoint, e.g.
 *                  https://abc123.execute-api.us-east-1.amazonaws.com/webhook/github
 *   GITHUB_SECRET  The HMAC-SHA256 shared secret configured in SSM at
 *                  /skills-svc/{env}/webhook/github-secret
 *
 * k6 does not ship Node.js crypto; HMAC-SHA256 is computed using the k6
 * built-in `k6/crypto` module (available since k6 v0.29).
 *
 * Metrics tracked:
 *   - http_req_duration p95 must be < 2 000 ms
 *   - error rate (non-202/200/401 responses) must be < 1%
 *   - response code breakdown: 202 (new job), 200 (ignored event), 401 (bad sig)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';

// ─── Custom metrics ────────────────────────────────────────────────────────

const accepted      = new Counter('webhook_accepted_202');   // new review job
const duplicate     = new Counter('webhook_duplicate_200');  // ignored event
const unauthorized  = new Counter('webhook_unauthorized_401'); // bad signature
const otherErrors   = new Counter('webhook_other_errors');
const errorRate     = new Rate('webhook_error_rate');
const p95Latency    = new Trend('webhook_p95_latency', true);

// ─── k6 options ───────────────────────────────────────────────────────────

export const options = {
  vus: 50,
  duration: '60s',

  thresholds: {
    // p95 response time must stay below 2 000 ms
    http_req_duration: ['p(95)<2000'],

    // Custom error rate must be below 1%
    webhook_error_rate: ['rate<0.01'],
  },

  // Graceful ramp-up over 5 s to avoid cold-start spike skewing p95
  stages: [
    { duration: '5s',  target: 50 },  // ramp up to 50 VUs
    { duration: '50s', target: 50 },  // hold at 50 VUs
    { duration: '5s',  target: 0  },  // ramp down
  ],
};

// ─── Configuration (from environment) ────────────────────────────────────

const WEBHOOK_URL   = __ENV.WEBHOOK_URL;
const GITHUB_SECRET = __ENV.GITHUB_SECRET;

if (!WEBHOOK_URL) {
  throw new Error('WEBHOOK_URL environment variable is required. ' +
    'Pass with: k6 run --env WEBHOOK_URL=https://...');
}
if (!GITHUB_SECRET) {
  throw new Error('GITHUB_SECRET environment variable is required. ' +
    'Pass with: k6 run --env GITHUB_SECRET=<secret>');
}

// ─── Payload generators ───────────────────────────────────────────────────

/**
 * Generate a realistic GitHub pull_request opened webhook payload.
 * Each VU iteration gets a unique commit SHA so dedup logic in the
 * webhook Lambda cannot short-circuit on a repeated event.
 */
function makePullRequestPayload(vu, iteration) {
  // Deterministic but unique commit SHA per (vu, iteration)
  const shaInput   = `vu-${vu}-iter-${iteration}-${Date.now()}`;
  const commitSha  = crypto.sha256(shaInput, 'hex').slice(0, 40);
  const prNumber   = (vu * 10000) + iteration;
  const repoOwner  = 'example-org';
  const repoName   = `repo-${(vu % 10) + 1}`;
  const cloneUrl   = `https://github.com/${repoOwner}/${repoName}.git`;
  const repoFullName = `${repoOwner}/${repoName}`;

  const payload = {
    action: 'opened',
    number: prNumber,
    pull_request: {
      id: prNumber,
      number: prNumber,
      title: `feat: load-test PR ${prNumber}`,
      state: 'open',
      head: {
        sha: commitSha,
        ref: `feature/load-test-${prNumber}`,
        repo: {
          id: vu + 1000,
          name: repoName,
          full_name: repoFullName,
          clone_url: cloneUrl,
          private: false,
        },
      },
      base: {
        sha: 'base000000000000000000000000000000000000'.slice(0, 40),
        ref: 'main',
        repo: {
          id: vu + 1000,
          name: repoName,
          full_name: repoFullName,
          clone_url: cloneUrl,
          private: false,
        },
      },
      user: {
        login: `ci-bot-${vu}`,
        type: 'User',
      },
      body: 'Automated load test pull request',
      draft: false,
    },
    repository: {
      id: vu + 1000,
      name: repoName,
      full_name: repoFullName,
      clone_url: cloneUrl,
      private: false,
      default_branch: 'main',
    },
    sender: {
      login: `ci-bot-${vu}`,
      type: 'User',
    },
    installation: {
      id: 12345,
    },
  };

  return JSON.stringify(payload);
}

/**
 * Generate a push (non-tag) payload that the webhook Lambda should IGNORE
 * (returns 200, not 202).  Used to exercise the "ignored event" code path.
 */
function makePushPayload(vu, iteration) {
  const sha = crypto.sha256(`push-${vu}-${iteration}`, 'hex').slice(0, 40);
  const payload = {
    ref: 'refs/heads/main',   // NOT a tag — should be ignored
    before: '0'.repeat(40),
    after: sha,
    repository: {
      id: vu + 2000,
      name: `repo-${vu}`,
      full_name: `example-org/repo-${vu}`,
      clone_url: `https://github.com/example-org/repo-${vu}.git`,
    },
    sender: { login: 'ci-bot', type: 'User' },
  };
  return JSON.stringify(payload);
}

// ─── HMAC-SHA256 signature ────────────────────────────────────────────────

/**
 * Compute the GitHub-style HMAC-SHA256 signature for a payload.
 * Returns the value to pass as X-Hub-Signature-256 header.
 */
function githubSignature(body) {
  const mac = crypto.hmac('sha256', GITHUB_SECRET, body, 'hex');
  return `sha256=${mac}`;
}

/**
 * Return a deliberately wrong signature to test the 401 path.
 */
function badSignature() {
  return 'sha256=' + '0'.repeat(64);
}

// ─── Main VU function ─────────────────────────────────────────────────────

export default function () {
  const vu        = __VU;
  const iter      = __ITER;

  // Decide which scenario this iteration exercises:
  //   70% — PR opened (should get 202)
  //   20% — push to branch (should get 200 — ignored)
  //   10% — bad signature (should get 401)
  const scenario = Math.random();

  let body;
  let signature;
  let eventType;
  let expectedStatus;

  if (scenario < 0.70) {
    body           = makePullRequestPayload(vu, iter);
    signature      = githubSignature(body);
    eventType      = 'pull_request';
    expectedStatus = 202;
  } else if (scenario < 0.90) {
    body           = makePushPayload(vu, iter);
    signature      = githubSignature(body);
    eventType      = 'push';
    expectedStatus = 200;
  } else {
    body           = makePullRequestPayload(vu, iter);
    signature      = badSignature();   // intentionally wrong
    eventType      = 'pull_request';
    expectedStatus = 401;
  }

  const headers = {
    'Content-Type':           'application/json',
    'X-GitHub-Event':         eventType,
    'X-Hub-Signature-256':    signature,
    'X-GitHub-Delivery':      `${vu}-${iter}-${Date.now()}`,
    'User-Agent':             'GitHub-Hookshot/k6-load-test',
  };

  const res = http.post(WEBHOOK_URL, body, { headers, timeout: '10s' });

  // Track latency for our custom trend
  p95Latency.add(res.timings.duration);

  // ── Assertions ──────────────────────────────────────────────────────────

  const ok = check(res, {
    'status is 202, 200, or 401': (r) =>
      r.status === 202 || r.status === 200 || r.status === 401,

    'response time p95 < 2000ms': (r) =>
      r.timings.duration < 2000,

    'response body is JSON': (r) => {
      try { JSON.parse(r.body); return true; } catch { return false; }
    },
  });

  // ── Counter breakdown ───────────────────────────────────────────────────

  if (res.status === 202) {
    accepted.add(1);

    // For 202 responses, verify the body contains a jobId
    check(res, {
      '202 response contains jobId': (r) => {
        try {
          const parsed = JSON.parse(r.body);
          return typeof parsed.jobId === 'string' && parsed.jobId.length > 0;
        } catch {
          return false;
        }
      },
    });

  } else if (res.status === 200) {
    duplicate.add(1);

    // For 200 responses, verify the body contains a message
    check(res, {
      '200 response contains message': (r) => {
        try {
          const parsed = JSON.parse(r.body);
          return typeof parsed.message === 'string';
        } catch {
          return false;
        }
      },
    });

  } else if (res.status === 401) {
    unauthorized.add(1);

    check(res, {
      '401 response contains error field': (r) => {
        try {
          const parsed = JSON.parse(r.body);
          return typeof parsed.error === 'string';
        } catch {
          return false;
        }
      },
    });

  } else {
    // Unexpected status — 4xx/5xx other than 401, or network error
    otherErrors.add(1);
    errorRate.add(1);
    console.error(
      `Unexpected status ${res.status} for VU=${vu} iter=${iter}: ${res.body.slice(0, 200)}`
    );
    return; // don't count as a normal success
  }

  // Non-401 scenarios that errored due to unexpected server status
  if (!ok && res.status !== 401) {
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }

  // Small think time between requests per VU to model realistic pacing.
  // With 50 VUs and ~350 ms average latency + 0 sleep the throughput is
  // ~50 / 0.35 ≈ 143 req/s, which is well above the 50 req/s target.
  // A short sleep brings it closer to 50 req/s:
  //   50 VUs / (latency + sleep) = 50 req/s → sleep ≈ latency × 0 (no sleep needed
  //   if average latency already limits to ~50 req/s at 50 VUs).
  //
  // No sleep here — let the Lambda's own latency naturally pace requests.
  // Adjust if the endpoint proves too fast and you need exactly 50 rps.
}

// ─── Summary handler (printed after the run) ──────────────────────────────

export function handleSummary(data) {
  const dur     = data.metrics['http_req_duration'];
  const p95     = dur?.values?.['p(95)'] ?? 'N/A';
  const avg     = dur?.values?.['avg'] ?? 'N/A';
  const maxLat  = dur?.values?.['max'] ?? 'N/A';
  const reqs    = data.metrics['http_reqs']?.values?.count ?? 0;
  const errRt   = data.metrics['webhook_error_rate']?.values?.rate ?? 0;

  const acc     = data.metrics['webhook_accepted_202']?.values?.count ?? 0;
  const dup     = data.metrics['webhook_duplicate_200']?.values?.count ?? 0;
  const unauth  = data.metrics['webhook_unauthorized_401']?.values?.count ?? 0;
  const other   = data.metrics['webhook_other_errors']?.values?.count ?? 0;

  const summary = `
==========================================================
  k6 Webhook Load Test Summary
==========================================================
  Total requests  : ${reqs}
  Error rate      : ${(errRt * 100).toFixed(2)}%  (threshold: < 1%)

  Latency
    avg           : ${typeof avg === 'number' ? avg.toFixed(0) : avg} ms
    p95           : ${typeof p95 === 'number' ? p95.toFixed(0) : p95} ms  (threshold: < 2 000 ms)
    max           : ${typeof maxLat === 'number' ? maxLat.toFixed(0) : maxLat} ms

  Response code breakdown
    202 (accepted)  : ${acc}
    200 (ignored)   : ${dup}
    401 (bad sig)   : ${unauth}
    other (errors)  : ${other}
==========================================================
`;

  return {
    stdout: summary,
  };
}
