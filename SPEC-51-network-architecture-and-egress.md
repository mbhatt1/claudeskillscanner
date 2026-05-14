# SPEC-51 — Network Architecture, Transit Gateway & Egress Control

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-06, SPEC-37 (multi-region)
**Related:** SPEC-40 (threat model), SPEC-45 (authz)

---

## 1. Current State & Target State

**Current (per SPEC-01):** single VPC, private subnets only, VPC gateway endpoints (S3/DDB), interface endpoints (Bedrock, KMS, ECR, …), no NAT, no public subnets.

**Target (this spec):**
- Hub-and-spoke via **Transit Gateway** so additional VPCs (DR region, partner integrations, dev sandboxes) attach uniformly
- **Egress firewall (AWS Network Firewall)** in front of any future internet egress (when needed for partner integrations / skill author webhooks)
- **PrivateLink** services for partners who need to invoke us
- **Centralized DNS** via Route 53 Resolver endpoints

---

## 2. Address Plan

| VPC                   | CIDR              | AZs | Purpose                  |
|-----------------------|-------------------|-----|--------------------------|
| prod-us-east-1        | 10.10.0.0/16      | 3   | Primary                  |
| prod-us-west-2        | 10.20.0.0/16      | 3   | Warm standby (SPEC-37)   |
| egress-us-east-1      | 10.0.0.0/22       | 3   | Network Firewall, NAT    |
| egress-us-west-2      | 10.0.4.0/22       | 3   | Network Firewall, NAT    |
| sandbox-dev           | 10.30.0.0/16      | 3   | Per-PR previews          |
| shared-services       | 10.5.0.0/20       | 3   | Centralized DNS, logging |

No overlap. Documented in `docs/network/address-plan.md`. Allocated via IPAM.

---

## 3. Transit Gateway

```ts
// infra/lib/network/tgw.ts
const tgw = new ec2.CfnTransitGateway(this, 'Tgw', {
  amazonSideAsn: 64512,
  description: 'skills-svc hub',
  autoAcceptSharedAttachments: 'enable',
  defaultRouteTableAssociation: 'disable',
  defaultRouteTablePropagation: 'disable',
  multicastSupport: 'disable',
  dnsSupport: 'enable',
});
```

**Route tables** (segmentation):
- `rt-prod` — prod-* VPCs + egress-*
- `rt-sandbox` — sandbox-dev only (cannot reach prod)
- `rt-shared` — shared-services + all others (one-way: prod → shared)

Sandbox cannot route to prod (explicit deny via separate RT). Cross-account TGW shared via RAM with the prod account.

---

## 4. Egress Strategy

Default: **no internet egress** from compute. All AWS APIs reach via interface endpoints.

For the cases that require internet (skill webhooks, future partner integrations):

```ts
// infra/lib/network/egress-vpc.ts
const fw = new networkfirewall.CfnFirewall(this, 'EgressFw', {
  firewallName: 'skills-svc-egress',
  firewallPolicyArn: fwPolicy.attrFirewallPolicyArn,
  vpcId: egressVpc.vpcId,
  subnetMappings: egressSubnets.map(s => ({ subnetId: s.subnetId })),
  deleteProtection: true,
});
```

Firewall policy:
- **Stateful suricata rules** with FQDN allow-list (e.g. `api.github.com`, `hooks.slack.com`).
- **Stateless** blocks: TCP 1-1024 except 443; ICMP rate-limited.
- **TLS inspection** (with private CA) for outbound integrations — opt-in per VPC.

Egress logging → S3 + CW logs partition for the SIEM (SPEC-46).

---

## 5. VPC Endpoint Posture

All endpoints carry **endpoint policies** that restrict actions and principals (already partial in SPEC-06):

```ts
new ec2.InterfaceVpcEndpoint(this, 'BedrockEp', {
  vpc, service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
  policyDocument: new iam.PolicyDocument({ statements: [
    new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['arn:aws:bedrock:*::foundation-model/anthropic.*'],
      conditions: { StringEquals: { 'aws:PrincipalArn': ecsTaskRole.roleArn } },
    }),
  ]}),
});
```

