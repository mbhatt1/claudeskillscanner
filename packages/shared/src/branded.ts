// packages/shared/src/branded.ts
// Branded type system for compile-time invariant enforcement.
// See SPEC-34a-branded-types.md for full rationale and bug-catch examples.

import { JobStatus } from './types';

// ── 1. Brand helper ───────────────────────────────────────────────────────────

/**
 * Intersect a primitive type T with a phantom brand B so that TypeScript treats
 * each branded alias as a distinct, non-interchangeable type.
 *
 * At runtime the brand field does not exist; it is erased by the JS engine.
 * At compile time TypeScript requires you to produce a value via a smart
 * constructor (or an explicit unsafe cast) — bare string literals are rejected.
 */
type Brand<T, B> = T & { readonly _brand: B };

// ── 2. Branded primitive aliases ─────────────────────────────────────────────

/** UUID v4 that identifies a single analysis job. */
export type JobId = Brand<string, 'JobId'>;

/**
 * IAM role ARN normalised to arn:aws:iam::<accountId>:role/<roleName>.
 * Session ARNs (arn:aws:sts::…:assumed-role/…/…) are rejected by makeUserArn
 * and must be normalised first.
 */
export type UserArn = Brand<string, 'UserArn'>;

/** npm / PyPI / Maven package name (alphanum + dash, non-empty). */
export type PackageName = Brand<string, 'PackageName'>;

/** 40-character lowercase hex Git commit SHA. */
export type CommitSha = Brand<string, 'CommitSha'>;

/** S3 object key (non-empty, no consecutive slashes). */
export type S3Key = Brand<string, 'S3Key'>;

/** AWS KMS key ARN beginning with arn:aws:kms:. */
export type KmsKeyArn = Brand<string, 'KmsKeyArn'>;

/** DynamoDB table name. */
export type TableName = Brand<string, 'TableName'>;

/** SQS queue URL. */
export type QueueUrl = Brand<string, 'QueueUrl'>;

/** ECS cluster ARN. */
export type ClusterArn = Brand<string, 'ClusterArn'>;

// ── 3. Normalise helper (mirrors packages/shared/src/utils.ts) ───────────────

/**
 * Convert an STS assumed-role ARN to a stable IAM role ARN.
 * Idempotent: non-session ARNs are returned unchanged.
 *
 * arn:aws:sts::<accountId>:assumed-role/<roleName>/<sessionName>
 *   → arn:aws:iam::<accountId>:role/<roleName>
 */
function normaliseArn(arn: string): string {
  const m = arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.+$/);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn;
}

// ── 4. Validation helpers ─────────────────────────────────────────────────────

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IAM_ARN_RE = /^arn:aws:iam::\d{12}:(?:role|user)\/[\w+=,.@/-]+$/;
const PKG_RE     = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const SHA_RE     = /^[0-9a-f]{40}$/;
const KMS_ARN_RE = /^arn:aws:kms:/;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`[branded] ${message}`);
}

// ── 5. Smart constructors with runtime validation ────────────────────────────

/**
 * Validate that `s` is a UUID v4 and return it as JobId.
 * Throws TypeError on invalid input.
 */
export function makeJobId(s: string): JobId {
  assert(UUID_RE.test(s), `Invalid JobId (expected UUID v4): "${s}"`);
  return s as JobId;
}

/**
 * Normalise `s` via normaliseArn() then validate it is a canonical IAM ARN.
 * Session ARNs (arn:aws:sts:…) are automatically normalised.
 * Throws TypeError if the result is not a valid IAM ARN.
 *
 * This is the fix for the GSI2PK bug: callers that passed a session ARN
 * directly will now receive the normalised form automatically.
 */
export function makeUserArn(s: string): UserArn {
  const normalised = normaliseArn(s);
  assert(IAM_ARN_RE.test(normalised), `Invalid UserArn (must be IAM role/user ARN): "${s}"`);
  return normalised as UserArn;
}

/**
 * Validate that `s` is a non-empty alphanum+dash package name.
 * Throws TypeError on invalid input.
 */
export function makePackageName(s: string): PackageName {
  assert(s.length > 0, 'PackageName must not be empty');
  assert(PKG_RE.test(s), `Invalid PackageName (alphanum + dash only): "${s}"`);
  return s as PackageName;
}

/**
 * Validate that `s` is a 40-character lowercase hex SHA.
 * Throws TypeError on invalid input.
 */
export function makeCommitSha(s: string): CommitSha {
  assert(SHA_RE.test(s), `Invalid CommitSha (expected 40-char hex): "${s}"`);
  return s as CommitSha;
}

/**
 * Validate that `s` is a non-empty S3 key with no consecutive slashes.
 * Throws TypeError on invalid input.
 */
export function makeS3Key(s: string): S3Key {
  assert(s.length > 0, 'S3Key must not be empty');
  assert(!s.includes('//'), `Invalid S3Key (double slash): "${s}"`);
  return s as S3Key;
}

