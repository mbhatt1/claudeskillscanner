# Skills as a Service — Specification Part 25: Automated Security Code Review Extension

**Version:** 1.0.0  
**Status:** AUTHORITATIVE — drop into Claude Code to implement  
**Depends on:** SPEC-01 through SPEC-10 (base system must be deployed)  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | ... | [Part 10](SPEC-10-skill-registry.md) | [Part 25: Code Review Extension]

---

## 1. Overview

This spec extends the existing Skills as a Service system to support automated security code review at scale — hundreds of packages per run — with zero changes to the core pipeline (SQS → Lambda → ECS → OpenSearch). All additions are additive.

### What changes vs. the base system

| Component | Change |
|-----------|--------|
| `packages/skills/code-review/` | **New** — built-in skill (prompt + manifest) |
| `packages/ecs-runner/src/main.ts` | **Extended** — `tarball` and `git` input modes |
| `packages/cli/src/commands/review/` | **New** — `review` command group |
| `packages/cli/src/utils/sarif.ts` | **New** — SARIF 2.1.0 converter |
| `packages/lambda/src/webhook/handler.ts` | **New** — GitHub/GitLab webhook Lambda |
| `infra/lib/code-review-stack.ts` | **New** — `CodeReviewStack` (findings table + webhook API) |
| `infra/bin/app.ts` | **Updated** — wire `CodeReviewStack` |
| `scripts/register-code-review-skill.sh` | **New** — post-deploy skill registration |

### What does NOT change

- `NetworkStack`, `SecurityStack`, `StorageStack`, `MessagingStack` — unchanged
- The SQS → SkillsIngestionLambda → ECS pipeline — unchanged; code review jobs flow through it
- The OpenSearch `skills-results` index schema — unchanged; findings are stored in a separate DynamoDB table
- The existing CLI commands (`upload`, `query`, `status`, etc.) — unchanged

---

## 2. Architecture Diagram (additions highlighted)

```
                          ┌────────────────────────────────────────────────┐
                          │         NEW: Two submission paths              │
                          │                                                │
  Developer/CI ──────────▶│  [A] skills-svc review batch --manifest f.json│
                          │      → uploads tarballs to S3                  │
                          │      → submits Step Functions for each pkg     │
                          │                                                │
  GitHub/GitLab ─────────▶│  [B] WebhookLambda (API Gateway HTTP API)    │
  (PR / tag push)         │      → validates HMAC-SHA256 signature         │
                          │      → writes S3 metadata (input-mode: git)   │
                          │      → posts GitHub "pending" status check     │
                          └───────────────┬────────────────────────────────┘
                                          │ Both paths:
                                          │ S3 PutObject → SQS → SkillsIngestionLambda
                                          ▼
                          ┌────────────────────────────────────────────────┐
                          │  ECS Runner (extended)                         │
                          │  Reads S3 metadata `input-mode`               │
                          │                                                │
                          │  tarball mode:                                 │
                          │    download JOB_SOURCE_KEY from S3            │
                          │    extract tarball/zip into workdir            │
                          │                                                │
                          │  git mode:                                     │
                          │    git clone --depth 1 <url> @<sha>           │
                          │    (requires git in container image)           │
                          │                                                │
                          │  Both: copy skill files → run claude CLI      │
                          │  with code-review skill prompt                 │
                          │  Output: structured JSON findings              │
                          └───────────────┬────────────────────────────────┘
                                          │
                                          ▼
                          ┌────────────────────────────────────────────────┐
                          │  ResultsProcessorLambda (extended)             │
                          │  Existing: indexes to OpenSearch               │
                          │  New: writes per-finding records to            │
                          │       findings DynamoDB table                  │
                          │  New: if github metadata present →            │
                          │       post GitHub Checks API update            │
                          └───────────┬──────────────┬─────────────────────┘
                                      │              │
                              ┌───────▼───┐   ┌──────▼────────────────┐
                              │ DynamoDB  │   │ GitHub Checks API      │
                              │ findings  │   │ (pending→success/fail) │
                              │ table     │   └───────────────────────┘
                              └───────────┘
                                      │
                          ┌───────────▼───────────────────────────────────┐
                          │  CLI: skills-svc review findings/report/diff  │
                          │  Queries DynamoDB findings table               │
                          │  Generates SARIF / JSON / Markdown reports     │
                          └───────────────────────────────────────────────┘
```

---

## 3. Built-in Code Review Skill

### 3.1 `packages/skills/code-review/manifest.json`

```json
{
  "name": "code-review",
  "version": "1.0.0",
  "description": "Automated security code review skill. Analyzes source code for vulnerabilities, produces structured findings in JSON with CWE IDs, severity ratings, file/line references, and remediation recommendations.",
  "author": "skills-as-a-service/built-in",
  "visibility": "org",
  "skills": ["security-review"],
  "defaultPrompt": "Perform a comprehensive security code review of the provided source code. Output ONLY valid JSON matching the findings schema. No prose before or after the JSON.",
  "outputSchema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["findings", "summary", "risk_level"],
    "properties": {
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["id", "severity", "cwe_id", "file", "line", "description", "recommendation", "confidence"],
          "properties": {
            "id":             { "type": "string", "description": "Unique finding ID, e.g. FINDING-001" },
            "severity":       { "type": "string", "enum": ["critical", "high", "medium", "low", "info"] },
            "cwe_id":         { "type": "string", "description": "CWE identifier, e.g. CWE-79" },
            "file":           { "type": "string", "description": "Relative file path within the repo" },
            "line":           { "type": "integer", "description": "Line number of the finding" },
            "description":    { "type": "string", "description": "Detailed description of the vulnerability" },
            "recommendation": { "type": "string", "description": "Specific remediation steps" },
            "confidence":     { "type": "string", "enum": ["high", "medium", "low"] }
          }
        }
      },
      "summary":    { "type": "string", "description": "Executive summary of the security posture" },
      "risk_level": { "type": "string", "enum": ["critical", "high", "medium", "low", "none"] }
    }
  },
  "tags": {
    "category": "security",
    "type": "built-in"
  }
}
```

### 3.2 `packages/skills/code-review/skills/security-review.md`

````markdown
# Security Code Review Skill

You are an expert security engineer performing a thorough automated security code review.
Your task is to analyze ALL source files in the working directory for security vulnerabilities.

## Scope

Review every source file present. Focus on but do not limit yourself to:
- Injection flaws: SQL injection, command injection, LDAP injection, XPath injection
- Cross-site scripting (XSS): reflected, stored, DOM-based
- Broken authentication: hardcoded credentials, weak session management, missing MFA enforcement
- Sensitive data exposure: secrets in code, unencrypted PII at rest or in transit
- Insecure deserialization: pickle, Java serialization, YAML.load, eval on untrusted input
- Broken access control: missing authorization checks, IDOR, path traversal
- Security misconfiguration: debug flags in prod, permissive CORS, directory listing
- Vulnerable dependencies: known-vulnerable imports (note them but focus on code-level issues)
- Cryptographic failures: MD5/SHA1 for passwords, ECB mode, hardcoded IV/salt
- SSRF: user-controlled URLs passed to HTTP clients without allow-listing
- XXE: XML parsers with external entity expansion enabled
- Race conditions and TOCTOU vulnerabilities
- Memory safety issues (for C/C++/Rust unsafe): buffer overflows, use-after-free
- Prototype pollution (JavaScript/TypeScript)
- Template injection: server-side template injection in Jinja2, Handlebars, Twig, etc.

## Analysis Method

1. Read each source file. Note language, framework, and dependencies.
2. Trace data flow from user-controlled inputs (HTTP params, headers, env vars, file uploads) to sinks (DB queries, shell commands, file writes, HTML output).
3. For each vulnerability found, record the exact file path and line number.
4. Assess severity using CVSS v3.1 guidance:
   - **critical**: CVSS ≥ 9.0 — directly exploitable RCE, auth bypass with no preconditions
   - **high**: CVSS 7.0–8.9 — significant data exposure, privilege escalation
   - **medium**: CVSS 4.0–6.9 — requires some precondition, moderate impact
   - **low**: CVSS < 4.0 — defense-in-depth, best practice violations
   - **info**: no CVSS score — observations that warrant attention but are not vulnerabilities
5. Assign the most specific CWE ID applicable. See https://cwe.mitre.org/ for reference.
6. Write a concrete, actionable recommendation — include specific API names or code patterns to use instead.
7. Assign confidence:
   - **high**: the code path is definitively vulnerable with no mitigating context
   - **medium**: likely vulnerable, but could be mitigated elsewhere in codebase
   - **low**: possibly vulnerable; requires runtime context to confirm

## Output Format

You MUST output ONLY a single JSON object. No markdown fences, no prose, no explanations outside the JSON.
The JSON must match this exact schema:

```json
{
  "findings": [
    {
      "id": "FINDING-001",
      "severity": "high",
      "cwe_id": "CWE-89",
      "file": "src/db/queries.py",
      "line": 42,
      "description": "User-supplied parameter `username` is concatenated directly into a SQL query string without parameterization, enabling SQL injection.",
      "recommendation": "Use parameterized queries or an ORM. Replace `f'SELECT * FROM users WHERE name={username}'` with `cursor.execute('SELECT * FROM users WHERE name = %s', (username,))`.",
      "confidence": "high"
    }
  ],
  "summary": "The codebase contains 3 high-severity and 1 medium-severity vulnerabilities. The most critical issue is SQL injection in the authentication module. Immediate remediation is recommended before production deployment.",
  "risk_level": "high"
}
```

If no vulnerabilities are found, return:
```json
{
  "findings": [],
  "summary": "No security vulnerabilities were identified in the reviewed source code.",
  "risk_level": "none"
}
```

Do not include findings for test files unless the test helper code would ship to production.
Do not include speculative findings without evidence in the actual source.
````

---

## 4. Extended Shared Types

### 4.1 `packages/shared/src/types.ts` — additions (append to existing file)

