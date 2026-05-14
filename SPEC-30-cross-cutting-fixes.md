# SPEC-30 — Remaining Cross-Cutting Fixes: Knowledge Store, Encryption Context, Query Handler

**Supersedes:** SPEC-03 (searcher.ts, indexer.ts), SPEC-02 (ingestion handler mcp-job-id section), SPEC-06 (crypto.ts) on the topics covered here.  
**Does NOT supersede:** SPEC-29 (MCP server rewrite — that remains authoritative for all MCP Lambda code).  
**Status:** AUTHORITATIVE for the five files defined below.  
**Version:** 1.0.0

---

## What This Spec Covers

SPEC-29 explicitly marked Fix 12 (searcher.ts `hybrid→bool.should`) as "out-of-scope — tracked in SPEC-24 Fix 2; searcher.ts is outside MCP Lambda scope." This spec closes that gap plus four other fixes that were identified in SPEC-23/24 as "not applied to source" and are not addressed by SPEC-29:

| # | Source Audit Fix | File | Issue |
|---|-----------------|------|-------|
| A | SPEC-24 Fix 2 / SPEC-28 Fix 12 | `packages/knowledge-store/src/searcher.ts` | `hybrid` query type → AOSS 400; replace with `bool.should`; add `post_filter`, `from`/`total`/`hasMore` pagination |
| B | SPEC-24 Fix 3 | `packages/lambda/src/query/handler.ts` | Lambda handler needs full API Gateway HTTP API shape reading `callerUserArn` from `requestContext.authorizer.iam.userArn` |
| C | SPEC-23 Fix 15 | `packages/knowledge-store/src/indexer.ts` | `user_arn` and `s3_result_key` never written to the OpenSearch document body |
| D | SPEC-23 Fix 14 | `packages/ecs-runner/src/uploader.ts` + `packages/lambda/src/results-processor/handler.ts` + `packages/shared/src/crypto.ts` | `userArn` missing from envelope encryption context — cross-tenant decryption possible |
| E | SPEC-28 Fix 6 / SPEC-24 Fix 26 | `packages/lambda/src/ingestion/handler.ts` | `mcp-job-id` S3 metadata must be honoured as the `jobId`; `isValidUUID` guard required |

All five areas must be deployed atomically (see "Deployment Order" at the end).

---

## Fix A — `packages/knowledge-store/src/searcher.ts`

**Root cause:** AOSS does not support the `hybrid` query type unless a configured search pipeline is deployed. No pipeline is deployed in this stack. Every `query_knowledge_store` call returned AOSS HTTP 400. `post_filter` was absent, so even if the query succeeded it would not enforce the per-user filter after kNN scoring. Pagination fields `from`, `total`, and `hasMore` were missing from both the request and response paths.

**Complete replacement:**

```typescript
// packages/knowledge-store/src/searcher.ts
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { QueryRequest, QueryResponse, SearchResult } from '@skills-svc/shared';

const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const INDEX_NAME     = process.env.OPENSEARCH_INDEX ?? 'skills-results';
const AOSS_ENDPOINT  = process.env.AOSS_ENDPOINT!;
const REGION         = process.env.REGION ?? 'us-east-1';

const bedrock = new BedrockRuntimeClient({ region: REGION });

function buildOSSClient(): Client {
  return new Client({
    ...AwsSigv4Signer({
      region:              REGION,
      service:             'aoss',
      getCredentials:      () => defaultProvider()(),
    }),
    node: AOSS_ENDPOINT,
  });
}

// Singleton — re-used across warm invocations
let _client: Client | undefined;
function getClient(): Client {
  if (!_client) _client = buildOSSClient();
  return _client;
}

async function embedQuery(text: string): Promise<number[]> {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId:     EMBED_MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body:        Buffer.from(JSON.stringify({ inputText: text })),
  }));
  const parsed = JSON.parse(Buffer.from(res.body).toString('utf-8'));
  const embedding: number[] = parsed.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Bedrock embedding returned empty vector');
  }
  return embedding;
}

export async function search(req: QueryRequest): Promise<QueryResponse> {
  const {
    query,
    callerUserArn,
    topK     = 5,
    minScore = 0.5,
    from     = 0,
  } = req;

  const startMs = Date.now();

  // Embed the natural language query using Titan Embed v2
  const embedding = await embedQuery(query);

  const client = getClient();

  // Fix A: Replace `hybrid` (unsupported in AOSS without a search pipeline) with
  // `bool.should` combining kNN vector search and multi_match BM25 text search.
  //
  // The `post_filter` clause enforces the per-user filter AFTER kNN scoring so that
  // relevance scores are computed across all documents but only the caller's documents
  // are returned. Without post_filter, putting the user_arn filter inside the bool
  // would cause kNN to score only within the user's documents — less accurate for
  // small corpora.
  //
  // `track_total_hits: true` returns the exact count of documents matching the query
  // (after post_filter) so callers can build `hasMore` pagination correctly.
  const body = {
    size: topK,
    from,
    query: {
      bool: {
        should: [
          // Semantic: kNN over the result_embedding vector field (Titan Embed v2 dimensions)
          {
            knn: {
              result_embedding: {
                vector: embedding,
                k:      topK * 2,   // over-fetch so post_filter has enough candidates
              },
            },
          },
          // Lexical: BM25 multi-field text search with field-level boosts
          {
            multi_match: {
              query,
              fields: [
                'job_name^2',
                'result_summary^3',
                'result_full_text^1',
                'skill_names^1.5',
              ],
              type:      'best_fields',
              fuzziness: 'AUTO',
            },
          },
        ],
        // Include the user filter inside the bool so it participates in score computation
        // for BM25; it is also repeated in post_filter as a hard gate after kNN scoring.
        filter: [
          { term: { user_arn: callerUserArn } },
        ],
        minimum_should_match: 1,
      },
    },
    // Fix A: post_filter enforces per-user tenancy AFTER kNN scoring.
    // This is the correct pattern for hybrid kNN + filter in AOSS — the kNN stage
    // ignores the bool filter, so post_filter acts as the final ownership gate.
    post_filter: {
      term: { user_arn: callerUserArn },
    },
    min_score: minScore,
    track_total_hits: true,
    _source: [
      'job_id',
      'job_name',
      'user_arn',
      's3_result_key',
      'result_summary',
      'created_at',
      'skill_names',
    ],
  };

  const response = await client.search({ index: INDEX_NAME, body });
  const hits     = response.body.hits;

  // total may be an object `{ value: N, relation: 'eq' }` or a plain number
  const totalHits: number =
    typeof hits.total === 'number'
      ? hits.total
      : (hits.total as { value: number }).value ?? 0;

  const results: SearchResult[] = (hits.hits as Array<{
    _id: string;
    _score: number;
    _source: Record<string, unknown>;
  }>).map(hit => ({
    jobId:         hit._source.job_id        as string,
    jobName:       hit._source.job_name      as string,
    userArn:       hit._source.user_arn      as string,
    s3ResultKey:   hit._source.s3_result_key as string | undefined,
    resultSummary: hit._source.result_summary as string,
    createdAt:     hit._source.created_at    as string,
    skillNames:    (hit._source.skill_names  as string[] | undefined) ?? [],
    score:         hit._score,
  }));

  const queryDurationMs = Date.now() - startMs;
  const returnedCount   = from + results.length;
  const hasMore         = returnedCount < totalHits;

  return {
    results,
    queryDurationMs,
    total:   totalHits,
    from,
    hasMore,
  };
}
```

