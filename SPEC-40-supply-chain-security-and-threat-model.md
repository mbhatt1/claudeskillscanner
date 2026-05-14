# SPEC-40 — Supply Chain Security & Formal Threat Model

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-06 (security hardening), SPEC-10 (skill registry), SPEC-29 (MCP)
**Related:** SPEC-38 (governance), SPEC-45 (authz), SPEC-39 (responsible AI)

---

# PART A — Supply Chain Security (SLSA L3 target)

## 1. Artifact Inventory

| Artifact                       | Registry              |
|--------------------------------|-----------------------|
| ECS-runner OCI image           | ECR (private)         |
| Each Lambda zip                | S3 (versioned)        |
| CLI npm tarball `@skills-svc/cli` | npmjs (public)     |
| Skill registry tarballs        | S3 (private, signed)  |
| CDK synth assets               | S3                    |

Every artifact requires: SBOM, provenance attestation, cosign signature, scan report.

---

## 2. Build Provenance (SLSA L3)

Reusable GH Actions workflow:

```yaml
# .github/workflows/build-with-provenance.yml
on: { workflow_call: { inputs: { artifact_name: { type: string, required: true } } } }
permissions: { id-token: write, contents: read, packages: write, attestations: write }
jobs:
  build:
    uses: slsa-framework/slsa-github-generator/.github/workflows/builder_container-slsa3.yml@v2.0.0
    with:
      image: ghcr.io/${{ github.repository }}/${{ inputs.artifact_name }}
      registry-username: ${{ github.actor }}
    secrets:
      registry-password: ${{ secrets.GITHUB_TOKEN }}
```

In-toto attestations are stored alongside the artifact in ECR (as OCI artifacts) and copied to `s3://skills-svc-attestations/`.

---

## 3. Signing (Sigstore cosign, keyless OIDC)

```yaml
- name: Sign image
  run: |
    cosign sign --yes \
      --identity-token "$(curl -sLS "$ACTIONS_ID_TOKEN_REQUEST_URL" -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" | jq -r .value)" \
      "$IMAGE@$DIGEST"
```

Verification at deploy:

```ts
// infra/lib/supplychain/verify-image.ts
new cr.AwsCustomResource(this, 'VerifyImage', {
  onUpdate: { service: 'CodeBuild', action: 'startBuild',
    parameters: { projectName: 'cosign-verify', environmentVariablesOverride: [
      { name: 'IMAGE_URI', value: image.imageUri },
      { name: 'CERT_IDENTITY_REGEX', value: '^https://github\\.com/org/skills-svc/\\.github/workflows/build.*@refs/heads/main$' },
      { name: 'OIDC_ISSUER', value: 'https://token.actions.githubusercontent.com' },
    ] } },
});
```

The CodeBuild project runs `cosign verify --certificate-identity-regexp ...` and fails if signature/identity mismatch.

---

## 4. SBOM

```yaml
- name: Generate SBOM
  run: syft "$IMAGE@$DIGEST" -o cyclonedx-json > sbom.cdx.json
- name: Attach SBOM as OCI artifact
  run: cosign attach sbom --sbom sbom.cdx.json "$IMAGE@$DIGEST"
- name: Vulnerability scan
  run: grype "$IMAGE@$DIGEST" --fail-on high --only-fixed
```

Grype gate: fail on HIGH/CRITICAL with available fix.

---

## 5. Dependency Hygiene

- `npm audit --audit-level=high` gate in CI
- `package-lock.json` committed, `npm ci --ignore-scripts --frozen-lockfile`
- Dependabot config for npm + GH Actions + Dockerfile
- License allow-list: MIT, Apache-2.0, BSD-2/3-Clause, ISC — blocks GPL/AGPL/SSPL
- Quarterly review of all transitive deps; pin minor versions

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    groups: { aws-sdk: { patterns: ["@aws-sdk/*"] } }
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
  - package-ecosystem: docker
    directory: "/packages/ecs-runner"
    schedule: { interval: weekly }
