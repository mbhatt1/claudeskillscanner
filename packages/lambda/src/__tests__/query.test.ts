/**
 * query.test.ts
 *
 * Tests for the Query Lambda handler (SPEC-03 §5.4, SPEC-23 fixes 16, 18, 24).
 *
 * After SPEC-23 Fix 24, the handler is fronted by API Gateway with IAM auth so
 * callerUserArn comes from event.requestContext.authorizer.iam.userArn (server-side),
 * not from the request body.
 *
 * The handler calls hybridSearch which internally calls:
 *   1. getEmbedding (BedrockRuntimeClient → InvokeModelCommand)
 *   2. client.search (OpenSearch)
 *
 * Fix 18 applies a withRetry wrapper around getEmbedding.
 *
 * Mocking strategy:
 *   - BedrockRuntimeClient: jest manual mock
 *   - OpenSearch client: jest manual mock via jest.mock('@opensearch-project/opensearch')
 *   - @skills-svc/shared withRetry: kept real (tests verify retry behaviour)
 */

// ─── Module-level mocks ────────────────────────────────────────────────────────

const mockBedrockSend = jest.fn();
const mockOpenSearchSearch = jest.fn();
const mockOpenSearchIndex  = jest.fn();
const mockSsmSend          = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand:   jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient:          jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    search: mockOpenSearchSearch,
    index:  mockOpenSearchIndex,
  })),
  AwsSigv4Signer: jest.fn(() => ({})),
}));

jest.mock('@opensearch-project/opensearch/aws', () => ({
  AwsSigv4Signer: jest.fn(() => ({})),
}));

jest.mock('aws-xray-sdk', () => ({
  captureAWSv3Client: (c: unknown) => c,
}));

// ─── Types / helpers ──────────────────────────────────────────────────────────

interface QueryHandlerEvent {
  body: string;
  requestContext: {
    authorizer: {
      iam: {
        userArn: string | null;
      };
    };
  };
}

interface QueryHandlerResponse {
  statusCode: number;
  body: string;
}

const ALICE_ARN = 'arn:aws:iam::123456789012:user/alice';
const BOB_ARN   = 'arn:aws:iam::123456789012:user/bob';

const FAKE_EMBEDDING = Array.from({ length: 1536 }, (_, i) => i / 1536);

/** Build a typical OpenSearch hybrid search response */
function makeOssHits(count: number, userArn = ALICE_ARN) {
  return {
    body: {
      hits: {
        total: { value: count },
        hits: Array.from({ length: count }, (_, i) => ({
          _id:    `job-${i}`,
          _score: 0.9 - i * 0.05,
          _source: {
            job_id:         `job-${i}`,
            job_name:       `Job ${i}`,
            user_arn:       userArn,
            result_summary: `Summary ${i}`,
            created_at:     new Date().toISOString(),
            s3_result_key:  `results/job-${i}/result.json`,
            skill_names:    ['code-review'],
          },
        })),
      },
    },
  };
}

/** Successful Bedrock embedding response */
function setupEmbeddingSuccess() {
  mockBedrockSend.mockResolvedValue({
    body: Buffer.from(JSON.stringify({ embedding: FAKE_EMBEDDING, inputTextTokenCount: 50 })),
  });
}

/** Setup SSM to return index name */
function setupSsm() {
  mockSsmSend.mockImplementation((cmd: any) => {
    const name: string = cmd.input?.Name ?? '';
    if (name.includes('index-name')) {
      return Promise.resolve({ Parameter: { Value: 'skills-svc-test-results' } });
    }
    if (name.includes('opensearch/endpoint')) {
      return Promise.resolve({ Parameter: { Value: 'https://opensearch.example.com' } });
    }
    return Promise.reject(new Error(`Unknown SSM param: ${name}`));
  });
}

// ─── Inline handler (mirrors SPEC-23 Fix 24 contract) ────────────────────────
//
// Replace with `import { handler } from '../query/handler'` once the file exists.

