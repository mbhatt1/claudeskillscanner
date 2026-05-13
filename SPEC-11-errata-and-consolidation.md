# Skills as a Service (SaaS) — Specification Part 11: Errata & Consolidation

**Version:** 1.0.0  
**Status:** AUTHORITATIVE — fixes and supersedes conflicting sections in Parts 1–10  
**Parts:** ... | [Part 10](SPEC-10-skill-registry.md) | [Part 11: Errata & Consolidation]

---

## Overview

This document resolves 25 loose ends, inconsistencies, and gaps identified across SPEC-01 through SPEC-10. Each issue is numbered, sourced to the originating spec, and given an authoritative fix. Where a fix replaces a prior definition, this document is the canonical version.

| # | Category | Issue |
|---|----------|-------|
| 1 | CDK | `validateZipStructure` in wrong package — CLI cannot import from Lambda |
| 2 | CDK | `StorageStack` modified by 3 specs — authoritative version with all 5 GSIs |
| 3 | CDK | `SecurityStack` — authoritative KMS key list (10 keys) |
| 4 | CDK | `bin/app.ts` — authoritative version with all stacks |
| 5 | CDK | `BatchStack` never wired into `bin/app.ts` |
| 6 | CDK | Validator Lambda S3 event missing resource policy |
| 7 | CDK | `MCPStack` Lambda env missing `RESULTS_BUCKET`, `DYNAMODB_TABLE_NAME`, `QUERY_LAMBDA_ARN` |
| 8 | IAM | `UserRole` missing `s3:GetObject` on registry bucket for `run` command |
| 9 | IAM | MCP Lambda role missing registry bucket + skills table access |
| 10 | Types | `DDB_KEY_PREFIX` — authoritative version with all keys |
| 11 | Types | `CliConfig` — authoritative version with all fields |
| 12 | Types | `envelopeDecrypt`/`envelopeEncrypt` missing from `@skills-svc/shared` package.json |
| 13 | Types | `padSemver` collision between `1.0.0` and `1.0.0-beta.1` |
| 14 | Logic | `batch list` uses invalid DDB `begins_with` on partition key |
| 15 | Logic | `batch-submit` and `batch-status` Lambda handlers never implemented |
| 16 | Logic | `run` command job-ID polling too fragile — replace with `runId` metadata |
| 17 | Logic | `configure` command not updated for profiles or new SSM params |
| 18 | Logic | `skill list` default shows empty state confusingly |
| 19 | Logic | `notify subscribe --webhook` protocol requires confirmation — not documented |
| 20 | Logic | `skill push` — `AdmZip` used in CLI but not in CLI `package.json` |
| 21 | Logic | `run` command: inline `require()` instead of top-level import |
| 22 | Logic | `envelopeDecrypt` called in CLI `diff` command but KMS client needs creds |
| 23 | QA | QA-130 hardcodes `Math.min(Math.max(...))` — should test the actual clamp function |
| 24 | MCP | MCP `submit_job` with `skill_ref` references SSM params not available in Lambda env |
| 25 | Security | `run` command does cross-bucket S3 copy from CLI — should be server-side Lambda |

---

## Fix 1: Move `validateZipStructure` to `@skills-svc/shared`

**Problem:** `packages/lambda/src/ingestion/validator.ts` is referenced in SPEC-07 (`watch.ts`) and SPEC-10 (`skill.ts`) via `@skills-svc/shared`. The CLI package cannot import from the Lambda package.

**Fix:** Move validator to `packages/shared/src/validator.ts` and re-export from Lambda.

### `packages/shared/src/validator.ts` (new file — content moved from `packages/lambda/src/ingestion/validator.ts`)

```typescript
import AdmZip from 'adm-zip';
import { ZipManifest } from './types';

export interface ZipMetaHint {
  compressedSize: number;
  uncompressedSize: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  manifest?: ZipManifest;
}

const MAX_COMPRESSED_BYTES   = 500 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO  = 100;
const MAX_FILE_COUNT         = 10_000;
const ZIP_MAGIC              = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function validateZipStructure(buffer: Buffer, meta?: ZipMetaHint): ValidationResult {
  if (buffer.length < 4 || !buffer.slice(0, 4).equals(ZIP_MAGIC)) {
    return { valid: false, error: 'File is not a valid ZIP archive (bad magic bytes)' };
  }
  if (meta) {
    if (meta.compressedSize > MAX_COMPRESSED_BYTES) {
      return { valid: false, error: `Compressed size ${meta.compressedSize} exceeds 500MB limit` };
    }
    if (meta.uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
      return { valid: false, error: `Uncompressed size exceeds 2GB limit` };
    }
    if (meta.compressedSize > 0 && meta.uncompressedSize / meta.compressedSize > MAX_COMPRESSION_RATIO) {
      return { valid: false, error: `Compression ratio exceeds ${MAX_COMPRESSION_RATIO}:1 (possible zip bomb)` };
    }
  }
  let zip: AdmZip;
  try { zip = new AdmZip(buffer); } catch (e) {
    return { valid: false, error: `Cannot parse ZIP: ${String(e)}` };
  }
  const entries = zip.getEntries();
  if (entries.length > MAX_FILE_COUNT) {
    return { valid: false, error: `ZIP contains ${entries.length} files, exceeding limit of ${MAX_FILE_COUNT}` };
  }
  for (const entry of entries) {
    const name = entry.entryName;
    if (name.startsWith('/') || name.includes('../') || name.includes('..\\')) {
      return { valid: false, error: `Path traversal detected in entry: ${name}` };
    }
  }
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) return { valid: false, error: 'manifest.json not found in ZIP root' };
  let manifest: ZipManifest;
  try { manifest = JSON.parse(manifestEntry.getData().toString('utf-8')); } catch (e) {
    return { valid: false, error: `manifest.json is not valid JSON: ${String(e)}` };
  }
  if (!manifest.jobName || typeof manifest.jobName !== 'string')
    return { valid: false, error: 'manifest.json missing required field: jobName (string)' };
  if (!manifest.version || typeof manifest.version !== 'string')
    return { valid: false, error: 'manifest.json missing required field: version (string)' };
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0)
    return { valid: false, error: 'manifest.json missing required field: skills (non-empty array)' };
  for (const skill of manifest.skills) {
    const entry = zip.getEntry(`skills/${skill}.md`) ?? zip.getEntry(`skills/${skill}`);
    if (!entry) return { valid: false, error: `Skill file not found: skills/${skill}.md` };
  }
  return { valid: true, manifest };
}
```

### `packages/shared/src/index.ts` — add exports

```typescript
export * from './types';
export * from './constants';
export * from './validator';
export * from './crypto';     // envelopeEncrypt / envelopeDecrypt
```

### `packages/lambda/src/ingestion/validator.ts` — shim (keep existing imports working)

```typescript
// Re-export from shared — do not duplicate logic
export { validateZipStructure, ValidationResult, ZipMetaHint } from '@skills-svc/shared';
```

### `packages/shared/package.json` — add `adm-zip` and `@aws-sdk/client-kms`

```json
{
  "name": "@skills-svc/shared",
  "dependencies": {
    "adm-zip": "^0.5.10",
    "@aws-sdk/client-kms": "^3.600.0"
  }
}
```