/**
 * Validate that `s` begins with the arn:aws:kms: prefix.
 * Throws TypeError on invalid input.
 */
export function makeKmsKeyArn(s: string): KmsKeyArn {
  assert(KMS_ARN_RE.test(s), `Invalid KmsKeyArn (must start with arn:aws:kms:): "${s}"`);
  return s as KmsKeyArn;
}

// ── 6. Unsafe casts — for trusted DynamoDB / env-var reads ───────────────────
//
// Use these ONLY when the value originates from a controlled data store that
// already enforced the invariant at write time (e.g. DDB records whose PK was
// written via a smart constructor, or environment variables injected by CDK).
//
// Never use them for values sourced from user-supplied HTTP request bodies.

/** Trust a DDB-sourced string as a JobId. No runtime validation. */
export function asJobId(s: string): JobId           { return s as JobId; }
/** Trust a DDB-sourced string as a UserArn. No runtime validation. */
export function asUserArn(s: string): UserArn       { return s as UserArn; }
/** Trust a DDB-sourced string as a PackageName. No runtime validation. */
export function asPackageName(s: string): PackageName { return s as PackageName; }
/** Trust a DDB-sourced string as a CommitSha. No runtime validation. */
export function asCommitSha(s: string): CommitSha   { return s as CommitSha; }
/** Trust a DDB-sourced string as an S3Key. No runtime validation. */
export function asS3Key(s: string): S3Key           { return s as S3Key; }
/** Trust a DDB-sourced string as a KmsKeyArn. No runtime validation. */
export function asKmsKeyArn(s: string): KmsKeyArn   { return s as KmsKeyArn; }
/** Trust a config string as a TableName. No runtime validation. */
export function asTableName(s: string): TableName   { return s as TableName; }
/** Trust a config string as a QueueUrl. No runtime validation. */
export function asQueueUrl(s: string): QueueUrl     { return s as QueueUrl; }
/** Trust a config string as a ClusterArn. No runtime validation. */
export function asClusterArn(s: string): ClusterArn { return s as ClusterArn; }

// ── 7. Updated EncryptionContext ──────────────────────────────────────────────

/**
 * KMS encryption context used when encrypting / decrypting job results.
 *
 * Previously `jobId` and `userArn` were plain `string`, making it possible to:
 *   (a) omit `userArn` entirely and satisfy the type checker (it was optional),
 *   (b) transpose `jobId` and `userArn` without a compile error,
 *   (c) pass the wrong purpose string.
 *
 * All three classes of bug are now compile errors.
 */
export interface EncryptionContext {
  readonly jobId:       JobId;                  // was string
  readonly userArn:     UserArn;                // was string, was missing in many places
  readonly purpose:     'skills-svc-result';    // literal — prevents wrong purpose string
  readonly environment: string;
}

// ── 8. Updated core interfaces ────────────────────────────────────────────────

import { Finding } from './types';

/**
 * Result produced by the ECS runner and stored in S3.
 * All identifier fields now carry compile-time brand enforcement.
 */
export interface RunResult {
  readonly jobId:       JobId;      // was string
  readonly userArn:     UserArn;    // was string
  readonly s3ResultKey: S3Key;      // was string
  readonly score?:      number;
  readonly summary?:    string;
  readonly findings?:   Finding[];
  readonly error?:      string;
}

/**
 * DynamoDB record for a single analysis job.
 */
export interface JobRecord {
  readonly jobId:       JobId;      // was string
  readonly userArn:     UserArn;    // was string
  readonly status:      JobStatus;
  readonly createdAt:   string;
  readonly updatedAt:   string;
  readonly s3ResultKey?: S3Key;
  readonly ttl?:         number;
}

/**
 * DynamoDB record for a single security finding linked to a job.
 */
export interface FindingRecord {
  readonly jobId:          JobId;        // was string
  readonly packageName:    PackageName;  // was string
  readonly packageVersion: string;
  readonly severity:       string;
  readonly rule:           string;
  readonly message:        string;
  readonly file?:          string;
  readonly line?:          number;
  readonly createdAt:      string;
  readonly ttl:            number;
}

// ── 9. Type-safe DynamoDB key builders ───────────────────────────────────────
//
// Previously callers built DDB keys with hand-rolled template literals, which
// meant the wrong prefix (e.g. "REVIEW#" instead of "JOB#") was a silent
// runtime bug. These functions enforce the correct prefix at compile time
// because each accepts only the appropriately branded type.

/** PK for a job record: JOB#<uuid> */
export const makeJobPK     = (id: JobId): `JOB#${JobId}`       => `JOB#${id}` as const;

/** GSI2PK for user-scoped job queries: USER#<normalised-arn> */
export const makeUserGSI   = (arn: UserArn): `USER#${UserArn}` => `USER#${arn}` as const;