**Companion `SearchResult` type update in `packages/shared/src/types.ts`** (add `s3ResultKey` if not already present):

```typescript
export interface SearchResult {
  jobId:         string;
  jobName:       string;
  userArn:       string;
  s3ResultKey?:  string;    // Fix C: written by indexer (see Fix C below)
  resultSummary: string;
  createdAt:     string;
  skillNames:    string[];
  score:         number;
}

export interface QueryRequest {
  query:         string;
  callerUserArn: string;
  topK?:         number;
  minScore?:     number;
  from?:         number;    // Fix A: pagination offset
}

export interface QueryResponse {
  results:         SearchResult[];
  queryDurationMs: number;
  total?:          number;   // Fix A: total hits matching the query (for hasMore)
  hasMore?:        boolean;  // Fix A
  from?:           number;   // Fix A: echo of the request offset
}
```

---

## Fix B — `packages/lambda/src/query/handler.ts`

**Root cause:** The query Lambda handler was written as a bare async function that accepted `QueryRequest` directly (suitable for direct Lambda invocation) but SPEC-24 Fix 3 requires it to also handle API Gateway HTTP API invocations. The MCP `query_knowledge_store` tool invokes it via `LambdaClient.InvokeCommand` (direct Lambda invocation), which means the bare-function path must remain. However, the handler must also accept API Gateway HTTP API events reading `callerUserArn` from `requestContext.authorizer.iam.userArn` for direct HTTP API usage. Both invocation paths must be supported.

**Complete replacement:**

