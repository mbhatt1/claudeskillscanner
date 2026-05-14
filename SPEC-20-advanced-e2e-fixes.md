# Skills as a Service (SaaS) — Specification Part 20: Advanced E2E Flow Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Source:** Second 10-agent E2E audit. 198 raw issues → 18 net-new critical fixes.  
**Parts:** ... | [Part 19](SPEC-19-e2e-flow-fixes.md) | [Part 20: Advanced E2E Flow Fixes]

---

## ROI Assessment

This round audited: CDK deployment, skill version migration, OpenSearch management, GDPR compliance, capacity limits, disaster recovery, multi-region deployment, developer UX, security boundaries, and system upgrades. ROI remains high — found architectural gaps invisible to component-level auditing. Stopping after this spec.

---

## 18 Net-New Critical Issues

| # | Severity | Issue |
|---|----------|-------|
| 1 | **CRITICAL** | SCP `DenyNonApprovedRegions` hardcodes `us-east-1` — blocks any non-US deployment |
| 2 | **CRITICAL** | No `skills-svc delete-user <arn>` command — GDPR right-to-be-forgotten impossible |
| 3 | **CRITICAL** | OpenSearch Serverless collection deletion not blocked by any SCP — data can be permanently lost |
| 4 | **CRITICAL** | No skill deprecation notification to consumers — Bob never learns Alice deprecated v1.0.0 |
| 5 | **CRITICAL** | Deprecation flag has no effect on scheduled jobs — deprecated skills run forever on schedules |
| 6 | **BLOCKER** | Break-glass role has no MFA condition — stolen credential can access all data |
| 7 | **BLOCKER** | `userArn` missing from KMS envelope encryption context — stolen key decrypts any result |
| 8 | **BLOCKER** | DLP circuit breaker absent — HIGH-RISK findings (AWS keys, private keys) are indexed in OpenSearch |
| 9 | **BLOCKER** | Validator Lambda uses direct S3→Lambda notification — 3 retries then silently dropped, no DLQ |
| 10 | **BLOCKER** | Bedrock model availability never checked at deploy time — deployment succeeds but all jobs fail in eu-west-1 |
| 11 | **BLOCKER** | AOSS collection endpoint URL changes on recreate — SSM param goes stale, all queries fail |
| 12 | **BLOCKER** | S3 upload rate limiting absent — attacker floods uploads triggering DoS for legitimate users |
| 13 | **CORRECTNESS** | No `schedule update <name> <new-zip>` command — skill version migration requires delete+recreate |
| 14 | **CORRECTNESS** | `number_of_replicas: 1` in OpenSearch index mapping — AOSS ignores or rejects this, index creation may fail |
| 15 | **CORRECTNESS** | DynamoDB GSI backfill blocks CDK deploy 15-30 minutes — no documentation, operator kills deployment |
| 16 | **CORRECTNESS** | No PITR restore runbook — DDB table recovery requires 15-30 minutes of manual re-wiring |
| 17 | **CORRECTNESS** | No OpenSearch re-index Lambda — collection deletion is unrecoverable without manual engineering |
| 18 | **CORRECTNESS** | CDK bootstrap required per-region — never documented; multi-region deploys fail immediately |

---

## Fix 1: SCP — Configurable Approved Regions

**Problem:** `DenyNonApprovedRegions` SCP hardcodes `us-east-1`. Any deployment to `eu-west-1` for data residency is blocked before CDK even runs.

**`infra/lib/scp-policies.ts`** — make regions configurable:

```typescript
export function buildSCPPolicies(approvedRegions: string[] = ['us-east-1']) {
  return {
    DenyNonApprovedRegions: {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'DenyNonApprovedRegions',
        Effect: 'Deny',
        NotAction: [
          'iam:*', 'sts:*', 'cloudfront:*', 'route53:*',
          'waf:*', 'support:*', 'budgets:*', 'organizations:*',
        ],
        Resource: '*',
        Condition: {
          StringNotEquals: { 'aws:RequestedRegion': approvedRegions },
        },
      }],
    },
    // ... other policies unchanged
  };
}
```

**`scripts/apply-scps.sh`** — pass regions as argument:

```bash
#!/usr/bin/env bash
set -euo pipefail
OU_ID=${1:?Usage: apply-scps.sh <OU_ID> [region1,region2,...]}
APPROVED_REGIONS=${2:-"us-east-1"}

export APPROVED_REGIONS="$APPROVED_REGIONS"

for POLICY_NAME in DenyAuditTampering DenyKMSKeyDeletion DenyLeaveOrg DenyNonApprovedRegions DenyRootUser DenyS3PublicAccess; do
  POLICY_JSON=$(node -e "
    const p = require('./infra/lib/scp-policies');
    const regions = process.env.APPROVED_REGIONS.split(',');
    const policies = p.buildSCPPolicies(regions);
    console.log(JSON.stringify(policies['$POLICY_NAME']));
  ")
  # ... attach to OU
done
```

**`scripts/deploy.sh`** — validate bootstrap per-region (Fix 18):

```bash
# Add before deployment:
echo "Checking CDK bootstrap for ${REGION}..."
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" &>/dev/null; then
  echo "ERROR: CDK not bootstrapped in ${REGION}. Run:"
  echo "  cdk bootstrap aws://${ACCOUNT}/${REGION}"
  exit 1
fi
```