Gateway endpoints (S3/DDB) attach route-table policies preventing cross-account access except listed bucket ARNs.

---

## 6. PrivateLink for Inbound Partners

If a partner ever needs to call us (no public endpoint by default):

```ts
const nlb = new elbv2.NetworkLoadBalancer(this, 'PartnerNLB', { vpc, internetFacing: false });
const svc = new ec2.CfnVPCEndpointService(this, 'PartnerSvc', {
  networkLoadBalancerArns: [nlb.loadBalancerArn],
  acceptanceRequired: true,
  allowedPrincipals: [`arn:aws:iam::${PARTNER_ACCT}:root`],
});
```

Acceptance is manual + audited; per-partner DNS name; mTLS over the NLB.

---

## 7. Centralized DNS

Route 53 Resolver endpoints in `shared-services` VPC:
- **Inbound** endpoints accept on-prem queries → AWS private zones
- **Outbound** endpoints forward `*.partner.example` to partner DNS (if applicable)
- Private hosted zones associated to all VPCs via RAM

Block `dns-resolver-amazon-com` exfil channels via firewall stateful rules (only `.amazon.com`/`.amazonaws.com`/allowed FQDNs).

---

## 8. SG & NACL Hygiene

- CDK Aspect rejects `0.0.0.0/0` ingress on any SG (except CloudFront-managed paths, which are explicit)
- NACLs default-deny outbound to private ranges except known peers
- All SGs tagged with `owner`, `purpose`; orphaned-SG sweeper Lambda deletes untagged unused SGs nightly (dry-run in prod first)

---

## 9. Flow Logs & Mirroring

- VPC Flow Logs (rejected + accepted) → Firehose → S3 (parquet) + CW
- Optional VPC Traffic Mirroring on demand for incident response
- Flow log analysis Athena view: `top_egress_destinations_24h`, `denied_attempts_by_eni`

---

## 10. WAF (Future Public Surface)

Today there is no public web surface; if/when added (e.g. PartnerLink front-door), attach AWS WAFv2 with:
- AWS Managed Rules: Core, KnownBadInputs, SQLi, BotControl
- Rate-based rules: 2000 req / 5 min / IP
- Geo block list (per legal review)
- Logging to S3 + Security Hub

---

## 11. Cost Considerations

- Network Firewall: ~$0.40/h + data → only used in egress VPC where required
- TGW attachments: $0.05/h per attachment; consolidate VPCs where possible
- PrivateLink: $0.013/h per endpoint per AZ
- Annual review of endpoint count vs NAT alternative (almost always endpoints win at our usage)

---

## 12. Failure Modes

| Failure                       | Detection                          | Mitigation                            |
|-------------------------------|------------------------------------|---------------------------------------|
| Endpoint outage in 1 AZ       | CW Endpoint health alarms          | Endpoints in all 3 AZs; SDK retries   |
| TGW route leak                | Daily route-audit Lambda           | Diff vs CDK; alarm on extra prefixes  |
| Firewall rule misconfig drops | Stateful rule drops in flow logs   | Pre-prod canary fleet exercises FQDNs |
| DNS exfil                     | Resolver query logs anomaly        | Blocklist + alarm                     |

---

## 13. Acceptance Criteria

- [ ] TGW deployed, segmented route tables enforce prod/sandbox isolation
- [ ] Egress VPC + Network Firewall live with FQDN allow-list
- [ ] Endpoint policies pinned to expected role ARNs
- [ ] Flow logs in S3 + queryable via Athena
- [ ] CDK Aspect rejects `0.0.0.0/0` SG ingress
- [ ] Orphan SG sweeper running (dry-run in prod first)
- [ ] PrivateLink template ready (unused but tested in sandbox)
- [ ] Quarterly network-architecture review meeting on calendar