```typescript
// ── Code Review Types ────────────────────────────────────────────────────────

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingConfidence = 'high' | 'medium' | 'low';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type InputMode = 'tarball' | 'git';
export type ReportFormat = 'sarif' | 'json' | 'markdown';

export interface SecurityFinding {
  id: string;            // FINDING-NNN
  severity: FindingSeverity;
  cwe_id: string;        // e.g. "CWE-89"
  file: string;          // relative path
  line: number;
  description: string;
  recommendation: string;
  confidence: FindingConfidence;
}

export interface ReviewOutput {
  findings: SecurityFinding[];
  summary: string;
  risk_level: RiskLevel;
}

/** Stored in DynamoDB findings table */
export interface FindingRecord extends SecurityFinding {
  packageName: string;
  packageVersion: string;
  jobId: string;
  language?: string;
  sourceRef?: string;   // git commit SHA or tarball S3 key
  createdAt: string;
  ttl: number;
}

/** Manifest file format for `review batch` */
export interface BatchManifestEntry {
  name: string;
  version: string;
  /** tarball path OR "git+https://...@<sha>" */
  source: string;
  language?: string;
}

/** S3 object metadata keys for code review jobs */
export interface CodeReviewJobMetadata {
  'input-mode': InputMode;
  'package-name': string;
  'package-version': string;
  'source-ref'?: string;       // git SHA or tarball s3 key
  'github-repo'?: string;      // owner/repo
  'github-commit-sha'?: string;
  'github-installation-id'?: string;
  'gitlab-project-id'?: string;
  'gitlab-commit-sha'?: string;
}

// Extend DDB_KEY_PREFIX constant
export const FINDINGS_KEY_PREFIX = {
  PACKAGE: 'PKG#',
  FINDING: 'FINDING#',
} as const;
```

---

## 5. ECS Runner Extensions

### 5.1 `packages/ecs-runner/src/main.ts` — full replacement

```typescript
import * as path from 'path';
import * as fs from 'fs/promises';
import { downloadZip } from './downloader';
import { downloadTarball } from './tarball-downloader';
import { extractZip } from './extractor';
import { extractTarball } from './tarball-extractor';
import { cloneRepo } from './git-cloner';
import { runSkills } from './runner';
import { uploadResults } from './uploader';
import { updateJobStatus } from './job-status';
import { JobStatus, InputMode } from '@skills-svc/shared';

process.on('SIGTERM', () => {
  console.log(JSON.stringify({ event: 'sigterm_received', message: 'Graceful shutdown initiated' }));
  process.exit(1);
});

async function main(): Promise<void> {
  const jobId       = requireEnv('JOB_ID');
  const env         = process.env.ENV ?? 'prod';
  const inputMode   = (process.env.INPUT_MODE ?? 'zip') as InputMode | 'zip';

  console.log(JSON.stringify({ event: 'task_start', jobId, inputMode }));

  try {
    await updateJobStatus(jobId, JobStatus.RUNNING, env);

    const workDir = '/tmp/workspace';
    const sourceDir = path.join(workDir, 'source');
    await fs.mkdir(sourceDir, { recursive: true });

    if (inputMode === 'tarball') {
      // ── Tarball/zip mode ─────────────────────────────────────────────
      // Source package uploaded to S3; ECS downloads and extracts it.
      const s3Bucket    = requireEnv('S3_BUCKET');
      const sourceKey   = requireEnv('JOB_SOURCE_KEY');

      console.log(JSON.stringify({ event: 'tarball_mode', s3Bucket, sourceKey }));
      const tarPath = path.join(workDir, 'source.tar.gz');
      await downloadTarball(s3Bucket, sourceKey, tarPath);
      await extractTarball(tarPath, sourceDir);

    } else if (inputMode === 'git') {
      // ── Git clone mode ───────────────────────────────────────────────
      // ECS clones the repo at the given URL and ref (commit SHA or tag).
      const gitUrl = requireEnv('JOB_GIT_URL');
      const gitRef = requireEnv('JOB_GIT_REF');

      console.log(JSON.stringify({ event: 'git_mode', gitUrl, gitRef }));
      await cloneRepo(gitUrl, gitRef, sourceDir);

    } else {
      // ── Legacy zip mode (original pipeline) ─────────────────────────
      const s3Bucket = requireEnv('S3_BUCKET');
      const s3Key    = requireEnv('S3_KEY');

      const zipPath = path.join(workDir, 'upload.zip');
      await downloadZip(s3Bucket, s3Key, zipPath);
      await extractZip(zipPath, sourceDir);
    }

    // Skill files are always fetched from the registry via SSM param
    // pointing to the code-review skill zip, pre-staged at deploy time.
    // For review jobs, JOB_SKILL_KEY overrides the default skill.
    const skillKey    = process.env.JOB_SKILL_KEY;
    const skillsBucket = process.env.S3_BUCKET ?? requireEnv('S3_BUCKET');
    const skillsDir   = path.join(workDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    if (skillKey) {
      const skillZipPath = path.join(workDir, 'skill.zip');
      await downloadZip(skillsBucket, skillKey, skillZipPath);
      await extractZip(skillZipPath, skillsDir);
    } else {
      // Default: use code-review skill baked into the image at /app/skills/code-review
      await fs.cp('/app/skills/code-review', skillsDir, { recursive: true });
    }

    const results = await runSkills(skillsDir, sourceDir, jobId, env);
    const resultKey = await uploadResults(jobId, results, env);

    console.log(JSON.stringify({ event: 'task_complete', jobId, resultKey }));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ event: 'task_error', jobId, err: String(err) }));
    try {
      await updateJobStatus(jobId, JobStatus.FAILED, env, String(err));
    } catch (updateErr) {
      console.error(JSON.stringify({ event: 'status_update_error', err: String(updateErr) }));
    }
    process.exit(1);
  }
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required env var ${name} is not set`);
  return val;
}

main();
```

### 5.2 `packages/ecs-runner/src/tarball-downloader.ts` — new file

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const s3 = new S3Client({});

export async function downloadTarball(bucket: string, key: string, destPath: string): Promise<void> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`Empty S3 body for s3://${bucket}/${key}`);

  await pipeline(res.Body as Readable, createWriteStream(destPath));
  console.log(JSON.stringify({ event: 'tarball_downloaded', bucket, key, destPath }));
}
```

### 5.3 `packages/ecs-runner/src/tarball-extractor.ts` — new file

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

/** Supported archive extensions */
const TAR_EXTS  = ['.tar.gz', '.tgz', '.tar.bz2', '.tar.xz', '.tar'];
const ZIP_EXTS  = ['.zip'];

export async function extractTarball(archivePath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });

  const basename = path.basename(archivePath).toLowerCase();

  if (ZIP_EXTS.some(ext => basename.endsWith(ext))) {
    // Use unzip — already present from existing Dockerfile
    await execFileAsync('unzip', ['-q', '-o', archivePath, '-d', destDir]);
  } else if (TAR_EXTS.some(ext => basename.endsWith(ext))) {
    // --strip-components=1 removes the top-level directory common in tarballs
    // --no-same-owner avoids chown errors in container
    await execFileAsync('tar', [
      '--extract',
      '--file', archivePath,
      '--directory', destDir,
      '--strip-components=1',
      '--no-same-owner',
      '--no-overwrite-dir',
    ]);
  } else {
    throw new Error(`Unsupported archive format: ${basename}`);
  }

  // Security: verify no symlinks escape destDir after extraction
  await verifyNoEscape(destDir);
  console.log(JSON.stringify({ event: 'tarball_extracted', archivePath, destDir }));
}

async function verifyNoEscape(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true } as any);
  for (const entry of entries as any[]) {
    if (entry.isSymbolicLink?.()) {
      const linkPath = path.join(entry.path ?? dir, entry.name);
      const target = await fs.realpath(linkPath).catch(() => '');
      if (target && !target.startsWith(resolved)) {
        throw new Error(`Symlink escape detected: ${linkPath} → ${target}`);
      }
    }
  }
}
```

### 5.4 `packages/ecs-runner/src/git-cloner.ts` — new file

```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const GIT_CLONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Clone a git repository at a specific ref (commit SHA, tag, or branch).
 * Uses --depth 1 for speed. For commit SHAs that are not branch heads,
 * uses a two-step: clone default branch, then checkout the SHA.
 *
 * @param gitUrl  HTTPS URL of the repository (no embedded credentials)
 * @param gitRef  Full commit SHA (40 chars) or refs/tags/<tag>
 * @param destDir Absolute path to clone into (must be under /tmp)
 */
export async function cloneRepo(gitUrl: string, gitRef: string, destDir: string): Promise<void> {
  if (!destDir.startsWith('/tmp/')) {
    throw new Error(`destDir must be under /tmp/, got: ${destDir}`);
  }

  // Sanitize URL — reject anything that is not https:// or ssh:// to prevent injection
  if (!gitUrl.startsWith('https://') && !gitUrl.startsWith('ssh://git@')) {
    throw new Error(`Unsupported git URL scheme. Only https:// and ssh://git@ are permitted.`);
  }

  // Sanitize ref — allow hex SHAs, refs/tags/..., refs/heads/...
  if (!/^[a-zA-Z0-9/._-]{1,256}$/.test(gitRef)) {
    throw new Error(`Invalid git ref: ${gitRef}`);
  }

  const isFullSha = /^[0-9a-f]{40}$/.test(gitRef);

  console.log(JSON.stringify({ event: 'git_clone_start', gitUrl, gitRef, isFullSha }));

  if (isFullSha) {
    // Commit SHAs may not be branch heads — clone with partial then fetch specific commit
    await execFileWithTimeout('git', [
      'clone',
      '--depth', '1',
      '--no-tags',
      '--',
      gitUrl,
      destDir,
    ], GIT_CLONE_TIMEOUT_MS);

    // Try to fetch the exact commit if it differs from HEAD
    try {
      await execFileWithTimeout('git', ['-C', destDir, 'fetch', '--depth', '1', 'origin', gitRef], 30_000);
      await execFileWithTimeout('git', ['-C', destDir, 'checkout', gitRef], 10_000);
    } catch {
      // If the exact SHA is already HEAD (from depth=1 clone), this is fine
      const { stdout } = await execFileAsync('git', ['-C', destDir, 'rev-parse', 'HEAD']);
      if (stdout.trim() !== gitRef) {
        throw new Error(`Could not checkout commit ${gitRef} — it may not be reachable with depth=1`);
      }
    }
  } else {
    // Tag or branch reference
    await execFileWithTimeout('git', [
      'clone',
      '--depth', '1',
      '--branch', gitRef,
      '--no-tags',
      '--single-branch',
      '--',
      gitUrl,
      destDir,
    ], GIT_CLONE_TIMEOUT_MS);
  }

  // Remove .git directory — not needed for analysis, reduces disk usage
  await execFileAsync('rm', ['-rf', path.join(destDir, '.git')]);

  console.log(JSON.stringify({ event: 'git_clone_complete', gitUrl, gitRef, destDir }));
}

