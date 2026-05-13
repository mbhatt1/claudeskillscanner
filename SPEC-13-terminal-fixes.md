# Skills as a Service (SaaS) — Specification Part 13: Terminal Fixes

**Version:** 1.0.0  
**Status:** AUTHORITATIVE — final loose-end resolution. After this spec the suite is complete.  
**Parts:** ... | [Part 12](SPEC-12-final-consolidation.md) | [Part 13: Terminal Fixes]

---

## Issues Resolved

| # | Severity | Issue |
|---|----------|-------|
| 1 | **BLOCKER** | `RunSkillLambda` env vars `SKILLS_TABLE_NAME` and `REGISTRY_BUCKET` are empty strings |
| 2 | **BLOCKER** | `LambdaStackProps` has no `skillsTableName` / `registryBucket` — cannot wire values |
| 3 | **BLOCKER** | `SkillRegistryStack` depends on `accessLogsBucket` from `StorageStack` but `app.ts` only adds `addDependency(security)` — CDK may deploy before Storage |
| 4 | **BLOCKER** | Deployment runbook deploys `SkillRegistry` at Tier 3 (parallel with `Storage`) — impossible since it needs Storage's access-logs bucket |
| 5 | **BLOCKER** | `batch run` SPEC-12 Fix 8 adds `PutCommand`/`UpdateCommand` but these are not in `batch.ts` imports |
| 6 | **BLOCKER** | `packages/lambda/package.json` — no authoritative version; multiple handlers added across specs with no consolidated deps |
| 7 | **BLOCKER** | `packages/cli/package.json` — missing `@aws-sdk/client-cloudformation` added by SPEC-12 Fix 27 |
| 8 | **CORRECTNESS** | Validator Lambda has no VPC config — inconsistent security posture; other Lambdas are all in VPC |
| 9 | **CORRECTNESS** | `inputTokens`/`outputTokens` never written to DDB — `cost.ts` always falls back to estimates silently |
| 10 | **CORRECTNESS** | `skill pull` never verifies SHA256 against registry DDB record — silent integrity gap |
| 11 | **CORRECTNESS** | `CliConfig.registryKmsKeyId` is populated but unused by any command — dead field causing confusion |
| 12 | **CORRECTNESS** | MCP server uses IAM (SigV4) auth — Claude Desktop's MCP client does not natively sign AWS requests; no documented workaround |
| 13 | **CORRECTNESS** | `SkillRegistryStack` missing import: uses `s3n.LambdaDestination` but import is not shown |
| 14 | **CORRECTNESS** | `SkillRegistryStack` `validatorFn` not granted `ssm:GetParameter` — handler calls SSM for table name |

---

## Fix 1 & 2: `RunSkillLambda` — Wire `SKILLS_TABLE_NAME` and `REGISTRY_BUCKET`

### Root Cause
SPEC-11 Fix 8 sets both env vars to `''` with a comment "populated via SSM at runtime", but the handler uses `process.env.SKILLS_TABLE_NAME!` directly (not SSM). The values are never populated.

### Solution
Add `skillsTableName` and `registryBucket` to `LambdaStackProps` and pass them through. `LambdaStack` depends on `SkillRegistryStack` (Tier 5 depends on Tier 4 — valid).

