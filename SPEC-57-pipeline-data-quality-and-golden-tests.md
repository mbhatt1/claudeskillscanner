# SPEC-57 — Pipeline Data Quality & Golden Tests

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-02 (Lambda+ECS), SPEC-03 (knowledge store), SPEC-43 (DX)
**Related:** SPEC-39 (AI eval), SPEC-44 (contracts), SPEC-52 (synthetics)

> SPEC-39 evaluates *model output*. This spec evaluates **the pipeline itself** — does a known input produce the expected DDB row, S3 layout, OpenSearch doc, SARIF, EventBridge events, audit entries? Distinct, deterministic, and cheap to run.

---

## 1. Why Pipeline-Level Tests

The pipeline transforms inputs through ~10 stages. Bugs at each stage are subtle and don't reliably surface as model-output regressions:
- Wrong DDB key shape (e.g. `JOB#${id}` vs `JOB#{id}`)
- Missing GSI projections
- Off-by-one in S3 prefixes (breaks lifecycle/erase)
- Wrong encryption context (decryption later fails)
- Audit event missing fields (compliance gap)
- Schema-envelope version drift between producer & consumer
- EventBridge `detail-type` typo (silent loss)
- Race-condition idempotency violations

Model-output tests can't catch these. We need *snapshot-style* tests on pipeline artifacts.

---

## 2. Golden Fixtures

```
tests/golden/
├── inputs/
│   ├── 001-tiny-skill.zip           # < 1 KB; one .md skill
│   ├── 002-medium-repo.tar.gz       # 50 files
│   ├── 003-zip-slip-attack.zip      # adversarial: must REJECT
│   ├── 004-symlink-trick.zip
│   ├── 005-decompression-bomb.zip
│   ├── 006-utf8-edge.zip            # filenames, BOMs
│   └── 007-empty.zip
└── expected/
    ├── 001/
    │   ├── ddb-job.json
    │   ├── s3-layout.txt            # `find` style sorted listing
    │   ├── opensearch-doc.json      # minus volatile fields
    │   ├── sarif.json
    │   ├── eventbridge-events.jsonl
    │   ├── audit-events.jsonl
    │   └── metrics.json
    └── 003/
        ├── ddb-job.json             # status: REJECTED
        ├── error.json               # error code = SKL_ZIP_SLIP
        └── audit-events.jsonl
```

Bedrock invocations are mocked (VCR fixtures, SPEC-43 §3) so tests are deterministic and cost zero.

---

## 3. Volatile-Field Normalization

Pipeline outputs contain timestamps, ULIDs, request IDs. Snapshot comparator normalizes before diff:

```ts
// tests/golden/normalize.ts
const NORMALIZE = [
  { path: '$..job_id',         replace: '<<JOB_ID>>' },
  { path: '$..occurred_at',    replace: '<<TS>>' },
  { path: '$..bedrock_request_id', replace: '<<BRID>>' },
  { path: '$..trace_id',       replace: '<<TRACE>>' },
];
```

Normalization rules are committed alongside fixtures so a reader can see exactly what's masked.

---

## 4. Runner

```bash
$ npm run golden
[001-tiny-skill] ✔
[002-medium-repo] ✔
[003-zip-slip-attack] ✔ (rejected as expected)
[007-empty.zip] ✘
  diff in expected/007/audit-events.jsonl:
    + missing event: { kind: "upload", outcome: "rejected", reason: "EMPTY_ZIP" }
1 failed
```

Runner:
1. Spins up LocalStack + OpenSearch container (or reuses Docker compose from SPEC-43 §2)
2. For each input: runs the full pipeline (Ingestion → ECS-runner-in-process → ResultsProcessor)
3. Snapshots every external write (DDB items, S3 keys, OpenSearch docs, EB events, audit log)
4. Normalizes and diffs against `expected/`

---

## 5. Update Flow

When a change *intentionally* alters output:

```bash
$ npm run golden -- --update 002
✔ Updated expected/002/* with current outputs
```