async function execFileWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 });
}
```

### 5.5 Updated `packages/ecs-runner/Dockerfile` — add git

```dockerfile
# ---- Builder stage ----
FROM node:20-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim AS runtime

# Install system dependencies including git for git-clone input mode
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
      git \
      tar \
      && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Harden git: disallow unsafe directory (CVE-2022-24765)
RUN git config --global safe.directory '/tmp/*'

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code@latest --ignore-scripts

# Create non-root user
RUN groupadd -g 1000 runner && \
    useradd -u 1000 -g runner -s /bin/bash -m -d /home/runner runner

WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules

# Bake the built-in code-review skill into the image
COPY ../../packages/skills/code-review /app/skills/code-review

# /tmp is the only writable area (root FS will be read-only)
RUN mkdir -p /tmp/workspace && chown runner:runner /tmp/workspace

USER 1000:1000

ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
```

---

## 6. Findings DynamoDB Table

### 6.1 `infra/lib/code-review-stack.ts` — new file

```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface CodeReviewStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  dynamodbKey: kms.Key;
  lambdaEnvKey: kms.Key;
  uploadsBucket: string;   // bucket name (from StorageStack SSM param)
  ecsClusterArn: string;   // from SSM
  ecsTaskDefArn: string;   // from SSM
  ingestionQueueUrl: string; // to submit jobs directly
}

export class CodeReviewStack extends cdk.Stack {
  public readonly findingsTable: dynamodb.Table;
  public readonly webhookFn: lambda.Function;
  public readonly webhookApi: apigatewayv2.HttpApi;

  constructor(scope: Construct, id: string, props: CodeReviewStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // ── Findings DynamoDB Table ──────────────────────────────────────────────
    // Schema:
    //   PK = PKG#{packageName}#{packageVersion}
    //   SK = FINDING#{findingId}
    //   GSI1: severity-index  PK=PKG#{name}#{ver}#SEV#{severity}, SK=CREATED_AT#{iso}
    //   GSI2: cwe-index       PK=CWE#{cweId}, SK=CREATED_AT#{iso}
    //   GSI3: job-index       PK=JOB#{jobId}, SK=FINDING#{findingId}
    this.findingsTable = new dynamodb.Table(this, 'FindingsTable', {
      tableName: `skills-svc-findings-${this.account}-${this.region}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dynamodbKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI1: query by package+severity
    this.findingsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-Severity',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: query by CWE ID across all packages
    this.findingsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-CWE',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: query all findings for a job
    this.findingsTable.addGlobalSecondaryIndex({
      indexName: 'GSI3-Job',
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // SSM param for other stacks to reference
    new ssm.StringParameter(this, 'FindingsTableParam', {
      parameterName: `/skills-svc/${envName}/dynamodb/findings-table-name`,
      stringValue: this.findingsTable.tableName,
    });

    // ── Webhook Lambda ────────────────────────────────────────────────────────
    const webhookLogGroup = new logs.LogGroup(this, 'WebhookLogGroup', {
      logGroupName: `/skills-svc/${envName}/lambda/webhook`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: props.lambdaEnvKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const webhookRole = new iam.Role(this, 'WebhookLambdaRole', {
      roleName: `skills-svc-webhook-lambda-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [webhookLogGroup.logGroupArn],
    }));
    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));
    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3PutMetadata',
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/reviews/*`],
    }));
    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KMSEncrypt',
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [props.dynamodbKey.keyArn, props.lambdaEnvKey.keyArn],
    }));
    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayWrite',
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));

    this.webhookFn = new lambda.Function(this, 'WebhookLambda', {
      functionName: `skills-svc-webhook-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      handler: 'webhook/handler.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      role: webhookRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ENV: envName,
        REGION: this.region,
        LOG_LEVEL: 'INFO',
      },
      description: 'Receives GitHub/GitLab webhooks, validates signatures, submits code review jobs',
    });

    // ── API Gateway HTTP API (public endpoint for GitHub/GitLab) ─────────────
    this.webhookApi = new apigatewayv2.HttpApi(this, 'WebhookApi', {
      apiName: `skills-svc-webhook-${envName}`,
      description: 'Public endpoint for GitHub and GitLab webhook events (code review)',
      createDefaultStage: true,
    });

    const webhookIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'WebhookIntegration',
      this.webhookFn,
    );

    this.webhookApi.addRoutes({
      path: '/webhook/github',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: webhookIntegration,
    });

    this.webhookApi.addRoutes({
      path: '/webhook/gitlab',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: webhookIntegration,
    });

    // ── WAF — Rate Limiting ──────────────────────────────────────────────────
    // WAF WebACL must be in us-east-1 for API Gateway regional APIs, or regional
    const webAcl = new wafv2.CfnWebACL(this, 'WebhookWaf', {
      name: `skills-svc-webhook-waf-${envName}`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `skills-svc-webhook-waf-${envName}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'WebhookRateLimit',
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: 500,          // 500 requests per 5-minute window per IP
              aggregateKeyType: 'IP',
            },
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSet',
            sampledRequestsEnabled: false,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        },
      ],
    });

    // Associate WAF with API Gateway stage
    new wafv2.CfnWebACLAssociation(this, 'WebhookWafAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.webhookApi.apiId}/stages/\$default`,
      webAclArn: webAcl.attrArn,
    });

    // SSM params
    new ssm.StringParameter(this, 'WebhookUrlParam', {
      parameterName: `/skills-svc/${envName}/webhook/api-url`,
      stringValue: this.webhookApi.apiEndpoint,
    });
  }
}
```

---

## 7. GitHub/GitLab Webhook Lambda Handler

### 7.1 `packages/lambda/src/webhook/handler.ts` — new file

```typescript
import { APIGatewayProxyHandlerV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { captureAWSv3Client } from 'aws-xray-sdk';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';

const s3 = captureAWSv3Client(new S3Client({}));
const ssm = captureAWSv3Client(new SSMClient({}));

const paramCache = new Map<string, { value: string; ts: number }>();

async function getParam(name: string): Promise<string> {
  const now = Date.now();
  const cached = paramCache.get(name);
  if (cached && now - cached.ts < 300_000) return cached.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM param not found: ${name}`);
  paramCache.set(name, { value, ts: now });
  return value;
}

function response(statusCode: number, body: object): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ── GitHub webhook handler ────────────────────────────────────────────────────

async function handleGitHub(
  headers: Record<string, string | undefined>,
  rawBody: string,
  env: string,
): Promise<APIGatewayProxyResultV2> {
  // 1. Validate HMAC-SHA256 signature
  const sigHeader = headers['x-hub-signature-256'] ?? '';
  const secret = await getParam(`/skills-svc/${env}/webhook/github-secret`);

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const sigBuffer = Buffer.from(sigHeader.padEnd(expected.length));
  const expBuffer = Buffer.from(expected);

  if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
    console.warn(JSON.stringify({ event: 'github_signature_invalid' }));
    return response(401, { error: 'Invalid signature' });
  }

  const event = headers['x-github-event'];
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  let repoUrl: string | undefined;
  let commitSha: string | undefined;
  let repoFullName: string | undefined;

  if (event === 'pull_request') {
    const action: string = payload.action;
    if (!['opened', 'synchronize', 'reopened'].includes(action)) {
      return response(200, { message: `Ignoring pull_request action: ${action}` });
    }
    repoUrl    = payload.pull_request?.head?.repo?.clone_url as string;
    commitSha  = payload.pull_request?.head?.sha as string;
    repoFullName = payload.repository?.full_name as string;

  } else if (event === 'push') {
    // Only trigger on tag pushes (refs/tags/...)
    const ref: string = payload.ref ?? '';
    if (!ref.startsWith('refs/tags/')) {
      return response(200, { message: `Ignoring push to non-tag ref: ${ref}` });
    }
    repoUrl    = payload.repository?.clone_url as string;
    commitSha  = payload.after as string;
    repoFullName = payload.repository?.full_name as string;
  } else {
    return response(200, { message: `Ignoring event: ${event}` });
  }

  if (!repoUrl || !commitSha || !repoFullName) {
    return response(400, { error: 'Missing required fields in GitHub payload' });
  }

  // 2. Submit review job via S3 metadata (flows through existing SQS → ECS pipeline)
  const uploadsBucket = await getParam(`/skills-svc/${env}/s3/uploads-bucket`);
  const jobId = randomUUID();
  const s3Key = `reviews/${repoFullName.replace('/', '_')}/${commitSha.slice(0, 8)}/${jobId}/trigger.json`;

  await s3.send(new PutObjectCommand({
    Bucket: uploadsBucket,
    Key: s3Key,
    Body: JSON.stringify({
      jobId,
      triggeredBy: 'github-webhook',
      repoUrl,
      commitSha,
      repoFullName,
      event,
    }),
    ContentType: 'application/json',
    Metadata: {
      'input-mode': 'git',
      'package-name': repoFullName.replace('/', '_'),
      'package-version': commitSha.slice(0, 8),
      'github-repo': repoFullName,
      'github-commit-sha': commitSha,
      'job-name': `github-${repoFullName}-${commitSha.slice(0, 8)}`,
      'user-arn': 'webhook',
      // ECS will read JOB_GIT_URL and JOB_GIT_REF from these SSM-resolved values
      'git-url': repoUrl,
      'git-ref': commitSha,
    },
  }));

  // 3. Post "pending" GitHub status check
  await postGitHubStatus({
    repoFullName,
    commitSha,
    state: 'pending',
    description: 'Security code review queued',
    context: 'skills-svc/security-review',
    env,
  });

  console.log(JSON.stringify({ event: 'github_webhook_processed', jobId, repoFullName, commitSha }));
  return response(202, { jobId, message: 'Review job submitted' });
}

// ── GitLab webhook handler ────────────────────────────────────────────────────

async function handleGitLab(
  headers: Record<string, string | undefined>,
  rawBody: string,
  env: string,
): Promise<APIGatewayProxyResultV2> {
  // Validate GitLab token
  const tokenHeader = headers['x-gitlab-token'] ?? '';
  const secret = await getParam(`/skills-svc/${env}/webhook/gitlab-secret`);

  if (tokenHeader !== secret) {
    console.warn(JSON.stringify({ event: 'gitlab_token_invalid' }));
    return response(401, { error: 'Invalid token' });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return response(400, { error: 'Invalid JSON body' });
  }

  const objectKind: string = payload.object_kind;
  let repoUrl: string | undefined;
  let commitSha: string | undefined;
  let projectId: string | undefined;

  if (objectKind === 'merge_request') {
    const action: string = payload.object_attributes?.action;
    if (!['open', 'update', 'reopen'].includes(action)) {
      return response(200, { message: `Ignoring merge_request action: ${action}` });
    }
    repoUrl   = payload.project?.http_url as string;
    commitSha = payload.object_attributes?.last_commit?.id as string;
    projectId = String(payload.project?.id ?? '');
  } else if (objectKind === 'tag_push') {
    repoUrl   = payload.project?.http_url as string;
    commitSha = payload.checkout_sha as string;
    projectId = String(payload.project?.id ?? '');
  } else {
    return response(200, { message: `Ignoring object_kind: ${objectKind}` });
  }

  if (!repoUrl || !commitSha || !projectId) {
    return response(400, { error: 'Missing required fields in GitLab payload' });
  }

  const uploadsBucket = await getParam(`/skills-svc/${env}/s3/uploads-bucket`);
  const jobId = randomUUID();
  const s3Key = `reviews/gitlab_${projectId}/${commitSha.slice(0, 8)}/${jobId}/trigger.json`;

  await s3.send(new PutObjectCommand({
    Bucket: uploadsBucket,
    Key: s3Key,
    Body: JSON.stringify({ jobId, triggeredBy: 'gitlab-webhook', repoUrl, commitSha, projectId }),
    ContentType: 'application/json',
    Metadata: {
      'input-mode': 'git',
      'package-name': `gitlab_${projectId}`,
      'package-version': commitSha.slice(0, 8),
      'gitlab-project-id': projectId,
      'gitlab-commit-sha': commitSha,
      'job-name': `gitlab-${projectId}-${commitSha.slice(0, 8)}`,
      'user-arn': 'webhook',
      'git-url': repoUrl,
      'git-ref': commitSha,
    },
  }));

  console.log(JSON.stringify({ event: 'gitlab_webhook_processed', jobId, projectId, commitSha }));
  return response(202, { jobId, message: 'Review job submitted' });
}

// ── GitHub Checks API helper ─────────────────────────────────────────────────

interface GitHubStatusParams {
  repoFullName: string;
  commitSha: string;
  state: 'pending' | 'success' | 'failure' | 'error';
  description: string;
  context: string;
  env: string;
  targetUrl?: string;
}

export async function postGitHubStatus(params: GitHubStatusParams): Promise<void> {
  let token: string;
  try {
    token = await getParam(`/skills-svc/${params.env}/webhook/github-token`);
  } catch {
    console.warn(JSON.stringify({ event: 'github_token_missing', message: 'No GitHub token in SSM — skipping status post' }));
    return;
  }

  const url = `https://api.github.com/repos/${params.repoFullName}/statuses/${params.commitSha}`;
  const body = {
    state: params.state,
    description: params.description.slice(0, 140), // GitHub limit
    context: params.context,
    ...(params.targetUrl ? { target_url: params.targetUrl } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'skills-svc-webhook/1.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(JSON.stringify({
      event: 'github_status_post_failed',
      status: res.status,
      body: await res.text().catch(() => ''),
    }));
  } else {
    console.log(JSON.stringify({ event: 'github_status_posted', state: params.state, commitSha: params.commitSha }));
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const env = process.env.ENV ?? 'prod';
  const rawBody = event.body ?? '';
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }

  const path = event.rawPath ?? '';

  try {
    if (path.startsWith('/webhook/github')) {
      return await handleGitHub(headers, rawBody, env);
    } else if (path.startsWith('/webhook/gitlab')) {
      return await handleGitLab(headers, rawBody, env);
    } else {
      return response(404, { error: 'Unknown webhook path' });
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'webhook_error', err: String(err) }));
    return response(500, { error: 'Internal server error' });
  }
};
```

---

## 8. ResultsProcessorLambda Extension

### 8.1 `packages/lambda/src/results-processor/findings-writer.ts` — new file

```typescript
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { FindingRecord, ReviewOutput, SecurityFinding } from '@skills-svc/shared';

interface WriteOptions {
  ddbClient: DynamoDBDocumentClient;
  findingsTable: string;
  packageName: string;
  packageVersion: string;
  jobId: string;
  language?: string;
  sourceRef?: string;
}

/**
 * Writes per-finding records to the findings DynamoDB table.
 * Uses BatchWrite (up to 25 items per call) for efficiency.
 */
