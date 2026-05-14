# SPEC-43 — Developer Experience & Platform

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-02, SPEC-10
**Related:** SPEC-36, SPEC-40, SPEC-44

---

## 1. Golden Path: Adding a Skill

```bash
$ skills-svc scaffold skill my-skill --tier minimal
✔ Generated:
    packages/skills/my-skill/
      manifest.json
      README.md
      prompt.md
      tests/sample.input.json
      tests/sample.expected.json
      eval/fixtures.jsonl
```

Generator under `packages/cli/src/scaffold/`. Templates parameterized by tier, tools_allowed, network.

---

## 2. Local Dev Environment

```yaml
# docker-compose.dev.yml
services:
  localstack:
    image: localstack/localstack:latest
    environment: { SERVICES: "s3,sqs,dynamodb,sns,iam,kms,sts,cloudwatch,events,secretsmanager" }
    ports: ["4566:4566"]
  opensearch:
    image: opensearchproject/opensearch:2
    environment: { discovery.type: single-node, plugins.security.disabled: "true" }
    ports: ["9200:9200"]
  bedrock-mock:
    image: ghcr.io/skills-svc/bedrock-mock:latest
    ports: ["8081:8081"]
```

Parity matrix in `docs/local-dev.md`:

| Service       | LocalStack | Notes                                       |
|---------------|------------|---------------------------------------------|
| S3            | full       | OK                                          |
| SQS           | full       | OK                                          |
| DDB           | full       | streams supported                           |
| OpenSearch    | NO         | use real container                          |
| Bedrock       | NO         | use bedrock-mock (VCR fixtures)             |
| KMS           | partial    | encrypt/decrypt OK; key policies stubbed    |
| ECS Fargate   | NO         | runner runs as local node process in dev    |

`make dev` brings up the stack and runs `scripts/smoke.sh` (upload fixture zip → assert end-to-end completion in < 60 s).

---

## 3. Bedrock Mocking

```ts
// packages/shared/test/bedrock-mock.ts
export class BedrockVCR {
  private fixtures: Map<string, any>;
  constructor(private dir: string, private mode: 'record' | 'replay') {}
  async invokeModel(req: InvokeReq) {
    const key = sha256(JSON.stringify(req));
    if (this.mode === 'replay') return this.fixtures.get(key) ?? throwMissing(key);
    const resp = await realBedrock.invokeModel(req);
    await fs.writeFile(`${this.dir}/${key}.json`, JSON.stringify({ req, resp }));
    return resp;
  }
}
```

Recorded fixtures under `tests/fixtures/bedrock/`. CI runs in replay mode; refreshed manually via `npm run bedrock:record`.

---

## 4. Build System (Turbo)

```json
// turbo.json
{
  "pipeline": {
    "typecheck": { "outputs": [], "inputs": ["**/*.ts", "tsconfig.json"] },
    "lint":      { "outputs": [] },
    "test":      { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "package":   { "dependsOn": ["build"], "outputs": ["*.zip"] }
  },
  "remoteCache": { "signature": true }
}
```

Remote cache → S3 (`s3://skills-svc-turbo-cache/`). Bundle budget gate in CI:

```ts
// scripts/bundle-budget.ts
const budgets = { 'lambda/ingestion': 5_000_000, 'lambda/results': 5_000_000 };
for (const [k, max] of Object.entries(budgets)) {
  const size = statSync(`packages/${k}/dist.zip`).size;
  if (size > max) throw new Error(`${k} ${size} > ${max}`);
}
```

---

## 5. CI/CD

```yaml
# .github/workflows/pr.yml
on: pull_request
permissions: { id-token: write, contents: read, pull-requests: write }
concurrency: { group: pr-${{ github.event.number }}, cancel-in-progress: true }
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci --ignore-scripts
      - run: npx turbo run typecheck lint test build
      - run: npx cdk synth
      - run: npx cdk diff --strict 2>&1 | tee cdk-diff.txt
      - uses: actions/github-script@v7
        with:
          script: |
            const body = require('fs').readFileSync('cdk-diff.txt','utf8');
            await github.rest.issues.createComment({
              issue_number: context.issue.number, owner: context.repo.owner, repo: context.repo.repo,
              body: '```\n' + body.slice(0, 60000) + '\n```' });
```

```yaml
# .github/workflows/deploy.yml — wave-by-wave; OIDC; manual gate before prod
on: { push: { branches: [main] } }
concurrency: { group: deploy-main }
jobs:
  deploy-dev:    { /* OIDC → dev role; cdk deploy --all */ }
  deploy-stage:  { needs: deploy-dev, environment: stage }
  deploy-prod:   { needs: deploy-stage, environment: prod }   # required reviewers in prod env
```

---

## 6. Pre-commit Hooks

```json
// .husky/pre-commit (via lint-staged)
{
  "*.{ts,tsx,js}": ["eslint --fix --max-warnings 0", "prettier -w"],
  "*.{json,md,yaml,yml}": ["prettier -w"],
  "*": ["gitleaks protect --staged --no-banner"]
}
```

Commit-msg hook: enforce conventional commits via `commitlint`. Pre-push hook: block large files > 1 MB, block direct push to `main`.

---

## 7. Linting & Formatting

```js
// .eslintrc.cjs
module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'cdk-nag'],
  extends: ['plugin:@typescript-eslint/strict-type-checked'],
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/consistent-type-imports': 'error',
  },
};
```

cdk-nag run inside lint as `npm run cdk:nag`.

---

## 8. Test Strategy