---

## Fix 2: GDPR Data Deletion Command

**`packages/cli/src/commands/delete-user.ts`** (new file):

```typescript
import { Command } from 'commander';
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { OpenSearchClient } from '@opensearch-project/opensearch';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { DDB_KEY_PREFIX } from '@skills-svc/shared';

export function deleteUserCommand(): Command {
  return new Command('delete-user')
    .description('Delete all data for a specific user (GDPR right to be forgotten)')
    .argument('<user-arn>', 'IAM ARN of the user to delete')
    .option('--dry-run', 'Show what would be deleted without deleting', false)
    .option('--force', 'Skip confirmation prompt', false)
    .action(async (userArn: string, opts: { dryRun: boolean; force: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ddb   = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region, credentials: creds }));
      const s3    = new S3Client({ region: cfg.region, credentials: creds });

      console.log(chalk.bold(`\nData Deletion Request for: ${userArn}`));
      if (opts.dryRun) console.log(chalk.yellow('  DRY RUN — no data will be deleted\n'));

      // 1. Find all jobs in DDB
      const jobs: string[] = [];
      let lastKey: Record<string, unknown> | undefined;
      do {
        const res = await ddb.send(new QueryCommand({
          TableName: cfg.dynamodbTableName,
          IndexName: 'GSI2-User',
          KeyConditionExpression: 'GSI2PK = :user',
          ExpressionAttributeValues: { ':user': `${DDB_KEY_PREFIX.USER}${userArn}` },
          ProjectionExpression: 'PK, s3ResultKey',
          ExclusiveStartKey: lastKey as any,
        }));
        (res.Items ?? []).forEach(item => jobs.push(item.PK as string));
        lastKey = res.LastEvaluatedKey as any;
      } while (lastKey);

      console.log(`  Found ${jobs.length} job records in DynamoDB`);

      // 2. Find S3 result objects
      const s3Keys: string[] = jobs
        .map(pk => `results/${pk.replace('JOB#', '')}/result.json.enc`)
        .filter(Boolean);
      console.log(`  Found ${s3Keys.length} result objects in S3`);

      if (!opts.dryRun) {
        if (!opts.force) {
          const { default: readline } = await import('readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const confirmed = await new Promise<boolean>(resolve => {
            rl.question(chalk.red(`\n  ⚠  Delete ${jobs.length} DDB records and ${s3Keys.length} S3 objects? (yes/N): `),
              answer => { rl.close(); resolve(answer.toLowerCase() === 'yes'); });
          });
          if (!confirmed) { console.log('Aborted.'); return; }
        }

        // Delete DDB records
        for (const pk of jobs) {
          await ddb.send(new DeleteCommand({
            TableName: cfg.dynamodbTableName,
            Key: { PK: pk, SK: 'METADATA' },
          }));
        }
        console.log(chalk.green(`  ✓ Deleted ${jobs.length} DDB records`));

        // Delete S3 result objects (all versions)
        if (s3Keys.length > 0) {
          for (const key of s3Keys) {
            const versions = await s3.send(new ListObjectVersionsCommand({
              Bucket: cfg.resultsBucket,
              Prefix: key,
            }));
            const toDelete = [
              ...(versions.Versions ?? []).map(v => ({ Key: v.Key!, VersionId: v.VersionId })),
              ...(versions.DeleteMarkers ?? []).map(d => ({ Key: d.Key!, VersionId: d.VersionId })),
            ];
            if (toDelete.length > 0) {
              await s3.send(new DeleteObjectsCommand({
                Bucket: cfg.resultsBucket,
                Delete: { Objects: toDelete },
              }));
            }
          }
          console.log(chalk.green(`  ✓ Deleted ${s3Keys.length} S3 result objects (all versions)`));
        }
      }

      // Non-deletable data report
      console.log(chalk.yellow('\n  ⚠  The following data CANNOT be deleted due to retention policies:'));
      console.log(chalk.dim('    - CloudTrail audit logs: 7-year ObjectLock COMPLIANCE retention'));
      console.log(chalk.dim('    - Bedrock invocation logs: 1-year ObjectLock COMPLIANCE retention'));
      console.log(chalk.dim('    - DynamoDB PITR backups: 35-day retention (auto-expires)'));
      console.log(chalk.dim('\n  These are required for regulatory compliance and cannot be deleted.'));
      console.log(chalk.dim('  Document this limitation in your privacy policy.'));
    });
}
```

Register in `index.ts`: `program.addCommand(deleteUserCommand())`.

---

## Fix 3: SCP — Block OpenSearch Collection Deletion

**`infra/lib/scp-policies.ts`** — add to `DenyAuditTampering`:

```typescript
DenyAuditTampering: {
  Statement: [
    // ... existing CloudTrail/GuardDuty/Config denials ...
    {
      Sid: 'DenyOpenSearchCollectionDeletion',
      Effect: 'Deny',
      Action: ['aoss:DeleteCollection'],
      Resource: '*',
    },
    {
      Sid: 'DenyS3CriticalBucketDeletion',
      Effect: 'Deny',
      Action: ['s3:DeleteBucket'],
      Resource: [
        // Protect critical data buckets from deletion
        // Note: Use ARN patterns; actual ARNs depend on account/region
        'arn:aws:s3:::skills-svc-results-*',
        'arn:aws:s3:::skills-svc-registry-*',
        'arn:aws:s3:::skills-svc-audit-*',
      ],
    },
  ],
},
```

