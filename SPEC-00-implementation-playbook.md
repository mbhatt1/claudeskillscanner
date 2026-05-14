# SPEC-00: Implementation Playbook

**Status:** AUTHORITATIVE — read this first
**Audience:** humans and Claude Code sessions implementing the system
**Scope:** how to consume SPEC-01..59 (and beyond) and turn them into running code without losing cross-spec invariants

This is not a feature spec. It is the meta-spec that tells you which specs to read, in what order, and how to know when you're done. If you're new here, this is the only file you need to open first.

---

## 1. What This Repo Is

A spec repo for **Skills as a Service** — a fully serverless AWS backend that runs Claude Code skills inside a hardened ECS sandbox, indexes their structured findings, and exposes everything to Claude Code sessions via an MCP server.

The repo currently contains specs only (`SPEC-*.md`) and an empty package scaffold (`packages/cli`, `packages/lambda`, `packages/ecs-runner`, `packages/shared`, `infra/`). The specs are **authoritative** — they define the system. Code is implemented *against* the specs, not the other way around.

---

## 2. How to Read the Spec Set

There are ~60 specs. Don't read them linearly. Read them in **layers**:

### Layer 0 — Orientation (read these no matter what)
- **SPEC-00** (this file) — playbook
- **SPEC-01** — overview & architecture diagram
- **SPEC-12** — final consolidation snapshot
- **SPEC-35** — IC7-level gap closure (frames the bar)

### Layer 1 — Foundations (must be implemented before any feature)
Order matters here.

1. **SPEC-01** — VPC, KMS keys, S3 buckets, DDB single-table schema, OpenSearch collection
2. **SPEC-51** — network architecture, every VPC endpoint
3. **SPEC-06** — security hardening (TLS-only, KMS SSE, GuardDuty, Security Hub)
4. **SPEC-45** — identity, IAM role design, caller propagation
5. **SPEC-34a** — branded types (`JobId`, `SkillId`, `CallerArn`, …)
6. **SPEC-34b** — CDK aspects (no-wildcard, no-public-subnet, KMS-required, …)
7. **SPEC-34c** — property tests scaffold
8. **SPEC-59** — production IAM tightening + Bedrock endpoint validation

After Layer 1, `cdk synth` should produce a deployable empty platform with all guardrails active.

### Layer 2 — Pipeline (the data plane)
1. **SPEC-02** — Lambda + ECS task definitions
2. **SPEC-03** — knowledge store + CLI bones
3. **SPEC-57** — pipeline golden tests (write these as you build)

### Layer 3 — Feature surface
- **SPEC-07, 08, 13, 14** — CLI features and cleanups
- **SPEC-09, 29, 32, 53** — MCP server (read in this order; 29 supersedes 09's wiring, 32 supersedes 29's tool set, 53 adds streaming/rate-limits)
- **SPEC-10** — skill registry
- **SPEC-25, 26** — code review extension
- **SPEC-55** — workflow DAG
- **SPEC-58** — MCP upload-and-scan flow (depends on 29/32 in place)
- **SPEC-54, 56** — skill SDK + onboarding (developer-facing surface)

### Layer 4 — Cross-cutting (apply continuously, not at the end)
- **SPEC-36** reliability, **37** DR, **38** governance, **39** responsible AI, **40** supply chain, **41** finops, **42** perf, **43** DX, **44** contracts, **46** observability, **47** model lifecycle, **48** marketplace, **49** bulk ops, **50** crypto agility, **52** synthetics

### Layer 5 — Audits & errata (read for what they fix, then apply)
- **SPEC-11, 16, 17, 18, 19, 20, 21, 22, 23, 24, 28, 30, 31, 33** — audit rounds. Each one is "these specific cells in earlier specs are wrong; here is the corrected text." Always treat audit specs as superseding earlier ones.

**Rule:** when a later spec has a `Supersedes` header, the cells it lists in earlier specs are dead. Don't implement the original.

