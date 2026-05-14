# SPEC-38 — Data Governance, Retention & Privacy

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01, SPEC-03 (knowledge store), SPEC-06 (security)
**Related:** SPEC-37 (DR), SPEC-40 (threat model), SPEC-45 (authz)

---

## 1. Data Classification Taxonomy

| Class          | Examples                                        | Storage rules                       |
|----------------|-------------------------------------------------|-------------------------------------|
| PUBLIC         | Documentation, skill manifests metadata         | No special handling                 |
| INTERNAL       | Job IDs, status, non-sensitive metrics          | Standard                            |
| CONFIDENTIAL   | Skill outputs, query results                    | KMS-CMK, access logged              |
| SECRET         | Auth tokens, API credentials in transit         | Never persisted (transit only)      |
| PII            | Emails, names, IPs, phone, SSNs                 | KMS-CMK, redacted in indexes        |
| SOURCE_CODE    | Repos under review, code snippets in SARIF      | KMS-CMK, never to CW logs           |
| MODEL_OUTPUT   | Raw Bedrock completions                         | KMS-CMK, retained per policy        |

### 1.1 Mandatory tagging CDK Aspect

```ts
// infra/lib/governance/classification-aspect.ts
import { IAspect, Annotations } from 'aws-cdk-lib';
const REQUIRED = ['data_classification', 'owner', 'app'];

export class ClassificationAspect implements IAspect {
  visit(node: IConstruct) {
    if (!Tags.of(node) || !this.hasAllRequiredTags(node)) {
      Annotations.of(node).addError(`Missing classification tags: ${REQUIRED.join(',')}`);
    }
    const cls = getTagValue(node, 'data_classification');
    if (cls && !['PUBLIC','INTERNAL','CONFIDENTIAL','SECRET','PII','SOURCE_CODE','MODEL_OUTPUT'].includes(cls)) {
      Annotations.of(node).addError(`Invalid classification: ${cls}`);
    }
  }
}
```

### 1.2 Macie weekly scan

```ts
new macie.CfnClassificationJob(this, 'WeeklyScan', {
  jobType: 'SCHEDULED',
  scheduleFrequency: { weeklySchedule: { dayOfWeek: 'SUNDAY' } },
  s3JobDefinition: { bucketDefinitions: [{ accountId: this.account, buckets: [resultsBucket.bucketName] }] },
  customDataIdentifierIds: [awsKeysCdi.ref, jwtCdi.ref, pemCdi.ref],
});
```

Custom data identifiers (CDIs) cover AWS access keys (`AKIA[0-9A-Z]{16}`), JWTs (header.payload.sig), PEM blocks (`-----BEGIN .* PRIVATE KEY-----`), common secret patterns from gitleaks ruleset. Findings auto-quarantine the source object via EventBridge → Lambda → S3 move-and-restrict.

---

## 2. PII Detection & Redaction

Pipeline stage between ECS result upload and ResultsProcessorLambda:

```ts
// packages/lambda/pii-redactor/index.ts
import { ComprehendClient, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';

const REGEX = {
  email:    /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  phone:    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ipv4:     /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  ssn:      /\b\d{3}-\d{2}-\d{4}\b/g,
};

function luhn(s: string) { /* ... */ }

export async function redact(text: string, jobId: string) {
  // 1) Comprehend pass (handles name/address/etc context-sensitively)
  const pii = await comprehend.send(new DetectPiiEntitiesCommand({ Text: text, LanguageCode: 'en' }));
  const map: Array<{kind:string; orig:string; token:string}> = [];
  let redacted = text;
  for (const e of pii.Entities ?? []) {
    const orig = text.slice(e.BeginOffset!, e.EndOffset!);
    const token = `<<${e.Type}_${jobId.slice(0,6)}_${map.length}>>`;
    redacted = redacted.replace(orig, token);
    map.push({ kind: e.Type!, orig, token });
  }
  // 2) Regex pass for things Comprehend misses
  for (const [kind, re] of Object.entries(REGEX)) {
    redacted = redacted.replace(re, (m) => {
      const token = `<<${kind}_${jobId.slice(0,6)}_${map.length}>>`;
      map.push({ kind, orig: m, token });
      return token;
    });
  }
  // 3) Credit-card via Luhn
  redacted = redacted.replace(/\b\d{13,19}\b/g, (m) => luhn(m) ? '<<CC>>' : m);

  // Original retained in stricter location; redaction map encrypted separately
  await s3.putObject({ Bucket: REDACTION_BUCKET, Key: `${jobId}/map.json`,
    Body: JSON.stringify(map), SSEKMSKeyId: REDACTION_KMS });
  return redacted;
}
```

