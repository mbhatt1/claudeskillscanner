# SPEC-50 — Cryptographic Agility & Post-Quantum Readiness

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-06 (security hardening), SPEC-38 (governance), SPEC-45 (identity)

> Defenders need a routine path to rotate algorithms and prepare for PQ before "harvest now, decrypt later" becomes a real loss.

---

## 1. Algorithm Inventory

Maintained file `docs/crypto/inventory.md` with one row per crypto use:

| Use                       | Primitive             | Library / Service             | Rotation horizon |
|---------------------------|-----------------------|-------------------------------|------------------|
| Data at rest (S3, DDB, OS)| AES-256-GCM (KMS)     | AWS KMS CMK                   | KMS yearly auto  |
| TLS to AWS endpoints      | TLS 1.2/1.3, ECDHE+AES-GCM | AWS                        | AWS-managed      |
| TLS for CLI               | TLS 1.3 only          | undici / Node 20              | with Node major  |
| JWT (if any)              | EdDSA (Ed25519)       | jose                          | annual           |
| Cosign artifact sig       | Ed25519 + Sigstore    | cosign                        | per release      |
| Audit-log hash chain      | SHA-256               | crypto module                 | review 2027      |
| Skill manifest signing    | Ed25519               | cosign                        | per author       |
| Embedding hashing         | SHA-256               | crypto module                 | review 2027      |
| Password hashing          | (none — no passwords) | n/a                           | n/a              |

CDK Aspect rejects unknown algorithms (e.g. MD5, SHA-1, RSA < 3072, DSA, RC4).

---

## 2. Crypto-Agility Pattern

Every crypto consumer goes through `packages/shared/crypto/`:

```ts
// packages/shared/crypto/index.ts
export interface Hasher { hash(b: Buffer): Buffer; algo: string; }
export interface Signer { sign(b: Buffer): Promise<Buffer>; verify(b: Buffer, sig: Buffer): Promise<boolean>; algo: string; }

export const hashers = {
  'sha-256': () => /* impl */,
  'sha-3-256': () => /* impl */,    // future
};
```

Calling code asks the **registry** for the current default; primitives never hardcoded. Stored ciphertext / signatures carry an algorithm identifier prefix:

```
ciphertext = "ALG:aes-256-gcm:v1|" || nonce || ct || tag
signature  = "ALG:ed25519:v1|"     || sig
hash       = "ALG:sha-256:v1|"     || digest
```

Decoders dispatch on the prefix; old data remains readable when the default rotates.

---

## 3. Key Management

- All CMKs created with `enable_key_rotation = true` (annual KMS-managed rotation; key material rotates while key ID stays stable).
- Application-level keys (cosign signing) versioned in Secrets Manager with rotation Lambda.
- Encryption context is mandatory on every KMS encrypt/decrypt (covered SPEC-06); included in `data_key.context` log field.

```ts
// CDK Aspect
class KmsRotationAspect implements IAspect {
  visit(n: IConstruct) {
    if (n instanceof kms.Key && !(n as any).enableKeyRotation) {
      Annotations.of(n).addError('KMS key rotation must be enabled');
    }
  }
}
```

---

## 4. Rotation Playbook

For each crypto use:
1. Stand up the new algorithm alongside the old in `packages/shared/crypto/`.
2. Flip producer's default via AppConfig flag `crypto.default.<use> = new`.
3. Wait one retention horizon for natural decrypt traffic of old ciphertext.
4. Background re-encrypt sweep (Lambda) for at-rest data still on old alg.
5. Decommission old algorithm; remove from registry.

Each rotation has a postmortem-style report under `docs/crypto/rotations/`.

---

## 5. Post-Quantum Readiness

Threat model: "harvest now, decrypt later" against any data with retention > 7 y (audit log, evidence bucket).

### 5.1 Track AWS roadmap
- **TLS hybrid KEMs (Kyber/ML-KEM)**: AWS already supports hybrid for KMS/S3 via custom `aws-lc`-based clients. Adopt when GA at the SDK layer.
- **KMS PQ signing**: monitor for ML-DSA support.

### 5.2 Adoption plan (phased)
| Phase | Trigger                                  | Action                                                |
|-------|------------------------------------------|-------------------------------------------------------|
| P1    | AWS SDK supports hybrid TLS by default   | Enable for S3/KMS clients via SDK config              |
| P2    | KMS PQ-signing GA                        | Migrate cosign keys to hybrid signatures              |
| P3    | Stable PQ KEMs available for application | Re-encrypt long-retention audit log with hybrid scheme|

### 5.3 Crypto-agility insurance
Audit-log envelopes already carry algorithm tags (§2) so future re-encryption can target the long-retention subset without re-touching all data.

---

## 6. TLS Hardening

- TLS 1.2 minimum on all endpoints; TLS 1.3 preferred
- Cipher suites: ECDHE+AES-GCM only (block CBC, RC4, 3DES)
- HSTS on any HTTP surface with `max-age=63072000; includeSubDomains; preload`
- Certificate transparency monitored (CT logs alarm if cert issued outside expected CAs)

Bucket policy enforcement:
```json
{ "Effect": "Deny", "Action": "s3:*", "Resource": ["${bucket}", "${bucket}/*"],
  "Condition": { "Bool": { "aws:SecureTransport": "false" } } }
{ "Effect": "Deny", "Action": "s3:*", "Resource": ["${bucket}", "${bucket}/*"],
  "Condition": { "NumericLessThan": { "s3:TlsVersion": "1.2" } } }
```

---

## 7. Random Number Generation

All RNG via `crypto.randomBytes` / `crypto.randomUUID`; `Math.random()` banned by ESLint rule for non-trivial uses. ULIDs use crypto-RNG (default in `ulid` package).

```js
// .eslintrc.cjs
'no-restricted-syntax': ['error',
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: 'Use crypto.randomBytes / randomUUID' }],
```

---

## 8. Secret Material Handling

- Never log secrets (redactor in SPEC-46 enforces)
- Use `Buffer` in memory; zero with `buf.fill(0)` ASAP after use (best-effort in V8)
- KMS encrypt context binds secret use to job (`encryption_context: { job_id, classification }`)

---

## 9. Certificate Lifecycle

- ACM-issued certs for all public endpoints; auto-renewal
- Private CA (AWS PCA) for internal mTLS if/when introduced (none today)
- Cosign trust roots pinned + rotated quarterly; ceremony documented in `docs/crypto/cosign-root-rotation.md`

---

## 10. Acceptance Criteria

- [ ] Algorithm inventory current
- [ ] All ciphertext/signatures/hashes carry alg-tag prefix
- [ ] CDK Aspects: KMS rotation + algorithm allowlist green
- [ ] TLS policy enforced on every public endpoint and bucket
- [ ] ESLint blocks `Math.random()` in security-sensitive paths
- [ ] PQ roadmap reviewed quarterly; AWS SDK config dry-run for hybrid KEMs
- [ ] One mock rotation exercised end-to-end on a non-critical use