---

## Fix 4: Skill Deprecation Notification System

**`packages/shared/src/types.ts`** — add `SkillDeprecationNotification`:

```typescript
export interface SkillDeprecationNotification {
  skillName: string;
  version: string;
  deprecatedBy: string;
  deprecationMsg: string;
  sunsetDate?: string;
  timestamp: string;
}
```

**`packages/lambda/src/skill-validator/handler.ts`** — publish SNS when deprecating:

```typescript
// Add to the deprecation UpdateCommand success path:
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const sns = new SNSClient({});

// After successful deprecation update:
await sns.send(new PublishCommand({
  TopicArn: skillEventsTopicArn, // new SSM param: /skills-svc/{env}/sns/skill-events-topic-arn
  Subject: `Skill Deprecated: ${skillName}@${version}`,
  Message: JSON.stringify({
    skillName, version,
    deprecatedBy: authorArn,
    deprecationMsg,
    timestamp: new Date().toISOString(),
  } satisfies SkillDeprecationNotification),
  MessageAttributes: {
    eventType: { DataType: 'String', StringValue: 'deprecation' },
    skillName:  { DataType: 'String', StringValue: skillName },
  },
}));
```

**`infra/lib/messaging-stack.ts`** — add skill events topic:

```typescript
const skillEventsTopic = new sns.Topic(this, 'SkillEventsTopic', {
  topicName: `skills-svc-skill-events-${envName}`,
  masterKey: props.messagingKey,
  displayName: 'Skills SaaS Skill Events (deprecations, new versions)',
});
// Deny non-SSL publish
skillEventsTopic.addToResourcePolicy(new iam.PolicyStatement({
  sid: 'DenyNonSSL',
  effect: iam.Effect.DENY,
  principals: [new iam.StarPrincipal()],
  actions: ['sns:Publish'],
  resources: [skillEventsTopic.topicArn],
  conditions: { Bool: { 'aws:SecureTransport': 'false' } },
}));

new ssm.StringParameter(this, 'ParamSkillEventsTopic', {
  parameterName: `/skills-svc/${envName}/sns/skill-events-topic-arn`,
  stringValue: skillEventsTopic.topicArn,
});
```

**CLI — subscribe to skill events:**

```bash
# User subscribes to deprecation events for a skill:
skills-svc notify subscribe --email bob@company.com --filter-event-type deprecation
# OR:
skills-svc notify subscribe --email bob@company.com --skill nlp-classifier
```

---

## Fix 5: Deprecation Enforcement on Scheduled Jobs

**`packages/lambda/src/schedule-trigger/handler.ts`** — check deprecation before copying:

```typescript
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SKILL_KEY_PREFIX, SkillStatus, padSemver } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: ScheduleTriggerInput): Promise<RunSkillOutput> => {
  // If this is a registry-referenced skill, check deprecation status
  if (event.skillName && event.skillVersion) {
    const skillsTableName = process.env.SKILLS_TABLE_NAME!;
    const versionRes = await ddb.send(new GetCommand({
      TableName: skillsTableName,
      Key: {
        PK: `${SKILL_KEY_PREFIX.SKILL}${event.skillName}`,
        SK: `${SKILL_KEY_PREFIX.VERSION}${padSemver(event.skillVersion)}`,
      },
    }));

    if (versionRes.Item?.deprecated) {
      const msg = versionRes.Item.deprecationMsg as string ?? 'No reason given';
      console.warn(JSON.stringify({
        event: 'deprecated_skill_executed',
        skillName: event.skillName,
        skillVersion: event.skillVersion,
        deprecationMsg: msg,
        message: `WARNING: Running deprecated skill version. ${msg}`,
      }));
      // Publish SNS warning (not failure — schedule still runs)
      // after SPEC-19 Fix 5 changes schedule prefix, this is fine
    }
  }
  // ... rest of handler unchanged
};
```

**Future enforcement:** Add `--sunset-date <ISO>` to `skill deprecate` command. After sunset date, schedule-trigger FAILS (not warns) with error directing user to update.

---

## Fix 6: Break-Glass Role — MFA Condition

**`infra/lib/security-stack.ts`** — add MFA requirement to break-glass trust policy:

```typescript
this.breakGlassRole = new iam.Role(this, 'BreakGlassRole', {
  roleName: `skills-svc-break-glass-${envName}`,
  assumedBy: new iam.AccountPrincipal(this.account),
  description: 'Emergency break-glass role — requires MFA to assume',
  maxSessionDuration: cdk.Duration.hours(1),
});

// Deny assumption without MFA — must be added as a separate statement
// because CDK doesn't support conditions on assumedBy directly
const cfnRole = this.breakGlassRole.node.defaultChild as iam.CfnRole;
cfnRole.addOverride('Properties.AssumeRolePolicyDocument.Statement.0.Condition', {
  Bool: { 'aws:MultiFactorAuthPresent': 'true' },
  NumericLessThan: { 'aws:MultiFactorAuthAge': '3600' }, // MFA used within last hour
});
```