```typescript
// packages/lambda/src/query/handler.ts
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { search } from '@skills-svc/knowledge-store/searcher';
import { QueryRequest, QueryResponse } from '@skills-svc/shared';

/**
 * Dual-mode Lambda handler for the Query function.
 *
 * Mode 1 — Direct Lambda invocation (used by MCP query tool via InvokeCommand):
 *   The event IS the QueryRequest payload. Detected by absence of `requestContext`.
 *
 * Mode 2 — API Gateway HTTP API invocation (IAM auth):
 *   The event is an APIGatewayProxyEventV2. `callerUserArn` is read from
 *   `requestContext.authorizer.iam.userArn`. The query body is JSON-parsed from
 *   `event.body`.
 *
 * Fix B: The previous implementation only supported Mode 1. The API Gateway path
 * was never wired, so direct HTTP calls returned 500 or processed the raw APIGW
 * event as a QueryRequest (callerUserArn would be undefined → AOSS returned no results).
 */
export const handler = async (
  event: QueryRequest | APIGatewayProxyEventV2
): Promise<QueryResponse | APIGatewayProxyResultV2> => {

  // Detect whether this is an API Gateway HTTP API invocation.
  // APIGatewayProxyEventV2 always has a `requestContext` with `http.method`.
  if (isApiGatewayEvent(event)) {
    return handleApiGateway(event);
  }

  // Mode 1: direct Lambda invocation — event IS the QueryRequest
  return handleDirect(event as QueryRequest);
};

// ── Type guard ────────────────────────────────────────────────────────────────

function isApiGatewayEvent(event: unknown): event is APIGatewayProxyEventV2 {
  return (
    typeof event === 'object' &&
    event !== null &&
    'requestContext' in event &&
    typeof (event as Record<string, unknown>).requestContext === 'object'
  );
}

// ── Mode 1: Direct Lambda invocation ─────────────────────────────────────────

async function handleDirect(req: QueryRequest): Promise<QueryResponse> {
  validateQueryRequest(req);
  return search(req);
}

// ── Mode 2: API Gateway HTTP API (IAM auth) ───────────────────────────────────

async function handleApiGateway(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {

  // Fix B: read the IAM-authenticated caller ARN from the API Gateway authorizer context.
  // For HttpIamAuthorizer this is requestContext.authorizer.iam.userArn.
  // For HttpLambdaAuthorizer (SPEC-29 Fix 2) it would be requestContext.authorizer.lambda.callerUserArn.
  // We support both so the query Lambda works regardless of which authorizer is in front.
  const iam = (event.requestContext as Record<string, unknown>)?.authorizer as
    Record<string, unknown> | undefined;

  const callerUserArn =
    (iam?.iam as Record<string, string> | undefined)?.userArn ??
    (iam?.lambda as Record<string, string> | undefined)?.callerUserArn;

  if (!callerUserArn) {
    return jsonResponse(401, {
      error: 'Unauthorized',
      message: 'Could not determine caller identity from request context',
    });
  }

  // Parse body
  let body: Partial<QueryRequest>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Bad Request', message: 'Invalid JSON body' });
  }

  const req: QueryRequest = {
    query:         body.query ?? '',
    callerUserArn,                   // Fix B: always sourced from authorizer context, not body
    topK:          body.topK,
    minScore:      body.minScore,
    from:          body.from,
  };

  try {
    validateQueryRequest(req);
  } catch (err) {
    return jsonResponse(400, {
      error: 'Bad Request',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const result = await search(req);
    return jsonResponse(200, result);
  } catch (err) {
    console.error(JSON.stringify({
      event:  'query_error',
      caller: callerUserArn,
      err:    String(err),
    }));
    return jsonResponse(500, { error: 'Internal Server Error' });
  }
}

// ── Shared validation ─────────────────────────────────────────────────────────

function validateQueryRequest(req: QueryRequest): void {
  if (!req.query || typeof req.query !== 'string' || req.query.trim().length === 0) {
    throw new Error('query must be a non-empty string');
  }
  if (!req.callerUserArn || typeof req.callerUserArn !== 'string') {
    throw new Error('callerUserArn must be a non-empty string');
  }
  if (req.topK !== undefined && (typeof req.topK !== 'number' || req.topK < 1 || req.topK > 50)) {
    throw new Error('topK must be a number between 1 and 50');
  }
  if (req.minScore !== undefined && (typeof req.minScore !== 'number' || req.minScore < 0 || req.minScore > 1)) {
    throw new Error('minScore must be a number between 0 and 1');
  }
  if (req.from !== undefined && (typeof req.from !== 'number' || req.from < 0)) {
    throw new Error('from must be a non-negative number');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(
  statusCode: number,
  body: unknown
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
```

---

## Fix C — `packages/knowledge-store/src/indexer.ts`

**Root cause (SPEC-23 Fix 15):** The OpenSearch document body written by the indexer did not include `user_arn` or `s3_result_key`. The `post_filter` and `filter` in the searcher (Fix A) operate on `user_arn`; if that field is absent the filter returns zero results for every query. The `s3_result_key` field enables the `get_result` tool to surface the S3 key directly from the search result without a DynamoDB roundtrip.

**Updated `RunResult` type** (add to `packages/shared/src/types.ts`):

```typescript
export interface RunResult {
  jobId:         string;
  jobName:       string;
  userArn:       string;       // Fix C: required — used as index key and encryption context
  s3ResultKey:   string;       // Fix C: required — written to OpenSearch for direct retrieval
  skillNames:    string[];
  resultSummary: string;
  output:        string | object;
  durationMs:    number;
  completedAt:   string;
}
```

**Complete replacement:**