ResultsProcessor uses the redacted text for embedding; original retained in results bucket with stricter ACL (auditor + break-glass only).

---

## 3. Retention Policy

| Resource              | Default retention | Override field           |
|-----------------------|-------------------|--------------------------|
| Uploads bucket        | 30 d              | n/a                      |
| Results bucket        | 90 d              | `retention_days` on job  |
| Results (legal-hold)  | 1 y               | `legal_hold=true`        |
| DDB jobs              | 180 d (TTL attr)  | `retention_days`         |
| OpenSearch docs       | 90 d              | (per-index rollover)     |
| Audit log             | 7 y               | immutable                |

### 3.1 S3 lifecycle

```ts
resultsBucket.addLifecycleRule({
  id: 'standard-results',
  enabled: true,
  expiration: Duration.days(90),
  noncurrentVersionExpiration: Duration.days(30),
  abortIncompleteMultipartUploadAfter: Duration.days(7),
  transitions: [
    { storageClass: s3.StorageClass.INTELLIGENT_TIERING, transitionAfter: Duration.days(0) },
    { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(30) },
  ],
});
```

### 3.2 OpenSearch retention (no native ILM on Serverless)

Monthly rolling indices `skills-results-YYYY-MM`. A daily Lambda deletes indices older than 90 d. Aliases `skills-results-write` (current month) and `skills-results-read` (all retained).

---

## 4. Right-to-Erasure (GDPR Art. 17)

```ts
// packages/cli/src/commands/erase.ts
program.command('erase <job-id>')
  .option('--reason <r>', 'GDPR / user-request / mistake')
  .action(async (jobId, opts) => {
    const ticket = await api.startErase(jobId, opts.reason);
    console.log(`Erase ticket ${ticket.id} — SLA 30 d, status URL: ${ticket.statusUrl}`);
  });
```

