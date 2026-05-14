# SPEC-54 — Skill SDK & Authoring Developer Experience

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-10 (registry), SPEC-39 (eval), SPEC-40 (signing), SPEC-48 (marketplace)
**Related:** SPEC-43 (DX), SPEC-44 (contracts)

> The marketplace (SPEC-48) is only as good as the supply. This spec defines the SDK, scaffolding, local test harness, and signing/publishing path so an external author can write, test, and publish a skill in under an hour.

---

## 1. SDK Packages

```
packages/skill-sdk/
├── ts/                  @skills-svc/skill-sdk          (npm)
│   ├── src/
│   │   ├── index.ts     // public API
│   │   ├── manifest.ts  // typed manifest builder + zod schema (v2)
│   │   ├── runner.ts    // local runner using bedrock-mock or real
│   │   ├── assert.ts    // assertions for tests
│   │   └── sarif.ts     // SARIF builders + validators
│   └── package.json
└── py/                  skills_svc_skill_sdk           (PyPI)
    └── (parallel surface)
```

Both SDKs target the same manifest v2 schema (SPEC-48 §1) and call the same Bedrock prompt template — Python is feature parity for skill *authors* even though our infrastructure is TS.

---

## 2. Public TypeScript Surface

```ts
// packages/skill-sdk/ts/src/index.ts

export interface SkillContext {
  jobId: string;
  workDir: string;                              // /tmp/work
  invokeModel(prompt: Prompt, opts?: InvokeOpts): Promise<ModelResponse>;
  emitFinding(f: Finding): void;
  emitProgress(pct: number, stage: string): void;
  artifact(name: string, body: Buffer | string, mime?: string): Promise<string>; // returns S3 key
  log(level: 'debug'|'info'|'warn'|'error', msg: string, attrs?: Record<string, unknown>): void;
}

export interface SkillModule {
  manifest: Manifest;
  run(input: SkillInput, ctx: SkillContext): Promise<SkillOutput>;
}

export function defineSkill(mod: SkillModule): SkillModule { return mod; }
```

Authors implement:

```ts
import { defineSkill } from '@skills-svc/skill-sdk';
import manifest from './manifest.json';

export default defineSkill({
  manifest,
  async run(input, ctx) {
    const files = await ctx.invokeModel({ system: SYS, user: input.repoSummary });
    for (const f of parseFindings(files.text)) ctx.emitFinding(f);
    return { ok: true };
  },
});
```

---

## 3. Scaffolding

```bash
$ skills-svc scaffold skill my-cwe-scanner \
    --tier minimal --lang typescript --category security
```

Generated layout:

```
my-cwe-scanner/
├── manifest.json                # v2, pre-filled
├── README.md                    # template with sections required by marketplace
├── src/
│   ├── index.ts                 # `defineSkill({...})`
│   └── prompts/system.md
├── tests/
│   ├── fixtures/                # sample inputs + expected outputs
│   ├── unit.test.ts             # vitest + sdk assert helpers
│   └── golden.test.ts           # runs against bedrock-mock fixtures
├── eval/
│   └── corpus.jsonl             # author's own eval cases
├── .gitignore
├── package.json                 # peerDeps on @skills-svc/skill-sdk
└── tsconfig.json
```

Templates per tier (minimal / standard / high) preset the manifest's `tools_allowed` and example code.

---

## 4. Local Run Harness

```bash
$ skills-svc skill run ./my-cwe-scanner --input tests/fixtures/sample.input.json
[skill] starting in /tmp/work/abc123
[skill] bedrock invoke (mock) — 14k in / 8k out
[skill] 3 findings emitted
[skill] done in 12.4s ($0.000 mocked)

Output:
  results.json
  findings.sarif
  artifacts/summary.md
```

Two run modes:
- `--mock` (default) → uses fixture-replay Bedrock (SPEC-43 §3)
- `--real` → live Bedrock against the author's sandbox AWS profile

Cost cap honored from manifest. Local runner is the **same code** as ECS runner (`packages/ecs-runner/`) parameterized by mock vs real — fewer divergence bugs.

---

## 5. Assertion Helpers