```typescript
// packages/knowledge-store/src/indexer.ts
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { RunResult } from '@skills-svc/shared';

const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const INDEX_NAME     = process.env.OPENSEARCH_INDEX ?? 'skills-results';
const AOSS_ENDPOINT  = process.env.AOSS_ENDPOINT!;
const REGION         = process.env.REGION ?? 'us-east-1';

const bedrock = new BedrockRuntimeClient({ region: REGION });

function buildOSSClient(): Client {
  return new Client({
    ...AwsSigv4Signer({
      region:         REGION,
      service:        'aoss',
      getCredentials: () => defaultProvider()(),
    }),
    node: AOSS_ENDPOINT,
  });
}

let _client: Client | undefined;
function getClient(): Client {
  if (!_client) _client = buildOSSClient();
  return _client;
}

async function embed(text: string): Promise<number[]> {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId:     EMBED_MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body:        Buffer.from(JSON.stringify({ inputText: text })),
  }));
  const parsed = JSON.parse(Buffer.from(res.body).toString('utf-8'));
  const embedding: number[] = parsed.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Bedrock embed returned empty vector');
  }
  return embedding;
}

/**
 * Build the text that will be embedded for semantic search.
 * The concatenation of jobName, summary, and skill names gives the
 * embedding enough signal to match queries like "how to classify text"
 * against a job named "NLP Skills Analysis" that produced a summary
 * about text classification.
 */
function buildEmbedText(result: RunResult): string {
  return [
    result.jobName,
    result.resultSummary,
    result.skillNames.join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 8000);  // Titan Embed v2 token limit ~8192; conservative trim
}

/**
 * Index a completed job result into OpenSearch Serverless.
 *
 * Fix C: the document body now includes `user_arn` and `s3_result_key`.
 *
 * `user_arn` is used:
 *   1. In the `bool.filter` and `post_filter` in searcher.ts for per-user tenancy.
 *   2. As a shard routing hint in future index configurations.
 *
 * `s3_result_key` is used:
 *   1. Returned in SearchResult so MCP get_result can locate the S3 object directly.
 *   2. Enables a future presigned-URL-in-search-result optimisation.
 *
 * The document ID is the `jobId` so re-indexing (on retry) is idempotent.
 */
export async function indexResult(result: RunResult): Promise<void> {
  // Validate required fields added in Fix C
  if (!result.userArn) {
    throw new Error(`indexResult: userArn is required (jobId=${result.jobId})`);
  }
  if (!result.s3ResultKey) {
    throw new Error(`indexResult: s3ResultKey is required (jobId=${result.jobId})`);
  }

  const embedText  = buildEmbedText(result);
  const embedding  = await embed(embedText);
  const client     = getClient();
  const indexedAt  = new Date().toISOString();

  // Build full text for BM25 search — trimmed to avoid AOSS document size limits
  const fullText =
    typeof result.output === 'string'
      ? result.output.slice(0, 32000)
      : JSON.stringify(result.output).slice(0, 32000);

  const doc = {
    job_id:           result.jobId,
    job_name:         result.jobName,

    // Fix C: user_arn written to document — required for per-user search filtering
    user_arn:         result.userArn,

    // Fix C: s3_result_key written to document — returned in SearchResult for direct retrieval
    s3_result_key:    result.s3ResultKey,

    skill_names:      result.skillNames,
    result_summary:   result.resultSummary,
    result_full_text: fullText,
    duration_ms:      result.durationMs,
    created_at:       result.completedAt,
    indexed_at:       indexedAt,

    // kNN vector field — dimension must match Titan Embed v2 output (1024)
    result_embedding: embedding,
  };

  await client.index({
    index:        INDEX_NAME,
    id:           result.jobId,   // idempotent re-indexing on retry
    body:         doc,
    refresh:      'wait_for',     // ensure result is visible to searcher on next invocation
  });

  console.log(JSON.stringify({
    event:      'indexed',
    jobId:      result.jobId,
    userArn:    result.userArn,
    durationMs: result.durationMs,
    indexedAt,
  }));
}
```

---

## Fix D — Envelope Encryption Context: Three Files (Atomic Deployment Required)

**Root cause (SPEC-23 Fix 14):** `envelopeEncrypt` in `uploader.ts` built the KMS encryption context without `userArn`. `envelopeDecrypt` in `results-processor/handler.ts` likewise omitted it. A caller who knew Bob's `jobId` could call `envelopeDecrypt` with their own identity and retrieve Bob's result, because KMS had no binding between the ciphertext and a specific user ARN.

These three files must be deployed atomically. Deploying the new encryptor before the new decryptor will cause all in-flight results to fail decryption (the old decryptor would pass a context without `userArn` which would not match the KMS grant). The correct deployment sequence is documented at the end of this spec.

### Fix D-1: `packages/shared/src/crypto.ts`

**Complete replacement:**