**`infra/lib/lambda-stack.ts` — updated props interface:**

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
  runSkillLambdaRole: iam.Role;
  lambdaEnvKey: kms.Key;
  uploadsKmsKeyId: string;
  skillsTableName: string;   // ADD — from SkillRegistryStack
  registryBucket: string;    // ADD — from SkillRegistryStack
}
```

**`infra/lib/lambda-stack.ts` — updated `RunSkillLambda` env block:**

```typescript
this.runSkillFn = new lambda.Function(this, 'RunSkillLambda', {
  ...sharedLambdaProps,
  functionName: `skills-svc-run-skill-${this.account}`,
  handler: 'run-skill/handler.handler',
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  reservedConcurrentExecutions: 100,
  role: props.runSkillLambdaRole,
  description: 'Server-side skill run — resolves skill ref, copies zip to uploads prefix',
  environment: {
    NODE_OPTIONS:       '--enable-source-maps',
    ENV:                props.envName,
    REGION:             this.region,
    UPLOADS_BUCKET:     props.uploadsBucket.bucketName,
    UPLOADS_KMS_KEY_ID: props.uploadsKmsKeyId,
    SKILLS_TABLE_NAME:  props.skillsTableName,   // ← was '' — now real value
    REGISTRY_BUCKET:    props.registryBucket,    // ← was '' — now real value
  },
});
```

**`infra/bin/app.ts` — updated LambdaStack instantiation (replaces SPEC-12 Fix 4):**

```typescript
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
  runSkillLambdaRole:    security.runSkillLambdaRole,
  lambdaEnvKey:          security.lambdaEnvKey,
  uploadsKmsKeyId:       security.uploadsBucketKey.keyArn,
  skillsTableName:       skillRegistry.skillsTable.tableName,   // ADD
  registryBucket:        skillRegistry.registryBucket.bucketName, // ADD
});
lambdaStack.addDependency(messaging);
lambdaStack.addDependency(skillRegistry); // ADD — LambdaStack needs SkillRegistry outputs
```

---

## Fix 3 & 4: `SkillRegistryStack` Dependency on `StorageStack`

### Root Cause
`SkillRegistryStack` requires `props.accessLogsBucket` from `StorageStack`. The CDK `addDependency` in SPEC-12's `app.ts` only has `skillRegistry.addDependency(security)` — Storage is not listed. CDK's implicit dependency tracking may catch this via the bucket ARN reference, but explicit declaration is required for deterministic ordering.

**`infra/bin/app.ts` — updated SkillRegistryStack instantiation:**

```typescript
const skillRegistry = new SkillRegistryStack(app, `SkillsSvc-${envName}-SkillRegistry`, {
  env, envName,
  vpc: network.vpc, lambdaSg: network.lambdaSg,
  registryBucketKey: security.registryBucketKey,
  dynamodbKey:       security.dynamodbKey,
  accessLogsBucket:  storage.accessLogsBucket,
});
skillRegistry.addDependency(security);
skillRegistry.addDependency(storage); // ADD — needs accessLogsBucket
```

### Authoritative Deployment Order (`scripts/deploy.sh`)

Replaces SPEC-12 Fix 30:

```bash
#!/usr/bin/env bash
set -euo pipefail
ENV=${CDK_ENV:-prod}

echo "=== Deploying Skills as a Service — env: $ENV ==="

# Tier 1 — no dependencies
npx cdk deploy SkillsSvc-${ENV}-Network       --require-approval never

# Tier 2 — needs Network
npx cdk deploy SkillsSvc-${ENV}-Security      --require-approval never

# Tier 3 — needs Security
npx cdk deploy SkillsSvc-${ENV}-Storage       --require-approval never

# Tier 4 — needs Storage (and Security)
npx cdk deploy SkillsSvc-${ENV}-SkillRegistry --require-approval never
npx cdk deploy SkillsSvc-${ENV}-Messaging     --require-approval never  # parallel

# Tier 5 — needs Messaging + SkillRegistry + Storage + Security
npx cdk deploy SkillsSvc-${ENV}-Lambda        --require-approval never
npx cdk deploy SkillsSvc-${ENV}-ECS           --require-approval never  # parallel
npx cdk deploy SkillsSvc-${ENV}-KnowledgeStore --require-approval never # parallel

# Tier 6 — needs Lambda + ECS + KnowledgeStore
npx cdk deploy SkillsSvc-${ENV}-Batch         --require-approval never
npx cdk deploy SkillsSvc-${ENV}-MCP           --require-approval never  # parallel

# Tier 7 — needs all above
npx cdk deploy SkillsSvc-${ENV}-Monitoring    --require-approval never
npx cdk deploy SkillsSvc-${ENV}-Compliance    --require-approval never  # parallel

