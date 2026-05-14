# SPEC-45 — Identity, Authorization & Access

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-06 (security)
**Related:** SPEC-38 (governance), SPEC-40 (threat model)

> Single-tenant. Multiple humans (engineers, on-call, security, skill authors, auditors) and machine principals.

---

## 1. Human Identity

- **Authoritative IdP:** AWS IAM Identity Center, federated to corporate IdP via SAML/OIDC
- **No IAM users.** All human access via SSO + STS
- **Permission Sets:** Engineer, OnCall, SecurityReviewer, SkillAuthor, Auditor, BreakGlass

---

## 2. Persona × Permission Matrix

| Action                       | Engineer | OnCall | SecurityReviewer | SkillAuthor | Auditor | BreakGlass |
|------------------------------|---------:|-------:|-----------------:|------------:|--------:|-----------:|
| Upload job                   | ✔ | ✔ | ✔ | ✔ |   |   |
| Read job results             | ✔ | ✔ | ✔ |   |   | ✔ |
| Query knowledge store        | ✔ | ✔ | ✔ |   |   | ✔ |
| Deploy non-prod              | ✔ |   |   |   |   |   |
| Deploy prod                  |   |   |   |   |   | ✔ (via JIT) |
| Read DDB jobs table          | ✔ | ✔ | ✔ |   |   | ✔ |
| Read S3 results              | ✔ | ✔ | ✔ |   |   | ✔ |
| Read audit log               |   |   |   |   | ✔ |   |
| Manage skills registry       |   |   | ✔ | ✔ |   |   |
| Rotate KMS keys              |   |   |   |   |   | ✔ |
| Modify IAM/Cedar policies    |   |   |   |   |   | ✔ |
| Read GuardDuty findings      |   | ✔ | ✔ |   | ✔ |   |

---

## 3. Machine Identity

- One IAM role per Lambda + ECS task + ECS task execution
- All resource-scoped + condition-keyed
- GitHub Actions OIDC role per workflow, sub-claim constrained:

```json
{
  "Effect": "Allow",
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:org/skills-svc:ref:refs/heads/main" }
  }
}
```

Separate role for prod deploys with `:environment:prod` sub claim → requires environment reviewers in GH Actions.

---

## 4. ABAC Strategy

Session tags propagated from Identity Center:

```json
{ "principalTag/persona": "SecurityReviewer", "principalTag/department": "eng" }
```

IAM policies reference tags:

```json
{
  "Effect": "Allow",
  "Action": "s3:GetObject",
  "Resource": "arn:aws:s3:::skills-svc-results/*",
  "Condition": {
    "StringEquals": {
      "aws:PrincipalTag/persona": ["SecurityReviewer", "Auditor", "OnCall", "Engineer"]
    }
  }
}
```

Resource tags enforced via CDK Aspect (SPEC-41 §11). Tag-on-create enforced via permission boundary.

---

## 5. Application-Level Authz with Cedar

```cedar
// packages/shared/authz/policies/jobs.cedar

permit (
  principal,
  action == Action::"ReadJob",
  resource is Job
) when {
  resource.submitted_by == principal.id
  || principal.persona == "Auditor"
  || (principal.persona == "OnCall" && resource.age_days < 7)
};

forbid (
  principal,
  action,
  resource
) unless {
  principal has persona
};
```

Evaluated in Lambda authorizer:

```ts
// packages/lambda/authorizer/index.ts
import { Cedar } from '@cedar-policy/cedar-wasm';
const cedar = new Cedar({ policies: loadPolicies(), entities: loadEntities() });
export const handler = async (event: AuthEvent) => {
  const decision = cedar.isAuthorized({
    principal: { type: 'User', id: event.userId, attrs: { persona: event.persona } },
    action:    { type: 'Action', id: event.action },
    resource:  { type: 'Job', id: event.jobId, attrs: { submitted_by: event.submitter, age_days: ageDays(event.jobCreatedAt) } },
  });
  if (decision.decision !== 'Allow') return { isAuthorized: false };
  return { isAuthorized: true };
};
```

