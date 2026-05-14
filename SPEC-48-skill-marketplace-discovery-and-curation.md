# SPEC-48 — Skill Marketplace: Discovery, Curation & Quality Signals

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-10 (registry), SPEC-39 (eval), SPEC-40 (supply chain)
**Related:** SPEC-44 (contracts)

> The registry exists but is opaque. This spec adds discovery, ranking, ratings, deprecation signaling, and license display so skills become a usable catalog rather than a tarball pile.

---

## 1. Skill Metadata (extended manifest)

Adds optional discovery fields:

```json
{
  "schema_version": 2,
  "skill_id": "security-review",
  "version": "1.4.2",
  "title": "Security Code Review",
  "summary": "Static security review with SARIF output",
  "description_md": "...long markdown...",
  "categories": ["security", "code-review", "sarif"],
  "tags": ["cwe", "owasp", "static-analysis"],
  "authors": [{ "name": "Alice", "github": "alice", "verified": true }],
  "license": "Apache-2.0",
  "homepage": "https://...",
  "repo": "https://github.com/org/security-skills",
  "supported_languages": ["typescript","python","go"],
  "model": { "tier": "flagship" },
  "maturity": "stable",
  "icon": "skills/security-review/icon.svg"
}
```

Schema in `packages/shared/schemas/v2/skill-manifest.ts`.

---

## 2. Discovery API (CLI + MCP)

```bash
$ skills-svc skill search "security review typescript"
ID                       VERSION  MATURITY   DOWNLOADS  RATING  AUTHOR
security-review          1.4.2    stable     12,401     4.6/5   org/security (verified)
ts-lint-skill            0.9.0    beta       302        4.1/5   alice
...

$ skills-svc skill info security-review
[ details rendered ]
```

MCP tool `skills_v2.skill_search(query, filters)` returns the same data.

---

## 3. Search & Ranking

OpenSearch index `skills-catalog` separate from results index:

```json
{
  "mappings": {
    "properties": {
      "skill_id":    { "type": "keyword" },
      "version":     { "type": "keyword" },
      "title":       { "type": "text" },
      "summary":     { "type": "text" },
      "description": { "type": "text" },
      "tags":        { "type": "keyword" },
      "categories":  { "type": "keyword" },
      "downloads":   { "type": "long" },
      "rating":      { "type": "float" },
      "rating_count":{ "type": "long" },
      "maturity":    { "type": "keyword" },
      "deprecated":  { "type": "boolean" },
      "verified":    { "type": "boolean" }
    }
  }
}
```

Ranking signal (Painless score):
```
text_score
  * (1 + log10(1 + downloads))
  * (0.5 + rating/5)
  * (verified ? 1.2 : 1.0)
  * (maturity=='stable' ? 1.1 : maturity=='beta' ? 1.0 : 0.85)
  * (deprecated ? 0.1 : 1.0)
```

---

## 4. Quality Signals

Curation pipeline (daily Lambda) computes per skill:
- **Downloads** (last 30 d, all-time)
- **Eval score** vs golden datasets (SPEC-39) where applicable
- **Error rate** (job failures attributable to skill)
- **Cost-per-job p50** (rolling 30 d)
- **Time-since-last-update**
- **Security-scan status** (Grype on skill deps)
- **CWE coverage** (for security skills)

Surfaced in `info` output.

---

## 5. Rating & Review

```bash
$ skills-svc skill rate security-review --stars 5 --comment "great recall"
```

Backend: DDB `SKILL_RATING#${skill}` items with `user_id` PK, `stars`, `comment`, `created_at`. One rating per user per skill (conditional write). Aggregate avg + count recomputed via DDB Streams → Lambda → OpenSearch.

Abuse mitigation: rate limits (5/user/day), profanity filter, minimum 1 successful job-run with that skill before rating allowed.

---

## 6. Curation Tiers

| Tier            | Badge        | Criteria                                              |
|-----------------|--------------|-------------------------------------------------------|
| **Verified**    | ✓ check      | Author enrolled; cosign signed; SBOM clean; eval ≥ baseline |
| **Featured**    | ★ star       | Verified + manual curator promotion                   |
| **Community**   | (none)       | Default                                               |
| **Quarantined** | ⚠ warning   | Failed scan; high error rate; security disclosure     |

Curators are humans with the `SecurityReviewer` persona; promotion/demotion is an auditable Cedar action.

---

## 7. License Display

```bash
$ skills-svc skill info security-review
...
License:    Apache-2.0  ✓ (allow-listed)
```

License allow-list (MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0). Other licenses display a warning. GPL/AGPL/SSPL skills are **rejected** at registry submit (SPEC-40 §5).

---

## 8. Deprecation Signaling

Manifest field:
```json
{ "deprecated": { "since": "2026-04-01", "replaced_by": "security-review-v2", "removal_at": "2026-10-01" } }
```

CLI install/use surfaces:
```
WARN: security-review@1.4.2 is deprecated. Use security-review-v2 (or 2.x). Removed 2026-10-01.
```

OpenSearch ranking deprioritizes deprecated skills (§3).

---

## 9. Versioning

- Skills follow semver
- Registry stores all versions; default install = latest non-prerelease, non-deprecated
- `skills-svc skill install security-review@~1.4` allows ranges (npm-style)
- Yanking: `skills-svc skill yank` (registry admin only) marks a version unavailable for new installs but doesn't break existing pins

---

## 10. Telemetry (opt-in)

Anonymous install/usage pings improve ranking. Default off; opt-in via `~/.skills-svc/config.yml`:

```yaml
telemetry:
  share_usage: true   # anonymous install/run counts
  share_errors: false # NEVER on by default — could leak code
```

Telemetry endpoint accepts only `{skill_id, version, event: install|run-start|run-success|run-fail, ts}` — no PII, no code, no inputs.

---

## 11. Catalog Web Index (static)

Even without a UI, generate a static markdown catalog daily under `s3://skills-svc-catalog/index.md` with all skills sorted by tier + rating, plus per-skill pages. Browsable via plain HTTPS or rendered by GitHub Pages. CLI links to it: `Catalog: https://catalog.skills-svc.example/security-review`.

---

## 12. Acceptance Criteria

- [ ] Manifest v2 schema enforced at registry submit
- [ ] OpenSearch catalog index live + ranking formula tested
- [ ] `skills-svc skill search` returns ranked results
- [ ] Rating flow: prevented without prior successful run; one-per-user
- [ ] Curator workflow (verify/feature/quarantine) auditable
- [ ] License allow-list enforced
- [ ] Deprecated skills demoted in ranking + CLI warns
- [ ] Static catalog regenerated daily
- [ ] Telemetry opt-in respected end-to-end
