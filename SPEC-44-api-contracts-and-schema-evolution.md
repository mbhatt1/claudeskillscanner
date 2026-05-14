# SPEC-44 — API Contracts & Schema Evolution

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-03, SPEC-09 (MCP), SPEC-10
**Related:** SPEC-43 (DX), SPEC-32 (MCP fixes)

---

## 1. Public Contract Inventory

| Contract                       | Surface     | Audience    | Stability    |
|--------------------------------|-------------|-------------|--------------|
| CLI commands/flags             | external    | users       | STABLE       |
| MCP tools                      | external    | LLM clients | STABLE       |
| S3 upload zip layout           | external    | users       | STABLE       |
| Skill manifest.json            | external    | skill authors | STABLE     |
| SARIF (with skills-svc/v1 ext) | external    | downstream  | STABLE       |
| Bedrock prompt template        | internal    | components  | INTERNAL     |
| SQS job message                | internal    | components  | INTERNAL     |
| SNS notification payload       | external    | webhooks    | STABLE       |
| EventBridge events             | mixed       | components+integrators | STABLE |
| DDB single-table schema        | internal    | components  | INTERNAL     |
| OpenSearch index mapping       | internal    | components  | INTERNAL     |
| Knowledge-store query response | external    | users       | STABLE       |

---

## 2. Versioning Policy

- **External:** semver (MAJOR.MINOR.PATCH)
- **Internal:** monotonic `schema_version` integer with **N-2 compatibility** (current code reads versions N, N-1, N-2)

### 2.1 Breaking changes (require MAJOR)

- Removing a field
- Renaming a field
- Narrowing a field's type (string → enum w/ closed set)
- Removing an enum value
- Changing semantics of an existing field
- Removing a CLI subcommand or flag
- Removing an MCP tool

### 2.2 Non-breaking (MINOR/PATCH)

- Adding optional field
- Adding new enum value (with default handler in readers)
- Adding new CLI flag/subcommand
- Adding new MCP tool
- Documentation, performance, internal refactor

---

## 3. Schema Registry

```
packages/shared/schemas/
├── v1/
│   ├── job-message.ts          # zod
│   ├── job-message.schema.json # generated
│   └── ...
├── v2/
└── build/                       # CI-generated, hashed
```

```ts
// packages/shared/schemas/v1/job-message.ts
import { z } from 'zod';
export const JobMessageV1 = z.object({
  schema:     z.literal('skills-svc/job-message'),
  version:    z.literal('1.0'),
  data: z.object({
    job_id: z.string().ulid(),
    s3_uri: z.string().regex(/^s3:\/\//),
    skill:  z.string(),
    submitted_at: z.string().datetime(),
  }),
  trace_id:    z.string(),
  occurred_at: z.string().datetime(),
});
export type JobMessageV1 = z.infer<typeof JobMessageV1>;
```

Build step (CI) emits:
- JSON Schema artifacts → `packages/shared/schemas/build/`
- Uploaded to `s3://skills-svc-schemas/${git-sha}/`
- Embedded in OCI image labels: `org.skills-svc.schemas.sha=${sha256}`

---

## 4. Compatibility Checker

```yaml
# .github/workflows/schema-compat.yml
- name: Schema compat check
  run: |
    npx schema-diff \
      --old s3://skills-svc-schemas/$(git merge-base origin/main HEAD)/ \
      --new packages/shared/schemas/build/ \
      --report compat.json
    node scripts/gate-compat.mjs compat.json
```

`gate-compat.mjs`:
- classifies each change as PATCH / MINOR / MAJOR
- if any MAJOR: require commit message footer `BREAKING-CHANGE: <reason>` and presence of `docs/migrations/${version}.md`
- otherwise pass

---

## 5. Wire-Format Envelope

```ts
interface Envelope<T> {
  schema: string;       // e.g. "skills-svc/job-message"
  version: string;      // semver MAJOR.MINOR
  data: T;
  trace_id: string;
  occurred_at: string;  // ISO-8601
}
```

