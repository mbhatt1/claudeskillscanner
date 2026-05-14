# SPEC-26 — Code Review Extension: All 20 Gap Fixes

**Supersedes:** SPEC-25 on all overlapping topics.  
**Scope:** Fixes all 20 gaps identified in the code review audit, implemented by 10 parallel agents.  
**Files written directly to repo:** chunker.ts, ignorer.ts (by Agent 1 — already on disk).

---

## Gap 1 — Code Chunking for Large Codebases

**New file `packages/ecs-runner/src/chunker.ts`** (written to disk by agent):
- `buildFileList(sourceDir)` — recursive walk, resolves symlinks, checks for escape from source root. Files >10 MB use `stat.size / 4` for token estimate.
- `chunkFiles(files, maxTokensPerBatch = 80_000)` — greedy bin-packing. Files that individually exceed the limit get their own chunk.
- `renderChunkContent(chunk)` — reads each file, truncates at `maxTokensPerBatch * 4` chars with `[TRUNCATED]` notice.

**Runner integration in `packages/ecs-runner/src/runner.ts`:**
```typescript
// After building file list:
const ignorer = await buildIgnorer(sourceDir, manifestExcludes);
const includedFiles = (await buildFileList(sourceDir))
  .filter(f => !ignorer.isIgnored(path.relative(sourceDir, f)));
const chunks = chunkFiles(includedFiles);

const allFindings: SecurityFinding[] = [];
for (let i = 0; i < chunks.length; i++) {
  const chunkContent = await renderChunkContent(chunks[i]);
  const chunkPrompt  = `${skillPrompt}\n\n---\n\n${chunkContent}`;
  const output = await runClaudeOnChunk(chunkPrompt, jobId, env);
  const parsed = parseClaudeOutput(output);
  allFindings.push(...(parsed.findings ?? []));

  // GAP 4 checkpoint: upload partial results after each chunk
  if (resultsBucket) {
    await uploadChunkCheckpoint(resultsBucket, jobId, i, {
      chunkIndex: i, findings: parsed.findings ?? [], rawOutput: '',
    });
  }
}

// Deduplicate: keep highest severity when (file, line, cwe_id) collides
const merged = deduplicateFindings(allFindings);
```

---

## Gap 2 — File Exclusion (.skillsignore)

**New file `packages/ecs-runner/src/ignorer.ts`** (written to disk by agent):
- `DEFAULT_EXCLUDES` — 30+ patterns: `node_modules`, `vendor`, `dist`, `build`, `__pycache__`, `*.min.js`, `*.pb.go`, `*.lock`, `coverage`, `.git`, common IDE/OS noise.
- `buildIgnorer(sourceDir, manifestExcludes?)` — reads `.skillsignore` from repo root (gitignore syntax), concatenates with defaults and per-package `excludePatterns` from the batch manifest.
- `Ignorer.isIgnored(relativePath)` — uses `minimatch` with `{ dot: true }`. Plain-name patterns (no `/` or `*`) match any path segment.

**Updated `BatchManifestEntry` in `packages/shared/src/types.ts`:**
```typescript
export interface BatchManifestEntry {
  name:    string;
  version: string;
  source:  string;
  language?: string;
  excludePatterns?: string[];  // ADD — per-package globs appended to DEFAULT_EXCLUDES
}
```

---

## Gap 3 — Commit-Level Idempotency

**New file `packages/lambda/src/webhook/dedup.ts`:**
```typescript
// GAP 3: check if this (packageName, commitSha) was already submitted
export async function checkCommitRecord(
  tableName: string, packageName: string, commitSha: string,
): Promise<{ shouldSkip: boolean; existing?: CommitRecord }> {
  const res = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `PKG#${packageName}`, SK: `COMMIT#${commitSha}` },
    ConsistentRead: true,
  }));
  if (!res.Item) return { shouldSkip: false };
  const rec = res.Item as CommitRecord;
  // Retry FAILED, skip everything else
  return { shouldSkip: rec.status !== 'FAILED', existing: rec };
}

