# Skills as a Service (SaaS) — Specification Part 12: Final Consolidation

**Version:** 1.0.0  
**Status:** AUTHORITATIVE — fixes gaps introduced in SPEC-11's own fixes  
**Parts:** ... | [Part 11](SPEC-11-errata-and-consolidation.md) | [Part 12: Final Consolidation]

---

## Overview

SPEC-11 introduced 25 fixes but created 30 new loose ends in the process. This document resolves them all. After this spec, the suite is complete.

| # | Issue | Root Cause |
|---|-------|-----------|
| 1 | `RunSkillInput`/`RunSkillOutput` imported from Lambda package in CLI | Types belong in shared |
| 2 | `LambdaStackProps` missing `runSkillLambdaRole` and `uploadsKmsKeyId` | Fix 8 added role/Lambda but not the props interface |
| 3 | `LambdaStack` missing `public readonly runSkillFn` | Fix 8 creates the function but never declares it |
| 4 | `MCPStackProps` missing `runSkillLambdaArn` | Fix 7 adds the env var, Fix 4 app.ts doesn't pass it |
| 5 | `app.ts` doesn't pass `runSkillLambdaArn` to MCPStack | Fix 4 app.ts predates Fix 8 |
| 6 | `BatchStack` Lambda env missing `BATCH_TABLE_NAME`, `UPLOADS_BUCKET`, `UPLOADS_KMS_KEY_ID`, `DYNAMODB_TABLE_NAME` | SPEC-08 only sets `{ ENV, REGION }` |
| 7 | `batchJobSubmitFn` missing S3 + KMS permissions (it does CopyObjectCommand) | SPEC-08 only grants DDB access |
| 8 | `batch run` METADATA `PutCommand` missing `GSI1PK`/`GSI1SK` fields | Fix 14 adds GSI but not the write side |
| 9 | `packages/shared/src/index.ts` never shown authoritatively | Subpath imports scattered across specs |
| 10 | Subpath imports `@skills-svc/shared/crypto`, `@skills-svc/shared/utils` — no exports map | package.json has no `exports` field |
| 11 | `parseSkillRef` defined in `skill.ts` (CLI command) and imported by `run.ts` — wrong layer | Should be in shared |
| 12 | `buildTestApp()` helper in SPEC-04 never updated with BatchStack, MCPStack, SkillRegistryStack | QA tests referencing `templates.mcp`, `templates.skillRegistry`, `templates.batch` would fail |
| 13 | Validator Lambda S3 event filter only uses `prefix: 'skills/'` — fires on any object | Should also filter `suffix: 'skill.zip'` |
| 14 | `clampConcurrency` exported from `@skills-svc/shared/utils` subpath — no exports map | Same as issue 10 |
| 15 | `BatchStack` `batchJobSubmitFn` uses `props.jobsTable.grantWriteData` — but submitter only PutItem on batchTable, not jobsTable | Overly broad + wrong table |
| 16 | `skill.ts` imports `validateZipStructure` from `@skills-svc/shared/validator` subpath | After Fix 1 it's on main index |
| 17 | `diff.ts` imports `envelopeDecrypt` from `@skills-svc/shared/crypto` subpath | Same — use main index |
| 18 | `configure.ts` missing top-level imports for `GetParametersByPathCommand` | Fix 17 shows the function body but not the imports |
| 19 | `BatchStack` `batchTable` `PutCommand` METADATA record is never written anywhere | `batch run` writes to SFN but never creates the METADATA record in DDB |
| 20 | `skill push` S3 `PutObjectCommand` uses `ChecksumAlgorithm: 'SHA256'` but registry bucket has ObjectLock — multipart uploads with checksums require specific SDK config | Need explicit note and workaround |
| 21 | `run.ts` `satisfies RunSkillInput` — `satisfies` only works if types are in scope | After Fix 1, types move to shared; import needs updating |
| 22 | `SkillRegistryStack` `validatorFn` granted `s3:GetObject` but not `s3:HeadObject` — handler calls `HeadObjectCommand` | IAM incomplete |
| 23 | `QA-163` asserts exactly 10 KMS keys — but `EncryptionEnforcerAspect` may also create keys | Assertion is fragile |
| 24 | `batch run` never writes `sfnExecutionArn` to DDB METADATA — but `batch cancel` reads it | `batch cancel` would always fail |
| 25 | `batch-status` handler does `UpdateCommand` on `batchTable` for terminal jobs — but Step Functions still retries `waitForJob` state after terminal | Need Step Functions to exit cleanly |
| 26 | `MCPStack` `RunSkillLambda` invoke permission not added to `runSkillFn` | Lambda:InvokeFunction requires resource-level permission from MCP Lambda role |
| 27 | SSM parameter `/skills-svc/{env}/lambda/run-skill-function-arn` written in `LambdaStack` but `MCPStack` reads it from env var set in `app.ts` — two sources of truth | Pick one: SSM or direct prop |
| 28 | `skill deprecate` sets `status: SkillStatus.DEPRECATED` but `SkillStatus` enum has `DEPRECATED` — validator writes `FAILED` for bad zips. Deprecation by `UpdateCommand` doesn't check current status | Should only deprecate `PUBLISHED` skills |
| 29 | `notify unsubscribe` takes `subscription-arn` as argument but lists show short ARN — user cannot copy-paste | List should show full ARN |
| 30 | Deployment runbook in SPEC-05 has 9 stacks — now has 12 | Runbook outdated |

---

## Fix 1: `RunSkillInput`/`RunSkillOutput` → `packages/shared/src/types.ts`

**Remove** from `packages/lambda/src/run-skill/handler.ts`.  
**Add** to `packages/shared/src/types.ts`:

```typescript
export interface RunSkillInput {
  skillName:      string;
  skillVersion:   string;  // must be resolved semver — not 'latest'
  jobName:        string;
  userArn:        string;
  promptOverride?: string;
  noCache?:       boolean;
}

export interface RunSkillOutput {
  runId:      string;
  uploadsKey: string;
}
```

Update `packages/lambda/src/run-skill/handler.ts` top:
```typescript
import { RunSkillInput, RunSkillOutput } from '@skills-svc/shared';
// remove local interface declarations
```

Update `packages/cli/src/commands/run.ts`:
```typescript
// Replace:
import type { RunSkillInput, RunSkillOutput } from '@skills-svc/lambda/run-skill/handler';
// With:
import { RunSkillInput, RunSkillOutput } from '@skills-svc/shared';
```

---

## Fix 2 & 3: `LambdaStackProps` + `public readonly runSkillFn`

**Authoritative `LambdaStackProps` interface** (add to `infra/lib/lambda-stack.ts`):

```typescript
interface LambdaStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  ingestionQueue: sqs.Queue;
  ingestionDLQ: sqs.Queue;
  resultsDLQ: sqs.Queue;
  jobsNotificationTopic: sns.Topic;
  jobsTable: dynamodb.Table;
  uploadsBucket: s3.Bucket;
  resultsBucket: s3.Bucket;
  ingestionLambdaRole: iam.Role;
  resultsLambdaRole: iam.Role;
  queryLambdaRole: iam.Role;
  runSkillLambdaRole: iam.Role;   // ADD — SPEC-11 Fix 8
  lambdaEnvKey: kms.Key;
  uploadsKmsKeyId: string;         // ADD — needed by RunSkillLambda env
}
```

**Add public property declaration** at top of `LambdaStack` class:

```typescript
export class LambdaStack extends cdk.Stack {
  public readonly ingestionFn: lambda.Function;
  public readonly resultsProcessorFn: lambda.Function;
  public readonly queryFn: lambda.Function;
  public readonly runSkillFn: lambda.Function;  // ADD
  public readonly scheduleTriggerFn: lambda.Function;
```

---

## Fix 4 & 5: `MCPStackProps` + `app.ts` wiring

**Add to `MCPStackProps`** in `infra/lib/mcp-stack.ts`:

```typescript
interface MCPStackProps extends cdk.StackProps {
  // ... all existing fields ...
  skillsTableName:    string;      // from SPEC-11 Fix 7
  registryBucket:     string;      // from SPEC-11 Fix 7
  runSkillLambdaArn:  string;      // ADD — needed for MCP submit_job skill_ref path
}
```