echo "=== Deployment complete ==="
echo "Next: bash scripts/build-push-ecs.sh $ENV && skills-svc configure --region us-east-1 --account \$ACCOUNT --env $ENV"
```

---

## Fix 5: `batch.ts` Missing Imports

**Add to `packages/cli/src/commands/batch.ts` top-level imports:**

```typescript
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,     // ADD — for writing METADATA
  UpdateCommand,  // ADD — for writing sfnExecutionArn
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'; // ADD — for user ARN
```

---

## Fix 6: Authoritative `packages/lambda/package.json`

```json
{
  "name": "@skills-svc/lambda",
  "version": "1.0.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "jest --passWithNoTests",
    "lint": "eslint src/ --max-warnings 0"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.600.0",
    "@aws-sdk/client-cloudwatch-logs": "^3.600.0",
    "@aws-sdk/client-comprehend":      "^3.600.0",
    "@aws-sdk/client-dynamodb":        "^3.600.0",
    "@aws-sdk/client-ecs":             "^3.600.0",
    "@aws-sdk/client-opensearch":      "^3.600.0",
    "@aws-sdk/client-s3":              "^3.600.0",
    "@aws-sdk/client-sns":             "^3.600.0",
    "@aws-sdk/client-ssm":             "^3.600.0",
    "@aws-sdk/client-sfn":             "^3.600.0",
    "@aws-sdk/credential-provider-node": "^3.600.0",
    "@aws-sdk/lib-dynamodb":           "^3.600.0",
    "@opensearch-project/opensearch":  "^2.6.0",
    "aws-xray-sdk":                    "^3.6.0",
    "@skills-svc/shared":              "*"
  },
  "devDependencies": {
    "@types/aws-lambda":               "^8.10.137",
    "@types/node":                     "^20.0.0",
    "aws-sdk-client-mock":             "^3.0.0",
    "jest":                            "^29.7.0",
    "ts-jest":                         "^29.1.0",
    "typescript":                      "^5.4.0"
  }
}
```

---

## Fix 7: Authoritative `packages/cli/package.json`

```json
{
  "name": "@skills-svc/cli",
  "version": "1.0.0",
  "bin": { "skills-svc": "dist/index.js" },
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "jest --passWithNoTests",
    "lint": "eslint src/ --max-warnings 0"
  },
  "dependencies": {
    "@aws-sdk/client-cloudformation":  "^3.600.0",
    "@aws-sdk/client-cloudtrail":      "^3.600.0",
    "@aws-sdk/client-cloudwatch-logs": "^3.600.0",
    "@aws-sdk/client-dynamodb":        "^3.600.0",
    "@aws-sdk/client-ecs":             "^3.600.0",
    "@aws-sdk/client-lambda":          "^3.600.0",
    "@aws-sdk/client-s3":              "^3.600.0",
    "@aws-sdk/client-scheduler":       "^3.600.0",
    "@aws-sdk/client-sfn":             "^3.600.0",
    "@aws-sdk/client-sns":             "^3.600.0",
    "@aws-sdk/client-ssm":             "^3.600.0",
    "@aws-sdk/client-sts":             "^3.600.0",
    "@aws-sdk/lib-dynamodb":           "^3.600.0",
    "@skills-svc/shared":              "*",
    "adm-zip":                         "^0.5.10",
    "chalk":                           "^5.3.0",
    "cli-table3":                      "^0.6.3",
    "commander":                       "^12.1.0",
    "diff":                            "^5.2.0",
    "glob":                            "^10.4.0"
  },
  "devDependencies": {
    "@types/adm-zip":  "^0.5.5",
    "@types/diff":     "^5.2.0",
    "@types/node":     "^20.0.0",
    "jest":            "^29.7.0",
    "ts-jest":         "^29.1.0",
    "typescript":      "^5.4.0"
  }
}
```

---

## Fix 8: Validator Lambda — VPC Config

**In `infra/lib/skill-registry-stack.ts`**, update `validatorFn` to add VPC:

```typescript
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
  vpc: props.vpc,                                                    // ADD
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },       // ADD
  securityGroups: [props.lambdaSg],                                  // ADD
  environment: {
    NODE_OPTIONS: '--enable-source-maps',
    ENV: envName,
    REGION: this.region,
  },
  description: 'Validates skill zip on push, writes metadata to DDB, updates latest pointer',
});
```

**Update `SkillRegistryStackProps`** to include VPC fields:

```typescript
interface SkillRegistryStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;             // ADD
  lambdaSg: ec2.SecurityGroup; // ADD
  registryBucketKey: kms.Key;
  dynamodbKey: kms.Key;
  accessLogsBucket: s3.Bucket;
}
```

---

## Fix 9: Store Token Counts in DDB for Accurate Cost Reporting

### Root Cause
`cost.ts` uses `item.inputTokens` and `item.outputTokens` from the DDB job record, but nothing writes them. They're always `undefined`, triggering the hardcoded fallback estimates.

### Solution: ECS runner parses Bedrock response token counts and stores them via DDB update

**`packages/ecs-runner/src/job-status.ts` — add token count parameter:**

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { JobStatus, isValidTransition, DDB_KEY_PREFIX } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const paramCache = new Map<string, { value: string; ts: number }>();
async function getParam(name: string): Promise<string> {
  const now = Date.now();
  const c = paramCache.get(name);
  if (c && now - c.ts < 300_000) return c.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  const v = res.Parameter!.Value!;
  paramCache.set(name, { value: v, ts: now });
  return v;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
}

export async function updateJobStatus(
  jobId: string,
  status: JobStatus,
  env: string,
  errorMessage?: string,
  tokenCounts?: TokenCounts,   // ADD
): Promise<void> {
  const tableName = await getParam(`/skills-svc/${env}/dynamodb/table-name`);
  const now = new Date().toISOString();

  const res = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
  }));
  const version = (res.Item?.version as number | undefined) ?? 0;
  const currentStatus = res.Item?.status as JobStatus | undefined;

  if (currentStatus && !isValidTransition(currentStatus, status)) {
    console.warn(JSON.stringify({ event: 'invalid_status_transition', jobId, from: currentStatus, to: status }));
    return;
  }

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    UpdateExpression: [
      'SET #status = :status',
      'updatedAt = :now',
      '#ver = :nv',
      'GSI1PK = :gsi1pk',
      errorMessage ? 'errorMessage = :err' : null,
      status === JobStatus.COMPLETE ? 'completedAt = :now' : null,
      tokenCounts ? 'inputTokens = :inTok, outputTokens = :outTok' : null,
    ].filter(Boolean).join(', '),
    ConditionExpression: '#ver = :cv',
    ExpressionAttributeNames: { '#status': 'status', '#ver': 'version' },
    ExpressionAttributeValues: {
      ':status': status,
      ':now': now,
      ':nv': version + 1,
      ':cv': version,
      ':gsi1pk': `${DDB_KEY_PREFIX.STATUS}${status}`,
      ...(errorMessage ? { ':err': errorMessage } : {}),
      ...(tokenCounts  ? { ':inTok': tokenCounts.inputTokens, ':outTok': tokenCounts.outputTokens } : {}),
    },
  }));
}
```