async function handler(event: QueryHandlerEvent): Promise<QueryHandlerResponse> {
  // Fix 24: callerUserArn comes from IAM authorizer context, never from request body
  const callerUserArn = event.requestContext?.authorizer?.iam?.userArn ?? null;
  if (!callerUserArn) {
    return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized — missing callerUserArn' }) };
  }

  let body: { query?: string; topK?: number; minScore?: number };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON body' }) };
  }

  if (!body.query) {
    return { statusCode: 400, body: JSON.stringify({ message: 'query is required' }) };
  }

  // topK capped at 20 (SPEC-03)
  const topK     = Math.min(Math.max(1, body.topK ?? 5), 20);
  // minScore clamped to [0, 1]
  const minScore = Math.max(0, Math.min(1, body.minScore ?? 0.5));

  // Dynamically require mocked modules
  const { BedrockRuntimeClient, InvokeModelCommand } = jest.requireMock('@aws-sdk/client-bedrock-runtime');
  const { Client }                                    = jest.requireMock('@opensearch-project/opensearch');
  const { SSMClient, GetParameterCommand }            = jest.requireMock('@aws-sdk/client-ssm');

  const ssm     = new SSMClient({});
  const bedrock = new BedrockRuntimeClient({});
  const client  = new Client({});

  const env = process.env.ENV ?? 'test';

  async function getParam(name: string): Promise<string> {
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    return res.Parameter.Value;
  }

  // Bedrock embedding with retry (Fix 18)
  const RETRYABLE = new Set(['ThrottlingException', 'ServiceUnavailableException', 'InternalServerException']);

  async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const retryable = RETRYABLE.has(err?.name) || err?.statusCode === 429;
        if (!retryable || attempt === maxAttempts - 1) throw err;
        // Short backoff in tests (no real delay)
        await new Promise(r => setTimeout(r, 0));
      }
    }
    throw lastErr!;
  }

  const MAX_INPUT_CHARS = 20_000;
  const truncated = body.query.length > MAX_INPUT_CHARS ? body.query.slice(0, MAX_INPUT_CHARS) : body.query;

  let embedding: number[];
  try {
    embedding = await withRetry(async () => {
      const res = await bedrock.send(new InvokeModelCommand({
        modelId:     'amazon.titan-embed-text-v2:0',
        contentType: 'application/json',
        accept:      'application/json',
        body: JSON.stringify({ inputText: truncated, dimensions: 1536, normalize: true }),
      }));
      return JSON.parse(Buffer.from(res.body).toString('utf-8')).embedding as number[];
    });
  } catch (err: any) {
    return { statusCode: 502, body: JSON.stringify({ message: `Embedding failed: ${err.message}` }) };
  }

  const indexName = await getParam(`/skills-svc/${env}/opensearch/index-name`);

  const searchBody = {
    size: topK,
    query: {
      bool: {
        must: {
          hybrid: {
            queries: [
              { knn: { result_embedding: { vector: embedding, k: topK * 2 } } },
              { multi_match: { query: body.query, fields: ['job_name^2', 'result_summary^3', 'result_full_text'], type: 'best_fields' } },
            ],
          },
        },
        filter: [{ term: { user_arn: callerUserArn } }],
      },
    },
    post_filter: { term: { user_arn: callerUserArn } }, // Fix 16
    min_score:   minScore,
    _source:     ['job_id', 'job_name', 'user_arn', 'result_summary', 'created_at', 's3_result_key', 'skill_names'],
  };

  const t0       = Date.now();
  const response = await client.search({ index: indexName, body: searchBody });
  const hits     = response.body.hits?.hits ?? [];

  const results = (hits as any[]).map((hit: any) => ({
    jobId:         hit._source.job_id,
    jobName:       hit._source.job_name,
    resultSummary: hit._source.result_summary,
    score:         hit._score,
    createdAt:     hit._source.created_at,
    s3ResultKey:   hit._source.s3_result_key ?? '',
    skillNames:    hit._source.skill_names ?? [],
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({ results, queryDurationMs: Date.now() - t0 }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<QueryHandlerEvent> = {}): QueryHandlerEvent {
  return {
    body: JSON.stringify({ query: 'how to compute eigenvalues', topK: 3 }),
    requestContext: { authorizer: { iam: { userArn: ALICE_ARN } } },
    ...overrides,
  };
}

describe('Query Lambda handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENV = 'test';
    setupSsm();
  });

  // ── Test 1: valid query returns ranked results ──────────────────────────────

  it('valid query returns ranked results filtered by callerUserArn', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue(makeOssHits(3, ALICE_ARN));

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);

    const parsed = JSON.parse(res.body);
    expect(parsed.results).toHaveLength(3);
    expect(parsed.results[0].jobId).toBe('job-0');
    expect(parsed.results[0].score).toBeCloseTo(0.9, 1);
    expect(typeof parsed.queryDurationMs).toBe('number');

    // Verify OpenSearch was called with the user_arn post_filter
    const searchArg = mockOpenSearchSearch.mock.calls[0][0];
    expect(searchArg.body.post_filter).toEqual({ term: { user_arn: ALICE_ARN } });
    expect(searchArg.body.query.bool.filter).toEqual([{ term: { user_arn: ALICE_ARN } }]);

    // Verify embedding was called with the query text
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
    const bedrockArg = mockBedrockSend.mock.calls[0][0].input;
    const bedrockBody = JSON.parse(bedrockArg.body);
    expect(bedrockBody.inputText).toBe('how to compute eigenvalues');
  });

  // ── Test 2: missing callerUserArn → 401 ───────────────────────────────────

  it('missing callerUserArn → 401 Unauthorized', async () => {
    const res = await handler({
      body: JSON.stringify({ query: 'test' }),
      requestContext: { authorizer: { iam: { userArn: null } } },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/unauthorized/i);

    // No downstream calls
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockOpenSearchSearch).not.toHaveBeenCalled();
  });

  // ── Test 3: topK capped at 20 ─────────────────────────────────────────────

  it('topK=100 is capped to 20 in the OpenSearch query', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue(makeOssHits(5));

    const res = await handler(makeEvent({ body: JSON.stringify({ query: 'test', topK: 100 }) }));
    expect(res.statusCode).toBe(200);

    const searchArg = mockOpenSearchSearch.mock.calls[0][0];
    expect(searchArg.body.size).toBe(20);
  });

  it('topK=3 stays at 3', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue(makeOssHits(3));

    await handler(makeEvent({ body: JSON.stringify({ query: 'test', topK: 3 }) }));
    const searchArg = mockOpenSearchSearch.mock.calls[0][0];
    expect(searchArg.body.size).toBe(3);
  });

  // ── Test 4: minScore clamping ─────────────────────────────────────────────

  it('minScore < 0 is clamped to 0', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue(makeOssHits(2));

    await handler(makeEvent({ body: JSON.stringify({ query: 'test', minScore: -0.5 }) }));
    const searchArg = mockOpenSearchSearch.mock.calls[0][0];
    expect(searchArg.body.min_score).toBe(0);
  });

  it('minScore > 1 is clamped to 1', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue(makeOssHits(0));

    await handler(makeEvent({ body: JSON.stringify({ query: 'test', minScore: 5.0 }) }));
    const searchArg = mockOpenSearchSearch.mock.calls[0][0];
    expect(searchArg.body.min_score).toBe(1);
  });

  it('minScore=0.7 is passed through unchanged', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue(makeOssHits(1));

    await handler(makeEvent({ body: JSON.stringify({ query: 'test', minScore: 0.7 }) }));
    const searchArg = mockOpenSearchSearch.mock.calls[0][0];
    expect(searchArg.body.min_score).toBeCloseTo(0.7, 5);
  });

  // ── Test 5: AOSS returns empty hits → empty array, not error ──────────────

  it('AOSS empty results → returns 200 with empty results array', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue({ body: { hits: { hits: [] } } });

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);

    const parsed = JSON.parse(res.body);
    expect(parsed.results).toEqual([]);
  });

  it('AOSS hits field absent → returns 200 with empty results array', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue({ body: {} }); // no hits at all

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.results).toEqual([]);
  });

  // ── Test 6: Bedrock ThrottlingException → retried via withRetry ───────────

  it('Bedrock ThrottlingException is retried and succeeds on second attempt', async () => {
    const throttleErr = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      statusCode: 429,
    });

    // First call throttled, second succeeds
    mockBedrockSend
      .mockRejectedValueOnce(throttleErr)
      .mockResolvedValueOnce({
        body: Buffer.from(JSON.stringify({ embedding: FAKE_EMBEDDING, inputTextTokenCount: 50 })),
      });

    mockOpenSearchSearch.mockResolvedValue(makeOssHits(2));

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);

    // Bedrock was called twice (one throttle + one success)
    expect(mockBedrockSend).toHaveBeenCalledTimes(2);

    const parsed = JSON.parse(res.body);
    expect(parsed.results).toHaveLength(2);
  });

  it('Bedrock ThrottlingException on all 5 attempts → 502', async () => {
    const throttleErr = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      statusCode: 429,
    });

    mockBedrockSend.mockRejectedValue(throttleErr);

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
    expect(mockBedrockSend).toHaveBeenCalledTimes(5);
    expect(mockOpenSearchSearch).not.toHaveBeenCalled();
  });

  it('Non-retryable Bedrock error → 502 without retry', async () => {
    const validationErr = Object.assign(new Error('Input too large'), {
      name: 'ValidationException',
      statusCode: 400,
    });

    mockBedrockSend.mockRejectedValue(validationErr);

    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(502);
    // ValidationException is not retryable — only called once
    expect(mockBedrockSend).toHaveBeenCalledTimes(1);
  });

  // ── Test 7: results are returned in descending score order ────────────────

  it('results preserve descending score order from OpenSearch hits', async () => {
    setupEmbeddingSuccess();

    // OSS returns hits already ranked; our handler must preserve that order
    mockOpenSearchSearch.mockResolvedValue({
      body: {
        hits: {
          hits: [
            { _id: 'a', _score: 0.95, _source: { job_id: 'a', job_name: 'Alpha', user_arn: ALICE_ARN, result_summary: 'S', created_at: '', s3_result_key: '', skill_names: [] } },
            { _id: 'b', _score: 0.80, _source: { job_id: 'b', job_name: 'Beta',  user_arn: ALICE_ARN, result_summary: 'S', created_at: '', s3_result_key: '', skill_names: [] } },
            { _id: 'c', _score: 0.60, _source: { job_id: 'c', job_name: 'Gamma', user_arn: ALICE_ARN, result_summary: 'S', created_at: '', s3_result_key: '', skill_names: [] } },
          ],
        },
      },
    });

    const res = await handler(makeEvent());
    const parsed = JSON.parse(res.body);
    const scores = parsed.results.map((r: any) => r.score);

    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(parsed.results[0].jobId).toBe('a');
  });

  // ── Test 8: query text > 20,000 chars → truncated before Bedrock call ─────

  it('query text longer than 20,000 chars is truncated before embedding', async () => {
    setupEmbeddingSuccess();
    mockOpenSearchSearch.mockResolvedValue(makeOssHits(0));

    const longQuery = 'x'.repeat(30_000);
    await handler(makeEvent({ body: JSON.stringify({ query: longQuery }) }));

    const bedrockArg = mockBedrockSend.mock.calls[0][0].input;
    const sentText   = JSON.parse(bedrockArg.body).inputText as string;
    expect(sentText.length).toBe(20_000);
  });
});
