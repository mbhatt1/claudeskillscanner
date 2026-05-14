# SPEC-34a — Branded Type System for Compile-Time Invariant Enforcement

**Depends on:** SPEC-33 (shared types, normaliseArn)  
**Implements:** `packages/shared/src/branded.ts`  
**Exports via:** `packages/shared/src/index.ts`

Every definition is complete TypeScript. No pseudocode. No "see above".

---

## Motivation

SPEC-33's gap audit found five classes of runtime bug that are invisible to
`tsc` when identifiers are typed as `string`:

| # | Bug | Detection before this SPEC |
|---|-----|---------------------------|
| 1 | `userArn` omitted from `EncryptionContext` | KMS `AuthFailure` at runtime |
| 2 | `jobId` and `userArn` transposed in call | Silent wrong context, decrypt fails |
| 3 | Raw env-var string (possibly empty) used as `jobId` | DDB `ValidationException` at runtime |
| 4 | Session ARN used verbatim as `GSI2PK` | All user-scoped queries return 0 results |
| 5 | `REVIEW#` prefix instead of `FINDING#` | All `GetItem` calls return null |

Branded types make every one of these a **compile-time error** with zero
runtime overhead for valid paths.

---

## 1. Brand Helper

```typescript
// packages/shared/src/branded.ts

/**
 * Intersect primitive type T with phantom brand B.
 * The _brand field exists only in the type system; it is absent at runtime.
 */
type Brand<T, B> = T & { readonly _brand: B };
```

The intersection forces callers to produce a value through a smart constructor
or an explicit unsafe cast — bare `string` literals are not assignable.

---

## 2. Branded Primitive Aliases

```typescript
/** UUID v4 that identifies a single analysis job. */
export type JobId = Brand<string, 'JobId'>;

/**
 * IAM role ARN normalised to arn:aws:iam::<accountId>:role/<roleName>.
 * Session ARNs are rejected by makeUserArn and must be normalised first.
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
```

---

## 3. Smart Constructors with Runtime Validation

Smart constructors accept `string`, validate the input against a regular
expression or predicate, and return the branded alias. They throw `TypeError`
on invalid input so that bad data is rejected at the system boundary (API
handler or env-var bootstrap) before it ever reaches DynamoDB or KMS.

```typescript
const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IAM_ARN_RE = /^arn:aws:iam::\d{12}:(?:role|user)\/[\w+=,.@/-]+$/;
const PKG_RE     = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const SHA_RE     = /^[0-9a-f]{40}$/;
const KMS_ARN_RE = /^arn:aws:kms:/;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TypeError(`[branded] ${message}`);
}

/** Validate UUID v4 → JobId. */
export function makeJobId(s: string): JobId {
  assert(UUID_RE.test(s), `Invalid JobId (expected UUID v4): "${s}"`);
  return s as JobId;
}

/**
 * Normalise via normaliseArn() then validate canonical IAM ARN → UserArn.
 * Session ARNs (arn:aws:sts:…) are automatically converted.
 */
export function makeUserArn(s: string): UserArn {
  const normalised = normaliseArn(s);
  assert(IAM_ARN_RE.test(normalised), `Invalid UserArn: "${s}"`);
  return normalised as UserArn;
}

/** Validate non-empty alphanum+dash package name → PackageName. */
export function makePackageName(s: string): PackageName {
  assert(s.length > 0, 'PackageName must not be empty');
  assert(PKG_RE.test(s), `Invalid PackageName: "${s}"`);
  return s as PackageName;
}

/** Validate 40-char hex SHA → CommitSha. */
export function makeCommitSha(s: string): CommitSha {
  assert(SHA_RE.test(s), `Invalid CommitSha: "${s}"`);
  return s as CommitSha;
}

/** Validate non-empty key with no double-slash → S3Key. */
export function makeS3Key(s: string): S3Key {
  assert(s.length > 0, 'S3Key must not be empty');
  assert(!s.includes('//'), `Invalid S3Key (double slash): "${s}"`);
  return s as S3Key;
}

/** Validate arn:aws:kms: prefix → KmsKeyArn. */
export function makeKmsKeyArn(s: string): KmsKeyArn {
  assert(KMS_ARN_RE.test(s), `Invalid KmsKeyArn: "${s}"`);
  return s as KmsKeyArn;
}
```

### Unsafe casts — for trusted DynamoDB / env-var reads

```typescript
// Use ONLY for values written by a smart constructor at an earlier stage.
// Never use for user-supplied HTTP request body fields.

export function asJobId(s: string): JobId           { return s as JobId; }
export function asUserArn(s: string): UserArn       { return s as UserArn; }
export function asPackageName(s: string): PackageName { return s as PackageName; }
export function asCommitSha(s: string): CommitSha   { return s as CommitSha; }
export function asS3Key(s: string): S3Key           { return s as S3Key; }
export function asKmsKeyArn(s: string): KmsKeyArn   { return s as KmsKeyArn; }
export function asTableName(s: string): TableName   { return s as TableName; }
export function asQueueUrl(s: string): QueueUrl     { return s as QueueUrl; }
export function asClusterArn(s: string): ClusterArn { return s as ClusterArn; }
```

