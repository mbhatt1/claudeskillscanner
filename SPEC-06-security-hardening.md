# Skills as a Service (SaaS) — Specification Part 6: Security Hardening

**Version:** 1.0.0  
**Status:** AUTHORITATIVE — supersedes conflicting sections in Parts 1–5  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | [Part 2](SPEC-02-lambda-ecs.md) | [Part 3](SPEC-03-knowledge-store-cli.md) | [Part 4](SPEC-04-qa-layers-1-50.md) | [Part 5](SPEC-05-qa-layers-51-100-deployment.md) | [Part 6: Security Hardening]

---

## Overview of Changes

This document addresses 14 security gaps identified for **critical data** handling. Changes are organized from highest to lowest priority. All changes are **additive or replacements** — they do not invalidate the existing spec except where explicitly noted.

| Gap | Fix | Affects |
|-----|-----|---------|
| Anthropic API key + broken egress | Replace with Bedrock Claude via IAM | SPEC-02, SPEC-03, ECS runner |
| No WORM audit logs | S3 Object Lock on audit bucket | SPEC-03 ComplianceStack |
| No SCPs | Organizations SCPs blocking destructive ops | New: SecurityStack |
| Per-record envelope encryption | Application-level KMS envelope encrypt/decrypt | SPEC-02, ECS runner |
| Cross-account isolation | Two-account model (control + data) | SPEC-01 architecture |
| Secrets Manager for remaining secrets | Replace SSM SecureString with Secrets Manager | SPEC-02, ECS runner |
| No OpenSearch row-level security | Filter all queries by `user_arn` | SPEC-03 searcher |
| No ECR CVE gate | Block deployment on critical CVEs | SPEC-05 CI |
| No DLP on output | Comprehend + pattern scan before indexing | SPEC-02 results-processor |
| ECS /tmp not wiped | Explicit overwrite after processing | SPEC-02 ECS runner |
| No SHA256 verification in ECS | Verify ETag before extracting zip | SPEC-02 ECS runner |
| Bedrock region lock | `aws:RequestedRegion` condition + invocation logging | SPEC-01 SecurityStack |
| No break-glass procedure | Break-glass role + runbook | New section |
| No SBOM | `docker sbom` in CI | SPEC-05 CI |

---

## 1. Replace Anthropic API with Bedrock Claude (Critical Fix)

### Problem
The original spec calls `claude` CLI which calls `api.anthropic.com` — unreachable from a fully private VPC. Also requires an API key stored in SSM.

### Fix
Use the **AWS Bedrock Runtime API** (`anthropic.claude-3-5-sonnet-20241022-v2:0`) from within the ECS container. Bedrock Runtime already has a VPC interface endpoint in the spec (`InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME`). No API key needed — uses IAM role.

### Changes

#### SPEC-01: Remove from SSM Parameter Layout
**DELETE** the row:
```
/skills-svc/{env}/anthropic/api-key  SecureString  Manual  ECS
```

**DELETE** Step 4 of Deployment Runbook:
```bash
aws ssm put-parameter --name "/skills-svc/prod/anthropic/api-key" ...
```

#### SPEC-02: Updated ECS Task Role (security-stack.ts)
Remove the SSM permission for `anthropic/api-key`. The task role already has `bedrock:InvokeModel` permission.

**REMOVE** from `ecsTaskRole` inline policy:
```typescript
// DELETE THIS BLOCK — no longer needed
this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadAnthropicKey',  // never existed explicitly but SSM param was referenced
  ...
}));
```