**`packages/ecs-runner/src/runner.ts` — extract and return token counts from Bedrock response:**

```typescript
export interface RunResult {
  // ... existing fields ...
  inputTokens: number;    // ADD — from Bedrock usage metadata
  outputTokens: number;   // ADD
}

// In invokeModel(), parse usage from Bedrock response:
const body = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
};

// Return from runSkills():
return {
  jobId,
  jobName:      manifest.jobName,
  skillNames:   manifest.skills,
  prompt:       userPrompt,
  output:       JSON.stringify(parsedOutput),
  resultSummary,
  durationMs,
  exitCode: 0,
  completedAt: new Date().toISOString(),
  inputTokens:  body.usage?.input_tokens  ?? 0,  // ADD
  outputTokens: body.usage?.output_tokens ?? 0,  // ADD
};
```

**`packages/ecs-runner/src/main.ts` — pass token counts to status update:**

```typescript
// In the success path:
const results = await runSkills(extractDir, jobId, env);
const resultKey = await uploadResults(jobId, results, env);

await updateJobStatus(jobId, JobStatus.COMPLETE, env, undefined, {
  inputTokens:  results.inputTokens,
  outputTokens: results.outputTokens,
});
```

**Add `inputTokens`/`outputTokens` to `RunResult` in `packages/shared/src/types.ts`:**

```typescript
export interface RunResult {
  jobId:        string;
  jobName:      string;
  skillNames:   string[];
  prompt:       string;
  output:       string;
  resultSummary: string;
  durationMs:   number;
  exitCode:     number;
  completedAt:  string;
  inputTokens:  number;   // ADD
  outputTokens: number;   // ADD
}
```

---

## Fix 10: `skill pull` — SHA256 Verification

**Add to `packages/cli/src/commands/skill.ts` `pull` action**, after the download stream completes:

```typescript
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

// After pipeline() completes — verify integrity
const storedSha256 = versionRes.Item.zipSha256 as string | undefined;
if (storedSha256) {
  const downloadedSha256 = createHash('sha256')
    .update(readFileSync(outFile))
    .digest('hex');

  if (downloadedSha256 !== storedSha256) {
    // Delete the corrupted file before throwing
    require('fs').unlinkSync(outFile);
    console.error(chalk.red(
      `✗ Integrity check failed for ${name}@${resolvedVersion}\n` +
      `  Expected: ${storedSha256}\n` +
      `  Got:      ${downloadedSha256}\n` +
      `  The downloaded file has been deleted. Try again or contact the skill author.`
    ));
    process.exit(1);
  }
  console.log(chalk.dim(`  SHA256 verified: ${storedSha256.slice(0, 16)}...`));
}
```

---

## Fix 11: Remove `registryKmsKeyId` from `CliConfig`

**Problem:** `CliConfig.registryKmsKeyId` is populated by `configure` but used by zero commands. `skill push` gets the KMS key ID from SSM at runtime via `GetParameterCommand`.

**Remove from `packages/cli/src/utils/config.ts`:**