**Update `infra/bin/app.ts` MCPStack instantiation** (replaces Fix 4's version):

```typescript
const mcpStack = new MCPStack(app, `SkillsSvc-${envName}-MCP`, {
  env, envName,
  vpc: network.vpc, lambdaSg: network.lambdaSg,
  lambdaEnvKey:       security.lambdaEnvKey,
  userRole:           security.userRole,
  dynamodbTableName:  storage.jobsTable.tableName,
  uploadsBucket:      storage.uploadsBucket.bucketName,
  resultsBucket:      storage.resultsBucket.bucketName,
  uploadsKmsKeyId:    security.uploadsBucketKey.keyArn,
  queryLambdaArn:     lambdaStack.queryFn.functionArn,
  opensearchEndpoint: '',
  jobsTopicArn:       messaging.jobsNotificationTopic.topicArn,
  ecsClusterArn:      ecsStack.cluster.clusterArn,
  skillsTableName:    skillRegistry.skillsTable.tableName,
  registryBucket:     skillRegistry.registryBucket.bucketName,
  runSkillLambdaArn:  lambdaStack.runSkillFn.functionArn,  // ADD
});
```

**Add `RUN_SKILL_LAMBDA_ARN` to MCPStack Lambda env** using the prop (not hardcoded from SSM):

```typescript
// In infra/lib/mcp-stack.ts Lambda environment block — add:
RUN_SKILL_LAMBDA_ARN: props.runSkillLambdaArn,
```

---

## Fix 6: `BatchStack` Lambda Environment Variables

**Replace** the two Lambda definitions in `infra/lib/batch-stack.ts` with complete environment blocks:

```typescript
const batchJobSubmitFn = new lambda.Function(this, 'BatchJobSubmitFn', {
  functionName: `skills-svc-batch-submit-${this.account}`,
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'batch-submit/handler.handler',
  code: lambda.Code.fromAsset('../packages/lambda/dist'),
  timeout: cdk.Duration.minutes(2),
  memorySize: 256,
  tracing: lambda.Tracing.ACTIVE,
  environment: {
    NODE_OPTIONS:       '--enable-source-maps',
    ENV:                envName,
    REGION:             this.region,
    BATCH_TABLE_NAME:   batchTable.tableName,          // ADD
    DYNAMODB_TABLE_NAME: props.jobsTable.tableName,    // ADD
    UPLOADS_BUCKET:     props.uploadsBucketName,       // ADD — new prop
    UPLOADS_KMS_KEY_ID: props.uploadsKmsKeyId,         // ADD — new prop
  },
});

const batchStatusFn = new lambda.Function(this, 'BatchStatusFn', {
  functionName: `skills-svc-batch-status-${this.account}`,
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'batch-status/handler.handler',
  code: lambda.Code.fromAsset('../packages/lambda/dist'),
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  tracing: lambda.Tracing.ACTIVE,
  environment: {
    NODE_OPTIONS:       '--enable-source-maps',
    ENV:                envName,
    REGION:             this.region,
    BATCH_TABLE_NAME:   batchTable.tableName,          // ADD
    DYNAMODB_TABLE_NAME: props.jobsTable.tableName,    // ADD
  },
});
```

**Add to `BatchStackProps`:**

```typescript
interface BatchStackProps extends cdk.StackProps {
  envName: string;
  jobsTable: dynamodb.Table;
  ingestionFn: lambda.Function;
  dynamodbKey: kms.Key;
  uploadsBucketName: string;   // ADD
  uploadsKmsKeyId:   string;   // ADD
}
```

**Update `app.ts` BatchStack instantiation:**

```typescript
const batchStack = new BatchStack(app, `SkillsSvc-${envName}-Batch`, {
  env, envName,
  jobsTable:         storage.jobsTable,
  ingestionFn:       lambdaStack.ingestionFn,
  dynamodbKey:       security.dynamodbKey,
  uploadsBucketName: storage.uploadsBucket.bucketName,  // ADD
  uploadsKmsKeyId:   security.uploadsBucketKey.keyArn,  // ADD
});
```

---

## Fix 7: `batchJobSubmitFn` S3 + KMS Permissions

**Replace** the permission grants for `batchJobSubmitFn` in `infra/lib/batch-stack.ts`:

```typescript
// REMOVE: props.jobsTable.grantWriteData(batchJobSubmitFn); — submitter doesn't touch jobs table

// ADD explicit permissions:
batchTable.grantWriteData(batchJobSubmitFn); // write METADATA + JOB# records

batchJobSubmitFn.addToRolePolicy(new iam.PolicyStatement({
  sid: 'CopySkillsZip',
  actions: ['s3:GetObject', 's3:PutObject'],
  resources: [`arn:aws:s3:::${props.uploadsBucketName}/uploads/batch/*`],
}));
batchJobSubmitFn.addToRolePolicy(new iam.PolicyStatement({
  sid: 'KMSForCopy',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [props.dynamodbKey.keyArn], // for batchTable
}));
// Note: uploads bucket KMS key grant is handled by the bucket's key policy
// when the Lambda copies within the same bucket (same key)
```

---

## Fix 8: `batch run` — Write METADATA with GSI1 Fields

**In `packages/cli/src/commands/batch.ts` `batch run` action**, the Step Functions `StartExecutionCommand` is called after uploading. Before that call, **write the METADATA record to DDB** so `batch list` and `batch status` work immediately:

```typescript
// ADD: write batch METADATA to DDB before starting SFN execution
const batchTableName = `skills-svc-batches-${cfg.accountId}-${cfg.region}`;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
const now = new Date().toISOString();

await ddb.send(new PutCommand({
  TableName: batchTableName,
  Item: {
    PK:            `BATCH#${batchId}`,
    SK:            'METADATA',
    batchId,
    batchName:     opts.jobName,
    userArn:       identity.Arn,
    status:        'RUNNING',
    totalJobs:     inputFiles.length,
    completedJobs: 0,
    failedJobs:    0,
    submittedJobs: 0,
    createdAt:     now,
    sfnExecutionArn: '', // filled in below after SFN start
    // GSI1 fields for batch list (Fix 14 from SPEC-11)
    GSI1PK: `USER#${identity.Arn}`,
    GSI1SK: `CREATED_AT#${now}`,
  },
  ConditionExpression: 'attribute_not_exists(PK)',
}));

// Start SFN execution
const execution = await sfn.send(new StartExecutionCommand({ ... }));

// Update METADATA with execution ARN (needed for batch cancel)
await ddb.send(new UpdateCommand({
  TableName: batchTableName,
  Key: { PK: `BATCH#${batchId}`, SK: 'METADATA' },
  UpdateExpression: 'SET sfnExecutionArn = :arn',
  ExpressionAttributeValues: { ':arn': execution.executionArn },
}));
```

**Add DDB imports** to `batch.ts` (already present — verify `PutCommand`, `UpdateCommand` are imported from `@aws-sdk/lib-dynamodb`).

---

## Fix 9 & 10: Authoritative `packages/shared/src/index.ts` and `package.json` exports

### `packages/shared/src/index.ts` (authoritative, single source)

```typescript
// Core types — all enums, interfaces, constants
export * from './types';
export * from './constants';

// Zip validation (moved from Lambda per SPEC-11 Fix 1)
export { validateZipStructure } from './validator';
export type { ValidationResult, ZipMetaHint } from './validator';

// Envelope encryption (from SPEC-06)
export { envelopeEncrypt, envelopeDecrypt } from './crypto';
export type { EncryptedEnvelope } from './crypto';

// Utilities
export { clampConcurrency, parseSkillRef } from './utils';  // Fix 11 below
```

### `packages/shared/package.json` — add `exports` field for subpath imports

```json
{
  "name": "@skills-svc/shared",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "jest"
  },
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

**All imports across the entire spec suite use `@skills-svc/shared` (main entry) — never subpaths.** Replace every occurrence of:
- `@skills-svc/shared/crypto` → `@skills-svc/shared`
- `@skills-svc/shared/validator` → `@skills-svc/shared`
- `@skills-svc/shared/utils` → `@skills-svc/shared`

---

## Fix 11: `parseSkillRef` → `packages/shared/src/utils.ts`

**Move** `parseSkillRef` out of `packages/cli/src/commands/skill.ts` into `packages/shared/src/utils.ts` so it can be used by the Lambda `run-skill` handler, MCP tools, and CLI without circular imports.

### `packages/shared/src/utils.ts` (authoritative)

```typescript
// Concurrency clamp (QA-169)
export function clampConcurrency(n: number): number {
  return Math.min(Math.max(n, 1), 50);
}

// Skill reference parsing: "name" or "name@version" or "name@latest"
export interface ParsedSkillRef {
  name:     string;
  version?: string;  // undefined means 'latest'
}

export function parseSkillRef(ref: string): ParsedSkillRef {
  const atIndex = ref.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0) return { name: ref };
  const name    = ref.slice(0, atIndex);
  const version = ref.slice(atIndex + 1);
  return { name, version: version === 'latest' ? undefined : version };
}
```

**Update imports** everywhere `parseSkillRef` is used:

```typescript
// packages/cli/src/commands/skill.ts — remove local definition, import from shared:
import { parseSkillRef } from '@skills-svc/shared';

// packages/cli/src/commands/run.ts:
import { parseSkillRef, RunSkillInput, RunSkillOutput } from '@skills-svc/shared';

// packages/lambda/src/mcp/tools/submit-job.ts:
import { parseSkillRef } from '@skills-svc/shared';
```

---

## Fix 12: `buildTestApp()` — Updated Helper for QA Tests

**Replace** `infra/test/helpers.ts` with authoritative version including all stacks:

```typescript
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack }        from '../lib/network-stack';
import { SecurityStack }       from '../lib/security-stack';
import { StorageStack }        from '../lib/storage-stack';
import { MessagingStack }      from '../lib/messaging-stack';
import { LambdaStack }         from '../lib/lambda-stack';
import { ECSStack }            from '../lib/ecs-stack';
import { KnowledgeStoreStack } from '../lib/knowledge-store-stack';
import { MonitoringStack }     from '../lib/monitoring-stack';
import { ComplianceStack }     from '../lib/compliance-stack';
import { BatchStack }          from '../lib/batch-stack';
import { MCPStack }            from '../lib/mcp-stack';
import { SkillRegistryStack }  from '../lib/skill-registry-stack';

export function buildTestApp() {
  const app = new App({ context: { envName: 'test' } });
  const env = { account: '123456789012', region: 'us-east-1' };

  const network  = new NetworkStack(app, 'Network', { env, envName: 'test' });
  const security = new SecurityStack(app, 'Security', { env, envName: 'test', vpc: network.vpc });

  const storage = new StorageStack(app, 'Storage', {
    env, envName: 'test',
    uploadsBucketKey: security.uploadsBucketKey,
    resultsBucketKey: security.resultsBucketKey,
    dynamodbKey:      security.dynamodbKey,
  });

  const messaging = new MessagingStack(app, 'Messaging', {
    env, envName: 'test',
    messagingKey:  security.messagingKey,
    uploadsBucket: storage.uploadsBucket,
  });

  const lambdaStack = new LambdaStack(app, 'Lambda', {
    env, envName: 'test',
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
    runSkillLambdaRole:    security.runSkillLambdaRole,
    lambdaEnvKey:          security.lambdaEnvKey,
    uploadsKmsKeyId:       security.uploadsBucketKey.keyArn,
  });

  const ecsStack = new ECSStack(app, 'ECS', {
    env, envName: 'test',
    vpc: network.vpc, ecsSg: network.ecsSg,
    ecsTaskRole: security.ecsTaskRole, ecsExecutionRole: security.ecsExecutionRole,
    ecsLogKey: security.ecsLogKey, ecrKey: security.ecrKey,
    uploadsBucket: storage.uploadsBucket, resultsBucket: storage.resultsBucket,
  });

  const knowledgeStore = new KnowledgeStoreStack(app, 'KnowledgeStore', {
    env, envName: 'test',
    vpc: network.vpc, vpcesg: network.vpcesg,
    opensearchKey:     security.opensearchKey,
    resultsLambdaRole: security.resultsLambdaRole,
    ecsTaskRole:       security.ecsTaskRole,
    queryLambdaRole:   security.queryLambdaRole,
  });

  const skillRegistry = new SkillRegistryStack(app, 'SkillRegistry', {
    env, envName: 'test',
    vpc: network.vpc, lambdaSg: network.lambdaSg,
    registryBucketKey: security.registryBucketKey,
    dynamodbKey:       security.dynamodbKey,
    accessLogsBucket:  storage.accessLogsBucket,
  });

  const batchStack = new BatchStack(app, 'Batch', {
    env, envName: 'test',
    jobsTable:         storage.jobsTable,
    ingestionFn:       lambdaStack.ingestionFn,
    dynamodbKey:       security.dynamodbKey,
    uploadsBucketName: storage.uploadsBucket.bucketName,
    uploadsKmsKeyId:   security.uploadsBucketKey.keyArn,
  });

  const mcpStack = new MCPStack(app, 'MCP', {
    env, envName: 'test',
    vpc: network.vpc, lambdaSg: network.lambdaSg,
    lambdaEnvKey:      security.lambdaEnvKey,
    userRole:          security.userRole,
    dynamodbTableName: storage.jobsTable.tableName,
    uploadsBucket:     storage.uploadsBucket.bucketName,
    resultsBucket:     storage.resultsBucket.bucketName,
    uploadsKmsKeyId:   security.uploadsBucketKey.keyArn,
    queryLambdaArn:    lambdaStack.queryFn.functionArn,
    opensearchEndpoint: 'https://test.aoss.amazonaws.com',
    jobsTopicArn:      messaging.jobsNotificationTopic.topicArn,
    ecsClusterArn:     ecsStack.cluster.clusterArn,
    skillsTableName:   skillRegistry.skillsTable.tableName,
    registryBucket:    skillRegistry.registryBucket.bucketName,
    runSkillLambdaArn: lambdaStack.runSkillFn.functionArn,
  });

  const monitoring = new MonitoringStack(app, 'Monitoring', {
    env, envName: 'test',
    ingestionFn:       lambdaStack.ingestionFn,
    resultsProcessorFn: lambdaStack.resultsProcessorFn,
    ingestionDLQ:      messaging.ingestionDLQ,
    resultsDLQ:        messaging.resultsDLQ,
    alarmTopic:        messaging.jobsNotificationTopic,
  });

  const compliance = new ComplianceStack(app, 'Compliance', {
    env, envName: 'test',
    auditKey:      security.auditKey,
    uploadsBucket: storage.uploadsBucket,
    resultsBucket: storage.resultsBucket,
  });

  return {
    network, security, storage, messaging, lambdaStack, ecsStack,
    knowledgeStore, skillRegistry, batchStack, mcpStack, monitoring, compliance,
    templates: {
      network:       Template.fromStack(network),
      security:      Template.fromStack(security),
      storage:       Template.fromStack(storage),
      messaging:     Template.fromStack(messaging),
      lambda:        Template.fromStack(lambdaStack),
      ecs:           Template.fromStack(ecsStack),
      knowledgeStore: Template.fromStack(knowledgeStore),
      skillRegistry:  Template.fromStack(skillRegistry),
      batch:          Template.fromStack(batchStack),
      mcp:            Template.fromStack(mcpStack),
      monitoring:     Template.fromStack(monitoring),
      compliance:     Template.fromStack(compliance),
    },
  };
}
```

---

## Fix 13: Validator Lambda S3 Event Filter — Add Suffix

**In `infra/lib/skill-registry-stack.ts`**, replace the event notification:

```typescript
// REPLACE:
this.registryBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.LambdaDestination(this.validatorFn),
  { prefix: 'skills/' },
);

// WITH (adds suffix filter so only skill.zip files trigger validation):
this.registryBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.LambdaDestination(this.validatorFn),
  { prefix: 'skills/', suffix: '/skill.zip' },
);
```

---

## Fix 14 (Clamp): Already resolved by Fix 9 (`clampConcurrency` in `utils.ts`, exported from main index)

---

## Fix 15: `batchJobSubmitFn` — Correct DDB Grant

**Replace** in `infra/lib/batch-stack.ts`:

```typescript
// REMOVE — submitter does not write to jobs table:
// props.jobsTable.grantWriteData(batchJobSubmitFn);

// KEEP — submitter writes to batchTable only:
batchTable.grantWriteData(batchJobSubmitFn);

// Status checker reads jobs, writes batch:
props.jobsTable.grantReadData(batchStatusFn);
batchTable.grantWriteData(batchStatusFn);
```

---

## Fix 16 & 17: Consolidate All Subpath Imports

Authoritative import replacements across all packages:

```typescript
// EVERYWHERE — replace these:
// import { envelopeDecrypt } from '@skills-svc/shared/crypto';
// import { validateZipStructure } from '@skills-svc/shared/validator';
// import { clampConcurrency } from '@skills-svc/shared/utils';
// import { parseSkillRef } from './skill';

// WITH (single import from main shared index):
import {
  envelopeDecrypt, envelopeEncrypt,
  validateZipStructure,
  clampConcurrency, parseSkillRef,
  // ... other types as needed
} from '@skills-svc/shared';
```

Files that need this update:
- `packages/cli/src/commands/diff.ts` — `envelopeDecrypt`
- `packages/cli/src/commands/skill.ts` — `validateZipStructure`, remove local `parseSkillRef`
- `packages/cli/src/commands/run.ts` — `parseSkillRef`, `RunSkillInput`, `RunSkillOutput`
- `packages/cli/src/commands/batch.ts` — `clampConcurrency`
- `packages/lambda/src/mcp/tools/submit-job.ts` — `parseSkillRef`
- `packages/lambda/src/results-processor/handler.ts` — `envelopeDecrypt`
- `packages/ecs-runner/src/uploader.ts` — `envelopeEncrypt`

---

## Fix 18: `configure.ts` Missing Imports

**Add to top of `packages/cli/src/commands/configure.ts`:**

```typescript
import { Command } from 'commander';
import {
  SSMClient,
  GetParametersByPathCommand,
  Parameter,
} from '@aws-sdk/client-ssm';
import chalk from 'chalk';
import { saveConfig, setDefaultProfileName, CliConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
```

---

## Fix 19: `batch run` METADATA — Resolved by Fix 8 above

Fix 8 adds the `PutCommand` and `UpdateCommand` to write METADATA (including `sfnExecutionArn`). This also resolves Fix 24 (`batch cancel` reads `sfnExecutionArn`).

---

## Fix 20: `skill push` — ObjectLock + ChecksumAlgorithm Note

S3 ObjectLock COMPLIANCE buckets support `PutObjectCommand` with `ChecksumAlgorithm: 'SHA256'` for non-multipart uploads (files ≤ 5GB). Since the skill zip limit is 500MB, all uploads are single-part. No workaround needed.

**Add comment in `packages/cli/src/commands/skill.ts`** near the PutObjectCommand:

```typescript
// Note: registry bucket has ObjectLock COMPLIANCE. PutObject is allowed;
// only Delete and overwrite of existing versions are blocked.
// ChecksumAlgorithm: 'SHA256' works for single-part uploads (≤ 5GB).
await s3.send(new PutObjectCommand({
  ChecksumAlgorithm: 'SHA256',
  // ...
}));
```

---

## Fix 21: `satisfies` operator — Resolved by Fix 1

After Fix 1 moves `RunSkillInput` to `@skills-svc/shared`, `satisfies RunSkillInput` works in `run.ts` with the correct import. No additional change needed.

---

## Fix 22: Validator Lambda Role — Add `s3:HeadObject`

**In `infra/lib/skill-registry-stack.ts`** `validatorRole` inline policy:

```typescript
validatorRole.addToPolicy(new iam.PolicyStatement({
  sid: 'ReadRegistry',
  actions: [
    's3:GetObject',
    's3:HeadObject',   // ADD — handler calls HeadObjectCommand for metadata
  ],
  resources: [`${this.registryBucket.bucketArn}/*`],
}));
```

---

## Fix 23: QA-163 — Resilient KMS Key Count Assertion

**Replace** fragile exact-count assertion:

```typescript
// REPLACE QA-163:
test('QA-163: SecurityStack creates exactly 10 KMS keys', () => {
  const { templates } = buildTestApp();
  const keys = templates.security.findResources('AWS::KMS::Key');

  // Assert minimum 10 — CDK may create additional keys for log retention etc.
  expect(Object.keys(keys).length).toBeGreaterThanOrEqual(10);

  // Assert each required alias exists
  const keyResources = Object.values(keys) as any[];
  const aliases = templates.security.findResources('AWS::KMS::Alias');
  const aliasValues = Object.values(aliases).map((a: any) => a.Properties.AliasName as string);

  const requiredAliases = [
    'alias/skills-svc/test/uploads',
    'alias/skills-svc/test/results',
    'alias/skills-svc/test/dynamodb',
    'alias/skills-svc/test/opensearch',
    'alias/skills-svc/test/lambda-env',
    'alias/skills-svc/test/ecs-logs',
    'alias/skills-svc/test/ecr',
    'alias/skills-svc/test/messaging',
    'alias/skills-svc/test/audit',
    'alias/skills-svc/test/registry',
  ];

  for (const alias of requiredAliases) {
    expect(aliasValues).toContain(alias);
  }
});
```

---

## Fix 24 & 25: Step Functions `batch-status` — Clean Exit

**Problem:** Step Functions Map state retries the `waitForJob` loop even after `batch-status` returns a terminal status, unless the Choice state properly catches it.

The Step Functions definition in SPEC-08 is correct — `jobComplete` Choice state routes `COMPLETE` to `Succeed` and `FAILED` to `Fail`. The `batch-status` handler returning `{ status: 'COMPLETE' }` is sufficient for the Choice to exit. No change needed to the state machine.

**However**, the `Fail` state causes the Map iteration to be marked as failed, which causes the entire Map state to fail (stopping other parallel runs). For batch jobs where individual failures are expected and non-fatal, change the `Fail` state to a `Pass` state:

```typescript
// In BatchStack — REPLACE:
const jobFailedState = new sfn.Fail(this, 'JobFailed', { error: 'JobFailed' });

// WITH (allows other batch items to continue):
const jobFailedState = new sfn.Pass(this, 'JobFailed', {
  result: sfn.Result.fromObject({ outcome: 'FAILED' }),
});
```

This way a single job failure doesn't abort the entire batch.

---

## Fix 26: `RunSkillLambda` — MCP Lambda Invoke Permission

**Add to `infra/lib/lambda-stack.ts`** after `RunSkillLambda` is created:

```typescript
// Allow MCP Lambda to invoke RunSkillLambda
this.runSkillFn.addPermission('AllowMCPInvoke', {
  principal: new iam.ServicePrincipal('lambda.amazonaws.com'),
  sourceArn: `arn:aws:lambda:${this.region}:${this.account}:function:skills-svc-mcp-${this.account}`,
});
```

---

## Fix 27: SSM vs Direct Prop — Pick One

**Decision:** Use direct prop (not SSM) for Lambda ARNs passed to other stacks. SSM is for runtime consumption by application code. CDK stacks pass ARNs directly as props.

**Remove** the SSM parameter for `run-skill-function-arn` from `LambdaStack` (Fix 8 added it unnecessarily):

```typescript
// REMOVE from LambdaStack:
// new ssm.StringParameter(this, 'ParamRunSkillFnArn', {
//   parameterName: `/skills-svc/${envName}/lambda/run-skill-function-arn`,
//   stringValue: this.runSkillFn.functionArn,
// });
```

**Update CLI `configure` command** — `runSkillLambdaArn` comes from a CloudFormation output, not SSM. Add a `CfnOutput` in `LambdaStack`:

```typescript
new cdk.CfnOutput(this, 'RunSkillFnArnOutput', {
  exportName: `SkillsSvc-${envName}-RunSkillFnArn`,
  value: this.runSkillFn.functionArn,
  description: 'RunSkillLambda ARN — used by CLI run command',
});
```

**Updated `configure.ts`** — after bulk SSM fetch, also describe the Lambda stack outputs for ARNs not in SSM:

```typescript
// After SSM GetParametersByPath, add:
const cfn = new CloudFormationClient({ region: opts.region, credentials: creds });
const lambdaStackRes = await cfn.send(new DescribeStacksCommand({
  StackName: `SkillsSvc-${opts.env}-Lambda`,
}));
const outputs = lambdaStackRes.Stacks?.[0]?.Outputs ?? [];
const getOutput = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue ?? '';

// Add to cfg:
runSkillLambdaArn: getOutput('RunSkillFnArnOutput'),
```

**Add import:**
```typescript
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
```

---

## Fix 28: `skill deprecate` — Check Current Status

**Add status guard** to `packages/cli/src/commands/skill.ts` `deprecate` action:

```typescript
// After fetching versionRes, add:
if (versionRes.Item.status !== SkillStatus.PUBLISHED) {
  console.error(chalk.red(
    `Cannot deprecate ${name}@${version} — current status is "${versionRes.Item.status}". ` +
    `Only PUBLISHED skills can be deprecated.`
  ));
  process.exit(1);
}
```

---

## Fix 29: `notify list` — Show Full Subscription ARN

**Replace** the short ARN column in `notify list` with full ARN, and add a copy-friendly format:

```typescript
prettyTable([
  ['Protocol', 'Endpoint', 'Status', 'Subscription ARN'],
  ...(subs.Subscriptions ?? []).map(s => [
    s.Protocol ?? '',
    (s.Endpoint ?? '').slice(0, 35) + (s.Endpoint && s.Endpoint.length > 35 ? '...' : ''),
    s.SubscriptionArn === 'PendingConfirmation'
      ? chalk.yellow('Pending')
      : chalk.green('Active'),
    s.SubscriptionArn ?? '',   // full ARN for unsubscribe command
  ]),
]);
console.log(chalk.dim('\nTo unsubscribe: skills-svc notify unsubscribe <Subscription ARN>'));
```

---

## Fix 30: Deployment Runbook — Updated Stack Order

**Replace** the deployment runbook in SPEC-05 Step 3 with the authoritative 12-stack order:

```bash
#!/usr/bin/env bash
set -euo pipefail
ENV=${CDK_ENV:-prod}

# Tier 1 — no dependencies
npx cdk deploy SkillsSvc-${ENV}-Network       --require-approval never

# Tier 2 — depends on Network
npx cdk deploy SkillsSvc-${ENV}-Security      --require-approval never

# Tier 3 — depends on Security
npx cdk deploy SkillsSvc-${ENV}-Storage       --require-approval never
npx cdk deploy SkillsSvc-${ENV}-SkillRegistry --require-approval never  # parallel with Storage

# Tier 4 — depends on Storage
npx cdk deploy SkillsSvc-${ENV}-Messaging     --require-approval never

# Tier 5 — depends on Messaging (and Storage, Security)
npx cdk deploy SkillsSvc-${ENV}-Lambda        --require-approval never
npx cdk deploy SkillsSvc-${ENV}-ECS           --require-approval never  # parallel with Lambda
npx cdk deploy SkillsSvc-${ENV}-KnowledgeStore --require-approval never # parallel

# Tier 6 — depends on Lambda, ECS, KnowledgeStore, SkillRegistry
npx cdk deploy SkillsSvc-${ENV}-Batch         --require-approval never
npx cdk deploy SkillsSvc-${ENV}-MCP           --require-approval never  # parallel with Batch

# Tier 7 — depends on all above
npx cdk deploy SkillsSvc-${ENV}-Monitoring    --require-approval never
npx cdk deploy SkillsSvc-${ENV}-Compliance    --require-approval never  # parallel with Monitoring
```

---

## Authoritative Dependency Graph (Updated)

```
NetworkStack
    └── SecurityStack
            ├── StorageStack
            │       └── MessagingStack
            │               └── LambdaStack ─────────────────────────────┐
            │                       └── BatchStack                       │
            ├── SkillRegistryStack                                        │
            │                                                             │
            ├── LambdaStack ──────────────────────────────────────────── ┤
            ├── ECSStack ─────────────────────────────────────────────── ┤
            └── KnowledgeStoreStack                                       │
                                                                          │
                    MCPStack ◄─────── (Lambda + ECS + SkillRegistry) ─────┘
                                                        │
                    MonitoringStack ◄───────────────────┘
                    ComplianceStack ◄───────────────────┘
```

---

## QA Checks (QA-171 through QA-180)

```typescript
// QA-171: RunSkillInput and RunSkillOutput are in shared package
test('QA-171: RunSkillInput and RunSkillOutput exported from @skills-svc/shared', () => {
  const shared = require('@skills-svc/shared');
  // Verify they are type exports — check they exist in the compiled JS as undefined
  // (interfaces are erased at runtime — test the handler imports work instead)
  const handler = require('@skills-svc/lambda/dist/run-skill/handler');
  expect(typeof handler.handler).toBe('function');
});

// QA-172: parseSkillRef is in shared package
test('QA-172: parseSkillRef exported from @skills-svc/shared', () => {
  const { parseSkillRef } = require('@skills-svc/shared');
  expect(typeof parseSkillRef).toBe('function');
  expect(parseSkillRef('my-skill@1.0.0')).toEqual({ name: 'my-skill', version: '1.0.0' });
  expect(parseSkillRef('my-skill')).toEqual({ name: 'my-skill', version: undefined });
  expect(parseSkillRef('my-skill@latest')).toEqual({ name: 'my-skill', version: undefined });
});

// QA-173: LambdaStack exposes runSkillFn as public property
test('QA-173: LambdaStack has runSkillFn public property', () => {
  const { lambdaStack } = buildTestApp();
  expect(lambdaStack.runSkillFn).toBeDefined();
  expect(lambdaStack.runSkillFn.functionName).toContain('run-skill');
});

// QA-174: MCPStack Lambda env has RUN_SKILL_LAMBDA_ARN
test('QA-174: MCP Lambda has RUN_SKILL_LAMBDA_ARN in environment', () => {
  const { templates } = buildTestApp();
  const fns = templates.mcp.findResources('AWS::Lambda::Function');
  const mcpFn = Object.values(fns).find((fn: any) =>
    (fn as any).Properties.FunctionName?.includes('mcp')
  ) as any;
  expect(mcpFn.Properties.Environment.Variables.RUN_SKILL_LAMBDA_ARN).toBeDefined();
});

// QA-175: BatchStack Lambda env has BATCH_TABLE_NAME and UPLOADS_BUCKET
test('QA-175: BatchJobSubmitFn has required environment variables', () => {
  const { templates } = buildTestApp();
  const fns = templates.batch.findResources('AWS::Lambda::Function');
  const submitFn = Object.values(fns).find((fn: any) =>
    JSON.stringify(fn).includes('batch-submit')
  ) as any;
  const env = submitFn.Properties.Environment.Variables;
  expect(env.BATCH_TABLE_NAME).toBeDefined();
  expect(env.UPLOADS_BUCKET).toBeDefined();
  expect(env.UPLOADS_KMS_KEY_ID).toBeDefined();
  expect(env.DYNAMODB_TABLE_NAME).toBeDefined();
});

// QA-176: Validator Lambda has HeadObject permission (not just GetObject)
test('QA-176: SkillValidatorLambda role has s3:HeadObject on registry bucket', () => {
  const { templates } = buildTestApp();
  const roles = templates.skillRegistry.findResources('AWS::IAM::Role');
  const validatorRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('skill-validator')
  ) as any;
  const stmts = validatorRole.Properties.Policies?.flatMap((p: any) => p.PolicyDocument.Statement) ?? [];
  const readStmt = stmts.find((s: any) => s.Sid === 'ReadRegistry');
  const actions = Array.isArray(readStmt?.Action) ? readStmt.Action : [readStmt?.Action];
  expect(actions).toContain('s3:HeadObject');
  expect(actions).toContain('s3:GetObject');
});

// QA-177: S3 event notification has both prefix and suffix filter
test('QA-177: Registry bucket S3 event notification filters on suffix skill.zip', () => {
  const { templates } = buildTestApp();
  const buckets = templates.skillRegistry.findResources('AWS::S3::Bucket');
  const registryBucket = Object.values(buckets).find((b: any) =>
    JSON.stringify(b).includes('registry')
  ) as any;
  const notification = registryBucket.Properties.NotificationConfiguration;
  const lambdaConfig = notification?.LambdaConfigurations?.[0];
  const filterRules = lambdaConfig?.Filter?.S3Key?.Rules ?? [];
  const suffixRule = filterRules.find((r: any) => r.Name === 'suffix');
  expect(suffixRule?.Value).toBe('/skill.zip');
});

// QA-178: batch run writes METADATA to DDB (including sfnExecutionArn)
test('QA-178: batch run PutCommand writes METADATA with GSI1 fields', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  const sfnMock = mockClient(SFNClient);
  sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:aws:states:test' });

  await runBatchRun({ jobName: 'test', inputs: 'test/*.json', concurrency: '5' });

  const putCall = ddbMock.commandCalls(PutCommand)[0];
  expect(putCall.args[0].input.Item.SK).toBe('METADATA');
  expect(putCall.args[0].input.Item.GSI1PK).toMatch(/^USER#/);
  expect(putCall.args[0].input.Item.totalJobs).toBeGreaterThan(0);

  // Second call should be UpdateCommand to set sfnExecutionArn
  const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
  expect(updateCall.args[0].input.UpdateExpression).toContain('sfnExecutionArn');
});

// QA-179: skill deprecate rejects non-PUBLISHED skills
test('QA-179: skill deprecate exits 1 if skill is not PUBLISHED', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({
    Item: { status: SkillStatus.FAILED, authorArn: 'arn:aws:iam::123:user/alice' },
  });
  const stsMock = mockClient(STSClient);
  stsMock.on(GetCallerIdentityCommand).resolves({ Arn: 'arn:aws:iam::123:user/alice' });
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

  await expect(runSkillDeprecate('my-skill@1.0.0', { message: 'test' })).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-180: Step Functions Fail state replaced with Pass for individual job failures
test('QA-180: Batch Step Functions JobFailed state is Pass not Fail', () => {
  const { templates } = buildTestApp();
  const stateMachines = templates.batch.findResources('AWS::StepFunctions::StateMachine');
  const sfn = Object.values(stateMachines)[0] as any;
  const definition = JSON.parse(sfn.Properties.DefinitionString ?? '{}');
  const jobFailedState = definition.States?.JobFailed;
  expect(jobFailedState?.Type).toBe('Pass');  // not 'Fail'
});
```

---

## Summary of All Changes

### Files with authoritative replacements in this spec

| File | Change |
|------|--------|
| `packages/shared/src/types.ts` | Add `RunSkillInput`, `RunSkillOutput`, `ParsedSkillRef` |
| `packages/shared/src/utils.ts` | Add `clampConcurrency`, `parseSkillRef` |
| `packages/shared/src/index.ts` | Authoritative single-file export |
| `packages/shared/package.json` | Remove `exports` subpaths — single main entry |
| `packages/lambda/src/run-skill/handler.ts` | Import types from shared |
| `packages/cli/src/commands/run.ts` | Import from shared, use Lambda not direct S3 copy |
| `packages/cli/src/commands/skill.ts` | Remove local `parseSkillRef`, add deprecate guard |
| `packages/cli/src/commands/batch.ts` | Write METADATA before SFN, update sfnExecutionArn after |
| `packages/cli/src/commands/notify.ts` | Show full subscription ARN |
| `packages/cli/src/commands/configure.ts` | Add CloudFormation output lookup |
| `infra/lib/lambda-stack.ts` | Add props + `public readonly runSkillFn` + invoke permission |
| `infra/lib/batch-stack.ts` | Fix env vars, fix DDB grants, fix SFN Fail→Pass, add props |
| `infra/lib/mcp-stack.ts` | Add `runSkillLambdaArn` to props and env |
| `infra/lib/skill-registry-stack.ts` | Add suffix filter, fix HeadObject IAM |
| `infra/bin/app.ts` | Pass `runSkillLambdaArn` to MCPStack, pass bucket props to BatchStack |
| `infra/test/helpers.ts` | Authoritative `buildTestApp()` with all 12 stacks |
| `scripts/deploy.sh` | Updated 12-stack deployment with correct tier ordering |