```typescript
// packages/shared/src/crypto.ts
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
} from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const kms = new KMSClient({ region: process.env.REGION ?? 'us-east-1' });

const KMS_KEY_SPEC   = 'AES_256';
const CIPHER_ALGO    = 'aes-256-gcm' as const;
const IV_BYTES       = 12;   // 96-bit IV for GCM
const AUTH_TAG_BYTES = 16;   // 128-bit auth tag for GCM
const KMS_KEY_ID     = process.env.RESULTS_KMS_KEY_ID ?? process.env.KMS_KEY_ID!;

/**
 * Fix D: `EncryptionContext` now includes `userArn` as a required field.
 *
 * KMS binds the encryption context to the ciphertext via AAD. Any decrypt
 * call that does not supply the identical context value will be rejected by KMS.
 *
 * This prevents cross-tenant decryption: a caller who knows Bob's `jobId` but
 * supplies their own `userArn` will receive a KMS AccessDeniedException.
 *
 * The `userArn` is the IAM ARN of the user who SUBMITTED the job (stored in
 * the DynamoDB job record as `job.userArn`). It is sourced from:
 *   - Encrypt path: RunResult.userArn (set by ECS runner from S3 metadata)
 *   - Decrypt path: DynamoDB job record (results-processor reads job.userArn)
 */
export interface EncryptionContext {
  jobId:       string;
  userArn:     string;   // Fix D: required — binds ciphertext to the submitting user
  purpose:     string;
  environment: string;
}

export interface EncryptedEnvelope {
  /** Base64-encoded KMS-encrypted data key */
  encryptedKey: string;
  /** Base64-encoded AES-GCM IV (12 bytes) */
  iv:           string;
  /** Base64-encoded AES-GCM ciphertext */
  ciphertext:   string;
  /** Base64-encoded AES-GCM authentication tag (16 bytes) */
  authTag:      string;
}

/**
 * Envelope-encrypt `plaintext` using a KMS-generated data key.
 *
 * Flow:
 *  1. Ask KMS to generate a data key, binding it to `context`.
 *  2. Use the plaintext data key to AES-256-GCM encrypt `plaintext`.
 *  3. Return an EncryptedEnvelope containing the encrypted data key and ciphertext.
 *     The plaintext data key is never stored — only the KMS-encrypted copy.
 *
 * Fix D: `context.userArn` is now required and included in the KMS encryption context.
 */
export async function envelopeEncrypt(
  plaintext: Buffer,
  context:   EncryptionContext
): Promise<EncryptedEnvelope> {
  if (!context.userArn) {
    throw new Error('envelopeEncrypt: context.userArn is required');
  }

  const encryptionContext = buildKmsContext(context);

  const dkRes = await kms.send(new GenerateDataKeyCommand({
    KeyId:             KMS_KEY_ID,
    KeySpec:           KMS_KEY_SPEC,
    EncryptionContext: encryptionContext,
  }));

  if (!dkRes.Plaintext || !dkRes.CiphertextBlob) {
    throw new Error('KMS GenerateDataKey returned incomplete response');
  }

  const dataKey      = Buffer.from(dkRes.Plaintext);
  const encryptedKey = Buffer.from(dkRes.CiphertextBlob);
  const iv           = randomBytes(IV_BYTES);

  const cipher  = createCipheriv(CIPHER_ALGO, dataKey, iv);
  const ct1     = cipher.update(plaintext);
  const ct2     = cipher.final();
  const authTag = cipher.getAuthTag();

  // Overwrite the plaintext data key in memory immediately after use
  dataKey.fill(0);

  return {
    encryptedKey: encryptedKey.toString('base64'),
    iv:           iv.toString('base64'),
    ciphertext:   Buffer.concat([ct1, ct2]).toString('base64'),
    authTag:      authTag.toString('base64'),
  };
}

/**
 * Envelope-decrypt an EncryptedEnvelope.
 *
 * Fix D: `context.userArn` is required and must match the value used at encrypt time.
 * KMS will return AccessDeniedException if the context does not match.
 */
export async function envelopeDecrypt(
  envelope: EncryptedEnvelope,
  context:  EncryptionContext
): Promise<Buffer> {
  if (!context.userArn) {
    throw new Error('envelopeDecrypt: context.userArn is required');
  }

  const encryptionContext = buildKmsContext(context);

  const dkRes = await kms.send(new DecryptCommand({
    CiphertextBlob:    Buffer.from(envelope.encryptedKey, 'base64'),
    EncryptionContext: encryptionContext,
  }));

  if (!dkRes.Plaintext) {
    throw new Error('KMS Decrypt returned empty plaintext');
  }

  const dataKey   = Buffer.from(dkRes.Plaintext);
  const iv        = Buffer.from(envelope.iv,         'base64');
  const authTag   = Buffer.from(envelope.authTag,    'base64');
  const encrypted = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = createDecipheriv(CIPHER_ALGO, dataKey, iv);
  decipher.setAuthTag(authTag);

  const plain1 = decipher.update(encrypted);
  const plain2 = decipher.final();

  // Overwrite the data key in memory
  dataKey.fill(0);

  return Buffer.concat([plain1, plain2]);
}

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Build the canonical KMS encryption context map from an EncryptionContext.
 * All keys and values must be strings. The shape is fixed so that encrypt
 * and decrypt always produce identical maps.
 */
function buildKmsContext(ctx: EncryptionContext): Record<string, string> {
  return {
    jobId:       ctx.jobId,
    userArn:     ctx.userArn,    // Fix D: now included
    purpose:     ctx.purpose,
    environment: ctx.environment,
  };
}
```

### Fix D-2: `packages/ecs-runner/src/uploader.ts`

**Complete replacement:**