export async function writeFindingsToTable(
  reviewOutput: ReviewOutput,
  opts: WriteOptions,
): Promise<void> {
  if (reviewOutput.findings.length === 0) {
    console.log(JSON.stringify({ event: 'no_findings', packageName: opts.packageName }));
    return;
  }

  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year

  const records: FindingRecord[] = reviewOutput.findings.map((f: SecurityFinding) => ({
    ...f,
    packageName: opts.packageName,
    packageVersion: opts.packageVersion,
    jobId: opts.jobId,
    language: opts.language,
    sourceRef: opts.sourceRef,
    createdAt: now,
    ttl,
  }));

  // Write in batches of 25 (DynamoDB limit)
  const BATCH_SIZE = 25;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const requestItems = batch.map((r) => ({
      PutRequest: {
        Item: {
          // Primary key: package + version
          PK: `PKG#${r.packageName}#${r.packageVersion}`,
          SK: `FINDING#${r.id}`,
          // GSI1: query by package+severity
          GSI1PK: `PKG#${r.packageName}#${r.packageVersion}#SEV#${r.severity}`,
          GSI1SK: `CREATED_AT#${r.createdAt}`,
          // GSI2: query by CWE across all packages
          GSI2PK: `CWE#${r.cwe_id}`,
          GSI2SK: `CREATED_AT#${r.createdAt}`,
          // GSI3: query by job
          GSI3PK: `JOB#${r.jobId}`,
          GSI3SK: `FINDING#${r.id}`,
          ...r,
        },
      },
    }));

    await opts.ddbClient.send(new BatchWriteCommand({
      RequestItems: { [opts.findingsTable]: requestItems },
    }));
  }

  console.log(JSON.stringify({
    event: 'findings_written',
    count: records.length,
    packageName: opts.packageName,
    packageVersion: opts.packageVersion,
  }));
}
```

### 8.2 Additions to `packages/lambda/src/results-processor/handler.ts`

Add these lines to the existing `ResultsProcessorLambda` handler after the OpenSearch indexing block:

```typescript
// ── CODE REVIEW EXTENSION: write findings + GitHub status ──────────────────

// Check if this is a code review job
const packageName = current.Item['package-name'] as string | undefined;
const packageVersion = current.Item['package-version'] as string | undefined;

if (succeeded && packageName && packageVersion && s3ResultKey) {
  try {
    // Parse the result as a ReviewOutput (findings schema)
    const resultObj = JSON.parse(/* already downloaded result json above */);
    const reviewOutput = resultObj as ReviewOutput;

    if (reviewOutput.findings !== undefined) {
      const findingsTableName = await getParam(`/skills-svc/${env}/dynamodb/findings-table-name`);
      await writeFindingsToTable(reviewOutput, {
        ddbClient: ddb,
        findingsTable: findingsTableName,
        packageName,
        packageVersion,
        jobId,
        language: current.Item.language as string | undefined,
        sourceRef: current.Item['source-ref'] as string | undefined,
      });
    }
  } catch (findingsErr) {
    console.error(JSON.stringify({ event: 'findings_write_error', jobId, err: String(findingsErr) }));
    // Non-fatal — do not fail the job
  }
}

// GitHub Checks API update
const githubRepo   = current.Item['github-repo'] as string | undefined;
const githubCommit = current.Item['github-commit-sha'] as string | undefined;

if (githubRepo && githubCommit) {
  try {
    const findingCount = (current.Item.findingCount as number | undefined) ?? 0;
    const riskLevel    = current.Item.riskLevel as string | undefined;

    await postGitHubStatus({
      repoFullName: githubRepo,
      commitSha: githubCommit,
      state: succeeded ? (findingCount > 0 && riskLevel === 'critical' ? 'failure' : 'success') : 'error',
      description: succeeded
        ? `Security review complete: ${findingCount} finding(s), risk level: ${riskLevel ?? 'none'}`
        : `Security review failed — check job ${jobId}`,
      context: 'skills-svc/security-review',
      env,
    });
  } catch (ghErr) {
    console.error(JSON.stringify({ event: 'github_status_update_error', jobId, err: String(ghErr) }));
  }
}
```

---

## 9. SARIF Converter

### 9.1 `packages/cli/src/utils/sarif.ts` — new file

```typescript
import { FindingRecord, FindingSeverity } from '@skills-svc/shared';

// SARIF 2.1.0 — https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: SarifRun[];
}

interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  artifacts: SarifArtifact[];
}

interface SarifTool {
  driver: {
    name: string;
    version: string;
    informationUri: string;
    rules: SarifRule[];
  };
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  helpUri: string;
  properties: { tags: string[]; 'security-severity': string };
  defaultConfiguration: { level: SarifLevel };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: SarifLocation[];
  properties: { confidence: string; recommendation: string };
}

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number };
  };
}

interface SarifArtifact {
  location: { uri: string; uriBaseId: string };
}

type SarifLevel = 'error' | 'warning' | 'note' | 'none';