// Writes PENDING marker with optimistic lock (attribute_not_exists condition)
// Returns true if this caller claimed the job, false on race loss
export async function writeCommitRecord(
  tableName: string, packageName: string, commitSha: string, jobId: string,
): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        PK: `PKG#${packageName}`, SK: `COMMIT#${commitSha}`,
        jobId, status: 'PENDING', createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
        GSI4PK: `SOURCEREF#${commitSha}`, GSI4SK: `PKG#${packageName}`,
      },
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    }));
    return true;
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
```

**CDK addition — GSI4 on findingsTable in `infra/lib/code-review-stack.ts`:**
```typescript
this.findingsTable.addGlobalSecondaryIndex({
  indexName:      'GSI4-SourceRef',
  partitionKey:   { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
  sortKey:        { name: 'GSI4SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'status', 'createdAt'],
});
```

---

## Gap 4 — ECS Timeout + Checkpointing

**`packages/ecs-runner/src/runner.ts` — job-type-aware timeout:**
```typescript
const JOB_TYPE = process.env.JOB_TYPE ?? 'default';
const TASK_TIMEOUT_MS = JOB_TYPE === 'code-review'
  ? 90 * 60 * 1000   // 90 minutes
  : 25 * 60 * 1000;  // 25 minutes (original)
```

**Checkpoint upload after each chunk:**
```typescript
async function uploadChunkCheckpoint(
  bucket: string, jobId: string, chunkIndex: number, result: ChunkFinding,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key:    `results/${jobId}/chunk-${chunkIndex}.json`,
    Body:   JSON.stringify(result),
    ContentType: 'application/json',
  }));
}
```

`ResultsProcessorLambda` detects `jobType=code-review` and merges chunk files before indexing.  
**SQS visibility timeout note:** code-review queues need `visibilityTimeout: cdk.Duration.seconds(6000)` (100 min).

---

## Gap 5 — Private Git Repository Authentication

**`packages/ecs-runner/src/git-cloner.ts` — complete rewrite (key sections):**

```typescript
// Detect host type from URL
function detectHost(gitUrl: string): HostInfo { /* github | gitlab | github-enterprise | ssh */ }

// Build GIT_CONFIG_COUNT/KEY_n/VALUE_n env vars — no disk writes
function buildTokenEnv(hostname: string, token: string): GitCredentials {
  return {
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0:   `url.https://oauth2:${token}@${hostname}/.insteadOf`,
      GIT_CONFIG_VALUE_0: `https://${hostname}/`,
      GIT_TERMINAL_PROMPT: '0',
    },
  };
}

// SSH key: write to /tmp/.ssh/id_rsa (mode 0o600), set GIT_SSH_COMMAND, wipe after clone
async function writeSshKey(pem: string): Promise<string> { /* ... */ }
async function wipeSshKey(): Promise<void> { /* overwrite with zeros then unlink */ }

export async function cloneRepo(gitUrl, gitRef, destDir, opts: CloneOptions): Promise<string> {
  // opts: { awsEnv, subpath, gitCredentialKey }
  // SSM params read: /skills-svc/{env}/git/github-token, gitlab-token, ssh-private-key
  // Returns effective sourceDir (destDir or destDir/subpath)
}
```

**IAM additions in `infra/lib/security-stack.ts`:**
```typescript
this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadGitCredentialsSSM',
  actions: ['ssm:GetParameter'],
  resources: [
    `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/git/github-token`,
    `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/git/gitlab-token`,
    `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/git/ssh-private-key`,
    `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/git/tokens/*`,
  ],
}));
```

---

## Gap 6 — Webhook Storm Deduplication (Burst Force-Pushes)

**In `packages/lambda/src/webhook/dedup.ts`:**
```typescript
// 60-second cooldown per (repoFullName, commitSha) to absorb burst force-pushes
export async function checkCooldown(
  tableName: string, repoFullName: string, commitSha: string,
): Promise<boolean> {
  const key = sha256(`${repoFullName}:${commitSha}`).slice(0, 32);
  const res = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `WEBHOOK#COOLDOWN#${key}`, SK: 'TS' },
  }));
  return !!res.Item;
}