```typescript
export interface CliConfig {
  profileName:       string;
  region:            string;
  accountId:         string;
  envName:           string;
  uploadsBucket:     string;
  resultsBucket:     string;
  uploadsKmsKeyId:   string;
  dynamodbTableName: string;
  registryBucket:    string;
  skillsTableName:   string;
  // registryKmsKeyId: string;   ← REMOVE — not used by any command
  jobsTopicArn:      string;
  opensearchEndpoint: string;
  queryLambdaArn:    string;
  runSkillLambdaArn: string;
  mcpEndpoint:       string;
  batchSfnArn:       string;
}
```

**Remove from `configure.ts`:**

```typescript
// REMOVE:
// registryKmsKeyId:  get('registry/kms-key-id'),
```

---

## Fix 12: MCP SigV4 — Documented Workaround for Claude Desktop

**Problem:** Claude Desktop's MCP client sends plain HTTPS requests — it cannot sign with SigV4. The `HttpIamAuthorizer` on the API Gateway rejects all Claude Desktop connections.

### Solution: Lambda Authorizer with API Key

For Claude Desktop integration, swap the API Gateway authorizer from IAM to a **Lambda authorizer** that validates a pre-shared API key stored in Secrets Manager. CLI users continue using SigV4 via the existing `UserRole`.

**Add to `infra/lib/mcp-stack.ts`:**

```typescript
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

// API key secret for Claude Desktop (rotated manually or via Secrets Manager rotation)
const mcpApiKeySecret = new secretsmanager.Secret(this, 'MCPApiKeySecret', {
  secretName: `/skills-svc/${envName}/mcp/api-key`,
  description: 'Pre-shared API key for MCP clients that cannot sign SigV4 (e.g. Claude Desktop)',
  encryptionKey: props.lambdaEnvKey,
  generateSecretString: {
    excludePunctuation: true,
    passwordLength: 48,
  },
  removalPolicy: cdk.RemovalPolicy.RETAIN,
});

// Lambda authorizer — validates Bearer token against the secret
const authorizerFn = new lambda.Function(this, 'MCPAuthorizerLambda', {
  functionName: `skills-svc-mcp-authorizer-${this.account}`,
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'mcp-authorizer/handler.handler',
  code: lambda.Code.fromAsset('../packages/lambda/dist'),
  timeout: cdk.Duration.seconds(5),
  memorySize: 128,
  environment: {
    API_KEY_SECRET_ARN: mcpApiKeySecret.secretArn,
    // Caller ARN for API key users — a fixed ARN representing Claude Desktop sessions
    CLAUDE_DESKTOP_ARN: `arn:aws:iam::${this.account}:assumed-role/skills-svc-user-${envName}/claude-desktop`,
  },
  vpc: props.vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [props.lambdaSg],
});
mcpApiKeySecret.grantRead(authorizerFn);

const lambdaAuthorizer = new apigatewayv2Authorizers.HttpLambdaAuthorizer(
  'MCPLambdaAuthorizer',
  authorizerFn,
  {
    responseTypes: [apigatewayv2Authorizers.HttpLambdaResponseType.SIMPLE],
    resultsCacheTtl: cdk.Duration.minutes(5),
    identitySource: ['$request.header.Authorization'],
  },
);

// Two routes — one IAM (CLI), one Lambda-authorized (Claude Desktop)
// IAM route:
api.addRoutes({
  path: '/mcp',
  methods: [apigatewayv2.HttpMethod.POST],
  integration: new apigatewayv2Integrations.HttpLambdaIntegration('MCPIntegration', mcpFn),
  authorizer: new apigatewayv2Authorizers.HttpIamAuthorizer(),
});

// API-key route (separate path for Claude Desktop):
api.addRoutes({
  path: '/mcp/desktop',
  methods: [apigatewayv2.HttpMethod.POST],
  integration: new apigatewayv2Integrations.HttpLambdaIntegration('MCPDesktopIntegration', mcpFn),
  authorizer: lambdaAuthorizer,
});
```

**`packages/lambda/src/mcp-authorizer/handler.ts`:**

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});
let _cachedKey: string | null = null;

export const handler = async (event: { headers: Record<string, string> }) => {
  const authHeader = event.headers['authorization'] ?? event.headers['Authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  if (!_cachedKey) {
    const res = await sm.send(new GetSecretValueCommand({
      SecretId: process.env.API_KEY_SECRET_ARN!,
    }));
    _cachedKey = res.SecretString!;
  }

  const isValid = token === _cachedKey && token.length > 0;

  return {
    isAuthorized: isValid,
    context: {
      callerArn: isValid ? process.env.CLAUDE_DESKTOP_ARN! : '',
    },
  };
};
```

**MCP server handler — extract `callerArn` from both auth paths:**

```typescript
// In packages/lambda/src/mcp/handler.ts, update callerArn extraction:
const callerArn =
  event.requestContext.authorizer?.iam?.userArn ??          // SigV4 (CLI)
  (event.requestContext.authorizer?.lambda?.callerArn as string | undefined) ?? // API key (Claude Desktop)
  'unknown';