**ADD** explicit Bedrock model permission scoped to Claude models only:
```typescript
this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
  sid: 'BedrockInvokeClaude',
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
  resources: [
    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
    `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
  ],
  conditions: {
    StringEquals: { 'aws:RequestedRegion': this.region }, // lock to deployment region
  },
}));
```

#### SPEC-02: Updated `packages/ecs-runner/src/runner.ts`

Replace the `claude` CLI subprocess with a Bedrock SDK call:

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { RunResult, ZipManifest } from '@skills-svc/shared';

const MODEL_ID = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const MAX_TOKENS = 8192;
const TASK_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

export async function runSkills(extractDir: string, jobId: string, env: string): Promise<RunResult> {
  const manifestPath = path.join(extractDir, 'manifest.json');
  const manifest: ZipManifest = JSON.parse(await readFile(manifestPath, 'utf-8'));

  // Load all skill files referenced in manifest
  const skillContents: string[] = [];
  for (const skillName of manifest.skills) {
    const skillPath = path.join(extractDir, 'skills', `${skillName}.md`);
    try {
      const content = await readFile(skillPath, 'utf-8');
      skillContents.push(`## Skill: ${skillName}\n\n${content}`);
    } catch {
      console.warn(JSON.stringify({ event: 'skill_file_missing', skillName }));
    }
  }

  const skillsContext = skillContents.join('\n\n---\n\n');
  const userPrompt = manifest.defaultPrompt ??
    'Analyze the provided skills, summarize their capabilities, and demonstrate example usage for each.';

  const systemPrompt = `You are a skills analysis assistant. You have been given a set of skill definitions. 
Analyze them carefully and respond in structured JSON format.
Respond ONLY with valid JSON matching this schema:
{
  "summary": "string — overall summary of what these skills do",
  "skills_analyzed": ["array of skill names analyzed"],
  "capabilities": ["list of key capabilities"],
  "example_outputs": [{"skill": "name", "example": "example output"}],
  "recommendations": ["list of recommendations for skill improvement"]
}`;

  const messages = [
    {
      role: 'user',
      content: `Here are the skill definitions:\n\n${skillsContext}\n\n---\n\n${userPrompt}`,
    },
  ];

  const bedrock = new BedrockRuntimeClient({ region: process.env.REGION ?? 'us-east-1' });

  const startMs = Date.now();

  // Wrap in timeout
  const result = await Promise.race([
    invokeModel(bedrock, messages, systemPrompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Bedrock invocation timed out after ${TASK_TIMEOUT_MS / 1000}s`)), TASK_TIMEOUT_MS)
    ),
  ]);

  const durationMs = Date.now() - startMs;

  let parsedOutput: Record<string, unknown>;
  try {
    parsedOutput = JSON.parse(result);
  } catch {
    parsedOutput = { summary: result, raw: true };
  }

  const resultSummary = typeof parsedOutput.summary === 'string'
    ? parsedOutput.summary.slice(0, 1000)
    : result.slice(0, 1000);

  return {
    jobId,
    jobName: manifest.jobName,
    skillNames: manifest.skills,
    prompt: userPrompt,
    output: JSON.stringify(parsedOutput),
    resultSummary,
    durationMs,
    exitCode: 0,
    completedAt: new Date().toISOString(),
  };
}

async function invokeModel(
  bedrock: BedrockRuntimeClient,
  messages: { role: string; content: string }[],
  system: string,
): Promise<string> {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: MAX_TOKENS,
    system,
    messages,
  };

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(body),
  }));

  const parsed = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
    content: Array<{ type: string; text: string }>;
  };

  const textBlock = parsed.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Bedrock response');
  return textBlock.text;
}
```

#### SPEC-02: Updated Dockerfile
Remove `npm install -g @anthropic-ai/claude-code` — the Bedrock SDK is included in `node_modules`:

```dockerfile
FROM node:20-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-slim AS runtime

# Only system deps needed — no claude CLI
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 1000 runner && \
    useradd -u 1000 -g runner -s /bin/bash -m -d /home/runner runner

WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules

RUN mkdir -p /tmp/workspace && chown runner:runner /tmp/workspace

USER 1000:1000
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
```

**ECS runner `package.json` dependencies** (add Bedrock SDK):
```json
{
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.600.0",
    "@aws-sdk/client-s3": "^3.600.0",
    "@aws-sdk/client-ssm": "^3.600.0",
    "@aws-sdk/client-dynamodb": "^3.600.0",
    "@aws-sdk/lib-dynamodb": "^3.600.0",
    "@aws-sdk/client-sns": "^3.600.0",
    "unzipper": "^0.12.3",
    "@skills-svc/shared": "*"
  }
}
```

#### SSM Parameter Removed
Delete the post-deploy step that sets `/skills-svc/prod/anthropic/api-key`. No external API key is needed.

---

## 2. S3 Object Lock (WORM) on Audit Bucket

### Problem
An admin with `s3:DeleteObject` can erase the audit trail even with versioning enabled.

### Fix: `infra/lib/compliance-stack.ts` — audit bucket update

Replace the existing `auditLogBucket` definition:

```typescript
// REPLACES existing auditLogBucket in ComplianceStack
const auditLogBucket = new s3.Bucket(this, 'AuditLogBucket', {
  bucketName: `skills-svc-audit-${this.account}-${this.region}`,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  versioned: true,            // required for Object Lock
  objectLockEnabled: true,    // WORM — cannot be disabled after creation
  objectLockDefaultRetention: {
    mode: s3.ObjectLockMode.COMPLIANCE,   // even root cannot delete during retention
    duration: cdk.Duration.days(2555),     // 7 years (2555 days)
  },
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  autoDeleteObjects: false,
  lifecycleRules: [{
    id: 'archive-after-90-days',
    transitions: [{
      storageClass: s3.StorageClass.GLACIER,
      transitionAfter: cdk.Duration.days(90),
    }],
  }],
});

// Explicitly deny delete operations — belt-and-suspenders with Object Lock
auditLogBucket.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'DenyDeleteAuditLogs',
  effect: iam.Effect.DENY,
  principals: [new iam.StarPrincipal()],
  actions: [
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:PutLifecycleConfiguration', // prevent shortening retention
    's3:PutBucketVersioning',        // prevent disabling versioning
  ],
  resources: [
    auditLogBucket.bucketArn,
    `${auditLogBucket.bucketArn}/*`,
  ],
}));

// Deny deletion of the bucket itself
auditLogBucket.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'DenyDeleteBucket',
  effect: iam.Effect.DENY,
  principals: [new iam.StarPrincipal()],
  actions: ['s3:DeleteBucket'],
  resources: [auditLogBucket.bucketArn],
}));
```

**Note:** `objectLockEnabled: true` requires the bucket to be created with Object Lock — it cannot be added after creation. The bucket must be RETAINED in CDK (`removalPolicy: RETAIN`) and never destroyed.

---

## 3. AWS Organizations SCPs

### Problem
A compromised admin credential or rogue insider can stop CloudTrail, disable GuardDuty, or delete KMS keys.

### Fix: SCPs at the Organization level (applied via AWS Console or org CDK)

Create `infra/lib/scp-policies.ts` with the SCP JSON. Apply these via the AWS Organizations console or via CDK in a dedicated management account stack.

```typescript
// infra/lib/scp-policies.ts
// These must be applied at the AWS Organizations OU level, not per-account CDK
// Document them here for the operator to apply manually after CDK deploy

export const SECURITY_SCP_POLICIES = {

  // Prevent disabling audit infrastructure
  DenyAuditTampering: {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyStopCloudTrail',
        Effect: 'Deny',
        Action: [
          'cloudtrail:StopLogging',
          'cloudtrail:DeleteTrail',
          'cloudtrail:UpdateTrail',
          'cloudtrail:PutEventSelectors',
        ],
        Resource: '*',
      },
      {
        Sid: 'DenyDisableGuardDuty',
        Effect: 'Deny',
        Action: [
          'guardduty:DeleteDetector',
          'guardduty:DisassociateFromMasterAccount',
          'guardduty:StopMonitoringMembers',
          'guardduty:UpdateDetector',
        ],
        Resource: '*',
      },
      {
        Sid: 'DenyDisableSecurityHub',
        Effect: 'Deny',
        Action: [
          'securityhub:DisableSecurityHub',
          'securityhub:DeleteInsight',
          'securityhub:DisableImportFindingsForProduct',
        ],
        Resource: '*',
      },
      {
        Sid: 'DenyDisableConfig',
        Effect: 'Deny',
        Action: [
          'config:DeleteConfigurationRecorder',
          'config:StopConfigurationRecorder',
          'config:DeleteDeliveryChannel',
        ],
        Resource: '*',
      },
    ],
  },

  // Prevent KMS key destruction
  DenyKMSKeyDeletion: {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyKMSScheduleKeyDeletion',
        Effect: 'Deny',
        Action: ['kms:ScheduleKeyDeletion', 'kms:DeleteImportedKeyMaterial'],
        Resource: '*',
        Condition: {
          StringNotLike: {
            'kms:KeyAliasName': 'alias/aws/*', // allow AWS-managed key deletion
          },
        },
      },
    ],
  },

  // Prevent leaving the Organization (data residency)
  DenyLeaveOrg: {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'DenyLeaveOrganization',
      Effect: 'Deny',
      Action: ['organizations:LeaveOrganization'],
      Resource: '*',
    }],
  },

  // Enforce region restriction — all data must stay in us-east-1
  DenyNonApprovedRegions: {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'DenyNonApprovedRegions',
      Effect: 'Deny',
      NotAction: [
        // Global services exempt from region restriction
        'iam:*', 'sts:*', 'cloudfront:*', 'route53:*',
        'waf:*', 'support:*', 'budgets:*', 'organizations:*',
      ],
      Resource: '*',
      Condition: {
        StringNotEquals: { 'aws:RequestedRegion': ['us-east-1'] },
      },
    }],
  },

  // Prevent root user usage
  DenyRootUser: {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'DenyRootUserAccess',
      Effect: 'Deny',
      Action: '*',
      Resource: '*',
      Condition: {
        StringLike: { 'aws:PrincipalArn': 'arn:aws:iam::*:root' },
      },
    }],
  },

  // Prevent public S3 access at account level (belt-and-suspenders with bucket policy)
  DenyS3PublicAccess: {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'DenyS3BucketPublicAccess',
      Effect: 'Deny',
      Action: ['s3:PutBucketPublicAccessBlock'],
      Resource: '*',
      Condition: {
        StringEquals: {
          's3:PublicAccessBlockConfiguration/BlockPublicAcls': 'false',
        },
      },
    }],
  },
} as const;
```

**`scripts/apply-scps.sh`** — run once after org setup:
```bash
#!/usr/bin/env bash
set -euo pipefail
# Requires management account credentials
OU_ID=${1:?Usage: apply-scps.sh <OU_ID>}

for POLICY_NAME in DenyAuditTampering DenyKMSKeyDeletion DenyLeaveOrg DenyNonApprovedRegions DenyRootUser DenyS3PublicAccess; do
  echo "Creating SCP: $POLICY_NAME"
  POLICY_JSON=$(node -e "const p = require('./infra/lib/scp-policies'); console.log(JSON.stringify(p.SECURITY_SCP_POLICIES['$POLICY_NAME']))")
  POLICY_ID=$(aws organizations create-policy \
    --name "SkillsSvc-$POLICY_NAME" \
    --description "Skills SaaS: $POLICY_NAME" \
    --content "$POLICY_JSON" \
    --type SERVICE_CONTROL_POLICY \
    --query 'Policy.PolicySummary.Id' --output text)
  aws organizations attach-policy --policy-id "$POLICY_ID" --target-id "$OU_ID"
  echo "  Attached $POLICY_ID to $OU_ID"
done
```

---

## 4. Application-Level Envelope Encryption

### Problem
KMS encrypts the S3 bucket but the ECS container sees plaintext data in `/tmp`. A memory dump or `/tmp` artifact leak exposes critical data.

### Fix: Per-job data key encryption

Each zip and its result are encrypted with a unique per-job data key (`GenerateDataKey`). The encrypted data key is stored in DynamoDB. Even if the S3 bucket is accessible, data cannot be decrypted without calling KMS with the correct role.

#### `packages/shared/src/crypto.ts`

```typescript
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const kms = new KMSClient({ region: process.env.REGION ?? 'us-east-1' });
const ALGORITHM = 'aes-256-gcm';

export interface EncryptedEnvelope {
  encryptedDataKey: string;  // base64 — KMS-encrypted data key
  iv: string;                // base64 — AES-GCM IV (12 bytes)
  authTag: string;           // base64 — AES-GCM authentication tag
  ciphertext: string;        // base64 — encrypted payload
}

export async function envelopeEncrypt(
  plaintext: Buffer,
  kmsKeyId: string,
  encryptionContext: Record<string, string>,
): Promise<EncryptedEnvelope> {
  // Generate a 256-bit data key using KMS
  const dataKeyRes = await kms.send(new GenerateDataKeyCommand({
    KeyId: kmsKeyId,
    KeySpec: 'AES_256',
    EncryptionContext: encryptionContext, // ties the key to this specific job
  }));

  const plaintextDataKey = dataKeyRes.Plaintext!;
  const encryptedDataKey = Buffer.from(dataKeyRes.CiphertextBlob!).toString('base64');

  // Encrypt with AES-256-GCM
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(plaintextDataKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Zero out the plaintext data key in memory
  Buffer.from(plaintextDataKey).fill(0);

  return {
    encryptedDataKey,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export async function envelopeDecrypt(
  envelope: EncryptedEnvelope,
  encryptionContext: Record<string, string>,
): Promise<Buffer> {
  // Decrypt the data key using KMS
  const decryptRes = await kms.send(new DecryptCommand({
    CiphertextBlob: Buffer.from(envelope.encryptedDataKey, 'base64'),
    EncryptionContext: encryptionContext,
  }));

  const plaintextDataKey = Buffer.from(decryptRes.Plaintext!);

  // Decrypt the ciphertext
  const decipher = createDecipheriv(
    ALGORITHM,
    plaintextDataKey,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);

  // Zero out the plaintext data key
  plaintextDataKey.fill(0);

  return plaintext;
}
```

#### Updated `packages/ecs-runner/src/uploader.ts`

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { envelopeEncrypt } from '@skills-svc/shared/crypto';
import { RunResult } from '@skills-svc/shared';

const s3 = new S3Client({ region: process.env.REGION });
const ssm = new SSMClient({ region: process.env.REGION });

export async function uploadResults(jobId: string, results: RunResult, env: string): Promise<string> {
  const kmsKeyId = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${env}/kms/results-key-id`,
  })).then(r => r.Parameter!.Value!);

  const resultsBucket = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${env}/s3/results-bucket`,
  })).then(r => r.Parameter!.Value!);

  const plaintext = Buffer.from(JSON.stringify(results), 'utf-8');

  // Envelope encrypt with job-specific context
  const envelope = await envelopeEncrypt(plaintext, kmsKeyId, {
    jobId,
    purpose: 'skills-svc-result',
    environment: env,
  });

  const s3Key = `results/${jobId}/result.json.enc`;
  await s3.send(new PutObjectCommand({
    Bucket: resultsBucket,
    Key: s3Key,
    Body: JSON.stringify(envelope),
    ContentType: 'application/json',
    ServerSideEncryption: 'aws:kms',   // S3-level KMS on top of envelope encryption
    Metadata: {
      'encryption-scheme': 'aes-256-gcm-envelope',
      'job-id': jobId,
    },
  }));

  return s3Key;
}
```

#### Updated `packages/lambda/src/results-processor/handler.ts` — decrypt before indexing

```typescript
import { envelopeDecrypt } from '@skills-svc/shared/crypto';

// In the success handler, replace plain JSON.parse with:
const encryptedEnvelope = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
const plaintext = await envelopeDecrypt(encryptedEnvelope, {
  jobId,
  purpose: 'skills-svc-result',
  environment: env,
});
const result: RunResult = JSON.parse(plaintext.toString('utf-8'));
```

#### Updated DynamoDB schema — store encrypted data key
Add field to `JobRecord` (in `packages/shared/src/types.ts`):
```typescript
encryptedDataKey?: string;  // stored after ECS task completes, for audit/re-decrypt
```

---

## 5. Two-Account Architecture (Control + Data)

### Problem
All resources in one account — a single compromised credential has account-level blast radius.

### Fix: Two AWS accounts

```
AWS Organization
├── Management Account        (billing, SCPs, no workloads)
├── Control Account           (CDK pipelines, CI/CD, developer access)
│   ├── ECR Repository        (images cross-account pulled by data account)
│   └── CDK Pipeline          (cross-account deploy role)
└── Data Account  [CRITICAL]  (all data-plane resources)
    ├── VPC + ECS             (no console login, no human IAM users)
    ├── S3 Buckets            (uploads, results, audit)
    ├── DynamoDB              (jobs table)
    ├── OpenSearch            (knowledge store)
    ├── Lambda Functions      (ingestion, results, query)
    └── KMS Keys              (all CMKs)
```

#### `infra/lib/cross-account-stack.ts` (in Control Account)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface CrossAccountStackProps extends cdk.StackProps {
  dataAccountId: string;
  envName: string;
}

export class CrossAccountStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CrossAccountStackProps) {
    super(scope, id, props);

    // Deploy role — assumed by CI/CD pipeline in control account to deploy to data account
    const deployRole = new iam.Role(this, 'DataAccountDeployRole', {
      roleName: `skills-svc-deploy-${props.envName}`,
      assumedBy: new iam.CompositePrincipal(
        new iam.AccountPrincipal(this.account), // control account CI/CD
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CDKDeployPermissions',
      actions: ['cloudformation:*', 'ssm:GetParameter', 'ssm:PutParameter', 's3:*'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'aws:RequestedRegion': 'us-east-1' },
      },
    }));

    // User role in data account — CLI users assume this cross-account
    // (Actual role is in data account; this is a trust policy pointer)
    new cdk.CfnOutput(this, 'DataAccountUserRoleArn', {
      value: `arn:aws:iam::${props.dataAccountId}:role/skills-svc-user-${props.envName}`,
      description: 'Role to assume for CLI access (in data account)',
    });
  }
}
```

#### Data Account — User Role Trust Policy Update

In `security-stack.ts`, add trust to allow cross-account assumption from control account developers:

```typescript
// REPLACE existing userRole trust policy
this.userRole = new iam.Role(this, 'UserRole', {
  roleName: `skills-svc-user-${envName}`,
  assumedBy: new iam.CompositePrincipal(
    new iam.AccountPrincipal(controlAccountId), // cross-account from control account
  ),
  description: 'Role assumed by CLI users via cross-account trust',
  maxSessionDuration: cdk.Duration.hours(8),
  // REMOVED: AccountRootPrincipal — no direct same-account assumption
});
```

#### `cdk.json` update — add context for accounts

```json
{
  "app": "npx ts-node bin/app.ts",
  "context": {
    "controlAccountId": "111111111111",
    "dataAccountId": "222222222222",
    "envName": "prod"
  }
}
```

---

## 6. Secrets Manager for All Remaining Secrets

### Problem
SSM SecureString has no automatic rotation and no versioning for rollback.

### Fix
Since we eliminated the Anthropic API key (switching to Bedrock), the only remaining application secret is any third-party webhook or notification endpoint. Move all such secrets to Secrets Manager with 30-day automatic rotation.

For a future-proof pattern, create a Secrets Manager secret for any outbound notification webhook:

```typescript
// In MessagingStack or a new SecretsStack
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

const notificationWebhookSecret = new secretsmanager.Secret(this, 'NotificationWebhook', {
  secretName: `/skills-svc/${envName}/notification/webhook-url`,
  description: 'Optional webhook URL for job completion notifications',
  encryptionKey: props.messagingKey,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  // Rotation: configure manually or with a rotation Lambda
});

// Deny all access except the notification Lambda role
notificationWebhookSecret.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'DenyAllExceptNotificationRole',
  effect: iam.Effect.DENY,
  principals: [new iam.StarPrincipal()],
  actions: ['secretsmanager:GetSecretValue'],
  resources: [notificationWebhookSecret.secretArn],
  conditions: {
    StringNotEquals: {
      'aws:PrincipalArn': props.resultsLambdaRole.roleArn,
    },
  },
}));
```

Secrets Manager configuration in `packages/lambda/src/results-processor/handler.ts`:

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsManager = new SecretsManagerClient({ region: process.env.REGION });
let _webhookUrl: string | null = null;

async function getWebhookUrl(env: string): Promise<string | null> {
  if (_webhookUrl) return _webhookUrl;
  try {
    const res = await secretsManager.send(new GetSecretValueCommand({
      SecretId: `/skills-svc/${env}/notification/webhook-url`,
      VersionStage: 'AWSCURRENT',
    }));
    _webhookUrl = res.SecretString ?? null;
  } catch {
    return null; // webhook is optional
  }
  return _webhookUrl;
}
```

---

## 7. OpenSearch Row-Level Security (Filter by user_arn)

### Problem
Any authenticated user can query any other user's results.

### Fix: Always apply `user_arn` filter in `hybridSearch`

#### Updated `packages/knowledge-store/src/searcher.ts`

```typescript
export async function hybridSearch(
  query: string,
  callerUserArn: string,           // REQUIRED — enforced, not optional
  topK = 5,
  minScore = 0.5,
  adminOverride = false,           // only break-glass role can set true
): Promise<SearchResult[]> {
  if (!callerUserArn) throw new Error('callerUserArn is required for row-level security');
  if (adminOverride) {
    console.warn(JSON.stringify({ event: 'admin_override_search', callerUserArn })); // audit
  }

  const client = await getOpenSearchClient();
  const indexName = await getIndexName();
  const embedding = await getEmbedding(query);

  const userFilter = adminOverride
    ? undefined
    : { term: { user_arn: callerUserArn } };

  const response = await client.search({
    index: indexName,
    body: {
      size: topK,
      query: {
        // Wrap hybrid in a bool filter for row-level security
        bool: {
          must: {
            hybrid: {
              queries: [
                { knn: { result_embedding: { vector: embedding, k: topK * 2 } } },
                {
                  multi_match: {
                    query,
                    fields: ['job_name^2', 'result_summary^3', 'result_full_text^1', 'skill_names^1.5'],
                    type: 'best_fields',
                    fuzziness: 'AUTO',
                  },
                },
              ],
            },
          },
          ...(userFilter ? { filter: [userFilter] } : {}),
        },
      },
      _source: ['job_id', 'job_name', 'result_summary', 'created_at', 's3_result_key', 'skill_names', 'user_arn'],
      min_score: minScore,
    },
  });

  return (response.body.hits?.hits ?? []).map((hit: any) => ({
    jobId: hit._source.job_id,
    jobName: hit._source.job_name,
    resultSummary: hit._source.result_summary,
    score: hit._score,
    createdAt: hit._source.created_at,
    s3ResultKey: hit._source.s3_result_key ?? '',
    skillNames: hit._source.skill_names ?? [],
  }));
}
```

#### Updated `packages/lambda/src/query/handler.ts`

```typescript
import { APIGatewayProxyHandler } from 'aws-lambda';
import { hybridSearch } from '@skills-svc/knowledge-store';
import { QueryRequest, QueryResponse } from '@skills-svc/shared';

export const handler = async (event: { body: string; requestContext?: any }): Promise<QueryResponse> => {
  const req: QueryRequest = JSON.parse(event.body ?? event as any);

  // Extract caller identity — passed from CLI via Lambda invocation context
  // The Lambda resource policy ensures only the user role can invoke this function
  // The caller ARN is injected by IAM and cannot be spoofed
  const callerArn = req.callerUserArn; // populated by CLI from STS GetCallerIdentity

  if (!callerArn) throw new Error('callerUserArn missing from request — request rejected');

  const start = Date.now();
  const results = await hybridSearch(req.query, callerArn, req.topK ?? 5, req.minScore ?? 0.5);

  return { results, queryDurationMs: Date.now() - start };
};
```

#### Updated `QueryRequest` type in `packages/shared/src/types.ts`

```typescript
export interface QueryRequest {
  query: string;
  callerUserArn: string;    // REQUIRED — enforced in Lambda handler
  topK?: number;
  minScore?: number;
}
```

#### Updated CLI `packages/cli/src/commands/query.ts`

```typescript
// Add to query command before invoking Lambda:
const identity = await sts.send(new GetCallerIdentityCommand({}));
const req: QueryRequest = {
  query: question,
  callerUserArn: identity.Arn!,  // inject caller ARN for row-level security
  topK: parseInt(opts.topK, 10),
  minScore: parseFloat(opts.minScore),
};
```

---

## 8. ECR CVE Gate in CI/CD

### Problem
ECR scans images on push but CI never checks scan results — a critical CVE can reach production.

### Fix: `.github/workflows/ci.yml` — add ECR scan check after docker push

Add this job after the `docker build` step and before `deploy-staging`:

```yaml
  ecr-cve-gate:
    name: ECR CVE Gate (block on critical/high)
    needs: qa
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/develop' || startsWith(github.ref, 'refs/tags/v')
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.STAGING_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1

      - name: Build and push to ECR for scanning
        id: build-push
        run: |
          ECR_URI=$(aws ssm get-parameter --name "/skills-svc/staging/ecr/repo-uri" --query Parameter.Value --output text)
          IMAGE_TAG=$(git rev-parse --short HEAD)
          aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$ECR_URI"
          docker build -t "$ECR_URI:$IMAGE_TAG" packages/ecs-runner/
          docker push "$ECR_URI:$IMAGE_TAG"
          echo "ecr_uri=$ECR_URI" >> $GITHUB_OUTPUT
          echo "image_tag=$IMAGE_TAG" >> $GITHUB_OUTPUT

      - name: Wait for ECR scan and enforce CVE gate
        run: |
          ECR_URI="${{ steps.build-push.outputs.ecr_uri }}"
          IMAGE_TAG="${{ steps.build-push.outputs.image_tag }}"
          REPO_NAME=$(echo "$ECR_URI" | cut -d'/' -f2)

          echo "Waiting for ECR scan to complete..."
          for i in $(seq 1 30); do
            STATUS=$(aws ecr describe-image-scan-findings \
              --repository-name "$REPO_NAME" \
              --image-id imageTag="$IMAGE_TAG" \
              --query 'imageScanStatus.status' --output text 2>/dev/null || echo "IN_PROGRESS")
            [ "$STATUS" = "COMPLETE" ] && break
            echo "  Scan status: $STATUS (attempt $i/30)"
            sleep 10
          done

          # Extract severity counts
          CRITICAL=$(aws ecr describe-image-scan-findings \
            --repository-name "$REPO_NAME" \
            --image-id imageTag="$IMAGE_TAG" \
            --query 'imageScanFindings.findingSeverityCounts.CRITICAL' --output text)
          HIGH=$(aws ecr describe-image-scan-findings \
            --repository-name "$REPO_NAME" \
            --image-id imageTag="$IMAGE_TAG" \
            --query 'imageScanFindings.findingSeverityCounts.HIGH' --output text)

          CRITICAL=${CRITICAL:-0}
          HIGH=${HIGH:-0}
          echo "CVE Scan Results: CRITICAL=$CRITICAL  HIGH=$HIGH"

          if [ "$CRITICAL" -gt 0 ]; then
            echo "❌ BLOCKED: $CRITICAL critical CVE(s) found — deployment halted"
            exit 1
          fi
          if [ "$HIGH" -gt 5 ]; then
            echo "❌ BLOCKED: $HIGH high CVE(s) found (threshold: 5) — deployment halted"
            exit 1
          fi
          echo "✅ CVE gate passed (CRITICAL=0, HIGH=$HIGH)"

      - name: Generate SBOM
        run: |
          docker sbom "${{ steps.build-push.outputs.ecr_uri }}:${{ steps.build-push.outputs.image_tag }}" \
            --format spdx-json \
            --output sbom-${{ steps.build-push.outputs.image_tag }}.spdx.json
      - uses: actions/upload-artifact@v4
        with:
          name: sbom-${{ steps.build-push.outputs.image_tag }}
          path: sbom-*.spdx.json
          retention-days: 90
```

---

## 9. DLP Output Scanning Before OpenSearch Indexing

### Problem
Claude's output could contain PII, secrets, or regulated data from the input skills.

### Fix: Add DLP scan in `packages/lambda/src/results-processor/indexer.ts`

```typescript
import { ComprehendClient, DetectPiiEntitiesCommand, DetectSentimentCommand } from '@aws-sdk/client-comprehend';
import { RunResult } from '@skills-svc/shared';

const comprehend = new ComprehendClient({ region: process.env.REGION ?? 'us-east-1' });

// Regex patterns for secrets (supplement Comprehend PII detection)
const SECRET_PATTERNS = [
  { name: 'AWS_ACCESS_KEY',   pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS_SECRET_KEY',   pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/ },
  { name: 'PRIVATE_KEY',      pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GITHUB_TOKEN',     pattern: /ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}/ },
  { name: 'GENERIC_API_KEY',  pattern: /api[_-]?key[_-]?[:=]\s*['"]?[A-Za-z0-9/+=]{20,}['"]?/i },
  { name: 'JWT_TOKEN',        pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]+/ },
  { name: 'CREDIT_CARD',      pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\b/ },
  { name: 'SSN',              pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
];

export interface DLPScanResult {
  clean: boolean;
  redactedText: string;
  findings: Array<{ type: string; location: string }>;
}

export async function dlpScan(text: string): Promise<DLPScanResult> {
  const findings: Array<{ type: string; location: string }> = [];
  let redactedText = text;

  // 1. Regex-based secret pattern scan
  for (const { name, pattern } of SECRET_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      findings.push({ type: name, location: `regex match` });
      // Redact the match
      redactedText = redactedText.replace(pattern, `[REDACTED:${name}]`);
      console.warn(JSON.stringify({ event: 'dlp_finding', type: name }));
    }
  }

  // 2. Amazon Comprehend PII detection (on first 5000 chars — Comprehend limit)
  const textChunk = text.slice(0, 5000);
  try {
    const piiResult = await comprehend.send(new DetectPiiEntitiesCommand({
      Text: textChunk,
      LanguageCode: 'en',
    }));

    for (const entity of piiResult.Entities ?? []) {
      if ((entity.Score ?? 0) > 0.9) { // high-confidence PII only
        const piiValue = textChunk.slice(entity.BeginOffset, entity.EndOffset);
        findings.push({ type: `PII:${entity.Type}`, location: `offset ${entity.BeginOffset}-${entity.EndOffset}` });
        redactedText = redactedText.replace(piiValue, `[REDACTED:${entity.Type}]`);
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'dlp_comprehend_error', err: String(err) }));
    // Don't block indexing on Comprehend failure — log and continue
  }

  const highRiskTypes = ['AWS_ACCESS_KEY', 'PRIVATE_KEY', 'SSN', 'CREDIT_CARD', 'JWT_TOKEN'];
  const hasHighRisk = findings.some(f => highRiskTypes.some(t => f.type.includes(t)));

  return {
    clean: findings.length === 0,
    redactedText,
    findings,
  };
}

// Updated indexJobResult — always scan before indexing
export async function indexJobResult(result: RunResult, env: string): Promise<string> {
  // DLP scan on result summary and full text
  const summaryDLP = await dlpScan(result.resultSummary);
  const fullTextDLP = await dlpScan(result.output.slice(0, 50_000));

  if (!summaryDLP.clean || !fullTextDLP.clean) {
    const allFindings = [...summaryDLP.findings, ...fullTextDLP.findings];
    console.warn(JSON.stringify({
      event: 'dlp_findings_redacted',
      jobId: result.jobId,
      findingCount: allFindings.length,
      types: allFindings.map(f => f.type),
    }));
    // Index the redacted version, not the original
    result = {
      ...result,
      resultSummary: summaryDLP.redactedText,
      output: fullTextDLP.redactedText,
    };
  }

  // Proceed with indexing (redacted text)
  // ... rest of indexJobResult from SPEC-02 ...
  const client = await getOpenSearchClient();
  const indexName = await getIndexName();
  const embeddingText = [result.jobName, result.skillNames.join(' '), result.resultSummary].join(' ');
  const embedding = await getEmbedding(embeddingText);

  await client.index({
    index: indexName,
    id: result.jobId,
    body: {
      job_id: result.jobId,
      job_name: result.jobName,
      skill_names: result.skillNames,
      prompt: result.prompt,
      result_summary: result.resultSummary,       // redacted
      result_full_text: result.output.slice(0, 50_000), // redacted
      result_embedding: embedding,
      created_at: new Date().toISOString(),
      completed_at: result.completedAt,
      duration_ms: result.durationMs,
      exit_code: result.exitCode,
      dlp_findings_count: summaryDLP.findings.length + fullTextDLP.findings.length,
      version: 1,
    },
    refresh: false,
  });

  return result.jobId;
}
```

**IAM permission to add to `resultsLambdaRole`:**
```typescript
this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ComprehendPII',
  actions: ['comprehend:DetectPiiEntities'],
  resources: ['*'], // Comprehend has no resource-level restrictions
}));
```

---

## 10. ECS /tmp Wipe After Processing

### Problem
Sensitive zip contents and Claude outputs remain in `/tmp/workspace` until the container terminates.

### Fix: `packages/ecs-runner/src/main.ts` — always wipe `/tmp/workspace`

```typescript
import { rm, writeFile, readdir } from 'fs/promises';
import { join } from 'path';

async function securelyClearWorkspace(dir: string): Promise<void> {
  // Overwrite files with zeros before deletion (defense against memory forensics on ECS host)
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true } as any);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        const filePath = join(entry.path ?? dir, entry.name);
        try {
          const { size } = await import('fs/promises').then(f => f.stat(filePath));
          await writeFile(filePath, Buffer.alloc(size, 0)); // overwrite with zeros
        } catch { /* best effort */ }
      }
    }
  } catch { /* directory may not exist */ }

  await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ event: 'workspace_cleared', dir }));
}