export async function writeCooldown(
  tableName: string, repoFullName: string, commitSha: string,
): Promise<void> {
  const key = sha256(`${repoFullName}:${commitSha}`).slice(0, 32);
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `WEBHOOK#COOLDOWN#${key}`, SK: 'TS',
      ttl: Math.floor(Date.now() / 1000) + 60,
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  })).catch(e => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
}
```

**Webhook handler sequence (after signature validation):**
1. `checkCooldown` → return 200 immediately if within 60s window
2. `writeCooldown` → claim the 60s window
3. `checkCommitRecord` → if COMPLETE/RUNNING/PENDING, return 200 with existing jobId
4. `writeCommitRecord` → conditional claim
5. Only if claimed: S3 PutObject + queue GitHub "pending" status

---

## Gap 7 — Findings Suppression / False-Positive Whitelist

**Updated `FindingRecord` in `packages/cli/src/commands/review/types.ts`:**
```typescript
export type FindingStatus = 'open' | 'accepted' | 'false-positive' | 'remediated' | 'suppressed';

export interface FindingRecord extends SecurityFinding {
  // ... existing fields ...
  status:            FindingStatus;   // ADD
  suppressedBy?:     string;
  suppressedAt?:     string;
  suppressionReason?: string;
  contentFingerprint: string;         // sha256(cwe_id + file + line + severity)
}

export interface SuppressionRule {   // PK=SUPPRESSION#{contentHash}, SK=GLOBAL
  PK:               string;
  SK:               'GLOBAL';
  contentHash:      string;
  suppressedBy:     string;
  suppressedAt:     string;
  suppressionReason: string;
}
```

**New `packages/cli/src/commands/review/suppress.ts`:**
- `suppressFinding(packageName, version, findingId, { reason, allVersions })` — `UpdateItem` to set `status=false-positive`; optionally writes `SuppressionRule` via `PutItem` when `--all-versions` is passed.
- `unsuppressFinding(...)` — `UpdateItem` back to `status=open`; optionally deletes global rule.
- Commander wiring: `skills-svc review suppress <pkg> <findingId> --reason "..." [--all-versions]`

**`packages/lambda/src/results-processor/findings-writer.ts`** — before each `PutItem`, `GetItem` on `SUPPRESSION#{contentHash}`. If rule exists, finding is written with `status=suppressed` (audit record) and suppressor metadata copied in. `ConditionExpression` prevents overwriting a manual `false-positive` on retry.

---

## Gap 8 — Aggregate Cross-Package Dashboard

**New `packages/cli/src/commands/review/summary.ts`:**
```typescript
// skills-svc review summary [--severity critical] [--since 2026-01-01] [--format json]
export async function reviewSummary(opts: SummaryOptions): Promise<void> {
  // 1. Scan PKG_REGISTRY (PK=PKG_REGISTRY, SK begins_with PKG#)
  // 2. Scan GSI2-CWE for cross-package finding data
  // 3. Output: total packages, findings by severity, top-10 CWEs, packages with criticals
}
```

**New `packages/cli/src/commands/review/list-packages.ts`:**
```typescript
// skills-svc review list-packages [--has-severity critical] [--reviewed-since 2026-01-01]
export async function reviewListPackages(opts: ListPackagesOptions): Promise<void> {
  // Query PKG_REGISTRY, filter by severity/date, display colored table
}
```

