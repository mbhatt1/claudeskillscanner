# SPEC-59: Production IAM Tightening + Bedrock Endpoint Validation

**Status:** AUTHORITATIVE — supersedes wildcard IAM policies in prior specs
**Depends on:** SPEC-01 (overview), SPEC-06 (security hardening), SPEC-34b (CDK aspects), SPEC-45 (identity), SPEC-51 (network)
**Supersedes (in part):** every `resources: ['*']` flagged "tighten in production" or "tighten later" in SPEC-09, SPEC-10, SPEC-25, SPEC-29, SPEC-31, SPEC-33, SPEC-45

This repo is a spec repo and the system is production. There is no "later." This spec is the canonical IAM resource scope for every Lambda/ECS/IAM principal in the system, plus the deploy-time validation that keeps it that way.

---

## 1. Wildcard Audit — Categorized

Inventory taken 2026-05-13. Every `resources: ['*']` in the spec set falls into one of two categories.

### 1.1 Category A — Must be tightened (this spec does it)

| Location | Action(s) | Why it was loose | Tightened resource |
|---|---|---|---|
| SPEC-09 §1 `KMSDecrypt` | `kms:Decrypt`, `kms:GenerateDataKey` | "restrict to specific key ARNs in production" | `${UploadsKmsKey.arn}`, `${ResultsKmsKey.arn}`, `${EnvKmsKey.arn}`, `${DdbKmsKey.arn}` |
| SPEC-29 §1 `KMSCrypto` | `kms:Decrypt`, `kms:GenerateDataKey` | "tighten to specific key ARNs in production" | same four key ARNs as above |
| SPEC-31 §2 (KMS in MCP) | `kms:Decrypt`, `kms:GenerateDataKey` | comment "tighten later" + aspect violation | same four key ARNs |
| SPEC-45 §3 (Bedrock invoke condition) | `bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream` | resource `*` with PrincipalArn condition | `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-*`, `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0` |
| SPEC-10 §3 (skill validator KMS) | `kms:Decrypt` | inherited wildcard | `${SkillRegistryKmsKey.arn}` |
| SPEC-33 §4 (results processor KMS) | `kms:Decrypt`, `kms:GenerateDataKey` | inherited wildcard | `${ResultsKmsKey.arn}`, `${OpenSearchKmsKey.arn}` |
| SPEC-22 §3 (ECS task role KMS) | `kms:Decrypt`, `kms:GenerateDataKey` | not yet scoped | `${UploadsKmsKey.arn}`, `${ResultsKmsKey.arn}` |
| SPEC-15 §2 (DLQ KMS, results KMS, logs KMS — three sites) | `kms:Decrypt`, `kms:GenerateDataKey` | not yet scoped | per-stack key ARN (DLQ key, results key, logs key respectively) |
| SPEC-23 §2 (cross-region key references) | `kms:Decrypt` | scoped to `*` for multi-region | replica key ARN per region from SSM param `/skills-svc/${env}/kms/${purpose}/${region}` |
| SPEC-25 §6 (webhook Lambda — not XRay; the S3 read for review artifacts) | `s3:GetObject` | wildcard prefix | `${ReviewArtifactsBucket.arn}/reviews/*` |
| SPEC-24 §5 (ECS describe) | `ecs:DescribeTasks`, `ecs:DescribeTaskDefinition` | wildcard | `arn:aws:ecs:${region}:${account}:task/${ClusterName}/*`, `arn:aws:ecs:${region}:${account}:task-definition/skills-runner:*` |
| SPEC-24 §5 (CloudTrail PutEvents) | `cloudtrail:PutEventsForLookup` | this *was* mislabeled — there is no such action; the wildcard there was actually `s3:GetObject` against the trail bucket | `${TrailBucket.arn}/AWSLogs/${account}/*` |
| SPEC-06 §9 (rare audit Lambda KMS) | `kms:Decrypt` | wildcard | `${AuditKmsKey.arn}` |

KMS keys referenced above are the named keys created in SPEC-01 §3 (`UploadsKmsKey`, `ResultsKmsKey`, `EnvKmsKey`, `DdbKmsKey`, `SkillRegistryKmsKey`, `OpenSearchKmsKey`, `AuditKmsKey`, `LogsKmsKey`, `DLQKmsKey`). Each stack imports the ARNs from SSM at synth time:

```ts
const uploadsKeyArn = ssm.StringParameter.valueFromLookup(this, '/skills-svc/prod/kms/uploads/arn');
```

`valueFromLookup` resolves at synth so the resulting policy contains the literal ARN, not a CloudFormation runtime token. This matters because the no-wildcard aspect (SPEC-34b) inspects the synthesized template.

### 1.2 Category B — Permanent AWS-mandated wildcards (allowlisted, not removed)

These actions have no resource-level support in AWS IAM. They stay as `resources: ['*']` and are added to the `WILDCARD_EXCEPTION_SIDS` allowlist in the no-wildcard aspect (SPEC-31 §2 already started this list — extend it).

| SID | Action(s) | AWS reason |
|---|---|---|
| `XRayWrite` | `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | XRay has no resource-level support |
| `CloudWatchMetrics` | `cloudwatch:PutMetricData` | scoped by `cloudwatch:namespace` condition, not resource ARN |
| `CloudTrailLookup` | `cloudtrail:LookupEvents` | trail-level read, no resource ARN |
| `ComprehendPII` | `comprehend:DetectPiiEntities`, `comprehend:ContainsPiiEntities` | no resource-level support |
| `BedrockListFoundationModels` | `bedrock:ListFoundationModels` | catalog-wide read, no resource ARN |
| `EC2DescribeForVPC` | `ec2:DescribeNetworkInterfaces`, `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeSecurityGroups` | required by Lambda-in-VPC, no resource-level support |

Each Category B statement **must** carry an `aws:RequestedRegion` condition restricting to the deploy region, and where applicable a tag/namespace condition:

```ts
new iam.PolicyStatement({
  sid: 'CloudWatchMetrics',
  actions: ['cloudwatch:PutMetricData'],
  resources: ['*'],
  conditions: {
    StringEquals: {
      'aws:RequestedRegion': this.region,
      'cloudwatch:namespace': ['SkillsSvc/MCP', 'SkillsSvc/Pipeline'],
    },
  },
});
```

Any new wildcard not in Category B fails synth.

---

## 2. The Aspect Becomes Strict, By Default

`NoWildcardIAMAspect` (SPEC-34b) currently warns; some stacks bypass with `STRICT=false`. Change:

1. **Default `strict: true`.** No env-var override. The only way to add a new wildcard is a new SID in `WILDCARD_EXCEPTION_SIDS` *with a justification comment that includes an AWS docs link*.
2. Aspect runs in **two passes**:
   - Pass 1: scan all `AWS::IAM::Policy` and `AWS::IAM::ManagedPolicy` for `Resource: "*"` or `Resource: ["*"]`.
   - Pass 2: walk statements by `Sid`; if `Sid` not in allowlist → fail synth with the offending stack/construct path.
3. Aspect also rejects `NotResource: ["*"]`, `Action: "*"`, `Action: "iam:*"`, `Action: "kms:*"`, and any `Principal: "*"` without a `Condition`.
4. `cdk synth` is run in CI **with `--strict`**; PR check is required.

The allowlist file lives at `infra/lib/aspects/wildcard-allowlist.ts`:

```ts
export const WILDCARD_EXCEPTION_SIDS: ReadonlySet<string> = new Set([
  'XRayWrite',
  'CloudWatchMetrics',
  'CloudTrailLookup',
  'ComprehendPII',
  'BedrockListFoundationModels',
  'EC2DescribeForVPC',
]);
```

Adding to this set requires a security review approver tag on the PR (CODEOWNERS).

---

## 3. Bedrock VPC Endpoint — Validated, Not Assumed

The earlier gap: if the Bedrock interface endpoint is missing or misconfigured, the system *fails closed* (good) but no automated check confirms the endpoint exists, has the right policy, and is reachable from the right SGs.

### 3.1 Required endpoint configuration

In `infra/lib/network-stack.ts` (extends SPEC-51):

```ts
const bedrockEp = new ec2.InterfaceVpcEndpoint(this, 'BedrockRuntimeEp', {
  vpc,
  service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
  privateDnsEnabled: true,
  subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, onePerAz: true },
  securityGroups: [bedrockEndpointSg],
});