```typescript
// packages/ecs-runner/src/uploader.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { envelopeEncrypt, EncryptedEnvelope } from '@skills-svc/shared/crypto';
import { RunResult } from '@skills-svc/shared';

const s3      = new S3Client({ region: process.env.REGION ?? 'us-east-1' });
const BUCKET  = process.env.RESULTS_BUCKET!;
const ENV     = process.env.ENV ?? 'prod';

/**
 * Encrypt and upload a RunResult to S3.
 *
 * Fix D: `envelopeEncrypt` now receives `userArn` in the encryption context.
 * The `userArn` is sourced from `result.userArn`, which the ECS runner sets
 * when it builds the RunResult from the job manifest (read from S3 metadata
 * `user-arn` written by submit_job or the CLI uploader).
 *
 * Returns the S3 key where the encrypted envelope was written. This key is
 * stored on the DynamoDB job record as `s3ResultKey` by the results processor.
 */
export async function uploadResult(result: RunResult): Promise<string> {
  // Validate that userArn is present — required for Fix D encryption context
  if (!result.userArn) {
    throw new Error(`uploadResult: result.userArn is required (jobId=${result.jobId})`);
  }

  const plaintext = Buffer.from(JSON.stringify(result), 'utf-8');

  // Fix D: include userArn in encryption context so KMS binds the ciphertext
  // to this specific user. Any decrypt without the matching userArn will fail.
  const envelope: EncryptedEnvelope = await envelopeEncrypt(plaintext, {
    jobId:       result.jobId,
    userArn:     result.userArn,   // Fix D: was missing — cross-tenant decryption was possible
    purpose:     'skills-svc-result',
    environment: ENV,
  });

  const s3Key = buildResultKey(result.jobId);

  await s3.send(new PutObjectCommand({
    Bucket:               BUCKET,
    Key:                  s3Key,
    Body:                 Buffer.from(JSON.stringify(envelope), 'utf-8'),
    ContentType:          'application/json',
    ServerSideEncryption: 'aws:kms',
    // Also tag with jobId and userArn for S3 lifecycle and audit
    Tagging:              `jobId=${result.jobId}&userArn=${encodeURIComponent(result.userArn)}`,
  }));

  console.log(JSON.stringify({
    event:      'result_uploaded',
    jobId:      result.jobId,
    userArn:    result.userArn,
    s3Key,
  }));

  return s3Key;
}

/**
 * Build the deterministic S3 result key for a job.
 * Pattern: results/{jobId}/result.json.enc
 */
export function buildResultKey(jobId: string): string {
  return `results/${jobId}/result.json.enc`;
}
```

### Fix D-3: `packages/lambda/src/results-processor/handler.ts` (relevant decrypt section)

**Complete replacement (full handler):**

```typescript
// packages/lambda/src/results-processor/handler.ts
import { S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { envelopeDecrypt, EncryptedEnvelope } from '@skills-svc/shared/crypto';
import { indexResult } from '@skills-svc/knowledge-store/indexer';
import { JobStatus, DDB_KEY_PREFIX, RunResult } from '@skills-svc/shared';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const JOBS_TABLE = process.env.DYNAMODB_TABLE_NAME!;
const ENV        = process.env.ENV ?? 'prod';

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    console.log(JSON.stringify({ event: 'processing_result', bucket, key }));

    try {
      await processResultFile(bucket, key);
    } catch (err) {
      // Log but do not rethrow — a single failed record should not block others.
      // In production, configure a DLQ on this Lambda's event source mapping.
      console.error(JSON.stringify({
        event:  'result_processing_error',
        bucket,
        key,
        err:    String(err),
      }));
    }
  }
};

async function processResultFile(bucket: string, key: string): Promise<void> {
  // Derive jobId from the S3 key pattern: results/{jobId}/result.json.enc
  const jobIdMatch = key.match(/^results\/([^/]+)\//);
  if (!jobIdMatch) {
    throw new Error(`Cannot parse jobId from S3 key: ${key}`);
  }
  const jobId = jobIdMatch[1];

  // ── 1. Fetch the DynamoDB job record ────────────────────────────────────────
  // Fix D: we read `job.userArn` from DynamoDB and pass it to envelopeDecrypt.
  // The userArn was written to the job record by the ingestion Lambda when the
  // job was created (sourced from S3 metadata `user-arn`).

  const jobRes = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
  }));

  if (!jobRes.Item) {
    throw new Error(`Job record not found in DDB for jobId=${jobId}`);
  }

  const jobUserArn = jobRes.Item.userArn as string | undefined;
  if (!jobUserArn) {
    throw new Error(
      `Job ${jobId} has no userArn in DDB — cannot reconstruct decryption context. ` +
      `Ensure the ingestion Lambda writes userArn to the job record.`
    );
  }

  // ── 2. Download the encrypted envelope from S3 ─────────────────────────────

  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const raw = Buffer.concat(chunks);

  const envelope: EncryptedEnvelope = JSON.parse(raw.toString('utf-8'));

  // ── 3. Decrypt using the full encryption context (Fix D) ───────────────────
  // Fix D: pass `userArn` from the DynamoDB record. Without this, KMS would
  // accept any decrypt call that had the correct jobId — cross-tenant access.

  const plaintext = await envelopeDecrypt(envelope, {
    jobId,
    userArn:     jobUserArn,   // Fix D: sourced from DDB, not from the requester's identity
    purpose:     'skills-svc-result',
    environment: ENV,
  });

  const result: RunResult = JSON.parse(plaintext.toString('utf-8'));

  // Backfill userArn and s3ResultKey onto the RunResult if the ECS runner
  // did not set them (defensive — they should be set by a fully-updated runner).
  if (!result.userArn)    result.userArn    = jobUserArn;
  if (!result.s3ResultKey) result.s3ResultKey = key;

  // ── 4. Index the result in OpenSearch ─────────────────────────────────────
  // Fix C: indexResult now writes user_arn and s3_result_key to the document.

  await indexResult(result);

  // ── 5. Mark job as COMPLETE in DynamoDB ────────────────────────────────────

  await ddb.send(new UpdateCommand({
    TableName:        JOBS_TABLE,
    Key:              { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    UpdateExpression: [
      'SET #s = :s',
      'updatedAt = :now',
      's3ResultKey = :key',
      'GSI1PK = :gsi',
    ].join(', '),
    ExpressionAttributeNames: {
      '#s': 'status',
    },
    ExpressionAttributeValues: {
      ':s':   JobStatus.COMPLETE,
      ':now': new Date().toISOString(),
      ':key': key,
      ':gsi': `${DDB_KEY_PREFIX.STATUS}${JobStatus.COMPLETE}`,
    },
    // Do not use a condition here — if the ECS task retried and we already
    // marked COMPLETE, a second write of the same values is idempotent.
  }));

  console.log(JSON.stringify({
    event:   'result_processed',
    jobId,
    userArn: jobUserArn,
    key,
  }));
}
```

