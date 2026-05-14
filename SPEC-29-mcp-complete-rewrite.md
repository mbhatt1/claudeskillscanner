# SPEC-29 — MCP Server: Complete Authoritative Rewrite

**Supersedes SPEC-09 entirely.**  
**Also supersedes all MCP-overlapping sections of SPEC-24 and SPEC-28.**  
**Status:** AUTHORITATIVE — drop-in implementation. All 28 fixes from SPEC-28 incorporated.  
**Version:** 2.0.0

---

## What Changed From SPEC-09

All 28 SPEC-28 fixes are incorporated. Critical issues resolved:
- Fix 1: All env vars now present in Lambda environment (tools no longer crash at startup)
- Fix 2: Lambda token authorizer replaces broken HttpIamAuthorizer (every call was 403)
- Fix 3: `mcp-config` now writes opaque token, not AWS credentials
- Fix 4: Handler reads `lambda.callerUserArn` not `iam.userArn`
- Fix 5: WAF excludes SizeRestrictions_BODY and NoUserAgent_HEADER, per-token rate limiting
- Fix 6: `submit_job` returns jobId immediately
- Fix 7: Size guard corrected to 7MB encoded
- Fix 8/14/15: `type: 'resource'` machine-readable JSON in job_status, query, list_jobs
- Fix 9: `envelopeDecrypt` now passes `userArn` context
- Fix 10: FAILED job returns distinct error message
- Fix 11: Size guard + presigned URL fallback for large results
- Fix 13: `top_k`, `min_score`, `from`, `limit` typed as `number` not `string`
- Fix 16: `startedBy: jobId` (bare UUID, not prefixed)
- Fix 17: `ecs:ListTasks` IAM resource is cluster ARN not task ARN
- Fix 18: Terminal-state cancel throws (isError:true)
- Fix 19: `MCPContent.resource` field added to types
- Fix 20: `summary_only` typed as `boolean`
- Fix 21: `id: req.id ?? null` (never undefined)
- Fix 22: jsonrpc field validated
- Fix 23: validateArgs checks for null values
- Fix 24: Error messages sanitized before surfacing to client
- Fix 25: All-notification batch returns HTTP 204
- Fix 26: Content-hash deduplication in submit_job
- Fix 27: OPTIONS included in CORS allowMethods (in Fix 2)
- Fix 28: `isError: false` omitted from success responses

---

## Section 1: CDK `MCPStack` — `infra/lib/mcp-stack.ts`

Complete replacement. Incorporates Fix 1, 2, 5, 17, 25 (CORS OPTIONS), 27.

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

interface MCPStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  lambdaEnvKey: kms.Key;
  userRole: iam.Role;
  dynamodbTableName: string;
  jobsTableArn: string;          // needed for IAM conditions
  uploadsBucket: string;
  resultsBucket: string;
  uploadsKmsKeyId: string;       // Fix 1: passed as env var, no SSM call per submit_job
  queryLambdaArn: string;
  ecsClusterName: string;        // Fix 17: cluster name for correct IAM scope
  ecsClusterArn: string;
  jobsTopicArn: string;
}