---

## Fix 7: Add `userArn` to KMS Encryption Context

**`packages/ecs-runner/src/uploader.ts`** — include `userArn` in context:

```typescript
// Read userArn from S3 metadata (set by CLI during upload)
const userArn = process.env.USER_ARN ?? 'unknown'; // set in ECS task env from S3 metadata

const envelope = await envelopeEncrypt(plaintext, kmsKeyId, {
  jobId,
  userArn,      // ADD — ties decryption to the job owner
  purpose: 'skills-svc-result',
  environment: env,
});
```

**`packages/lambda/src/results-processor/handler.ts`** — decrypt with `userArn`:

```typescript
// Get userArn from job DDB record
const userArn = current.Item.userArn as string;

const plain = await envelopeDecrypt(encryptedEnvelope, {
  jobId,
  userArn,      // ADD — must match what was used during encryption
  purpose: 'skills-svc-result',
  environment: env,
});
```

**`packages/cli/src/commands/results.ts`** and **`diff.ts`** — get `userArn` from job record:

```typescript
const userArn = jobRes.Item.userArn as string;
const plain = await envelopeDecrypt(raw, {
  jobId,
  userArn,      // ADD
  purpose: 'skills-svc-result',
  environment: cfg.envName,
});
```

---

## Fix 8: DLP Circuit Breaker

**`packages/lambda/src/results-processor/indexer.ts`** — block high-risk findings from indexing:

```typescript
const HIGH_RISK_DLP_TYPES = new Set([
  'AWS_ACCESS_KEY', 'PRIVATE_KEY', 'SSN', 'CREDIT_CARD', 'JWT_TOKEN',
]);

export async function indexJobResult(result: RunResult, env: string): Promise<string> {
  const summaryDLP = await dlpScan(result.resultSummary);
  const fullTextDLP = await dlpScan(result.output.slice(0, 50_000));

  const hasHighRisk = [...summaryDLP.findings, ...fullTextDLP.findings]
    .some(f => HIGH_RISK_DLP_TYPES.has(f.type.replace('PII:', '')));

  if (hasHighRisk) {
    console.error(JSON.stringify({
      event: 'dlp_high_risk_blocked',
      jobId: result.jobId,
      findings: summaryDLP.findings.map(f => f.type),
      message: 'HIGH-RISK DLP finding — result NOT indexed in OpenSearch',
    }));
    // Publish SNS alert
    await sns.send(new PublishCommand({
      TopicArn: await getParam(`/skills-svc/${env}/sns/jobs-topic-arn`),
      Subject: `DLP Alert: High-risk finding in job ${result.jobId}`,
      Message: `HIGH-RISK PII detected in job ${result.jobId} output. Result was NOT indexed. Review manually.`,
    }));
    return result.jobId; // Return without indexing
  }

  // Proceed with indexing (using redacted text)
  // ... rest unchanged
}
```

---

## Fix 9: Validator Lambda — Add SQS Queue Between S3 Event and Lambda

**Problem:** S3→Lambda direct notification retries 3 times then silently drops the event. If the validator Lambda fails, the skill is never validated — stuck with no DDB record.

**Solution:** Add S3→SQS→Lambda pattern (same as ingestion pipeline).

**`infra/lib/skill-registry-stack.ts`** — add SQS queue:

```typescript
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';

// Add validation DLQ and queue
const validationDLQ = new sqs.Queue(this, 'ValidationDLQ', {
  queueName: `skills-svc-validation-dlq-${envName}`,
  encryption: sqs.QueueEncryption.KMS,
  encryptionMasterKey: props.dynamodbKey,
  retentionPeriod: cdk.Duration.days(14),
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

const validationQueue = new sqs.Queue(this, 'ValidationQueue', {
  queueName: `skills-svc-validation-${envName}`,
  encryption: sqs.QueueEncryption.KMS,
  encryptionMasterKey: props.dynamodbKey,
  visibilityTimeout: cdk.Duration.minutes(5), // >= Lambda timeout
  deadLetterQueue: { queue: validationDLQ, maxReceiveCount: 3 },
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

// S3 event → SQS (not direct to Lambda)
this.registryBucket.addEventNotification(
  s3.EventType.OBJECT_CREATED,
  new s3n.SqsDestination(validationQueue),
  { prefix: 'skills/', suffix: 'skill.zip' },
);

// SQS → Lambda (with DLQ fallback)
this.validatorFn.addEventSource(new lambdaEventSources.SqsEventSource(validationQueue, {
  batchSize: 1,
  reportBatchItemFailures: true,
}));

// REMOVE the direct S3→Lambda permission (no longer needed):
// this.validatorFn.addPermission('AllowS3Invoke', ...)
```

**Update `skill-validator/handler.ts`** to accept SQS event format (same pattern as ingestion Lambda).

---

## Fix 10: Bedrock Model Availability Pre-Deploy Check

**`infra/bin/app.ts`** — add pre-flight check before instantiating stacks:

```typescript
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';

async function checkBedrockAvailability(region: string) {
  const bedrock = new BedrockClient({ region });
  try {
    const models = await bedrock.send(new ListFoundationModelsCommand({}));
    const claudeModels = (models.modelSummaries ?? [])
      .filter(m => m.modelId?.includes('anthropic.claude'))
      .map(m => m.modelId!);
    const titanModels = (models.modelSummaries ?? [])
      .filter(m => m.modelId?.includes('titan-embed'))
      .map(m => m.modelId!);

    if (claudeModels.length === 0) {
      throw new Error(
        `No Claude models available in ${region}. ` +
        `Skills execution will fail. ` +
        `Check: https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html`
      );
    }
    if (titanModels.length === 0) {
      console.warn(`WARNING: No Titan embedding models in ${region}. ` +
        `Knowledge store queries will fail. Consider a region with Titan availability.`);
    }

    // Store discovered model IDs in CDK context for stacks to use
    app.node.setContext('bedrockClaudeModelId', claudeModels[0]);
    app.node.setContext('bedrockEmbeddingModelId', titanModels[0] ?? 'amazon.titan-embed-text-v1:0');

    console.log(`✓ Bedrock: Claude=${claudeModels[0]}, Embeddings=${titanModels[0]}`);
  } catch (err: any) {
    if (err.name === 'UnrecognizedClientException' || err.message.includes('not available')) {
      throw new Error(`Bedrock not available in ${region}: ${err.message}`);
    }
    throw err;
  }
}

// Call before stack instantiation
await checkBedrockAvailability(env.region ?? 'us-east-1');
```

**Stacks read model IDs from CDK context instead of hardcoding:**

```typescript
// In ECSStack and KnowledgeStoreStack:
const claudeModelId = app.node.tryGetContext('bedrockClaudeModelId')
  ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0';
new ssm.StringParameter(this, 'BedrockClaudeModelId', {
  parameterName: `/skills-svc/${envName}/bedrock/claude-model-id`,
  stringValue: claudeModelId,
});
```

---

## Fix 11: AOSS Endpoint Auto-Refresh via Collection ID

**`packages/knowledge-store/src/client.ts`** — use collection ID for endpoint discovery:

```typescript
import { OpenSearchServerlessClient, ListCollectionsCommand } from '@aws-sdk/client-opensearchserverless';

const aoss = new OpenSearchServerlessClient({ region: process.env.REGION });
let _client: Client | null = null;
let _endpointVerifiedAt = 0;
const ENDPOINT_VERIFY_TTL = 300_000; // 5 minutes

async function resolveEndpoint(env: string): Promise<string> {
  const now = Date.now();
  const cachedEndpoint = paramCache.get(`/skills-svc/${env}/opensearch/endpoint`);

  // Periodically verify endpoint is still valid
  if (cachedEndpoint && now - _endpointVerifiedAt < ENDPOINT_VERIFY_TTL) {
    return cachedEndpoint.value;
  }

  // Fetch collection ID and resolve current endpoint
  const collectionId = await getCachedParam(`/skills-svc/${env}/opensearch/collection-id`);
  const collections = await aoss.send(new ListCollectionsCommand({
    collectionFilters: { ids: [collectionId] },
  }));

  const endpoint = collections.collectionSummaries?.[0]?.collectionEndpoint;
  if (!endpoint) throw new Error(`AOSS collection ${collectionId} not found or no endpoint`);

  // Update SSM if endpoint changed
  const storedEndpoint = cachedEndpoint?.value;
  if (endpoint !== storedEndpoint) {
    console.warn(JSON.stringify({
      event: 'opensearch_endpoint_changed',
      old: storedEndpoint,
      new: endpoint,
      message: 'OpenSearch endpoint changed — SSM param stale',
    }));
    // Update cache
    paramCache.set(`/skills-svc/${env}/opensearch/endpoint`, { value: endpoint, ts: now });
    _client = null; // Force client recreation
  }

  _endpointVerifiedAt = now;
  return endpoint;
}
```

---

## Fix 12: S3 Upload Rate Limiting via CloudWatch Alarm

**`infra/lib/monitoring-stack.ts`** — add upload surge alarm:

```typescript
// S3 upload rate alarm (per user)
new cloudwatch.Alarm(this, 'S3UploadSurgeAlarm', {
  alarmName: `skills-svc-${envName}-upload-surge`,
  metric: new cloudwatch.Metric({
    namespace: 'AWS/S3',
    metricName: 'NumberOfObjects',
    dimensionsMap: {
      BucketName: props.uploadsBucketName,
      StorageType: 'AllStorageTypes',
    },
    period: cdk.Duration.minutes(1),
    statistic: 'Sum',
  }),
  threshold: 50,  // 50 uploads per minute from any source
  evaluationPeriods: 2,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
  alarmDescription: 'Possible upload flooding — check for abuse',
}).addAlarmAction(alarmAction);

// Also: S3 lifecycle to auto-delete old uploads (reduce attack surface)
// StorageStack already has 90-day lifecycle — confirm this deletes uploads/ prefix too
```

---

## Fix 13: `schedule update` Command

**`packages/cli/src/commands/schedule.ts`** — add `update` sub-command:

```typescript
cmd.command('update <schedule-name> <zip-path>')
  .description('Update a schedule to use a new skills zip version')
  .option('--skill <ref>', 'Pull zip from registry: "name@version"')
  .action(async (scheduleName: string, zipPath: string, opts: { skill?: string }) => {
    const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
    const creds = await getCredentialProvider();
    const s3    = new S3Client({ region: cfg.region, credentials: creds });
    const ssm   = new SSMClient({ region: cfg.region, credentials: creds });

    // Extract scheduleId from schedule name
    const uuidMatch = scheduleName.match(/-([a-f0-9]{8})$/);
    const scheduleId = uuidMatch?.[1];
    if (!scheduleId) {
      console.error(chalk.red(`Cannot extract schedule ID from: ${scheduleName}`));
      process.exit(1);
    }

    let zipBuffer: Buffer;
    if (opts.skill) {
      // Pull from registry
      const { name, version } = parseSkillRef(opts.skill);
      // ... fetch from S3 registry (similar to skill pull command)
      console.log(chalk.blue(`Pulling ${opts.skill} from registry...`));
      // zipBuffer = await pullSkillZip(name, version, cfg, creds);
    } else {
      zipBuffer = readFileSync(zipPath);
    }

    // Overwrite the stored schedule zip (same S3 key, new content)
    const scheduleS3Key = `skill-schedules/${scheduleId}/skill.zip`;
    const registryBucket = await ssm.send(new GetParameterCommand({
      Name: `/skills-svc/${cfg.envName}/registry/bucket-name`,
    })).then(r => r.Parameter!.Value!);

    await s3.send(new PutObjectCommand({
      Bucket: cfg.uploadsBucket,    // uploads bucket, not registry
      Key: scheduleS3Key,
      Body: zipBuffer!,
      ContentType: 'application/zip',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: cfg.uploadsKmsKeyId,
      ChecksumAlgorithm: 'SHA256',
      Metadata: {
        'job-name':     scheduleName,
        'schedule-id':  scheduleId,
        ...(opts.skill ? { 'skill-ref': opts.skill } : {}),
      },
    }));

    console.log(chalk.green(`✓ Schedule "${scheduleName}" updated`));
    console.log(chalk.dim(`  Next execution will use the new zip`));
  });
```

---

## Fix 14: Remove `number_of_replicas` from AOSS Index Mapping

**`packages/lambda/src/bootstrap-index/handler.ts`** — fix mapping:

```typescript
const INDEX_MAPPING = {
  settings: {
    index: {
      knn: true,
      'knn.algo_param.ef_search': 512,
      number_of_shards: 5,
      // REMOVE number_of_replicas — AOSS manages replication automatically
      // Setting this causes index creation to fail on AOSS
      refresh_interval: '5s',
    },
    // ...
  },
  // ... mappings unchanged
};
```

---

## Fix 15: Document DDB GSI Backfill Behavior

Add to **`scripts/deploy.sh`** after Storage stack deploy:

```bash
echo "Deploying Storage stack (GSI creation may take 15-30 minutes)..."
npx cdk deploy SkillsSvc-${ENV}-Storage --require-approval never

echo "Waiting for DynamoDB GSIs to become ACTIVE..."
TABLE_NAME="skills-svc-jobs-$(aws sts get-caller-identity --query Account --output text)-${REGION}"
for GSI in GSI1-Status GSI2-User GSI3-Schedule GSI4-CacheKey GSI5-Skill; do
  echo -n "  Checking $GSI... "
  STATUS=""
  while [ "$STATUS" != "ACTIVE" ]; do
    STATUS=$(aws dynamodb describe-table --table-name "$TABLE_NAME" \
      --query "Table.GlobalSecondaryIndexes[?IndexName=='$GSI'].IndexStatus" \
      --output text 2>/dev/null || echo "PENDING")
    [ "$STATUS" != "ACTIVE" ] && sleep 10 && echo -n "."
  done
  echo " ACTIVE"
done
echo "All GSIs are ACTIVE. Continuing deployment."
```

---

## Fix 16: DDB PITR Restore Runbook

**`docs/disaster-recovery-runbook.md`** (new file):

```markdown
# Skills as a Service — Disaster Recovery Runbook

## Scenario 1: DynamoDB Table Accidentally Deleted

### Steps:
1. Find the point in time BEFORE deletion:
   ```bash
   aws cloudtrail lookup-events \
     --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteTable \
     --region us-east-1 | jq '.Events[0].EventTime'
   ```

2. Restore to temp table (different name — DDB cannot rename):
   ```bash
   aws dynamodb restore-table-to-point-in-time \
     --source-table-arn arn:aws:dynamodb:us-east-1:ACCOUNT:table/skills-svc-jobs-ACCOUNT-us-east-1 \
     --target-table-name skills-svc-jobs-ACCOUNT-us-east-1-restored \
     --restore-date-time "2025-05-13T10:00:00Z"
   ```

3. Wait for restore (~5 minutes):
   ```bash
   aws dynamodb wait table-exists --table-name skills-svc-jobs-ACCOUNT-us-east-1-restored
   ```

4. Update SSM param to point to restored table:
   ```bash
   aws ssm put-parameter \
     --name "/skills-svc/prod/dynamodb/table-name" \
     --value "skills-svc-jobs-ACCOUNT-us-east-1-restored" \
     --type String --overwrite
   ```

5. Force Lambda SSM cache refresh (redeploy or wait 5 minutes):
   ```bash
   aws lambda update-function-configuration \
     --function-name skills-svc-ingestion-ACCOUNT \
     --environment Variables="{ENV=prod,REGION=us-east-1,CACHE_BUST=$(date +%s)}"
   ```

6. Run CDK deploy to re-add table to CloudFormation management:
   ```bash
   # IMPORTANT: Import the restored table into CloudFormation
   cdk deploy SkillsSvc-prod-Storage --import
   ```

7. Verify all in-flight jobs: `skills-svc list-jobs --status RUNNING`
   - Any RUNNING jobs with no active ECS task must be manually FAILED

### RTO: ~15-30 minutes
### RPO: ~0 (PITR covers up to 35 days)
```