---

## Fix E — `packages/lambda/src/ingestion/handler.ts`

**Root cause (SPEC-28 Fix 6 / SPEC-24 Fix 26):** The ingestion Lambda always called `randomUUID()` for the jobId, ignoring the `mcp-job-id` value written into S3 object metadata by `submit_job`. This meant the jobId returned to the MCP agent by `submit_job` was useless — calling `job_status` with that ID returned NOT_FOUND indefinitely. The fix reads `mcp-job-id` from S3 metadata and uses it as the jobId if and only if it is a valid v4 UUID.

The `isValidUUID` function is defined in `packages/shared/src/types.ts` (already specified in SPEC-29 Section 13). This handler imports it from there.

**Complete replacement:**

```typescript
// packages/lambda/src/ingestion/handler.ts
import { S3Event } from 'aws-lambda';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ECSClient,
  RunTaskCommand,
  LaunchType,
} from '@aws-sdk/client-ecs';
import { randomUUID } from 'crypto';
import {
  isValidUUID,
  DDB_KEY_PREFIX,
  JobStatus,
} from '@skills-svc/shared';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecs = new ECSClient({});

const JOBS_TABLE       = process.env.DYNAMODB_TABLE_NAME!;
const ECS_CLUSTER_ARN  = process.env.ECS_CLUSTER_ARN!;
const ECS_TASK_DEF_ARN = process.env.ECS_TASK_DEFINITION_ARN!;
const ECS_SUBNET_IDS   = (process.env.ECS_SUBNET_IDS ?? '').split(',').filter(Boolean);
const ECS_SG_IDS       = (process.env.ECS_SECURITY_GROUP_IDS ?? '').split(',').filter(Boolean);
const CONTAINER_NAME   = process.env.ECS_CONTAINER_NAME ?? 'skills-runner';
const ENV              = process.env.ENV ?? 'prod';
const REGION           = process.env.REGION ?? 'us-east-1';

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    console.log(JSON.stringify({ event: 'ingestion_triggered', bucket, key }));

    try {
      await processUpload(bucket, key);
    } catch (err) {
      console.error(JSON.stringify({
        event:  'ingestion_error',
        bucket,
        key,
        err:    String(err),
      }));
    }
  }
};

async function processUpload(bucket: string, key: string): Promise<void> {
  // ── 1. Read S3 metadata ─────────────────────────────────────────────────────

  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const meta = head.Metadata ?? {};

  const jobName    = meta['job-name']    ?? key.split('/').pop() ?? key;
  const userArn    = meta['user-arn']    ?? '';
  const mcpJobId   = meta['mcp-job-id'];
  const isMcp      = meta['mcp-submitted'] === 'true';

  // Fix E: honour mcp-job-id from S3 metadata as the jobId.
  // This is the UUID that submit_job generated and returned to the MCP agent.
  // Guard with isValidUUID so a malformed or injected value cannot corrupt the
  // DynamoDB key schema (PK uses this value directly).
  const jobId = (mcpJobId && isValidUUID(mcpJobId)) ? mcpJobId : randomUUID();

  if (isMcp && mcpJobId && !isValidUUID(mcpJobId)) {
    // Log a warning — the mcp-job-id was present but invalid; we assigned a new UUID.
    // The MCP agent's submit_job-returned jobId will not match; polling will get NOT_FOUND.
    console.warn(JSON.stringify({
      event:    'invalid_mcp_job_id',
      mcpJobId,
      assigned: jobId,
      key,
    }));
  }

  // ── 2. Idempotency check — avoid double-ingestion on S3 event retries ───────

  const existing = await ddb.send(new QueryCommand({
    TableName:                 JOBS_TABLE,
    KeyConditionExpression:    'PK = :pk AND SK = :sk',
    ExpressionAttributeValues: {
      ':pk': `${DDB_KEY_PREFIX.JOB}${jobId}`,
      ':sk': 'METADATA',
    },
    Limit: 1,
  }));

  if (existing.Items?.length) {
    console.log(JSON.stringify({ event: 'already_ingested', jobId, key }));
    return;
  }

  // ── 3. Create the DynamoDB job record ───────────────────────────────────────

  const createdAt = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName:           JOBS_TABLE,
    ConditionExpression: 'attribute_not_exists(PK)',   // race-safe
    Item: {
      PK:        `${DDB_KEY_PREFIX.JOB}${jobId}`,
      SK:        'METADATA',
      jobId,
      jobName,
      userArn,                                          // written from S3 metadata user-arn
      status:    JobStatus.PENDING,
      s3Key:     key,
      createdAt,
      updatedAt: createdAt,
      version:   0,
      // GSI keys
      GSI1PK:   `${DDB_KEY_PREFIX.STATUS}${JobStatus.PENDING}`,
      GSI1SK:   createdAt,
      GSI2PK:   `${DDB_KEY_PREFIX.USER}${userArn}`,
      GSI2SK:   createdAt,
    },
  }));

  console.log(JSON.stringify({ event: 'job_created', jobId, jobName, userArn }));

  // ── 4. Launch ECS Fargate task ─────────────────────────────────────────────

  // SPEC-23 Fix 1: startedBy = bare jobId (not the old prefixed format).
  // cancel_job (SPEC-29 Section 11) uses startedBy=jobId to find and stop the task.
  await ecs.send(new RunTaskCommand({
    cluster:        ECS_CLUSTER_ARN,
    taskDefinition: ECS_TASK_DEF_ARN,
    launchType:     LaunchType.FARGATE,
    startedBy:      jobId,    // bare UUID — matches cancel_job ListTasks query
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets:        ECS_SUBNET_IDS,
        securityGroups: ECS_SG_IDS,
        assignPublicIp: 'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name:        CONTAINER_NAME,
        environment: [
          { name: 'JOB_ID',          value: jobId },
          { name: 'JOB_NAME',        value: jobName },
          { name: 'USER_ARN',        value: userArn },
          { name: 'S3_BUCKET',       value: bucket },
          { name: 'S3_KEY',          value: key },
          { name: 'JOBS_TABLE_NAME', value: JOBS_TABLE },
          { name: 'ENV',             value: ENV },
          { name: 'REGION',          value: REGION },
        ],
      }],
    },
  }));

  // ── 5. Mark job as RUNNING ─────────────────────────────────────────────────

  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      PK:        `${DDB_KEY_PREFIX.JOB}${jobId}`,
      SK:        'METADATA',
      jobId,
      jobName,
      userArn,
      status:    JobStatus.RUNNING,
      s3Key:     key,
      createdAt,
      updatedAt: new Date().toISOString(),
      version:   1,
      GSI1PK:   `${DDB_KEY_PREFIX.STATUS}${JobStatus.RUNNING}`,
      GSI1SK:   createdAt,
      GSI2PK:   `${DDB_KEY_PREFIX.USER}${userArn}`,
      GSI2SK:   createdAt,
    },
  }));

  console.log(JSON.stringify({ event: 'ecs_task_launched', jobId, userArn, key }));
}
```