**`findings-writer.ts` PKG_REGISTRY upsert (after writing finding rows):**
```typescript
await ddb.send(new UpdateCommand({
  TableName: findingsTable,
  Key: { PK: 'PKG_REGISTRY', SK: `PKG#${packageName}` },
  UpdateExpression: 'SET packageName=:name, latestVersion=:ver, latestReviewedAt=:at ' +
                    'ADD totalFindings :total, criticalCount :crit, highCount :high, ...',
  ExpressionAttributeValues: { ':name': packageName, ':ver': version, /* counts */ },
}));
```

---

## Gap 9 — SARIF `partialFingerprints` + GitHub Code Scanning Requirements

**Complete replacement of `packages/cli/src/utils/sarif.ts`:**

```typescript
export function findingsToSarif(
  findings: FindingRecord[], packageName: string, packageVersion: string,
  opts: SarifOptions = {},
): SarifLog {
  // GAP 9a: partialFingerprints.primaryLocationLineHash on every result
  partialFingerprints: {
    primaryLocationLineHash: createHash('sha256')
      .update(`${f.file}:${f.line}:${f.cwe_id}`).digest('hex').slice(0, 16),
  },

  // GAP 9b: automationDetails.id
  run.automationDetails = { id: `skills-svc/${packageName}/${version}/${jobId}` };

  // GAP 9c: versionControlProvenance when sourceRef provided
  run.versionControlProvenance = [{ repositoryUri, revisionId: commitSha, branch }];

  // GAP 9d: rule.shortDescription and rule.fullDescription always populated
  //         (static CWE name table with 18 common CWEs; finding description as fallback)

  // GAP 9e: result.suppressions for status=suppressed findings → GitHub "dismissed" state
  result.suppressions = [{ kind: 'external', status: 'accepted', justification: reason }];
}
```

---

## Gap 10 — CI Exit Code / Build Gate

**New `packages/cli/src/commands/review/wait.ts`:**
```typescript
// skills-svc review wait <pkg> --version 2.1.0 --timeout 30 --fail-on-severity high
// Exit codes: 0=passed, 1=findings above threshold, 2=job FAILED, 3=timeout
export async function reviewWait(packageName: string, opts: WaitOptions): Promise<void> {
  // Resolve jobId via latestVersion pointer (Gap 13 fix)
  // Poll every 10s until COMPLETE/FAILED or timeout
  // On COMPLETE: query GSI3 for findings, count by severity, exit appropriately
}
```

**Updated `packages/cli/src/commands/review/report.ts`** — added `--fail-on-severity` flag:
```typescript
if (opts.failOnSeverity) {
  const blocking = findings.filter(f => meetsThreshold(f.severity, opts.failOnSeverity!));
  if (blocking.length > 0) process.exit(1);
}
```

---

## Gap 11 — Scoped Review (Changed Files Only)

**`packages/lambda/src/webhook/handler.ts`** — PR events fetch changed files:
```typescript
// On pull_request events:
const changedFiles = await fetchPullRequestFiles(repoFullName, pullNumber, githubToken);
// GET /repos/{owner}/{repo}/pulls/{pullNumber}/files → [{ filename, status }]
const scopeFilesS3Key = await storeChangedFiles(uploadsBucket, jobId, repoFullName, changedFiles);
// Stored at: reviews/{repo}/{jobId}/changed-files.json
metadata['scope-files-key'] = `s3://${uploadsBucket}/${scopeFilesS3Key}`;

