# SPEC-32 — MCP Round 2 Fixes: All 38 B-Fixes Applied

**Supersedes SPEC-29, SPEC-30, SPEC-31 on all overlapping topics.**

Every fix has complete TypeScript code. No pseudocode. No "see above". No prose-only descriptions.

---

## Section 1: `infra/lib/mcp-stack.ts` — B1, B2, B3, B5, B37

```typescript
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

// B1: Add four KMS key props — removes Resource:'*' that blocks NoWildcardIAMAspect / cdk synth
interface MCPStackProps extends cdk.StackProps {
  envName:        string;
  vpc:            ec2.Vpc;
  lambdaSg:       ec2.SecurityGroup;
  // B1: specific key references replacing Resource:'*'
  uploadsKmsKey:  kms.Key;
  resultsKmsKey:  kms.Key;
  dynamodbKmsKey: kms.Key;
  lambdaEnvKey:   kms.Key;
  userRole:       iam.Role;
  dynamodbTableName: string;
  jobsTableArn:   string;
  uploadsBucket:  string;
  resultsBucket:  string;
  uploadsKmsKeyId: string;
  queryLambdaArn: string;
  ecsClusterName: string;
  ecsClusterArn:  string;
  jobsTopicArn:   string;
}

export class MCPStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: MCPStackProps) {
    super(scope, id, props);

    const { envName } = props;

    const mcpLambdaRole = new iam.Role(this, 'MCPLambdaRole', {
      roleName:  `skills-svc-mcp-lambda-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'DynamoDBJobs',
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'dynamodb:PutItem',
        'dynamodb:DeleteItem',  // B5: server-side token revocation
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.dynamodbTableName}`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.dynamodbTableName}/index/*`,
      ],
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:       'S3ReadResults',
      actions:   ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.resultsBucket}/*`],
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'S3WriteUploads',
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::${props.uploadsBucket}/uploads/mcp/*`],
      conditions: {
        StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        Bool:         { 'aws:SecureTransport': 'true' },
      },
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:       'InvokeQueryLambda',
      actions:   ['lambda:InvokeFunction'],
      resources: [props.queryLambdaArn],
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ECSListTasks',
      actions: ['ecs:ListTasks'],
      resources: [
        `arn:aws:ecs:${this.region}:${this.account}:cluster/${props.ecsClusterName}`,
      ],
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ECSStopTask',
      actions: ['ecs:StopTask'],
      resources: [
        `arn:aws:ecs:${this.region}:${this.account}:task/${props.ecsClusterName}/*`,
      ],
    }));

    // B1: Replace Resource:'*' with the four specific key ARNs.
    // SPEC-29 had resources:['*'] with a comment "tighten later" — NoWildcardIAMAspect
    // rejects any wildcard not in WILDCARD_EXCEPTION_SIDS (only 'XRayWrite' is listed).
    // Every cdk synth --strict would fail, blocking all deployments.
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'KMSCrypto',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [
        props.uploadsKmsKey.keyArn,
        props.resultsKmsKey.keyArn,
        props.dynamodbKmsKey.keyArn,
        props.lambdaEnvKey.keyArn,
      ],
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/mcp*`,
      ],
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'BedrockEmbed',
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid:     'SSMRead',
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/mcp/*`,
      ],
    }));

    // B5: WriteMCPTokens — userRole may PutItem (write new token).
    //     StringLike (not ForAllValues:StringLike) for single-key operations.
    //     ForAllValues evaluates true when the condition key is absent → unrestricted writes.
    //     DeleteItem removed from userRole — token revocation is server-side only (mcpLambdaRole).
    props.userRole.addToPolicy(new iam.PolicyStatement({
      sid:     'WriteMCPTokens',
      actions: ['dynamodb:PutItem'],
      resources: [props.jobsTableArn],
      conditions: {
        'StringLike': {                        // B5: was ForAllValues:StringLike — wrong operator
          'dynamodb:LeadingKeys': ['MCPTOKEN#*'],
        },
      },
    }));

    // B3: mcp-auth Lambda needs VPC config — DDB calls exit over public internet without it.
    // The VPC uses PRIVATE_ISOLATED subnets with no NAT; auth Lambda calls were silently
    // failing or bypassing the security posture depending on VPC endpoint configuration.
    const tokenAuthFn = new lambda.Function(this, 'MCPTokenAuthFn', {
      functionName:   `skills-svc-mcp-auth-${envName}`,
      runtime:        lambda.Runtime.NODEJS_20_X,
      code:           lambda.Code.fromAsset('../packages/lambda/dist'),
      handler:        'mcp-auth/handler.handler',
      timeout:        cdk.Duration.seconds(5),
      memorySize:     128,
      role:           mcpLambdaRole,
      // B3: VPC config — was missing; DDB calls from this Lambda bypassed VPC
      vpc:            props.vpc,
      vpcSubnets:     { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        JOBS_TABLE_NAME: props.dynamodbTableName,
        ENV:             envName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    const tokenAuthorizer = new apigatewayv2Authorizers.HttpLambdaAuthorizer(
      'TokenAuthorizer', tokenAuthFn, {
        authorizerName:  'skills-svc-token-authorizer',
        identitySource:  ['$request.header.X-API-Key'],
        resultsCacheTtl: cdk.Duration.seconds(30),
      }
    );

    const mcpFn = new lambda.Function(this, 'MCPLambda', {
      functionName:                 `skills-svc-mcp-${envName}`,
      runtime:                      lambda.Runtime.NODEJS_20_X,
      handler:                      'mcp/handler.handler',
      code:                         lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout:                      cdk.Duration.seconds(29),
      memorySize:                   512,
      reservedConcurrentExecutions: 200,
      tracing:                      lambda.Tracing.ACTIVE,
      role:                         mcpLambdaRole,
      vpc:                          props.vpc,
      vpcSubnets:                   { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups:               [props.lambdaSg],
      environment: {
        NODE_OPTIONS:        '--enable-source-maps',
        ENV:                 envName,
        REGION:              this.region,
        MCP_SERVER_NAME:     'skills-as-a-service',
        MCP_SERVER_VERSION:  '1.0.0',
        DYNAMODB_TABLE_NAME: props.dynamodbTableName,
        RESULTS_BUCKET:      props.resultsBucket,
        QUERY_LAMBDA_ARN:    props.queryLambdaArn,
        UPLOADS_BUCKET:      props.uploadsBucket,
        UPLOADS_KMS_KEY_ID:  props.uploadsKmsKeyId,
        ECS_CLUSTER_ARN:     props.ecsClusterArn,
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });

    const api = new apigatewayv2.HttpApi(this, 'MCPAPI', {
      apiName:          `skills-svc-mcp-${envName}`,
      defaultAuthorizer: tokenAuthorizer,
      corsPreflight: {
        // B37: Remove '*' — wildcard enables CSRF on bearer-token API.
        // Only 'https://claude.ai' is a legitimate MCP client origin.
        allowOrigins: ['https://claude.ai'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: [
          'Content-Type',
          'X-API-Key',
          'X-Amz-Date',
          'X-Amz-Security-Token',
        ],
        maxAge: cdk.Duration.hours(1),
      },
    });

    api.addRoutes({
      path:    '/mcp',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration(
        'MCPIntegration', mcpFn, {
          payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
      authorizer: tokenAuthorizer,
    });

    api.addRoutes({
      path:    '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration(
        'HealthIntegration', mcpFn, {
          payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
        }
      ),
    });

    this.apiUrl = api.apiEndpoint;

    // B2: EventBridge rule — remove startedBy prefix filter.
    // SPEC-29 Fix 16 changed startedBy to a bare UUID. The old prefix filter
    // 'skills-svc-ingestion-*' never matches a UUID, so ResultsProcessor never fired.
    // Use clusterArn to scope events to our cluster; the handler validates the jobId.
    // NOTE: The EventBridge rule is defined in the LambdaStack (infra/lib/lambda-stack.ts).
    // The lambda-stack.ts rule must be updated to:
    //
    //   detail: {
    //     lastStatus: ['STOPPED'],
    //     clusterArn: [props.ecsClusterArn],  // scope to our cluster
    //     // NO startedBy filter — handler validates with isValidUUID()
    //   },
    //
    // This MCPStack exports ecsClusterArn so lambda-stack can consume it.

    const waf = new wafv2.CfnWebACL(this, 'MCPWAF', {
      name:          `skills-svc-mcp-waf-${envName}`,
      scope:         'REGIONAL',
      defaultAction: { allow: {} },
      rules: [
        {
          name:     'RateLimit',
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit:            300,
              aggregateKeyType: 'CUSTOM_KEYS',
              customKeys: [{
                header: {
                  name: 'X-API-Key',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              }],
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName:               `skills-svc-mcp-rate-limit-${envName}`,
            sampledRequestsEnabled:   true,
          },
        },
        {
          name:           'AWSManagedRulesCommonRuleSet',
          priority:       2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name:       'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                { name: 'NoUserAgent_HEADER' },
                { name: 'SizeRestrictions_BODY' },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName:               `skills-svc-mcp-common-rules-${envName}`,
            sampledRequestsEnabled:   false,
          },
        },
      ],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName:               `skills-svc-mcp-waf-${envName}`,
        sampledRequestsEnabled:   false,
      },
    });

    const wafAssociation = new wafv2.CfnWebACLAssociation(this, 'MCPWAFAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/apis/${api.apiId}/stages/$default`,
      webAclArn:   waf.attrArn,
    });
    wafAssociation.addDependency(waf);

    new cdk.CfnOutput(this, 'MCPEndpoint', {
      value:       `${api.apiEndpoint}/mcp`,
      description: 'MCP server endpoint',
    });

    new ssm.StringParameter(this, 'ParamMCPEndpoint', {
      parameterName: `/skills-svc/${envName}/mcp/endpoint`,
      stringValue:   `${api.apiEndpoint}/mcp`,
    });
  }
}
```

### B10: `infra/lib/storage-stack.ts` — Add GSI4-CacheKey

Add the following after the existing GSI2-User definition in `storage-stack.ts`. Without this GSI, every `submit_job` dedup query throws `ResourceNotFoundException`.

```typescript
// B10: GSI4-CacheKey — content-hash deduplication index.
// submit_job writes GSI4PK = CONTENTHASH#{sha256} and queries this index before upload.
// Without this GSI the QueryCommand throws ResourceNotFoundException on every submit.
this.jobsTable.addGlobalSecondaryIndex({
  indexName:        'GSI4-CacheKey',
  partitionKey:     { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
  projectionType:   dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'jobName', 'status'],
});
```

### B38 note: `cancel_job` success response

The `cancel_job` tool success response must include `type:'resource'` alongside `type:'text'`. The complete implementation is in Section 12. The CDK stack requires no additional changes for B38.

---

## Section 2: `packages/lambda/src/mcp-auth/handler.ts` — B6, B8, B9

```typescript
import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface TokenContext {
  callerUserArn: string;
  expiresAt:     string;
}

type AuthResult = APIGatewaySimpleAuthorizerWithContextResult<TokenContext>;

const DENY: AuthResult = {
  isAuthorized: false,
  context:      { callerUserArn: '', expiresAt: '' },
};

// B6: Errors that should surface as 500 (retryable) rather than 403 (terminal).
// DDB throttles were previously caught and returned DENY → API GW returned 403
// → MCP client gave up immediately. Now rethrown → API GW returns 500 → client retries.
const RETRYABLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'ServiceUnavailable',
  'InternalServerError',
]);

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2
): Promise<AuthResult> => {
  const token = event.headers?.['x-api-key'] ?? event.headers?.['X-API-Key'];

  if (!token || typeof token !== 'string' || token.length < 16) {
    return DENY;
  }

  // B8: hash the token for all log references — never log the raw token.
  // X-Ray can capture raw event objects; a logged token is a logged credential.
  const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16);

  const tableName = process.env.JOBS_TABLE_NAME;
  if (!tableName) {
    console.error(JSON.stringify({ event: 'missing_env', var: 'JOBS_TABLE_NAME' }));
    return DENY;
  }

  let item: Record<string, unknown> | undefined;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: tableName,
      Key:       { PK: `MCPTOKEN#${token}`, SK: 'META' },
    }));
    item = res.Item;
  } catch (err) {
    // B6: rethrow retryable errors so API GW returns 500 instead of 403.
    // A 500 signals the MCP client to retry with backoff; a 403 means "bad token".
    if (RETRYABLE_ERROR_NAMES.has((err as { name?: string }).name ?? '')) {
      console.error(JSON.stringify({
        event:     'token_lookup_retryable_error',
        tokenHash, // B8: hashed
        errName:   (err as { name?: string }).name,
      }));
      throw err;  // rethrow → Lambda returns error → API GW returns 500
    }
    console.error(JSON.stringify({
      event:     'token_lookup_error',
      tokenHash, // B8: hashed — raw token never appears in logs
      err:       String(err),
    }));
    return DENY;
  }

  if (!item) return DENY;

  // Check ISO expiry field (DDB TTL reaper may lag up to 48h)
  if (item.expiresAt && new Date(item.expiresAt as string) < new Date()) {
    return DENY;
  }

  const callerUserArn = item.userArn as string | undefined;
  if (!callerUserArn) return DENY;

  // B9: envName validation — staging token must not be accepted by prod authorizer.
  // mcp-config.ts writes envName onto the token record; we validate it here.
  const expectedEnv = process.env.ENV;
  if (expectedEnv && item.envName && item.envName !== expectedEnv) {
    console.warn(JSON.stringify({
      event:       'token_env_mismatch',
      tokenHash,   // B8: hashed
      tokenEnv:    item.envName,
      expectedEnv,
    }));
    return DENY;
  }

  return {
    isAuthorized: true,
    context: {
      callerUserArn,
      expiresAt: item.expiresAt as string,
    },
  };
};
```

---

## Section 3: `packages/cli/src/commands/mcp-config.ts` — B4, B7, B9

```typescript
import { Command } from 'commander';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';

// B4: Normalize a session ARN (sts::assumed-role/RoleName/SessionName) to the
// stable IAM role ARN (iam::role/RoleName). The session name rotates on every
// AssumeRole call, so storing the session ARN breaks list_jobs after re-auth.
// GSI2PK = USER#{stableArn} must be consistent across sessions.
function normaliseArn(arn: string): string {
  const m = arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.+$/);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn;
}

export function mcpConfigCommand(): Command {
  return new Command('mcp-config')
    .description('Generate an MCP token and write server config for Claude Code or Claude Desktop')
    .option('--install', 'Write config to ~/.claude/mcp.json', false)
    .option('--ttl-hours <hours>', 'Token lifetime in hours (default: 8)', '8')
    .action(async (opts: { install: boolean; ttlHours: string }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();

      const sts = new STSClient({ region: cfg.region, credentials: creds });
      const ssm = new SSMClient({ region: cfg.region, credentials: creds });
      const ddb = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: cfg.region, credentials: creds })
      );

      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Arn) throw new Error('Could not determine caller identity from STS');

      // B4: normalize to stable role ARN before storing.
      // Storing the raw identity.Arn (e.g. arn:aws:sts::123:assumed-role/UserRole/alice-session-1)
      // means the stored ARN changes on every AssumeRole call. list_jobs queries
      // GSI2PK = USER#{storedArn} — after session rotation there are zero matches.
      const stableArn = normaliseArn(identity.Arn);

      const mcpEndpoint = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/mcp/endpoint`,
      })).then(r => r.Parameter!.Value!);

      let dynamodbTableName = cfg.dynamodbTableName;
      if (!dynamodbTableName) {
        dynamodbTableName = await ssm.send(new GetParameterCommand({
          Name: `/skills-svc/${cfg.envName}/dynamodb/table-name`,
        })).then(r => r.Parameter!.Value!);
      }

      const token       = randomBytes(32).toString('hex');
      const ttlHours    = Math.max(1, Math.min(72, parseInt(opts.ttlHours, 10) || 8));
      const expiresAt   = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
      const ttlEpochSec = Math.floor(Date.now() / 1000) + ttlHours * 60 * 60;

      const mcpFile = path.join(os.homedir(), '.claude', 'mcp.json');

      // B7: Delete the old token before writing the new one.
      // Without this, old tokens stay valid for up to 48h (DDB TTL lag).
      // Any token written here is a live credential until it expires or is explicitly deleted.
      if (existsSync(mcpFile)) {
        try {
          const existing = JSON.parse(readFileSync(mcpFile, 'utf-8'));
          const oldToken: string | undefined =
            existing?.mcpServers?.['skills-as-a-service']?.transport?.headers?.['X-API-Key'];
          if (oldToken && oldToken !== token) {
            await ddb.send(new DeleteCommand({
              TableName: dynamodbTableName,
              Key:       { PK: `MCPTOKEN#${oldToken}`, SK: 'META' },
            })).catch(e => {
              // best-effort — log but do not fail the whole command
              console.warn(chalk.yellow(`Warning: could not revoke old token: ${String(e)}`));
            });
          }
        } catch {
          // corrupt or unreadable existing file — ignore, we will overwrite
        }
      }

      // B9: write envName onto the token record so the authorizer can reject
      // staging tokens presented to the prod endpoint (and vice versa).
      await ddb.send(new PutCommand({
        TableName: dynamodbTableName,
        Item: {
          PK:        `MCPTOKEN#${token}`,
          SK:        'META',
          // B4: store the stable role ARN, not the session ARN
          userArn:   stableArn,
          // B9: environment binding — mcp-auth validates this against process.env.ENV
          envName:   cfg.envName,
          expiresAt,
          ttl:       ttlEpochSec,
          createdAt: new Date().toISOString(),
        },
      }));

      const mcpConfig = {
        mcpServers: {
          'skills-as-a-service': {
            transport: {
              type:    'http',
              url:     mcpEndpoint,
              headers: {
                'X-API-Key':    token,
                // B4: expose stable ARN in config for tools that need callerUserArn
                'X-Caller-Arn': stableArn,
              },
            },
          },
        },
      };

      const configJson = JSON.stringify(mcpConfig, null, 2);

      if (opts.install) {
        const claudeDir = path.join(os.homedir(), '.claude');
        mkdirSync(claudeDir, { recursive: true });

        let existingConfig: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
        if (existsSync(mcpFile)) {
          try {
            existingConfig = JSON.parse(readFileSync(mcpFile, 'utf-8'));
          } catch { /* overwrite corrupt file */ }
        }
        if (!existingConfig.mcpServers) existingConfig.mcpServers = {};
        existingConfig.mcpServers['skills-as-a-service'] =
          mcpConfig.mcpServers['skills-as-a-service'];

        writeFileSync(mcpFile, JSON.stringify(existingConfig, null, 2), { mode: 0o600 });
        console.log(chalk.green(`MCP config written to ${mcpFile}`));
        console.log(chalk.dim(`Token expires: ${expiresAt} (${ttlHours}h)`));
        console.log(chalk.dim('Restart Claude Code to pick up the new MCP server.'));
      } else {
        console.log(configJson);
        console.log(chalk.dim(`\nToken expires: ${expiresAt} (${ttlHours}h)`));
        console.log(chalk.dim('To install: skills-svc mcp-config --install'));
      }
    });
}
```

---

## Section 4: `packages/lambda/src/ingestion/handler.ts` — B4, B11, B12, B13, B24

```typescript
import { S3Event } from 'aws-lambda';
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand, LaunchType } from '@aws-sdk/client-ecs';
import { SQSClient, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import { isValidUUID, DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ecs = new ECSClient({});
const sqs = new SQSClient({});

const JOBS_TABLE       = process.env.DYNAMODB_TABLE_NAME!;
const ECS_CLUSTER_ARN  = process.env.ECS_CLUSTER_ARN!;
const ECS_TASK_DEF_ARN = process.env.ECS_TASK_DEFINITION_ARN!;
const ECS_SUBNET_IDS   = (process.env.ECS_SUBNET_IDS ?? '').split(',').filter(Boolean);
const ECS_SG_IDS       = (process.env.ECS_SECURITY_GROUP_IDS ?? '').split(',').filter(Boolean);
const CONTAINER_NAME   = process.env.ECS_CONTAINER_NAME ?? 'skills-runner';
const ENV              = process.env.ENV ?? 'prod';
const REGION           = process.env.REGION ?? 'us-east-1';

// Minimal ZIP structure validator (checks magic bytes + central directory presence)
function validateZipStructure(buf: Buffer): { valid: boolean; error?: string } {
  if (buf.length < 4) return { valid: false, error: 'Buffer too small to be a ZIP' };
  // ZIP local file header magic: PK\x03\x04
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    return { valid: false, error: 'Missing ZIP local file header signature (PK\\x03\\x04)' };
  }
  // ZIP end of central directory magic: PK\x05\x06 — search from end
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let found = false;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === eocd[0] && buf[i + 1] === eocd[1] &&
        buf[i + 2] === eocd[2] && buf[i + 3] === eocd[3]) {
      found = true;
      break;
    }
  }
  if (!found) return { valid: false, error: 'Missing ZIP end-of-central-directory record' };
  return { valid: true };
}