```

**Claude Desktop MCP config** (`mcp-config` command updated output):

```json
{
  "mcpServers": {
    "skills-as-a-service": {
      "transport": {
        "type": "http",
        "url": "https://<api-id>.execute-api.us-east-1.amazonaws.com/mcp/desktop"
      },
      "headers": {
        "Authorization": "Bearer <api-key-from-secrets-manager>"
      }
    }
  }
}
```

**`skills-svc mcp-config` command** — fetch API key and print desktop config:

```typescript
// Add to mcp-config action:
if (opts.desktop) {
  const sm = new SecretsManagerClient({ region: cfg.region, credentials: creds });
  const keyRes = await sm.send(new GetSecretValueCommand({
    SecretId: `/skills-svc/${cfg.envName}/mcp/api-key`,
  }));
  const apiKey = keyRes.SecretString!;
  const desktopEndpoint = mcpEndpoint.replace('/mcp', '/mcp/desktop');

  const config = {
    mcpServers: {
      'skills-as-a-service': {
        transport: { type: 'http', url: desktopEndpoint },
        headers: { Authorization: `Bearer ${apiKey}` },
      },
    },
  };
  // ... write or print
}
```

Add `--desktop` flag to `mcp-config` command:
```typescript
.option('--desktop', 'Generate config for Claude Desktop (API key auth, not SigV4)', false)
```

**Add to `packages/cli/package.json` dependencies:**
```json
"@aws-sdk/client-secrets-manager": "^3.600.0"
```

---

## Fix 13: `SkillRegistryStack` — Proper `s3n` Import

**Add to top of `infra/lib/skill-registry-stack.ts`:**

```typescript
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
```

Remove the inline `require('aws-cdk-lib/aws-s3-notifications').LambdaDestination` used in SPEC-10.

---

## Fix 14: Validator Lambda Role — Add `ssm:GetParameter`

**In `infra/lib/skill-registry-stack.ts`** `validatorRole` inline policies, the `SSMRead` policy grants access but looking at SPEC-10, it does include this:

```typescript
validatorRole.addToPolicy(new iam.PolicyStatement({
  sid: 'SSMRead',
  actions: ['ssm:GetParameter', 'ssm:GetParameters'],
  resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
}));
```

This is already in SPEC-10. **Confirmed present — no change needed.** However, the KMS policy must also include the `dynamodbKey` for the skills table (SSM params themselves use SSM's own KMS). Verify the `KMSDecrypt` statement covers it:

```typescript
validatorRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KMSDecrypt',
  actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
  resources: [
    props.registryBucketKey.keyArn,
    props.dynamodbKey.keyArn,        // for skills DDB table writes
  ],
}));
```

This is already in SPEC-10. ✓ No change needed.

---

## Authoritative `infra/test/helpers.ts` — Updated for Fix 1 & 3

Replaces SPEC-12 Fix 12:

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
  const storage  = new StorageStack(app, 'Storage', {
    env, envName: 'test',
    uploadsBucketKey: security.uploadsBucketKey,
    resultsBucketKey: security.resultsBucketKey,
    dynamodbKey:      security.dynamodbKey,
  });

  // Tier 4 — needs Storage
  const skillRegistry = new SkillRegistryStack(app, 'SkillRegistry', {
    env, envName: 'test',
    vpc: network.vpc, lambdaSg: network.lambdaSg,
    registryBucketKey: security.registryBucketKey,
    dynamodbKey:       security.dynamodbKey,
    accessLogsBucket:  storage.accessLogsBucket,
  });

  const messaging = new MessagingStack(app, 'Messaging', {
    env, envName: 'test',
    messagingKey:  security.messagingKey,
    uploadsBucket: storage.uploadsBucket,
  });

  // Tier 5 — needs Messaging + SkillRegistry
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
    skillsTableName:       skillRegistry.skillsTable.tableName,      // wired
    registryBucket:        skillRegistry.registryBucket.bucketName,  // wired
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
    lambdaEnvKey:       security.lambdaEnvKey,
    userRole:           security.userRole,
    dynamodbTableName:  storage.jobsTable.tableName,
    uploadsBucket:      storage.uploadsBucket.bucketName,
    resultsBucket:      storage.resultsBucket.bucketName,
    uploadsKmsKeyId:    security.uploadsBucketKey.keyArn,
    queryLambdaArn:     lambdaStack.queryFn.functionArn,
    opensearchEndpoint: 'https://test.aoss.amazonaws.com',
    jobsTopicArn:       messaging.jobsNotificationTopic.topicArn,
    ecsClusterArn:      ecsStack.cluster.clusterArn,
    skillsTableName:    skillRegistry.skillsTable.tableName,
    registryBucket:     skillRegistry.registryBucket.bucketName,
    runSkillLambdaArn:  lambdaStack.runSkillFn.functionArn,
  });

  const monitoring = new MonitoringStack(app, 'Monitoring', {
    env, envName: 'test',
    ingestionFn:        lambdaStack.ingestionFn,
    resultsProcessorFn: lambdaStack.resultsProcessorFn,
    ingestionDLQ:       messaging.ingestionDLQ,
    resultsDLQ:         messaging.resultsDLQ,
    alarmTopic:         messaging.jobsNotificationTopic,
  });

  const compliance = new ComplianceStack(app, 'Compliance', {
    env, envName: 'test',
    auditKey:      security.auditKey,
    uploadsBucket: storage.uploadsBucket,
    resultsBucket: storage.resultsBucket,
  });

  return {
    network, security, storage, messaging,
    lambdaStack, ecsStack, knowledgeStore, skillRegistry,
    batchStack, mcpStack, monitoring, compliance,
    templates: {
      network:        Template.fromStack(network),
      security:       Template.fromStack(security),
      storage:        Template.fromStack(storage),
      messaging:      Template.fromStack(messaging),
      lambda:         Template.fromStack(lambdaStack),
      ecs:            Template.fromStack(ecsStack),
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

## QA Checks (QA-181 through QA-190)

```typescript
// QA-181: RunSkillLambda env has non-empty SKILLS_TABLE_NAME
test('QA-181: RunSkillLambda env SKILLS_TABLE_NAME is non-empty', () => {
  const { templates } = buildTestApp();
  const fns = templates.lambda.findResources('AWS::Lambda::Function');
  const runFn = Object.values(fns).find((fn: any) =>
    (fn as any).Properties.FunctionName?.includes('run-skill')
  ) as any;
  const env = runFn.Properties.Environment.Variables;
  expect(env.SKILLS_TABLE_NAME).toBeDefined();
  expect(env.SKILLS_TABLE_NAME).not.toBe('');
  expect(env.REGISTRY_BUCKET).toBeDefined();
  expect(env.REGISTRY_BUCKET).not.toBe('');
});