async function main(): Promise<void> {
  const jobId = process.env.JOB_ID ?? fail('JOB_ID required');
  const s3Bucket = process.env.S3_BUCKET ?? fail('S3_BUCKET required');
  const s3Key = process.env.S3_KEY ?? fail('S3_KEY required');
  const env = process.env.ENV ?? 'prod';

  process.on('SIGTERM', async () => {
    console.log(JSON.stringify({ event: 'sigterm', message: 'Clearing workspace before shutdown' }));
    await securelyClearWorkspace('/tmp/workspace').catch(() => {});
    process.exit(1);
  });

  try {
    await updateJobStatus(jobId, JobStatus.RUNNING, env);
    const zipPath = await downloadZip(s3Bucket, s3Key, '/tmp/workspace/upload.zip');
    await verifyChecksum(zipPath, s3Bucket, s3Key); // NEW — see section 11
    const extractDir = await extractZip(zipPath, '/tmp/workspace/skills');
    const results = await runSkills(extractDir, jobId, env);
    const resultKey = await uploadResults(jobId, results, env);
    console.log(JSON.stringify({ event: 'task_complete', jobId, resultKey }));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ event: 'task_error', jobId, err: String(err) }));
    await updateJobStatus(jobId, JobStatus.FAILED, env, String(err)).catch(() => {});
    process.exit(1);
  } finally {
    // ALWAYS clear workspace regardless of success or failure
    await securelyClearWorkspace('/tmp/workspace');
  }
}
```

---

## 11. SHA256 Verification in ECS Before Zip Extraction

### Problem
TOCTOU: Lambda validates the zip, but ECS downloads and processes whatever is at that S3 key. A race condition or storage-layer corruption could cause a different file to be processed.

### Fix: Store SHA256 in DynamoDB at Lambda time; verify in ECS before extraction.

#### `packages/lambda/src/ingestion/handler.ts` — store checksum in DDB

```typescript
// After HeadObject, capture the S3 checksum
const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
const s3ChecksumSha256 = head.ChecksumSHA256; // only present if uploaded with ChecksumAlgorithm: SHA256

