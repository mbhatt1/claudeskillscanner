# SPEC-56 — Customer Onboarding & Quick-Start

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-07 (CLI), SPEC-45 (identity), SPEC-43 (DX)
**Related:** SPEC-48 (marketplace), SPEC-54 (SDK)

> Goal: first successful job run within **5 minutes** of `npm install`. Goal: production sandbox provisioned within **15 minutes**.

---

## 1. Onboarding Tiers

| Tier      | Audience                       | Path                              | Time-to-first-job |
|-----------|--------------------------------|-----------------------------------|-------------------|
| Try       | Curious / evaluating           | Public demo with shared sandbox   | 60 s              |
| Sandbox   | Skill author / single dev      | Self-provisioned dev account      | 15 min            |
| Production| Team adopting in prod          | Guided CDK deploy to own account  | < 1 day           |

---

## 2. Tier 1: Try (Public Demo)

A shared, rate-limited public endpoint runs a fixed subset of skills against a user-supplied **URL only** (no zip upload):

```bash
$ npm install -g @skills-svc/cli
$ skills-svc try --repo https://github.com/some/public-repo --skill security-review
✔ Submitted to public demo (rate-limited, ephemeral, no auth needed)
✔ Job 01HX...   completed in 47s
Top findings:
  CWE-79  src/render.ts:42  high     XSS via unescaped user input
  CWE-89  src/db.ts:108     critical SQL injection
Full SARIF: https://demo.skills-svc.example/jobs/01HX.../sarif (TTL 24h)
```

Public demo is its own thin stack:
- API Gateway + WAF (rate-limited per IP)
- Restricted skill set (no `tools_allowed: shell`)
- Repos must be public + size-capped (10 MB)
- All outputs public-readable for 24 h
- Cost ceiling enforced; throttle at $X/day total

Disclaimer: "Demo only — your repo URL is logged; do not use private code."

---

## 3. Tier 2: Sandbox

```bash
$ skills-svc init
✔ Detected: no existing config
? Onboarding tier:
  ❯ Sandbox (recommended for first-time users)
    Production
? AWS account: bring-your-own
? Region: us-east-1
✔ Running CDK bootstrap...
✔ Deployed: skills-svc-sandbox stack (12 min)
✔ Configured ~/.skills-svc/config.yml
✔ Test job submitted: 01HX...
✔ Job completed in 64s

Try next:
  skills-svc query "What were the SQL injection findings?"
  skills-svc skill search security
  skills-svc workflow list
```

Behind the scenes:
- `cdk bootstrap` + the sandbox-flavored stack (smaller capacity, $20/day budget)
- Identity Center not required (sandbox uses local SSO profile)
- A canary job runs automatically to verify the deployment

Failure modes (each with a remediation URL printed):
- Region without Bedrock model → suggest us-east-1 / us-west-2
- Quota too low → file quota request command pre-populated
- VPC quota exhausted → use smaller subnet plan

---

## 4. Tier 3: Production

Production onboarding is a **runbook**, not magic. Located at `docs/onboarding/production.md`:

```
1. Prerequisites
   - AWS Organizations with security tooling already deployed (CloudTrail org-trail, GuardDuty)
   - Identity Center configured with SAML/OIDC to corp IdP
   - Two-account structure: prod + dev
2. Deploy
   - Clone repo, configure infra/lib/config/prod.ts
   - cdk diff in each account, review with security
   - cdk deploy --all
3. Verify
   - skills-svc admin verify  → 50-item readiness checklist (SPEC-40 §18)
4. Add humans
   - Assign Identity Center permission sets per persona (SPEC-45)
5. Smoke
   - skills-svc smoke run  → reference job; verify SARIF
6. Cutover
   - DNS, status page entries, dashboards published
```

`skills-svc admin verify` runs an *operator readiness check*: SLOs configured? Alarms wired? Runbooks present? DR drill within 90 d? Output → checklist with pass/fail/n/a.

---

## 5. Inline Help & Discoverability

CLI `--help` is structured by **intent**, not by command list:

```
$ skills-svc --help
SKILL AS A SERVICE

Run a job:        skills-svc upload | try
Inspect results:  skills-svc status | results | query
Marketplace:      skills-svc skill {search|info|install}
Workflows:        skills-svc workflow {list|run|status}
Admin:            skills-svc admin {verify|users|budgets}
Auth:             skills-svc {login|logout}

New here? Try:    skills-svc try --repo https://github.com/...
Docs:             https://docs.skills-svc.example
```

Each subcommand prints a "Next steps" footer pointing to common follow-ons.

---

## 6. Sample Data & Tutorials

`packages/cli/src/samples/` ships with:
- `samples/vulnerable-app/` — small repo with known CWEs
- `samples/clean-app/` — control case (no findings)
- `samples/skill-author-quick-start/` — hello-world skill

```bash
$ skills-svc tutorial run security-review
[1/5] Cloning sample vulnerable-app to /tmp/...
[2/5] Submitting job...
[3/5] Job complete. Findings:
[4/5] Querying knowledge store: "What CWE-79 findings?"
[5/5] Tutorial complete. Next: skills-svc tutorial run skill-author
```

Tutorial = a script + narration; not a separate codepath.

---

## 7. Onboarding Telemetry (opt-in)

If user opts in (default off):
- Time-to-first-job (TTFJ) per tier
- Drop-off step (where did `init` fail?)
- Most common errors during onboarding
- Days-to-second-job (activation metric)

Feeds back into improving the flow. Strict: no command arguments captured, no repo URLs, no PII.

---

## 8. Error Recovery

Every onboarding step records progress to `~/.skills-svc/onboarding-state.json`. On failure, `skills-svc init --resume` picks up after the last successful step.

Common-error catalog (`docs/onboarding/errors.md`):
- `SKL-OB-1001 quota too low` — pre-populated quota-increase command
- `SKL-OB-1002 region not available` — list of supported regions
- `SKL-OB-1003 cdk bootstrap failed` — manual recovery
- `SKL-OB-1004 SSO config missing` — link to Identity Center setup

---

## 9. Time-to-First-Job SLO

Track and publish:
- **Try tier:** TTFJ < 60 s p95
- **Sandbox tier:** TTFJ < 15 min p95 (deploy-time dominated)
- **Production tier:** "skills-svc admin verify" passes within 1 business day

Regressions in any of these get treated like reliability regressions (postmortem, action items).

---

## 10. Sunset / Off-boarding

The forgotten-but-important other half:

```bash
$ skills-svc admin offboard --confirm
✔ Will delete: sandbox stack (no production stacks affected)
✔ Will retain: audit log (legal retention)
✔ Will erase: jobs (last 90d), results, embeddings   [SPEC-38 §4]
Proceed? [y/N]
```

Erasure executes asynchronously; off-boarding receipt emailed at completion.

---

## 11. Acceptance Criteria

- [ ] `skills-svc try` returns findings in < 60 s p95
- [ ] `skills-svc init --tier sandbox` completes < 15 min p95
- [ ] `skills-svc admin verify` lists every required control with pass/fail
- [ ] CLI `--help` re-org reviewed for new-user clarity
- [ ] Tutorials run end-to-end on macOS + Linux CI
- [ ] Onboarding-state resume tested with each step failure
- [ ] TTFJ telemetry (opt-in) flowing
- [ ] Off-boarding command erases the right scope, leaves audit log intact