export class MCPStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: MCPStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // ── IAM Role ───────────────────────────────────────────────────────────────

    const mcpLambdaRole = new iam.Role(this, 'MCPLambdaRole', {
      roleName: `skills-svc-mcp-lambda-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // DynamoDB — jobs table + GSIs + MCP token items
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDBJobs',
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'dynamodb:PutItem',    // needed for content-hash dedup check (Fix 26) and token writes
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.dynamodbTableName}`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.dynamodbTableName}/index/*`,
      ],
    }));

    // S3 — results (read) and uploads (write, MCP prefix only)
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3ReadResults',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.resultsBucket}/*`],
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3WriteUploads',
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::${props.uploadsBucket}/uploads/mcp/*`],
      conditions: {
        StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        Bool: { 'aws:SecureTransport': 'true' },
      },
    }));
    // S3 presigned URL generation for large results (Fix 11)
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3PresignResults',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.resultsBucket}/*`],
    }));

    // Lambda invoke — query function
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeQueryLambda',
      actions: ['lambda:InvokeFunction'],
      resources: [props.queryLambdaArn],
    }));

    // ECS — Fix 17: ecs:ListTasks must target cluster ARN, ecs:StopTask targets task ARN
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECSListTasks',
      actions: ['ecs:ListTasks'],
      resources: [
        `arn:aws:ecs:${this.region}:${this.account}:cluster/${props.ecsClusterName}`,
      ],
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECSStopTask',
      actions: ['ecs:StopTask'],
      resources: [
        `arn:aws:ecs:${this.region}:${this.account}:task/${props.ecsClusterName}/*`,
      ],
    }));

    // SSM — only for mcp/endpoint parameter (not bucket/key — those are env vars now)
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMRead',
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/mcp/*`,
      ],
    }));

    // KMS — decrypt results, generate data keys for uploads
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KMSCrypto',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: ['*'],  // tighten to specific key ARNs in production
    }));

    // CloudWatch Logs
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/mcp*`,
      ],
    }));

    // Bedrock — for query tool embeddings (if query Lambda is co-located)
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockEmbed',
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    // Allow userRole to write/delete MCP tokens in DDB (Fix 3: token-based auth)
    props.userRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteMCPTokens',
      actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [props.jobsTableArn],
      conditions: {
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': ['MCPTOKEN#*'],
        },
      },
    }));

    // ── mcp-auth Lambda (Fix 2) ────────────────────────────────────────────────

    const tokenAuthFn = new lambda.Function(this, 'MCPTokenAuthFn', {
      functionName: `skills-svc-mcp-auth-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      handler: 'mcp-auth/handler.handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      role: mcpLambdaRole,
      environment: {
        JOBS_TABLE_NAME: props.dynamodbTableName,
        ENV: envName,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      description: 'MCP token validator — validates X-API-Key tokens stored in DDB',
    });

    // Fix 2: HttpLambdaAuthorizer replaces the broken HttpIamAuthorizer
    const tokenAuthorizer = new apigatewayv2Authorizers.HttpLambdaAuthorizer(
      'TokenAuthorizer', tokenAuthFn, {
        authorizerName:  'skills-svc-token-authorizer',
        identitySource:  ['$request.header.X-API-Key'],
        resultsCacheTtl: cdk.Duration.seconds(30),  // short TTL so revocations take effect
      }
    );

    // ── MCP Lambda (Fix 1: all env vars present) ──────────────────────────────

    const mcpFn = new lambda.Function(this, 'MCPLambda', {
      functionName: `skills-svc-mcp-${envName}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'mcp/handler.handler',
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout: cdk.Duration.seconds(29),    // API GW HTTP API hard limit is 29s
      memorySize: 512,
      reservedConcurrentExecutions: 200,
      tracing: lambda.Tracing.ACTIVE,
      role: mcpLambdaRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        NODE_OPTIONS:        '--enable-source-maps',
        ENV:                 envName,
        REGION:              this.region,
        MCP_SERVER_NAME:     'skills-as-a-service',
        MCP_SERVER_VERSION:  '1.0.0',
        // Fix 1: these were missing — every tool except submit_job crashed at runtime
        DYNAMODB_TABLE_NAME: props.dynamodbTableName,
        RESULTS_BUCKET:      props.resultsBucket,
        QUERY_LAMBDA_ARN:    props.queryLambdaArn,
        UPLOADS_BUCKET:      props.uploadsBucket,
        UPLOADS_KMS_KEY_ID:  props.uploadsKmsKeyId,  // avoids SSM call per submit_job
        ECS_CLUSTER_ARN:     props.ecsClusterArn,
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      description: 'MCP server — exposes Skills-as-a-Service tools to MCP clients',
    });

    // ── API Gateway (Fix 2, Fix 27: OPTIONS in CORS) ──────────────────────────

    const api = new apigatewayv2.HttpApi(this, 'MCPAPI', {
      apiName:     `skills-svc-mcp-${envName}`,
      description: 'Skills as a Service MCP Server',
      // Fix 2: defaultAuthorizer is now the Lambda token authorizer
      defaultAuthorizer: tokenAuthorizer,
      // Fix 27: OPTIONS must be in allowMethods for CORS preflight to work
      corsPreflight: {
        allowOrigins: ['https://claude.ai', '*'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.OPTIONS,   // Fix 27 — required for initialize preflight
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
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('MCPIntegration', mcpFn, {
        payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
      }),
      authorizer: tokenAuthorizer,
    });

    // Health check — no auth
    api.addRoutes({
      path:    '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('HealthIntegration', mcpFn, {
        payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    this.apiUrl = api.apiEndpoint;

    // ── WAF (Fix 5: exclusions + per-token rate limiting + dependency) ─────────

    const waf = new wafv2.CfnWebACL(this, 'MCPWAF', {
      name:          `skills-svc-mcp-waf-${envName}`,
      scope:         'REGIONAL',
      defaultAction: { allow: {} },
      rules: [
        {
          // Fix 5: per-token rate limiting (not per-IP — multiple agents behind NAT)
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
              // Fix 5: exclude rules that break legitimate MCP traffic
              excludedRules: [
                { name: 'NoUserAgent_HEADER' },     // headless MCP agents omit User-Agent
                { name: 'SizeRestrictions_BODY' },  // submit_job sends up to 13MB base64 body
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName:               `skills-svc-mcp-common-rules-${envName}`,
            sampledRequestsEnabled:   false,
          },
        },
        {
          name:           'AWSManagedRulesKnownBadInputsRuleSet',
          priority:       3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name:       'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName:               `skills-svc-mcp-bad-inputs-${envName}`,
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

    // Fix 5: explicit dependency prevents race where association deploys before WAF
    const wafAssociation = new wafv2.CfnWebACLAssociation(this, 'MCPWAFAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/apis/${api.apiId}/stages/$default`,
      webAclArn:   waf.attrArn,
    });
    wafAssociation.addDependency(waf);

    // ── Outputs ────────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'MCPEndpoint', {
      value:       `${api.apiEndpoint}/mcp`,
      description: 'MCP server endpoint — add to MCP client config',
    });

    new ssm.StringParameter(this, 'ParamMCPEndpoint', {
      parameterName: `/skills-svc/${envName}/mcp/endpoint`,
      stringValue:   `${api.apiEndpoint}/mcp`,
    });
  }
}
```

---

## Section 2: `packages/lambda/src/mcp-auth/handler.ts`

Token validator Lambda. Incorporates Fix 2, Fix 3 (token storage schema).

```typescript
import {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface TokenContext {
  callerUserArn: string;
  expiresAt: string;
}

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2
): Promise<APIGatewaySimpleAuthorizerWithContextResult<TokenContext>> => {
  const token = event.headers?.['x-api-key'] ?? event.headers?.['X-API-Key'];

  const DENY: APIGatewaySimpleAuthorizerWithContextResult<TokenContext> = {
    isAuthorized: false,
    context: { callerUserArn: '', expiresAt: '' },
  };

  if (!token || typeof token !== 'string' || token.length < 16) {
    return DENY;
  }

  const tableName = process.env.JOBS_TABLE_NAME;
  if (!tableName) {
    console.error('JOBS_TABLE_NAME not set');
    return DENY;
  }

  let item: Record<string, unknown> | undefined;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `MCPTOKEN#${token}`, SK: 'META' },
    }));
    item = res.Item;
  } catch (err) {
    console.error(JSON.stringify({ event: 'token_lookup_error', err: String(err) }));
    return DENY;
  }

  if (!item) return DENY;

  // Check expiry using the human-readable ISO field (DDB TTL reaper may lag by up to 48h)
  if (item.expiresAt && new Date(item.expiresAt as string) < new Date()) {
    return DENY;
  }

  const callerUserArn = item.userArn as string;
  if (!callerUserArn) return DENY;

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

## Section 3: `packages/lambda/src/mcp/handler.ts`

Main Lambda entry point. Incorporates Fix 4 (read from `lambda.callerUserArn`), Fix 25 (batch 204).

```typescript
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { MCPServer } from './server';
import { ALL_TOOLS } from './tools';
import { ALL_RESOURCES } from './resources';

const server = new MCPServer({
  name:      process.env.MCP_SERVER_NAME    ?? 'skills-as-a-service',
  version:   process.env.MCP_SERVER_VERSION ?? '1.0.0',
  tools:     ALL_TOOLS,
  resources: ALL_RESOURCES,
});

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Health check — no auth required
  if (event.requestContext.http.method === 'GET' && event.rawPath === '/health') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok', server: server.name }),
    };
  }

  // Fix 4: Lambda authorizer puts identity in lambda.callerUserArn, not iam.userArn.
  // Support both so a future IAM-auth path still works.
  const callerArn =
    event.requestContext?.authorizer?.iam?.userArn ??
    (event.requestContext?.authorizer?.lambda as Record<string, string> | undefined)?.callerUserArn;

  if (!callerArn) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      null,
        error:   { code: -32001, message: 'Unauthorized — valid X-API-Key required' },
      }),
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      null,
        error:   { code: -32700, message: 'Parse error' },
      }),
    };
  }

  // Fix 25: batch — return 204 if all notifications (no id fields), else return only non-null
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(req => server.handle(req, callerArn)));
    const nonNull = responses.filter((r): r is NonNullable<typeof r> => r !== null);
    if (nonNull.length === 0) {
      // All notifications — JSON-RPC 2.0 §6 says must not return a response body
      return { statusCode: 204, body: '' };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nonNull),
    };
  }

  const response = await server.handle(body, callerArn);

  // Single notification (no id) — no response
  if (response === null) {
    return { statusCode: 204, body: '' };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  };
};
```

---

## Section 4: `packages/lambda/src/mcp/server.ts`

MCPServer class. Incorporates Fix 21 (id ?? null), Fix 22 (jsonrpc validation), Fix 23 (null check in validateArgs), Fix 24 (error sanitization), Fix 28 (omit isError:false).

```typescript
import { MCPTool, MCPResource, MCPRequest, MCPResponse } from './types';

interface MCPServerConfig {
  name: string;
  version: string;
  tools: MCPTool[];
  resources: MCPResource[];
}

// Safe error prefixes that may be shown directly to MCP clients (Fix 24)
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
  'Zip file exceeds',
  'Missing required',
  'must not be null',
  'Duplicate submission',
  'Encoded zip is',
  'Cancelled via',
] as const;

function sanitizeErrorMessage(msg: string): string {
  if (SAFE_ERROR_PREFIXES.some(p => msg.includes(p))) return msg;
  return 'An internal error occurred. Check server logs for details.';
}

// Fix 23: check for null/undefined on required fields, not just presence
function validateArgs(args: unknown, schema: Record<string, unknown>): string | null {
  if (!args || typeof args !== 'object') return 'Arguments must be an object';
  const required = (schema.required as string[] | undefined) ?? [];
  const argsObj  = args as Record<string, unknown>;
  for (const field of required) {
    if (!(field in argsObj)) {
      return `Missing required argument: ${field}`;
    }
    if (argsObj[field] === null || argsObj[field] === undefined) {
      return `Required argument "${field}" must not be null or undefined`;
    }
  }
  return null;
}

export class MCPServer {
  readonly name: string;
  private readonly version: string;
  private readonly toolMap: Map<string, MCPTool>;
  private readonly resourceMap: Map<string, MCPResource>;

  constructor(config: MCPServerConfig) {
    this.name        = config.name;
    this.version     = config.version;
    this.toolMap     = new Map(config.tools.map(t => [t.name, t]));
    this.resourceMap = new Map(config.resources.map(r => [r.uri, r]));
  }

  async handle(request: unknown, callerArn: string): Promise<MCPResponse | null> {
    const req = request as Partial<MCPRequest>;

    // Fix 22: validate jsonrpc field before anything else
    if (req.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        // Fix 21: id must be null when missing/undefined, not dropped by JSON.stringify
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

    // Notifications (no id field) — fire-and-forget, no response
    if (!('id' in req)) return null;

    try {
      switch (req.method) {
        case 'initialize':
          return this.respond(req.id, {
            protocolVersion: '2024-11-05',
            serverInfo:      { name: this.name, version: this.version },
            capabilities: {
              tools:     { listChanged: false },
              resources: { listChanged: false, subscribe: false },
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
          const params = req.params as { name?: string; arguments?: unknown } | undefined;
          const name = params?.name;
          const args = params?.arguments;

          if (!name) return this.error(req.id, -32602, 'tools/call requires params.name');

          const tool = this.toolMap.get(name);
          if (!tool) return this.error(req.id, -32602, `Unknown tool: ${name}`);

          const validationError = validateArgs(args, tool.inputSchema);
          if (validationError) return this.error(req.id, -32602, validationError);

          try {
            const result = await tool.execute(args as Record<string, unknown>, callerArn);
            // Fix 28: omit isError entirely on success (not isError: false)
            return this.respond(req.id, {
              content: Array.isArray(result)
                ? result
                : [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
            });
          } catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            const safe = sanitizeErrorMessage(raw);  // Fix 24
            console.error(JSON.stringify({ event: 'tool_error', tool: name, err: raw, callerArn }));
            // Fix 28: isError: true only on error
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

        default:
          return this.error(req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      console.error(JSON.stringify({ event: 'server_error', err: String(err) }));
      return this.error(req.id, -32603, 'Internal error');
    }
  }

  // Fix 21: id ?? null — never let undefined through to JSON.stringify (it would be dropped)
  private respond(id: unknown, result: unknown): MCPResponse {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }

  private error(id: unknown, code: number, message: string): MCPResponse {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }
}
```

---

## Section 5: `packages/lambda/src/mcp/types.ts`

Type definitions. Incorporates Fix 19 (`MCPContent.resource`), Fix 19 (`MCPToolPropertySchema` with default/min/max).

```typescript
// Fix 19: MCPToolPropertySchema must include default/minimum/maximum so tools with
// number types (Fix 13) and boolean types (Fix 20) can compile without casting.
export interface MCPToolPropertySchema {
  type:        string;
  description: string;
  enum?:       string[];
  minimum?:    number;
  maximum?:    number;
  default?:    unknown;
}

export interface MCPToolInputSchema {
  type:       'object';
  properties: Record<string, MCPToolPropertySchema>;
  required:   string[];
}

export interface MCPTool {
  name:        string;
  description: string;
  inputSchema: MCPToolInputSchema;
  execute: (args: Record<string, unknown>, callerArn: string) => Promise<MCPContent[] | string | object>;
}

export interface MCPResource {
  uri:         string;
  name:        string;
  description: string;
  mimeType:    string;
  read: (callerArn: string) => Promise<MCPResourceContent[]>;
}

// Fix 19: add resource field — required for type:'resource' content blocks used by
// Fix 8 (job_status), Fix 14 (query), Fix 15 (list_jobs)
export interface MCPEmbeddedResource {
  uri:       string;
  mimeType:  string;
  text?:     string;
  blob?:     string;
}

export interface MCPContent {
  type:      'text' | 'image' | 'resource';
  text?:     string;
  data?:     string;
  mimeType?: string;
  resource?: MCPEmbeddedResource;  // Fix 19: was missing; blocked all resource responses
}

export interface MCPResourceContent {
  uri:      string;
  mimeType: string;
  text?:    string;
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id?:     string | number | null;
  method:  string;
  params?: unknown;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id:      unknown;
  result?: unknown;
  error?:  { code: number; message: string; data?: unknown };
}
```

---

## Section 6: `packages/lambda/src/mcp/tools/submit-job.ts`

Complete implementation. Incorporates Fix 1 (env vars), Fix 6 (jobId returned), Fix 7 (7MB encoded limit), Fix 26 (content-hash dedup).

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID, createHash } from 'crypto';
import { MCPTool, MCPContent } from '../types';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Fix 7: guard on ENCODED length, not decoded length.
// API GW HTTP API limit is 10MB encoded body. 7MB zip → ~9.3MB base64 → safely under limit.
// The old guard (10MB decoded) fired AFTER API GW had already returned 413.
const MAX_ENCODED_BYTES = 7 * 1024 * 1024;

export const submitJobTool: MCPTool = {
  name: 'submit_job',
  description: [
    'Submit a skills zip file to be processed by Bedrock Claude.',
    'The zip must contain a manifest.json and one or more .md skill files.',
    'Returns a job ID immediately — use job_status to track progress.',
    'Base64-encode the zip before passing. Max ~7.5MB zip via MCP; use `skills-svc upload` for larger files.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      zip_base64: {
        type:        'string',
        description: 'Base64-encoded content of the skills zip file (max ~7.5 MB zip via MCP; use CLI for larger files)',
      },
      job_name: {
        type:        'string',
        description: 'Human-readable name for this job (max 128 chars)',
      },
      prompt: {
        type:        'string',
        description: 'Optional prompt override. If omitted, uses defaultPrompt from manifest.json.',
      },
    },
    required: ['zip_base64', 'job_name'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const zipBase64 = args.zip_base64 as string;
    const jobName   = (args.job_name as string).slice(0, 128);
    const env       = process.env.ENV ?? 'prod';

    // Fix 7: check encoded length before decoding — prevents silent API GW 413
    if (zipBase64.length > MAX_ENCODED_BYTES) {
      throw new Error(
        `Encoded zip is ${(zipBase64.length / 1024 / 1024).toFixed(1)}MB. ` +
        `API Gateway limit is 10MB; base64 overhead means the effective zip limit via MCP ` +
        `is ~7.5MB. Use \`skills-svc upload\` for larger files.`
      );
    }

    const zipBuffer = Buffer.from(zipBase64, 'base64');

    // Validate ZIP magic bytes (PK\x03\x04)
    if (zipBuffer.length < 4 || !zipBuffer.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error('Provided content is not a valid ZIP file');
    }

    // Fix 26: content-hash deduplication — same zip submitted twice → return existing job
    const contentHash = createHash('sha256').update(zipBuffer).digest('hex');
    const tableName   = process.env.DYNAMODB_TABLE_NAME!;

    const existing = await ddb.send(new QueryCommand({
      TableName:                 tableName,
      IndexName:                 'GSI4-CacheKey',
      KeyConditionExpression:    'GSI4PK = :ck',
      ExpressionAttributeValues: { ':ck': `CONTENTHASH#${contentHash}` },
      Limit:                     1,
    }));

    if (existing.Items?.length) {
      const prev = existing.Items[0];
      return [
        {
          type: 'text',
          text: [
            `Duplicate submission detected.`,
            `This exact zip was already submitted as job ${prev.jobId} ("${prev.jobName}").`,
            `Use job_status with job_id="${prev.jobId}" to check its status.`,
            `Submit a new job only if you want to reprocess with a different zip or prompt.`,
          ].join('\n'),
        },
        {
          type:     'resource',
          resource: {
            uri:      `skills://jobs/${prev.jobId}`,
            mimeType: 'application/json',
            text:     JSON.stringify({ jobId: prev.jobId, status: prev.status, isDuplicate: true }),
          },
        },
      ];
    }

    // Fix 1: bucket/key from env vars, not SSM (no SSM call per invocation)
    const bucket   = process.env.UPLOADS_BUCKET!;
    const kmsKeyId = process.env.UPLOADS_KMS_KEY_ID!;

    // Fix 6: generate jobId before upload so we can return it immediately
    const jobId  = randomUUID();
    const s3Key  = `uploads/mcp/${jobId}/${jobName.replace(/[^a-zA-Z0-9-]/g, '_')}.zip`;

    await s3.send(new PutObjectCommand({
      Bucket:               bucket,
      Key:                  s3Key,
      Body:                 zipBuffer,
      ContentType:          'application/zip',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId:          kmsKeyId,
      ChecksumAlgorithm:    'SHA256',
      Metadata: {
        'job-name':      jobName,
        'user-arn':      callerArn,
        // Fix 6: ingestion Lambda reads mcp-job-id and uses it as the DDB jobId key
        'mcp-job-id':    jobId,
        'mcp-submitted': 'true',
        'content-hash':  contentHash,
        ...(args.prompt ? { 'prompt-override': args.prompt as string } : {}),
      },
    }));

    return [
      {
        type: 'text',
        text: [
          `Job submitted.`,
          ``,
          `Job ID:   ${jobId}`,
          `Job Name: ${jobName}`,
          `ETA:      10–30 seconds to RUNNING, 2–10 minutes to COMPLETE`,
          ``,
          `Note: job_status returns NOT_FOUND for ~20 seconds while the ingestion pipeline initialises.`,
          `Poll:     call job_status with job_id="${jobId}"`,
        ].join('\n'),
      },
      {
        type:     'resource',
        resource: {
          uri:      `skills://jobs/${jobId}`,
          mimeType: 'application/json',
          text:     JSON.stringify({ jobId, jobName, status: 'SUBMITTED', isDuplicate: false }),
        },
      },
    ];
  },
};
```

**Required companion change in `packages/lambda/src/ingestion/handler.ts`** (Fix 6):
```typescript
import { isValidUUID } from '@skills-svc/shared';

// When reading the S3 object head after EventBridge trigger:
const mcpJobId = head.Metadata?.['mcp-job-id'];
const jobId    = (mcpJobId && isValidUUID(mcpJobId)) ? mcpJobId : randomUUID();
```

**Required addition to `packages/shared/src/types.ts`** (Fix 6):
```typescript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidUUID(v: string): boolean { return UUID_RE.test(v); }
```

---

## Section 7: `packages/lambda/src/mcp/tools/job-status.ts`

Complete implementation. Incorporates Fix 8 (`type: 'resource'` response), NOT_FOUND polling hint.

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const jobStatusTool: MCPTool = {
  name: 'job_status',
  description: 'Get the current status of a job. Returns machine-readable resource block with isTerminal and pollAgainInSeconds.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: {
        type:        'string',
        description: 'The UUID job ID returned from submit_job or list_jobs',
      },
    },
    required: ['job_id'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId     = args.job_id as string;
    const tableName = process.env.DYNAMODB_TABLE_NAME!;

    const res = await ddb.send(new GetCommand({
      TableName: tableName,
      Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    // Fix 8: NOT_FOUND includes machine-readable block + polling hint
    if (!res.Item) {
      return [
        {
          type: 'text',
          text: `Job ${jobId} not found. If just submitted, wait 10–20 seconds for the ingestion pipeline to start.`,
        },
        {
          type:     'resource',
          resource: {
            uri:      `skills://jobs/${jobId}`,
            mimeType: 'application/json',
            text:     JSON.stringify({
              jobId,
              status:             'NOT_FOUND',
              isTerminal:         false,
              pollAgainInSeconds: 15,
            }),
          },
        },
      ];
    }

    const job = res.Item;

    if (job.userArn !== callerArn) {
      throw new Error('Access denied: you do not own this job');
    }

    const statusEmoji: Record<string, string> = {
      PENDING:  '⏳',
      RUNNING:  '🔄',
      COMPLETE: '✅',
      FAILED:   '❌',
    };

    const lines = [
      `${statusEmoji[job.status as string] ?? '?'} ${job.jobName}`,
      ``,
      `Status:   ${job.status}`,
      `Job ID:   ${job.jobId}`,
      `Created:  ${new Date(job.createdAt as string).toLocaleString()}`,
      `Updated:  ${new Date(job.updatedAt as string).toLocaleString()}`,
    ];

    if (job.status === JobStatus.COMPLETE) {
      lines.push(`Result:   call get_result with job_id="${jobId}"`);
    }
    if (job.status === JobStatus.FAILED && job.errorMessage) {
      lines.push(`Error:    ${job.errorMessage as string}`);
    }
    if (job.status === JobStatus.RUNNING) {
      const elapsedSec = Math.round((Date.now() - new Date(job.createdAt as string).getTime()) / 1000);
      lines.push(`Elapsed:  ${elapsedSec}s`);
    }

    const isTerminal = job.status === JobStatus.COMPLETE || job.status === JobStatus.FAILED;
    const pollAgainInSeconds =
      job.status === JobStatus.PENDING || job.status === JobStatus.RUNNING ? 10 : null;

    // Fix 8: machine-readable resource block alongside human text
    return [
      { type: 'text', text: lines.join('\n') },
      {
        type:     'resource',
        resource: {
          uri:      `skills://jobs/${jobId}`,
          mimeType: 'application/json',
          text:     JSON.stringify({
            jobId,
            jobName:            job.jobName,
            status:             job.status,
            createdAt:          job.createdAt,
            updatedAt:          job.updatedAt,
            isTerminal,
            pollAgainInSeconds,
            ...(job.status === JobStatus.FAILED   ? { errorMessage:     job.errorMessage }            : {}),
            ...(job.status === JobStatus.COMPLETE ? { resultAvailable:  Boolean(job.s3ResultKey) }   : {}),
          }),
        },
      },
    ];
  },
};
```

---

## Section 8: `packages/lambda/src/mcp/tools/get-result.ts`

Complete implementation. Incorporates Fix 9 (`userArn` in decrypt context), Fix 10 (FAILED message), Fix 11 (size guard + presigned URL), Fix 20 (`summary_only` boolean).

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus, RunResult } from '@skills-svc/shared';
import { envelopeDecrypt } from '@skills-svc/shared/crypto';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Fix 11: Lambda synchronous response limit is 6MB; stay well under it
const INLINE_LIMIT_BYTES = 4 * 1024 * 1024;  // 4MB

export const getResultTool: MCPTool = {
  name: 'get_result',
  description: 'Retrieve the full result of a completed job. For results >4MB, returns a presigned S3 URL instead of inline content.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: {
        type:        'string',
        description: 'Job ID of a COMPLETE job',
      },
      // Fix 20: boolean not string — MCP clients send true/false per JSON Schema
      summary_only: {
        type:        'boolean',
        default:     false,
        description: 'Return only the result summary (true) or the full output (false). Default: false',
      },
    },
    required: ['job_id'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId       = args.job_id as string;
    // Fix 20: accept boolean true OR string 'true' for backwards compatibility
    const summaryOnly = args.summary_only === true || args.summary_only === 'true';
    const tableName   = process.env.DYNAMODB_TABLE_NAME!;
    const env         = process.env.ENV ?? 'prod';

    const jobRes = await ddb.send(new GetCommand({
      TableName: tableName,
      Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    if (!jobRes.Item) throw new Error(`Job not found: ${jobId}`);
    if (jobRes.Item.userArn !== callerArn) throw new Error('Access denied: you do not own this job');

    // Fix 10: FAILED gets a distinct message, not the generic "not complete yet"
    if (jobRes.Item.status === JobStatus.FAILED) {
      return [{
        type: 'text',
        text: [
          `Job FAILED — no result was produced.`,
          jobRes.Item.errorMessage ? `Error: ${jobRes.Item.errorMessage as string}` : '',
          `Do not retry get_result for this job. Submit a new job if needed.`,
        ].filter(Boolean).join('\n'),
      }];
    }

    if (jobRes.Item.status !== JobStatus.COMPLETE) {
      return [{
        type: 'text',
        text: `Job not yet complete. Status: ${jobRes.Item.status as string}. Poll job_status, then retry get_result when COMPLETE.`,
      }];
    }

    const resultKey = jobRes.Item.s3ResultKey as string | undefined;
    if (!resultKey) throw new Error('Result key not found on job record');

    const bucket = process.env.RESULTS_BUCKET!;
    const obj    = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: resultKey }));

    const chunks: Uint8Array[] = [];
    for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const rawBytes = Buffer.concat(chunks);

    // Fix 11: size guard — large results return a presigned URL instead of crashing with 502
    if (rawBytes.length > INLINE_LIMIT_BYTES) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: resultKey }),
        { expiresIn: 3600 }
      );
      return [{
        type: 'text',
        text: [
          `Result is too large to return inline (${(rawBytes.length / 1024 / 1024).toFixed(1)} MB).`,
          `Download via presigned URL (valid 1 hour):`,
          url,
        ].join('\n'),
      }];
    }

    const rawEnvelope = JSON.parse(rawBytes.toString('utf-8'));

    // Fix 9: envelopeDecrypt must receive userArn in context to prevent cross-tenant decryption
    const plain = await envelopeDecrypt(rawEnvelope, {
      jobId,
      userArn:     callerArn,    // Fix 9: was missing; any caller who knew jobId could decrypt
      purpose:     'skills-svc-result',
      environment: env,
    });

    const result: RunResult = JSON.parse(plain.toString('utf-8'));

    if (summaryOnly) {
      return [{ type: 'text', text: result.resultSummary }];
    }

    const formatted = [
      `## Result: ${result.jobName}`,
      ``,
      `**Skills analysed:** ${result.skillNames.join(', ')}`,
      `**Duration:** ${Math.round(result.durationMs / 1000)}s`,
      `**Completed:** ${new Date(result.completedAt).toLocaleString()}`,
      ``,
      `### Output`,
      ``,
      typeof result.output === 'string' && result.output.startsWith('{')
        ? '```json\n' + JSON.stringify(JSON.parse(result.output), null, 2) + '\n```'
        : String(result.output),
    ].join('\n');

    return [{ type: 'text', text: formatted }];
  },
};
```

---

## Section 9: `packages/lambda/src/mcp/tools/query.ts`

Complete implementation. Incorporates Fix 13 (number types, `from` pagination), Fix 14 (`type: 'resource'` response).

```typescript
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { MCPTool, MCPContent } from '../types';
import { QueryRequest, QueryResponse } from '@skills-svc/shared';

const lambdaClient = new LambdaClient({});

export const queryTool: MCPTool = {
  name: 'query_knowledge_store',
  description: [
    'Search the skills knowledge store using natural language.',
    'Returns the most relevant job results using hybrid semantic + keyword search.',
    'Results are scoped to your own jobs only.',
    'Use this to find prior skill analysis results, reuse past outputs, or discover what skills have been run.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type:        'string',
        description: 'Natural language search query, e.g. "how to classify text" or "eigenvalue computation"',
      },
      // Fix 13: must be type:'number' — clients send numeric values per JSON Schema
      top_k: {
        type:        'number',
        minimum:     1,
        maximum:     20,
        default:     5,
        description: 'Results to return (1–20, default: 5)',
      },
      min_score: {
        type:        'number',
        minimum:     0,
        maximum:     1,
        default:     0.5,
        description: 'Minimum relevance score 0.0–1.0 (default: 0.5)',
      },
      // Fix 13: from pagination was entirely missing
      from: {
        type:        'number',
        minimum:     0,
        default:     0,
        description: 'Pagination offset — number of results to skip (0-based, default: 0)',
      },
    },
    required: ['query'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const queryFnArn = process.env.QUERY_LAMBDA_ARN;
    if (!queryFnArn) throw new Error('QUERY_LAMBDA_ARN not configured');

    // Fix 13: Number() coercion handles both numeric and string inputs defensively
    const topK     = Math.min(Math.max(1, Number(args.top_k     ?? 5)),   20);
    const minScore = Math.min(Math.max(0, Number(args.min_score ?? 0.5)),  1);
    const from     = Math.max(0, Number(args.from ?? 0));

    const req: QueryRequest = {
      query:         args.query as string,
      callerUserArn: callerArn,
      topK,
      minScore,
      from,
    };

    const invocation = await lambdaClient.send(new InvokeCommand({
      FunctionName: queryFnArn,
      Payload:      Buffer.from(JSON.stringify(req)),
    }));

    if (invocation.FunctionError) {
      const errBody = JSON.parse(Buffer.from(invocation.Payload!).toString());
      throw new Error(errBody.errorMessage ?? 'Query failed');
    }

    const response: QueryResponse = JSON.parse(Buffer.from(invocation.Payload!).toString());

    if (!response.results.length) {
      return [{
        type: 'text',
        text: 'No results found. Try a broader query or lower min_score.',
      }];
    }

    const formattedText = [
      `Found ${response.results.length} result(s) in ${response.queryDurationMs}ms:`,
      ``,
      ...response.results.map((r, i) => [
        `${i + 1}. **${r.jobName}** (score: ${(r.score * 100).toFixed(0)}%)`,
        `   Skills: ${r.skillNames.join(', ')}`,
        `   Date: ${new Date(r.createdAt).toLocaleDateString()}`,
        `   Summary: ${r.resultSummary.slice(0, 300)}${r.resultSummary.length > 300 ? '...' : ''}`,
        `   Job ID: \`${r.jobId}\``,
      ].join('\n')),
    ].join('\n');

    // Fix 14: machine-readable resource block so agents can extract jobIds without regex
    return [
      { type: 'text', text: formattedText },
      {
        type:     'resource',
        resource: {
          uri:      'skills://query-results',
          mimeType: 'application/json',
          text:     JSON.stringify({
            total:           response.total ?? response.results.length,
            from:            response.from  ?? 0,
            hasMore:         response.hasMore ?? false,
            queryDurationMs: response.queryDurationMs,
            results: response.results.map(r => ({
              jobId:         r.jobId,
              jobName:       r.jobName,
              score:         r.score,
              skillNames:    r.skillNames,
              createdAt:     r.createdAt,
              resultSummary: r.resultSummary.slice(0, 500),
            })),
          }),
        },
      },
    ];
  },
};
```

---

## Section 10: `packages/lambda/src/mcp/tools/list-jobs.ts`

Complete implementation. Incorporates Fix 15 (GSI2-User always, not GSI1 with limit-before-filter), `since`/`until`/`job_name_contains` filters, number `limit` type, `type: 'resource'` response.

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const listJobsTool: MCPTool = {
  name: 'list_jobs',
  description: 'List your jobs, optionally filtered by status, date range, or name substring. Returns machine-readable JSON resource block.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type:        'string',
        description: 'Filter by status (default: ALL)',
        enum:        ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'ALL'],
      },
      // Fix 15: type must be 'number' not 'string'
      limit: {
        type:        'number',
        minimum:     1,
        maximum:     100,
        default:     20,
        description: 'Maximum number of jobs to return (1–100, default: 20)',
      },
      since: {
        type:        'string',
        description: 'ISO 8601 datetime — return only jobs created at or after this time',
      },
      until: {
        type:        'string',
        description: 'ISO 8601 datetime — return only jobs created at or before this time',
      },
      job_name_contains: {
        type:        'string',
        description: 'Case-insensitive substring filter on job name',
      },
    },
    required: [],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const status           = (args.status as string | undefined) ?? 'ALL';
    // Fix 15: Number() coercion so both numeric and legacy string inputs work
    const limit            = Math.min(Math.max(1, Number(args.limit ?? 20)), 100);
    const since            = args.since as string | undefined;
    const until            = args.until as string | undefined;
    const jobNameContains  = (args.job_name_contains as string | undefined)?.toLowerCase();
    const tableName        = process.env.DYNAMODB_TABLE_NAME!;

    // Fix 15: ALWAYS use GSI2-User keyed on caller.
    // The old code used GSI1-Status with Limit-before-FilterExpression, which returned 0 results
    // when the first N items in the index all belonged to other users.
    const expressionAttributeValues: Record<string, unknown> = {
      ':user': `${DDB_KEY_PREFIX.USER}${callerArn}`,
    };
    const expressionAttributeNames: Record<string, string> = {};
    let filterParts: string[] = [];

    if (status !== 'ALL') {
      filterParts.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = status;
    }
    if (since) {
      filterParts.push('createdAt >= :since');
      expressionAttributeValues[':since'] = since;
    }
    if (until) {
      filterParts.push('createdAt <= :until');
      expressionAttributeValues[':until'] = until;
    }

    const res = await ddb.send(new QueryCommand({
      TableName:                 tableName,
      IndexName:                 'GSI2-User',
      KeyConditionExpression:    'GSI2PK = :user',
      ...(filterParts.length > 0 ? { FilterExpression: filterParts.join(' AND ') } : {}),
      ...(Object.keys(expressionAttributeNames).length > 0 ? { ExpressionAttributeNames: expressionAttributeNames } : {}),
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward:          false,   // newest first
      Limit:                     limit,
    }));

    let items = res.Items ?? [];

    // Apply in-memory job_name_contains filter (DDB FilterExpression doesn't support case-insensitive contains)
    if (jobNameContains) {
      items = items.filter(item =>
        (item.jobName as string | undefined)?.toLowerCase().includes(jobNameContains)
      );
    }

    if (!items.length) {
      return [{
        type: 'text',
        text: `No jobs found${status !== 'ALL' ? ` with status ${status}` : ''}${jobNameContains ? ` matching "${jobNameContains}"` : ''}.`,
      }];
    }

    const rows = items.map(item =>
      `• \`${item.jobId as string}\` — **${item.jobName as string}** — ${item.status as string} — ${new Date(item.createdAt as string).toLocaleDateString()}`
    ).join('\n');

    const humanText = `Your jobs (${items.length}):\n\n${rows}`;

    // Fix 15: resource block for machine-readable extraction
    return [
      { type: 'text', text: humanText },
      {
        type:     'resource',
        resource: {
          uri:      'skills://jobs/list',
          mimeType: 'application/json',
          text:     JSON.stringify({
            count: items.length,
            jobs: items.map(item => ({
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

## Section 11: `packages/lambda/src/mcp/tools/cancel-job.ts`

Complete implementation. Incorporates Fix 16 (bare `jobId` as `startedBy`), Fix 17 (IAM note — cluster ARN for ListTasks), Fix 18 (`isError: true` on terminal state via throw), ConditionalCheck handling.

```typescript
import { ECSClient, StopTaskCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ecs = new ECSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Note: Fix 17 — IAM policy for ecs:ListTasks MUST target the cluster ARN, not task/* ARN.
// The CDK stack (Section 1) now correctly sets:
//   sid: 'ECSListTasks', resources: [`arn:aws:ecs:${region}:${account}:cluster/${clusterName}`]
// and separately:
//   sid: 'ECSStopTask',  resources: [`arn:aws:ecs:${region}:${account}:task/${clusterName}/*`]

export const cancelJobTool: MCPTool = {
  name: 'cancel_job',
  description: 'Cancel a PENDING or RUNNING job. Throws an error (isError: true) if the job is already in a terminal state.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: {
        type:        'string',
        description: 'Job ID to cancel',
      },
      reason: {
        type:        'string',
        description: 'Reason for cancellation (recorded in the job record)',
      },
    },
    required: ['job_id'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId  = args.job_id as string;
    const reason = (args.reason as string | undefined) ?? 'Cancelled via MCP';
    const tableName = process.env.DYNAMODB_TABLE_NAME!;

    const jobRes = await ddb.send(new GetCommand({
      TableName: tableName,
      Key:       { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    if (!jobRes.Item) throw new Error(`Job not found: ${jobId}`);
    if (jobRes.Item.userArn !== callerArn) throw new Error('Access denied: you do not own this job');

    const status  = jobRes.Item.status as JobStatus;
    const version = jobRes.Item.version as number ?? 0;

    // Fix 18: throw so server.ts catch block returns isError: true — agent can detect failure
    if (status === JobStatus.COMPLETE || status === JobStatus.FAILED) {
      throw new Error(`Cannot cancel — job ${jobId} is already in terminal state: ${status}`);
    }

    // Fix 16: use bare jobId as startedBy — matches SPEC-23 Fix 1 in ingestion Lambda.
    // The old code used `skills-svc-ingestion-${jobId.slice(0, 8)}` which never matched.
    if (status === JobStatus.RUNNING) {
      const clusterArn = process.env.ECS_CLUSTER_ARN!;

      const tasksRes = await ecs.send(new ListTasksCommand({
        cluster:   clusterArn,
        startedBy: jobId,   // Fix 16: bare UUID
      }));

      for (const taskArn of tasksRes.taskArns ?? []) {
        await ecs.send(new StopTaskCommand({
          cluster: clusterArn,
          task:    taskArn,
          reason,
        }));
      }
    }

    try {
      await ddb.send(new UpdateCommand({
        TableName:           tableName,
        Key:                 { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
        UpdateExpression:    'SET #s = :s, updatedAt = :now, #v = :nv, GSI1PK = :gsi, errorMessage = :err',
        ConditionExpression: '#v = :cv',
        ExpressionAttributeNames: {
          '#s': 'status',
          '#v': 'version',
        },
        ExpressionAttributeValues: {
          ':s':   JobStatus.FAILED,
          ':now': new Date().toISOString(),
          ':nv':  version + 1,
          ':cv':  version,
          ':gsi': `${DDB_KEY_PREFIX.STATUS}${JobStatus.FAILED}`,
          ':err': `Cancelled via MCP: ${reason}`,
        },
      }));
    } catch (err: unknown) {
      // Fix 18: ConditionalCheckFailed means the job transitioned to terminal between our GetItem
      // and UpdateItem — return a non-error content block (the job is stopped either way)
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        return [{
          type: 'text',
          text: `Job ${jobId} reached a terminal state before cancellation could complete. It is no longer running.`,
        }];
      }
      throw err;
    }

    return [{
      type: 'text',
      text: `Job ${jobId} cancelled successfully.\nReason: ${reason}`,
    }];
  },
};
```

---

## Section 12: `packages/cli/src/commands/mcp-config.ts`

Complete token-based config writer. Incorporates Fix 3 (no AWS credentials in mcp.json, token stored in DDB with correct integer TTL).

```typescript
import { Command } from 'commander';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';

export function mcpConfigCommand(): Command {
  return new Command('mcp-config')
    .description('Generate an MCP token and write server config for Claude Code or Claude Desktop')
    .option('--install', 'Write config to ~/.claude/mcp.json', false)
    .option('--ttl-hours <hours>', 'Token lifetime in hours (default: 8)', '8')
    .action(async (opts: { install: boolean; ttlHours: string }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();

      const sts  = new STSClient({ region: cfg.region, credentials: creds });
      const ssm  = new SSMClient({ region: cfg.region, credentials: creds });
      const ddb  = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: cfg.region, credentials: creds })
      );

      // Verify caller identity
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Arn) throw new Error('Could not determine caller identity from STS');

      // Resolve MCP endpoint
      const mcpEndpoint = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/mcp/endpoint`,
      })).then(r => r.Parameter!.Value!);

      // Resolve DDB table name if not already in local config
      let dynamodbTableName = cfg.dynamodbTableName;
      if (!dynamodbTableName) {
        dynamodbTableName = await ssm.send(new GetParameterCommand({
          Name: `/skills-svc/${cfg.envName}/dynamodb/table-name`,
        })).then(r => r.Parameter!.Value!);
      }

      // Fix 3: generate opaque token — do NOT embed AWS credentials in mcp.json
      const token       = randomBytes(32).toString('hex');
      const ttlHours    = Math.max(1, Math.min(72, parseInt(opts.ttlHours, 10) || 8));
      const expiresAt   = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
      // Fix 3: ttl must be integer epoch seconds (old code had literal '...' placeholder)
      const ttlEpochSec = Math.floor(Date.now() / 1000) + ttlHours * 60 * 60;

      await ddb.send(new PutCommand({
        TableName: dynamodbTableName,
        Item: {
          PK:        `MCPTOKEN#${token}`,
          SK:        'META',
          userArn:   identity.Arn,
          expiresAt,
          ttl:       ttlEpochSec,   // Fix 3: integer epoch seconds for DDB TTL
          createdAt: new Date().toISOString(),
        },
      }));

      // Fix 3: write only token header — the env field is stdio-only and silently ignored
      // by HTTP transport. Never embed AWS_ACCESS_KEY_ID etc. in mcp.json.
      const mcpConfig = {
        mcpServers: {
          'skills-as-a-service': {
            transport: {
              type:    'http',
              url:     mcpEndpoint,
              headers: {
                'X-API-Key': token,   // validated by mcp-auth Lambda (Section 2)
              },
            },
            // No `env` field — env is a stdio transport concept, ignored for HTTP transport
          },
        },
      };

      const configJson = JSON.stringify(mcpConfig, null, 2);

      if (opts.install) {
        const claudeDir = path.join(os.homedir(), '.claude');
        mkdirSync(claudeDir, { recursive: true });
        const mcpFile = path.join(claudeDir, 'mcp.json');

        let existing: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
        if (existsSync(mcpFile)) {
          try {
            existing = JSON.parse(readFileSync(mcpFile, 'utf-8'));
          } catch {
            // corrupt existing file — overwrite
          }
        }
        if (!existing.mcpServers) existing.mcpServers = {};
        existing.mcpServers['skills-as-a-service'] = mcpConfig.mcpServers['skills-as-a-service'];

        writeFileSync(mcpFile, JSON.stringify(existing, null, 2), { mode: 0o600 });

        console.log(chalk.green(`MCP config written to ${mcpFile}`));
        console.log(chalk.dim(`Token expires: ${expiresAt} (${ttlHours}h)`));
        console.log(chalk.dim('Restart Claude Code / Claude Desktop to pick up the new MCP server.'));
        console.log(chalk.dim('Run `skills-svc mcp-config --install` again before the token expires.'));
      } else {
        console.log(configJson);
        console.log(chalk.dim(`\nToken expires: ${expiresAt} (${ttlHours}h)`));
        console.log(chalk.dim('To install:    skills-svc mcp-config --install'));
      }
    });
}
```

---

## Section 13: Required Package Additions and Shared Types

### `packages/lambda/package.json` additions

```json
{
  "dependencies": {
    "@aws-sdk/s3-request-presigner": "^3.600.0"
  }
}
```

### `packages/shared/src/types.ts` additions (Fix 6, Fix 13)

```typescript
// Fix 6: UUID validator used by ingestion Lambda to honour mcp-job-id metadata
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidUUID(v: string): boolean { return UUID_RE.test(v); }

// Fix 13: QueryRequest and QueryResponse updated with from/total/hasMore
export interface QueryRequest {
  query:         string;
  callerUserArn: string;
  topK?:         number;
  minScore?:     number;
  from?:         number;   // Fix 13: pagination offset was missing
}

export interface QueryResponse {
  results:         SearchResult[];
  queryDurationMs: number;
  total?:          number;    // Fix 13
  hasMore?:        boolean;   // Fix 13
  from?:           number;    // Fix 13
}
```

### `packages/lambda/src/mcp/tools/index.ts`

```typescript
export { submitJobTool }  from './submit-job';
export { queryTool }      from './query';
export { jobStatusTool }  from './job-status';
export { listJobsTool }   from './list-jobs';
export { getResultTool }  from './get-result';
export { cancelJobTool }  from './cancel-job';

import { submitJobTool }  from './submit-job';
import { queryTool }      from './query';
import { jobStatusTool }  from './job-status';
import { listJobsTool }   from './list-jobs';
import { getResultTool }  from './get-result';
import { cancelJobTool }  from './cancel-job';

export const ALL_TOOLS = [
  submitJobTool,
  queryTool,
  jobStatusTool,
  listJobsTool,
  getResultTool,
  cancelJobTool,
];
```

### `packages/lambda/src/mcp/resources/index.ts` (unchanged from SPEC-09 — no fixes apply)

```typescript
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MCPResource, MCPResourceContent } from '../types';
import { DDB_KEY_PREFIX } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const jobsResource: MCPResource = {
  uri:         'skills://jobs',
  name:        'My Jobs',
  description: 'All jobs submitted by the authenticated user, newest first',
  mimeType:    'application/json',

  async read(callerArn): Promise<MCPResourceContent[]> {
    const tableName = process.env.DYNAMODB_TABLE_NAME!;
    const res = await ddb.send(new QueryCommand({
      TableName:                 tableName,
      IndexName:                 'GSI2-User',
      KeyConditionExpression:    'GSI2PK = :user',
      ExpressionAttributeValues: { ':user': `${DDB_KEY_PREFIX.USER}${callerArn}` },
      ScanIndexForward:          false,
      Limit:                     50,
    }));

    const jobs = (res.Items ?? []).map(item => ({
      jobId:      item.jobId,
      jobName:    item.jobName,
      status:     item.status,
      createdAt:  item.createdAt,
      skillNames: item.skillNames ?? [],
    }));

    return [{
      uri:      'skills://jobs',
      mimeType: 'application/json',
      text:     JSON.stringify(jobs, null, 2),
    }];
  },
};

export const ALL_RESOURCES: MCPResource[] = [jobsResource];
```

### `infra/bin/app.ts` — MCPStack wiring (updated props)

```typescript
import { MCPStack } from '../lib/mcp-stack';

const mcpStack = new MCPStack(app, `SkillsSvc-${envName}-MCP`, {
  env,
  envName,
  vpc:               network.vpc,
  lambdaSg:          network.lambdaSg,
  lambdaEnvKey:      security.lambdaEnvKey,
  userRole:          security.userRole,
  dynamodbTableName: storage.jobsTable.tableName,
  jobsTableArn:      storage.jobsTable.tableArn,    // needed for token IAM condition
  uploadsBucket:     storage.uploadsBucket.bucketName,
  resultsBucket:     storage.resultsBucket.bucketName,
  uploadsKmsKeyId:   security.uploadsBucketKey.keyArn,
  queryLambdaArn:    lambdaStack.queryFn.functionArn,
  ecsClusterName:    ecsStack.cluster.clusterName,  // Fix 17: name not ARN
  ecsClusterArn:     ecsStack.cluster.clusterArn,
  jobsTopicArn:      messaging.jobsNotificationTopic.topicArn,
});
mcpStack.addDependency(lambdaStack);
mcpStack.addDependency(ecsStack);
```

---

## Fix Coverage Matrix

| Fix | Severity | Section | Summary |
|-----|----------|---------|---------|
| 1  | CRITICAL  | 1 (CDK env) | DYNAMODB_TABLE_NAME, RESULTS_BUCKET, QUERY_LAMBDA_ARN, UPLOADS_BUCKET, UPLOADS_KMS_KEY_ID added |
| 2  | CRITICAL  | 1 (CDK auth) | HttpLambdaAuthorizer replaces HttpIamAuthorizer; tokenAuthFn deployed |
| 3  | CRITICAL  | 12 (CLI) | Token written to DDB with integer TTL; no AWS creds in mcp.json |
| 4  | BLOCKING  | 3 (handler) | Reads `lambda.callerUserArn` with IAM fallback; returns 401 if absent |
| 5  | BLOCKING  | 1 (WAF) | NoUserAgent_HEADER + SizeRestrictions_BODY excluded; per-token rate limit; WAF dependency |
| 6  | BLOCKING  | 6 (submit-job) | jobId generated pre-upload; returned in text + resource block; ingestion honours mcp-job-id |
| 7  | BLOCKING  | 6 (submit-job) | MAX_ENCODED_BYTES = 7MB; guard on encoded length before decode |
| 8  | BLOCKING  | 7 (job-status) | type:'resource' block with isTerminal + pollAgainInSeconds; NOT_FOUND also gets resource block |
| 9  | BLOCKING  | 8 (get-result) | userArn passed to envelopeDecrypt in encryption context |
| 10 | BLOCKING  | 8 (get-result) | FAILED returns distinct "no result produced" message |
| 11 | BLOCKING  | 8 (get-result) | INLINE_LIMIT_BYTES = 4MB; presigned URL returned for larger results |
| 12 | N/A (searcher.ts) | — | Tracked in SPEC-24 Fix 2; searcher.ts is outside MCP Lambda scope |
| 13 | BLOCKING  | 9 (query) | top_k, min_score, from all typed number; Number() coercion; from pagination added |
| 14 | BLOCKING  | 9 (query) | type:'resource' block with jobIds and scores for machine extraction |
| 15 | BLOCKING  | 10 (list-jobs) | GSI2-User always used; since/until/job_name_contains added; limit is number type |
| 16 | BLOCKING  | 11 (cancel-job) | startedBy: jobId (bare UUID) |
| 17 | BLOCKING  | 1 (CDK IAM) | ECSListTasks targets cluster ARN; ECSStopTask targets task ARN |
| 18 | BLOCKING  | 11 (cancel-job) | Terminal state throws → isError:true; ConditionalCheck returns non-error content |
| 19 | BLOCKING  | 5 (types) | MCPContent.resource field added; MCPToolPropertySchema has default/minimum/maximum |
| 20 | BLOCKING  | 8 (get-result) | summary_only: type:'boolean'; accepts boolean true or string 'true' |
| 21 | CORRECTNESS | 4 (server) | id: req.id ?? null in respond() and error() |
| 22 | CORRECTNESS | 4 (server) | jsonrpc !== '2.0' returns -32600 before any dispatch |
| 23 | CORRECTNESS | 4 (server) | validateArgs checks null/undefined on required fields |
| 24 | CORRECTNESS | 4 (server) | sanitizeErrorMessage() hides AWS SDK internals; safe prefixes allowlisted |
| 25 | CORRECTNESS | 3 (handler) | All-notification batch returns 204 not 200 [] |
| 26 | CORRECTNESS | 6 (submit-job) | SHA-256 content hash; GSI4-CacheKey query before upload |
| 27 | BLOCKING  | 1 (CDK CORS) | CorsHttpMethod.OPTIONS included in allowMethods (part of Fix 2 block) |
| 28 | CORRECTNESS | 4 (server) | isError omitted on success; isError:true only on error path |