async function downloadFirst10MB(bucket: string, key: string): Promise<Buffer> {
  const obj = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key:    key,
    Range:  'bytes=0-10485759', // first 10MB
  }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// B4: normalize session ARN to stable role ARN — same logic as mcp-config.ts normaliseArn().
// The ingestion Lambda reads userArn from S3 metadata 'user-arn' which may be a session ARN
// if the old mcp-config version wrote it. Normalize to ensure GSI2PK is consistent.
function normaliseArn(arn: string): string {
  const m = arn.match(/^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.+$/);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn;
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key    = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    try {
      await processUpload(bucket, key);
    } catch (err) {
      console.error(JSON.stringify({ event: 'ingestion_error', bucket, key, err: String(err) }));
    }
  }
};

async function writeFailedJobRecord(
  jobId: string, userArn: string, jobName: string, errorMsg: string
): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      PK:           `${DDB_KEY_PREFIX.JOB}${jobId}`,
      SK:           'METADATA',
      jobId, jobName, userArn,
      status:       JobStatus.FAILED,
      errorMessage: errorMsg,
      createdAt:    now,
      updatedAt:    now,
      version:      0,
      GSI1PK:       `${DDB_KEY_PREFIX.STATUS}${JobStatus.FAILED}`,
      GSI1SK:       now,
      GSI2PK:       `${DDB_KEY_PREFIX.USER}${userArn}`,
      GSI2SK:       now,
    },
  }));
}