---

## Deployment Order

These five fixes have an ordering constraint due to the encryption context change (Fix D):

```
Step 1 — Deploy shared/src/crypto.ts (Fix D-1) first.
         Both the new encryptor and the new decryptor import from here.
         Publishing this package alone has no runtime effect — callers
         still pass the old context shapes until Step 2/3.

Step 2 — Deploy results-processor/handler.ts (Fix D-3).
         The new decrypt path is now live. Any new result written by the
         OLD ECS runner (without userArn in context) will fail decryption.
         This is acceptable because the window between Step 2 and Step 3
         should be seconds — deploy them in the same CDK diff.

Step 3 — Deploy ecs-runner/src/uploader.ts (Fix D-2) and indexer.ts (Fix C)
         together in the same ECS task definition revision.
         After this point, all new results are encrypted with userArn in context
         and indexed with user_arn + s3_result_key in the document.

Step 4 — Deploy ingestion/handler.ts (Fix E).
         Safe to deploy at any point — it only affects new S3 uploads.

Step 5 — Deploy knowledge-store/src/searcher.ts (Fix A) and
         query/handler.ts (Fix B) together.
         Safe to deploy after Step 3 (the user_arn field is now in new documents).
         Existing documents indexed without user_arn will return no results for
         existing users — run a one-time re-index backfill job after deployment.

Step 6 — Re-index backfill (optional but recommended):
         For each COMPLETE job in DynamoDB, re-download the result from S3,
         decrypt it (using the job.userArn from DDB), and call indexResult()
         to write a fresh document with user_arn and s3_result_key populated.
```

---

## Summary of Changes

| Fix | File | Change |
|-----|------|--------|
| A | `packages/knowledge-store/src/searcher.ts` | Replace `hybrid` with `bool.should` (kNN + multi_match); add `post_filter` for per-user tenancy; add `from`/`total`/`hasMore` pagination; `track_total_hits: true` |
| B | `packages/lambda/src/query/handler.ts` | Full API Gateway HTTP API handler with IAM/Lambda auth `callerUserArn` extraction; dual-mode support (direct invocation + APIGW) |
| C | `packages/knowledge-store/src/indexer.ts` | Write `user_arn` and `s3_result_key` to every indexed OpenSearch document; validate both fields before indexing |
| D-1 | `packages/shared/src/crypto.ts` | `EncryptionContext.userArn` added as required field; `buildKmsContext` includes it; both `envelopeEncrypt` and `envelopeDecrypt` guard on its presence |
| D-2 | `packages/ecs-runner/src/uploader.ts` | Pass `result.userArn` to `envelopeEncrypt` in context; validate `userArn` present before upload |
| D-3 | `packages/lambda/src/results-processor/handler.ts` | Read `job.userArn` from DynamoDB; pass it to `envelopeDecrypt`; backfill `userArn`/`s3ResultKey` on `RunResult` if absent |
| E | `packages/lambda/src/ingestion/handler.ts` | Read `mcp-job-id` from S3 metadata; use as `jobId` if `isValidUUID(mcpJobId)`; warn and fall back to `randomUUID()` if invalid |