---

## Fix 2: Authoritative `StorageStack` — All 5 GSIs

**Problem:** SPEC-02 defines 2 GSIs. SPEC-08 adds GSI4. SPEC-10 adds GSI5. Three conflicting partial definitions.

**Authoritative `infra/lib/storage-stack.ts` — jobs table GSI block:**

```typescript
// GSI1: query by status
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI1-Status',
  partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

// GSI2: query by user
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI2-User',
  partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.ALL,
});

// GSI3: query by schedule (SPEC-07 scheduled jobs)
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI3-Schedule',
  partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'jobName', 'status', 'createdAt'],
});

// GSI4: cache key lookup (SPEC-08 result caching)
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI4-CacheKey',
  partitionKey: { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'status', 'createdAt', 's3ResultKey'],
});

// GSI5: jobs by skill version (SPEC-10 skill registry lineage)
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI5-Skill',
  partitionKey: { name: 'GSI5PK', type: dynamodb.AttributeType.STRING },
  sortKey:      { name: 'GSI5SK', type: dynamodb.AttributeType.STRING },
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'jobName', 'status', 'createdAt', 'userArn'],
});
```

---

## Fix 3: Authoritative `SecurityStack` — All 10 KMS Keys

**Problem:** SPEC-02 defines 9 keys. SPEC-10 adds `registryBucketKey`. Authoritative list:

```typescript
// In infra/lib/security-stack.ts constructor — ALL keys:
this.uploadsBucketKey  = makeKey(this, 'UploadsBucketKey',  `${envName}/uploads`);
this.resultsBucketKey  = makeKey(this, 'ResultsBucketKey',  `${envName}/results`);
this.dynamodbKey       = makeKey(this, 'DynamoDBKey',       `${envName}/dynamodb`);
this.opensearchKey     = makeKey(this, 'OpenSearchKey',     `${envName}/opensearch`);
this.lambdaEnvKey      = makeKey(this, 'LambdaEnvKey',      `${envName}/lambda-env`);
this.ecsLogKey         = makeKey(this, 'EcsLogKey',         `${envName}/ecs-logs`);
this.ecrKey            = makeKey(this, 'EcrKey',            `${envName}/ecr`);
this.messagingKey      = makeKey(this, 'MessagingKey',      `${envName}/messaging`);
this.auditKey          = makeKey(this, 'AuditKey',          `${envName}/audit`);
this.registryBucketKey = makeKey(this, 'RegistryBucketKey', `${envName}/registry`); // SPEC-10

// Add to public readonly declarations:
public readonly registryBucketKey: kms.Key;
```

---

## Fix 4: Authoritative `infra/bin/app.ts`

**Problem:** SPEC-01 has the original. SPEC-09 adds MCPStack. SPEC-10 adds SkillRegistryStack. SPEC-08 BatchStack is never added.

```typescript
import { App, Aspects, Tags } from 'aws-cdk-lib';
import { NetworkStack }       from '../lib/network-stack';
import { SecurityStack }      from '../lib/security-stack';
import { StorageStack }       from '../lib/storage-stack';
import { MessagingStack }     from '../lib/messaging-stack';
import { LambdaStack }        from '../lib/lambda-stack';
import { ECSStack }           from '../lib/ecs-stack';
import { KnowledgeStoreStack } from '../lib/knowledge-store-stack';
import { MonitoringStack }    from '../lib/monitoring-stack';
import { ComplianceStack }    from '../lib/compliance-stack';
import { BatchStack }         from '../lib/batch-stack';          // SPEC-08
import { MCPStack }           from '../lib/mcp-stack';            // SPEC-09
import { SkillRegistryStack } from '../lib/skill-registry-stack'; // SPEC-10
import { NoWildcardIAMAspect }      from '../aspects/no-wildcard-iam';
import { EncryptionEnforcerAspect } from '../aspects/encryption-enforcer';
import { TaggingEnforcerAspect }    from '../aspects/tagging-enforcer';

const app     = new App();
const envName = (app.node.tryGetContext('envName') as string) ?? 'prod';
const env     = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' };

Aspects.of(app).add(new NoWildcardIAMAspect());
Aspects.of(app).add(new EncryptionEnforcerAspect());
Aspects.of(app).add(new TaggingEnforcerAspect({ requiredTags: ['Environment', 'Project', 'CostCenter', 'DataClassification'] }));

Tags.of(app).add('Project', 'skills-as-a-service');
Tags.of(app).add('Environment', envName);
Tags.of(app).add('CostCenter', 'engineering');
Tags.of(app).add('DataClassification', 'confidential');
Tags.of(app).add('ManagedBy', 'cdk');

const network  = new NetworkStack(app, `SkillsSvc-${envName}-Network`, { env, envName });
const security = new SecurityStack(app, `SkillsSvc-${envName}-Security`, { env, envName, vpc: network.vpc });
security.addDependency(network);

const storage = new StorageStack(app, `SkillsSvc-${envName}-Storage`, {
  env, envName,
  uploadsBucketKey: security.uploadsBucketKey,
  resultsBucketKey: security.resultsBucketKey,
  dynamodbKey:      security.dynamodbKey,
});
storage.addDependency(security);

const messaging = new MessagingStack(app, `SkillsSvc-${envName}-Messaging`, {
  env, envName,
  messagingKey:  security.messagingKey,
  uploadsBucket: storage.uploadsBucket,
});
messaging.addDependency(storage);

const lambdaStack = new LambdaStack(app, `SkillsSvc-${envName}-Lambda`, {
  env, envName,
  vpc: network.vpc, lambdaSg: network.lambdaSg,
  ingestionQueue:        messaging.ingestionQueue,
  ingestionDLQ:          messaging.ingestionDLQ,
  resultsDLQ:            messaging.resultsDLQ,
  jobsNotificationTopic: messaging.jobsNotificationTopic,
  jobsTable:             storage.jobsTable,
  uploadsBucket:         storage.uploadsBucket,
  resultsBucket:         storage.resultsBucket,
  ingestionLambdaRole:   security.ingestionLambdaRole,
  resultsLambdaRole:     security.resultsLambdaRole,
  queryLambdaRole:       security.queryLambdaRole,
  lambdaEnvKey:          security.lambdaEnvKey,
});
lambdaStack.addDependency(messaging);

const ecsStack = new ECSStack(app, `SkillsSvc-${envName}-ECS`, {
  env, envName,
  vpc: network.vpc, ecsSg: network.ecsSg,
  ecsTaskRole: security.ecsTaskRole, ecsExecutionRole: security.ecsExecutionRole,
  ecsLogKey: security.ecsLogKey, ecrKey: security.ecrKey,
  uploadsBucket: storage.uploadsBucket, resultsBucket: storage.resultsBucket,
});
ecsStack.addDependency(security);

const knowledgeStore = new KnowledgeStoreStack(app, `SkillsSvc-${envName}-KnowledgeStore`, {
  env, envName,
  vpc: network.vpc, vpcesg: network.vpcesg,
  opensearchKey:     security.opensearchKey,
  resultsLambdaRole: security.resultsLambdaRole,
  ecsTaskRole:       security.ecsTaskRole,
  queryLambdaRole:   security.queryLambdaRole,
});
knowledgeStore.addDependency(security);

const skillRegistry = new SkillRegistryStack(app, `SkillsSvc-${envName}-SkillRegistry`, {
  env, envName,
  vpc: network.vpc, lambdaSg: network.lambdaSg,
  registryBucketKey: security.registryBucketKey,
  dynamodbKey:       security.dynamodbKey,
  accessLogsBucket:  storage.accessLogsBucket,
});
skillRegistry.addDependency(security);

const batchStack = new BatchStack(app, `SkillsSvc-${envName}-Batch`, {
  env, envName,
  jobsTable:        storage.jobsTable,
  ingestionFn:      lambdaStack.ingestionFn,
  dynamodbKey:      security.dynamodbKey,
});
batchStack.addDependency(lambdaStack);

const mcpStack = new MCPStack(app, `SkillsSvc-${envName}-MCP`, {
  env, envName,
  vpc: network.vpc, lambdaSg: network.lambdaSg,
  lambdaEnvKey:      security.lambdaEnvKey,
  userRole:          security.userRole,
  dynamodbTableName: storage.jobsTable.tableName,
  uploadsBucket:     storage.uploadsBucket.bucketName,
  resultsBucket:     storage.resultsBucket.bucketName,
  uploadsKmsKeyId:   security.uploadsBucketKey.keyArn,
  queryLambdaArn:    lambdaStack.queryFn.functionArn,
  opensearchEndpoint: '',
  jobsTopicArn:      messaging.jobsNotificationTopic.topicArn,
  ecsClusterArn:     ecsStack.cluster.clusterArn,
  skillsTableName:   skillRegistry.skillsTable.tableName,    // Fix 9
  registryBucket:    skillRegistry.registryBucket.bucketName, // Fix 9
});
mcpStack.addDependency(lambdaStack);
mcpStack.addDependency(ecsStack);
mcpStack.addDependency(skillRegistry);

const monitoring = new MonitoringStack(app, `SkillsSvc-${envName}-Monitoring`, {
  env, envName,
  ingestionFn:      lambdaStack.ingestionFn,
  resultsProcessorFn: lambdaStack.resultsProcessorFn,
  ingestionDLQ:     messaging.ingestionDLQ,
  resultsDLQ:       messaging.resultsDLQ,
  alarmTopic:       messaging.jobsNotificationTopic,
});
monitoring.addDependency(batchStack);
monitoring.addDependency(mcpStack);
monitoring.addDependency(skillRegistry);

const compliance = new ComplianceStack(app, `SkillsSvc-${envName}-Compliance`, {
  env, envName,
  auditKey:      security.auditKey,
  uploadsBucket: storage.uploadsBucket,
  resultsBucket: storage.resultsBucket,
});
compliance.addDependency(monitoring);

app.synth();
```