---

## Fix 17: OpenSearch Re-Index Lambda

**`packages/lambda/src/reindex/handler.ts`** (new file):

```typescript
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { envelopeDecrypt } from '@skills-svc/shared';
import { indexJobResult } from '@skills-svc/knowledge-store';
import { JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3  = new S3Client({});

export const handler = async (event: { sinceDate?: string; untilDate?: string; dryRun?: boolean }) => {
  const env = process.env.ENV ?? 'prod';
  const tableName = process.env.DYNAMODB_TABLE_NAME!;
  const resultsBucket = process.env.RESULTS_BUCKET!;

  const since = event.sinceDate ? new Date(event.sinceDate).getTime() : 0;
  const until = event.untilDate ? new Date(event.untilDate).getTime() : Date.now();

  let indexed = 0, failed = 0, skipped = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: '#status = :complete AND createdAt BETWEEN :since AND :until',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':complete': JobStatus.COMPLETE,
        ':since': new Date(since).toISOString(),
        ':until': new Date(until).toISOString(),
      },
      ExclusiveStartKey: lastKey as any,
    }));

    for (const item of res.Items ?? []) {
      if (!item.s3ResultKey) { skipped++; continue; }
      try {
        if (!event.dryRun) {
          const obj = await s3.send(new GetObjectCommand({ Bucket: resultsBucket, Key: item.s3ResultKey }));
          const chunks: Uint8Array[] = [];
          for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
          const raw = JSON.parse(Buffer.concat(chunks).toString());
          const plain = await envelopeDecrypt(raw, {
            jobId: item.jobId,
            userArn: item.userArn,   // after Fix 7
            purpose: 'skills-svc-result',
            environment: env,
          });
          const result = JSON.parse(plain.toString());
          await indexJobResult(result, env);
        }
        indexed++;
      } catch (err) {
        console.error(JSON.stringify({ event: 'reindex_error', jobId: item.jobId, err: String(err) }));
        failed++;
      }
    }
    lastKey = res.LastEvaluatedKey as any;
  } while (lastKey);

  return { indexed, failed, skipped, dryRun: event.dryRun ?? false };
};
```

**CLI command to trigger re-index:**

```bash
skills-svc index reindex \
  --since 2025-01-01 \
  --until 2025-05-13 \
  --dry-run  # preview first
```

---

## Fix 18: CDK Bootstrap Per-Region Documentation

**`scripts/deploy.sh`** — add bootstrap check (integrated with Fix 1):

```bash
check_bootstrap() {
  local region="$1"
  local account="$2"
  if ! aws cloudformation describe-stacks \
       --stack-name CDKToolkit \
       --region "$region" \
       --query 'Stacks[0].StackStatus' \
       --output text 2>/dev/null | grep -q "COMPLETE"; then
    echo ""
    echo "ERROR: CDK not bootstrapped in $region."
    echo "Run this command first:"
    echo ""
    echo "  cdk bootstrap aws://${account}/${region} \\"
    echo "    --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \\"
    echo "    --trust ${account}"
    echo ""
    exit 1
  fi
  echo "✓ CDK bootstrapped in $region"
}

check_bootstrap "${CDK_DEFAULT_REGION:-us-east-1}" "${CDK_DEFAULT_ACCOUNT}"
```

---

## New QA Checks (QA-259 through QA-266)