// Tag push events: scopeToDiff = false → full repo review
```

**ECS submitter:** passes `{ name: 'JOB_SCOPE_FILES', value: scopeFilesKey }` in container overrides.

**`packages/ecs-runner/src/main.ts`:**
```typescript
const scopeFilesUri = process.env.JOB_SCOPE_FILES;
if (scopeFilesUri) {
  await downloadScopeFile(scopeFilesUri, sourceDir);
  // Downloads to /tmp/workspace/source/.review-scope.json
}
```

**`packages/skills/code-review/skills/security-review.md`** — added scope section:
```
If `.review-scope.json` exists in the workspace root, FOCUS findings exclusively on
the files listed there. You MAY read other files for context but only REPORT findings
whose vulnerable code path originates in a scoped file. Tag-push events have no scope
file — review all files.
```

---

## Gap 12 — Monorepo / Subpath Support

**Updated `BatchManifestEntry` and `CodeReviewJobMetadata`:**
```typescript
export interface BatchManifestEntry {
  // ... existing fields ...
  subpath?:         string;   // ADD — relative POSIX path into monorepo, e.g. "packages/auth"
  gitCredentialKey?: string;  // ADD — SSM param for per-repo credential override
}
```

**`packages/ecs-runner/src/git-cloner.ts`** — `CloneOptions.subpath` triggers sparse-checkout:
```typescript
// After init + remote add:
await execFileWithTimeout('git', ['-C', destDir, 'sparse-checkout', 'init', '--cone'], 30_000, env);
await execFileWithTimeout('git', ['-C', destDir, 'sparse-checkout', 'set', subpath], 30_000, env);
// Returns path.resolve(destDir, subpath) as the effective sourceDir
```

**`packages/ecs-runner/src/main.ts`** — injects subpath context into skill prompt:
```typescript
async function injectSubpathContext(skillsDir: string, subpath: string): Promise<void> {
  const promptPath = path.join(skillsDir, 'skills', 'security-review.md');
  const prefix = `> **Scope:** You are reviewing the package at subdirectory: \`${subpath}\`\n\n`;
  // Prepended to prompt if not already present
}
```

---

## Gap 13 — `resolveLatestVersion` DynamoDB Bug Fix

**Root cause:** `begins_with(PK, ...)` on a partition key throws `ValidationException` at runtime.

**Fix:** Maintain a pointer record. In `findings-writer.ts` after writing findings:
```typescript
// Pointer record: PK=PKG#<name>, SK=LATEST_REVIEWED_VERSION
// Uses padSemver for comparison (same algorithm as SPEC-10 skill registry)
function padSemver(v: string): string {
  const [coreStr, pre] = v.split('-', 2);
  const [M=0,m=0,p=0] = coreStr.split('.').map(Number);
  const core = [M,m,p].map(n => String(n).padStart(10,'0')).join('.');
  return pre ? `${core}.A.${pre}` : `${core}.Z`;
}

await ddb.send(new UpdateCommand({
  TableName: findingsTable,
  Key: { PK: `PKG#${packageName}`, SK: 'LATEST_REVIEWED_VERSION' },
  UpdateExpression: 'SET versionRaw=:vr, version=:vp, jobId=:jid, reviewedAt=:at',
  ConditionExpression: 'attribute_not_exists(#vp) OR #vp <= :vp',
  ExpressionAttributeNames: { '#vp': 'version' },
  ExpressionAttributeValues: {
    ':vr': version, ':vp': padSemver(version), ':jid': jobId, ':at': now,
  },
})).catch(e => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
```

**Updated `resolveLatestVersion` in `packages/cli/src/commands/review/findings.ts`:**
```typescript
async function resolveLatestVersion(
  ddb: DynamoDBDocumentClient, tableName: string, packageName: string,
): Promise<{ version: string; jobId: string; reviewedAt: string }> {
  const res = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `PKG#${packageName}`, SK: 'LATEST_REVIEWED_VERSION' },
  }));
  if (!res.Item) throw new Error(`No reviews found for package: ${packageName}`);
  return {
    version:    res.Item.versionRaw as string,
    jobId:      res.Item.jobId as string,
    reviewedAt: res.Item.reviewedAt as string,
  };
}
```

---

## Gap 14 — Diff Fingerprint Survives Refactors

**`FindingRecord.contentFingerprint`** — content-based fingerprint:

In `findings-writer.ts`:
```typescript
async function computeContentFingerprint(finding: SecurityFinding, sourceDir?: string): Promise<string> {
  if (sourceDir) {
    const absPath = path.join(sourceDir, finding.file);
    const window = await readCodeWindow(absPath, finding.line); // 5-line window (2+1+2)
    if (window) return createHash('sha256').update(window).digest('hex');
  }
  // Fallback: hash description
  return createHash('sha256').update(finding.description.slice(0, 300)).digest('hex');
}