---

## Fix 5: Batch Stack missing from app.ts

Resolved by Fix 4 above. `BatchStack` is now wired in.

---

## Fix 6: Validator Lambda — S3 Resource Policy

**Problem:** `SkillRegistryStack` registers an S3 event notification but never grants S3 permission to invoke the Lambda.

**Add to `infra/lib/skill-registry-stack.ts`** after `this.validatorFn` is declared:

```typescript
// Grant S3 service permission to invoke the validator Lambda
this.validatorFn.addPermission('AllowS3Invoke', {
  principal: new iam.ServicePrincipal('s3.amazonaws.com'),
  action: 'lambda:InvokeFunction',
  sourceArn: this.registryBucket.bucketArn,
  sourceAccount: this.account, // prevent confused deputy attack
});
```

---

## Fix 7: MCPStack Lambda — Missing Environment Variables

**Problem:** MCP tools use `process.env.RESULTS_BUCKET`, `process.env.DYNAMODB_TABLE_NAME`, `process.env.QUERY_LAMBDA_ARN` but `MCPStack` Lambda environment only has `ENV`, `REGION`, `MCP_SERVER_NAME`, `MCP_SERVER_VERSION`.

**Updated `infra/lib/mcp-stack.ts` — Lambda environment block:**

```typescript
const mcpFn = new lambda.Function(this, 'MCPLambda', {
  // ... other props unchanged ...
  environment: {
    NODE_OPTIONS:           '--enable-source-maps',
    ENV:                    envName,
    REGION:                 this.region,
    MCP_SERVER_NAME:        'skills-as-a-service',
    MCP_SERVER_VERSION:     '1.0.0',
    // Variables used by MCP tools directly (not via SSM — performance optimization)
    DYNAMODB_TABLE_NAME:    props.dynamodbTableName,
    RESULTS_BUCKET:         props.resultsBucket,
    UPLOADS_BUCKET:         props.uploadsBucket,
    UPLOADS_KMS_KEY_ID:     props.uploadsKmsKeyId,
    QUERY_LAMBDA_ARN:       props.queryLambdaArn,
    SKILLS_TABLE_NAME:      props.skillsTableName,   // Fix 9
    REGISTRY_BUCKET:        props.registryBucket,    // Fix 9
  },
});
```

**Updated `MCPStackProps`:**

```typescript
interface MCPStackProps extends cdk.StackProps {
  // ... existing fields ...
  skillsTableName: string;   // ADD
  registryBucket:  string;   // ADD
}
```

---

## Fix 8: UserRole Missing Registry Read Permission

**Problem:** The `run` command performs a cross-bucket `CopyObjectCommand` from the registry bucket to the uploads bucket. The CLI user assumes `UserRole`, which in SPEC-01 only has `s3:PutObject` on the uploads bucket — it cannot read from the registry bucket.

**Preferred fix:** Move the copy server-side into a Lambda (`RunSkillLambda`) so the CLI user never needs direct access to the registry bucket. The CLI invokes the Lambda, which does the copy using its own IAM role.

### New Lambda: `RunSkillLambda` (`packages/lambda/src/run-skill/handler.ts`)