const SEVERITY_TO_LEVEL: Record<FindingSeverity, SarifLevel> = {
  critical: 'error',
  high:     'error',
  medium:   'warning',
  low:      'note',
  info:     'none',
};

// CVSS approximate scores for SARIF security-severity property
const SEVERITY_TO_SCORE: Record<FindingSeverity, string> = {
  critical: '9.5',
  high:     '7.5',
  medium:   '5.0',
  low:      '2.5',
  info:     '0.0',
};

/**
 * Converts an array of FindingRecord (from DynamoDB) to a SARIF 2.1.0 log.
 * Deduplicates rules by CWE ID.
 */
export function findingsToSarif(findings: FindingRecord[], packageName: string, packageVersion: string): SarifLog {
  // Build rule set — one rule per unique CWE ID
  const ruleMap = new Map<string, SarifRule>();
  const artifactUris = new Set<string>();

  for (const f of findings) {
    if (!ruleMap.has(f.cwe_id)) {
      ruleMap.set(f.cwe_id, {
        id: f.cwe_id,
        name: cweToRuleName(f.cwe_id),
        shortDescription: { text: f.description.slice(0, 120) },
        fullDescription: { text: f.description },
        helpUri: `https://cwe.mitre.org/data/definitions/${f.cwe_id.replace('CWE-', '')}.html`,
        properties: {
          tags: ['security', f.severity, f.cwe_id],
          'security-severity': SEVERITY_TO_SCORE[f.severity],
        },
        defaultConfiguration: { level: SEVERITY_TO_LEVEL[f.severity] },
      });
    }
    artifactUris.add(f.file);
  }

  const results: SarifResult[] = findings.map((f) => ({
    ruleId: f.cwe_id,
    level: SEVERITY_TO_LEVEL[f.severity],
    message: { text: f.description },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: f.file, uriBaseId: '%SRCROOT%' },
        region: { startLine: f.line },
      },
    }],
    properties: {
      confidence: f.confidence,
      recommendation: f.recommendation,
    },
  }));

  const artifacts: SarifArtifact[] = Array.from(artifactUris).map((uri) => ({
    location: { uri, uriBaseId: '%SRCROOT%' },
  }));

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'skills-svc-security-review',
          version: '1.0.0',
          informationUri: 'https://github.com/your-org/skills-as-a-service',
          rules: Array.from(ruleMap.values()),
        },
      },
      results,
      artifacts,
    }],
  };
}

function cweToRuleName(cweId: string): string {
  const num = cweId.replace('CWE-', '');
  // Map well-known CWEs to human-readable names
  const names: Record<string, string> = {
    '79':  'CrossSiteScripting',
    '89':  'SqlInjection',
    '78':  'OsCommandInjection',
    '22':  'PathTraversal',
    '502': 'DeserializationOfUntrustedData',
    '20':  'ImproperInputValidation',
    '287': 'ImproperAuthentication',
    '798': 'HardcodedCredentials',
    '327': 'BrokenOrRiskyCryptographicAlgorithm',
    '918': 'ServerSideRequestForgery',
    '611': 'XxeInjection',
    '94':  'CodeInjection',
    '352': 'CrossSiteRequestForgery',
    '434': 'UnrestrictedFileUpload',
  };
  return names[num] ? `CWE${num}${names[num]}` : `CWE${num}`;
}
```

---

## 10. CLI `review` Command Group

### 10.1 `packages/cli/src/commands/review/index.ts`

```typescript
import { Command } from 'commander';
import { reviewSubmit } from './submit';
import { reviewBatch } from './batch';
import { reviewStatus } from './status';
import { reviewFindings } from './findings';
import { reviewReport } from './report';
import { reviewDiff } from './diff';

export function registerReviewCommands(program: Command): void {
  const review = program
    .command('review')
    .description('Security code review commands — submit, query, and report findings');

  review
    .command('submit <source>')
    .description('Submit a single package for security code review')
    .requiredOption('--package-name <name>', 'Package name (used as identifier)')
    .requiredOption('--package-version <version>', 'Package version (semver or arbitrary string)')
    .option('--language <lang>', 'Primary language hint (python, javascript, go, java, etc.)')
    .option('--skill-version <ver>', 'code-review skill version to use (default: latest)', 'latest')
    .action(async (source: string, opts: {
      packageName: string;
      packageVersion: string;
      language?: string;
      skillVersion: string;
    }) => {
      await reviewSubmit(source, opts);
    });

  review
    .command('batch')
    .description('Submit multiple packages from a manifest file')
    .requiredOption('--manifest <file>', 'Path to JSON manifest file: [{name, version, source, language?}]')
    .option('--concurrency <n>', 'Max concurrent uploads', '10')
    .option('--dry-run', 'Parse manifest and validate sources without submitting')
    .action(async (opts: { manifest: string; concurrency: string; dryRun?: boolean }) => {
      await reviewBatch(opts);
    });

  review
    .command('status <packageName>')
    .description('Show latest review job status for a package')
    .option('--version <ver>', 'Specific version (default: latest)')
    .action(async (packageName: string, opts: { version?: string }) => {
      await reviewStatus(packageName, opts);
    });

  review
    .command('findings <packageName>')
    .description('Query security findings for a package')
    .option('--version <ver>', 'Package version (default: latest reviewed)')
    .option('--severity <level>', 'Filter by severity: critical|high|medium|low|info')
    .option('--cwe <id>', 'Filter by CWE ID, e.g. CWE-79')
    .option('--output <format>', 'Output format: table|json', 'table')
    .action(async (packageName: string, opts: {
      version?: string;
      severity?: string;
      cwe?: string;
      output: string;
    }) => {
      await reviewFindings(packageName, opts);
    });

  review
    .command('report <packageName>')
    .description('Generate a full security report')
    .requiredOption('--format <fmt>', 'Output format: sarif|json|markdown')
    .option('--version <ver>', 'Package version (default: latest)')
    .option('--output-file <path>', 'Write report to file instead of stdout')
    .action(async (packageName: string, opts: {
      format: string;
      version?: string;
      outputFile?: string;
    }) => {
      await reviewReport(packageName, opts);
    });

  review
    .command('diff <packageName>')
    .description('Compare findings between two package versions')
    .requiredOption('--from <version>', 'Base version')
    .requiredOption('--to <version>', 'Target version')
    .option('--output <format>', 'Output format: table|json', 'table')
    .action(async (packageName: string, opts: {
      from: string;
      to: string;
      output: string;
    }) => {
      await reviewDiff(packageName, opts);
    });
}
```

### 10.2 `packages/cli/src/commands/review/submit.ts`

```typescript
import * as path from 'path';
import * as fs from 'fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { loadConfig } from '../../utils/config';
import { makeS3Client } from '../../utils/aws-clients';
import chalk from 'chalk';

interface SubmitOptions {
  packageName: string;
  packageVersion: string;
  language?: string;
  skillVersion: string;
}

const GIT_SOURCE_PATTERN = /^git\+https?:\/\/(.+?)@([0-9a-f]{40}|[a-zA-Z0-9/_.-]+)$/;

export async function reviewSubmit(source: string, opts: SubmitOptions): Promise<void> {
  const config = await loadConfig();
  const s3 = makeS3Client(config);
  const jobId = randomUUID();

  const isGit = GIT_SOURCE_PATTERN.test(source);

  if (isGit) {
    // git+https://github.com/owner/repo@<commit>
    const match = source.match(GIT_SOURCE_PATTERN);
    if (!match) throw new Error(`Invalid git source format: ${source}\nExpected: git+https://...@<commit-sha>`);
    const [, repoUrl, ref] = match;

    const s3Key = `reviews/${opts.packageName}/${opts.packageVersion}/${jobId}/trigger.json`;

    await s3.send(new PutObjectCommand({
      Bucket: config.uploadsBucket,
      Key: s3Key,
      Body: JSON.stringify({ jobId, triggeredBy: 'cli', repoUrl: `https://${repoUrl}`, ref }),
      ContentType: 'application/json',
      Metadata: {
        'input-mode': 'git',
        'package-name': opts.packageName,
        'package-version': opts.packageVersion,
        'job-name': `review-${opts.packageName}-${opts.packageVersion}`,
        'user-arn': config.userArn ?? 'cli',
        'git-url': `https://${repoUrl}`,
        'git-ref': ref,
        ...(opts.language ? { language: opts.language } : {}),
      },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.uploadsKeyId,
    }));

    console.log(chalk.green(`\n✓ Git review job submitted`));
    console.log(`  Job ID:  ${chalk.bold(jobId)}`);
    console.log(`  Package: ${opts.packageName}@${opts.packageVersion}`);
    console.log(`  Repo:    https://${repoUrl} @ ${ref}`);

  } else {
    // Local tarball/zip path
    const absPath = path.resolve(source);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Source file not found: ${absPath}`);
    }

    const ext = absPath.endsWith('.tar.gz') ? '.tar.gz'
      : absPath.endsWith('.tgz') ? '.tgz'
      : absPath.endsWith('.zip') ? '.zip'
      : path.extname(absPath);

    const s3Key = `reviews/${opts.packageName}/${opts.packageVersion}/${jobId}/source${ext}`;
    const fileBuffer = fs.readFileSync(absPath);

    await s3.send(new PutObjectCommand({
      Bucket: config.uploadsBucket,
      Key: s3Key,
      Body: fileBuffer,
      Metadata: {
        'input-mode': 'tarball',
        'package-name': opts.packageName,
        'package-version': opts.packageVersion,
        'job-source-key': s3Key,
        'job-name': `review-${opts.packageName}-${opts.packageVersion}`,
        'user-arn': config.userArn ?? 'cli',
        ...(opts.language ? { language: opts.language } : {}),
      },
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.uploadsKeyId,
    }));

    console.log(chalk.green(`\n✓ Tarball review job submitted`));
    console.log(`  Job ID:  ${chalk.bold(jobId)}`);
    console.log(`  Package: ${opts.packageName}@${opts.packageVersion}`);
    console.log(`  Source:  ${absPath} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
  }

  console.log(`\nTrack with: ${chalk.cyan(`skills-svc review status ${opts.packageName} --version ${opts.packageVersion}`)}`);
}
```

### 10.3 `packages/cli/src/commands/review/batch.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import pLimit from 'p-limit';
import chalk from 'chalk';
import { BatchManifestEntry } from '@skills-svc/shared';
import { reviewSubmit } from './submit';

