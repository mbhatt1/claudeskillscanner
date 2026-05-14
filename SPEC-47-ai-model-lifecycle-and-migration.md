# SPEC-47 — AI Model Lifecycle & Migration Playbook

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-39 (responsible AI + eval)
**Related:** SPEC-36 (canary), SPEC-41 (cost), SPEC-44 (contracts)

---

## 1. Why a Model Lifecycle Spec

Bedrock-hosted Anthropic models are deprecated/replaced regularly (cf. Sonnet 4.6 → 4.7, Opus 4.6 → 4.7). The system MUST treat model version as a versioned input with explicit migration paths, not an environment variable change.

---

## 2. Model Catalog

```ts
// packages/shared/models/catalog.ts
export const MODEL_CATALOG = {
  'claude-opus-4-7':   { tier: 'flagship', context: 1_000_000, priceIn: 15, priceOut: 75, status: 'PRIMARY' },
  'claude-sonnet-4-6': { tier: 'balanced', context: 200_000,   priceIn: 3,  priceOut: 15, status: 'PRIMARY' },
  'claude-haiku-4-5':  { tier: 'fast',     context: 200_000,   priceIn: 0.8, priceOut: 4,  status: 'PRIMARY' },
  'claude-opus-4-6':   { tier: 'flagship', status: 'DEPRECATED', sunsetAt: '2026-12-01' },
  // …
} as const;
```

Catalog is the **only** place model IDs are referenced; everything else looks them up via skill manifest tier (`tier: 'flagship'`).

---

## 3. Skill Manifest Model Binding

Skills declare a tier preference, not a model ID:

```json
{
  "model": { "tier": "flagship", "fallback_tiers": ["balanced"] }
}
```

The runner resolves tier → ID via the catalog at execution time. Operators can pin to a specific ID in AppConfig override for incident response.

---

## 4. Migration Phases

When a new model becomes available (e.g. `claude-opus-4-8`):

| Phase | Action                                           | Gate                                       |
|-------|--------------------------------------------------|--------------------------------------------|
| 0     | Add to catalog with `status: PREVIEW`             | Operator only                              |
| 1     | Run full eval suite on PREVIEW                    | Eval ≥ baseline; safety regression < 1%    |
| 2     | Shadow eval at 5% prod traffic for 7 d           | No safety regression; cost/latency in range|
| 3     | Canary 10% of `flagship` tier for 7 d            | SLO unaffected; FP rate ≤ baseline + 1%    |
| 4     | Canary 50% for 3 d                                | Same                                       |
| 5     | Promote: new ID becomes `PRIMARY`; previous → `SUPERSEDED` | All gates passed                  |
| 6     | After 90 d: previous → `DEPRECATED` with sunset   | n/a                                        |
| 7     | At sunset: remove from catalog                    | All skills migrated                        |

Each phase is automated via Step Function `model-migration` which advances on gate signals from CloudWatch metrics.

---

## 5. Eval Gate Matrix

```yaml
# packages/eval/gates/model-promotion.yml
gates:
  - metric: security_review_f1
    floor: baseline - 0.02
    weight: critical
  - metric: jailbreak_resistance_rate
    floor: baseline + 0    # cannot regress
    weight: critical
  - metric: schema_validity_rate
    floor: 0.98
    weight: critical
  - metric: latency_p95_ms
    ceiling: baseline * 1.20
    weight: high
  - metric: cost_per_job_usd
    ceiling: baseline * 1.15
    weight: high
```

Step Function reads the gate file and rejects promotion on any `critical` failure; `high` failures need 2-person override.

---

## 6. Prompt Compatibility

Prompts versioned with hash + minor (`security-review.v1.4`). When model changes, run prompt-compatibility eval: same prompt × old/new model → diff scores. If diff > 5%, fork the prompt: `security-review.v1.4-opus4-7.md` vs `security-review.v1.4-opus4-8.md`. Skill manifest gains `prompt_overrides: { "claude-opus-4-8": "v1.5" }`.

---

## 7. Embedding Model Migrations

(Special case because OpenSearch is indexed against the embedding model.)

```
old_model → still indexed (read alias keeps v3)
       │
new_model → dual-write to v4 + v3 for 30 d
new_model → backfill v4 by re-embedding S3 source
new_model → switch read alias to v4 only
old_model → drop v3 after retention
```

Tracked as a SPEC-44 §13 OS migration plus a model migration entry.

---

## 8. Deprecation Comms

CLI surfaces:
```
WARN: Model claude-opus-4-6 will sunset 2026-12-01. Your skill foo pins this model.
      Auto-resolved to claude-opus-4-7 (flagship tier) starting 2026-09-01 unless overridden.
      Re-run eval: skills-eval run --dataset security-review --model claude-opus-4-7
```

CHANGELOG entries auto-generated when catalog status transitions.

---

## 9. Rollback

```ts
// AppConfig flags drive emergency rollback (no redeploy)
{
  "model_pin": {
    "flagship": "claude-opus-4-7"   // override catalog primary
  }
}
```

`skills-svc admin model pin --tier flagship --to claude-opus-4-6` flips the flag with audit trail.

---

## 10. Vendor-Lock-In Hedge

Catalog supports non-Anthropic entries (e.g. another foundation model on Bedrock):
```ts
'other-vendor-model-x': { tier: 'balanced', adapter: 'bedrock-otherco', status: 'EXPERIMENTAL' }
```

Adapter layer in `packages/shared/llm/adapters/` abstracts InvokeModel for vendor-specific request shapes. Used for benchmarking, not production yet.

---

## 11. Migration Postmortem Template

Every model migration produces a postmortem doc under `docs/migrations/models/${old}-to-${new}.md`:
- Eval results (before/after)
- Shadow window observations
- Canary cohort metrics
- Incidents (if any)
- Prompt changes
- Cost delta
- Action items

---

## 12. Acceptance Criteria

- [ ] All skill code references tiers, not model IDs
- [ ] Catalog is single source of truth
- [ ] Step Function `model-migration` drilled in sandbox end-to-end
- [ ] Eval gates exercised (with a deliberate failure injection)
- [ ] Embedding migration path tested
- [ ] AppConfig pin override audit-logged
- [ ] CLI warnings surfaced on deprecated models
- [ ] Postmortem written for last model swap