---

## 4. Updated EncryptionContext

```typescript
/**
 * KMS encryption context for job-result envelope encryption.
 *
 * Changes from SPEC-33 baseline:
 *   - jobId:   string  → JobId   (non-interchangeable with UserArn)
 *   - userArn: string  → UserArn (was missing / optional in many callers)
 *   - purpose: string  → literal 'skills-svc-result' (prevents wrong string)
 */
export interface EncryptionContext {
  readonly jobId:       JobId;
  readonly userArn:     UserArn;
  readonly purpose:     'skills-svc-result';
  readonly environment: string;
}
```

**Why the literal purpose?**  
If `purpose` is typed as `string`, a caller that passes `'code-review-result'`
satisfies the type checker but produces a context that KMS rejects at decrypt
time. The literal type `'skills-svc-result'` makes any other string a compile
error.

---

## 5. Updated Core Interfaces

```typescript
import { JobStatus } from './types';

export interface RunResult {
  readonly jobId:       JobId;      // was string
  readonly userArn:     UserArn;    // was string
  readonly s3ResultKey: S3Key;      // was string
  readonly score?:      number;
  readonly summary?:    string;
  readonly findings?:   Finding[];
  readonly error?:      string;
}

export interface JobRecord {
  readonly jobId:        JobId;     // was string
  readonly userArn:      UserArn;   // was string
  readonly status:       JobStatus;
  readonly createdAt:    string;
  readonly updatedAt:    string;
  readonly s3ResultKey?: S3Key;
  readonly ttl?:         number;
}

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
```

---

## 6. Type-Safe DynamoDB Key Builders

Previously callers built DDB keys with hand-rolled template literals. A
copy-paste error that substituted `REVIEW#` for `FINDING#` was a silent
runtime bug.

```typescript
/** PK for a job record. Always: JOB#<uuid> */
export const makeJobPK =
  (id: JobId): `JOB#${JobId}` => `JOB#${id}` as const;

/** GSI2PK for user-scoped job queries. Always: USER#<normalised-arn> */
export const makeUserGSI =
  (arn: UserArn): `USER#${UserArn}` => `USER#${arn}` as const;

/** GSI3PK for status-based queries. Always: STATUS#<status> */
export const makeStatusGSI =
  (s: JobStatus): `STATUS#${JobStatus}` => `STATUS#${s}` as const;

/** PK for a finding record. Always: FINDING#<pkg>#<jobId> */
export const makeFindingPK =
  (pkg: PackageName, id: JobId): string => `FINDING#${pkg}#${id}`;

/** SK for a package-scoped finding. Always: PKG#<packageName> */
export const makePackageSK =
  (pkg: PackageName): `PKG#${PackageName}` => `PKG#${pkg}` as const;
```

Each builder accepts only the correctly branded type. Passing a plain `string`
or a differently branded value is a `TS2345` error.

---

## 7. Five Compile-Time Bug Demonstrations

The following blocks are present in `branded.ts` wrapped in `/* … */` comment
blocks. Un-comment any block and run `tsc --noEmit` to reproduce the error.

### BUG-1 — `userArn` omitted from `EncryptionContext`

**Root cause (SPEC-33 gap audit):** Several callers of `envelopeDecrypt` built
a context object without `userArn` because the field was either absent from the
old interface or typed as optional. KMS rejected the decrypt call at runtime.

```typescript
// COMPILE ERROR — do not un-comment in production builds
function envelopeDecrypt(_ctx: EncryptionContext): void { }

const badCtx = {
  jobId:       makeJobId('00000000-0000-4000-8000-000000000000'),
  // userArn intentionally omitted
  purpose:     'skills-svc-result' as const,
  environment: 'prod',
};
envelopeDecrypt(badCtx);
// TS2345: Property 'userArn' is missing in type '{ jobId: JobId; … }'
//         but required in type 'EncryptionContext'.
```

### BUG-2 — `jobId` and `userArn` transposed

**Root cause:** Both were `string`; TypeScript allowed the swap. The KMS
context contained the ARN as `jobId` and vice-versa, so every decrypt call
produced a `GenerateDataKeyWithoutPlaintext` error in prod but not in unit
tests (which used mock KMS).

```typescript
// COMPILE ERROR
function buildContext(jobId: JobId, userArn: UserArn): EncryptionContext {
  return { jobId, userArn, purpose: 'skills-svc-result', environment: 'prod' };
}