interface BatchOptions {
  manifest: string;
  concurrency: string;
  dryRun?: boolean;
}

export async function reviewBatch(opts: BatchOptions): Promise<void> {
  const manifestPath = path.resolve(opts.manifest);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  let entries: BatchManifestEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BatchManifestEntry[];
  } catch (e) {
    throw new Error(`Failed to parse manifest: ${String(e)}`);
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Manifest must be a non-empty JSON array');
  }

  // Validate all entries before submitting
  for (const [i, entry] of entries.entries()) {
    if (!entry.name)    throw new Error(`Manifest entry ${i}: missing "name"`);
    if (!entry.version) throw new Error(`Manifest entry ${i}: missing "version"`);
    if (!entry.source)  throw new Error(`Manifest entry ${i}: missing "source"`);
  }

  console.log(chalk.bold(`\nBatch review: ${entries.length} package(s) from ${opts.manifest}`));

  if (opts.dryRun) {
    console.log(chalk.yellow('\nDry run — no jobs will be submitted:'));
    for (const e of entries) {
      console.log(`  ${e.name}@${e.version}  ${e.source}`);
    }
    return;
  }

  const concurrency = Math.max(1, Math.min(50, parseInt(opts.concurrency, 10)));
  const limit = pLimit(concurrency);

  let submitted = 0;
  let failed = 0;
  const errors: string[] = [];

  const tasks = entries.map((entry) =>
    limit(async () => {
      try {
        await reviewSubmit(entry.source, {
          packageName: entry.name,
          packageVersion: entry.version,
          language: entry.language,
          skillVersion: 'latest',
        });
        submitted++;
        process.stdout.write(chalk.green('.'));
      } catch (err) {
        failed++;
        errors.push(`${entry.name}@${entry.version}: ${String(err)}`);
        process.stdout.write(chalk.red('x'));
      }
    }),
  );

  await Promise.all(tasks);
  process.stdout.write('\n');

  console.log(chalk.bold(`\nBatch complete: ${submitted} submitted, ${failed} failed`));
  if (errors.length > 0) {
    console.log(chalk.red('\nErrors:'));
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  }
}
```

### 10.4 `packages/cli/src/commands/review/findings.ts`

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../utils/config';
import { makeDDBClient, makeSSMClient } from '../../utils/aws-clients';
import { FindingRecord, FindingSeverity } from '@skills-svc/shared';

interface FindingsOptions {
  version?: string;
  severity?: string;
  cwe?: string;
  output: string;
}

const SEVERITY_COLORS: Record<FindingSeverity, chalk.Chalk> = {
  critical: chalk.bgRed.white.bold,
  high:     chalk.red.bold,
  medium:   chalk.yellow,
  low:      chalk.cyan,
  info:     chalk.gray,
};

export async function reviewFindings(packageName: string, opts: FindingsOptions): Promise<void> {
  const config = await loadConfig();
  const ddbRaw = makeDDBClient(config);
  const ddb    = DynamoDBDocumentClient.from(ddbRaw);
  const ssm    = makeSSMClient(config);

  const env = config.env ?? 'prod';
  const findingsTable = await getParam(ssm, `/skills-svc/${env}/dynamodb/findings-table-name`);

  const version = opts.version ?? 'latest';

  let findings: FindingRecord[];

  if (opts.cwe) {
    // Query by CWE across all versions of this package using GSI2
    const res = await ddb.send(new QueryCommand({
      TableName: findingsTable,
      IndexName: 'GSI2-CWE',
      KeyConditionExpression: 'GSI2PK = :pk',
      FilterExpression: 'packageName = :pkg',
      ExpressionAttributeValues: {
        ':pk': `CWE#${opts.cwe}`,
        ':pkg': packageName,
      },
    }));
    findings = (res.Items ?? []) as FindingRecord[];
  } else if (opts.severity) {
    // Query by package+version+severity using GSI1
    const pkgVer = version === 'latest' ? await resolveLatestVersion(ddb, findingsTable, packageName) : version;
    const res = await ddb.send(new QueryCommand({
      TableName: findingsTable,
      IndexName: 'GSI1-Severity',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `PKG#${packageName}#${pkgVer}#SEV#${opts.severity}`,
      },
    }));
    findings = (res.Items ?? []) as FindingRecord[];
  } else {
    // Query all findings for package+version using primary key
    const pkgVer = version === 'latest' ? await resolveLatestVersion(ddb, findingsTable, packageName) : version;
    const res = await ddb.send(new QueryCommand({
      TableName: findingsTable,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `PKG#${packageName}#${pkgVer}`,
        ':sk': 'FINDING#',
      },
    }));
    findings = (res.Items ?? []) as FindingRecord[];
  }

  if (opts.output === 'json') {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  // Table output
  if (findings.length === 0) {
    console.log(chalk.green(`\nNo findings for ${packageName}@${opts.version ?? 'latest'}`));
    return;
  }

  const table = new Table({
    head: ['ID', 'Severity', 'CWE', 'File', 'Line', 'Description'].map(h => chalk.bold(h)),
    colWidths: [14, 10, 10, 30, 6, 60],
    wordWrap: true,
  });

  for (const f of findings.sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))) {
    const severityCol = SEVERITY_COLORS[f.severity]?.(f.severity.toUpperCase()) ?? f.severity;
    table.push([f.id, severityCol, f.cwe_id, f.file, String(f.line), f.description.slice(0, 120)]);
  }

  console.log(`\nFindings for ${chalk.bold(packageName)}@${opts.version ?? 'latest'} (${findings.length} total):\n`);
  console.log(table.toString());
}

async function resolveLatestVersion(
  ddb: DynamoDBDocumentClient,
  table: string,
  packageName: string,
): Promise<string> {
  // Scan for any finding with this package name to find the latest version
  // In practice, store a "latest" pointer record. For now, query with prefix.
  const res = await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'begins_with(PK, :prefix)',
    ExpressionAttributeValues: { ':prefix': `PKG#${packageName}#` },
    Limit: 1,
    ScanIndexForward: false,
  }));
  const item = res.Items?.[0];
  if (!item) throw new Error(`No findings found for package: ${packageName}`);
  const pk = item.PK as string;
  // PK = PKG#{name}#{version}
  const parts = pk.split('#');
  return parts[2] ?? 'unknown';
}

function severityWeight(s: FindingSeverity): number {
  return { critical: 5, high: 4, medium: 3, low: 2, info: 1 }[s] ?? 0;
}

async function getParam(ssm: SSMClient, name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
  if (!res.Parameter?.Value) throw new Error(`SSM param not found: ${name}`);
  return res.Parameter.Value;
}
```

### 10.5 `packages/cli/src/commands/review/report.ts`

```typescript
import * as fs from 'fs';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { loadConfig } from '../../utils/config';
import { makeDDBClient, makeSSMClient } from '../../utils/aws-clients';
import { findingsToSarif } from '../../utils/sarif';
import { FindingRecord, ReportFormat } from '@skills-svc/shared';

interface ReportOptions {
  format: string;
  version?: string;
  outputFile?: string;
}

export async function reviewReport(packageName: string, opts: ReportOptions): Promise<void> {
  const format = opts.format as ReportFormat;
  if (!['sarif', 'json', 'markdown'].includes(format)) {
    throw new Error(`Invalid format: ${format}. Must be sarif, json, or markdown`);
  }

  const config = await loadConfig();
  const ddb = DynamoDBDocumentClient.from(makeDDBClient(config));
  const ssm = makeSSMClient(config);

  const env = config.env ?? 'prod';
  const findingsTable = await getParam(ssm, `/skills-svc/${env}/dynamodb/findings-table-name`);
  const version = opts.version ?? 'latest';

  const res = await ddb.send(new QueryCommand({
    TableName: findingsTable,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `PKG#${packageName}#${version}`,
      ':sk': 'FINDING#',
    },
  }));
  const findings = (res.Items ?? []) as FindingRecord[];

  let output: string;

  if (format === 'sarif') {
    const sarif = findingsToSarif(findings, packageName, version);
    output = JSON.stringify(sarif, null, 2);

  } else if (format === 'json') {
    output = JSON.stringify({ packageName, version, findings, generatedAt: new Date().toISOString() }, null, 2);

  } else {
    // markdown
    output = generateMarkdownReport(packageName, version, findings);
  }

  if (opts.outputFile) {
    fs.writeFileSync(opts.outputFile, output, 'utf-8');
    console.log(chalk.green(`Report written to ${opts.outputFile}`));
  } else {
    console.log(output);
  }
}