Every cross-process JSON message uses this envelope. Readers dispatch on `(schema, version)`. Unknown `(schema, version)` → log + DLQ (never crash).

---

## 6. Forward/Backward Compatibility Patterns

- **Readers ignore unknown fields** — passthrough preserved
- **Writers fill defaults** for absent optional fields
- **Discriminated unions** keyed by `kind: 'foo' | 'bar'`
- **Never reuse a field name** with a different type (add `field_v2`, deprecate old)

---

## 7. Deprecation Lifecycle

```
DEPRECATED   →  SUNSET-WARNING       →  REMOVED
(release N)     (release N+1, ≥ 90d)     (release N+2)
```

Tracker file:

```md
# DEPRECATIONS.md
| Identifier               | Deprecated | Sunset | Removed | Owner | Notes |
|--------------------------|------------|--------|---------|-------|-------|
| CLI flag --legacy-format | 2026-04    | 2026-07| 2026-10 | @cli  | Replaced by --format=legacy |
| MCP tool skills_v1.upload| 2026-03    | 2026-06| 2026-09 | @mcp  | Use skills_v2.upload |
```

CLI prints warnings:

```
WARN: --legacy-format is deprecated; will sunset 2026-07-01; removed 2026-10-01.
      Migrate to --format=legacy. See docs/migrations/cli-1.4-to-2.0.md.
```

MCP tool descriptions include `"deprecated": true`.

---

## 8. MCP Tool Versioning

Tool names embed major version:

```ts
// packages/mcp-server/src/tools/index.ts
export const tools = {
  'skills_v1.upload':  { handler: uploadV1, deprecated: true, sunsetAt: '2026-09-01' },
  'skills_v2.upload':  { handler: uploadV2 },
  'skills_v1.query':   { handler: queryV1,  deprecated: true, sunsetAt: '2026-09-01' },
  'skills_v2.query':   { handler: queryV2 },
};
```

Both v1 and v2 hosted during transition.

---

## 9. CLI Flag Evolution

Old flags kept as **hidden aliases** for one major:

```ts
program.option('--legacy-format', undefined, /* hidden */ true)
       .option('--format <fmt>');  // visible
```

Opt-in usage telemetry (off by default) records flag usage to inform sunset timing.

---

## 10. Skill Manifest Evolution

```ts
const ManifestV1 = z.object({ schema_version: z.literal(1), /* ... */ });
const ManifestV2 = z.object({ schema_version: z.literal(2), tools_allowed: z.array(z.string()), /* ... */ });

// packages/cli/src/commands/skill-migrate.ts
program.command('skill migrate <path>').action((path) => {
  const m = JSON.parse(readFileSync(`${path}/manifest.json`, 'utf8'));
  if (m.schema_version === 1) {
    const v2 = { ...m, schema_version: 2, tools_allowed: inferTools(m), network: m.network ?? false };
    writeFileSync(`${path}/manifest.json`, JSON.stringify(v2, null, 2));
  }
});
```

Per-version validator runs at submit time; legacy versions accepted but warn.

---

## 11. SARIF Profile

SARIF 2.1.0 (OASIS spec) + skills-svc extension namespace:

```json
{
  "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/csd02/schemas/sarif-2.1.0-rtm.5.json",
  "version": "2.1.0",
  "runs": [{
    "tool": { "driver": { "name": "skills-svc", "version": "1.0.0" } },
    "results": [{
      "ruleId": "CWE-79",
      "level": "warning",
      "message": { "text": "..." },
      "locations": [{ "physicalLocation": { "artifactLocation": { "uri": "..." }, "region": { "startLine": 42 } } }],
      "properties": {
        "skills-svc/v1": {
          "confidence": 0.78,
          "requires_human": false,
          "skill_id": "security-review",
          "skill_version": "1.4.2",
          "model_id": "claude-opus-4-7"
        }
      }
    }]
  }]
}
```