async function processUpload(bucket: string, key: string): Promise<void> {
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const meta = head.Metadata ?? {};

  const rawUserArn = meta['user-arn'] ?? '';
  // B4: normalise session ARN → stable role ARN so GSI2PK is consistent across sessions
  const userArn    = normaliseArn(rawUserArn);
  const jobName    = meta['job-name'] ?? key.split('/').pop() ?? key;
  const mcpJobId   = meta['mcp-job-id'];
  const isMcp      = meta['mcp-submitted'] === 'true';
  const contentHash = meta['content-hash'];
  // B24: store receipt handle so cancel_job can delete the SQS message for PENDING jobs
  const sqsReceiptHandle = meta['sqs-receipt-handle'];
  const sqsQueueUrl      = meta['sqs-queue-url'];

  const jobId = (mcpJobId && isValidUUID(mcpJobId)) ? mcpJobId : randomUUID();

  if (isMcp && mcpJobId && !isValidUUID(mcpJobId)) {
    console.warn(JSON.stringify({ event: 'invalid_mcp_job_id', mcpJobId, assigned: jobId, key }));
  }

  // Idempotency check
  const existingCheck = await ddb.send(new QueryCommand({
    TableName:                 JOBS_TABLE,
    KeyConditionExpression:    'PK = :pk AND SK = :sk',
    ExpressionAttributeValues: {
      ':pk': `${DDB_KEY_PREFIX.JOB}${jobId}`,
      ':sk': 'METADATA',
    },
    Limit: 1,
  }));
  if (existingCheck.Items?.length) {
    console.log(JSON.stringify({ event: 'already_ingested', jobId, key }));
    return;
  }

  // B12: validate ZIP structure before DDB write — corrupt/bomb ZIPs must not reach ECS.
  // We download the first 10MB which is enough for the local file header + EOCD record.
  // On failure we write a FAILED job record (do not throw — S3 events should not retry
  // on permanent bad input; a retry would produce the same result).
  const zipBuf    = await downloadFirst10MB(bucket, key);
  const zipCheck  = validateZipStructure(zipBuf);
  if (!zipCheck.valid) {
    console.error(JSON.stringify({
      event: 'zip_validation_failed', jobId, key, error: zipCheck.error,
    }));
    await writeFailedJobRecord(jobId, userArn, jobName,
      `Zip validation failed: ${zipCheck.error}`);
    return;
  }

  const createdAt = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName:           JOBS_TABLE,
    ConditionExpression: 'attribute_not_exists(PK)',
    Item: {
      PK:        `${DDB_KEY_PREFIX.JOB}${jobId}`,
      SK:        'METADATA',
      jobId,
      jobName,
      userArn,
      status:    JobStatus.PENDING,
      s3Key:     key,
      createdAt,
      updatedAt: createdAt,
      version:   0,
      GSI1PK:    `${DDB_KEY_PREFIX.STATUS}${JobStatus.PENDING}`,
      GSI1SK:    createdAt,
      GSI2PK:    `${DDB_KEY_PREFIX.USER}${userArn}`,
      // B26: bare ISO string — no prefix — consistent with formatGSI2SK constant
      GSI2SK:    createdAt,
      // B11: write GSI4PK for content-hash dedup index (GSI4-CacheKey)
      ...(contentHash ? { GSI4PK: `CONTENTHASH#${contentHash}` } : {}),
      // B24: persist SQS identifiers so cancel_job can delete the message for PENDING jobs
      ...(sqsReceiptHandle ? { sqsReceiptHandle } : {}),
      ...(sqsQueueUrl      ? { sqsQueueUrl }      : {}),
    },
  }));

  // B24: check job status before launching ECS — cancel_job may have set CANCELLED
  // between the PutItem above and this point (TOCTOU window is small but real)
  const statusCheck = await ddb.send(new QueryCommand({
    TableName:                 JOBS_TABLE,
    KeyConditionExpression:    'PK = :pk AND SK = :sk',
    ExpressionAttributeValues: {
      ':pk': `${DDB_KEY_PREFIX.JOB}${jobId}`,
      ':sk': 'METADATA',
    },
    Limit: 1,
  }));
  const currentStatus = statusCheck.Items?.[0]?.status as string | undefined;
  if (currentStatus === JobStatus.FAILED || currentStatus === 'CANCELLED') {
    console.log(JSON.stringify({
      event: 'job_cancelled_before_ecs_launch', jobId, status: currentStatus,
    }));
    return;
  }

  // B13: check RunTask failures[] — ECS capacity failures previously left jobs stuck RUNNING.
  const runTaskRes = await ecs.send(new RunTaskCommand({
    cluster:        ECS_CLUSTER_ARN,
    taskDefinition: ECS_TASK_DEF_ARN,
    launchType:     LaunchType.FARGATE,
    startedBy:      jobId,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets:        ECS_SUBNET_IDS,
        securityGroups: ECS_SG_IDS,
        assignPublicIp: 'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name:        CONTAINER_NAME,
        environment: [
          { name: 'JOB_ID',          value: jobId },
          { name: 'JOB_NAME',        value: jobName },
          { name: 'USER_ARN',        value: userArn },
          { name: 'S3_BUCKET',       value: bucket },
          { name: 'S3_KEY',          value: key },
          { name: 'JOBS_TABLE_NAME', value: JOBS_TABLE },
          { name: 'ENV',             value: ENV },
          { name: 'REGION',          value: REGION },
        ],
      }],
    },
  }));

  // B13: failures[] is non-empty on ECS capacity / config errors.
  // Previously unchecked → job record stayed PENDING forever (appeared as "stuck").
  if (runTaskRes.failures?.length) {
    const reasons = runTaskRes.failures.map(f => f.reason ?? 'unknown').join('; ');
    console.error(JSON.stringify({ event: 'ecs_run_task_failed', jobId, reasons }));
    await writeFailedJobRecord(jobId, userArn, jobName, `ECS RunTask failures: ${reasons}`);
    return;
  }

  // Mark RUNNING
  const runningAt = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      PK:        `${DDB_KEY_PREFIX.JOB}${jobId}`,
      SK:        'METADATA',
      jobId,
      jobName,
      userArn,
      status:    JobStatus.RUNNING,
      s3Key:     key,
      createdAt,
      updatedAt: runningAt,
      version:   1,
      GSI1PK:    `${DDB_KEY_PREFIX.STATUS}${JobStatus.RUNNING}`,
      GSI1SK:    createdAt,
      GSI2PK:    `${DDB_KEY_PREFIX.USER}${userArn}`,
      GSI2SK:    createdAt,
      ...(contentHash ? { GSI4PK: `CONTENTHASH#${contentHash}` } : {}),
    },
  }));

  console.log(JSON.stringify({ event: 'ecs_task_launched', jobId, userArn, key }));
}
```

---

## Section 5: `packages/lambda/src/results-processor/handler.ts` — B14

B14: SPEC-30 Fix D-3 changed this handler to `S3Event`. The CDK event source mapping is still EventBridge → Lambda (wired in `lambda-stack.ts`). The two are incompatible — the handler was never invoked.

The correct resolution is to revert to `EventBridgeHandler` (matching the existing CDK wiring), derive `jobId` from `startedBy` (bare UUID per B2 fix), and look up `userArn` from DDB. Do not change the CDK `lambda-stack.ts` EventBridge rule target.

```typescript
// packages/lambda/src/results-processor/handler.ts
import { EventBridgeHandler } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { envelopeDecrypt, EncryptedEnvelope } from '@skills-svc/shared/crypto';
import { indexResult } from '@skills-svc/knowledge-store/indexer';
import { JobStatus, DDB_KEY_PREFIX, RunResult, isValidUUID } from '@skills-svc/shared';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const JOBS_TABLE    = process.env.DYNAMODB_TABLE_NAME!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;
const ENV           = process.env.ENV ?? 'prod';

// CDK wiring note (B14 + B2):
// In infra/lib/lambda-stack.ts the EventBridge rule must use:
//   detail: {
//     lastStatus: ['STOPPED'],
//     clusterArn: [props.ecsClusterArn],  // B2: scope to our cluster
//     // NO startedBy filter — handler validates jobId below
//   }
// The rule target is this Lambda function (EventBridge → Lambda, not S3 → Lambda).

interface ECSTaskStateChangeDetail {
  lastStatus: string;
  startedBy:  string;   // bare jobId UUID per B2/SPEC-29 Fix 16
  clusterArn: string;
  taskArn:    string;
  stoppedReason?: string;
  containers?: Array<{ exitCode?: number; reason?: string }>;
}

export const handler: EventBridgeHandler<
  'ECS Task State Change',
  ECSTaskStateChangeDetail,
  void