bedrockEp.addToPolicy(new iam.PolicyStatement({
  sid: 'AllowAnthropicAndTitanEmbed',
  principals: [new iam.AnyPrincipal()],
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: [
    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`,
    `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
  ],
  conditions: {
    StringEquals: { 'aws:PrincipalAccount': this.account },
    Bool:         { 'aws:SecureTransport': 'true' },
  },
}));

bedrockEp.addToPolicy(new iam.PolicyStatement({
  sid: 'DenyEverythingElse',
  effect: iam.Effect.DENY,
  principals: [new iam.AnyPrincipal()],
  actions: ['bedrock:*'],
  notResources: [
    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-*`,
    `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
  ],
}));
```

The endpoint policy itself becomes a second layer of model allowlisting — even if the Lambda's IAM policy drifts, the endpoint refuses non-allowlisted models.

`bedrockEndpointSg` allows 443 only from `lambdaSg` and `ecsTaskSg`.

### 3.2 Deploy-time validation (the missing piece)

Two new checks run in the **deploy pipeline**, both blocking.

**Check A — Synth-time CDK assertion** (`infra/test/synth/bedrock-endpoint.test.ts`):
- Template contains exactly one `AWS::EC2::VPCEndpoint` with `ServiceName` matching `bedrock-runtime`
- `PrivateDnsEnabled: true`
- Subnet list size equals number of AZs (3 in prod)
- Endpoint policy contains both `AllowAnthropicAndTitanEmbed` and `DenyEverythingElse` SIDs
- Security group ingress restricted to `lambdaSg` and `ecsTaskSg` on tcp/443
- Snapshot match on policy JSON

**Check B — Post-deploy smoke test** (`infra/test/post-deploy/bedrock-reachability.ts`), invoked by CodeBuild after `cdk deploy`:

```ts
// Runs in a one-shot Lambda placed in the same VPC/SG as the MCP Lambda.
const client = new BedrockRuntimeClient({});

// Probe 1: allowed model — should succeed
await client.send(new InvokeModelCommand({
  modelId: 'anthropic.claude-haiku-4-5-20251001',
  body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, anthropic_version: 'bedrock-2023-05-31' }),
  contentType: 'application/json',
}));

// Probe 2: non-allowlisted model — should be denied by endpoint policy, not by IAM
await expect(client.send(new InvokeModelCommand({
  modelId: 'mistral.mixtral-8x7b-instruct-v0:1',
  body: JSON.stringify({ prompt: 'ping', max_tokens: 1 }),
  contentType: 'application/json',
}))).rejects.toMatchObject({ name: 'AccessDeniedException' });