/** GSI3PK for status-based queries: STATUS#<status> */
export const makeStatusGSI = (s: JobStatus): `STATUS#${JobStatus}` => `STATUS#${s}` as const;

/** PK for a finding record: FINDING#<packageName>#<jobId> */
export const makeFindingPK = (pkg: PackageName, id: JobId): string =>
  `FINDING#${pkg}#${id}`;

/** SK for a package-scoped finding: PKG#<packageName> */
export const makePackageSK = (pkg: PackageName): `PKG#${PackageName}` =>
  `PKG#${pkg}` as const;

// ── 10. Compile-time bug demonstrations ──────────────────────────────────────
//
// The five blocks below are commented out because they are intentionally
// invalid TypeScript. Un-comment any block and run `tsc --noEmit` to see the
// compiler error. Each corresponds to an actual bug found during the SPEC-33
// gap audit.

/*
// BUG-1: envelopeDecrypt called with userArn omitted.
// Before: userArn was optional / not present in EncryptionContext → silently
//         produced a context missing the ARN, so KMS would reject the call
//         at runtime with an AuthFailure.
// Fix: EncryptionContext now requires userArn: UserArn (non-optional).
//
// Compile error:
//   Property 'userArn' is missing in type '{ jobId: JobId; purpose: ...; environment: string; }'
//   but required in type 'EncryptionContext'.

function envelopeDecrypt(_ctx: EncryptionContext): void { }

const badCtx = {
  jobId:       makeJobId('00000000-0000-4000-8000-000000000000'),
  // userArn intentionally omitted
  purpose:     'skills-svc-result' as const,
  environment: 'prod',
};
envelopeDecrypt(badCtx); // ← TS2345
*/

/*
// BUG-2: jobId and userArn transposed in a function call.
// Before: both were plain `string` so TypeScript allowed the swap silently.
//         The KMS context was built with the ARN as the jobId and vice-versa,
//         causing every decrypt call to fail with GenerateDataKeyWithoutPlaintext.
// Fix: JobId ≠ UserArn at the type level.
//
// Compile error:
//   Argument of type 'UserArn' is not assignable to parameter of type 'JobId'.

function buildContext(jobId: JobId, userArn: UserArn): EncryptionContext {
  return { jobId, userArn, purpose: 'skills-svc-result', environment: 'prod' };
}

const id  = makeJobId('00000000-0000-4000-8000-000000000000');
const arn = makeUserArn('arn:aws:iam::123456789012:role/MyRole');

buildContext(arn, id); // ← TS2345: transposed — caught at compile time
*/

/*
// BUG-3: Raw string passed where JobId is required.
// Before: jobId was typed as `string` everywhere; callers passed raw env-var
//         strings (including empty strings after a missing env-var read)
//         directly into DDB key builders and KMS contexts.
// Fix: JobId is a branded type; bare `string` is not assignable.
//
// Compile error:
//   Argument of type 'string' is not assignable to parameter of type 'JobId'.

const rawEnvVar: string = process.env.JOB_ID ?? '';
makeJobPK(rawEnvVar); // ← TS2345
*/

/*
// BUG-4: GSI2PK built from session ARN instead of normalised ARN.
// Before: callers took process.env.USER_ARN (which ECS injects as a session
//         ARN like arn:aws:sts::…:assumed-role/…/…) and used it verbatim as
//         the GSI2PK. Queries using the stable role ARN never matched.
// Fix: makeUserArn() normalises session ARNs automatically; the returned
//      UserArn is always in the canonical arn:aws:iam:: form.
//      Passing a session ARN to makeUserGSI without calling makeUserArn first
//      is a compile error because `string` is not `UserArn`.
//
// Compile error:
//   Argument of type 'string' is not assignable to parameter of type 'UserArn'.

const sessionArn: string = 'arn:aws:sts::123456789012:assumed-role/MyRole/session';
makeUserGSI(sessionArn); // ← TS2345
// Correct usage:
// const userArn = makeUserArn(sessionArn); // normalises + validates
// makeUserGSI(userArn);                    // ✓
*/

/*
// BUG-5: Wrong DDB prefix used in a hand-rolled key expression.
// Before: key builders were ad-hoc template literals; a copy-paste error
//         caused FindingRecord PKs to be written with the "REVIEW#" prefix
//         instead of "FINDING#", making all GetItem calls return null.
// Fix: makeFindingPK() accepts (PackageName, JobId) and always emits
//      "FINDING#<pkg>#<id>". Passing a plain string for either argument
//      is a compile error, so the compiler rejects:
//         `REVIEW#${pkg}#${id}`   (wrong prefix — can't even call the builder)
//      and forces all callers through the same typed function.
//
// Compile error:
//   Argument of type 'string' is not assignable to parameter of type 'PackageName'.

const rawPkg: string = 'my-package';
const rawId:  string = '00000000-0000-4000-8000-000000000000';
makeFindingPK(rawPkg, rawId); // ← TS2345 on both arguments
*/