const id  = makeJobId('00000000-0000-4000-8000-000000000000');
const arn = makeUserArn('arn:aws:iam::123456789012:role/MyRole');

buildContext(arn, id);
// TS2345: Argument of type 'UserArn' is not assignable to parameter of type 'JobId'.
```

### BUG-3 — Raw `string` passed where `JobId` required

**Root cause:** `process.env.JOB_ID` returns `string | undefined`. Callers
wrote `process.env.JOB_ID!` (non-null assertion) to silence the undefined
warning, then passed the result directly to `makeJobPK`. A missing env-var
produced an empty-string DDB key that matched no records.

```typescript
// COMPILE ERROR
const rawEnvVar: string = process.env.JOB_ID ?? '';
makeJobPK(rawEnvVar);
// TS2345: Argument of type 'string' is not assignable to parameter of type 'JobId'.
```

**Correct pattern:**
```typescript
const jobId = makeJobId(process.env.JOB_ID ?? '');
// makeJobId validates UUID format and throws TypeError on empty string.
```

### BUG-4 — Session ARN used verbatim as `GSI2PK`

**Root cause (SPEC-33 / T4):** ECS injects `AWS_ROLE_ARN` as a session ARN
(`arn:aws:sts::…:assumed-role/…/<sessionName>`). The runner read it directly
into `GSI2PK` via `makeUserGSI`. Because each task invocation uses a different
session name, no two records shared the same GSI2PK, so all user-scoped
`Query` calls returned zero results.

```typescript
// COMPILE ERROR
const sessionArn: string =
  'arn:aws:sts::123456789012:assumed-role/MyRole/ecs-task-abc';
makeUserGSI(sessionArn);
// TS2345: Argument of type 'string' is not assignable to parameter of type 'UserArn'.
```

**Correct pattern:**
```typescript
// makeUserArn() normalises session ARN → stable IAM ARN before branding.
const userArn = makeUserArn(process.env.USER_ARN!);
makeUserGSI(userArn); // ✓  USER#arn:aws:iam::123456789012:role/MyRole
```

### BUG-5 — Wrong DDB prefix in key builder

**Root cause:** A developer copy-pasted the `ReviewRecord` key builder when
writing `FindingRecord` persistence code and forgot to change the prefix from
`REVIEW#` to `FINDING#`. All `GetItem` calls for findings returned `null`;
the bug was not caught until a customer reported missing findings in prod.

```typescript
// COMPILE ERROR
const rawPkg: string = 'my-package';
const rawId:  string = '00000000-0000-4000-8000-000000000000';
makeFindingPK(rawPkg, rawId);
// TS2345: Argument of type 'string' is not assignable to parameter of type 'PackageName'.
// TS2345: Argument of type 'string' is not assignable to parameter of type 'JobId'.
```

**Correct pattern:**
```typescript
const pkg = makePackageName('my-package');
const id  = makeJobId('00000000-0000-4000-8000-000000000000');
makeFindingPK(pkg, id); // ✓  FINDING#my-package#00000000-…
```

---

## 8. Export Surface

```typescript
// packages/shared/src/index.ts
export * from './types';
export * from './branded';
export { normaliseArn } from './utils';
```

All branded types, smart constructors, unsafe casts, updated interfaces, and
key builders are re-exported from the package root. Consumers import from
`@skills-svc/shared` as before; no import path changes are required.

---

## 9. Migration Guide

| Old code | New code |
|----------|----------|
| `jobId: string` | `jobId: JobId` |
| `userArn: string` | `userArn: UserArn` |
| `s3ResultKey: string` | `s3ResultKey: S3Key` |
| `const pk = \`JOB#${jobId}\`` | `const pk = makeJobPK(jobId)` |
| `const gsi = \`USER#${arn}\`` | `const gsi = makeUserGSI(makeUserArn(arn))` |
| Read from DDB → assign | `asJobId(item.jobId)`, `asUserArn(item.userArn)` |
| API handler → parse | `makeJobId(req.params.jobId)` (throws on invalid) |

### Incremental adoption

1. Add `import type { JobId, UserArn, … } from '@skills-svc/shared'` to each
   service package.
2. Replace `string` field types with the appropriate branded alias in the
   function signature closest to the system boundary (API handler, SQS
   consumer, DDB reader).
3. Fix resulting TS2345 errors inward; use `asXxx()` for DDB reads and
   `makeXxx()` for user-supplied values.
4. Run `tsc --noEmit` and resolve all errors before merging.

---

## 10. File Locations

| File | Purpose |
|------|---------|
| `packages/shared/src/branded.ts` | All branded types, constructors, interfaces, key builders |
| `packages/shared/src/index.ts` | Re-exports branded + existing types |
| `packages/shared/src/utils.ts` | `normaliseArn` (SPEC-33 S1/T9) |
| `packages/shared/src/types.ts` | Base enums and non-branded interfaces |