Updates produce a PR diff, reviewed like any other code. CODEOWNERS gate on `tests/golden/expected/`: changes need explicit reviewer approval (prevents accidental "just rerun until green").

---

## 6. Cross-Contract Checks

Beyond per-fixture snapshots, the runner validates **structural invariants** across all fixtures:

- Every DDB job has matching audit `upload` event
- Every audit event has valid `prev_hash` chain
- Every OpenSearch doc's `source_s3_uri` resolves to a real object
- Every EventBridge event matches its versioned schema (SPEC-44)
- Lifecycle prefixes match retention spec (SPEC-38)

```ts
// tests/golden/invariants.ts
expect(everyJobHasAuditUpload(snapshot)).toBe(true);
expect(auditHashChainValid(snapshot.audit)).toBe(true);
expect(everyOpenSearchDocHasSourceS3(snapshot)).toBe(true);
```

These are the same invariants enforced at runtime by SPEC-34a/b branded types — they're tested here against full pipeline outputs.

---

## 7. Adversarial Corpus

Fixtures `003`..`006` cover security-critical paths:
- zip-slip
- symlink escape
- decompression bomb
- UTF-8 / BOM / filename edge cases
- max-depth zip
- duplicate-name entries
- zero-byte entries

Each has an **expected rejection** (status, error code, audit event). A regression that *accepts* an adversarial input fails loudly.

---

## 8. Data-Lineage Verification

For each completed fixture, runner asserts the lineage record (SPEC-38 §7) is complete:

```ts
const doc = snapshot.opensearch[0];
expect(doc).toHaveProperty('source_s3_uri');
expect(doc).toHaveProperty('source_sha256');
expect(doc).toHaveProperty('producer_skill_sha');
expect(doc).toHaveProperty('model_id');
expect(doc).toHaveProperty('embedding_model');
expect(doc).toHaveProperty('pipeline_version');
```

Missing lineage → fail.

---

## 9. Determinism Test

Same input run twice (same Bedrock VCR fixture) must produce byte-identical normalized snapshots. A repro Lambda runs the corpus N=10 times nightly; any non-determinism alerts.

---

## 10. Performance Smoke

Optional `--with-perf` mode records per-stage latency and asserts against SPEC-42 budgets (warn-only):

```
[002] ingestion=120ms ecs-setup=NA(local) result-process=180ms index=300ms  ✓ within budget
[002] regression alert: index latency +45% vs 7-day baseline
```

Not a hard gate (LocalStack ≠ prod), but tracked over time.

---

## 11. CI Integration

```yaml
# .github/workflows/golden.yml
- name: Golden pipeline tests
  run: |
    docker compose -f docker-compose.dev.yml up -d
    npm run golden
    npm run golden:invariants
```

Required check on every PR. Median CI duration target < 4 min.

---

## 12. Migration Tests

When a pipeline migration ships (SPEC-44 §12-13: shadow-write/backfill/cutover), a paired golden fixture per phase verifies:
- Pre-migration: old expected output
- Mid-migration: both old + new written
- Post-migration: only new written
- Backfill complete: scan finds zero old-shape records

Forces the migration plan to be reified as test fixtures before merging.

---

## 13. Skill Author Pipeline-Compat Tests

Skill registry submit (SPEC-40 §7) runs a *minimal* pipeline smoke against the new skill in a sandbox:
- Submit known input
- Run the new skill
- Verify outputs land in S3/DDB/OpenSearch shapes
- Verify SARIF (if produced) is schema-valid

Prevents a misshapen skill from getting indexed at all.

---

## 14. Acceptance Criteria

- [ ] ≥ 20 golden fixtures committed (mix of happy/adversarial)
- [ ] Runner green on macOS + Linux CI
- [ ] CODEOWNERS gate on `tests/golden/expected/`
- [ ] Adversarial corpus produces expected rejections
- [ ] Cross-contract invariants enforced
- [ ] Determinism test green over N=10 runs
- [ ] Migration paired-fixture pattern documented + 1 worked example
- [ ] Median CI golden-test duration < 4 min