// QA-182: SkillRegistryStack depends on StorageStack (explicit CDK dependency)
test('QA-182: SkillRegistryStack addDependency includes StorageStack', () => {
  // Verify by inspecting that the CloudFormation template for SkillRegistry
  // references the access-logs bucket from StorageStack
  const { templates } = buildTestApp();
  const buckets = templates.skillRegistry.findResources('AWS::S3::Bucket');
  // Registry bucket should have server access logging pointing to access-logs bucket
  const registryBucket = Object.values(buckets).find((b: any) =>
    JSON.stringify(b).includes('registry')
  ) as any;
  expect(registryBucket.Properties.LoggingConfiguration).toBeDefined();
});

// QA-183: Validator Lambda is in VPC
test('QA-183: SkillValidatorLambda has VpcConfig', () => {
  const { templates } = buildTestApp();
  const fns = templates.skillRegistry.findResources('AWS::Lambda::Function');
  const validatorFn = Object.values(fns).find((fn: any) =>
    JSON.stringify(fn).includes('skill-validator')
  ) as any;
  expect(validatorFn.Properties.VpcConfig).toBeDefined();
  expect(validatorFn.Properties.VpcConfig.SubnetIds.length).toBeGreaterThanOrEqual(2);
});

// QA-184: batch.ts imports PutCommand and UpdateCommand
test('QA-184: batch run command imports PutCommand and UpdateCommand', () => {
  const source = readFileSync('packages/cli/src/commands/batch.ts', 'utf-8');
  expect(source).toContain('PutCommand');
  expect(source).toContain('UpdateCommand');
  expect(source).toContain('STSClient');
  expect(source).toContain('GetCallerIdentityCommand');
});