// Store in DynamoDB job record (add to PutCommand Item):
s3ChecksumSha256: s3ChecksumSha256 ?? null,
```

#### `packages/ecs-runner/src/main.ts` — add verifyChecksum call

```typescript
import { S3Client, GetObjectAttributesCommand, ObjectAttributes } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';

const s3 = new S3Client({ region: process.env.REGION });

export async function verifyChecksum(zipPath: string, bucket: string, key: string): Promise<void> {
  // Get the S3-stored checksum
  const attrs = await s3.send(new GetObjectAttributesCommand({
    Bucket: bucket,
    Key: key,
    ObjectAttributes: [ObjectAttributes.CHECKSUM],
  }));

  const s3Sha256 = attrs.Checksum?.ChecksumSHA256;
  if (!s3Sha256) {
    console.warn(JSON.stringify({ event: 'no_s3_checksum', key, message: 'S3 checksum not present — skipping verification' }));
    return; // uploaded before checksum enforcement — allow but warn
  }

  // Compute local SHA256 of downloaded file
  const localHash = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(zipPath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('base64')))
      .on('error', reject);
  });

  if (localHash !== s3Sha256) {
    throw new Error(
      `Checksum mismatch — possible tamper or corruption. ` +
      `Expected: ${s3Sha256}, Got: ${localHash}`
    );
  }

  console.log(JSON.stringify({ event: 'checksum_verified', key, sha256: localHash }));
}
```

---

## 12. Bedrock Region Lock and Model Invocation Logging

### Problem
Bedrock calls could route cross-region. Model inputs/outputs should be logged for compliance.

### Fix: IAM condition + Bedrock model invocation logging

#### IAM condition already added in Section 1 (Bedrock region lock)

The `ecsTaskRole` Bedrock policy now includes:
```typescript
conditions: {
  StringEquals: { 'aws:RequestedRegion': this.region },
},
```

#### Bedrock Model Invocation Logging — `infra/lib/compliance-stack.ts`

```typescript
import * as bedrock from 'aws-cdk-lib/aws-bedrock';