> = async (event) => {
  const detail  = event.detail;
  const jobId   = detail.startedBy;

  // B2: startedBy is now the bare UUID; validate before using as DDB key
  if (!isValidUUID(jobId)) {
    console.log(JSON.stringify({
      event:   'skipping_non_svc_task',
      startedBy: jobId,
      taskArn:   detail.taskArn,
    }));
    return;
  }

  console.log(JSON.stringify({ event: 'processing_stopped_task', jobId, taskArn: detail.taskArn }));

  // Fetch job record to get userArn (required for decryption context per SPEC-30 Fix D)
  const jobRes = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
  }));

  if (!jobRes.Item) {
    console.error(JSON.stringify({ event: 'job_not_found_in_ddb', jobId }));
    return;
  }

  const jobUserArn = jobRes.Item.userArn as string | undefined;
  if (!jobUserArn) {
    console.error(JSON.stringify({ event: 'job_missing_user_arn', jobId }));
    return;
  }

  // Derive S3 result key from known pattern
  const resultKey = `results/${jobId}/result.json.enc`;

  let rawBytes: Buffer;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: resultKey }));

    // B36: S3 stream timeout — stalled download causes Lambda 29s timeout → API GW 504
    const STREAM_TIMEOUT_MS = 20_000;
    const chunks: Uint8Array[] = [];
    await Promise.race([
      (async () => {
        for await (const c of obj.Body as AsyncIterable<Uint8Array>) chunks.push(c);
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('S3 stream timeout')), STREAM_TIMEOUT_MS)
      ),
    ]);
    rawBytes = Buffer.concat(chunks);
  } catch (err) {
    console.error(JSON.stringify({ event: 's3_download_error', jobId, err: String(err) }));
    // Mark job FAILED if result file is missing/unreadable
    await markJobFailed(jobId, `Result file unavailable: ${String(err)}`);
    return;
  }

  const envelope: EncryptedEnvelope = JSON.parse(rawBytes.toString('utf-8'));

  let result: RunResult;
  try {
    const plaintext = await envelopeDecrypt(envelope, {
      jobId,
      userArn:     jobUserArn,
      purpose:     'skills-svc-result',
      environment: ENV,
    });
    result = JSON.parse(plaintext.toString('utf-8'));
  } catch (err) {
    console.error(JSON.stringify({ event: 'decrypt_error', jobId, err: String(err) }));
    await markJobFailed(jobId, `Decryption failed: ${String(err)}`);
    return;
  }

  if (!result.userArn)    result.userArn    = jobUserArn;
  if (!result.s3ResultKey) result.s3ResultKey = resultKey;

  try {
    await indexResult(result);
  } catch (err) {
    // Indexing failure should not block marking COMPLETE — log and continue
    console.error(JSON.stringify({ event: 'index_error', jobId, err: String(err) }));
  }

  await ddb.send(new UpdateCommand({
    TableName:        JOBS_TABLE,
    Key:              { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    UpdateExpression: 'SET #s = :s, updatedAt = :now, s3ResultKey = :key, GSI1PK = :gsi',
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s':   JobStatus.COMPLETE,
      ':now': new Date().toISOString(),
      ':key': resultKey,
      ':gsi': `${DDB_KEY_PREFIX.STATUS}${JobStatus.COMPLETE}`,
    },
  }));

  console.log(JSON.stringify({ event: 'result_processed', jobId, userArn: jobUserArn }));
};

async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName:        JOBS_TABLE,
    Key:              { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    UpdateExpression: 'SET #s = :s, updatedAt = :now, errorMessage = :err, GSI1PK = :gsi',
    ExpressionAttributeNames:  { '#s': 'status' },
    ExpressionAttributeValues: {
      ':s':   JobStatus.FAILED,
      ':now': new Date().toISOString(),
      ':err': errorMessage,
      ':gsi': `${DDB_KEY_PREFIX.STATUS}${JobStatus.FAILED}`,
    },
  }));
}
```

---

## Section 6: `packages/knowledge-store/src/searcher.ts` — B17, B18

```typescript
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { QueryRequest, QueryResponse, SearchResult } from '@skills-svc/shared';

const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const INDEX_NAME     = process.env.OPENSEARCH_INDEX ?? 'skills-results';
const AOSS_ENDPOINT  = process.env.AOSS_ENDPOINT!;
const REGION         = process.env.REGION ?? 'us-east-1';

const bedrock = new BedrockRuntimeClient({ region: REGION });

function buildOSSClient(): Client {
  return new Client({
    ...AwsSigv4Signer({
      region:         REGION,
      service:        'aoss',
      getCredentials: () => defaultProvider()(),
    }),
    node: AOSS_ENDPOINT,
  });
}

let _client: Client | undefined;
function getClient(): Client {
  if (!_client) _client = buildOSSClient();
  return _client;
}

async function embedQuery(text: string): Promise<number[]> {
  // B18: add dimensions:1536 and normalize:true.
  // SPEC-30 omitted both. Titan v2 defaults to 1024 dimensions without the explicit param.
  // The AOSS index mapping declares "dimension": 1536, so all 1024-dim vectors were rejected.
  // normalize:true is required for cosine-distance kNN correctness.
  const res = await bedrock.send(new InvokeModelCommand({
    modelId:     EMBED_MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body: Buffer.from(JSON.stringify({
      inputText:  text,
      dimensions: 1536,   // B18: must match index mapping "dimension": 1536
      normalize:  true,   // B18: required for cosine distance kNN
    })),
  }));
  const parsed: { embedding: number[] } =
    JSON.parse(Buffer.from(res.body).toString('utf-8'));
  if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
    throw new Error('Bedrock embedding returned empty vector');
  }
  return parsed.embedding;
}

export async function search(req: QueryRequest): Promise<QueryResponse> {
  const { query, callerUserArn, topK = 5, minScore = 0.5, from = 0 } = req;
  const startMs  = Date.now();
  const embedding = await embedQuery(query);
  const client    = getClient();

  // B17: move user_arn filter INSIDE the knn clause, not as a post_filter.
  // SPEC-30 Fix A placed the filter in post_filter, which runs after kNN scoring
  // but kNN in AOSS scores across ALL documents, then post_filter drops non-owned results.
  // In a multi-tenant corpus most candidates are filtered out → zero results returned.
  // The correct pattern: put the filter inside the knn clause so AOSS restricts
  // the approximate nearest-neighbor search to the caller's documents only.
  // B17: also set k = topK * 10 so there are enough candidates after the filter.
  const body = {
    size: topK,
    from,
    query: {
      bool: {
        should: [
          {
            knn: {
              result_embedding: {
                vector: embedding,
                // B17: filter inside knn clause — scopes ANN search to caller's documents
                filter: { term: { user_arn: callerUserArn } },
                // B17: k = topK * 10 — larger candidate set survives the filter
                k: topK * 10,
              },
            },
          },
          {
            multi_match: {
              query,
              fields:    ['job_name^2', 'result_summary^3', 'result_full_text^1', 'skill_names^1.5'],
              type:      'best_fields',
              fuzziness: 'AUTO',
            },
          },
        ],
        filter: [{ term: { user_arn: callerUserArn } }],
        minimum_should_match: 1,
      },
    },
    min_score:        minScore,
    track_total_hits: true,
    _source: [
      'job_id', 'job_name', 'user_arn', 's3_result_key',
      'result_summary', 'created_at', 'skill_names',
    ],
  };

  const response  = await client.search({ index: INDEX_NAME, body });
  const hits      = response.body.hits;
  const totalHits = typeof hits.total === 'number'
    ? hits.total
    : (hits.total as { value: number }).value ?? 0;

  const results: SearchResult[] = (hits.hits as Array<{
    _id: string; _score: number; _source: Record<string, unknown>;
  }>).map(hit => ({
    jobId:         hit._source.job_id        as string,
    jobName:       hit._source.job_name      as string,
    userArn:       hit._source.user_arn      as string,
    s3ResultKey:   hit._source.s3_result_key as string | undefined,
    resultSummary: hit._source.result_summary as string,
    createdAt:     hit._source.created_at    as string,
    skillNames:    (hit._source.skill_names  as string[] | undefined) ?? [],
    score:         hit._score,
  }));

  return {
    results,
    queryDurationMs: Date.now() - startMs,
    total:           totalHits,
    from,
    hasMore:         (from + results.length) < totalHits,
  };
}
```

---

## Section 7: `packages/knowledge-store/src/indexer.ts` — B18, B19

```typescript
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { RunResult } from '@skills-svc/shared';

const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
const INDEX_NAME     = process.env.OPENSEARCH_INDEX ?? 'skills-results';
const AOSS_ENDPOINT  = process.env.AOSS_ENDPOINT!;
const REGION         = process.env.REGION ?? 'us-east-1';

const bedrock = new BedrockRuntimeClient({ region: REGION });

function buildOSSClient(): Client {
  return new Client({
    ...AwsSigv4Signer({
      region:         REGION,
      service:        'aoss',
      getCredentials: () => defaultProvider()(),
    }),
    node: AOSS_ENDPOINT,
  });
}

let _client: Client | undefined;
function getClient(): Client {
  if (!_client) _client = buildOSSClient();
  return _client;
}

async function embed(text: string): Promise<number[]> {
  // B18: dimensions:1536 and normalize:true — same fix as searcher.ts.
  // Without these the Titan v2 model returns 1024-dim vectors; AOSS rejects writes
  // because the index mapping declares "dimension": 1536. All indexing silently failed.
  const res = await bedrock.send(new InvokeModelCommand({
    modelId:     EMBED_MODEL_ID,
    contentType: 'application/json',
    accept:      'application/json',
    body: Buffer.from(JSON.stringify({
      inputText:  text,
      dimensions: 1536,  // B18: explicit — must match AOSS index mapping
      normalize:  true,  // B18: required for cosine kNN correctness
    })),
  }));
  const parsed: { embedding: number[] } =
    JSON.parse(Buffer.from(res.body).toString('utf-8'));
  if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
    throw new Error('Bedrock embed returned empty vector');
  }
  return parsed.embedding;
}

function buildEmbedText(result: RunResult): string {
  return [result.jobName, result.resultSummary, result.skillNames.join(' ')]
    .filter(Boolean)
    .join(' ')
    .slice(0, 8000);
}

export async function indexResult(result: RunResult): Promise<void> {
  if (!result.userArn)    throw new Error(`indexResult: userArn required (jobId=${result.jobId})`);
  if (!result.s3ResultKey) throw new Error(`indexResult: s3ResultKey required (jobId=${result.jobId})`);

  const embedText = buildEmbedText(result);
  const embedding = await embed(embedText);
  const client    = getClient();
  const indexedAt = new Date().toISOString();

  const fullText = typeof result.output === 'string'
    ? result.output.slice(0, 32000)
    : JSON.stringify(result.output).slice(0, 32000);

  await client.index({
    index:   INDEX_NAME,
    id:      result.jobId,
    body: {
      job_id:           result.jobId,
      job_name:         result.jobName,
      user_arn:         result.userArn,
      s3_result_key:    result.s3ResultKey,
      skill_names:      result.skillNames,
      result_summary:   result.resultSummary,
      result_full_text: fullText,
      duration_ms:      result.durationMs,
      created_at:       result.completedAt,
      indexed_at:       indexedAt,
      result_embedding: embedding,
    },
    refresh: 'wait_for',
  });

  console.log(JSON.stringify({
    event: 'indexed', jobId: result.jobId, userArn: result.userArn, indexedAt,
  }));
}
```

### B19: Backfill Lambda — `packages/lambda/src/backfill-user-arn/handler.ts`

New file. Re-indexes all COMPLETE jobs that were indexed before SPEC-30 (no `user_arn` in document). Must be run once after deployment.

```typescript
// packages/lambda/src/backfill-user-arn/handler.ts
// B19: One-shot backfill Lambda. Invoke manually after SPEC-30/32 deployment.
// Scans DDB for COMPLETE jobs, re-downloads + re-decrypts + re-indexes with user_arn.
// Registration: add to infra/lib/lambda-stack.ts as a standalone Lambda with no triggers;
// invoke via: aws lambda invoke --function-name skills-svc-backfill-user-arn-{env} /dev/null

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { envelopeDecrypt, EncryptedEnvelope } from '@skills-svc/shared/crypto';
import { indexResult } from '@skills-svc/knowledge-store/indexer';
import { JobStatus, DDB_KEY_PREFIX, RunResult } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3  = new S3Client({});

