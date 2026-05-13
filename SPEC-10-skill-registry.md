# Skills as a Service (SaaS) — Specification Part 10: Skill Registry

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | [Part 2](SPEC-02-lambda-ecs.md) | [Part 3](SPEC-03-knowledge-store-cli.md) | [Part 4](SPEC-04-qa-layers-1-50.md) | [Part 5](SPEC-05-qa-layers-51-100-deployment.md) | [Part 6](SPEC-06-security-hardening.md) | [Part 7](SPEC-07-cli-features.md) | [Part 8](SPEC-08-cli-features-2.md) | [Part 9](SPEC-09-mcp-server.md) | [Part 10: Skill Registry]

---

## Problem Statement

Prior to this spec, skills have no persistent identity. Every job submission requires re-uploading the full zip. There is no way to:
- Reference a skill by name across jobs
- Share a skill with teammates without passing zip files
- Track which version of a skill produced which result
- Discover skills published by others in the org
- Audit skill lineage (which jobs ran skill X at version Y)

This spec introduces a **Skill Registry** — a first-class store where skills have identity, semantic versions, visibility controls, and immutable published artifacts.

---

## Mental Model

```
Skill (stored once, referenced many times)
├── name:       "eigenvalue-analyzer"
├── version:    "1.2.0"   (semver, immutable once published)
├── visibility: private | org                 
├── author:     arn:aws:iam::123:user/alice
├── zip:        s3://skills-registry/skills/alice/eigenvalue-analyzer/1.2.0/skill.zip
└── manifest:   { jobName, skills[], defaultPrompt, description, tags }

Job (a run of a specific skill version)
├── skillName:    "eigenvalue-analyzer"
├── skillVersion: "1.2.0"
└── results → OpenSearch (already indexed, now includes skill reference)
```

Skills are immutable once published at a version. A new version must be pushed to change anything. `latest` is a pointer to the highest non-prerelease version and updates automatically.

---

## 1. New AWS Resources

### Summary

| Resource | Purpose |
|----------|---------|
| `skills-registry-{account}-{region}` S3 bucket | Immutable skill zip storage |
| `skills-svc-skills-{account}-{region}` DDB table | Skill metadata, versions, tags |
| `SkillValidatorLambda` | Validates zip on push, extracts metadata |
| DDB GSI5 on jobs table | `SKILL#{name}#{version}` → jobs that ran this skill |
| OpenSearch index `skills-registry` | Full-text + semantic search over skill descriptions |

---

## 2. SkillRegistryStack (`infra/lib/skill-registry-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface SkillRegistryStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  registryBucketKey: kms.Key;  // dedicated KMS key for registry bucket
  dynamodbKey: kms.Key;
  accessLogsBucket: s3.Bucket;
}

export class SkillRegistryStack extends cdk.Stack {
  public readonly registryBucket: s3.Bucket;
  public readonly skillsTable: dynamodb.Table;
  public readonly validatorFn: lambda.Function;