Extension JSON Schema at `packages/shared/schemas/sarif-ext-v1.schema.json`. GitHub Code Scanning ingest validated.

---

## 12. DDB Schema Migrations

```
infra/migrations/
├── 0001-add-cost-attr/
│   ├── README.md
│   ├── shadow-write.ts
│   ├── backfill.ts
│   └── cutover.ts
└── ...
```

Playbook per migration:
1. Code change: writers populate **new + old** attributes
2. Backfill Lambda (paginated scan, conditional updates)
3. Verify parity
4. Switch readers to new attribute
5. Stop writing old
6. Remove old attribute

Migration progress tracked in DDB itself:

```
PK=MIGRATION#0001-add-cost-attr  SK=META
  status: backfilling
  cursor: <lastEvaluatedKey>
  started_at: ...
```

---

## 13. OpenSearch Index Migrations

Versioned aliases:
- `skills-results-write` → `skills-results-v3`
- `skills-results-read`  → `skills-results-v3, skills-results-v2`

Embedding-model change:
1. Bring up v4 index with new model
2. Dual-write to v3+v4 for 7 days
3. Reindex backlog from S3 source into v4
4. Switch `read` alias to v4 only
5. Drop v3 after retention

---

## 14. EventBridge Versioned Events

```
detail-type: "skills-svc.job.completed.v1"
detail: { schema, version, data, ... }
```

Consumers subscribe to specific `detail-type` versions; producers emit multiple versions during transition (with feature flag `emit_legacy_events`).

---

## 15. Contract Tests

```
tests/contracts/
├── cli-to-api/         # Pact consumer, CLI as consumer
├── lambda-to-lambda/   # Envelope round-trip
└── mcp-client-server/  # mock MCP client validates server tools
```

Run in CI on every PR. Broken contract fails the PR.

---

## 16. Backwards-Compat Test Matrix

```yaml
# .github/workflows/compat-matrix.yml
strategy:
  matrix:
    cli_version: ["latest", "n-1", "n-2"]
    server_version: ["latest", "n-1", "n-2"]
steps:
  - run: install cli@${{ matrix.cli_version }} && test against server@${{ matrix.server_version }}
```

Cell fails → flagged compat violation; either fix or document N-2 break.

---

## 17. API Stability Tiers

| Tier         | Guarantee                                    |
|--------------|----------------------------------------------|
| STABLE       | Breaking changes require MAJOR + sunset      |
| BETA         | May change with 1-release warning            |
| EXPERIMENTAL | May change/disappear anytime                 |

Tier metadata embedded:
- CLI: `--help` annotates with `[BETA]` / `[EXPERIMENTAL]`
- MCP: tool description prefix
- Docs: per-page banner

---

## 18. Public Documentation

```
docs/contracts/
├── README.md           # auto-generated TOC
├── cli.md
├── mcp-tools.md
├── manifest.md
├── sarif-ext.md
├── upload-format.md
├── notifications.md
└── eventbridge.md
```

Generated from JSDoc + schemas via `npm run docs:contracts` in CI.

---

## 19. Changelog Discipline

```
# CHANGELOG.md
## [Unreleased]
### Added
### Changed
### Deprecated
### Removed
### Fixed
### Security

## [1.5.0] - 2026-05-13
### Added
- `skills_v2.upload` MCP tool
### Deprecated
- `--legacy-format` CLI flag (sunset 2026-07-01)
```

Generated by `conventional-changelog` from commits; verified in CI.

---

## 20. Acceptance Criteria

- [ ] Every cross-process message uses Envelope
- [ ] Schema registry build artifacts published per commit
- [ ] Compat checker blocks unjustified MAJOR
- [ ] DEPRECATIONS.md current
- [ ] CLI prints sunset warnings for deprecated flags
- [ ] MCP v1 + v2 tools coexist during transition
- [ ] Contract tests green
- [ ] N-2 compat matrix green
- [ ] CHANGELOG.md generated in releases