async function readCodeWindow(filePath: string, lineNumber: number): Promise<string | null> {
  // Reads lines max(0, line-3) to min(total, line+2), trims+normalises whitespace each line
  // Returns null for binary files, files >2MB, or missing files
}
```

**`packages/cli/src/commands/review/diff.ts`** — three-tier matching:
```typescript
function diffFindings(fromFindings: FindingRecord[], toFindings: FindingRecord[]): DiffResult {
  // Tier 1: contentFingerprint (survives rename + line shift)
  // Tier 2: file + cwe_id     (survives line shift in same file)
  // Tier 3: file + line + cwe_id (exact match — original method)
  // Output includes matchMethod: 'content'|'location'|'exact' per unchanged finding
}
```

---

## Gap 15 — GitLab Timing-Safe Token Comparison

**`packages/lambda/src/webhook/handler.ts` — `handleGitLab()`:**
```typescript
// BEFORE (vulnerable to timing oracle):
if (tokenHeader !== secret) { return unauthorized(); }

// AFTER (constant-time comparison):
const tokenBuf  = Buffer.from(tokenHeader.padEnd(secret.length, '\0').slice(0, secret.length));
const secretBuf = Buffer.from(secret);
const lengthsMatch = tokenHeader.length === secret.length;
if (!lengthsMatch || !timingSafeEqual(tokenBuf, secretBuf)) {
  return unauthorized();
}
```

---

## Gap 16 — Automated SARIF Upload to GitHub Code Scanning

**`packages/lambda/src/results-processor/github-status-publisher.ts` (new):**
```typescript
// publishSarifUpload(): generates SARIF from findings, gzip+base64-encodes it,
// publishes to GitHubStatusQueue (NOT the GitHub API directly — VPC constraint)
// Guards against SQS 256KB limit; logs warning and skips if payload >200KB
export async function publishSarifUpload(params: {
  findings: FindingRecord[]; packageName: string; packageVersion: string;
  jobId: string; repoFullName: string; commitSha: string; ref: string; env: string;
}): Promise<void>
```

**In `ResultsProcessorLambda`:** after writing findings, calls `publishSarifUpload()` when `github-repo` + `github-commit-sha` + `github-ref` metadata are present.

---

## Gap 17 — WebhookLambda Outside VPC

**`infra/lib/code-review-stack.ts`** — remove `vpc`, `vpcSubnets`, `securityGroups` from `WebhookLambda` definition:
```typescript
// BEFORE — inside VPC, cannot reach api.github.com:
const webhookFn = new lambda.Function(this, 'WebhookLambda', {
  vpc: props.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [props.lambdaSg],
  ...
});

// AFTER — outside VPC; S3 and SSM reachable via public HTTPS endpoints with IAM:
const webhookFn = new lambda.Function(this, 'WebhookLambda', {
  // No vpc / vpcSubnets / securityGroups
  environment: {
    ...existing,
    GITHUB_STATUS_QUEUE_URL: gitHubStatusQueue.queueUrl,  // ADD
  },
  ...
});
```

The initial "pending" GitHub status post is enqueued to `GitHubStatusQueue` instead of calling GitHub directly.

---

## Gap 18 — Tarball Size Validation Before Upload/Extraction

**`packages/cli/src/commands/review/submit.ts`** — size check before upload:
```typescript
const stat = fs.statSync(absPath);
if (stat.size > MAX_TARBALL_BYTES) {  // default 500MB, configurable via SKILLS_MAX_TARBALL_BYTES
  throw new Error(`Tarball too large: ${(stat.size/1024/1024).toFixed(1)}MB exceeds ${limit}MB limit`);
}