```
tests/
├── unit/            # vitest, isolated, fast
├── integration/     # LocalStack-backed
├── contract/        # schema validation per Lambda surface
└── e2e/             # ephemeral CDK stack, real AWS in sandbox
```

Coverage gates in `vitest.config.ts`:
```ts
coverage: { lines: 80, branches: 80, functions: 80, statements: 80,
            // handlers are ok at 70
            perFile: { 'packages/lambda/**': { lines: 70 } } }
```

---

## 9. Ephemeral Preview Environments

PR labeled `preview` triggers:

```yaml
- name: Deploy preview
  if: contains(github.event.pull_request.labels.*.name, 'preview')
  run: |
    export PR=${{ github.event.number }}
    npx cdk deploy --all --context env=pr-$PR --require-approval never
    echo "preview-url=https://api.pr-$PR.skills-svc-dev.example" >> $GITHUB_OUTPUT
```

Auto-teardown on close/merge via `.github/workflows/preview-teardown.yml`. Budget per preview $50/week.

---

## 10. Documentation

```
docs/
├── adr/             # MADR-format Architecture Decision Records
├── runbooks/        # one md per page-worthy alarm
├── onboarding.md    # day-1, week-1, month-1 checklist
├── contracts/       # see SPEC-44
├── model-card.md    # see SPEC-39
├── security/        # checklists, threat model, redteam reports
└── api/             # TypeDoc-generated, regenerated in CI
```

ADR template:

```md
# ADR-NNN: <title>
Status: Proposed | Accepted | Superseded by ADR-MMM
Context: ...
Decision: ...
Consequences: ...
```

---

## 11. CLI DX

- Excellent `--help`, contextual `--help <subcmd>`
- Shell completions: `skills-svc completion bash | zsh | fish`
- Structured errors with codes + URL: `Error [SKL-1018]: upload too large. Limit 100MB. See https://docs.skills-svc.example/errors/SKL-1018`
- `--debug` dumps AWS request IDs, retries, timing
- `--dry-run` on `erase`, `delete`, `rotate-key`

---

## 12. Error Catalog

```ts
// packages/shared/errors.ts
export const ERRORS = {
  SKL_1001: { msg: 'Invalid manifest', remediation: 'docs/errors/SKL-1001' },
  SKL_1018: { msg: 'Upload too large', remediation: 'docs/errors/SKL-1018' },
  SKL_2001: { msg: 'Job not found', remediation: 'docs/errors/SKL-2001' },
  // ...
} as const;

export class SkillsError extends Error {
  constructor(public code: keyof typeof ERRORS, public detail?: unknown) {
    super(`[${code}] ${ERRORS[code].msg}`);
  }
}
```

One docs page per code under `docs/errors/`.

---

## 13. Observability for Developers

```bash
$ skills-svc logs --job-id 01HXXXXX --follow
[ingestion]   2026-05-13T12:01:00Z  accepted job 01HX...
[ecs-runner]  2026-05-13T12:01:30Z  starting skill security-review
[ecs-runner]  2026-05-13T12:02:14Z  bedrock invoke (Opus) 14k in / 8k out
[results]     2026-05-13T12:02:18Z  indexed 42 docs
trace: https://console.aws.amazon.com/xray/.../traces/1-...
```

Tails all relevant log groups + X-Ray link, scoped to `trace_id` of the job.

---

## 14. Onboarding Automation

```bash
$ scripts/bootstrap-dev.sh
✔ Detect OS (macOS arm64)
✔ Install: node, awscli, cdk, syft, grype, cosign, gitleaks, husky
✔ Configure AWS Identity Center profile `skills-svc-dev`
✔ Install pre-commit
✔ npm ci
✔ make dev
Bootstrap complete. Try: skills-svc query "hello"
```

---

## 15. Code Review Standards & CODEOWNERS

```
# .github/CODEOWNERS
*                              @org/skills-svc
/infra/                        @org/skills-svc @org/security
/packages/shared/auth/         @org/security
/packages/shared/crypto/       @org/security
/.github/workflows/            @org/security
/SPEC-*.md                     @org/architecture
```

PRs require: 1 reviewer default, 2 for security paths. Review checklist embedded in PR template.

---

## 16. Deprecation Policy

- Conventional commits → semver
- Internal contracts: 1 minor warning → 1 major removal
- External (CLI flags, MCP tools): see SPEC-44 §7
- Feature flags gate refactors; old + new live until validated, then delete

---

## 17. Engineering Metrics Dashboard

```ts
// packages/lambda/eng-metrics/index.ts
// PR cycle time, time-to-first-review, CI duration, flaky-test rate, cache hit rate
// Sources: GH GraphQL, CodeBuild reports, Turbo cache logs
// Output: Skills/EngOps/* metrics + weekly engineering review email
```

Targets:
- PR cycle time p50 < 24 h
- Time-to-first-review p50 < 4 business h
- CI duration p95 < 12 min
- Flaky-test rate < 1%
- Build cache hit rate > 70%

---

## 18. Acceptance Criteria

- [ ] `scripts/bootstrap-dev.sh` brings a new engineer to first green PR in < 2 h
- [ ] `make dev` smoke passes in CI matrix (macOS, Linux)
- [ ] Bedrock VCR works in replay mode in CI
- [ ] Turbo remote cache live; hit rate > 70%
- [ ] Preview env deploys + tears down per-PR
- [ ] Coverage gates enforced
- [ ] Conventional-commits + commitlint live
- [ ] gitleaks pre-commit passes 4 weeks running
- [ ] CODEOWNERS enforced on security paths
- [ ] Error catalog covers 100% of user-facing throws