---

## 3. Build Sequence

This is the order a fresh implementation should proceed in. Each step has an explicit gate; do not advance until the gate passes.

| # | Step | Gate |
|---|---|---|
| 1 | Bootstrap `infra/` CDK app, `packages/shared` types from SPEC-34a | `pnpm build` clean; branded types compile |
| 2 | SPEC-01 §3 KMS keys + SSM ARN exports | `cdk synth` produces all keys; no wildcards |
| 3 | SPEC-01 §4 VPC + SPEC-51 endpoints | `cdk synth`; SPEC-59 §3.2 Check A passes |
| 4 | SPEC-34b aspects wired, `strict: true` | aspect blocks a deliberately bad commit in a meta-test |
| 5 | SPEC-01 §5 S3 buckets + DDB + OpenSearch | bucket policies KMS-required; DDB PITR on |
| 6 | SPEC-06 hardening (GuardDuty, Security Hub, CloudTrail) | findings ingestion works in dev env |
| 7 | SPEC-45 user role + ECS task role + MCP role | SPEC-59 §1.1 KMS scoping applied from day one |
| 8 | SPEC-02 ingestion Lambda + ECS task definition | end-to-end zip → ECS run → result S3 object |
| 9 | SPEC-03 results processor + knowledge store indexer | findings searchable in OpenSearch |
| 10 | SPEC-57 golden pipeline tests | a canonical zip produces byte-identical results document |
| 11 | SPEC-09 → SPEC-29 → SPEC-32 MCP server (apply supersessions) | SigV4 auth works; `submit_job`, `job_status`, `get_result` green |
| 12 | SPEC-10 skill registry + SPEC-40 signing | unsigned skill rejected by registry |
| 13 | SPEC-58 upload modes B and C + streaming + `scan` tool | 1.5 GiB upload + fan-out scan end-to-end |
| 14 | SPEC-55 workflow DAG | `workflow run` + `workflow replay` deterministic |
| 15 | SPEC-25/26 code review extension | `/security-review` on a PR posts findings |
| 16 | SPEC-54 skill SDK + SPEC-56 onboarding | `skl init` → first scan in <10 min |
| 17 | Layer 4 cross-cutting concerns applied as features stabilize | each one's own acceptance criteria |
| 18 | Layer 5 errata applied as they were written | grep the corrected cells, confirm matches |

Skip-ahead is **forbidden**: every step's gate is a precondition for the next.

---

## 4. Using Claude Code With This Spec Set

The specs are designed to be consumed by Claude Code. They are not designed to be dropped in as a single 200k-token prompt and produce the whole system. Use this loop instead.

### 4.1 Per-spec implementation prompt

```
You are implementing SPEC-XX §Y. Read:
  - SPEC-00 (playbook) — orientation
  - SPEC-XX-{slug}.md — the spec you are implementing
  - any spec named in its `Depends on:` header
Implement only §Y. Do not invent code that isn't grounded in the spec.
When done:
  - run `pnpm -w typecheck` — must pass
  - run `pnpm -w test --filter <package>` — must pass
  - run `cdk synth --strict` — must pass
Report back with: files changed, gate status, anything that contradicted the spec.
```

### 4.2 Chunk size

- A spec section (§) is the right unit of work for one Claude turn.
- A whole spec is the right unit of work for one PR.
- A layer (per §2) is the right unit of work for one sprint.

### 4.3 What Claude is good at here
- Translating a spec section into CDK + Lambda + tests
- Wiring AWS SDK calls when the construct names are already in the spec
- Writing the tests listed in `## Tests` sections
- Catching cross-spec contradictions when shown two specs at once

### 4.4 What Claude is *not* good at here
- Keeping invariants across the whole 60-spec set in one session — it will drift
- Inventing AWS action names or construct props not in the spec — it will hallucinate
- Knowing whether a Layer 5 audit spec has already been applied — check the corrected cells yourself
- Verifying deploy-time probes — those need a real AWS account