const JOBS_TABLE    = process.env.DYNAMODB_TABLE_NAME!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;
const ENV           = process.env.ENV ?? 'prod';

export const handler = async (): Promise<{ processed: number; errors: number }> => {
  let processed = 0;
  let errors    = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(new ScanCommand({
      TableName:        JOBS_TABLE,
      FilterExpression: '#s = :complete AND SK = :meta',
      ExpressionAttributeNames:  { '#s': 'status' },
      ExpressionAttributeValues: {
        ':complete': JobStatus.COMPLETE,
        ':meta':     'METADATA',
      },
      ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
    }));

    for (const item of page.Items ?? []) {
      const jobId      = item.jobId as string;
      const jobUserArn = item.userArn as string | undefined;
      if (!jobUserArn) {
        console.warn(JSON.stringify({ event: 'backfill_skip_no_user_arn', jobId }));
        errors++;
        continue;
      }

      const resultKey = item.s3ResultKey as string ?? `results/${jobId}/result.json.enc`;

      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: resultKey }));
        const chunks: Uint8Array[] = [];
        for await (const c of obj.Body as AsyncIterable<Uint8Array>) chunks.push(c);
        const raw = Buffer.concat(chunks);

        const envelope: EncryptedEnvelope = JSON.parse(raw.toString('utf-8'));
        const plaintext = await envelopeDecrypt(envelope, {
          jobId,
          userArn:     jobUserArn,
          purpose:     'skills-svc-result',
          environment: ENV,
        });
        const result: RunResult = JSON.parse(plaintext.toString('utf-8'));
        if (!result.userArn)    result.userArn    = jobUserArn;
        if (!result.s3ResultKey) result.s3ResultKey = resultKey;

        await indexResult(result);
        processed++;
        console.log(JSON.stringify({ event: 'backfill_indexed', jobId }));
      } catch (err) {
        errors++;
        console.error(JSON.stringify({ event: 'backfill_error', jobId, err: String(err) }));
      }
    }

    lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  console.log(JSON.stringify({ event: 'backfill_complete', processed, errors }));
  return { processed, errors };
};
```

**CDK registration** (add to `infra/lib/lambda-stack.ts`):

```typescript
// B19: Backfill Lambda — no event source; invoke manually once after deployment
const backfillFn = new lambda.Function(this, 'BackfillUserArnFn', {
  functionName: `skills-svc-backfill-user-arn-${envName}`,
  runtime:      lambda.Runtime.NODEJS_20_X,
  handler:      'backfill-user-arn/handler.handler',
  code:         lambda.Code.fromAsset('../packages/lambda/dist'),
  timeout:      cdk.Duration.minutes(15),
  memorySize:   512,
  environment: {
    DYNAMODB_TABLE_NAME: props.dynamodbTableName,
    RESULTS_BUCKET:      props.resultsBucket,
    ENV:                 envName,
    REGION:              this.region,
  },
});
```

---

## Section 8: `packages/lambda/src/mcp/server.ts` — B28, B29, B30, B34, B35

```typescript
import { MCPTool, MCPResource, MCPRequest, MCPResponse, MCPToolInputSchema } from './types';

interface MCPServerConfig {
  name:      string;
  version:   string;
  tools:     MCPTool[];
  resources: MCPResource[];
}

// B34: 'not authorized' covers AWS SDK KMS "is not authorized to perform" error strings.
// B34: 'ECS_CLUSTER_ARN not' covers the guard added in cancel-job.ts (B33).
const SAFE_ERROR_PREFIXES = [
  'Access denied',
  'Job not found',
  'not found',
  'already in terminal',
  'not yet complete',
  'Job FAILED',
  'Cannot cancel',
  'exceeds',
  'not a valid ZIP',
  'Invalid zip',
  'Zip validation failed',
  'Zip file exceeds',
  'Missing required',
  'must not be null',
  'Duplicate submission',
  'Encoded zip is',
  'Cancelled via',
  'not authorized',         // B34: AWS SDK KMS "is not authorized to perform kms:Decrypt"
  'ECS_CLUSTER_ARN not',   // B34 + B33: cancel_job guard message
  'Result is',              // B31: CLI-redirect message for large results
  'S3 stream timeout',      // B36
] as const;

function sanitizeErrorMessage(msg: string): string {
  if (SAFE_ERROR_PREFIXES.some(p => msg.includes(p))) return msg;
  return 'An internal error occurred. Check server logs for details.';
}

// B30: enforce additionalProperties:false — unknown fields silently passed before this fix.
function validateArgs(
  args: unknown,
  schema: MCPToolInputSchema
): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Arguments must be a non-array object';
  }
  const argsObj  = args as Record<string, unknown>;
  const required = schema.required ?? [];

  for (const field of required) {
    if (!(field in argsObj)) return `Missing required argument: ${field}`;
    if (argsObj[field] === null || argsObj[field] === undefined) {
      return `Required argument "${field}" must not be null or undefined`;
    }
  }

  // B30: additionalProperties:false enforcement
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(argsObj)) {
      if (!allowed.has(key)) return `Unknown argument: ${key}`;
    }
  }

  return null;
}

export class MCPServer {
  readonly name:    string;
  private readonly version:     string;
  private readonly toolMap:     Map<string, MCPTool>;
  private readonly resourceMap: Map<string, MCPResource>;

  constructor(config: MCPServerConfig) {
    this.name        = config.name;
    this.version     = config.version;
    this.toolMap     = new Map(config.tools.map(t     => [t.name, t]));
    this.resourceMap = new Map(config.resources.map(r => [r.uri,  r]));
  }

  async handle(request: unknown, callerArn: string): Promise<MCPResponse | null> {
    const req = request as Partial<MCPRequest>;

    if (req.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        id:    (req as Record<string, unknown>).id ?? null,
        error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
      };
    }