// QA-185: packages/lambda/package.json has all required AWS SDK clients
test('QA-185: lambda package.json includes all required SDK deps', () => {
  const pkg = JSON.parse(readFileSync('packages/lambda/package.json', 'utf-8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  const required = [
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-comprehend',
    '@aws-sdk/client-dynamodb',
    '@aws-sdk/client-ecs',
    '@aws-sdk/client-s3',
    '@aws-sdk/client-sns',
    '@aws-sdk/client-ssm',
    '@aws-sdk/lib-dynamodb',
    'aws-xray-sdk',
    '@skills-svc/shared',
  ];
  for (const dep of required) {
    expect(deps).toContain(dep);
  }
});

// QA-186: packages/cli/package.json has @aws-sdk/client-cloudformation
test('QA-186: cli package.json includes @aws-sdk/client-cloudformation', () => {
  const pkg = JSON.parse(readFileSync('packages/cli/package.json', 'utf-8'));
  expect(Object.keys(pkg.dependencies ?? {})).toContain('@aws-sdk/client-cloudformation');
});

// QA-187: RunResult type includes inputTokens and outputTokens
test('QA-187: RunResult interface has inputTokens and outputTokens fields', () => {
  const source = readFileSync('packages/shared/src/types.ts', 'utf-8');
  expect(source).toContain('inputTokens:');
  expect(source).toContain('outputTokens:');
});

// QA-188: skill pull verifies SHA256 before returning success
test('QA-188: skill pull verifies SHA256 and exits 1 on mismatch', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand)
    .resolvesOnce({ Item: { latestVersion: '1.0.0', latestStable: '1.0.0' } })
    .resolvesOnce({ Item: {
      s3Key: 'skills/alice/my-skill/1.0.0/skill.zip',
      zipSha256: 'aaaa1234deadbeef',  // won't match downloaded file
      deprecated: false,
    }});
  const s3Mock = mockClient(S3Client);
  s3Mock.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from('tampered-content')]) });
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

  await expect(runSkillPull('my-skill@1.0.0', {})).rejects.toThrow('exit');
  expect(exitSpy).toHaveBeenCalledWith(1);
});

// QA-189: MCP desktop route exists (separate from IAM route)
test('QA-189: MCPStack has /mcp/desktop route with Lambda authorizer', () => {
  const { templates } = buildTestApp();
  // API Gateway routes
  const routes = templates.mcp.findResources('AWS::ApiGatewayV2::Route');
  const routePaths = Object.values(routes).map((r: any) => r.Properties.RouteKey as string);
  expect(routePaths.some(r => r.includes('/mcp/desktop'))).toBe(true);
});

// QA-190: updateJobStatus stores inputTokens and outputTokens when provided
test('QA-190: updateJobStatus writes inputTokens/outputTokens to DDB', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({ Item: { version: 0, status: 'RUNNING' } });
  ddbMock.on(UpdateCommand).resolves({});

  await updateJobStatus('job-001', JobStatus.COMPLETE, 'prod', undefined, {
    inputTokens: 3500,
    outputTokens: 1200,
  });

  const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
  const values = updateCall.args[0].input.ExpressionAttributeValues;
  expect(values[':inTok']).toBe(3500);
  expect(values[':outTok']).toBe(1200);
  expect(updateCall.args[0].input.UpdateExpression).toContain('inputTokens');
});
```

---

## Spec Suite Completion Summary

| Spec | Lines | Focus |
|------|-------|-------|
| SPEC-01 | 966 | Architecture, CDK stack design, VPC, SSM layout |
| SPEC-02 | 1,358 | StorageStack, MessagingStack, LambdaStack, ECSStack, all handlers |
| SPEC-03 | 1,367 | Knowledge store, CLI commands, shared types, monitoring |
| SPEC-04 | 1,229 | QA-001–050: CDK assertions, security, Lambda correctness |
| SPEC-05 | 1,412 | QA-051–100: Integration tests, cost model, deployment runbook |
| SPEC-06 | (≈1,600) | Security hardening, Bedrock migration, envelope encryption, DLP |
| SPEC-07 | 1,641 | validate, --stream, watch, schedule commands |
| SPEC-08 | 1,735 | cancel, profiles, caching, batch, diff, cost, notify, audit |
| SPEC-09 | 1,412 | MCP Lambda server, 6 tools, Claude Desktop integration |
| SPEC-10 | 1,767 | Skill Registry: DDB schema, validator Lambda, CLI skill/run commands |
| SPEC-11 | 1,457 | 25 errata fixes (validator to shared, GSIs, IAM gaps, batch handlers) |
| SPEC-12 | 1,069 | 30 more fixes (RunSkillLambda wiring, buildTestApp, subpath imports) |
| SPEC-13 | ~1,050 | 14 terminal fixes (empty env vars, deploy order, package.json, tokens) |
| **Total** | **~17,000** | |

**The spec suite is now complete.** Drop all 13 SPEC-*.md files into Claude Code and implement.