// Probe 3: DNS resolves to the private endpoint, not the public IP
const ip = await dns.resolve4('bedrock-runtime.us-east-1.amazonaws.com');
expect(ip.every(isRfc1918)).toBe(true);
```

If any probe fails, the deploy is rolled back via CodeDeploy alarm. The probe Lambda is destroyed after success to remove the dangling permission.

### 3.3 Ongoing validation

- **Synthetic monitor** (SPEC-52): probes 1–3 above run every 5 min from a canary Lambda. Alarm on 2 consecutive failures pages oncall.
- **Config rule** `bedrock-endpoint-policy-immutable` — AWS Config detects drift on the endpoint policy and reverts within 10 min (auto-remediation Lambda re-applies the canonical policy from SSM).

---

## 4. Other VPC Endpoints — Same Treatment

Extend §3 to every interface endpoint declared in SPEC-51: KMS, Secrets Manager, SSM, ECR-API, ECR-DKR, STS, SQS, Logs, Monitoring, OpenSearch. Each gets:

1. An endpoint policy that scopes principals to `aws:PrincipalAccount = this.account` and requires `aws:SecureTransport: true`.
2. A synth-time test asserting endpoint presence + policy SIDs.
3. A post-deploy reachability probe (one allowed call, one denied call).

Gateway endpoints (S3, DDB) get policy + reachability probe but no SG (gateway endpoints don't have ENIs).

---

## 5. CI Gates (Required Checks)

The following PR checks must be required on `main`:

- `cdk synth --strict` passes (no wildcard outside allowlist)
- `wildcard-allowlist-changed` — if `wildcard-allowlist.ts` diff is non-empty, requires `security-review` CODEOWNERS approval
- `iam-resource-scope.test.ts` — for every Lambda's role, asserts that for each (Sid, Action) the Resource is not `*` unless Sid ∈ allowlist
- `bedrock-endpoint.test.ts` (§3.2 Check A)
- `vpc-endpoints.test.ts` (§4 synth tests)

Post-deploy:
- `post-deploy/bedrock-reachability.ts` (§3.2 Check B) — gates the canary → live cutover
- All other endpoint reachability probes (§4)

---

## 6. Migration / Application to Existing Specs

This spec **overrides** the wildcard policy in the cells listed in §1.1. Implementors must:

1. Replace each Category A wildcard with the tightened resource list from the table.
2. Add `aws:RequestedRegion` + namespace/tag conditions to each Category B statement.
3. Re-synth; verify aspect passes; verify per-Lambda integration tests (Lambda can still read the keys it needs, denied for keys it doesn't).
4. Add an explicit ADR row in `docs/adr/059-iam-tightening.md` recording the exception list with AWS docs links.

Cross-region replica keys: each region's stack reads its own SSM parameter; no cross-region wildcards.

---

## 7. Tests

### 7.1 Synth tests (block PR)
- `wildcard-aspect.test.ts` — table-driven: for every stack, synth and assert zero wildcards outside allowlist
- `category-b-conditions.test.ts` — for every allowlisted SID, assert presence of `aws:RequestedRegion`, and tag/namespace condition where applicable
- `kms-key-scoping.test.ts` — for every Lambda role using KMS, assert Resource list is a non-empty array of literal `arn:aws:kms:*:*:key/...` strings (no tokens, no wildcards)
- `bedrock-endpoint.test.ts` — §3.2 Check A
- `vpc-endpoints.test.ts` — §4 synth assertions for each endpoint

### 7.2 Integration tests (deployed env)
- `kms-cross-key-denied.test.ts` — MCP Lambda attempts to decrypt with a non-allowlisted KMS key → denied
- `bedrock-non-allowlisted-model.test.ts` — invoke Mixtral via the endpoint → `AccessDeniedException` from endpoint policy, not from IAM (assert error origin via the response trace)
- `bedrock-public-endpoint-unreachable.test.ts` — from the MCP Lambda's VPC, resolving `bedrock-runtime.${region}.amazonaws.com` returns only RFC1918 addresses
- `endpoint-cross-account.test.ts` — call from a second account's role → denied by `aws:PrincipalAccount` condition

### 7.3 Drift tests (continuous)
- AWS Config rule `bedrock-endpoint-policy-immutable` — test by mutating the endpoint policy in a dev env and asserting auto-remediation within 10 min
- `wildcard-introduced.test.ts` — synthetic PR that adds a new wildcard outside the allowlist; assert CI rejects it (run as a meta-test in the platform repo)

### 7.4 Negative tests (must reject)
- Adding a SID to `WILDCARD_EXCEPTION_SIDS` without CODEOWNERS approval → CI fails on the `wildcard-allowlist-changed` check
- A statement with `Action: "kms:*"` → aspect fails synth
- A statement with `Principal: "*"` and no `Condition` → aspect fails synth

---

## 8. Acceptance Criteria

- [ ] Every Category A wildcard listed in §1.1 replaced with a literal resource list in the referenced spec section's implementation
- [ ] Every Category B wildcard carries `aws:RequestedRegion` + applicable namespace/tag condition
- [ ] `WILDCARD_EXCEPTION_SIDS` set matches §1.2 exactly
- [ ] `cdk synth --strict` passes for every stack with zero suppressions
- [ ] Bedrock VPC endpoint has `AllowAnthropicAndTitanEmbed` + `DenyEverythingElse` policy SIDs
- [ ] §3.2 Check A and Check B both gating deploy
- [ ] §4 reachability probes implemented for every interface endpoint declared in SPEC-51
- [ ] AWS Config rule `bedrock-endpoint-policy-immutable` deployed with auto-remediation
- [ ] CODEOWNERS gate on `infra/lib/aspects/wildcard-allowlist.ts`
- [ ] ADR `docs/adr/059-iam-tightening.md` written and merged