// Streaming multipart upload (no readFileSync):
const upload = new Upload({
  client: s3,
  params: { Body: createReadStream(absPath), ContentLength: stat.size, /* ... */ },
  partSize: 10 * 1024 * 1024,
});
upload.on('httpUploadProgress', progress => { /* 5% increment progress bar */ });
await upload.done();
```

**`packages/ecs-runner/src/tarball-extractor.ts`** — pre-extraction size check:
```typescript
async function validateTarSize(archivePath: string): Promise<void> {
  // Streams tar headers via the `tar` npm package (pure JS) for .tar.gz/.tgz
  // Sums entry sizes; throws if total > MAX_UNCOMPRESSED_BYTES (default 2GB)
  // Falls back to `tar --list --verbose` subprocess for bzip2/xz
  // Zip: uses `unzip -v` to read central directory without extracting
}
```

---

## Gap 19 — Cross-Package Finding Deduplication

**`FindingRecord.contentHash`** (different from `contentFingerprint`):
```typescript
// In findings-writer.ts:
function computeContentHash(finding: SecurityFinding): string {
  return createHash('sha256')
    .update(`${finding.cwe_id}:${finding.description.slice(0,500)}:${finding.recommendation.slice(0,200)}`)
    .digest('hex');
}
```

**GSI4 on findings table** (`PK=HASH#{contentHash}`, `SK=PKG#{name}#{version}`):
```typescript
this.findingsTable.addGlobalSecondaryIndex({
  indexName:    'GSI4-ContentHash',
  partitionKey: { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI4SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});
```

**New `packages/cli/src/commands/review/duplicates.ts`:**
```typescript
// skills-svc review duplicates [--min-count 5] [--cwe CWE-89] [--bulk-suppress]
// Scans GSI4, groups by contentHash, filters to min-count packages
// --bulk-suppress: interactive loop to suppress all instances of each duplicate

// skills-svc review affected <findingId>
// Resolves contentHash for the given finding, queries GSI4 for all packages sharing it
```

---

## Gap 20 — `review status` Command Implementation

**`packages/cli/src/commands/review/status.ts`** — complete implementation:
```typescript
export async function reviewStatus(packageName: string, opts: StatusOptions): Promise<void> {
  // 1. resolveLatestVersion(packageName) → { version, jobId } (uses Gap 13 pointer)
  // 2. GetItem on jobs table: PK=JOB#{jobId}, SK=METADATA
  // 3. Query GSI3 for finding counts by severity (projects only 'severity' field)
  // 4. --watch: polls every 10s, re-renders on status change, exits on terminal state
  // 5. --format json: outputs StatusReport object; exit 1 on FAILED
}
```

**`packages/cli/src/commands/review/index.ts`** — complete command registration:
```typescript
review.command('status <packageName>')
  .option('--version <ver>',   'Specific version (default: latest)')
  .option('--watch',           'Poll until job completes')
  .option('--format <fmt>',    'Output format: human|json', 'human')
  .action(async (pkg, opts) => { await reviewStatus(pkg, opts); });
```

---

## Gap 21 — GitHubStatusLambda Implementation

**New `packages/lambda/src/github-status/handler.ts`:**
```typescript
// SQS consumer — deployed OUTSIDE VPC
// Handles action: 'commit-status' → POST /repos/{owner}/{repo}/statuses/{sha}
// Handles action: 'sarif-upload'  → POST /repos/{owner}/{repo}/code-scanning/sarifs
// Exponential backoff retry (base 250ms, up to 4 retries) on GitHub 5xx
// Partial batch failure support: batchItemFailures on per-record errors
export const handler: SQSHandler = async (event) => { ... };
```

**CDK additions in `infra/lib/code-review-stack.ts`:**
```typescript
const gitHubStatusDlq = new sqs.Queue(this, 'GitHubStatusDLQ', {
  retentionPeriod: cdk.Duration.days(14),
  encryption: sqs.QueueEncryption.KMS_MANAGED,
});

const gitHubStatusQueue = new sqs.Queue(this, 'GitHubStatusQueue', {
  queueName:         `skills-svc-github-status-${envName}`,
  visibilityTimeout: cdk.Duration.minutes(30),
  deadLetterQueue:   { queue: gitHubStatusDlq, maxReceiveCount: 5 },
});

// SSM param for ResultsProcessorLambda and WebhookLambda to read queue URL
new ssm.StringParameter(this, 'GitHubStatusQueueUrlParam', {
  parameterName: `/skills-svc/${envName}/sqs/github-status-queue-url`,
  stringValue:   gitHubStatusQueue.queueUrl,
});

const gitHubStatusLambda = new lambda.Function(this, 'GitHubStatusLambda', {
  functionName: `skills-svc-github-status-${envName}`,
  handler:      'github-status/handler.handler',
  timeout:      cdk.Duration.seconds(60),
  // *** NO vpc — must reach api.github.com directly ***
  reservedConcurrentExecutions: 20,
});

gitHubStatusLambda.addEventSource(new SqsEventSource(gitHubStatusQueue, {
  batchSize: 10, reportBatchItemFailures: true,
}));

// Grant send permissions to both WebhookLambda and ResultsProcessorLambda
gitHubStatusQueue.grantSendMessages(webhookRole);
gitHubStatusQueue.grantSendMessages(resultsProcessorRole);
```