```typescript
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';
import { SKILL_KEY_PREFIX, SkillStatus, padSemver } from '@skills-svc/shared';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

export interface RunSkillInput {
  skillName:    string;
  skillVersion: string;  // already resolved (no 'latest')
  jobName:      string;
  userArn:      string;
  promptOverride?: string;
  noCache?:     boolean;
}

export interface RunSkillOutput {
  runId:      string;
  uploadsKey: string;
}

export const handler = async (input: RunSkillInput): Promise<RunSkillOutput> => {
  const env = process.env.ENV ?? 'prod';

  const skillsTableName = process.env.SKILLS_TABLE_NAME!;
  const registryBucket  = process.env.REGISTRY_BUCKET!;
  const uploadsBucket   = process.env.UPLOADS_BUCKET!;
  const uploadsKmsKeyId = process.env.UPLOADS_KMS_KEY_ID!;

  // Verify skill version exists and is published
  const versionRes = await ddb.send(new GetCommand({
    TableName: skillsTableName,
    Key: {
      PK: `${SKILL_KEY_PREFIX.SKILL}${input.skillName}`,
      SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(input.skillVersion)}`,
    },
  }));

  if (!versionRes.Item) throw new Error(`Skill not found: ${input.skillName}@${input.skillVersion}`);
  if (versionRes.Item.status !== SkillStatus.PUBLISHED) {
    throw new Error(`Skill ${input.skillName}@${input.skillVersion} is not published (status: ${versionRes.Item.status})`);
  }

  const registryS3Key = versionRes.Item.s3Key as string;
  const runId         = randomUUID();
  const uploadsKey    = `uploads/${runId}/${input.skillName}-${input.skillVersion}.zip`;

  await s3.send(new CopyObjectCommand({
    Bucket:               uploadsBucket,
    CopySource:           `${registryBucket}/${registryS3Key}`,
    Key:                  uploadsKey,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId:          uploadsKmsKeyId,
    MetadataDirective:    'REPLACE',
    Metadata: {
      'job-name':       input.jobName,
      'user-arn':       input.userArn,
      'skill-name':     input.skillName,
      'skill-version':  input.skillVersion,
      'run-id':         runId,
      ...(input.promptOverride ? { 'prompt-override': input.promptOverride } : {}),
      ...(input.noCache        ? { 'no-cache': 'true' }                      : {}),
    },
  }));

  console.log(JSON.stringify({ event: 'skill_run_triggered', skillName: input.skillName, skillVersion: input.skillVersion, runId }));
  return { runId, uploadsKey };
};
```

### Add `RunSkillLambda` to `LambdaStack`

```typescript
// In LambdaStack constructor:
this.runSkillFn = new lambda.Function(this, 'RunSkillLambda', {
  ...sharedLambdaProps,
  functionName: `skills-svc-run-skill-${this.account}`,
  handler: 'run-skill/handler.handler',
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  reservedConcurrentExecutions: 100,
  role: props.runSkillLambdaRole,  // new role defined in SecurityStack
  description: 'Server-side skill run: resolves skill ref, copies zip to uploads prefix',
  environment: {
    ...sharedLambdaProps.environment,
    SKILLS_TABLE_NAME: '', // populated via SSM at runtime
    REGISTRY_BUCKET:   '',
    UPLOADS_BUCKET:    props.uploadsBucket.bucketName,
    UPLOADS_KMS_KEY_ID: props.uploadsKmsKeyId,
  },
});