function generateMarkdownReport(packageName: string, version: string, findings: FindingRecord[]): string {
  const critical = findings.filter(f => f.severity === 'critical');
  const high     = findings.filter(f => f.severity === 'high');
  const medium   = findings.filter(f => f.severity === 'medium');
  const low      = findings.filter(f => f.severity === 'low');
  const info     = findings.filter(f => f.severity === 'info');

  const lines: string[] = [
    `# Security Review Report`,
    ``,
    `**Package:** \`${packageName}@${version}\`  `,
    `**Generated:** ${new Date().toISOString()}  `,
    `**Total Findings:** ${findings.length}`,
    ``,
    `## Summary`,
    ``,
    `| Severity | Count |`,
    `|----------|-------|`,
    `| Critical | ${critical.length} |`,
    `| High     | ${high.length} |`,
    `| Medium   | ${medium.length} |`,
    `| Low      | ${low.length} |`,
    `| Info     | ${info.length} |`,
    ``,
    `## Findings`,
    ``,
  ];

  for (const f of [...critical, ...high, ...medium, ...low, ...info]) {
    lines.push(`### ${f.id} — ${f.severity.toUpperCase()}: ${f.cwe_id}`);
    lines.push(``);
    lines.push(`**File:** \`${f.file}\` (line ${f.line})  `);
    lines.push(`**Confidence:** ${f.confidence}  `);
    lines.push(`**CWE Reference:** https://cwe.mitre.org/data/definitions/${f.cwe_id.replace('CWE-', '')}.html`);
    lines.push(``);
    lines.push(`#### Description`);
    lines.push(``);
    lines.push(f.description);
    lines.push(``);
    lines.push(`#### Recommendation`);
    lines.push(``);
    lines.push(f.recommendation);
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  if (findings.length === 0) {
    lines.push(`No security vulnerabilities were identified.`);
  }

  return lines.join('\n');
}

async function getParam(ssm: SSMClient, name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
  if (!res.Parameter?.Value) throw new Error(`SSM param not found: ${name}`);
  return res.Parameter.Value;
}
```

### 10.6 `packages/cli/src/commands/review/diff.ts`

```typescript
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../utils/config';
import { makeDDBClient, makeSSMClient } from '../../utils/aws-clients';
import { FindingRecord } from '@skills-svc/shared';

interface DiffOptions {
  from: string;
  to: string;
  output: string;
}

interface DiffResult {
  fixed:     FindingRecord[];
  new_:      FindingRecord[];
  unchanged: FindingRecord[];
}

export async function reviewDiff(packageName: string, opts: DiffOptions): Promise<void> {
  const config = await loadConfig();
  const ddb = DynamoDBDocumentClient.from(makeDDBClient(config));
  const ssm = makeSSMClient(config);

  const env = config.env ?? 'prod';
  const findingsTable = await getParam(ssm, `/skills-svc/${env}/dynamodb/findings-table-name`);

  const [fromFindings, toFindings] = await Promise.all([
    queryFindings(ddb, findingsTable, packageName, opts.from),
    queryFindings(ddb, findingsTable, packageName, opts.to),
  ]);

  // Fingerprint: file + line + cwe_id for matching (not id, which may differ)
  const fingerprint = (f: FindingRecord): string => `${f.file}:${f.line}:${f.cwe_id}`;

  const fromSet = new Map(fromFindings.map(f => [fingerprint(f), f]));
  const toSet   = new Map(toFindings.map(f => [fingerprint(f), f]));

  const diff: DiffResult = {
    fixed:     fromFindings.filter(f => !toSet.has(fingerprint(f))),
    new_:      toFindings.filter(f => !fromSet.has(fingerprint(f))),
    unchanged: toFindings.filter(f => fromSet.has(fingerprint(f))),
  };

  if (opts.output === 'json') {
    console.log(JSON.stringify({
      packageName,
      from: opts.from,
      to: opts.to,
      summary: { fixed: diff.fixed.length, new: diff.new_.length, unchanged: diff.unchanged.length },
      fixed: diff.fixed,
      new: diff.new_,
      unchanged: diff.unchanged,
    }, null, 2));
    return;
  }

  // Table output
  console.log(chalk.bold(`\nDiff: ${packageName} ${opts.from} → ${opts.to}\n`));
  console.log(`  ${chalk.green(`Fixed:     ${diff.fixed.length}`)}`);
  console.log(`  ${chalk.red(`New:       ${diff.new_.length}`)}`);
  console.log(`  ${chalk.gray(`Unchanged: ${diff.unchanged.length}`)}`);

  if (diff.new_.length > 0) {
    console.log(chalk.red.bold('\n⚠ New findings (introduced in this version):\n'));
    printFindingsTable(diff.new_);
  }

  if (diff.fixed.length > 0) {
    console.log(chalk.green.bold('\n✓ Fixed findings (resolved since previous version):\n'));
    printFindingsTable(diff.fixed);
  }
}

async function queryFindings(
  ddb: DynamoDBDocumentClient,
  table: string,
  packageName: string,
  version: string,
): Promise<FindingRecord[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `PKG#${packageName}#${version}`,
      ':sk': 'FINDING#',
    },
  }));
  return (res.Items ?? []) as FindingRecord[];
}

function printFindingsTable(findings: FindingRecord[]): void {
  const table = new Table({
    head: ['Severity', 'CWE', 'File', 'Line', 'Description'].map(h => chalk.bold(h)),
    colWidths: [10, 10, 35, 6, 60],
    wordWrap: true,
  });
  for (const f of findings) {
    table.push([f.severity.toUpperCase(), f.cwe_id, f.file, String(f.line), f.description.slice(0, 80)]);
  }
  console.log(table.toString());
}

async function getParam(ssm: SSMClient, name: string): Promise<string> {
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: false }));
  if (!res.Parameter?.Value) throw new Error(`SSM param not found: ${name}`);
  return res.Parameter.Value;
}
```

---

## 11. CDK App Updates

### 11.1 `infra/bin/app.ts` — additions (append to existing stacks)

```typescript
import { CodeReviewStack } from '../lib/code-review-stack';

// After MonitoringStack is declared:
const codeReview = new CodeReviewStack(app, `SkillsSvc-${envName}-CodeReview`, {
  env,
  envName,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  dynamodbKey: security.dynamodbKey,
  lambdaEnvKey: security.lambdaEnvKey,
  // These are SSM param paths resolved at runtime by the Lambda:
  uploadsBucket: `skills-svc-uploads-${process.env.CDK_DEFAULT_ACCOUNT}-${process.env.CDK_DEFAULT_REGION}`,
  ecsClusterArn: '',   // read from SSM at Lambda runtime
  ecsTaskDefArn: '',   // read from SSM at Lambda runtime
  ingestionQueueUrl: '',
});

// CodeReviewStack depends on StorageStack (DynamoDB key) and NetworkStack
codeReview.addDependency(storage);
codeReview.addDependency(lambdaStack);

// MonitoringStack update — add review alarms
// (pass codeReview.webhookFn and codeReview.findingsTable to MonitoringStack if desired)
```

### 11.2 MonitoringStack additions (new alarms)

Add to `infra/lib/monitoring-stack.ts`:

```typescript
// ── Code Review Alarms ────────────────────────────────────────────────────────

// Alarm: webhook Lambda errors
new cloudwatch.Alarm(this, 'WebhookLambdaErrorAlarm', {
  alarmName: `skills-svc-webhook-errors-${props.envName}`,
  metric: props.webhookFn.metricErrors({ period: cdk.Duration.minutes(5) }),
  threshold: 5,
  evaluationPeriods: 1,
  alarmDescription: 'Webhook Lambda error rate high — possible signature validation failures or GitHub API issues',
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  actionsEnabled: true,
});
props.alarmTopic.grantPublish(new iam.ServicePrincipal('cloudwatch.amazonaws.com'));