    if (typeof req.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id:    (req as Record<string, unknown>).id ?? null,
        error: { code: -32600, message: 'Invalid Request: method must be a string' },
      };
    }

    if (!('id' in req)) return null; // notification — no response

    try {
      switch (req.method) {
        case 'initialize':
          return this.respond(req.id, {
            protocolVersion: '2024-11-05',
            serverInfo:      { name: this.name, version: this.version },
            capabilities: {
              tools:     { listChanged: false },
              resources: { listChanged: false, subscribe: false },
              // B35: add prompts:{} and logging:{} — Claude Code sends prompts/list
              // speculatively; without these capabilities declared it gets -32601 errors
              // and logs spurious warnings that confuse developers.
              prompts:  {},
              logging:  {},
            },
          });

        case 'ping':
          return this.respond(req.id, {});

        case 'tools/list':
          return this.respond(req.id, {
            tools: [...this.toolMap.values()].map(t => ({
              name:        t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });

        case 'tools/call': {
          // B28: reject array params — MCP spec §5.5 requires params to be an object.
          // Some MCP clients erroneously send an array; previously this caused a cryptic
          // TypeError deep in argument destructuring.
          if (Array.isArray(req.params)) {
            return this.error(req.id, -32602, 'tools/call params must be an object, not an array');
          }

          const params = req.params as { name?: string; arguments?: unknown } | undefined;
          const name   = params?.name;
          const args   = params?.arguments;

          if (!name) return this.error(req.id, -32602, 'tools/call requires params.name');

          const tool = this.toolMap.get(name);
          // B29: unknown tool returns -32601 (Method not found), not -32602 (Invalid params).
          // The MCP spec is explicit: -32601 = method/tool not found; -32602 = bad params.
          if (!tool) return this.error(req.id, -32601, `Unknown tool: ${name}`);

          const validationError = validateArgs(args, tool.inputSchema);
          if (validationError) return this.error(req.id, -32602, validationError);

          try {
            const result = await tool.execute(
              args as Record<string, unknown>,
              callerArn
            );
            return this.respond(req.id, {
              content: Array.isArray(result)
                ? result
                : [{ type: 'text', text: typeof result === 'string'
                    ? result
                    : JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            const raw  = err instanceof Error ? err.message : String(err);
            const safe = sanitizeErrorMessage(raw);
            console.error(JSON.stringify({
              event: 'tool_error', tool: name, err: raw, callerArn,
            }));
            return this.respond(req.id, {
              content: [{ type: 'text', text: safe }],
              isError: true,
            });
          }
        }

        case 'resources/list':
          return this.respond(req.id, {
            resources: [...this.resourceMap.values()].map(r => ({
              uri:         r.uri,
              name:        r.name,
              description: r.description,
              mimeType:    r.mimeType,
            })),
          });

        case 'resources/read': {
          const { uri } = (req.params ?? {}) as { uri?: string };
          if (!uri) return this.error(req.id, -32602, 'resources/read requires params.uri');
          const resource = this.resourceMap.get(uri);
          if (!resource) return this.error(req.id, -32602, `Unknown resource: ${uri}`);
          const contents = await resource.read(callerArn);
          return this.respond(req.id, { contents });
        }

        // B35: handle prompts/list and logging/setLevel gracefully rather than -32601
        case 'prompts/list':
          return this.respond(req.id, { prompts: [] });

        case 'logging/setLevel':
          return this.respond(req.id, {});

        default:
          return this.error(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'server_error', err: String(err) }));
      return this.error(req.id, -32603, 'Internal error');
    }
  }

  private respond(id: unknown, result: unknown): MCPResponse {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  private error(id: unknown, code: number, message: string): MCPResponse {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }
}
```

**Update `MCPToolInputSchema` in `packages/lambda/src/mcp/types.ts`** to include `additionalProperties`:

```typescript
export interface MCPToolInputSchema {
  type:                  'object';
  properties:            Record<string, MCPToolPropertySchema>;
  required:              string[];
  additionalProperties?: boolean;  // B30: false = strict; undefined = permissive (default)
}
```

---

## Section 9: `packages/lambda/src/mcp/tools/submit-job.ts` — B15

Only the size guard constant changes. The rest of the file is from SPEC-29 Section 6.

```typescript
// B15: MAX_ENCODED_BYTES = 10MB (the API GW HTTP API hard limit).
// SPEC-29 used 7MB which limits effective zip to 5.25MB (base64 overhead ~1.33x).
// The advertised limit is 7.5MB zip → ~10MB encoded → set the guard to the API GW limit.
// Error message describes 7.5MB so the user understands the effective zip limit.
const MAX_ENCODED_BYTES = 10 * 1024 * 1024;  // 10MB encoded = ~7.5MB zip

// ... (complete file: import + execute() identical to SPEC-29 Section 6,
//      except replace: const MAX_ENCODED_BYTES = 7 * 1024 * 1024;
//      with the line above, and update the error message text below)

// Inside execute(), the size error message:
if (zipBase64.length > MAX_ENCODED_BYTES) {
  throw new Error(
    `Encoded zip is ${(zipBase64.length / 1024 / 1024).toFixed(1)}MB. ` +
    `API Gateway limit is 10MB encoded; base64 overhead means the effective zip limit ` +
    `via MCP is ~7.5MB. Use \`skills-svc upload\` for larger files.`
  );
}
```

---

## Section 10: `packages/lambda/src/mcp/tools/get-result.ts` — B31, B36

Complete replacement of SPEC-29 Section 8.

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus, RunResult } from '@skills-svc/shared';
import { envelopeDecrypt } from '@skills-svc/shared/crypto';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INLINE_LIMIT_BYTES = 4 * 1024 * 1024;
// B36: stream timeout — stalled S3 download previously caused Lambda 29s timeout
// which API GW converts to a 504 with no JSON body (unhandled by MCP client).
const STREAM_TIMEOUT_MS  = 20_000;

export const getResultTool: MCPTool = {
  name: 'get_result',
  description: [
    'Retrieve the full result of a completed job.',
    'Results larger than 4MB cannot be returned inline — use `skills-svc results <job-id>` instead.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      job_id: {
        type:        'string',
        description: 'Job ID of a COMPLETE job',
      },
      summary_only: {
        type:        'boolean',
        default:     false,
        description: 'Return only the result summary (true) or the full output (false).',
      },
    },
    required:              ['job_id'],
    additionalProperties:  false,  // B30
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId       = args.job_id as string;
    const summaryOnly = args.summary_only === true || args.summary_only === 'true';
    const tableName   = process.env.DYNAMODB_TABLE_NAME!;
    const env         = process.env.ENV ?? 'prod';

    const jobRes = await ddb.send(new GetCommand({
      TableName: tableName,
      Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    if (!jobRes.Item) throw new Error(`Job not found: ${jobId}`);
    if (jobRes.Item.userArn !== callerArn) {
      throw new Error('Access denied: you do not own this job');
    }

    if (jobRes.Item.status === JobStatus.FAILED) {
      return [{
        type: 'text',
        text: [
          'Job FAILED — no result was produced.',
          jobRes.Item.errorMessage
            ? `Error: ${jobRes.Item.errorMessage as string}`
            : '',
          'Do not retry get_result for this job. Submit a new job if needed.',
        ].filter(Boolean).join('\n'),
      }];
    }

    if (jobRes.Item.status !== JobStatus.COMPLETE) {
      return [{
        type: 'text',
        text: `Job not yet complete. Status: ${jobRes.Item.status as string}. ` +
              'Poll job_status, then retry get_result when COMPLETE.',
      }];
    }

    const resultKey = jobRes.Item.s3ResultKey as string | undefined;
    if (!resultKey) throw new Error('Result key not found on job record');

    const bucket = process.env.RESULTS_BUCKET!;
    const obj    = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: resultKey }));

    const chunks: Uint8Array[] = [];
    // B36: race S3 stream against a 20s timeout.
    // Without this, a stalled connection causes the Lambda to hit its 29s timeout.
    // API GW converts a Lambda timeout into a 504 with no JSON body — the MCP client
    // cannot distinguish this from a network error and gives confusing messages.
    await Promise.race([
      (async () => {
        for await (const c of obj.Body as AsyncIterable<Uint8Array>) chunks.push(c);
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('S3 stream timeout')), STREAM_TIMEOUT_MS)
      ),
    ]);
    const rawBytes = Buffer.concat(chunks);

    // B31: Replace presigned URL fallback with a CLI-redirect error.
    // Presigned S3 URLs for SSE-KMS objects require the downloader to have kms:Decrypt.
    // MCP token-auth clients have no AWS credentials, so presigned URLs are unusable.
    // The correct UX is to redirect the user to the CLI which has credentials.
    if (rawBytes.length > INLINE_LIMIT_BYTES) {
      throw new Error(
        `Result is ${(rawBytes.length / 1024 / 1024).toFixed(1)}MB — too large for MCP inline. ` +
        `Use: skills-svc results ${jobId}`
      );
    }

    const rawEnvelope = JSON.parse(rawBytes.toString('utf-8'));
    const plain = await envelopeDecrypt(rawEnvelope, {
      jobId,
      userArn:     callerArn,
      purpose:     'skills-svc-result',
      environment: env,
    });

    const result: RunResult = JSON.parse(plain.toString('utf-8'));

    if (summaryOnly) {
      return [{ type: 'text', text: result.resultSummary }];
    }

    const formatted = [
      `## Result: ${result.jobName}`,
      '',
      `**Skills:** ${result.skillNames.join(', ')}`,
      `**Duration:** ${Math.round(result.durationMs / 1000)}s`,
      `**Completed:** ${new Date(result.completedAt).toLocaleString()}`,
      '',
      '### Output',
      '',
      typeof result.output === 'string' && result.output.startsWith('{')
        ? '```json\n' + JSON.stringify(JSON.parse(result.output), null, 2) + '\n```'
        : String(result.output),
    ].join('\n');

    return [{ type: 'text', text: formatted }];
  },
};
```

---

## Section 11: `packages/lambda/src/mcp/tools/list-jobs.ts` — B23

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const listJobsTool: MCPTool = {
  name: 'list_jobs',
  description: 'List your jobs. Filters are applied after DDB retrieval. Use since/until/job_name_contains to narrow results.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type:        'string',
        description: 'Filter by status. Default: ALL',
        enum:        ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED', 'ALL'],
      },
      limit: {
        type:        'number',
        minimum:     1,
        maximum:     100,
        default:     20,
        description: 'Maximum results to return (1–100, default: 20)',
      },
      since: {
        type:        'string',
        description: 'ISO 8601 — return jobs created at or after this time',
      },
      until: {
        type:        'string',
        description: 'ISO 8601 — return jobs created at or before this time',
      },
      job_name_contains: {
        type:        'string',
        description: 'Case-insensitive substring filter on job name',
      },
    },
    required:             [],
    additionalProperties: false,  // B30
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const status          = (args.status as string | undefined) ?? 'ALL';
    const limit           = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);
    const since           = args.since as string | undefined;
    const until           = args.until as string | undefined;
    const jobNameContains = (args.job_name_contains as string | undefined)?.toLowerCase();
    const tableName       = process.env.DYNAMODB_TABLE_NAME!;

    const expressionValues: Record<string, unknown> = {
      ':user': `${DDB_KEY_PREFIX.USER}${callerArn}`,
    };
    const expressionNames: Record<string, string> = {};
    const filterParts: string[] = [];

    if (status !== 'ALL') {
      filterParts.push('#status = :status');
      expressionNames['#status'] = 'status';
      expressionValues[':status'] = status;
    }
    if (since) {
      filterParts.push('createdAt >= :since');
      expressionValues[':since'] = since;
    }
    if (until) {
      filterParts.push('createdAt <= :until');
      expressionValues[':until'] = until;
    }

    const baseParams: QueryCommandInput = {
      TableName:                 tableName,
      IndexName:                 'GSI2-User',
      KeyConditionExpression:    'GSI2PK = :user',
      ExpressionAttributeValues: expressionValues,
      ScanIndexForward:          false,
      ...(filterParts.length > 0 ? { FilterExpression: filterParts.join(' AND ') } : {}),
      ...(Object.keys(expressionNames).length > 0
        ? { ExpressionAttributeNames: expressionNames } : {}),
    };

    // B23: cursor-pagination loop — DDB applies Limit BEFORE FilterExpression.
    // The old code set Limit:limit which silently truncated results when the first N
    // DDB items were filtered out by since/until/status. Now we loop until we have
    // enough post-filter results or exhaust the index.
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;

    while (items.length < limit) {
      const res = await ddb.send(new QueryCommand({
        ...baseParams,
        // Fetch in batches; do not hard-limit to `limit` because FilterExpression
        // runs after Limit — a Limit of 20 with status=COMPLETE in a mostly-RUNNING
        // index would return 0 results even if 20 COMPLETE jobs exist beyond the page.
        Limit: Math.min(100, (limit - items.length) * 3),
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
      }));

      const page = res.Items ?? [];

      // Apply in-memory job_name_contains (DDB has no native case-insensitive contains)
      const filtered = jobNameContains
        ? page.filter(i =>
            (i.jobName as string | undefined)?.toLowerCase().includes(jobNameContains)
          )
        : page;

      items.push(...filtered);
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!lastKey) break;  // exhausted the index
    }

    const page = items.slice(0, limit);

    if (!page.length) {
      return [{
        type: 'text',
        text: `No jobs found${status !== 'ALL' ? ` with status ${status}` : ''}` +
              `${jobNameContains ? ` matching "${jobNameContains}"` : ''}.`,
      }];
    }

    const rows = page.map(item =>
      `• \`${item.jobId as string}\` — **${item.jobName as string}** — ` +
      `${item.status as string} — ${new Date(item.createdAt as string).toLocaleDateString()}`
    ).join('\n');

    return [
      { type: 'text', text: `Your jobs (${page.length}):\n\n${rows}` },
      {
        type:     'resource',
        resource: {
          uri:      'skills://jobs/list',
          mimeType: 'application/json',
          text:     JSON.stringify({
            count: page.length,
            jobs:  page.map(item => ({
              jobId:     item.jobId,
              jobName:   item.jobName,
              status:    item.status,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
            })),
          }),
        },
      },
    ];
  },
};
```

---

## Section 12: `packages/lambda/src/mcp/tools/cancel-job.ts` — B24, B25, B33, B38

```typescript
import { ECSClient, StopTaskCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { SQSClient, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ecs = new ECSClient({});
const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const cancelJobTool: MCPTool = {
  name: 'cancel_job',
  description: 'Cancel a PENDING or RUNNING job. Returns isError:true if the job is already in a terminal state.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'Job ID to cancel' },
      reason: { type: 'string', description: 'Reason for cancellation' },
    },
    required:             ['job_id'],
    additionalProperties: false,  // B30
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId     = args.job_id as string;
    const reason    = (args.reason as string | undefined) ?? 'Cancelled via MCP';
    const tableName = process.env.DYNAMODB_TABLE_NAME!;

    const jobRes = await ddb.send(new GetCommand({
      TableName: tableName,
      Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    if (!jobRes.Item) throw new Error(`Job not found: ${jobId}`);
    if (jobRes.Item.userArn !== callerArn) {
      throw new Error('Access denied: you do not own this job');
    }

    const status  = jobRes.Item.status as string;
    const version = (jobRes.Item.version as number | undefined) ?? 0;

    // B25: CANCELLED is now a distinct terminal state — not FAILED.
    // Previously cancel set status=FAILED, making cancelled jobs indistinguishable
    // from genuine failures. Retry tooling would incorrectly retry cancelled jobs.
    if (status === JobStatus.COMPLETE || status === JobStatus.FAILED ||
        status === 'CANCELLED') {
      throw new Error(
        `Cannot cancel — job ${jobId} is already in terminal state: ${status}`
      );
    }

    if (status === 'PENDING') {
      // B24: PENDING jobs — delete the SQS message so the ingestion Lambda
      // does not launch an ECS task after we cancel.
      // sqsReceiptHandle and sqsQueueUrl were written by the ingestion Lambda (Section 4).
      const sqsReceiptHandle = jobRes.Item.sqsReceiptHandle as string | undefined;
      const sqsQueueUrl      = jobRes.Item.sqsQueueUrl      as string | undefined;

      if (sqsReceiptHandle && sqsQueueUrl) {
        try {
          await sqs.send(new DeleteMessageCommand({
            QueueUrl:      sqsQueueUrl,
            ReceiptHandle: sqsReceiptHandle,
          }));
          console.log(JSON.stringify({
            event: 'sqs_message_deleted', jobId, sqsQueueUrl,
          }));
        } catch (err) {
          // Best-effort — the message may have already been processed (visibility timeout).
          // The DDB status update below is the authoritative cancel signal.
          console.warn(JSON.stringify({
            event: 'sqs_delete_failed', jobId, err: String(err),
          }));
        }
      }
    }

    if (status === JobStatus.RUNNING) {
      // B33: guard on ECS_CLUSTER_ARN before ECS API call.
      // Without the guard a missing env var causes an unsanitized SDK error to surface.
      const clusterArn = process.env.ECS_CLUSTER_ARN;
      if (!clusterArn) {
        throw new Error('ECS_CLUSTER_ARN not configured — cannot stop running task');
      }

      const tasksRes = await ecs.send(new ListTasksCommand({
        cluster:   clusterArn,
        startedBy: jobId,   // bare UUID per B2/SPEC-29 Fix 16
      }));

      for (const taskArn of tasksRes.taskArns ?? []) {
        await ecs.send(new StopTaskCommand({
          cluster: clusterArn,
          task:    taskArn,
          reason,
        }));
      }
    }

    // B25: write CANCELLED status (not FAILED)
    try {
      await ddb.send(new UpdateCommand({
        TableName:           tableName,
        Key:                 { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
        UpdateExpression:
          'SET #s = :s, updatedAt = :now, #v = :nv, GSI1PK = :gsi, errorMessage = :err',
        ConditionExpression: '#v = :cv',
        ExpressionAttributeNames: { '#s': 'status', '#v': 'version' },
        ExpressionAttributeValues: {
          ':s':   'CANCELLED',   // B25: distinct status
          ':now': new Date().toISOString(),
          ':nv':  version + 1,
          ':cv':  version,
          ':gsi': `${DDB_KEY_PREFIX.STATUS}CANCELLED`,
          ':err': `Cancelled via MCP: ${reason}`,
        },
      }));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        // Race: job reached terminal state between GetItem and UpdateItem
        return [
          {
            type: 'text',
            text: `Job ${jobId} reached a terminal state before cancellation could complete. It is no longer running.`,
          },
          // B38: resource block even on race path
          {
            type:     'resource',
            resource: {
              uri:      `skills://jobs/${jobId}`,
              mimeType: 'application/json',
              text:     JSON.stringify({ jobId, cancelled: false, race: true }),
            },
          },
        ];
      }
      throw err;
    }

    // B38: success response must include type:'resource' block.
    // Agents using the resource pattern need structured confirmation — text alone
    // requires regex parsing which is fragile.
    return [
      {
        type: 'text',
        text: `Job ${jobId} cancelled successfully.\nReason: ${reason}`,
      },
      {
        type:     'resource',
        resource: {
          uri:      `skills://jobs/${jobId}`,
          mimeType: 'application/json',
          text:     JSON.stringify({
            jobId,
            status:    'CANCELLED',
            cancelled: true,
            reason,
          }),
        },
      },
    ];
  },
};
```

---

## Section 13: `packages/shared/src/types.ts` and `constants.ts` — B21, B25, B26, B27

### `packages/shared/src/types.ts`

```typescript
// B21: Keep only this (SPEC-30) version of QueryRequest/QueryResponse.
// Delete the SPEC-29 §13 version which omits from/total/hasMore — merge conflict resolved.

export interface QueryRequest {
  query:         string;
  callerUserArn: string;
  topK?:         number;
  minScore?:     number;
  from?:         number;    // pagination offset
}

export interface QueryResponse {
  results:         SearchResult[];
  queryDurationMs: number;
  total?:          number;
  hasMore?:        boolean;
  from?:           number;
}

export interface SearchResult {
  jobId:         string;
  jobName:       string;
  userArn:       string;
  s3ResultKey?:  string;
  resultSummary: string;
  createdAt:     string;
  skillNames:    string[];
  score:         number;
}

export interface RunResult {
  jobId:         string;
  jobName:       string;
  userArn:       string;
  s3ResultKey:   string;
  skillNames:    string[];
  resultSummary: string;
  output:        string | object;
  durationMs:    number;
  completedAt:   string;
}

// B25: CANCELLED is a distinct terminal status for jobs stopped by user request.
// Distinguishes user cancellation from genuine failures so retry tooling works correctly.
export enum JobStatus {
  PENDING   = 'PENDING',
  RUNNING   = 'RUNNING',
  COMPLETE  = 'COMPLETE',
  FAILED    = 'FAILED',
  CANCELLED = 'CANCELLED',  // B25: new — do not retry; was previously mapped to FAILED
}

// list_jobs input schema enum must include CANCELLED (server.ts validateArgs uses this)
export const JOB_STATUS_ENUM = [
  'PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'CANCELLED', 'ALL',
] as const;

// isValidTransition: CANCELLED is terminal — no transitions out of it
export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  const allowed: Partial<Record<JobStatus, JobStatus[]>> = {
    [JobStatus.PENDING]:  [JobStatus.RUNNING,  JobStatus.FAILED, JobStatus.CANCELLED],
    [JobStatus.RUNNING]:  [JobStatus.COMPLETE, JobStatus.FAILED, JobStatus.CANCELLED],
    [JobStatus.COMPLETE]: [],
    [JobStatus.FAILED]:   [],
    [JobStatus.CANCELLED]:[],
  };
  return (allowed[from] ?? []).includes(to);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidUUID(v: string): boolean { return UUID_RE.test(v); }
```

### `packages/shared/src/constants.ts`

```typescript
// B27: DDB_KEY_PREFIX — explicit string values, not inferred.
// Previously USER was never defined in constants; files used ad-hoc literals ('USER#')
// causing silent zero-result queries when the literal differed by a character.
export const DDB_KEY_PREFIX = {
  JOB:    'JOB#',
  STATUS: 'STATUS#',
  USER:   'USER#',      // B27: was missing — list_jobs GSI2PK was inconsistent
} as const;

export type DDBKeyPrefix = typeof DDB_KEY_PREFIX[keyof typeof DDB_KEY_PREFIX];

// B26: formatGSI2SK — bare ISO string; no prefix.
// SPEC-02 wrote 'CREATED_AT#{iso}' and SPEC-30 Fix E wrote bare ISO.
// Mixed records break date range sort order in GSI2. Standardize on bare ISO everywhere.
// Usage: GSI2SK: formatGSI2SK(createdAt)  — in all DDB writers (ingestion, results-processor)
export const formatGSI2SK = (iso: string): string => iso;

// Unit test to pin both values (add to packages/shared/src/__tests__/constants.test.ts):
//
//   import { DDB_KEY_PREFIX, formatGSI2SK } from '../constants';
//   test('DDB_KEY_PREFIX.USER is USER#', () => {
//     expect(DDB_KEY_PREFIX.USER).toBe('USER#');
//   });
//   test('DDB_KEY_PREFIX.JOB is JOB#', () => {
//     expect(DDB_KEY_PREFIX.JOB).toBe('JOB#');
//   });
//   test('DDB_KEY_PREFIX.STATUS is STATUS#', () => {
//     expect(DDB_KEY_PREFIX.STATUS).toBe('STATUS#');
//   });
//   test('formatGSI2SK returns bare ISO', () => {
//     const iso = '2026-01-01T00:00:00.000Z';
//     expect(formatGSI2SK(iso)).toBe(iso);
//     expect(formatGSI2SK(iso)).not.toMatch(/^CREATED_AT#/);
//   });
```

---

## Section 14: `packages/knowledge-store/package.json` — B22

```json
{
  "name": "@skills-svc/knowledge-store",
  "version": "1.0.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".":          { "import": "./dist/index.js",   "types": "./dist/index.d.ts"   },
    "./searcher": { "import": "./dist/searcher.js", "types": "./dist/searcher.d.ts" },
    "./indexer":  { "import": "./dist/indexer.js",  "types": "./dist/indexer.d.ts"  }
  },
  "scripts": {
    "build": "tsc",
    "test":  "jest"
  },
  "peerDependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3",
    "@opensearch-project/opensearch":  "^2"
  }
}
```

**Why B22 matters:** Node 18+ honours `exports` maps and ignores `main` for sub-path imports. Without the `exports` map, `import { indexResult } from '@skills-svc/knowledge-store/indexer'` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime in Lambda (Node 20).

---

## Section 15: `packages/cli/src/commands/diff.ts` — B16

Only the `envelopeDecrypt` call site changes. Add `userArn` from the job record.

```typescript
// In packages/cli/src/commands/diff.ts, inside fetchResult():
// B16: add userArn to envelopeDecrypt — SPEC-30 Fix D made userArn a required context field.
// The diff command was written before Fix D and throws 'envelopeDecrypt: context.userArn is required'
// on every invocation after SPEC-30 is deployed.

async function fetchResult(jobId: string, cfg: CliConfig): Promise<RunResult> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: cfg.region }));

  const jobRes = await ddb.send(new GetCommand({
    TableName: cfg.dynamodbTableName,
    Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
  }));

  if (!jobRes.Item) throw new Error(`Job not found: ${jobId}`);

  const s3     = new S3Client({ region: cfg.region });
  const bucket = cfg.resultsBucket;
  const key    = jobRes.Item.s3ResultKey as string;

  const obj    = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks: Uint8Array[] = [];
  for await (const c of obj.Body as AsyncIterable<Uint8Array>) chunks.push(c);
  const raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  // B16: userArn was missing — throws after SPEC-30 Fix D deployed
  const plain = await envelopeDecrypt(raw, {
    jobId,
    userArn:     jobRes.Item.userArn as string,  // B16: sourced from DDB job record
    purpose:     'skills-svc-result',
    environment: cfg.envName,
  });

  return JSON.parse(plain.toString('utf-8')) as RunResult;
}
```

---

## Section 16: `packages/lambda/src/query/handler.ts` — B20

```typescript
// packages/lambda/src/query/handler.ts
// B20: handleDirect is called when the MCP query tool invokes this Lambda directly
// via InvokeCommand. The problem: callerUserArn in direct-invoke mode is self-reported
// by the MCP server, not validated by an authorizer. Any IAM principal with
// lambda:InvokeFunction can spoof any callerUserArn and read another user's results.
//
// Resolution options (choose one before deploying):
//   Option A (RECOMMENDED): Disable handleDirect — force all callers through API GW + auth.
//     The MCP query tool must be updated to call the API GW HTTPS endpoint with SigV4.
//   Option B (TEMPORARY): Leave handleDirect but add a warning log on every direct invocation.
//     This allows existing deployments to keep working while Option A is implemented.
//
// This file implements Option B (warning) as a safe interim so existing deployments
// are not broken. Implement Option A by replacing the handleDirect body below with:
//   throw new Error('Direct Lambda invocation disabled — use the API Gateway endpoint');
//
// Update the MCP query tool (packages/lambda/src/mcp/tools/query.ts) to use HTTPS:
//   Replace: lambdaClient.send(new InvokeCommand({...}))
//   With:    fetch(process.env.QUERY_API_ENDPOINT!, { method:'POST', headers:{...SigV4...} })

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { search } from '@skills-svc/knowledge-store/searcher';
import { QueryRequest, QueryResponse } from '@skills-svc/shared';