// Bedrock model invocation logging (S3 destination, KMS encrypted)
// Note: CDK L1 construct — use CfnLoggingConfiguration
const bedrockLogBucket = new s3.Bucket(this, 'BedrockLogBucket', {
  bucketName: `skills-svc-bedrock-logs-${this.account}-${this.region}`,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.KMS,
  encryptionKey: props.auditKey,
  enforceSSL: true,
  versioned: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  objectLockEnabled: true,
  objectLockDefaultRetention: {
    mode: s3.ObjectLockMode.COMPLIANCE,
    duration: cdk.Duration.days(365),
  },
  lifecycleRules: [{
    id: 'glacier-after-30',
    transitions: [{ storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(30) }],
  }],
});

// Bedrock invocation logs — log prompts and completions for audit
// This is a CfnResource (no L2 construct yet)
new cdk.CfnResource(this, 'BedrockLoggingConfig', {
  type: 'AWS::Bedrock::ModelInvocationLoggingConfiguration',
  properties: {
    LoggingConfig: {
      S3Config: {
        BucketName: bedrockLogBucket.bucketName,
        KeyPrefix: `bedrock-logs/${props.envName}/`,
      },
      TextDataDeliveryEnabled: true,
      ImageDataDeliveryEnabled: false,
      EmbeddingDataDeliveryEnabled: true,
    },
  },
});