// Alarm: webhook Lambda p95 latency > 10 seconds
new cloudwatch.Alarm(this, 'WebhookLatencyAlarm', {
  alarmName: `skills-svc-webhook-latency-${props.envName}`,
  metric: props.webhookFn.metricDuration({
    period: cdk.Duration.minutes(5),
    statistic: 'p95',
  }),
  threshold: 10_000,
  evaluationPeriods: 2,
  alarmDescription: 'Webhook Lambda p95 latency > 10s — likely waiting on GitHub API or S3',
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
```

---

## 12. SSM Parameter Store — New Parameters

| Parameter Path | Written By | Read By |
|---------------|-----------|---------|
| `/skills-svc/{env}/dynamodb/findings-table-name` | `CodeReviewStack` | `ResultsProcessorLambda`, CLI |
| `/skills-svc/{env}/webhook/api-url` | `CodeReviewStack` | CLI (`skills-svc configure`) |
| `/skills-svc/{env}/webhook/github-secret` | **Manual post-deploy** | `WebhookLambda` |
| `/skills-svc/{env}/webhook/github-token` | **Manual post-deploy** | `ResultsProcessorLambda`, `WebhookLambda` |
| `/skills-svc/{env}/webhook/gitlab-secret` | **Manual post-deploy** | `WebhookLambda` |

Post-deploy SSM writes (done once by operator):
```bash
# GitHub webhook secret (generate a random 32-byte hex string)
aws ssm put-parameter \
  --name /skills-svc/prod/webhook/github-secret \
  --value "$(openssl rand -hex 32)" \
  --type SecureString \
  --key-id alias/skills-svc/prod/lambda-env

# GitHub App / Personal Access Token with repo:status scope
aws ssm put-parameter \
  --name /skills-svc/prod/webhook/github-token \
  --value "ghp_..." \
  --type SecureString \
  --key-id alias/skills-svc/prod/lambda-env

# GitLab webhook token
aws ssm put-parameter \
  --name /skills-svc/prod/webhook/gitlab-secret \
  --value "$(openssl rand -hex 32)" \
  --type SecureString \
  --key-id alias/skills-svc/prod/lambda-env
```

---

## 13. Skill Registration Script

### 13.1 `scripts/register-code-review-skill.sh` — new file

```bash
#!/usr/bin/env bash
#
# register-code-review-skill.sh
# Run after every deploy to push/update the built-in code-review skill in the registry.
# Requires: skills-svc CLI configured, jq, zip
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_DIR="$REPO_ROOT/packages/skills/code-review"

if [[ ! -f "$SKILL_DIR/manifest.json" ]]; then
  echo "ERROR: skill directory not found at $SKILL_DIR" >&2
  exit 1
fi

SKILL_VERSION="$(jq -r .version "$SKILL_DIR/manifest.json")"
SKILL_NAME="$(jq -r .name "$SKILL_DIR/manifest.json")"

echo "Registering built-in skill: $SKILL_NAME@$SKILL_VERSION"

# Create a temporary zip
TMP_DIR="$(mktemp -d)"
SKILL_ZIP="$TMP_DIR/code-review.zip"

(
  cd "$SKILL_DIR"
  zip -r "$SKILL_ZIP" manifest.json skills/
)

# Push to skill registry via CLI
skills-svc skill push "$SKILL_ZIP" \
  --name "$SKILL_NAME" \
  --version "$SKILL_VERSION" \
  --visibility org

echo "✓ Built-in skill '$SKILL_NAME@$SKILL_VERSION' registered successfully"

# Clean up
rm -rf "$TMP_DIR"
```

---

## 14. IAM Additions to SecurityStack

Add to `infra/lib/security-stack.ts` — new policy statements for existing roles:

```typescript
// ECS Task Role: allow reading reviews/ prefix from uploads bucket (tarball mode)
this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadReviewSourceTarballs',
  actions: ['s3:GetObject', 's3:HeadObject'],
  resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/reviews/*`],
}));

// Results Lambda Role: write to findings table
this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'FindingsTableWrite',
  actions: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem', 'dynamodb:GetItem', 'dynamodb:Query'],
  resources: [
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-findings-${this.account}-${this.region}`,
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-findings-${this.account}-${this.region}/index/*`,
  ],
}));

// Results Lambda Role: call GitHub API (outbound HTTPS via VPC endpoint or NAT)
// Note: GitHub API calls require outbound internet. Add a NAT gateway OR
// use a proxy Lambda in the VPC that forwards to api.github.com.
// For simplicity this spec assumes the ResultsProcessorLambda has internet access
// via NAT or is deployed without VPC for the GitHub status post function.
// See implementation note in Section 15.

// User Role: read findings table
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'DDBReadFindings',
  actions: ['dynamodb:GetItem', 'dynamodb:Query'],
  resources: [
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-findings-${this.account}-${this.region}`,
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-findings-${this.account}-${this.region}/index/*`,
  ],
}));
```

---

## 15. Implementation Notes

### 15.1 GitHub API outbound access

The existing system uses private VPC subnets with no NAT gateways to minimize cost. However, `ResultsProcessorLambda` must call `api.github.com` to post status checks. Two options:

**Option A (Recommended for cost):** Move the GitHub status post to a separate small Lambda (`GitHubStatusLambda`) that is NOT in the VPC and is invoked asynchronously via SQS. This Lambda posts the status check and exits. This keeps the main VPC clean.

**Option B (Simpler):** Add a single NAT gateway in one AZ ($32/month). Update `NetworkStack` to add `natGateways: 1` for the AZ hosting the Lambda subnets. ECS tasks that need to clone public repos also benefit from this.

This spec implements Option A in the `ResultsProcessorLambda` by pushing a message to a `GitHubStatusQueue` (not in VPC) rather than calling GitHub directly.

### 15.2 ECS task env var wiring for input mode

The `SkillsIngestionLambda` must be extended to pass `INPUT_MODE`, `JOB_GIT_URL`, `JOB_GIT_REF`, `JOB_SOURCE_KEY`, `PACKAGE_NAME`, `PACKAGE_VERSION` as ECS container overrides. Read these from S3 object metadata via `HeadObjectCommand` (already done in the existing `ingestion/handler.ts`) and forward them.

Specifically, add to `ecs-submitter.ts`:

```typescript
// Read extended metadata for code review jobs
const inputMode     = head.Metadata?.['input-mode'] ?? 'zip';
const gitUrl        = head.Metadata?.['git-url'];
const gitRef        = head.Metadata?.['git-ref'];
const sourceKey     = head.Metadata?.['job-source-key'];
const packageName   = head.Metadata?.['package-name'];
const packageVersion = head.Metadata?.['package-version'];
const githubRepo    = head.Metadata?.['github-repo'];
const githubCommit  = head.Metadata?.['github-commit-sha'];

// Add to ECS containerOverrides.environment:
{ name: 'INPUT_MODE',        value: inputMode },
{ name: 'JOB_GIT_URL',       value: gitUrl ?? '' },
{ name: 'JOB_GIT_REF',       value: gitRef ?? '' },
{ name: 'JOB_SOURCE_KEY',    value: sourceKey ?? '' },
{ name: 'PACKAGE_NAME',      value: packageName ?? '' },
{ name: 'PACKAGE_VERSION',   value: packageVersion ?? '' },
{ name: 'GITHUB_REPO',       value: githubRepo ?? '' },
{ name: 'GITHUB_COMMIT_SHA', value: githubCommit ?? '' },
```

Also store these metadata fields in the DynamoDB job record so `ResultsProcessorLambda` can read them later.

### 15.3 Webhook S3 trigger

The `MessagingStack` currently only watches `prefix: 'uploads/', suffix: '.zip'`. The webhook handler writes to `reviews/...` with a `.json` extension. Add a second S3 event notification:

```typescript
// In MessagingStack constructor:
props.uploadsBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.SqsDestination(this.ingestionQueue),
  { prefix: 'reviews/', suffix: '.json' },
);
```

### 15.4 Skill files in ECS container

The Dockerfile copies `packages/skills/code-review` into `/app/skills/code-review`. The `main.ts` runner detects that `JOB_SKILL_KEY` is empty and copies from this baked-in path to `/tmp/workspace/skills/`. The `runner.ts` is updated to accept `skillsDir` and `sourceDir` as separate arguments so Claude receives `--skills-dir /tmp/workspace/skills` and CWDs in `/tmp/workspace/source`.

### 15.5 `p-limit` dependency for CLI

Add `p-limit` to `packages/cli/package.json`:
```json
"dependencies": {
  "p-limit": "^5.0.0"
}
```
`p-limit` v5 is ESM-only; use dynamic import or pin to v4 for CommonJS.

### 15.6 Deploy order

```
(existing stacks in existing order)
    │
    ▼
CodeReviewStack  ← StorageStack (DynamoDB key), LambdaStack (Lambda SG)
    │
    ▼
MonitoringStack  ← updated to include CodeReviewStack alarms
    │
    ▼
ComplianceStack  ← unchanged
    │
    ▼ (post-deploy)
scripts/register-code-review-skill.sh
```

---

## 16. Testing Plan

### 16.1 Unit tests

| File | What to test |
|------|-------------|
| `packages/lambda/src/webhook/__tests__/handler.test.ts` | HMAC validation (valid/invalid/wrong-length), PR event parsing, push-to-tag vs non-tag branch, GitLab token validation, missing fields |
| `packages/ecs-runner/src/__tests__/git-cloner.test.ts` | URL scheme rejection (ftp://), ref sanitization (shell metacharacters), symlink escape after clone |
| `packages/ecs-runner/src/__tests__/tarball-extractor.test.ts` | Symlink escape detection, unsupported format error |
| `packages/cli/src/__tests__/sarif.test.ts` | Valid SARIF 2.1.0 schema output, deduplication of rules by CWE |
| `packages/lambda/src/__tests__/findings-writer.test.ts` | BatchWrite splitting at 25, DDB key construction |

### 16.2 Integration smoke test additions

Add to `scripts/smoke-test.sh`:

```bash
# Test 1: tarball review submission
echo "=== Smoke: tarball review ==="
TEST_PKG="smoke-test-tarball"
TEST_VER="$(date +%s)"
tar czf /tmp/smoke-src.tar.gz -C /dev/null . 2>/dev/null || true
# Create a minimal tarball with one vulnerable-looking file
mkdir -p /tmp/smoke-src
echo 'import subprocess; subprocess.call(user_input)' > /tmp/smoke-src/app.py
tar czf /tmp/smoke-src.tar.gz -C /tmp smoke-src
skills-svc review submit /tmp/smoke-src.tar.gz \
  --package-name "$TEST_PKG" \
  --package-version "$TEST_VER" \
  --language python

# Test 2: git review submission (public repo, short SHA)
echo "=== Smoke: git review ==="
skills-svc review submit \
  "git+https://github.com/anthropics/anthropic-sdk-python@HEAD" \
  --package-name "anthropic-sdk-python" \
  --package-version "smoke-$(date +%s)"

echo "=== Smoke: webhook endpoint reachable ==="
WEBHOOK_URL="$(aws ssm get-parameter \
  --name /skills-svc/prod/webhook/api-url --query Parameter.Value --output text)"
HTTP_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$WEBHOOK_URL/webhook/github" \
  -H 'Content-Type: application/json' \
  -d '{}' )"
# Expect 401 (no signature) — not 5xx
[[ "$HTTP_STATUS" == "401" ]] || { echo "FAIL: expected 401, got $HTTP_STATUS"; exit 1; }
echo "✓ Webhook returns 401 for unsigned request (correct)"
```

---

## 17. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Git clone of malicious repo | URL scheme allowlist (https/ssh only), `.git` removal after clone, read-only container FS, non-root user |
| Tarball path traversal | `verifyNoEscape()` post-extraction symlink check; `tar --no-overwrite-dir` |
| Webhook replay attacks | Timestamp validation not possible with GitHub's scheme; mitigated by HMAC-SHA256 with `timingSafeEqual` and WAF rate limiting (500 req/5min/IP) |
| Webhook secret exposure | Stored in SSM SecureString encrypted with customer KMS key; never logged |
| GitHub token scope | Use a fine-grained PAT limited to `statuses:write` on specific repos, NOT a classic token with repo scope |
| Findings data sensitivity | DynamoDB findings table uses same customer KMS key as jobs table; PITR enabled; TTL = 1 year |
| Zip bomb via tarball | `tar` extraction is not pre-validated like zip; mitigate by monitoring disk usage in ECS task (add a background du check every 30s during extraction) |
| Command injection via git URL/ref | Strict regex validation before passing to `execFile` (no shell interpolation since `execFile` does not use shell) |

---

## 18. File Inventory

New files created by this spec:

```
packages/skills/code-review/
  manifest.json
  skills/security-review.md

packages/ecs-runner/src/
  tarball-downloader.ts
  tarball-extractor.ts
  git-cloner.ts

packages/lambda/src/
  webhook/
    handler.ts
  results-processor/
    findings-writer.ts

packages/cli/src/
  commands/review/
    index.ts
    submit.ts
    batch.ts
    status.ts          (thin wrapper around existing status logic)
    findings.ts
    report.ts
    diff.ts
  utils/
    sarif.ts

infra/lib/
  code-review-stack.ts

scripts/
  register-code-review-skill.sh
```

Modified files:

```
packages/shared/src/types.ts            — add code-review types
packages/ecs-runner/src/main.ts         — input mode dispatch
packages/ecs-runner/Dockerfile          — add git, tar
packages/lambda/src/ingestion/handler.ts — forward extended metadata to ECS
packages/lambda/src/results-processor/handler.ts — findings write + GitHub status
packages/cli/src/index.ts              — register review commands
infra/bin/app.ts                       — wire CodeReviewStack
infra/lib/security-stack.ts            — new IAM statements
infra/lib/monitoring-stack.ts          — new alarms
infra/lib/messaging-stack.ts           — add reviews/ S3 event notification
```