The aspects in SPEC-34b and the strict checks in SPEC-59 are the safety net for these failure modes. **Don't disable them.** A failing aspect is a working aspect.

### 4.5 Use `/security-review` continuously
After implementing any spec touching IAM, network, or data flow, run `/security-review` on the diff. It is configured (SPEC-25) to flag wildcard policies, missing KMS conditions, and open SGs.

---

## 5. Spec Lifecycle

### 5.1 Authoring a new spec
Required frontmatter:
```
**Status:** AUTHORITATIVE
**Depends on:** SPEC-XX, SPEC-YY
**Supersedes (in part):** SPEC-ZZ §N  (if applicable)
```
Sections that fix or override earlier specs **must** list the specific cells (spec, section, sometimes line range) in the `Supersedes` header. No silent overrides.

### 5.2 Audit/errata specs
When implementation reveals drift, write a new audit spec rather than editing earlier ones. Earlier specs are historical; the latest spec wins. This is why the audit chain (SPEC-11..33) exists.

### 5.3 Test sections are mandatory
Every new spec ships with a `## Tests` section enumerating unit / property / integration / red-team tests. Acceptance criteria reference them.

### 5.4 Numbering
- SPEC-00 — playbook (this file)
- SPEC-01..05 — foundational
- SPEC-06..14 — initial feature surface
- SPEC-15..33 — audit rounds
- SPEC-34..59 — feature + cross-cutting
- Allocate the next integer for any new spec; don't backfill.

---

## 6. Definition of Done — Whole System

The system is "done" when **all** of the following hold:

- Every spec's `## Acceptance Criteria` checklist is fully checked, with a PR link per item
- `cdk synth --strict` passes for every stack
- All aspect checks in SPEC-34b pass with `WILDCARD_EXCEPTION_SIDS` matching SPEC-59 §1.2 exactly
- Every Category A wildcard in SPEC-59 §1.1 has been replaced with a literal resource list
- Every interface VPC endpoint in SPEC-51 has both Check A (synth) and Check B (post-deploy probe) gating deploys
- The red-team SSRF corpus in SPEC-58 §9.7 is wired as a required CI check
- A golden pipeline run (SPEC-57) produces a byte-identical results document on two consecutive deploys
- A new engineer can run `skl init` and submit their first scan in <10 minutes (SPEC-56)
- The system survives a region-out DR drill (SPEC-37) without manual intervention
- The model lifecycle eval harness (SPEC-39, SPEC-47) gates production model swaps

Anything less is in-progress. There is no "good enough."

---

## 7. When You Get Stuck

- Cross-spec contradiction: read the later spec's `Supersedes` header; if it doesn't resolve, write a new audit spec.
- Unclear acceptance criterion: don't guess; the spec is wrong, fix the spec first.
- Hallucinated AWS API: stop, check AWS docs, then update the spec with the real shape.
- Aspect blocking a thing you "need": you don't need it. Find a scoped resource ARN.
- Claude session losing thread: split the work smaller; one spec section per turn.

The specs are dense on purpose. The density is what keeps a multi-month, multi-engineer, AI-assisted build coherent. Trust the gates.

---

## 8. Appendix A — 3-Day Layer 1 Bootstrap

The fastest path from empty repo to a deployed, gated foundation. This appendix is the **only** part of SPEC-00 that prescribes concrete commands; everything else in the spec set describes *what* to build, this describes *how to start*.

### A.0 Prerequisites
- **The user provides a throwaway AWS account** for testing. All deploys in this appendix target that account. Production accounts are out of scope until the system is built.
- Local: Node 20+, pnpm 9+, AWS CLI v2, CDK v2, `jq`, `git`.
- Set up:
  ```
  export AWS_PROFILE=skills-svc-throwaway
  export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  export CDK_DEFAULT_REGION=us-east-1
  aws sts get-caller-identity   # confirm throwaway account
  ```