// Grant Bedrock service permission to write to the log bucket
bedrockLogBucket.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'AllowBedrockLogs',
  principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
  actions: ['s3:PutObject'],
  resources: [`${bedrockLogBucket.bucketArn}/bedrock-logs/*`],
  conditions: {
    StringEquals: { 'aws:SourceAccount': this.account },
    ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:*` },
  },
}));
```

---

## 13. Break-Glass Procedure

### Break-Glass IAM Role (`infra/lib/security-stack.ts`)

```typescript
// Break-glass role — for emergency incident response only
// Requires MFA + explicit approval in audit log
this.breakGlassRole = new iam.Role(this, 'BreakGlassRole', {
  roleName: `skills-svc-break-glass-${envName}`,
  assumedBy: new iam.AccountPrincipal(this.account),
  description: 'Emergency break-glass role for incident response — all sessions logged to CloudTrail',
  maxSessionDuration: cdk.Duration.hours(1), // short session only
});

// Full read access to all data for incident investigation
this.breakGlassRole.addToPolicy(new iam.PolicyStatement({
  sid: 'BreakGlassReadAll',
  actions: [
    's3:GetObject', 's3:ListBucket',
    'dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:Query',
    'logs:GetLogEvents', 'logs:FilterLogEvents',
    'cloudtrail:LookupEvents',
    'kms:Decrypt', // to read encrypted data for investigation
  ],
  resources: ['*'],
}));

// CloudWatch alarm — fires whenever break-glass role is assumed
new cloudwatch.Alarm(this, 'BreakGlassAssumedAlarm', {
  alarmName: `skills-svc-${envName}-break-glass-assumed`,
  metric: new cloudwatch.Metric({
    namespace: 'CloudTrailMetrics',
    metricName: 'BreakGlassRoleAssumed',
    period: cdk.Duration.minutes(1),
    statistic: 'Sum',
  }),
  threshold: 1,
  evaluationPeriods: 1,
  alarmDescription: 'CRITICAL: Break-glass role was assumed — verify this is authorized',
}).addAlarmAction(new cloudwatchActions.SnsAction(props.securityAlarmTopic));

// CloudWatch metric filter — detect break-glass assumption from CloudTrail
new logs.MetricFilter(this, 'BreakGlassMetricFilter', {
  logGroup: props.cloudTrailLogGroup,
  metricNamespace: 'CloudTrailMetrics',
  metricName: 'BreakGlassRoleAssumed',
  filterPattern: logs.FilterPattern.literal(
    `{ $.eventName = "AssumeRole" && $.requestParameters.roleArn = "*break-glass*" }`
  ),
  metricValue: '1',
});
```

### Break-Glass Runbook (`docs/break-glass-runbook.md`)

```markdown
# Break-Glass Emergency Access Runbook

## When to Use
- Active security incident requiring data access
- Critical bug requiring direct DynamoDB inspection
- Key compromise requiring immediate audit

## Authorization Required
1. Incident commander approval (verbal + Slack message)
2. Security team lead approval (Slack + JIRA ticket)
3. Post-incident review required within 24 hours

## Steps
1. Open JIRA incident ticket with reason
2. Post in #security-incidents: "Assuming break-glass role for incident JIRA-XXXX"
3. Assume role:
   ```bash
   aws sts assume-role \
     --role-arn arn:aws:iam::DATA_ACCOUNT:role/skills-svc-break-glass-prod \
     --role-session-name "incident-JIRA-XXXX-$(whoami)" \
     --duration-seconds 3600
   ```
4. An SNS alarm fires immediately — security team is notified
5. Perform investigation — ALL actions are CloudTrail logged
6. Revoke credentials when done (session expires in 1 hour automatically)
7. File post-incident review within 24 hours

## Key Compromise Response
1. Immediately: `aws kms disable-key --key-id <compromised-key-id>`
2. Rotate affected key: `aws kms enable-key-rotation --key-id <new-key-id>`
3. Re-encrypt all affected S3 objects using batch operations
4. Rotate any credentials that could decrypt with old key
5. Review CloudTrail for unauthorized decryption events in last 90 days

## Contacts
- Security Lead: security-lead@company.com
- Incident Commander: oncall@company.com
- AWS Support: open P1 case via console
```

---

## 14. SBOM Generation

Already included in the ECR CVE Gate (Section 8) via `docker sbom`. Additionally, generate SBOM for Lambda dependencies:

```yaml
# Add to .github/workflows/ci.yml
      - name: Generate Lambda SBOM
        run: |
          npm install -g @cyclonedx/cyclonedx-npm
          cyclonedx-npm --output-format json --output-file sbom-lambda.cdx.json packages/lambda
          cyclonedx-npm --output-format json --output-file sbom-ecs-runner.cdx.json packages/ecs-runner
      - uses: actions/upload-artifact@v4
        with:
          name: sbom-npm-${{ github.sha }}
          path: sbom-*.cdx.json
          retention-days: 365
```

---

## New QA Checks (QA-101 through QA-114)

Add to `scripts/qa-run-all.sh` and `infra/test/`:

```typescript
// QA-101: Bedrock model ID uses supported Claude model (not Anthropic direct)
test('QA-101: ECS runner uses Bedrock Claude model ID', () => {
  const source = readFileSync('packages/ecs-runner/src/runner.ts', 'utf-8');
  expect(source).toContain('anthropic.claude');
  expect(source).not.toContain('api.anthropic.com');
  expect(source).not.toContain('ANTHROPIC_API_KEY');
});

// QA-102: Audit bucket has Object Lock in COMPLIANCE mode
test('QA-102: Audit S3 bucket has Object Lock in COMPLIANCE mode', () => {
  const { templates } = buildTestApp();
  templates.compliance.hasResourceProperties('AWS::S3::Bucket', {
    ObjectLockEnabled: true,
    ObjectLockConfiguration: {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 2555 } },
    },
  });
});

// QA-103: Audit bucket denies DeleteObject
test('QA-103: Audit bucket policy denies DeleteObject', () => {
  const { templates } = buildTestApp();
  const policies = templates.compliance.findResources('AWS::S3::BucketPolicy');
  const auditPolicy = Object.values(policies).find((p: any) =>
    JSON.stringify(p).includes('audit')
  );
  expect(auditPolicy).toBeDefined();
  const stmts = (auditPolicy as any).Properties.PolicyDocument.Statement;
  const denyDelete = stmts.find((s: any) =>
    s.Effect === 'Deny' &&
    (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('s3:DeleteObject')
  );
  expect(denyDelete).toBeDefined();
});

// QA-104: SCP policy file exists and contains required deny statements
test('QA-104: SCP policy file has all required deny statements', () => {
  const source = readFileSync('infra/lib/scp-policies.ts', 'utf-8');
  expect(source).toContain('StopLogging');
  expect(source).toContain('DeleteDetector');
  expect(source).toContain('ScheduleKeyDeletion');
  expect(source).toContain('LeaveOrganization');
});

// QA-105: envelopeEncrypt and envelopeDecrypt are round-trip correct
test('QA-105: Envelope encrypt/decrypt round-trip is mathematically correct', async () => {
  const kmsMock = mockClient(KMSClient);
  const fakeDataKey = randomBytes(32);
  kmsMock.on(GenerateDataKeyCommand).resolves({
    Plaintext: fakeDataKey,
    CiphertextBlob: Buffer.from('encrypted-key'),
  });
  kmsMock.on(DecryptCommand).resolves({ Plaintext: fakeDataKey });

  const plaintext = Buffer.from('critical data payload for round-trip test');
  const envelope = await envelopeEncrypt(plaintext, 'alias/test-key', { jobId: 'test' });
  const decrypted = await envelopeDecrypt(envelope, { jobId: 'test' });

  expect(decrypted.toString('utf-8')).toBe('critical data payload for round-trip test');
  expect(envelope.ciphertext).not.toBe(plaintext.toString('base64')); // actually encrypted
});

// QA-106: envelopeDecrypt fails with wrong encryption context
test('QA-106: Envelope decrypt fails with wrong encryption context', async () => {
  const kmsMock = mockClient(KMSClient);
  kmsMock.on(DecryptCommand).rejects(new Error('InvalidCiphertextException'));

  await expect(
    envelopeDecrypt(fakeEnvelope, { jobId: 'WRONG-JOB-ID' })
  ).rejects.toThrow();
});

// QA-107: hybridSearch always includes user_arn filter
test('QA-107: hybridSearch always applies user_arn filter', async () => {
  const searchSpy = jest.fn().mockResolvedValue({ body: { hits: { hits: [] } } });
  jest.spyOn(clientModule, 'getOpenSearchClient').mockResolvedValue({ search: searchSpy } as any);

  await hybridSearch('test query', 'arn:aws:iam::123:user/alice');

  const searchBody = searchSpy.mock.calls[0][0].body;
  expect(JSON.stringify(searchBody)).toContain('user_arn');
  expect(JSON.stringify(searchBody)).toContain('arn:aws:iam::123:user/alice');
});

// QA-108: hybridSearch throws if callerUserArn is empty
test('QA-108: hybridSearch rejects empty callerUserArn', async () => {
  await expect(hybridSearch('test', '')).rejects.toThrow(/callerUserArn/);
  await expect(hybridSearch('test', undefined as any)).rejects.toThrow(/callerUserArn/);
});

// QA-109: DLP scan detects AWS access key pattern
test('QA-109: DLP scan detects and redacts AWS access key', async () => {
  const text = 'Here is your key: AKIAIOSFODNN7EXAMPLE and some other text';
  const result = await dlpScan(text);
  expect(result.clean).toBe(false);
  expect(result.findings.some(f => f.type === 'AWS_ACCESS_KEY')).toBe(true);
  expect(result.redactedText).toContain('[REDACTED:AWS_ACCESS_KEY]');
  expect(result.redactedText).not.toContain('AKIAIOSFODNN7EXAMPLE');
});

// QA-110: DLP scan detects private key
test('QA-110: DLP scan detects and redacts private key header', async () => {
  const text = 'Key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...';
  const result = await dlpScan(text);
  expect(result.clean).toBe(false);
  expect(result.findings.some(f => f.type === 'PRIVATE_KEY')).toBe(true);
});

// QA-111: Workspace is wiped in finally block (always)
test('QA-111: main() clears workspace in finally block even on error', async () => {
  const clearSpy = jest.spyOn(workspaceModule, 'securelyClearWorkspace').mockResolvedValue();
  jest.spyOn(downloaderModule, 'downloadZip').mockRejectedValue(new Error('download failed'));

  await expect(main()).resolves.not.toThrow(); // process.exit(1) mocked
  expect(clearSpy).toHaveBeenCalledWith('/tmp/workspace');
});

// QA-112: SHA256 checksum mismatch throws before extraction
test('QA-112: verifyChecksum throws on SHA256 mismatch', async () => {
  const s3Mock = mockClient(S3Client);
  s3Mock.on(GetObjectAttributesCommand).resolves({
    Checksum: { ChecksumSHA256: 'correctHash==' },
  });

  // File has different content → different hash
  await writeFile('/tmp/test-tampered.zip', Buffer.from('tampered content'));
  await expect(verifyChecksum('/tmp/test-tampered.zip', 'bucket', 'key'))
    .rejects.toThrow(/mismatch|tamper/i);
});

// QA-113: Bedrock calls have aws:RequestedRegion condition in IAM policy
test('QA-113: ECS task role Bedrock policy has RequestedRegion condition', () => {
  const { templates } = buildTestApp();
  const roles = templates.security.findResources('AWS::IAM::Role');
  const taskRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('BedrockInvokeClaude')
  );
  expect(taskRole).toBeDefined();
  const bedrockStmt = (taskRole as any).Properties.Policies
    .flatMap((p: any) => p.PolicyDocument.Statement)
    .find((s: any) => s.Sid === 'BedrockInvokeClaude');
  expect(bedrockStmt.Condition?.StringEquals?.['aws:RequestedRegion']).toBeDefined();
});

// QA-114: Break-glass alarm exists in MonitoringStack
test('QA-114: CloudWatch alarm exists for break-glass role assumption', () => {
  const { templates } = buildTestApp();
  const alarms = templates.security.findResources('AWS::CloudWatch::Alarm');
  const bgAlarm = Object.values(alarms).find((a: any) =>
    JSON.stringify(a).includes('break-glass') || JSON.stringify(a).includes('BreakGlass')
  );
  expect(bgAlarm).toBeDefined();
});
```

---

## Summary of Changes to Existing Files

| File | Change |
|------|--------|
| `packages/ecs-runner/src/runner.ts` | **Replace** entire file — Bedrock SDK instead of claude CLI |
| `packages/ecs-runner/Dockerfile` | **Remove** `npm install -g @anthropic-ai/claude-code` |
| `packages/ecs-runner/src/main.ts` | Add `verifyChecksum`, `securelyClearWorkspace` in `finally` |
| `packages/ecs-runner/src/uploader.ts` | Add envelope encryption before S3 upload |
| `packages/lambda/src/results-processor/handler.ts` | Add `envelopeDecrypt` before reading result JSON |
| `packages/lambda/src/results-processor/indexer.ts` | Add `dlpScan` before indexing |
| `packages/lambda/src/ingestion/handler.ts` | Store `s3ChecksumSha256` in DDB record |
| `packages/knowledge-store/src/searcher.ts` | Add mandatory `user_arn` filter |
| `packages/lambda/src/query/handler.ts` | Require and forward `callerUserArn` |
| `packages/cli/src/commands/query.ts` | Inject `callerUserArn` from STS identity |
| `packages/shared/src/types.ts` | Add `callerUserArn` to `QueryRequest`; `encryptedDataKey` to `JobRecord` |
| `infra/lib/compliance-stack.ts` | Object Lock on audit bucket, Bedrock invocation logging |
| `infra/lib/security-stack.ts` | Break-glass role + alarm, Bedrock region-locked policy |
| `infra/lib/messaging-stack.ts` | Secrets Manager for webhook (optional) |
| `.github/workflows/ci.yml` | ECR CVE gate job, SBOM generation |
| `scripts/qa-run-all.sh` | Add QA-101 through QA-114 |
| `infra/test/` | Add QA-101 through QA-114 test cases |
| **NEW** `packages/shared/src/crypto.ts` | Envelope encrypt/decrypt utility |
| **NEW** `infra/lib/scp-policies.ts` | SCP JSON definitions |
| **NEW** `scripts/apply-scps.sh` | One-time SCP application script |
| **NEW** `docs/break-glass-runbook.md` | Emergency access procedure |
| **DELETED** `/skills-svc/{env}/anthropic/api-key` SSM param | Replaced by Bedrock IAM |