```

---

## 6. Base Image Policy

- `public.ecr.aws/lambda/nodejs:20` or `gcr.io/distroless/nodejs20-debian12` (distroless preferred for ECS runner)
- Pinned by digest, not tag
- Nightly rebuild via scheduled GH Action — patches without code change
- ECR Enhanced Scanning enabled (Inspector)

---

## 7. Skill Package Supply Chain

Skill registry Lambda verifies on submit:

```ts
// packages/lambda/skill-registry-submit/index.ts
async function verify(tarball: Buffer) {
  // 1) Cosign-signed by enrolled author
  const sig = extract('skill.tar.sig', tarball);
  await cosign.verify(sig, { certIdentityRegexp: `^${ENROLLED_AUTHOR_REGEX}$`, oidcIssuer: GH_OIDC });
  // 2) SBOM present
  if (!hasFile('sbom.cdx.json', tarball)) throw new Error('NO_SBOM');
  // 3) Static scan
  const code = extractFiles(tarball);
  for (const f of code) {
    if (/\beval\s*\(|new Function\s*\(|child_process|require\(['"]vm['"]\)/.test(f.contents)) {
      throw new Error(`BANNED_API in ${f.path}`);
    }
  }
  // 4) Manifest schema-valid
  manifestSchema.parse(JSON.parse(extract('manifest.json', tarball)));
}
```

---

## 8. CLI Distribution

```yaml
# .github/workflows/publish-cli.yml
- run: npm publish --access restricted --provenance
  env: { NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} }  # OIDC trusted publishing — no static token
```

CLI startup self-verifies:

```ts
// packages/cli/src/integrity.ts
const ownDigest = sha256(await readFile(process.argv[1]));
const sig = await fetch(`https://skills-svc.example/cli/${VERSION}/sig`);
await cosign.verifyBlob({ digest: ownDigest, sig, certIdentityRegexp: '...' });
```

---

## 9. Secret Zero & Boot Trust

- CDK deploy via GitHub OIDC → IAM role (no long-lived keys)
- ECR image pulls authenticated via task-execution role + ECR endpoint policy restricted to `arn:aws:ecr:*:${account}:repository/skills-svc/*`

---

## 10. CI/CD Hardening

- Branch protection: require PR, 2 reviews for security-sensitive paths via CODEOWNERS
- Signed commits required (`commit.gpgsign = true` enforced)
- Ephemeral GH Actions runners (no shared state)
- Network egress allowlist for runners (only npm registry, ECR, GH, AWS APIs)
- Pinned actions by SHA, not tag

```yaml
# .github/CODEOWNERS
/infra/                @org/security
/packages/shared/auth/ @org/security
/packages/shared/crypto/ @org/security
/.github/              @org/security
```

---

## 11. Deploy Verification

CDK custom resource pre-deploy:

```ts
new cr.AwsCustomResource(this, 'PreDeployGate', {
  onUpdate: { service: 'Lambda', action: 'invoke',
    parameters: { FunctionName: 'verify-supply-chain',
      Payload: JSON.stringify({ image: image.imageUri, lambdaZips: zipUris, cliVersion }) } },
});
```

`verify-supply-chain` Lambda runs cosign verify on all artifacts, checks SBOM scan status in ECR Inspector, fails CFN on issue.

---

## 12. Vulnerability Response SLA

| Severity | Fix in prod |
|----------|-------------|
| CRITICAL | 24 h        |
| HIGH     | 7 d         |
| MEDIUM   | 30 d        |
| LOW      | 90 d        |

Inspector findings → Security Hub → EventBridge → ticketing Lambda (auto-create ticket, assign owner from CODEOWNERS).

---

# PART B — Formal Threat Model

## 13. Trust Boundaries

```
[user workstation] ──TLS+SigV4──▶ [API GW / S3] ─event─▶ [SQS] ─pull─▶ [IngestionLambda]
                                                                         │ ECS RunTask
                                                                         ▼
[Bedrock]◀─VPC EP──[ECS task] ──S3 PUT──▶ [Results bucket] ─event─▶ [ResultsProcessor]
                       │                                                    │ writes
                       └──KMS────────────────────────────┐                  ▼
                                                          ▼            [DDB / OpenSearch]
                                                       [KMS]
```

For each boundary: authn = IAM SigV4 or KMS key policy; in-transit = TLS 1.2+; at-rest = KMS-CMK.

---

## 14. STRIDE Per Component

| Component        | S | T | R | I | D | E | Mitigations |
|------------------|---|---|---|---|---|---|-------------|
| S3 upload        | M | M | L | M | M | L | TLS, SigV4, bucket policy deny-non-TLS, KMS-CMK, CloudTrail data events, presigned URL TTL 5 min, content-MD5 verification |
| IngestionLambda  | L | M | L | M | M | M | Reserved concurrency, validation w/ Zod, KMS encrypt context, X-Ray tracing, IAM least-priv, permission boundary |
| ECS task         | L | H | M | H | H | H | Readonly rootfs, non-root user, no-new-privileges, seccomp, VPC egress allowlist, network policy, task role minimal, no docker socket, capability drop ALL |
| ResultsProcessor | L | M | L | M | M | L | Same as Ingestion; idempotent writes |
| DDB              | L | M | L | M | M | L | KMS-CMK, fine-grained IAM, PITR, conditional writes |
| OpenSearch       | L | M | L | M | H | L | VPC-only, data-access policies, encrypted, slow-log alerts |
| MCP server       | M | M | L | M | M | M | SigV4 (HTTP transport), Lambda authorizer + Cedar, prompt sanitizer (SPEC-39) |
| CLI              | M | L | L | M | L | L | cosign self-verify, OIDC SSO, no static creds, token cache 0600 |
| Skill registry   | H | H | M | M | M | H | Signed packages, manifest schema, static scan, author enrollment |

Likelihood/Impact: L/M/H.

---

## 15. Abuse Cases

### AC-01 — Malicious skill author exfiltration
Adversary publishes a skill that, when run, attempts to read other jobs' S3 objects.
**Mitigations:** Skill task role scoped to `arn:aws:s3:::skills-svc-results/${jobId}/*` via session policies generated per-run. VPC egress allowlist blocks attacker-controlled endpoints. Manifest `network: false` denies all egress except whitelisted AWS endpoints.

### AC-02 — Malicious zip uploader (zip-slip, decompression bomb, symlink)
**Mitigations:** Unzip in `packages/ecs-runner` with safe unzip lib that:
- Rejects entries with `..` or absolute paths
- Caps total uncompressed size (250 MB) and compression ratio (100×)
- Strips symlinks

### AC-03 — Prompt injection via reviewed repo coerces SARIF (covered in SPEC-39)
**Mitigations:** SARIF outputs validated against schema; automated remediation gated on confidence + human review on sensitive paths (SPEC-39 §9).

### AC-04 — Compromised npm dep in ECS-runner
**Mitigations:** SLSA L3 provenance, dependency review, `ignore-scripts=true` for install, frozen-lockfile, weekly Grype scans, vulnerability SLA.

### AC-05 — Bedrock token-cost DoS
Attacker uploads jobs designed to maximize tokens.
**Mitigations:** Per-job `max_cost_usd` cap (SPEC-41 §4), monthly budget kill switch, rate limits per IAM principal on upload.

### AC-06 — OpenSearch query injection via NL CLI
**Mitigations:** Query DSL constructed server-side, never string-concatenate user input; user input embedded then kNN-searched (no DSL evaluation of user text).

### AC-07 — DDB hot-partition DoS
**Mitigations:** ULID PKs (SPEC-42 §5), composite SK with random suffix on hot GSIs, on-demand billing absorbs spikes, ThrottledRequests alarm.

### AC-08 — IAM role-assumption phishing
**Mitigations:** Identity Center SSO + MFA required (SPEC-45), no IAM users, role assumption logged + alerts on unusual hours, permission boundary denies privilege escalation.

---

## 16. Mitigation Traceability

| Abuse case | Primary mitigation                | Spec ref          |
|------------|------------------------------------|-------------------|
| AC-01      | Per-run session policies + VPC egress allowlist | SPEC-06 §X, SPEC-45 |
| AC-02      | Safe unzip                          | SPEC-02 ECS runner |
| AC-03      | SARIF schema + HITL                 | SPEC-39 §9         |
| AC-04      | SLSA + Grype + Dependabot           | SPEC-40 §2,4,5     |
| AC-05      | Cost cap + budget kill              | SPEC-41 §3,4       |
| AC-06      | Server-built query DSL              | SPEC-03            |
| AC-07      | PK design + on-demand               | SPEC-42 §5         |
| AC-08      | SSO + MFA + permission boundary     | SPEC-45            |

---

## 17. Red Team Plan

- **Cadence:** quarterly external engagement; monthly internal "purple team" exercises
- **Scope (in):** production API surface, MCP server, skill registry, CLI distribution path, IAM model
- **Scope (out):** AWS service internals, third-party Bedrock model, social engineering of named individuals
- **Reporting:** standard report template under `docs/redteam/`, severity rubric (CVSS 3.1), 90-day fix SLA for HIGH+
- **Bug bounty:** in-scope = production endpoints; out-of-scope = AWS infra, DoS, prompt-injection (handled separately under SPEC-39), spam

---

## 18. Pre-Launch Security Checklist (50 items)

(abridged — full list lives in `docs/security/pre-launch-checklist.md`)

**Auth/Authz**
1. SSO + MFA required for all human access
2. No IAM users
3. Permission boundaries attached to all roles
4. Session tags propagate persona
5. Cedar policies tested with > 90% coverage

**Crypto**
6. KMS-CMK on all data stores
7. TLS 1.2+ enforced via bucket policies
8. KMS key rotation enabled
9. Encryption context required on encrypt/decrypt
10. No deprecated algorithms

**Logging**
11. CloudTrail org-trail to write-once bucket
12. Audit log immutable + hash-chained
13. GuardDuty enabled all regions
14. Security Hub enabled with CIS + AWS Foundational
15. No PII/SOURCE_CODE in CloudWatch logs

**Input/Output**
16. Zod validation at every Lambda entry
17. Output encoding for HTML/JSON contexts
18. SARIF schema-validated
19. Unzip safe-mode (zip-slip, bomb)
20. Skill manifest schema-validated

**Secrets**
21. Secrets Manager only; no env-var secrets
22. No long-lived keys
23. OIDC for CI
24. Rotation policy documented

**Errors**
25. No stack traces to users
26. Structured errors with codes
27. Retry/backoff with jitter
28. Idempotency keys

**Deps**
29. SBOM published
30. Vulnerability scan green
31. License allow-list enforced
32. Dependabot up-to-date

**Deploy**
33. Cosign verification at deploy
34. CDK aspects pass (security + tagging + classification)
35. Pre/post traffic hooks
36. Auto-rollback on alarm

**Network**
37. No public subnets for compute
38. No NAT gateways
39. VPC endpoint policies restrict ARNs
40. SG least-privilege
41. WAF on public endpoints

**Data**
42. PII redaction tested
43. Retention enforced
44. Erasure tested
45. Backup verified

**Ops**
46. SLOs measured
47. Runbooks present + reviewed
48. On-call rotation defined
49. DR drill last 90 days
50. Threat model reviewed last 90 days

---

## 19. Incident Response

**Sev definitions:** see SPEC-36 §4.1.

**Runbook:**
1. **Detect** — alarm/page/external report
2. **Triage** — assign IC, declare sev, open channel
3. **Contain** — kill switch, revoke creds, block IPs, isolate task
4. **Eradicate** — patch, rotate keys, re-image
5. **Recover** — restore from backup, replay queue, validate SLOs
6. **Postmortem** — 5 business days; blameless; action items tracked

Comms template: `docs/ir/comms.md`.

Regulator-notification triggers:
- GDPR data breach (any PII unauth-accessed): 72 h to supervisory authority
- SOC2 customer-impacting incident: notify affected within agreed timeline
- Maintain `docs/ir/notification-runbook.md`

Postmortem template: `docs/ir/postmortem.md`.

---

## 20. Acceptance Criteria

- [ ] SLSA L3 attestations for all artifacts
- [ ] Cosign verification at deploy gates passing
- [ ] SBOM + Grype scan green
- [ ] Skill registry rejects unsigned/banned-API packages
- [ ] STRIDE table reviewed by 2 engineers
- [ ] Each abuse case has demo'd mitigation in CI
- [ ] First quarterly red-team report on file
- [ ] 50-item checklist passed for launch
- [ ] IR runbook drilled