**`ResultsProcessorLambda`** — replaces direct `postGitHubStatus()` call with SQS publish:
```typescript
await sqs.send(new SendMessageCommand({
  QueueUrl: await getParam(`/skills-svc/${env}/sqs/github-status-queue-url`),
  MessageBody: JSON.stringify({
    action: 'commit-status', env,
    repoFullName: githubRepo, commitSha: githubCommit,
    state: succeeded ? (riskLevel === 'critical' ? 'failure' : 'success') : 'error',
    description: `Security review: ${findingCount} finding(s), risk: ${riskLevel}`,
    context: 'skills-svc/security-review',
  }),
}));
```

---

## Summary Table

| Gap | Component | Key Fix |
|-----|-----------|---------|
| 1  | ECS runner | Chunker splits source into 80k-token batches; multiple Claude invocations merged |
| 2  | ECS runner | Ignorer reads `.skillsignore` + per-package `excludePatterns`; 30+ default patterns |
| 3  | Webhook Lambda | `checkCommitRecord`/`writeCommitRecord` with optimistic lock; GSI4 on sourceRef |
| 4  | ECS runner | `JOB_TYPE=code-review` → 90min timeout; chunk checkpoint uploads after each batch |
| 5  | ECS runner | `git-cloner.ts` full rewrite: token via `GIT_CONFIG_*` env, SSH key with `timingSafeWipe` |
| 6  | Webhook Lambda | 60-second DDB-based cooldown keyed by sha256(repo+commit) |
| 7  | CLI + Lambda | `FindingRecord.status` field; `suppress`/`unsuppress` commands; auto-suppress via rule |
| 8  | CLI | `summary` and `list-packages` commands; PKG_REGISTRY upsert in findings-writer |
| 9  | CLI | SARIF: `partialFingerprints`, `automationDetails`, `versionControlProvenance`, suppressions |
| 10 | CLI | `review wait` command with exit codes 0/1/2/3; `--fail-on-severity` on `report` |
| 11 | Webhook + ECS | PR changed-files fetch → `.review-scope.json`; skill prompt honours scope |
| 12 | ECS runner | `subpath` in manifest → sparse-checkout; subpath injected into skill prompt |
| 13 | CLI + Lambda | `LATEST_REVIEWED_VERSION` pointer record; `GetItem` replaces invalid `begins_with(PK)` |
| 14 | ECS + CLI | 5-line code window `contentFingerprint`; `diff` uses 3-tier matching |
| 15 | Webhook Lambda | `timingSafeEqual` for GitLab token (was plain `!==`) |
| 16 | Lambda | `publishSarifUpload()` → SQS → `GitHubStatusLambda` → GitHub Code Scanning API |
| 17 | CDK | `WebhookLambda` removed from VPC; routes status through `GitHubStatusQueue` |
| 18 | CLI + ECS | `statSync` size check before upload; streaming `Upload`; pre-extraction tar index scan |
| 19 | CLI + Lambda | `contentHash` field + GSI4-ContentHash; `duplicates` + `affected` commands |
| 20 | CLI | Full `review status` implementation; `resolveLatestVersion` pointer lookup |
| 21 | CDK + Lambda | `GitHubStatusLambda` outside VPC; `GitHubStatusQueue` SQS; retry with backoff |