  constructor(scope: Construct, id: string, props: SkillRegistryStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // ── Registry S3 Bucket ───────────────────────────────────────────────
    // Immutable versioned artifacts — ObjectLock COMPLIANCE to prevent deletion
    this.registryBucket = new s3.Bucket(this, 'RegistryBucket', {
      bucketName: `skills-svc-registry-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: props.registryBucketKey,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: {
        mode: s3.ObjectLockMode.COMPLIANCE,
        duration: cdk.Duration.days(2555), // 7 years — skills are audit artifacts
      },
      serverAccessLogsBucket: props.accessLogsBucket,
      serverAccessLogsPrefix: 'registry-access-logs/',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [{
        id: 'glacier-old-versions',
        transitions: [{
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: cdk.Duration.days(365),
        }],
      }],
    });

    // Deny delete operations — belt-and-suspenders with ObjectLock
    this.registryBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyDelete',
      effect: iam.Effect.DENY,
      principals: [new iam.StarPrincipal()],
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [`${this.registryBucket.bucketArn}/*`],
    }));

    // ── Skills DDB Table (separate from jobs table) ──────────────────────
    // Single-table design: skills + versions + tags in one table
    this.skillsTable = new dynamodb.Table(this, 'SkillsTable', {
      tableName: `skills-svc-skills-${this.account}-${this.region}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dynamodbKey,
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl', // used for deprecated skills only
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI1: list all versions of a skill (PK=SKILL#{name}, SK=VERSION#{semver})
    // — base table already provides this; GSI not needed for this pattern

    // GSI1: list skills by author
    this.skillsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-Author',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING }, // AUTHOR#{userArn}
      sortKey:      { name: 'GSI1SK', type: dynamodb.AttributeType.STRING }, // PUBLISHED_AT#{iso}
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: list all org-visible skills
    this.skillsTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-OrgSkills',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING }, // VISIBILITY#org
      sortKey:      { name: 'GSI2SK', type: dynamodb.AttributeType.STRING }, // PUBLISHED_AT#{iso}
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: list skills by tag
    this.skillsTable.addGlobalSecondaryIndex({
      indexName: 'GSI3-Tag',
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING }, // TAG#{tag}
      sortKey:      { name: 'GSI3SK', type: dynamodb.AttributeType.STRING }, // PUBLISHED_AT#{iso}
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['skillName', 'version', 'description', 'authorArn', 'latestVersion'],
    });

    // ── Skill Validator Lambda ───────────────────────────────────────────
    const validatorRole = new iam.Role(this, 'ValidatorRole', {
      roleName: `skills-svc-skill-validator-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    validatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadRegistry',
      actions: ['s3:GetObject', 's3:HeadObject'],
      resources: [`${this.registryBucket.bucketArn}/*`],
    }));
    validatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteSkillsTable',
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:Query'],
      resources: [
        this.skillsTable.tableArn,
        `${this.skillsTable.tableArn}/index/*`,
      ],
    }));
    validatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMRead',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));
    validatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KMSDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [props.registryBucketKey.keyArn, props.dynamodbKey.keyArn],
    }));
    validatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/lambda/validator:*`],
    }));
    validatorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRay',
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));

    this.validatorFn = new lambda.Function(this, 'SkillValidatorLambda', {
      functionName: `skills-svc-skill-validator-${this.account}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'skill-validator/handler.handler',
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      reservedConcurrentExecutions: 20,
      tracing: lambda.Tracing.ACTIVE,
      role: validatorRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ENV: envName,
        REGION: this.region,
      },
      description: 'Validates skill zip on push, writes metadata to DDB, updates latest pointer',
    });

    // S3 event: new object in skills/ prefix → validator Lambda
    this.registryBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new (require('aws-cdk-lib/aws-s3-notifications').LambdaDestination)(this.validatorFn),
      { prefix: 'skills/' },
    );

    // SSM params
    new ssm.StringParameter(this, 'ParamRegistryBucket', {
      parameterName: `/skills-svc/${envName}/registry/bucket-name`,
      stringValue: this.registryBucket.bucketName,
    });
    new ssm.StringParameter(this, 'ParamSkillsTableName', {
      parameterName: `/skills-svc/${envName}/registry/skills-table-name`,
      stringValue: this.skillsTable.tableName,
    });
    new ssm.StringParameter(this, 'ParamRegistryKeyId', {
      parameterName: `/skills-svc/${envName}/registry/kms-key-id`,
      stringValue: props.registryBucketKey.keyArn,
    });
  }
}
```

### Add to `infra/lib/security-stack.ts`

```typescript
// New KMS key for registry bucket (separate key = separate blast radius)
this.registryBucketKey = makeKey(this, 'RegistryBucketKey', `${envName}/registry`);
```

Export as `public readonly registryBucketKey: kms.Key`.

### Add to `infra/bin/app.ts`

```typescript
import { SkillRegistryStack } from '../lib/skill-registry-stack';

const skillRegistry = new SkillRegistryStack(app, `SkillsSvc-${envName}-SkillRegistry`, {
  env, envName,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  registryBucketKey: security.registryBucketKey,
  dynamodbKey: security.dynamodbKey,
  accessLogsBucket: storage.accessLogsBucket,
});
skillRegistry.addDependency(security);
skillRegistry.addDependency(network);
```

### Add GSI5 to jobs table (`infra/lib/storage-stack.ts`)

```typescript
// GSI5: list jobs that ran a specific skill version
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI5-Skill',
  partitionKey: { name: 'GSI5PK', type: dynamodb.AttributeType.STRING }, // SKILL#{name}#{version}
  sortKey:      { name: 'GSI5SK', type: dynamodb.AttributeType.STRING }, // CREATED_AT#{iso}
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'jobName', 'status', 'createdAt', 'userArn'],
});
```

---

## 3. DDB Schema (Skills Table)

Single-table design. All access patterns listed below.

### Item Types

#### SKILL_META — one per skill name (the "namespace" record)

```
PK = SKILL#{name}
SK = META

Fields:
  skillName       string   "eigenvalue-analyzer"
  description     string   Human-readable description
  authorArn       string   IAM ARN of first publisher
  latestVersion   string   "1.2.0" — updated on each push
  latestStable    string   "1.2.0" — highest non-prerelease version
  visibility      string   "private" | "org"
  tags            string[] ["math", "linear-algebra"]
  createdAt       string   ISO 8601
  updatedAt       string   ISO 8601
  totalVersions   number
  totalRuns       number   incremented by ingestion Lambda on each job
  GSI1PK          string   AUTHOR#{authorArn}
  GSI1SK          string   PUBLISHED_AT#{iso}
  GSI2PK          string   VISIBILITY#org  (only if visibility=org, absent otherwise)
  GSI2SK          string   PUBLISHED_AT#{iso}
```

#### SKILL_VERSION — one per published version

```
PK = SKILL#{name}
SK = VERSION#{semver}   (zero-padded: VERSION#001.002.000 for correct sort)

Fields:
  skillName       string
  version         string   raw semver "1.2.0"
  versionSortKey  string   zero-padded for lexicographic sort
  authorArn       string   publisher of this specific version
  description     string   version-specific description (may differ from meta)
  s3Key           string   skills/{author}/{name}/{version}/skill.zip
  s3ETag          string   S3 ETag for integrity
  zipSha256       string   SHA256 of zip content
  sizeBytes       number
  skills          string[] from manifest.json
  defaultPrompt   string   from manifest.json
  changelog       string   optional, from manifest.json
  publishedAt     string   ISO 8601
  deprecated      boolean  false by default
  deprecatedAt    string?
  deprecationMsg  string?
  status          string   "validating" | "published" | "deprecated" | "failed"
  validationError string?  set if status=failed
  GSI1PK          string   AUTHOR#{authorArn}
  GSI1SK          string   PUBLISHED_AT#{publishedAt}
```

#### SKILL_TAG — one per (tag, skill) pair for tag-based listing

```
PK = TAG#{tag}
SK = SKILL#{name}#{version}

Fields:
  skillName, version, authorArn, description, publishedAt
  GSI3PK = TAG#{tag}
  GSI3SK = PUBLISHED_AT#{publishedAt}
```

### Access Patterns

| Pattern | Key Expression | Index |
|---------|---------------|-------|
| Get skill metadata | `PK=SKILL#{name} SK=META` | None |
| List all versions of a skill | `PK=SKILL#{name} SK begins_with VERSION#` | None |
| Get specific version | `PK=SKILL#{name} SK=VERSION#{padded}` | None |
| List skills by author | `GSI1PK=AUTHOR#{arn}` | GSI1 |
| List org-visible skills | `GSI2PK=VISIBILITY#org` | GSI2 |
| List skills by tag | `GSI3PK=TAG#{tag}` | GSI3 |
| List jobs that ran a skill | `GSI5PK=SKILL#{name}#{version}` on jobs table | GSI5 |

### Semver Zero-Padding (for correct DDB sort)

```typescript
// "1.12.0" → "001.012.000"
export function padSemver(version: string): string {
  const [major, minor, patch] = version.split('.').map(n => parseInt(n, 10));
  return [major, minor, patch].map(n => String(n).padStart(3, '0')).join('.');
}
```

---

## 4. Shared Types (`packages/shared/src/types.ts` additions)

```typescript
export enum SkillVisibility {
  PRIVATE = 'private',
  ORG     = 'org',
}

export enum SkillStatus {
  VALIDATING  = 'validating',
  PUBLISHED   = 'published',
  DEPRECATED  = 'deprecated',
  FAILED      = 'failed',
}

export const SKILL_KEY_PREFIX = {
  SKILL:      'SKILL#',
  VERSION:    'VERSION#',
  TAG:        'TAG#',
  AUTHOR:     'AUTHOR#',
  VISIBILITY: 'VISIBILITY#',
} as const;

export interface SkillMeta {
  skillName: string;
  description: string;
  authorArn: string;
  latestVersion: string;
  latestStable: string;
  visibility: SkillVisibility;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  totalVersions: number;
  totalRuns: number;
}

export interface SkillVersion {
  skillName: string;
  version: string;
  versionSortKey: string;
  authorArn: string;
  description: string;
  s3Key: string;
  s3ETag: string;
  zipSha256: string;
  sizeBytes: number;
  skills: string[];
  defaultPrompt?: string;
  changelog?: string;
  publishedAt: string;
  deprecated: boolean;
  deprecatedAt?: string;
  deprecationMsg?: string;
  status: SkillStatus;
  validationError?: string;
}

export interface SkillRef {
  skillName: string;
  version: string;    // resolved semver — "latest" resolved before storage
}

// Updated JobRecord — add skill reference fields
// (extends existing JobRecord in SPEC-02)
export interface SkillJobFields {
  skillName?: string;     // set when job was submitted via skill ref
  skillVersion?: string;  // resolved version
  GSI5PK?: string;        // SKILL#{name}#{version}
  GSI5SK?: string;        // CREATED_AT#{iso}
}

// Valid semver: MAJOR.MINOR.PATCH with optional prerelease (-alpha.1)
export const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function isValidSemver(version: string): boolean {
  return SEMVER_REGEX.test(version);
}

export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

export function padSemver(version: string): string {
  const clean = version.split('-')[0]; // strip prerelease for sort key
  const [major = 0, minor = 0, patch = 0] = clean.split('.').map(Number);
  return [major, minor, patch].map(n => String(n).padStart(3, '0')).join('.');
}

// Returns the higher of two semver strings (ignoring prerelease for stable comparison)
export function isHigherVersion(a: string, b: string): boolean {
  const pa = padSemver(a), pb = padSemver(b);
  return pa > pb;
}
```

---

## 5. Skill Validator Lambda

### `packages/lambda/src/skill-validator/handler.ts`

Triggered by S3 ObjectCreated on the registry bucket. Validates the uploaded zip, extracts manifest, writes DDB records, updates the `latest` pointer.

```typescript
import { S3Handler, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createHash } from 'crypto';
import { captureAWSv3Client } from 'aws-xray-sdk';
import {
  SkillStatus, SkillVisibility, SKILL_KEY_PREFIX,
  padSemver, isPrerelease, isHigherVersion, isValidSemver,
  ZipManifest,
} from '@skills-svc/shared';
import { validateZipStructure } from '../ingestion/validator';

const s3  = captureAWSv3Client(new S3Client({}));
const ddb = captureAWSv3Client(DynamoDBDocumentClient.from(new DynamoDBClient({})));
const ssm = captureAWSv3Client(new SSMClient({}));

const paramCache = new Map<string, { value: string; ts: number }>();
async function getParam(name: string): Promise<string> {
  const now = Date.now();
  const cached = paramCache.get(name);
  if (cached && now - cached.ts < 300_000) return cached.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter!.Value!;
  paramCache.set(name, { value, ts: now });
  return value;
}

// S3 key format: skills/{authorId}/{skillName}/{version}/skill.zip
function parseS3Key(key: string): { authorId: string; skillName: string; version: string } | null {
  const parts = key.split('/');
  if (parts.length !== 5 || parts[0] !== 'skills' || parts[4] !== 'skill.zip') return null;
  return { authorId: parts[1], skillName: parts[2], version: parts[3] };
}

export const handler: S3Handler = async (event: S3Event) => {
  const env = process.env.ENV ?? 'prod';
  const skillsTableName = await getParam(`/skills-svc/${env}/registry/skills-table-name`);

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    const parsed = parseS3Key(key);
    if (!parsed) {
      console.warn(JSON.stringify({ event: 'skip_non_skill_key', key }));
      continue;
    }

    const { authorId, skillName, version } = parsed;

    // Validate semver
    if (!isValidSemver(version)) {
      console.error(JSON.stringify({ event: 'invalid_semver', key, version }));
      await writeFailedVersion(skillsTableName, skillName, version, authorId, key, 'Invalid semver format');
      continue;
    }

    // Idempotency: check if this version already exists and is published
    const existing = await ddb.send(new GetCommand({
      TableName: skillsTableName,
      Key: {
        PK: `${SKILL_KEY_PREFIX.SKILL}${skillName}`,
        SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(version)}`,
      },
    }));
    if (existing.Item?.status === SkillStatus.PUBLISHED) {
      console.warn(JSON.stringify({ event: 'already_published', skillName, version }));
      continue;
    }

    // Download zip for validation (first 10MB for header check)
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const authorArn = head.Metadata?.['author-arn'] ?? `unknown/${authorId}`;
    const visibility = (head.Metadata?.['visibility'] as SkillVisibility | undefined) ?? SkillVisibility.PRIVATE;
    const description = head.Metadata?.['description'] ?? '';
    const changelog   = head.Metadata?.['changelog'] ?? '';

    const range = `bytes=0-${Math.min((head.ContentLength ?? 0) - 1, 10 * 1024 * 1024 - 1)}`;
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const zipBuffer = Buffer.concat(chunks);

    // Structural validation
    const validation = validateZipStructure(zipBuffer, {
      compressedSize: head.ContentLength ?? 0,
      uncompressedSize: (head.ContentLength ?? 0) * 10,
    });

    if (!validation.valid) {
      await writeFailedVersion(skillsTableName, skillName, version, authorArn, key, validation.error!);
      continue;
    }

    const manifest = validation.manifest!;

    // Compute SHA256 of full zip (using S3 ETag as proxy — ETag is MD5 for non-multipart)
    const zipSha256 = head.ChecksumSHA256 ?? createHash('sha256').update(zipBuffer).digest('hex');
    const now = new Date().toISOString();

    // Write version record
    await ddb.send(new PutCommand({
      TableName: skillsTableName,
      Item: {
        PK:             `${SKILL_KEY_PREFIX.SKILL}${skillName}`,
        SK:             `${SKILL_KEY_PREFIX.VERSION}${padSemver(version)}`,
        skillName,
        version,
        versionSortKey: padSemver(version),
        authorArn,
        description:    description || manifest.jobName,
        s3Key:          key,
        s3ETag:         head.ETag?.replace(/"/g, '') ?? '',
        zipSha256,
        sizeBytes:      head.ContentLength ?? 0,
        skills:         manifest.skills,
        defaultPrompt:  manifest.defaultPrompt,
        changelog,
        publishedAt:    now,
        deprecated:     false,
        status:         SkillStatus.PUBLISHED,
        GSI1PK:         `${SKILL_KEY_PREFIX.AUTHOR}${authorArn}`,
        GSI1SK:         `PUBLISHED_AT#${now}`,
        ...(visibility === SkillVisibility.ORG ? {
          GSI2PK: `${SKILL_KEY_PREFIX.VISIBILITY}org`,
          GSI2SK: `PUBLISHED_AT#${now}`,
        } : {}),
      },
      ConditionExpression: 'attribute_not_exists(PK) OR #status <> :published',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':published': SkillStatus.PUBLISHED },
    }));

    // Upsert SKILL_META — update latestVersion if this is higher
    const metaRes = await ddb.send(new GetCommand({
      TableName: skillsTableName,
      Key: { PK: `${SKILL_KEY_PREFIX.SKILL}${skillName}`, SK: 'META' },
    }));

    const currentLatest = metaRes.Item?.latestVersion as string | undefined;
    const currentStable = metaRes.Item?.latestStable as string | undefined;
    const isNewer        = !currentLatest || isHigherVersion(version, currentLatest);
    const isNewerStable  = !isPrerelease(version) && (!currentStable || isHigherVersion(version, currentStable));
    const tags: string[] = manifest.tags ? Object.values(manifest.tags) : [];

    if (!metaRes.Item) {
      // First version — create META record
      await ddb.send(new PutCommand({
        TableName: skillsTableName,
        Item: {
          PK:            `${SKILL_KEY_PREFIX.SKILL}${skillName}`,
          SK:            'META',
          skillName,
          description:   description || manifest.jobName,
          authorArn,
          latestVersion:  version,
          latestStable:   isPrerelease(version) ? '' : version,
          visibility,
          tags,
          createdAt:     now,
          updatedAt:     now,
          totalVersions:  1,
          totalRuns:      0,
          GSI1PK:        `${SKILL_KEY_PREFIX.AUTHOR}${authorArn}`,
          GSI1SK:        `PUBLISHED_AT#${now}`,
          ...(visibility === SkillVisibility.ORG ? {
            GSI2PK: `${SKILL_KEY_PREFIX.VISIBILITY}org`,
            GSI2SK: `PUBLISHED_AT#${now}`,
          } : {}),
        },
      }));
    } else {
      // Update META
      await ddb.send(new UpdateCommand({
        TableName: skillsTableName,
        Key: { PK: `${SKILL_KEY_PREFIX.SKILL}${skillName}`, SK: 'META' },
        UpdateExpression: [
          'SET updatedAt = :now',
          'ADD totalVersions :one',
          ...(isNewer       ? ['latestVersion = :lv'] : []),
          ...(isNewerStable ? ['latestStable = :ls']  : []),
        ].join(', '),
        ExpressionAttributeValues: {
          ':now': now,
          ':one': 1,
          ...(isNewer       ? { ':lv': version } : {}),
          ...(isNewerStable ? { ':ls': version } : {}),
        },
      }));
    }

    // Write TAG records
    for (const tag of tags) {
      await ddb.send(new PutCommand({
        TableName: skillsTableName,
        Item: {
          PK:         `${SKILL_KEY_PREFIX.TAG}${tag}`,
          SK:         `${SKILL_KEY_PREFIX.SKILL}${skillName}#${version}`,
          skillName,
          version,
          authorArn,
          description: description || manifest.jobName,
          publishedAt: now,
          GSI3PK:     `${SKILL_KEY_PREFIX.TAG}${tag}`,
          GSI3SK:     `PUBLISHED_AT#${now}`,
        },
      }));
    }

    console.log(JSON.stringify({ event: 'skill_published', skillName, version, authorArn, visibility }));
  }
};

async function writeFailedVersion(
  tableName: string,
  skillName: string,
  version: string,
  authorArn: string,
  s3Key: string,
  error: string,
): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      PK: `${SKILL_KEY_PREFIX.SKILL}${skillName}`,
      SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(version)}`,
      skillName, version, authorArn, s3Key,
      status: SkillStatus.FAILED,
      validationError: error,
      publishedAt: new Date().toISOString(),
      deprecated: false,
    },
  }));
  console.error(JSON.stringify({ event: 'skill_validation_failed', skillName, version, error }));
}
```

---

## 6. Updated Ingestion Lambda

When a job is submitted via skill reference (not direct zip), the ingestion Lambda resolves the skill to a zip S3 key and records the skill lineage.

### `packages/lambda/src/ingestion/handler.ts` additions

```typescript
// In processRecord(), detect skill-ref metadata:
const skillName    = head.Metadata?.['skill-name'];
const skillVersion = head.Metadata?.['skill-version'];

// Add to DDB job record:
...(skillName && skillVersion ? {
  skillName,
  skillVersion,
  GSI5PK: `${DDB_KEY_PREFIX.SKILL ?? 'SKILL#'}${skillName}#${skillVersion}`,
  GSI5SK: `CREATED_AT#${now}`,
} : {}),

// After successful job submission, increment totalRuns on the skill:
if (skillName && skillVersion) {
  const skillsTableName = await getParam(`/skills-svc/${env}/registry/skills-table-name`);
  await ddb.send(new UpdateCommand({
    TableName: skillsTableName,
    Key: { PK: `SKILL#${skillName}`, SK: 'META' },
    UpdateExpression: 'ADD totalRuns :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
}
```

Add `SKILL#` to `DDB_KEY_PREFIX` in `packages/shared/src/types.ts`:
```typescript
export const DDB_KEY_PREFIX = {
  JOB:      'JOB#',
  STATUS:   'STATUS#',
  USER:     'USER#',
  ETAG:     'ETAG#',
  CACHE:    'CACHE#',
  SCHEDULE: 'SCHEDULE#',
  SKILL:    'SKILL#',     // NEW
} as const;
```

---

## 7. CLI Commands

### S3 Key Convention

All skills stored at: `skills/{authorId}/{skillName}/{version}/skill.zip`

Where `authorId` is the last segment of the IAM ARN (e.g. `alice` from `arn:aws:iam::123:user/alice`).

---

### `packages/cli/src/commands/skill.ts`

```typescript
import { Command } from 'commander';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createWriteStream, readFileSync, statSync, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { randomUUID } from 'crypto';
import {
  SkillStatus, SkillVisibility, SKILL_KEY_PREFIX,
  isValidSemver, padSemver, isPrerelease, SkillVersion, SkillMeta,
} from '@skills-svc/shared';
import { validateZipStructure } from '@skills-svc/shared/validator';
import { zipDirectory } from '../utils/zipper';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { prettyTable, prettyJson, prettyJobStatus } from '../utils/pretty-print';

export function skillCommand(): Command {
  const cmd = new Command('skill').description('Manage skills in the registry');

  // ── skill push ─────────────────────────────────────────────────────────
  cmd.command('push <path>')
    .description('Publish a skill directory or zip to the registry')
    .requiredOption('--name <name>', 'Skill name (lowercase, hyphens only, e.g. "eigenvalue-analyzer")')
    .requiredOption('--version <semver>', 'Semantic version (e.g. "1.2.0" or "2.0.0-beta.1")')
    .option('--description <desc>', 'Short description of what this skill does')
    .option('--visibility <v>', 'Visibility: private|org', 'private')
    .option('--tag <tags>', 'Comma-separated tags (e.g. "math,linear-algebra")')
    .option('--changelog <notes>', 'What changed in this version')
    .option('--dry-run', 'Validate locally without pushing', false)
    .action(async (skillPath: string, opts: {
      name: string;
      version: string;
      description?: string;
      visibility: string;
      tag?: string;
      changelog?: string;
      dryRun: boolean;
    }) => {
      // Validate name format
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(opts.name) || opts.name.length > 64) {
        console.error(chalk.red('Skill name must be lowercase alphanumeric with hyphens, 2–64 chars'));
        process.exit(1);
      }

      // Validate semver
      if (!isValidSemver(opts.version)) {
        console.error(chalk.red(`Invalid semver: "${opts.version}". Use MAJOR.MINOR.PATCH format.`));
        process.exit(1);
      }

      // Validate visibility
      if (!['private', 'org'].includes(opts.visibility)) {
        console.error(chalk.red('--visibility must be "private" or "org"'));
        process.exit(1);
      }

      const cfg    = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds  = await getCredentialProvider();
      const sts    = new STSClient({ region: cfg.region, credentials: creds });
      const ssm    = new SSMClient({ region: cfg.region, credentials: creds });
      const s3     = new S3Client({ region: cfg.region, credentials: creds });
      const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));

      const identity = await sts.send(new GetCallerIdentityCommand({}));
      const authorId = identity.Arn!.split('/').pop()!;

      // Determine if path is directory or zip
      const stat = statSync(skillPath);
      let zipPath: string;

      if (stat.isDirectory()) {
        console.log(chalk.dim('Zipping directory...'));
        zipPath = path.join(os.tmpdir(), `skill-push-${randomUUID()}.zip`);
        await zipDirectory(skillPath, zipPath, ['*.tmp', '*.swp', '.DS_Store']);
      } else if (skillPath.endsWith('.zip')) {
        zipPath = skillPath;
      } else {
        console.error(chalk.red('Path must be a directory or .zip file'));
        process.exit(1);
      }

      // Local validation
      console.log(chalk.dim('Validating skill structure...'));
      const zipBuffer = readFileSync(zipPath);
      const validation = validateZipStructure(zipBuffer);

      if (!validation.valid) {
        console.error(chalk.red(`Validation failed: ${validation.error}`));
        process.exit(1);
      }

      const manifest = validation.manifest!;
      console.log(chalk.green('✓ Validation passed'));
      console.log(`  Skills: ${manifest.skills.join(', ')}`);
      console.log(`  Prompt: ${manifest.defaultPrompt?.slice(0, 60) ?? '(none — will use default)'}`);

      if (opts.dryRun) {
        console.log(chalk.yellow('\n  --dry-run: not pushing to registry'));
        return;
      }

      // Check if version already exists (immutable)
      const skillsTableName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/skills-table-name`,
      })).then(r => r.Parameter!.Value!);

      const existing = await ddb.send(new GetCommand({
        TableName: skillsTableName,
        Key: {
          PK: `${SKILL_KEY_PREFIX.SKILL}${opts.name}`,
          SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(opts.version)}`,
        },
      }));

      if (existing.Item?.status === SkillStatus.PUBLISHED) {
        console.error(chalk.red(
          `Version ${opts.name}@${opts.version} is already published and immutable.\n` +
          `Bump the version number to publish changes.`
        ));
        process.exit(1);
      }

      // Push to registry
      const registryBucket = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/bucket-name`,
      })).then(r => r.Parameter!.Value!);

      const registryKeyId = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/kms-key-id`,
      })).then(r => r.Parameter!.Value!);

      const s3Key = `skills/${authorId}/${opts.name}/${opts.version}/skill.zip`;
      const tags  = opts.tag?.split(',').map(t => t.trim()).filter(Boolean) ?? [];

      console.log(chalk.blue(`\nPushing ${opts.name}@${opts.version}...`));

      await s3.send(new PutObjectCommand({
        Bucket: registryBucket,
        Key: s3Key,
        Body: zipBuffer,
        ContentType: 'application/zip',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: registryKeyId,
        ChecksumAlgorithm: 'SHA256',
        Metadata: {
          'skill-name':   opts.name,
          'skill-version': opts.version,
          'author-arn':   identity.Arn!,
          'visibility':   opts.visibility,
          'description':  opts.description ?? manifest.jobName,
          'changelog':    opts.changelog ?? '',
          'tags':         tags.join(','),
        },
      }));

      console.log(chalk.green(`✓ Pushed: ${opts.name}@${opts.version}`));
      console.log(chalk.dim('  Validator Lambda is processing... status available in ~10 seconds.'));
      console.log(`\n  View: ${chalk.cyan(`skills-svc skill info ${opts.name}@${opts.version}`)}`);
      console.log(`  Run:  ${chalk.cyan(`skills-svc run --skill ${opts.name}@${opts.version} --job-name "my-run"`)}`);
    });

  // ── skill list ─────────────────────────────────────────────────────────
  cmd.command('list')
    .description('List skills in the registry')
    .option('--mine', 'Show only your skills', false)
    .option('--org', 'Show org-shared skills', false)
    .option('--tag <tag>', 'Filter by tag')
    .option('--limit <n>', 'Max results', '20')
    .option('--format <fmt>', 'Output: table|json', 'table')
    .action(async (opts: {
      mine: boolean;
      org: boolean;
      tag?: string;
      limit: string;
      format: string;
    }) => {
      const cfg    = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds  = await getCredentialProvider();
      const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const sts    = new STSClient({ region: cfg.region, credentials: creds });
      const ssm    = new SSMClient({ region: cfg.region, credentials: creds });

      const skillsTableName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/skills-table-name`,
      })).then(r => r.Parameter!.Value!);

      const limit = Math.min(parseInt(opts.limit, 10), 100);
      let items: any[] = [];

      if (opts.mine) {
        const identity = await sts.send(new GetCallerIdentityCommand({}));
        const res = await ddb.send(new QueryCommand({
          TableName: skillsTableName,
          IndexName: 'GSI1-Author',
          KeyConditionExpression: 'GSI1PK = :author',
          ExpressionAttributeValues: { ':author': `${SKILL_KEY_PREFIX.AUTHOR}${identity.Arn}` },
          ScanIndexForward: false,
          Limit: limit,
        }));
        items = res.Items ?? [];
      } else if (opts.tag) {
        const res = await ddb.send(new QueryCommand({
          TableName: skillsTableName,
          IndexName: 'GSI3-Tag',
          KeyConditionExpression: 'GSI3PK = :tag',
          ExpressionAttributeValues: { ':tag': `${SKILL_KEY_PREFIX.TAG}${opts.tag}` },
          ScanIndexForward: false,
          Limit: limit,
        }));
        items = res.Items ?? [];
      } else {
        // Default: org-visible skills
        const res = await ddb.send(new QueryCommand({
          TableName: skillsTableName,
          IndexName: 'GSI2-OrgSkills',
          KeyConditionExpression: 'GSI2PK = :vis',
          ExpressionAttributeValues: { ':vis': `${SKILL_KEY_PREFIX.VISIBILITY}org` },
          ScanIndexForward: false,
          Limit: limit,
        }));
        items = res.Items ?? [];
      }

      if (!items.length) {
        console.log(chalk.yellow('No skills found. Publish your first skill with: skills-svc skill push ./my-skill --name my-skill --version 1.0.0'));
        return;
      }

      if (opts.format === 'json') { prettyJson(items); return; }

      prettyTable([
        ['Skill', 'Latest', 'Visibility', 'Runs', 'Author', 'Updated'],
        ...items.map(item => [
          chalk.bold(item.skillName ?? item.name ?? ''),
          item.latestVersion ?? item.version ?? '',
          item.visibility === SkillVisibility.ORG ? chalk.cyan('org') : chalk.dim('private'),
          String(item.totalRuns ?? 0),
          (item.authorArn ?? '').split('/').pop() ?? '',
          new Date(item.updatedAt ?? item.publishedAt ?? 0).toLocaleDateString(),
        ]),
      ]);
    });

  // ── skill info ─────────────────────────────────────────────────────────
  cmd.command('info <skill-ref>')
    .description('Show detailed info for a skill. Use "name" or "name@version".')
    .option('--versions', 'List all published versions', false)
    .option('--runs', 'Show recent job runs that used this skill', false)
    .action(async (skillRef: string, opts: { versions: boolean; runs: boolean }) => {
      const { name, version } = parseSkillRef(skillRef);
      const cfg    = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds  = await getCredentialProvider();
      const ddb    = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const ssm    = new SSMClient({ region: cfg.region, credentials: creds });

      const skillsTableName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/skills-table-name`,
      })).then(r => r.Parameter!.Value!);

      // Fetch META record
      const metaRes = await ddb.send(new GetCommand({
        TableName: skillsTableName,
        Key: { PK: `${SKILL_KEY_PREFIX.SKILL}${name}`, SK: 'META' },
      }));
      if (!metaRes.Item) {
        console.error(chalk.red(`Skill not found: ${name}`));
        process.exit(1);
      }
      const meta = metaRes.Item as unknown as SkillMeta;

      // Resolve version
      const resolvedVersion = version ?? meta.latestStable ?? meta.latestVersion;

      // Fetch version record
      const versionRes = await ddb.send(new GetCommand({
        TableName: skillsTableName,
        Key: {
          PK: `${SKILL_KEY_PREFIX.SKILL}${name}`,
          SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(resolvedVersion)}`,
        },
      }));
      const ver = versionRes.Item as unknown as SkillVersion | undefined;

      console.log(chalk.bold(`\n${name}@${resolvedVersion}`));
      console.log(`  ${meta.description}\n`);

      prettyTable([
        ['Field', 'Value'],
        ['Latest version', meta.latestVersion],
        ['Latest stable',  meta.latestStable || '(none)'],
        ['Visibility',     meta.visibility],
        ['Author',         meta.authorArn.split('/').pop() ?? meta.authorArn],
        ['Tags',           meta.tags?.join(', ') || '(none)'],
        ['Total versions', String(meta.totalVersions)],
        ['Total runs',     String(meta.totalRuns)],
        ['Created',        new Date(meta.createdAt).toLocaleString()],
      ]);

      if (ver) {
        console.log(chalk.bold('\n  This version:'));
        prettyTable([
          ['Field', 'Value'],
          ['Status',         ver.deprecated ? chalk.yellow('deprecated') : chalk.green(ver.status)],
          ['Skills in zip',  ver.skills.join(', ')],
          ['Size',           `${(ver.sizeBytes / 1024).toFixed(1)} KB`],
          ['SHA256',         ver.zipSha256.slice(0, 16) + '...'],
          ['Published',      new Date(ver.publishedAt).toLocaleString()],
          ['Changelog',      ver.changelog || '(none)'],
          ...(ver.deprecated ? [['Deprecation', ver.deprecationMsg ?? '']] : []),
        ]);
      }

      if (opts.versions) {
        console.log(chalk.bold('\n  All versions:'));
        const versionsRes = await ddb.send(new QueryCommand({
          TableName: skillsTableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: {
            ':pk': `${SKILL_KEY_PREFIX.SKILL}${name}`,
            ':prefix': SKILL_KEY_PREFIX.VERSION,
          },
          ScanIndexForward: false,
        }));
        prettyTable([
          ['Version', 'Status', 'Published', 'Author'],
          ...(versionsRes.Items ?? []).map(v => [
            v.version,
            v.deprecated ? chalk.yellow('deprecated') : v.status === 'published' ? chalk.green('published') : chalk.red(v.status),
            new Date(v.publishedAt).toLocaleDateString(),
            (v.authorArn as string).split('/').pop() ?? '',
          ]),
        ]);
      }

      if (opts.runs) {
        console.log(chalk.bold('\n  Recent runs:'));
        const runsRes = await ddb.send(new QueryCommand({
          TableName: cfg.dynamodbTableName,
          IndexName: 'GSI5-Skill',
          KeyConditionExpression: 'GSI5PK = :sk',
          ExpressionAttributeValues: {
            ':sk': `${SKILL_KEY_PREFIX.SKILL}${name}#${resolvedVersion}`,
          },
          ScanIndexForward: false,
          Limit: 10,
        }));
        if (!runsRes.Items?.length) {
          console.log(chalk.dim('  No runs yet for this skill version.'));
        } else {
          prettyTable([
            ['Job ID', 'Job Name', 'Status', 'User', 'Date'],
            ...(runsRes.Items ?? []).map(job => [
              (job.jobId as string).slice(0, 8) + '...',
              job.jobName as string,
              job.status as string,
              (job.userArn as string).split('/').pop() ?? '',
              new Date(job.createdAt as string).toLocaleDateString(),
            ]),
          ]);
        }
      }
    });

  // ── skill pull ─────────────────────────────────────────────────────────
  cmd.command('pull <skill-ref>')
    .description('Download a skill zip from the registry. Use "name" or "name@version".')
    .option('--output <dir>', 'Output directory (default: ./<skill-name>)')
    .option('--unzip', 'Extract zip after downloading', false)
    .action(async (skillRef: string, opts: { output?: string; unzip: boolean }) => {
      const { name, version } = parseSkillRef(skillRef);
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const s3    = new S3Client({ region: cfg.region, credentials: creds });
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });

      const skillsTableName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/skills-table-name`,
      })).then(r => r.Parameter!.Value!);
      const registryBucket = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/bucket-name`,
      })).then(r => r.Parameter!.Value!);

      // Resolve version
      let resolvedVersion = version;
      if (!resolvedVersion || resolvedVersion === 'latest') {
        const metaRes = await ddb.send(new GetCommand({
          TableName: skillsTableName,
          Key: { PK: `${SKILL_KEY_PREFIX.SKILL}${name}`, SK: 'META' },
        }));
        if (!metaRes.Item) { console.error(chalk.red(`Skill not found: ${name}`)); process.exit(1); }
        resolvedVersion = metaRes.Item.latestStable ?? metaRes.Item.latestVersion;
      }

      const versionRes = await ddb.send(new GetCommand({
        TableName: skillsTableName,
        Key: {
          PK: `${SKILL_KEY_PREFIX.SKILL}${name}`,
          SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(resolvedVersion)}`,
        },
      }));

      if (!versionRes.Item) {
        console.error(chalk.red(`Version not found: ${name}@${resolvedVersion}`));
        process.exit(1);
      }
      if (versionRes.Item.deprecated) {
        console.warn(chalk.yellow(`⚠  ${name}@${resolvedVersion} is deprecated: ${versionRes.Item.deprecationMsg ?? ''}`));
      }

      const s3Key = versionRes.Item.s3Key as string;
      const outDir = opts.output ?? `./${name}`;
      const outFile = path.join(outDir, `${name}-${resolvedVersion}.zip`);
      mkdirSync(outDir, { recursive: true });

      console.log(chalk.blue(`Downloading ${name}@${resolvedVersion}...`));
      const obj = await s3.send(new GetObjectCommand({ Bucket: registryBucket, Key: s3Key }));
      await pipeline(obj.Body as Readable, createWriteStream(outFile));
      console.log(chalk.green(`✓ Downloaded: ${outFile}`));

      if (opts.unzip) {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(outFile);
        zip.extractAllTo(outDir, true);
        console.log(chalk.green(`✓ Extracted to: ${outDir}`));
      }
    });

  // ── skill deprecate ────────────────────────────────────────────────────
  cmd.command('deprecate <skill-ref>')
    .description('Mark a skill version as deprecated. Use "name@version".')
    .requiredOption('--message <msg>', 'Deprecation message (e.g. "Use eigenvalue-v2@2.0.0 instead")')
    .action(async (skillRef: string, opts: { message: string }) => {
      const { name, version } = parseSkillRef(skillRef);
      if (!version) { console.error(chalk.red('Must specify version: skill-name@1.0.0')); process.exit(1); }

      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });
      const sts   = new STSClient({ region: cfg.region, credentials: creds });

      const skillsTableName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/skills-table-name`,
      })).then(r => r.Parameter!.Value!);
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      // Verify ownership
      const versionRes = await ddb.send(new GetCommand({
        TableName: skillsTableName,
        Key: {
          PK: `${SKILL_KEY_PREFIX.SKILL}${name}`,
          SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(version)}`,
        },
      }));
      if (!versionRes.Item) { console.error(chalk.red(`Version not found: ${name}@${version}`)); process.exit(1); }
      if (versionRes.Item.authorArn !== identity.Arn) {
        console.error(chalk.red('Only the original author can deprecate a skill version'));
        process.exit(1);
      }

      await ddb.send(new UpdateCommand({
        TableName: skillsTableName,
        Key: {
          PK: `${SKILL_KEY_PREFIX.SKILL}${name}`,
          SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(version)}`,
        },
        UpdateExpression: 'SET deprecated = :true, deprecatedAt = :now, deprecationMsg = :msg, #status = :dep',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':true': true,
          ':now': new Date().toISOString(),
          ':msg': opts.message,
          ':dep': SkillStatus.DEPRECATED,
        },
      }));

      console.log(chalk.yellow(`✓ ${name}@${version} marked as deprecated`));
      console.log(`  Message: ${opts.message}`);
      console.log(chalk.dim('  Note: existing jobs that used this skill are not affected. Future submissions will show a deprecation warning.'));
    });

  return cmd;
}

// ── skill ref resolution ─────────────────────────────────────────────────

export function parseSkillRef(ref: string): { name: string; version?: string } {
  const atIndex = ref.lastIndexOf('@');
  if (atIndex === -1) return { name: ref };
  return { name: ref.slice(0, atIndex), version: ref.slice(atIndex + 1) };
}
```

---

## 8. `skills-svc run` — Submit Job via Skill Reference

New command that replaces `upload` when using a registry skill.

### `packages/cli/src/commands/run.ts`

```typescript
import { Command } from 'commander';
import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { SKILL_KEY_PREFIX, padSemver, SkillStatus } from '@skills-svc/shared';
import { parseSkillRef } from './skill';
import { streamJobLogs } from '../utils/log-streamer';
import { prettyTable } from '../utils/pretty-print';

export function runCommand(): Command {
  return new Command('run')
    .description('Run a skill from the registry by name (without re-uploading)')
    .requiredOption('--skill <ref>', 'Skill reference: "name" or "name@version" or "name@latest"')
    .requiredOption('--job-name <name>', 'Job name for this run')
    .option('--prompt <prompt>', 'Override the skill\'s default prompt')
    .option('--stream', 'Stream ECS task logs to stdout', false)
    .option('--stream-timeout <s>', 'Max stream seconds', '1800')
    .option('--no-cache', 'Skip result cache check', false)
    .action(async (opts: {
      skill: string;
      jobName: string;
      prompt?: string;
      stream: boolean;
      streamTimeout: string;
      cache: boolean;
    }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const s3    = new S3Client({ region: cfg.region, credentials: creds });
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });
      const sts   = new STSClient({ region: cfg.region, credentials: creds });

      const { name, version: requestedVersion } = parseSkillRef(opts.skill);
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      // Resolve skill + version from registry
      const skillsTableName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/skills-table-name`,
      })).then(r => r.Parameter!.Value!);

      const metaRes = await ddb.send(new GetCommand({
        TableName: skillsTableName,
        Key: { PK: `${SKILL_KEY_PREFIX.SKILL}${name}`, SK: 'META' },
      }));
      if (!metaRes.Item) {
        console.error(chalk.red(`Skill not found: ${name}`));
        console.log(`  Available: ${chalk.cyan('skills-svc skill list')}`);
        process.exit(1);
      }

      const resolvedVersion = (requestedVersion === 'latest' || !requestedVersion)
        ? (metaRes.Item.latestStable ?? metaRes.Item.latestVersion)
        : requestedVersion;

      const versionRes = await ddb.send(new GetCommand({
        TableName: skillsTableName,
        Key: {
          PK: `${SKILL_KEY_PREFIX.SKILL}${name}`,
          SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(resolvedVersion)}`,
        },
      }));

      if (!versionRes.Item) {
        console.error(chalk.red(`Version not found: ${name}@${resolvedVersion}`));
        process.exit(1);
      }

      if (versionRes.Item.status !== SkillStatus.PUBLISHED) {
        console.error(chalk.red(`Skill ${name}@${resolvedVersion} is not published (status: ${versionRes.Item.status})`));
        process.exit(1);
      }

      if (versionRes.Item.deprecated) {
        console.warn(chalk.yellow(`⚠  ${name}@${resolvedVersion} is deprecated: ${versionRes.Item.deprecationMsg}`));
        console.warn(chalk.yellow('   Continuing — use a newer version when possible.'));
      }

      // Copy registry zip to uploads prefix to trigger ingestion pipeline
      // This is the same pattern as the schedule trigger Lambda
      const registryBucket  = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/registry/bucket-name`,
      })).then(r => r.Parameter!.Value!);

      const uploadsBucket = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/s3/uploads-bucket`,
      })).then(r => r.Parameter!.Value!);

      const uploadsKmsKeyId = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/kms/uploads-key-id`,
      })).then(r => r.Parameter!.Value!);

      const registryS3Key = versionRes.Item.s3Key as string;
      const runId         = randomUUID();
      const uploadsKey    = `uploads/${runId}/${name}-${resolvedVersion}.zip`;

      console.log(chalk.blue(`Running ${name}@${resolvedVersion}...`));

      // Cross-bucket copy: registry → uploads (triggers S3 event → ingestion pipeline)
      await s3.send(new CopyObjectCommand({
        Bucket:               uploadsBucket,
        CopySource:           `${registryBucket}/${registryS3Key}`,
        Key:                  uploadsKey,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId:          uploadsKmsKeyId,
        MetadataDirective:    'REPLACE',
        Metadata: {
          'job-name':       opts.jobName,
          'user-arn':       identity.Arn!,
          'skill-name':     name,
          'skill-version':  resolvedVersion,
          'run-id':         runId,
          ...(opts.prompt ? { 'prompt-override': opts.prompt } : {}),
          ...(opts.cache  ? {} : { 'no-cache': 'true' }),
        },
      }));

      prettyTable([
        ['Field', 'Value'],
        ['Skill',    `${name}@${resolvedVersion}`],
        ['Job Name', opts.jobName],
        ['Run ID',   runId],
        ['Status',   chalk.yellow('PENDING')],
      ]);

      if (opts.stream) {
        // Resolve job ID and stream (same logic as upload --stream)
        console.log(chalk.dim('\nStreaming logs...'));
        const { DynamoDBDocumentClient: DDC, QueryCommand } = require('@aws-sdk/lib-dynamodb');
        const ddb2 = DDC.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
        let jobId: string | undefined;
        const pollStart = Date.now();
        while (!jobId && Date.now() - pollStart < 30_000) {
          await new Promise(r => setTimeout(r, 2_000));
          const res = await ddb2.send(new QueryCommand({
            TableName: cfg.dynamodbTableName,
            IndexName: 'GSI2-User',
            KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK >= :since',
            ExpressionAttributeValues: {
              ':pk': `USER#${identity.Arn}`,
              ':since': `CREATED_AT#${new Date(Date.now() - 60_000).toISOString()}`,
            },
            ScanIndexForward: false,
            Limit: 1,
          }));
          const candidate = res.Items?.[0];
          if (candidate?.skillName === name && candidate?.skillVersion === resolvedVersion) {
            jobId = candidate.jobId as string;
          }
        }
        if (jobId) {
          await streamJobLogs({ jobId, cfg, timeoutMs: parseInt(opts.streamTimeout, 10) * 1000 });
        } else {
          console.log(chalk.yellow('Could not resolve job ID for streaming.'));
        }
      } else {
        console.log(`\nTrack: ${chalk.cyan(`skills-svc list-jobs --status PENDING`)}`);
      }
    });
}
```

---

## 9. Updated `packages/cli/src/index.ts`

```typescript
import { skillCommand } from './commands/skill';
import { runCommand }   from './commands/run';
import { mcpConfigCommand } from './commands/mcp-config'; // from SPEC-09

program.addCommand(skillCommand());
program.addCommand(runCommand());
program.addCommand(mcpConfigCommand());
```

---

## 10. Updated MCP Tool: `submit_job`

The `submit_job` MCP tool gains a `skill_ref` alternative to `zip_base64`:

```typescript
// Add to submit_job inputSchema.properties:
skill_ref: {
  type: 'string',
  description: 'Registry skill reference e.g. "eigenvalue-analyzer" or "eigenvalue-analyzer@1.2.0". Use instead of zip_base64 when the skill is already in the registry.',
},

// Updated execute():
if (args.skill_ref && !args.zip_base64) {
  // Resolve from registry and trigger via S3 copy (same as `run` command)
  // ... same CopyObjectCommand logic as run.ts
  return [{ type: 'text', text: `✅ Run submitted: ${args.skill_ref}\n\nUse job_status or list_jobs to track progress.` }];
}
```

---

## 11. Updated OpenSearch Index (knowledge store)

Add `skill_name` and `skill_version` to the `skills-results` index mapping (already in SPEC-03):

```json
"skill_name":    { "type": "keyword" },
"skill_version": { "type": "keyword" }
```

Update `indexer.ts` to populate these fields when present on the `RunResult`.

---

## 12. `CliConfig` Update

Add to `packages/cli/src/utils/config.ts`:

```typescript
export interface CliConfig {
  // ... existing fields ...
  registryBucket: string;       // NEW
  skillsTableName: string;      // NEW
  registryKmsKeyId: string;     // NEW
}
```

`configure` command auto-discovers these from CloudFormation outputs or SSM.

---

## 13. QA Checks (QA-145 through QA-160)

```typescript
// QA-145: SkillRegistryStack creates registry bucket with ObjectLock COMPLIANCE
test('QA-145: Registry bucket has ObjectLock in COMPLIANCE mode', () => {
  const { templates } = buildTestApp();
  templates.skillRegistry.hasResourceProperties('AWS::S3::Bucket', {
    ObjectLockEnabled: true,
    ObjectLockConfiguration: {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: 2555 } },
    },
  });
});

// QA-146: Registry bucket denies DeleteObject
test('QA-146: Registry bucket policy denies DeleteObject', () => {
  const { templates } = buildTestApp();
  const policies = templates.skillRegistry.findResources('AWS::S3::BucketPolicy');
  const registryPolicy = Object.values(policies).find((p: any) =>
    JSON.stringify(p).includes('registry')
  ) as any;
  expect(registryPolicy).toBeDefined();
  const stmts = registryPolicy.Properties.PolicyDocument.Statement;
  const denyDelete = stmts.find((s: any) =>
    s.Effect === 'Deny' &&
    (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('s3:DeleteObject')
  );
  expect(denyDelete).toBeDefined();
});

// QA-147: SkillsTable has exactly 3 GSIs
test('QA-147: Skills DDB table has exactly 3 GSIs', () => {
  const { templates } = buildTestApp();
  const tables = templates.skillRegistry.findResources('AWS::DynamoDB::Table');
  const skillsTable = Object.values(tables).find((t: any) =>
    JSON.stringify(t).includes('GSI1-Author')
  ) as any;
  expect(skillsTable).toBeDefined();
  expect(skillsTable.Properties.GlobalSecondaryIndexes).toHaveLength(3);
});

// QA-148: padSemver sorts correctly
test('QA-148: padSemver sorts version strings correctly in DDB', () => {
  const versions = ['1.12.0', '1.2.0', '2.0.0', '1.0.10'];
  const padded   = versions.map(padSemver).sort();
  // Expected sort: 001.000.010, 001.002.000, 001.012.000, 002.000.000
  expect(padded[0]).toBe(padSemver('1.0.10'));
  expect(padded[1]).toBe(padSemver('1.2.0'));
  expect(padded[2]).toBe(padSemver('1.12.0'));
  expect(padded[3]).toBe(padSemver('2.0.0'));
});

// QA-149: isValidSemver accepts valid versions
test('QA-149: isValidSemver accepts valid semver strings', () => {
  expect(isValidSemver('1.0.0')).toBe(true);
  expect(isValidSemver('1.12.0')).toBe(true);
  expect(isValidSemver('2.0.0-alpha.1')).toBe(true);
  expect(isValidSemver('3.1.4-beta')).toBe(true);
  expect(isValidSemver('0.0.1')).toBe(true);
});

// QA-150: isValidSemver rejects invalid versions
test('QA-150: isValidSemver rejects invalid semver strings', () => {
  expect(isValidSemver('1.0')).toBe(false);
  expect(isValidSemver('v1.0.0')).toBe(false);
  expect(isValidSemver('latest')).toBe(false);
  expect(isValidSemver('1')).toBe(false);
  expect(isValidSemver('')).toBe(false);
});

// QA-151: isPrerelease correctly identifies prerelease versions
test('QA-151: isPrerelease returns true only for prerelease versions', () => {
  expect(isPrerelease('1.0.0-alpha.1')).toBe(true);
  expect(isPrerelease('2.0.0-beta')).toBe(true);
  expect(isPrerelease('1.0.0')).toBe(false);
  expect(isPrerelease('2.0.0')).toBe(false);
});

// QA-152: isHigherVersion is mathematically correct
test('QA-152: isHigherVersion correctly orders versions', () => {
  expect(isHigherVersion('1.2.0', '1.1.0')).toBe(true);
  expect(isHigherVersion('2.0.0', '1.9.9')).toBe(true);
  expect(isHigherVersion('1.0.10', '1.0.9')).toBe(true);
  expect(isHigherVersion('1.0.0', '1.0.0')).toBe(false); // equal is not higher
  expect(isHigherVersion('1.0.0', '1.0.1')).toBe(false);
});

// QA-153: skill push rejects invalid name format
test('QA-153: skill push rejects name with uppercase or spaces', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  await expect(runSkillPush({ name: 'My Skill', version: '1.0.0' })).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-154: skill push rejects invalid semver
test('QA-154: skill push rejects non-semver version string', async () => {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  await expect(runSkillPush({ name: 'my-skill', version: 'v1.0' })).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-155: skill push is idempotent — rejects re-publish of same version
test('QA-155: skill push rejects publishing an already-published version', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({ Item: { status: SkillStatus.PUBLISHED } });
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  await expect(runSkillPush({ name: 'my-skill', version: '1.0.0' })).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-156: validator Lambda rejects invalid semver in S3 key
test('QA-156: validator handler writes FAILED status for invalid semver in S3 key', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(PutCommand).resolves({});
  const s3Mock = mockClient(S3Client);
  s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1024, Metadata: {} });

  await handler(makeS3Event('skills/alice/my-skill/not-semver/skill.zip'), {} as any, {} as any);

  const putCall = ddbMock.commandCalls(PutCommand)[0];
  expect(putCall.args[0].input.Item.status).toBe(SkillStatus.FAILED);
  expect(putCall.args[0].input.Item.validationError).toMatch(/semver/i);
});

// QA-157: validator Lambda sets latestStable correctly for stable versions
test('QA-157: validator writes latestStable when version is not prerelease', async () => {
  // Simulate: no existing META, version = '1.2.0' (stable)
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({ Item: null }); // no existing META or version
  ddbMock.on(PutCommand).resolves({});
  // ... trigger handler ...
  const metaPut = ddbMock.commandCalls(PutCommand).find(c =>
    c.args[0].input.Item?.SK === 'META'
  );
  expect(metaPut?.args[0].input.Item.latestStable).toBe('1.2.0');
});

// QA-158: validator Lambda does NOT set latestStable for prerelease
test('QA-158: validator leaves latestStable empty for prerelease version', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({ Item: null });
  ddbMock.on(PutCommand).resolves({});
  // Trigger handler with version '2.0.0-beta.1'
  const metaPut = ddbMock.commandCalls(PutCommand).find(c =>
    c.args[0].input.Item?.SK === 'META'
  );
  expect(metaPut?.args[0].input.Item.latestStable).toBe('');
});

// QA-159: parseSkillRef handles all valid formats
test('QA-159: parseSkillRef correctly parses skill references', () => {
  expect(parseSkillRef('my-skill')).toEqual({ name: 'my-skill', version: undefined });
  expect(parseSkillRef('my-skill@1.0.0')).toEqual({ name: 'my-skill', version: '1.0.0' });
  expect(parseSkillRef('my-skill@latest')).toEqual({ name: 'my-skill', version: 'latest' });
  expect(parseSkillRef('my-skill@2.0.0-beta.1')).toEqual({ name: 'my-skill', version: '2.0.0-beta.1' });
});

// QA-160: run command triggers S3 cross-bucket copy with correct metadata
test('QA-160: run command CopyObject includes skill-name and skill-version metadata', async () => {
  const s3Mock = mockClient(S3Client);
  s3Mock.on(CopyObjectCommand).resolves({});
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand)
    .resolvesOnce({ Item: { latestVersion: '1.0.0', latestStable: '1.0.0' } }) // META
    .resolvesOnce({ Item: { s3Key: 'skills/alice/my-skill/1.0.0/skill.zip', status: 'published', deprecated: false } }); // VERSION

  await runRun({ skill: 'my-skill', jobName: 'test-run', stream: false, cache: true });

  const copyCall = s3Mock.commandCalls(CopyObjectCommand)[0];
  expect(copyCall.args[0].input.Metadata?.['skill-name']).toBe('my-skill');
  expect(copyCall.args[0].input.Metadata?.['skill-version']).toBe('1.0.0');
  expect(copyCall.args[0].input.Key).toMatch(/^uploads\//);
});
```

---

## 14. Summary of Changes

### New Files

```
packages/lambda/src/
└── skill-validator/
    └── handler.ts        Validates zip on push, writes DDB metadata, updates latest pointer

packages/cli/src/
├── commands/
│   ├── skill.ts          push / list / info / pull / deprecate
│   └── run.ts            run a skill from registry by reference

packages/shared/src/
└── types.ts              UPDATED — SkillMeta, SkillVersion, SkillRef, SKILL_KEY_PREFIX,
                          padSemver, isValidSemver, isPrerelease, isHigherVersion

infra/lib/
└── skill-registry-stack.ts   NEW — registry S3 bucket, skills DDB table, validator Lambda
```

### Updated Files

| File | Change |
|------|--------|
| `infra/lib/security-stack.ts` | Add `registryBucketKey` KMS key |
| `infra/lib/storage-stack.ts` | Add GSI5 (skill → jobs) to jobs table |
| `infra/bin/app.ts` | Add `SkillRegistryStack` with dependency wiring |
| `packages/lambda/src/ingestion/handler.ts` | Record `skillName`/`skillVersion`, increment `totalRuns` |
| `packages/lambda/src/mcp/tools/submit-job.ts` | Accept `skill_ref` as alternative to `zip_base64` |
| `packages/cli/src/index.ts` | Register `skillCommand()` and `runCommand()` |
| `packages/cli/src/utils/config.ts` | Add `registryBucket`, `skillsTableName`, `registryKmsKeyId` |

### S3 Key Layout

```
skills-svc-registry-{account}-{region}/
└── skills/
    └── {authorId}/
        └── {skillName}/
            └── {version}/
                └── skill.zip     ← immutable, KMS encrypted, ObjectLock COMPLIANCE

skills-svc-uploads-{account}-{region}/
└── uploads/
    ├── {uuid}/skill.zip           ← direct upload (existing)
    └── {uuid}/{name}-{ver}.zip    ← copied from registry by `run` command (NEW)
```