```ts
import { assertFinding, assertSarif, assertCostUnder } from '@skills-svc/skill-sdk/assert';

test('detects basic XSS', async () => {
  const out = await runLocal(skill, fixtures.xssRepo);
  assertFinding(out, { ruleId: 'CWE-79', file: 'src/render.ts' });
  assertSarif(out.sarif);                      // schema valid against SPEC-44 §11
  assertCostUnder(out, 0.10);                  // $
});
```

---

## 6. Eval Integration

Author's `eval/corpus.jsonl` is run via:

```bash
$ skills-svc skill eval ./my-cwe-scanner
ran 24 cases  passed 22  failed 2
metrics: precision=0.91 recall=0.79 f1=0.85  p95_latency=8.2s  p95_cost=$0.07
report: ./eval-report.html
```

Author can compare runs (regression-detection):

```bash
$ skills-svc skill eval ./my-cwe-scanner --baseline last
delta:  precision -0.01  recall +0.04  cost -12%
```

On submit to registry, author's eval results are stored alongside the artifact; marketplace ranking (SPEC-48 §3) consumes them.

---

## 7. Lint & Static Checks

```bash
$ skills-svc skill lint ./my-cwe-scanner
✔ Manifest v2 schema
✔ README has required sections (Description, Usage, License, Limitations)
✔ No banned APIs (eval, Function, child_process, vm)        # SPEC-40 §7
✔ All findings emitted have ruleId + location
✔ Bundle size < 2MB
✘ Missing icon at skills/my-cwe-scanner/icon.svg
```

CLI exit-code-aware so CI can enforce.

---

## 8. Signing & Publish

```bash
$ skills-svc skill build ./my-cwe-scanner
→ my-cwe-scanner-0.1.0.tar.gz   sha256=...

$ skills-svc skill sign my-cwe-scanner-0.1.0.tar.gz
→ Sigstore keyless flow — opens browser for OIDC...
→ Signed by github:alice@example.com (cert-identity)
→ Wrote my-cwe-scanner-0.1.0.tar.gz.sig

$ skills-svc skill publish my-cwe-scanner-0.1.0.tar.gz
✔ Registry verified signature + manifest + scan
✔ Published: skills://my-cwe-scanner@0.1.0
   catalog: https://catalog.skills-svc.example/my-cwe-scanner
```

Behind the scenes: registry Lambda runs SPEC-40 §7 verification before accepting.

---

## 9. Skill Author Sandbox

`skills-svc skill sandbox` provisions a **dev-only** AWS sub-environment for the author:
- Scoped IAM role (`SkillAuthor` persona, SPEC-45)
- S3 bucket + Bedrock invoke quota
- Capped at $20/day
- Auto-cleanup after 30 d idle

```bash
$ skills-svc skill sandbox create
account: 1234... region: us-east-1 budget: $20/day
profile written to ~/.skills-svc/profiles/sandbox
```

Avoids "I need an AWS account first" friction.

---

## 10. Generated Documentation

`skills-svc skill docs ./my-cwe-scanner` emits `docs/index.md`:
- Auto-generated from manifest + TSDoc on `run()` + README
- Includes eval-report summary
- Includes cost/latency table
- Renders fixtures as examples

Marketplace serves the same doc at `/<skill>/<version>/docs`.

---

## 11. Versioning & Compat

- Authors follow semver (SPEC-44)
- SDK is on a separate semver; declares supported manifest versions
- `skills-svc skill migrate` rewrites old manifest versions (SPEC-44 §10)
- Deprecation surfaced in CLI on `skill build` if author depends on a deprecated SDK API

---

## 12. Python SDK Parity

Same lifecycle (scaffold/run/eval/lint/sign/publish), shipped via `pip install skills-svc-skill-sdk`. The runner shells out to the same TS local runner via a thin Python wrapper, so behavior is identical and we don't maintain two execution engines.

---

## 13. Acceptance Criteria

- [ ] `scaffold → run → eval → lint → sign → publish` works end-to-end in < 60 min for a new author
- [ ] SDK package builds + publishes to npm + PyPI in CI
- [ ] Local runner shares code path with ECS runner (single source)
- [ ] Lint enforces banned APIs, manifest schema, README sections
- [ ] Sandbox provisioning succeeds in < 5 min, budget-capped
- [ ] Marketplace consumes author eval reports
- [ ] Versioned SDK with deprecation warnings honored
- [ ] Python parity tested with 3 reference skills