```ts
// packages/lambda/erase/index.ts
export const handler = async (event: { jobId: string; reason: string; ticketId: string }) => {
  const { jobId, reason, ticketId } = event;
  // 1) S3 delete (versioned + lock-aware)
  for await (const obj of listObjects(`${jobId}/`)) {
    if (obj.objectLockLegalHoldStatus === 'ON') throw new Error('LEGAL-HOLD');
    await s3.deleteObject({ Bucket: RESULTS, Key: obj.Key!, VersionId: obj.VersionId });
  }
  // 2) DDB delete (job + GSI projections)
  await ddb.deleteItem({ TableName: TABLE, Key: { PK: `JOB#${jobId}`, SK: 'META' } });
  // 3) OpenSearch delete by query
  await os.deleteByQuery({ index: 'skills-results-*', body: { query: { term: { job_id: jobId } } } });
  // 4) Tombstone to immutable audit log
  await audit.append({ event: 'erase', jobId, reason, ticketId, at: new Date().toISOString() });
  // 5) Verification report
  await s3.putObject({ Bucket: ERASE_REPORTS, Key: `${ticketId}.json`,
    Body: JSON.stringify({ verified_at: Date.now(), residue: await scan(jobId) }) });
};
```

Idempotent (S3 deletes are no-ops on missing keys; DDB delete is unconditional; OpenSearch DBQ is idempotent).

---

## 5. Data Subject Access (Art. 15)

`skills-svc export --job-id X` returns a portable archive: all S3 objects under `${jobId}/`, the DDB item as JSON, the OpenSearch hit, the audit-log slice scoped to that job. Streamed as a signed-URL tarball, valid 24 h.

---

## 6. Immutable Audit Log

S3 Object Lock COMPLIANCE mode, KMS-CMK, retention 7 y, write via batched Firehose-style Lambda:

```ts
// packages/shared/audit/append.ts
export async function append(event: AuditEvent) {
  const enriched = { ...event, schema: 'skills-svc.audit.v1', occurred_at: new Date().toISOString(),
                     prev_hash: await getLastHash(), id: ulid() };
  const hash = sha256(JSON.stringify(enriched));
  enriched.hash = hash;
  await kinesisFirehose.putRecord({ DeliveryStreamName: AUDIT_STREAM,
    Record: { Data: Buffer.from(JSON.stringify(enriched) + '\n') } });
}
```

Events: `upload`, `run-start`, `run-complete`, `query`, `erase`, `role-assumption`, `policy-change`. Partition `dt=YYYY-MM-DD/`. Hash-chained for tamper-evidence (each entry's `prev_hash` is the previous entry's `hash`); a daily verifier Lambda walks the chain and alarms on break.

---

## 7. Data Lineage

Every OpenSearch doc carries:

```ts
interface OpenSearchDoc {
  job_id: string;
  source_s3_uri: string;
  source_sha256: string;
  producer_skill: string;
  producer_skill_version: string;
  producer_skill_sha: string;
  model_id: string;
  model_version: string;
  embedding_model: string;
  bedrock_request_id: string;
  pipeline_version: string;
  created_at: string;
  classification: 'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'PII'|'SOURCE_CODE'|'MODEL_OUTPUT';
  redacted: boolean;
}
```

CLI: `skills-svc lineage <job-id>` prints the lineage tree (source zip → skill version → model → embedding → index docs).

---

## 8. Encryption-in-Use Boundary

| Location              | Encrypted in use? | Mitigation                                |
|-----------------------|-------------------|-------------------------------------------|
| Lambda memory         | No                | No swap; ephemeral storage encrypted; isolated execution env |
| ECS task memory       | No                | Same; readonly rootfs; no debugger        |
| Bedrock inference     | Yes (TLS in transit; no in-use)        | Bedrock data-protection contract          |
| OpenSearch query path | No (in-process)   | Private VPC endpoints only                |
| S3                    | At rest (SSE-KMS); in transit (TLS 1.2+) | Bucket policies deny non-TLS              |
| DDB                   | At rest (CMK); in transit (TLS)        | n/a                                       |

Future: Nitro Enclaves for SECRET-class workloads if scope expands.

---

## 9. Cross-Border / Data Residency

Each job carries `data_residency` ∈ `us | eu`. Region-scoped queues + buckets. IAM condition on the cross-region role:

```json
{
  "Effect": "Deny",
  "Action": "s3:GetObject",
  "Resource": "*",
  "Condition": {
    "StringNotEquals": { "aws:RequestedRegion": "${aws:ResourceTag/data_residency}" }
  }
}
```

(Tag-based; the bucket tag `data_residency=us` blocks reads from `eu-*` regions.)

---

## 10. Compliance Mapping

| Control                       | SOC2 (CC) | ISO 27001 Annex A | GDPR Art. | HIPAA Safeguard |
|-------------------------------|-----------|-------------------|-----------|-----------------|
| Access logged                 | CC6.1     | A.12.4            | 30        | 164.312(b)      |
| Encryption at rest            | CC6.7     | A.10.1            | 32        | 164.312(a)(2)(iv) |
| Right to erasure              | CC6.5     | A.18.1.4          | 17        | n/a             |
| Audit log immutability        | CC4.1     | A.12.4.2          | 30        | 164.312(c)      |
| Backup + DR                   | A1.2      | A.17              | n/a       | 164.308(a)(7)   |
| Access reviews                | CC6.2     | A.9.2.5           | n/a       | 164.308(a)(4)   |

> Not HIPAA-certified; mappings are aspirational for future enrollment.

Evidence Lambda runs monthly, snapshots AWS Config + IAM + KMS state into `s3://skills-svc-evidence/YYYY-MM/`, retained 7 y under Object Lock.

---

## 11. Skill Output Safety

SARIF findings contain code snippets — classified `SOURCE_CODE`. Never logged to CloudWatch:

```ts
// packages/shared/log.ts
export function log(level: string, msg: string, attrs: Record<string,unknown>) {
  const safe = redactClassified(attrs);
  console.log(JSON.stringify({ level, msg, ...safe, redacted: safe._redacted_keys?.length > 0 }));
}
```

`redactClassified` walks the object, replaces any field tagged SOURCE_CODE/PII with `"<<redacted:SOURCE_CODE>>"` and records keys in `_redacted_keys`.

---

## 12. Acceptance Criteria

- [ ] CDK Aspect rejects untagged resources
- [ ] Macie weekly scan green 4 weeks running
- [ ] PII redactor unit-tested with 500-sample corpus, recall ≥ 0.95
- [ ] Erase tested end-to-end with verification report
- [ ] Audit log hash chain verifier runs daily without breaks
- [ ] Compliance evidence collected for 3 months
- [ ] No SOURCE_CODE/PII in CloudWatch logs (sample audit)