Policy unit tests under `packages/shared/authz/tests/`. Target ≥ 90% policy coverage (Cedar's policy-coverage tool).

---

## 6. Break-Glass Access

Workflow (Step Function `break-glass-grant`):
1. Engineer submits request with ticket ref
2. Notification to approver group (Slack + email)
3. **2-person approval** (engineer cannot approve own)
4. Time-bound grant: 4 h max via Identity Center temporary assignment
5. Session is recorded (CloudTrail + optional SSM Session Manager logs)
6. Auto-revoke at expiry
7. Auto-generate postmortem stub linked to the ticket

```ts
// infra/lib/iam/break-glass.ts
new sfn.StateMachine(this, 'BreakGlassGrant', {
  definitionBody: sfn.DefinitionBody.fromFile('infra/lib/iam/break-glass.asl.json'),
  tracingEnabled: true,
});
```

---

## 7. Credential Lifetime

- STS session: 1 h default, 4 h max
- No static keys anywhere (CDK Aspect rejects `aws_access_key_id` env vars)
- IdP signing cert rotation: 90 d
- Identity Center SCIM token: stored in Secrets Manager with auto-rotation

---

## 8. MFA

- Identity Center requires MFA for every sign-in
- WebAuthn / FIDO2 preferred (phishing-resistant)
- Conditional access: prod permission sets require WebAuthn (TOTP not accepted)

---

## 9. CLI Auth Flow

```bash
$ skills-svc login
Opening browser for Identity Center device flow...
✔ Signed in as alice@example.com (persona=Engineer)
Token cached at ~/.skills-svc/cache/sso.json (mode 0600)
Expires: 2026-05-13T17:00:00Z
```

Under the hood: SSO OIDC device flow → SSO cache → `sts:AssumeRoleWithSAML` (or `assume-role-with-sso`). Cache file mode 0600. `skills-svc logout` purges.

---

## 10. Permission Boundary

Every role created in this account attaches a permission boundary `skills-svc-boundary`:

```json
{
  "Effect": "Deny",
  "Action": [
    "iam:Create*", "iam:Delete*", "iam:Update*", "iam:Put*", "iam:Attach*",
    "kms:Disable*", "kms:Schedule*", "kms:Put*",
    "cloudtrail:Stop*", "cloudtrail:Delete*",
    "guardduty:Disable*", "guardduty:Delete*",
    "config:Stop*", "securityhub:Disable*"
  ],
  "Resource": "*",
  "Condition": { "StringNotEquals": { "aws:PrincipalTag/persona": "BreakGlass" } }
}
```

Even an admin must JIT-elevate to BreakGlass to bypass.

---

## 11. MCP Server Authn/Authz

- **HTTP transport:** API Gateway with `AWS_IAM` auth → SigV4 → Lambda authorizer (Cedar)
- **stdio transport:** local process credentials (parent process must have valid SSO session); rejects on TTY-only debug calls in non-dev

```ts
// packages/mcp-server/src/auth.ts
async function authn(req: McpReq): Promise<Principal> {
  if (req.transport === 'http') return verifySigV4(req); // returns IAM principal + session tags
  return localProcessIdentity();
}
```

---

## 12. Skill Author Identity

- OIDC enrollment (GitHub or corp IdP)
- Cosign keyless signing with their identity (SPEC-40 §7)
- Registry verifies `cert-identity` matches enrolled author
- Author can be revoked; cosign verify then fails

---

## 13. Audit-Only Role

`Auditor` Permission Set:
- `arn:aws:iam::aws:policy/ReadOnlyAccess`
- + `s3:GetObject` on audit-log bucket only
- - any access to primary data buckets (explicit deny)
- All reads logged via CloudTrail data events

---

## 14. Access Reviews

```ts
// packages/lambda/access-review/index.ts
// Quarterly: enumerate Identity Center assignments + IAM roles + Cedar policies
// Output: report to s3://skills-svc-access-reviews/YYYY-QQ/
// Create ticket per persona owner to approve/revoke
// Unreviewed access auto-disabled after 7-day grace
```

Trigger via EventBridge cron `cron(0 9 1 1,4,7,10 ? *)`.

---

## 15. VPC Endpoint Policies

```ts
new ec2.InterfaceVpcEndpoint(this, 'BedrockEndpoint', {
  vpc,
  service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
  policyDocument: new iam.PolicyDocument({ statements: [
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [new iam.AnyPrincipal()],
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:PrincipalArn': ecsTaskRole.roleArn } },
    }),
  ]}),
});
```

Only the ECS task role can invoke Bedrock through this endpoint.

---

## 16. Cross-Account Boundary

- **prod** account isolated from **dev** account
- CI deploys via dedicated cross-account `skills-svc-deploy-prod` role with permission boundary
- Humans never have direct write to prod (only JIT via BreakGlass)

---

## 17. Secrets vs Config

- **Secrets Manager:** actual secrets only (API keys, signing certs)
- **AppConfig:** feature flags + non-secret config (model defaults, OCU caps)
- **Never env vars** for secrets — CDK Aspect rejects suspicious env-var names (`*_KEY`, `*_SECRET`, `*_TOKEN`):

```ts
// infra/lib/iam/no-secret-env-aspect.ts
class NoSecretEnvAspect implements IAspect {
  visit(node: IConstruct) {
    if (node instanceof lambda.Function) {
      const env = (node as any).environment;
      for (const k of Object.keys(env ?? {})) {
        if (/(KEY|SECRET|TOKEN|PASSWORD)/i.test(k) && !k.startsWith('PUBLIC_')) {
          Annotations.of(node).addError(`Suspicious env var: ${k} — use Secrets Manager`);
        }
      }
    }
  }
}
```

---

## 18. Just-in-Time Elevation

Engineer requests prod write:
1. CLI: `skills-svc jit request --resource prod --duration 1h --reason "deploy 1.5.0"`
2. Ticket auto-created, approvers paged
3. Approver clicks → Step Function `jit-grant` assigns temporary permission set
4. Engineer assumes role via SSO
5. Auto-revoke at 1 h regardless of state-machine state (Identity Center handles expiry)
6. Activity logged + linked to ticket

---

## 19. Auth Observability

```sql
-- Athena queries against CloudTrail logs (infra/lib/iam/athena-queries.sql)
-- Q1: Sign-ins outside business hours
SELECT useridentity.principalid, eventtime
FROM cloudtrail WHERE eventname = 'AssumeRoleWithSAML'
  AND hour(from_iso8601_timestamp(eventtime)) NOT BETWEEN 8 AND 19;

-- Q2: Role-chaining depth > 2
SELECT ... -- chained AssumeRole calls within 1h

-- Q3: AccessDenied spikes
SELECT eventname, count(*) FROM cloudtrail
WHERE errorcode = 'AccessDenied' AND eventtime > now() - interval '1' hour
GROUP BY eventname HAVING count(*) > 100;
```

Each saved query alarms via CW Insights → SNS.

---

## 20. Threat Scenarios → Mitigations

| Scenario                         | Mitigation                                          |
|----------------------------------|-----------------------------------------------------|
| Phished engineer                 | WebAuthn MFA; short sessions; conditional access     |
| Leaked CI token                  | OIDC only (no static token); sub-claim restriction   |
| Compromised dev workstation      | SSO token TTL 1 h; permission boundary; CloudTrail   |
| Malicious insider auditor        | Audit role read-only + audit-bucket only; their reads audited |
| Privilege escalation via IAM     | Permission boundary denies iam:Create*               |
| KMS key disable attempt          | Permission boundary; alarm on key policy change      |
| Cedar policy bypass              | Cedar policies hashed + signed; CI gate              |

---

## 21. Acceptance Criteria

- [ ] Zero IAM users in account
- [ ] All roles have permission boundary attached
- [ ] Cedar policy unit tests ≥ 90% coverage
- [ ] Identity Center MFA enforced
- [ ] CLI SSO flow works on all dev OSes
- [ ] BreakGlass tested with audit trail
- [ ] Quarterly access review completed
- [ ] VPC endpoint policies restrict to expected roles
- [ ] JIT elevation drilled
- [ ] CloudTrail Athena queries scheduled
- [ ] All threat scenarios mapped to live controls