- One-time: `cdk bootstrap aws://${CDK_DEFAULT_ACCOUNT}/${CDK_DEFAULT_REGION}`.

### A.1 Principles
1. **Deploy to the throwaway account from hour 1.** Synth-only is a lie; half the bugs surface only at deploy.
2. **Aspects and meta-tests before the resources they police.** Every subsequent commit is verified by construction.
3. **Tight Claude loop.** `cdk synth --strict && pnpm -w test` is the feedback signal. Don't let Claude make more than 2–3 changes between gate runs.
4. **No "tighten later."** SPEC-59 §1.1 scoping applies from the first IAM statement written.

### A.2 Hour 1 — Repo skeleton + CI gates
Workspace files: root `package.json` with pnpm workspaces, `tsconfig.base.json`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`.

CI must, on every push, run:
```
pnpm -w install --frozen-lockfile
pnpm -w typecheck
pnpm -w test
pnpm --filter @skills-svc/infra exec cdk synth --strict
```
Make this required before any other code lands.

**Claude prompt:**
> Scaffold a pnpm workspace with packages `@skills-svc/shared`, `@skills-svc/infra`, `@skills-svc/lambda`, `@skills-svc/ecs-runner`, `@skills-svc/cli`. Add `tsconfig.base.json` (strict, ES2022, NodeNext), per-package `tsconfig.json`, vitest config, and `.github/workflows/ci.yml` running the four gate commands above. No application code yet. Verify all four gates pass on an empty workspace.

### A.3 Day 1 morning — Branded types (SPEC-34a) + aspects (SPEC-34b) + meta-tests
Implement aspects **before** any resources. Write a meta-test stack that contains a deliberately bad construct (wildcard IAM, public subnet, unencrypted bucket) and assert each aspect rejects it.

**Claude prompt:**
> In `packages/shared/src/branded.ts`, implement branded types per SPEC-34a: `JobId`, `SkillId`, `CallerArn`, `UploadId`, `WorkflowId`. Each with a `make<X>` constructor that validates format and throws otherwise. Property tests in `packages/shared/src/__tests__/branded.property.ts` per SPEC-34c.
>
> In `packages/infra/lib/aspects/`, implement `NoWildcardIAMAspect`, `NoPublicSubnetAspect`, `KmsRequiredAspect`, `TlsOnlyAspect` per SPEC-34b. Default `strict: true` (no env override). Wildcard allowlist file `wildcard-allowlist.ts` with SIDs per SPEC-59 §1.2 exactly.
>
> In `packages/infra/test/aspects/`, write a meta-test that builds a deliberately bad stack (one wildcard IAM, one public subnet, one unencrypted bucket, one HTTP-only listener) and asserts each aspect fails synth. The test must pass — meaning the aspects must reject.

Gate: `pnpm -w test && pnpm --filter @skills-svc/infra exec cdk synth --strict` green.

### A.4 Day 1 afternoon — KMS keys + SSM exports (SPEC-01 §3)
Stack `KmsStack` creates the nine keys named in SPEC-59 §1.1 footer (`UploadsKmsKey`, `ResultsKmsKey`, `EnvKmsKey`, `DdbKmsKey`, `SkillRegistryKmsKey`, `OpenSearchKmsKey`, `AuditKmsKey`, `LogsKmsKey`, `DLQKmsKey`). Each has rotation enabled, a key policy granting only the deploy account root + (later) specific service principals, and exports its ARN to SSM at `/skills-svc/${env}/kms/${purpose}/arn`.

**Claude prompt:**
> Implement `packages/infra/lib/stacks/kms-stack.ts` creating the nine KMS keys listed in SPEC-59 §1.1 footer. Each: customer-managed, rotation on, deletion window 30 days, alias `alias/skills-svc/${env}/${purpose}`, ARN exported to SSM at `/skills-svc/${env}/kms/${purpose}/arn`. Key policies grant only `kms:*` to the account root for now; service principals added in their respective stacks. Synth test asserts nine keys exist with rotation enabled.

Deploy to the throwaway account: `cdk deploy SkillsSvc-Kms-dev`. Verify in console.

### A.5 Day 2 morning — VPC + endpoints (SPEC-01 §4 + SPEC-51 + SPEC-59 §3)
Single VPC, private isolated subnets only across 3 AZs, no NAT. Gateway endpoints for S3 and DDB. Interface endpoints for every service in SPEC-51 §2. Bedrock endpoint with the `AllowAnthropicAndTitanEmbed` + `DenyEverythingElse` policy SIDs per SPEC-59 §3.1.

**Claude prompt:**
> Implement `packages/infra/lib/stacks/network-stack.ts` per SPEC-01 §4 and SPEC-51:
> - VPC: 3 AZs, private isolated subnets only (no NAT, no public subnets), `enableDnsHostnames` + `enableDnsSupport`
> - Gateway endpoints: S3, DDB
> - Interface endpoints: KMS, Secrets Manager, SSM, ECR-API, ECR-DKR, STS, SQS, Logs, Monitoring, OpenSearch, Bedrock-Runtime
> - Bedrock-Runtime endpoint policy with `AllowAnthropicAndTitanEmbed` + `DenyEverythingElse` SIDs per SPEC-59 §3.1
> - Each endpoint policy requires `aws:PrincipalAccount = this.account` and `aws:SecureTransport = true`
> - Security groups: `lambdaSg`, `ecsTaskSg`, `bedrockEndpointSg` (allows 443 only from lambdaSg + ecsTaskSg)
>
> Synth tests per SPEC-59 §3.2 Check A (Bedrock endpoint shape) and SPEC-59 §4 (synth assertions for every endpoint).

Deploy. Confirm endpoints created, policies attached.

### A.6 Day 2 afternoon — IAM roles (SPEC-45 + SPEC-59 §1.1)
Three roles: `UserRole` (assumed by CLI), `EcsTaskRole`, `McpLambdaRole`. Every KMS statement uses the literal SSM-resolved ARN, never `*`. Every Category B wildcard carries `aws:RequestedRegion` + namespace/tag conditions per SPEC-59 §1.2.

**Claude prompt:**
> Implement `packages/infra/lib/stacks/iam-stack.ts` per SPEC-45 with SPEC-59 §1.1 scoping applied from the first statement. For each of `UserRole`, `EcsTaskRole`, `McpLambdaRole`:
> - Resolve KMS key ARNs via `ssm.StringParameter.valueFromLookup(...)` at synth (literal ARNs in template, not tokens)
> - Every `kms:Decrypt`/`kms:GenerateDataKey` statement names specific keys, never `*`
> - Every Category B statement (XRay, CW metrics, CT lookup, Comprehend PII, Bedrock list, EC2 describe) carries `aws:RequestedRegion` + namespace/tag conditions per SPEC-59 §1.2
> - The aspect from §A.3 must pass — if it fails, fix the role, not the aspect
>
> Tests: `iam-resource-scope.test.ts` asserts no wildcards outside allowlist; `kms-key-scoping.test.ts` asserts literal ARN strings.

Deploy. The aspect should pass on first synth; if it doesn't, the spec wasn't followed.

### A.7 Day 3 morning — Buckets, DDB, OpenSearch (SPEC-01 §5 + SPEC-06)
Four buckets (uploads, results, review-artifacts, audit-logs), one DDB table (single-table per SPEC-01 §5), one OpenSearch Serverless VECTOR collection. All KMS-encrypted with the right keys from §A.4. Bucket policies require `aws:SecureTransport: true` and `s3:x-amz-server-side-encryption: aws:kms`. Block-public-access on all buckets. DDB PITR on.

**Claude prompt:**
> Implement `packages/infra/lib/stacks/data-stack.ts` per SPEC-01 §5:
> - Four S3 buckets each with the corresponding KMS key from KmsStack, block-public-access, TLS-only + KMS-required bucket policies, lifecycle rules per SPEC-06
> - One DynamoDB table per SPEC-01 §5 single-table design, PITR on, KMS with DdbKmsKey, GSI1 (status) + GSI2 (user)
> - One OpenSearch Serverless collection (VECTOR type) with the index template per SPEC-03, KMS with OpenSearchKmsKey, data access policy granting only EcsTaskRole + McpLambdaRole
>
> Tests: `bucket-policies.test.ts` asserts TLS + KMS conditions on every bucket; `ddb-pitr.test.ts` asserts PITR on; `opensearch-encryption.test.ts` asserts CMK encryption.

### A.8 Day 3 afternoon — Hardening + Bedrock reachability probe
SPEC-06: enable GuardDuty, Security Hub (with AWS Foundational + CIS standards), CloudTrail (organization trail not required for throwaway, account-level fine), AWS Config with the `bedrock-endpoint-policy-immutable` rule per SPEC-59 §3.3.

Then run SPEC-59 §3.2 **Check B** post-deploy probe:
- Probe 1: invoke `anthropic.claude-haiku-4-5-20251001` → succeeds
- Probe 2: invoke `mistral.mixtral-8x7b-instruct-v0:1` → denied by endpoint policy
- Probe 3: DNS resolution of `bedrock-runtime.${region}.amazonaws.com` from inside the VPC returns RFC1918 only

**Claude prompt:**
> Implement `packages/infra/lib/stacks/hardening-stack.ts` per SPEC-06: GuardDuty detector, Security Hub with AWS Foundational + CIS, account-level CloudTrail to the audit-logs bucket, AWS Config with the `bedrock-endpoint-policy-immutable` rule + auto-remediation Lambda per SPEC-59 §3.3.
>
> Then implement `packages/infra/test/post-deploy/bedrock-reachability.ts` as a one-shot Lambda placed in the VPC with lambdaSg, executing the three probes from SPEC-59 §3.2 Check B. The CodeBuild deploy step runs this Lambda after `cdk deploy` and rolls back if any probe fails.

Deploy. **If Check B goes green, Layer 1 is real.** That is the line.

### A.9 Layer 1 Acceptance Gate
Before starting Layer 2, all of these must be true in the throwaway account:
- [ ] `cdk synth --strict` passes for every stack
- [ ] The aspect meta-test (§A.3) still rejects deliberately bad input
- [ ] All nine KMS keys exist with rotation on, ARNs in SSM
- [ ] VPC has zero public subnets, zero NAT gateways, zero internet gateways
- [ ] Every interface endpoint has a policy with `aws:PrincipalAccount` + `aws:SecureTransport` conditions
- [ ] Bedrock endpoint policy contains both `AllowAnthropicAndTitanEmbed` and `DenyEverythingElse` SIDs
- [ ] `bedrock-reachability` post-deploy probe — all three sub-probes green
- [ ] No `Resource: "*"` in any IAM statement outside `WILDCARD_EXCEPTION_SIDS`
- [ ] Every Category B wildcard carries the required conditions per SPEC-59 §1.2
- [ ] GuardDuty + Security Hub + CloudTrail + Config rule deployed and reporting
- [ ] CI pipeline blocks PRs that violate any gate above

When this list is fully checked, the foundation is real and Layer 2 (the pipeline) can begin per §3 of this spec.

### A.10 Cost & Cleanup
The throwaway account will accrue: VPC endpoints (~$0.01/hr each × ~12 endpoints ≈ $90/mo), GuardDuty (~$5–20/mo on light traffic), Security Hub (~$3/mo), OpenSearch Serverless (1 OCU minimum ≈ $175/mo).

If pausing between Layer 1 and Layer 2 for more than a day, run `cdk destroy --all` on the throwaway account to avoid OpenSearch + endpoint charges. SSM-stored KMS ARNs vanish; the next bootstrap re-creates them.