// Expose ARN via SSM
new ssm.StringParameter(this, 'ParamRunSkillFnArn', {
  parameterName: `/skills-svc/${envName}/lambda/run-skill-function-arn`,
  stringValue: this.runSkillFn.functionArn,
});
```

### New IAM role `runSkillLambdaRole` in `SecurityStack`

```typescript
this.runSkillLambdaRole = new iam.Role(this, 'RunSkillLambdaRole', {
  roleName: `skills-svc-run-skill-lambda-${envName}`,
  assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
});
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadRegistryBucket',
  actions: ['s3:GetObject'],
  resources: [`arn:aws:s3:::skills-svc-registry-${this.account}-${this.region}/*`],
}));
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'WriteUploadsBucket',
  actions: ['s3:PutObject'],
  resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/uploads/*`],
  conditions: { StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } },
}));
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadSkillsTable',
  actions: ['dynamodb:GetItem'],
  resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-skills-${this.account}-${this.region}`],
}));
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KMSDecrypt',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [this.registryBucketKey.keyArn, this.uploadsBucketKey.keyArn],
}));
this.runSkillLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'CloudWatchLogs',
  actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
  resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/skills-svc-run-skill-*`],
}));
```

### Add `lambda:InvokeFunction` on `runSkillFn` to `UserRole`

```typescript
// In SecurityStack userRole inline policy (replace direct S3 registry access):
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'InvokeRunSkillLambda',
  actions: ['lambda:InvokeFunction'],
  resources: [`arn:aws:lambda:${this.region}:${this.account}:function:skills-svc-run-skill-${this.account}`],
}));
```

### Updated `packages/cli/src/commands/run.ts` — use Lambda instead of direct S3 copy

```typescript
// Replace CopyObjectCommand block with:
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lam = new LambdaClient({ region: cfg.region, credentials: creds });
const runSkillFnArn = await ssm.send(new GetParameterCommand({
  Name: `/skills-svc/${cfg.envName}/lambda/run-skill-function-arn`,
})).then(r => r.Parameter!.Value!);

const invocation = await lam.send(new InvokeCommand({
  FunctionName: runSkillFnArn,
  Payload: JSON.stringify({
    skillName:     name,
    skillVersion:  resolvedVersion,
    jobName:       opts.jobName,
    userArn:       identity.Arn,
    promptOverride: opts.prompt,
    noCache:       !opts.cache,
  } satisfies RunSkillInput),
}));

if (invocation.FunctionError) {
  const err = JSON.parse(Buffer.from(invocation.Payload!).toString());
  console.error(chalk.red(`Run failed: ${err.errorMessage ?? 'Unknown error'}`));
  process.exit(1);
}

const { runId } = JSON.parse(Buffer.from(invocation.Payload!).toString()) as RunSkillOutput;
```

---

## Fix 9: MCP Lambda Missing Registry Access

Resolved by Fix 7 (adds `skillsTableName`, `registryBucket` to env) and Fix 4 (wires props from SkillRegistryStack into MCPStack).

Additionally, add to `mcpLambdaRole` in `infra/lib/mcp-stack.ts`:

```typescript
mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadSkillsTable',
  actions: ['dynamodb:GetItem', 'dynamodb:Query'],
  resources: [
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-skills-${this.account}-${this.region}`,
    `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-skills-${this.account}-${this.region}/index/*`,
  ],
}));
mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
  sid: 'InvokeRunSkillLambda',
  actions: ['lambda:InvokeFunction'],
  resources: [`arn:aws:lambda:${this.region}:${this.account}:function:skills-svc-run-skill-${this.account}`],
}));
```

---

## Fix 10: Authoritative `DDB_KEY_PREFIX`

**Replace all partial definitions with this single source of truth in `packages/shared/src/types.ts`:**

```typescript
export const DDB_KEY_PREFIX = {
  JOB:        'JOB#',
  STATUS:     'STATUS#',
  USER:       'USER#',
  ETAG:       'ETAG#',
  CACHE:      'CACHE#',      // SPEC-08 result caching
  SCHEDULE:   'SCHEDULE#',   // SPEC-07 scheduled jobs
  SKILL:      'SKILL#',      // SPEC-10 skill registry
  TAG:        'TAG#',        // SPEC-10 skill tags
  AUTHOR:     'AUTHOR#',     // SPEC-10 skill author index
  VISIBILITY: 'VISIBILITY#', // SPEC-10 org-shared skills
} as const;
```

---

## Fix 11: Authoritative `CliConfig`

**Replace all partial definitions with this single source of truth in `packages/cli/src/utils/config.ts`:**

```typescript
export interface CliConfig {
  profileName:       string;
  region:            string;
  accountId:         string;
  envName:           string;
  // Storage
  uploadsBucket:     string;
  resultsBucket:     string;
  uploadsKmsKeyId:   string;
  dynamodbTableName: string;
  // Registry (SPEC-10)
  registryBucket:    string;
  skillsTableName:   string;
  registryKmsKeyId:  string;
  // Messaging
  jobsTopicArn:      string;
  // Knowledge store
  opensearchEndpoint: string;
  // Lambda ARNs
  queryLambdaArn:    string;
  runSkillLambdaArn: string;  // Fix 8
  // MCP
  mcpEndpoint:       string;  // SPEC-09
  // Batch
  batchSfnArn:       string;  // SPEC-08
}
```

---

## Fix 12: `@skills-svc/shared` Package Dependencies

**`packages/shared/package.json` — authoritative dependencies:**

```json
{
  "name": "@skills-svc/shared",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "jest" },
  "dependencies": {
    "adm-zip": "^0.5.10",
    "@aws-sdk/client-kms": "^3.600.0"
  },
  "devDependencies": {
    "@types/adm-zip": "^0.5.5",
    "typescript": "^5.4.0"
  }
}
```

---

## Fix 13: `padSemver` Prerelease Collision

**Problem:** `padSemver("1.0.0")` and `padSemver("1.0.0-beta.1")` both produce `"001.000.000"`, causing a DDB SK collision. By semver convention, `1.0.0-beta.1 < 1.0.0` (prerelease sorts before stable).

**Fix:** Stable versions get suffix `.Z`, prerelease get suffix `.A` so stable sorts after prerelease.

```typescript
export function padSemver(version: string): string {
  const [coreStr, prerelease] = version.split('-', 2);
  const [major = 0, minor = 0, patch = 0] = coreStr.split('.').map(Number);
  const core = [major, minor, patch].map(n => String(n).padStart(3, '0')).join('.');
  // Stable (.Z) sorts after any prerelease (.A prefix) in DDB lexicographic order
  return prerelease ? `${core}.A.${prerelease}` : `${core}.Z`;
}

// Examples:
// "1.0.0"        → "001.000.000.Z"
// "1.0.0-beta.1" → "001.000.000.A.beta.1"
// "1.0.0-alpha"  → "001.000.000.A.alpha"
// DDB SK sort:   .A.alpha < .A.beta.1 < .Z  ✓ (prerelease before stable)
```

Update `isHigherVersion` to use the new `padSemver`:

```typescript
export function isHigherVersion(a: string, b: string): boolean {
  return padSemver(a) > padSemver(b);
}
```

---

## Fix 14: `batch list` — Invalid DDB Query

**Problem:** SPEC-08 `batch list` uses `begins_with(PK, :prefix)` in `KeyConditionExpression` — DynamoDB does not support `begins_with` on partition keys.

**Fix:** Add a GSI to `BatchStack`'s `batchTable` to support listing, or use a dedicated `BATCH_LIST` PK:

```typescript
// In BatchStack batchTable definition, add GSI for user-based listing:
batchTable.addGlobalSecondaryIndex({
  indexName: 'GSI1-UserBatches',
  partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING }, // USER#{userArn}
  sortKey:      { name: 'GSI1SK', type: dynamodb.AttributeType.STRING }, // CREATED_AT#{iso}
  projectionType: dynamodb.ProjectionType.ALL,
});
```

**Updated `batch list` command:**

```typescript
// Replace invalid Query with GSI-based query:
const identity = await sts.send(new GetCallerIdentityCommand({}));
const res = await ddb.send(new QueryCommand({
  TableName: batchTableName,
  IndexName: 'GSI1-UserBatches',
  KeyConditionExpression: 'GSI1PK = :user',
  ExpressionAttributeValues: { ':user': `USER#${identity.Arn}` },
  ScanIndexForward: false,
  Limit: parseInt(opts.limit, 10),
}));
```

**Updated `batch run` — write GSI fields to METADATA record:**

```typescript
// Add to METADATA PutCommand Item:
GSI1PK: `USER#${identity.Arn}`,
GSI1SK: `CREATED_AT#${new Date().toISOString()}`,
```

---

## Fix 15: `batch-submit` and `batch-status` Lambda Implementations

### `packages/lambda/src/batch-submit/handler.ts`

```typescript
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface BatchSubmitInput {
  batchId:        string;
  batchJobName:   string;
  skillsS3Bucket: string;
  skillsS3Key:    string;
  userArn:        string;
  useCache:       boolean;
  input:          { s3Key: string; originalFile: string; index: number };
  inputIndex:     number;
}

interface BatchSubmitOutput {
  jobId:  string;
  batchId: string;
}

export const handler = async (event: BatchSubmitInput): Promise<BatchSubmitOutput> => {
  const uploadsBucket   = process.env.UPLOADS_BUCKET!;
  const uploadsKmsKeyId = process.env.UPLOADS_KMS_KEY_ID!;
  const batchTableName  = process.env.BATCH_TABLE_NAME!;
  const jobsTableName   = process.env.DYNAMODB_TABLE_NAME!;

  const jobId   = randomUUID();
  const runId   = randomUUID();
  const destKey = `uploads/batch/${event.batchId}/runs/${runId}/skills.zip`;
  const now     = new Date().toISOString();

  // Copy skills zip + attach input file reference in metadata
  await s3.send(new CopyObjectCommand({
    Bucket:               uploadsBucket,
    CopySource:           `${event.skillsS3Bucket}/${event.skillsS3Key}`,
    Key:                  destKey,
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId:          uploadsKmsKeyId,
    MetadataDirective:    'REPLACE',
    Metadata: {
      'job-name':       `${event.batchJobName}-${event.inputIndex}`,
      'user-arn':       event.userArn,
      'batch-id':       event.batchId,
      'batch-input-key': event.input.s3Key,
      'run-id':         runId,
      ...(event.useCache ? {} : { 'no-cache': 'true' }),
    },
  }));

  // Write batch job record
  await ddb.send(new PutCommand({
    TableName: batchTableName,
    Item: {
      PK:          `BATCH#${event.batchId}`,
      SK:          `JOB#${jobId}`,
      jobId,
      inputFile:   event.input.originalFile,
      inputIndex:  event.inputIndex,
      status:      'PENDING',
      createdAt:   now,
    },
    ConditionExpression: 'attribute_not_exists(SK)',
  }));

  // Increment submitted count on METADATA
  await ddb.send(new UpdateCommand({
    TableName: batchTableName,
    Key: { PK: `BATCH#${event.batchId}`, SK: 'METADATA' },
    UpdateExpression: 'ADD submittedJobs :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));

  return { jobId, batchId: event.batchId };
};
```

### `packages/lambda/src/batch-status/handler.ts`

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface BatchStatusInput {
  jobId:   string;
  batchId: string;
}

interface BatchStatusOutput {
  jobId:   string;
  batchId: string;
  status:  string;
}

export const handler = async (event: BatchStatusInput): Promise<BatchStatusOutput> => {
  const jobsTableName  = process.env.DYNAMODB_TABLE_NAME!;
  const batchTableName = process.env.BATCH_TABLE_NAME!;

  const res = await ddb.send(new GetCommand({
    TableName: jobsTableName,
    Key: { PK: `${DDB_KEY_PREFIX.JOB}${event.jobId}`, SK: 'METADATA' },
  }));

  const status = (res.Item?.status as string | undefined) ?? 'PENDING';

  // Update batch job record when terminal
  if (status === JobStatus.COMPLETE || status === JobStatus.FAILED) {
    const now = new Date().toISOString();
    await ddb.send(new UpdateCommand({
      TableName: batchTableName,
      Key: { PK: `BATCH#${event.batchId}`, SK: `JOB#${event.jobId}` },
      UpdateExpression: 'SET #status = :status, completedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status, ':now': now },
    }));

    const countField = status === JobStatus.COMPLETE ? 'completedJobs' : 'failedJobs';
    await ddb.send(new UpdateCommand({
      TableName: batchTableName,
      Key: { PK: `BATCH#${event.batchId}`, SK: 'METADATA' },
      UpdateExpression: `ADD ${countField} :one`,
      ExpressionAttributeValues: { ':one': 1 },
    }));
  }

  return { jobId: event.jobId, batchId: event.batchId, status };
};
```

---

## Fix 16: `run` Command Job-ID Polling — Use `runId`

**Problem:** `run.ts` polls DDB via GSI2 and checks `candidate?.skillName === name`, but `skillName` is only written after the ingestion Lambda processes the S3 event asynchronously. The poll can match a different job.

**Fix:** Use `runId` (set in S3 metadata and stored in DDB) as the unique correlation key.

```typescript
// In ingestion Lambda — add runId to DDB job record:
const runId = head.Metadata?.['run-id'];
// Add to PutCommand Item:
runId: runId ?? null,
```

**Updated `run.ts` polling loop:**

```typescript
// Poll DDB for job with matching runId
let jobId: string | undefined;
const pollStart = Date.now();
while (!jobId && Date.now() - pollStart < 30_000) {
  await new Promise(r => setTimeout(r, 2_000));
  const res = await ddb.send(new QueryCommand({
    TableName: cfg.dynamodbTableName,
    IndexName: 'GSI2-User',
    KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK >= :since',
    ExpressionAttributeValues: {
      ':pk':    `${DDB_KEY_PREFIX.USER}${identity.Arn}`,
      ':since': `CREATED_AT#${new Date(Date.now() - 60_000).toISOString()}`,
    },
    ScanIndexForward: false,
    Limit: 5,
  }));
  // Match by runId stored in DDB (set by ingestion Lambda from S3 metadata)
  const match = res.Items?.find(item => item.runId === runId);
  if (match) jobId = match.jobId as string;
}
```

---

## Fix 17: Authoritative `configure` Command

```typescript
// packages/cli/src/commands/configure.ts
import { Command } from 'commander';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { saveConfig, setDefaultProfileName, CliConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';

export function configureCommand(): Command {
  return new Command('configure')
    .description('Configure the CLI by auto-discovering stack outputs from SSM')
    .requiredOption('--region <region>', 'AWS region (e.g. us-east-1)')
    .requiredOption('--account <id>', 'AWS account ID')
    .option('--env <name>', 'Environment name (e.g. prod, staging)', 'prod')
    .option('--profile <name>', 'Profile name to write config to', 'default')
    .action(async (opts: { region: string; account: string; env: string; profile: string }) => {
      const creds = await getCredentialProvider();
      const ssm   = new SSMClient({ region: opts.region, credentials: creds });

      console.log(chalk.blue(`Discovering configuration for env="${opts.env}" in ${opts.region}...`));

      // Bulk-fetch all SSM params for this env
      const params: Record<string, string> = {};
      let nextToken: string | undefined;
      do {
        const res = await ssm.send(new GetParametersByPathCommand({
          Path:           `/skills-svc/${opts.env}/`,
          Recursive:      true,
          WithDecryption: false,
          NextToken:      nextToken,
        }));
        (res.Parameters ?? []).forEach(p => {
          const key = p.Name!.replace(`/skills-svc/${opts.env}/`, '');
          params[key] = p.Value!;
        });
        nextToken = res.NextToken;
      } while (nextToken);

      const get = (key: string, fallback = '') => params[key] ?? fallback;

      const cfg: CliConfig = {
        profileName:       opts.profile,
        region:            opts.region,
        accountId:         opts.account,
        envName:           opts.env,
        uploadsBucket:     get('s3/uploads-bucket'),
        resultsBucket:     get('s3/results-bucket'),
        uploadsKmsKeyId:   get('kms/uploads-key-id'),
        dynamodbTableName: get('dynamodb/table-name'),
        registryBucket:    get('registry/bucket-name'),
        skillsTableName:   get('registry/skills-table-name'),
        registryKmsKeyId:  get('registry/kms-key-id'),
        jobsTopicArn:      get('sns/jobs-topic-arn'),
        opensearchEndpoint: get('opensearch/endpoint'),
        queryLambdaArn:    get('lambda/query-function-arn'),
        runSkillLambdaArn: get('lambda/run-skill-function-arn'),
        mcpEndpoint:       get('mcp/endpoint'),
        batchSfnArn:       get('sfn/batch-arn'),
      };

      const missing = Object.entries(cfg)
        .filter(([k, v]) => !v && !['mcpEndpoint', 'batchSfnArn'].includes(k))
        .map(([k]) => k);

      if (missing.length > 0) {
        console.warn(chalk.yellow(`⚠  Some parameters not found in SSM: ${missing.join(', ')}`));
        console.warn(chalk.dim('   Ensure all CDK stacks are deployed before running configure.'));
      }

      saveConfig(cfg);
      setDefaultProfileName(opts.profile);
      console.log(chalk.green(`✓ Profile "${opts.profile}" configured (${Object.keys(params).length} parameters discovered)`));
    });
}
```

---

## Fix 18: `skill list` Default Behaviour

**Problem:** When neither `--mine`, `--org`, nor `--tag` is set and no org-visible skills exist, user sees an unhelpful empty state.

**Fix:** Default to `--mine` first, fall back to org if no personal skills found.

```typescript
// In skill list action — replace default branch:
} else {
  // Default: try user's own skills first
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const mine = await ddb.send(new QueryCommand({
    TableName: skillsTableName,
    IndexName: 'GSI1-Author',
    KeyConditionExpression: 'GSI1PK = :author',
    ExpressionAttributeValues: { ':author': `${SKILL_KEY_PREFIX.AUTHOR}${identity.Arn}` },
    ScanIndexForward: false, Limit: limit,
  }));
  items = mine.Items ?? [];

  if (!items.length) {
    // Fall back to org-visible
    const org = await ddb.send(new QueryCommand({
      TableName: skillsTableName,
      IndexName: 'GSI2-OrgSkills',
      KeyConditionExpression: 'GSI2PK = :vis',
      ExpressionAttributeValues: { ':vis': `${SKILL_KEY_PREFIX.VISIBILITY}org` },
      ScanIndexForward: false, Limit: limit,
    }));
    items = org.Items ?? [];
    if (items.length) console.log(chalk.dim('Showing org-shared skills (you have no personal skills yet).\n'));
  }
}
```

---

## Fix 19: `notify subscribe --webhook` Confirmation

**Problem:** SNS HTTPS subscriptions require the endpoint to respond to a `SubscriptionConfirmation` POST from SNS before delivery begins. Not documented.

**Add to `notify subscribe` output when `--webhook` is used:**

```typescript
if (opts.webhook) {
  console.log(chalk.green(`✓ Webhook subscription initiated: ${opts.webhook}`));
  console.log(chalk.yellow('\n  ⚠  Action required: SNS will POST a SubscriptionConfirmation to your webhook.'));
  console.log('  Your endpoint must respond with HTTP 200 and call the ConfirmationURL in the request body.');
  console.log('  Until confirmed, no notifications will be delivered.');
  console.log(chalk.dim('\n  Example handler (Express):'));
  console.log(chalk.dim(`
  app.post('/webhook', async (req, res) => {
    const body = JSON.parse(req.body);
    if (body.Type === 'SubscriptionConfirmation') {
      await fetch(body.SubscribeURL); // confirm subscription
    }
    res.sendStatus(200);
  });`));
}
```

---

## Fix 20: `adm-zip` Missing from CLI `package.json`

**Problem:** `skill.ts` and `validate.ts` use `adm-zip` but it's only in `packages/shared/package.json` now. The CLI gets it transitively but that's an implicit dependency.

**Add to `packages/cli/package.json`:**

```json
{
  "dependencies": {
    "adm-zip": "^0.5.10",
    "@types/adm-zip": "^0.5.5"
  }
}
```

---

## Fix 21: `run.ts` Inline `require()` Replaced

**Problem:** SPEC-10 `run.ts` uses `const { DynamoDBDocumentClient: DDC, QueryCommand } = require('@aws-sdk/lib-dynamodb')` inline in the action handler — sloppy and bypasses TypeScript type checking.

**Fix:** Move all imports to top of file (standard pattern used throughout all other commands):

```typescript
// At top of packages/cli/src/commands/run.ts — replace inline require with:
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { RunSkillInput, RunSkillOutput } from '@skills-svc/lambda/run-skill/handler';
```

---

## Fix 22: `envelopeDecrypt` in CLI `diff.ts` — KMS Credentials

**Problem:** `envelopeDecrypt` calls KMS. The CLI user has assumed the `UserRole` which does NOT have `kms:Decrypt` for the results bucket key. `diff` would fail silently.

**Fix:** Add `kms:Decrypt` for the results key to `UserRole`:

```typescript
// Add to UserRole inline policy in SecurityStack:
this.userRole.addToPolicy(new iam.PolicyStatement({
  sid: 'DecryptResultsForDiff',
  actions: ['kms:Decrypt'],
  resources: [this.resultsBucketKey.keyArn],
  conditions: {
    StringEquals: {
      'kms:ViaService': `s3.${this.region}.amazonaws.com`,
      'kms:CallerAccount': this.account,
    },
  },
}));
```

---

## Fix 23: QA-130 — Test Actual Clamp Utility

**Problem:** QA-130 tests the arithmetic inline rather than the actual `batch run` clamp logic.

**Fix — extract clamp to shared utility and test it:**

```typescript
// packages/shared/src/utils.ts
export function clampConcurrency(n: number): number {
  return Math.min(Math.max(n, 1), 50);
}

// Updated QA-130:
test('QA-130: clampConcurrency enforces [1, 50] bounds', () => {
  expect(clampConcurrency(-5)).toBe(1);
  expect(clampConcurrency(0)).toBe(1);
  expect(clampConcurrency(1)).toBe(1);
  expect(clampConcurrency(25)).toBe(25);
  expect(clampConcurrency(50)).toBe(50);
  expect(clampConcurrency(51)).toBe(50);
  expect(clampConcurrency(1000)).toBe(50);
});
```

---

## Fix 24: MCP `submit_job` with `skill_ref` — SSM Access

**Problem:** SPEC-10 adds `skill_ref` support to `submit_job` MCP tool, but the tool resolves the skill via DDB/S3 copy — that logic now lives in `RunSkillLambda` (Fix 8). The MCP tool should invoke `RunSkillLambda` rather than duplicating the resolution logic.

**Updated `submit_job` execute() for `skill_ref` path:**

```typescript
if (args.skill_ref && !args.zip_base64) {
  const { name, version: reqVersion } = parseSkillRef(args.skill_ref as string);
  const skillsTableName = process.env.SKILLS_TABLE_NAME!;
  const runSkillFnArn   = process.env.RUN_SKILL_LAMBDA_ARN!;

  // Resolve latest if needed
  let resolvedVersion = reqVersion;
  if (!resolvedVersion || resolvedVersion === 'latest') {
    const meta = await ddb.send(new GetCommand({
      TableName: skillsTableName,
      Key: { PK: `SKILL#${name}`, SK: 'META' },
    }));
    if (!meta.Item) throw new Error(`Skill not found: ${name}`);
    resolvedVersion = meta.Item.latestStable ?? meta.Item.latestVersion;
  }

  const invocation = await lambdaClient.send(new InvokeCommand({
    FunctionName: runSkillFnArn,
    Payload: JSON.stringify({
      skillName:    name,
      skillVersion: resolvedVersion,
      jobName:      `mcp-${name}-${Date.now()}`,
      userArn:      callerArn,
    } satisfies RunSkillInput),
  }));

  if (invocation.FunctionError) throw new Error('RunSkill invocation failed');
  return [{ type: 'text', text: `✅ Run submitted: ${name}@${resolvedVersion}\n\nUse job_status or list_jobs to track.` }];
}
```

Add `RUN_SKILL_LAMBDA_ARN` to MCPStack Lambda environment (alongside Fix 7):

```typescript
RUN_SKILL_LAMBDA_ARN: lambdaStack.runSkillFn.functionArn, // add to MCPStack env
```

---

## Fix 25: `run` Command — Already Fixed by Fix 8

The original concern was the CLI doing a cross-bucket S3 copy with `UserRole` credentials. Fix 8 moves this server-side into `RunSkillLambda`. The `UserRole` never touches the registry bucket. Resolved.

---

## Consolidated New File List

```
packages/shared/src/
├── validator.ts        MOVED from packages/lambda/src/ingestion/validator.ts
├── crypto.ts           CONFIRMED in packages/shared (from SPEC-06)
├── utils.ts            NEW — clampConcurrency and other shared utilities
└── index.ts            UPDATED — exports validator, crypto, utils

packages/lambda/src/
├── ingestion/
│   └── validator.ts    UPDATED — re-export shim from @skills-svc/shared
├── run-skill/
│   └── handler.ts      NEW — server-side skill run (cross-bucket copy)
├── batch-submit/
│   └── handler.ts      NEW — Step Functions map state: submit one job
└── batch-status/
    └── handler.ts      NEW — Step Functions wait: check job completion

infra/lib/
├── security-stack.ts   UPDATED — add registryBucketKey, runSkillLambdaRole
├── storage-stack.ts    UPDATED — add GSI3, GSI4, GSI5
├── lambda-stack.ts     UPDATED — add RunSkillLambda
└── batch-stack.ts      UPDATED — add GSI1 to batchTable
infra/bin/app.ts        REPLACED — authoritative version with all stacks

packages/cli/src/
├── commands/
│   ├── configure.ts    REPLACED — auto-discovers all SSM params
│   └── run.ts          UPDATED — uses RunSkillLambda, runId polling
└── utils/
    └── config.ts       REPLACED — authoritative CliConfig
```

---

## QA Checks (QA-161 through QA-170)

```typescript
// QA-161: validateZipStructure is importable from @skills-svc/shared
test('QA-161: validateZipStructure exports from shared package', () => {
  const { validateZipStructure } = require('@skills-svc/shared');
  expect(typeof validateZipStructure).toBe('function');
});

// QA-162: StorageStack has exactly 5 GSIs on jobs table
test('QA-162: JobsTable has exactly 5 GSIs', () => {
  const { templates } = buildTestApp();
  const tables = templates.storage.findResources('AWS::DynamoDB::Table');
  const jobsTable = Object.values(tables).find((t: any) =>
    JSON.stringify(t).includes('GSI1-Status')
  ) as any;
  expect(jobsTable.Properties.GlobalSecondaryIndexes).toHaveLength(5);
  const names = jobsTable.Properties.GlobalSecondaryIndexes.map((g: any) => g.IndexName);
  expect(names).toContain('GSI1-Status');
  expect(names).toContain('GSI2-User');
  expect(names).toContain('GSI3-Schedule');
  expect(names).toContain('GSI4-CacheKey');
  expect(names).toContain('GSI5-Skill');
});

// QA-163: SecurityStack has exactly 10 KMS keys
test('QA-163: SecurityStack creates exactly 10 KMS keys', () => {
  const { templates } = buildTestApp();
  const keys = templates.security.findResources('AWS::KMS::Key');
  expect(Object.keys(keys)).toHaveLength(10);
});

// QA-164: padSemver stable > prerelease (no collision)
test('QA-164: padSemver correctly orders stable above prerelease', () => {
  expect(padSemver('1.0.0')).toContain('.Z');
  expect(padSemver('1.0.0-beta.1')).toContain('.A.');
  expect(padSemver('1.0.0') > padSemver('1.0.0-beta.1')).toBe(true); // stable after prerelease
  expect(padSemver('1.0.0') === padSemver('1.0.0-beta.1')).toBe(false); // no collision
});

// QA-165: RunSkillLambda is in LambdaStack
test('QA-165: LambdaStack contains RunSkillLambda function', () => {
  const { templates } = buildTestApp();
  const fns = templates.lambda.findResources('AWS::Lambda::Function');
  const runFn = Object.values(fns).find((fn: any) =>
    JSON.stringify(fn).includes('run-skill')
  );
  expect(runFn).toBeDefined();
});

// QA-166: RunSkillLambda role has s3:GetObject on registry, s3:PutObject on uploads
test('QA-166: runSkillLambdaRole has correct S3 permissions', () => {
  const { templates } = buildTestApp();
  const roles = templates.security.findResources('AWS::IAM::Role');
  const runRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('run-skill-lambda')
  ) as any;
  expect(runRole).toBeDefined();
  const stmts = runRole.Properties.Policies?.flatMap((p: any) => p.PolicyDocument.Statement) ?? [];
  const readRegistry = stmts.find((s: any) => s.Sid === 'ReadRegistryBucket');
  const writeUploads = stmts.find((s: any) => s.Sid === 'WriteUploadsBucket');
  expect(readRegistry?.Action).toContain('s3:GetObject');
  expect(writeUploads?.Action).toContain('s3:PutObject');
});

// QA-167: Validator Lambda has S3 resource policy (invoke permission)
test('QA-167: SkillValidatorLambda has S3 invoke permission', () => {
  const { templates } = buildTestApp();
  templates.skillRegistry.hasResourceProperties('AWS::Lambda::Permission', {
    Principal: 's3.amazonaws.com',
    Action: 'lambda:InvokeFunction',
  });
});

// QA-168: MCPStack Lambda env has all required vars
test('QA-168: MCP Lambda environment has all required variables', () => {
  const { templates } = buildTestApp();
  const fns = templates.mcp.findResources('AWS::Lambda::Function');
  const mcpFn = Object.values(fns).find((fn: any) =>
    JSON.stringify(fn).includes('skills-svc-mcp')
  ) as any;
  const env = mcpFn.Properties.Environment.Variables;
  expect(env.DYNAMODB_TABLE_NAME).toBeDefined();
  expect(env.RESULTS_BUCKET).toBeDefined();
  expect(env.QUERY_LAMBDA_ARN).toBeDefined();
  expect(env.SKILLS_TABLE_NAME).toBeDefined();
  expect(env.REGISTRY_BUCKET).toBeDefined();
  expect(env.RUN_SKILL_LAMBDA_ARN).toBeDefined();
});

// QA-169: clampConcurrency covers all boundary cases
test('QA-169: clampConcurrency enforces [1, 50] including boundaries', () => {
  const { clampConcurrency } = require('@skills-svc/shared/utils');
  expect(clampConcurrency(0)).toBe(1);
  expect(clampConcurrency(1)).toBe(1);
  expect(clampConcurrency(50)).toBe(50);
  expect(clampConcurrency(51)).toBe(50);
  expect(clampConcurrency(-100)).toBe(1);
  expect(clampConcurrency(Infinity)).toBe(50);
});

// QA-170: configure command bulk-fetches SSM params via GetParametersByPath
test('QA-170: configure uses GetParametersByPath (not individual GetParameter calls)', async () => {
  const ssmMock = mockClient(SSMClient);
  ssmMock.on(GetParametersByPathCommand).resolves({
    Parameters: [
      { Name: '/skills-svc/prod/s3/uploads-bucket', Value: 'test-bucket' },
      { Name: '/skills-svc/prod/dynamodb/table-name', Value: 'test-table' },
    ],
  });
  await runConfigure({ region: 'us-east-1', account: '123', env: 'prod', profile: 'test' });
  expect(ssmMock.commandCalls(GetParametersByPathCommand)).toHaveLength(1);
  // Must NOT use individual GetParameter calls
  const { GetParameterCommand } = require('@aws-sdk/client-ssm');
  expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
});
```

---

## Summary

| Fix | Impact | Effort |
|-----|--------|--------|
| 1 — validator to shared | Unblocks CLI zip validation | Low |
| 2 — 5-GSI StorageStack | Single authoritative definition | Low |
| 3 — 10 KMS keys | Single authoritative definition | Low |
| 4 — authoritative app.ts | All stacks wired | Low |
| 5 — BatchStack in app.ts | Batch feature deployable | Low |
| 6 — Validator S3 permission | Skill push actually works | Low |
| 7 — MCP Lambda env vars | MCP tools work end-to-end | Low |
| 8 — Server-side skill run | Security: CLI never reads registry | High |
| 9 — MCP registry access | MCP skill_ref works | Low |
| 10 — DDB_KEY_PREFIX | No more key collisions | Low |
| 11 — CliConfig | configure writes all fields | Low |
| 12 — shared pkg.json | shared package builds | Low |
| 13 — padSemver collision | Correct semver ordering | Medium |
| 14 — batch list GSI | batch list returns results | Medium |
| 15 — batch handlers | batch pipeline works | High |
| 16 — runId polling | run --stream finds correct job | Medium |
| 17 — configure command | one-command setup | Medium |
| 18 — skill list default | good empty state | Low |
| 19 — webhook confirmation | users know what to do | Low |
| 20 — adm-zip in CLI | CLI package builds | Low |
| 21 — inline require | type safety | Low |
| 22 — KMS for diff | diff command works | Low |
| 23 — QA-130 | tests real code | Low |
| 24 — MCP skill_ref | MCP uses RunSkillLambda | Low |
| 25 — cross-bucket CLI | resolved by Fix 8 | — |