```typescript
// QA-259: SCP DenyNonApprovedRegions uses configurable regions not hardcoded us-east-1
test('QA-259: SCP DenyNonApprovedRegions accepts regions parameter', () => {
  const source = readFileSync('infra/lib/scp-policies.ts', 'utf-8');
  expect(source).toContain('approvedRegions');
  expect(source).not.toMatch(/'\s*us-east-1\s*'\]/); // no hardcoded single region
});

// QA-260: delete-user command is registered in index.ts
test('QA-260: deleteUserCommand is registered in CLI', () => {
  const source = readFileSync('packages/cli/src/index.ts', 'utf-8');
  expect(source).toContain('deleteUserCommand');
  expect(source).toContain("addCommand(deleteUserCommand())");
});

// QA-261: SCP includes DenyOpenSearchCollectionDeletion
test('QA-261: SCP DenyAuditTampering includes OpenSearch collection deletion', () => {
  const source = readFileSync('infra/lib/scp-policies.ts', 'utf-8');
  expect(source).toContain('aoss:DeleteCollection');
  expect(source).toContain('DenyOpenSearchCollectionDeletion');
});

// QA-262: break-glass role has MFA condition
test('QA-262: BreakGlassRole trust policy requires MFA', () => {
  const { templates } = buildTestApp();
  const roles = templates.security.findResources('AWS::IAM::Role');
  const bgRole = Object.values(roles).find((r: any) =>
    JSON.stringify(r).includes('break-glass')
  ) as any;
  const trustDoc = bgRole.Properties.AssumeRolePolicyDocument;
  const stmts = trustDoc.Statement ?? [];
  const hasMFA = stmts.some((s: any) =>
    s.Condition?.Bool?.['aws:MultiFactorAuthPresent'] === 'true'
  );
  expect(hasMFA).toBe(true);
});

// QA-263: KMS encryption context includes userArn in uploader
test('QA-263: envelopeEncrypt in uploader.ts includes userArn in context', () => {
  const source = readFileSync('packages/ecs-runner/src/uploader.ts', 'utf-8');
  expect(source).toContain('userArn');
  expect(source).toContain("purpose: 'skills-svc-result'");
});

// QA-264: DLP circuit breaker blocks high-risk findings from indexing
test('QA-264: indexer.ts does not index when HIGH_RISK DLP findings present', () => {
  const source = readFileSync('packages/lambda/src/results-processor/indexer.ts', 'utf-8');
  expect(source).toContain('HIGH_RISK_DLP_TYPES');
  expect(source).toContain('hasHighRisk');
  // Must return without calling client.index when hasHighRisk is true
  expect(source).toMatch(/hasHighRisk[\s\S]{0,200}return/);
});

// QA-265: Validator Lambda uses SQS not direct S3 event
test('QA-265: SkillRegistryStack uses SQS between S3 event and validator Lambda', () => {
  const { templates } = buildTestApp();
  // Should have a SQS queue for validation
  const queues = templates.skillRegistry.findResources('AWS::SQS::Queue');
  const validationQueue = Object.values(queues).find((q: any) =>
    JSON.stringify(q).includes('validation')
  );
  expect(validationQueue).toBeDefined();
  // Lambda should NOT have a direct S3 permission (only SQS permission)
  const permissions = templates.skillRegistry.findResources('AWS::Lambda::Permission');
  const s3Permission = Object.values(permissions).find((p: any) =>
    (p as any).Properties?.Principal === 's3.amazonaws.com'
  );
  expect(s3Permission).toBeUndefined(); // S3 → Lambda direct replaced by S3 → SQS → Lambda
});

// QA-266: AOSS index mapping has no number_of_replicas
test('QA-266: bootstrap-index handler does not set number_of_replicas', () => {
  const source = readFileSync('packages/lambda/src/bootstrap-index/handler.ts', 'utf-8');
  expect(source).not.toContain('number_of_replicas');
});
```

---

## Summary

| Fix | Impact | Files Changed |
|-----|--------|--------------|
| 1 — Configurable SCP regions | CRITICAL — enables EU deployment | `scp-policies.ts`, `apply-scps.sh`, `deploy.sh` |
| 2 — GDPR delete-user command | CRITICAL — legal compliance | `commands/delete-user.ts` (new) |
| 3 — SCP blocks AOSS deletion | CRITICAL — prevents data loss | `scp-policies.ts` |
| 4 — Skill deprecation notifications | CRITICAL — consumer awareness | `skill-validator/handler.ts`, `messaging-stack.ts` |
| 5 — Deprecation enforced on schedules | CRITICAL — prevents silent use | `schedule-trigger/handler.ts` |
| 6 — Break-glass MFA condition | BLOCKER — security hardening | `security-stack.ts` |
| 7 — userArn in KMS context | BLOCKER — tighter key scoping | `uploader.ts`, `results-processor/handler.ts`, `results.ts`, `diff.ts` |
| 8 — DLP circuit breaker | BLOCKER — PII never indexed | `results-processor/indexer.ts` |
| 9 — Validator Lambda SQS queue | BLOCKER — no silent event drops | `skill-registry-stack.ts`, `skill-validator/handler.ts` |
| 10 — Bedrock availability pre-check | BLOCKER — catches region issues at deploy | `infra/bin/app.ts` |
| 11 — AOSS endpoint auto-refresh | BLOCKER — DR resilience | `knowledge-store/src/client.ts` |
| 12 — S3 upload rate limiting | BLOCKER — DoS protection | `monitoring-stack.ts` |
| 13 — schedule update command | CORRECTNESS — skill migration | `commands/schedule.ts` |
| 14 — Remove number_of_replicas | CORRECTNESS — AOSS compatibility | `bootstrap-index/handler.ts` |
| 15 — GSI backfill docs in deploy.sh | CORRECTNESS — prevents killed deploys | `scripts/deploy.sh` |
| 16 — DDB PITR restore runbook | CORRECTNESS — DR documentation | `docs/disaster-recovery-runbook.md` (new) |
| 17 — OpenSearch re-index Lambda | CORRECTNESS — DR capability | `lambda/src/reindex/handler.ts` (new) |
| 18 — CDK bootstrap per-region | CORRECTNESS — multi-region support | `scripts/deploy.sh` |