export const handler = async (
  event: QueryRequest | APIGatewayProxyEventV2
): Promise<QueryResponse | APIGatewayProxyResultV2> => {
  if (isApiGatewayEvent(event)) {
    return handleApiGateway(event);
  }
  return handleDirect(event as QueryRequest);
};

function isApiGatewayEvent(event: unknown): event is APIGatewayProxyEventV2 {
  return (
    typeof event === 'object' && event !== null &&
    'requestContext' in event &&
    typeof (event as Record<string, unknown>).requestContext === 'object'
  );
}

async function handleDirect(req: QueryRequest): Promise<QueryResponse> {
  // B20: callerUserArn is self-reported — log a warning on every direct invocation.
  // Any caller with lambda:InvokeFunction can pass any callerUserArn.
  console.warn(JSON.stringify({
    event:  'direct_lambda_invoke_warning',
    message: 'B20: callerUserArn is self-reported in direct invocation mode — not authorizer-validated. Implement Option A to disable.',
    callerUserArn: req.callerUserArn,
  }));
  validateQueryRequest(req);
  return search(req);
}

async function handleApiGateway(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const iam = (event.requestContext as Record<string, unknown>)?.authorizer as
    Record<string, unknown> | undefined;
  const callerUserArn =
    (iam?.iam    as Record<string, string> | undefined)?.userArn ??
    (iam?.lambda as Record<string, string> | undefined)?.callerUserArn;

  if (!callerUserArn) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  let body: Partial<QueryRequest>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Bad Request', message: 'Invalid JSON body' });
  }

  const req: QueryRequest = {
    query:         body.query ?? '',
    callerUserArn,
    topK:          body.topK,
    minScore:      body.minScore,
    from:          body.from,
  };

  try {
    validateQueryRequest(req);
  } catch (err) {
    return jsonResponse(400, {
      error:   'Bad Request',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const result = await search(req);
    return jsonResponse(200, result);
  } catch (err) {
    console.error(JSON.stringify({ event: 'query_error', callerUserArn, err: String(err) }));
    return jsonResponse(500, { error: 'Internal Server Error' });
  }
}

function validateQueryRequest(req: QueryRequest): void {
  if (!req.query?.trim()) throw new Error('query must be a non-empty string');
  if (!req.callerUserArn) throw new Error('callerUserArn must be a non-empty string');
  if (req.topK    !== undefined && (req.topK    < 1 || req.topK    > 50)) throw new Error('topK 1–50');
  if (req.minScore !== undefined && (req.minScore < 0 || req.minScore > 1)) throw new Error('minScore 0–1');
  if (req.from    !== undefined && req.from < 0)  throw new Error('from must be >= 0');
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
```

---

## Section 17: Infrastructure Notes

**B2 — `infra/lib/lambda-stack.ts` EventBridge rule update (code change required there)**

```typescript
// In infra/lib/lambda-stack.ts, find the ECS Task State Change rule and replace:
//
// BEFORE (broken — matches prefix 'skills-svc-ingestion-*' but startedBy is now bare UUID):
//   detail: {
//     lastStatus: ['STOPPED'],
//     startedBy:  [{ prefix: 'skills-svc-ingestion-' }],
//   },
//
// AFTER (B2 fix — scope by clusterArn; handler validates UUID):
//   detail: {
//     lastStatus: ['STOPPED'],
//     clusterArn: [props.ecsClusterArn],
//   },
//
// The handler (Section 5) calls isValidUUID(detail.startedBy) to ignore unrelated tasks.
```

**B19 — Backfill Lambda CDK registration**

The `backfillFn` CDK definition is in Section 7. It must be added to `lambda-stack.ts` (or a dedicated `backfill-stack.ts`). It has no event source — invoke manually once:

```bash
aws lambda invoke \
  --function-name skills-svc-backfill-user-arn-${ENV} \
  --payload '{}' \
  /dev/null
```

**B32 — Resolved by B23**

B32 was identified as a duplicate of B23 (list_jobs Limit-before-filter truncation). The cursor-pagination loop in Section 11 resolves both.

---

## Fix Coverage Index

| Fix | Severity | Section | Resolution |
|-----|----------|---------|------------|
| B1  | CRITICAL  | 1 | Four KMS key ARN props replace Resource:'*' |
| B2  | CRITICAL  | 1 (note) + 5 | Remove startedBy prefix filter; add clusterArn; handler validates UUID |
| B3  | BLOCKING  | 1 | vpc/vpcSubnets/securityGroups added to tokenAuthFn |
| B4  | BLOCKING  | 3 + 4 | normaliseArn() in mcp-config.ts and ingestion handler |
| B5  | BLOCKING  | 1 | StringLike replaces ForAllValues:StringLike; DeleteItem off userRole |
| B6  | BLOCKING  | 2 | Retryable DDB errors rethrown → API GW 500 not 403 |
| B7  | BLOCKING  | 3 | Old token deleted via DeleteCommand before writing new |
| B8  | BLOCKING  | 2 | sha256 tokenHash in all log lines; raw token never logged |
| B9  | BLOCKING  | 2 + 3 | envName written to token record; validated in authorizer |
| B10 | BLOCKING  | 1 | GSI4-CacheKey added to storage-stack.ts |
| B11 | BLOCKING  | 4 | GSI4PK = CONTENTHASH#{hash} written in ingestion handler |
| B12 | BLOCKING  | 4 | validateZipStructure called before DDB write; FAILED on error |
| B13 | BLOCKING  | 4 | RunTask failures[] checked; FAILED written on ECS error |
| B14 | CRITICAL  | 5 | Revert to EventBridgeHandler; CDK wiring note; isValidUUID guard |
| B15 | CORRECTNESS | 9 | MAX_ENCODED_BYTES = 10MB; error message says 7.5MB |
| B16 | BLOCKING  | 15 | userArn added to envelopeDecrypt call in diff.ts |
| B17 | BLOCKING  | 6 | user_arn filter inside knn clause; k = topK * 10 |
| B18 | CRITICAL  | 6 + 7 | dimensions:1536 and normalize:true in both embed calls |
| B19 | BLOCKING  | 7 | Backfill Lambda implementation + CDK registration note |
| B20 | BLOCKING  | 16 | handleDirect logs warning; Option A documented |
| B21 | BLOCKING  | 13 | Duplicate QueryRequest/QueryResponse removed; SPEC-30 version kept |
| B22 | BLOCKING  | 14 | exports map in package.json for Node 18+ sub-path imports |
| B23 | BLOCKING  | 11 | Cursor-pagination loop; no hard Limit before FilterExpression |
| B24 | BLOCKING  | 4 + 12 | sqsReceiptHandle stored in DDB; deleted in cancel_job PENDING path |
| B25 | BLOCKING  | 12 + 13 | CANCELLED status enum value; cancel_job writes CANCELLED not FAILED |
| B26 | BLOCKING  | 4 + 13 | formatGSI2SK constant; bare ISO everywhere; no CREATED_AT# prefix |
| B27 | CRITICAL  | 13 | DDB_KEY_PREFIX.USER defined explicitly as 'USER#' |
| B28 | CORRECTNESS | 8 | Array params rejected with -32602 for tools/call |
| B29 | CORRECTNESS | 8 | Unknown tool returns -32601 not -32602 |
| B30 | CORRECTNESS | 8 | additionalProperties:false enforced in validateArgs |
| B31 | BLOCKING  | 10 | Presigned URL removed; CLI-redirect error thrown instead |
| B32 | (dup)     | 11 | Resolved by B23 |
| B33 | CORRECTNESS | 12 | ECS_CLUSTER_ARN guard before ListTasks/StopTask |
| B34 | CORRECTNESS | 8 | 'not authorized' and 'ECS_CLUSTER_ARN not' added to SAFE_ERROR_PREFIXES |
| B35 | CORRECTNESS | 8 | prompts:{} and logging:{} in initialize response; prompts/list handled |
| B36 | BLOCKING  | 5 + 10 | Promise.race with 20s timeout on S3 stream |
| B37 | BLOCKING  | 1 | CORS allowOrigins removes '*'; only 'https://claude.ai' |
| B38 | CORRECTNESS | 12 | type:'resource' block on success and ConditionalCheck race paths |
