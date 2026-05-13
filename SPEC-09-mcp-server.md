# Skills as a Service (SaaS) — Specification Part 9: Lambda MCP Server

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | ... | [Part 8](SPEC-08-cli-features-2.md) | [Part 9: MCP Server]

---

## Overview

An MCP (Model Context Protocol) server exposed via API Gateway + Lambda. This lets any MCP-compatible client (Claude Desktop, Claude Code, custom agents) call Skills as a Service tools directly — submitting jobs, querying the knowledge store, checking status — without using the CLI.

```
MCP Client (Claude Desktop / Claude Code)
    │  JSON-RPC 2.0 over HTTPS
    ▼
API Gateway (HTTP API, JWT authorizer)
    │
    ▼
MCP Lambda (Node.js 20, VPC)
    │
    ├── tools/submit-job     → uploads zip to S3, triggers pipeline
    ├── tools/query          → hybrid knn+BM25 search over knowledge store
    ├── tools/job-status     → DDB GetItem
    ├── tools/list-jobs      → DDB GSI query
    ├── tools/get-result     → S3 GetObject + decrypt + return
    ├── tools/cancel-job     → ECS StopTask + DDB update
    └── resources/jobs       → MCP resource listing all jobs
```

---

## 1. MCP Protocol Implementation

The server implements [MCP spec 2024-11-05](https://modelcontextprotocol.io/specification). Transport: **Streamable HTTP** (single `/mcp` endpoint, POST for all JSON-RPC calls). Lambda returns the full response body — no SSE streaming (API Gateway + Lambda doesn't support true streaming SSE for long-running tools; tools complete within Lambda timeout).

### JSON-RPC message types handled

| Method | Direction | Description |
|--------|-----------|-------------|
| `initialize` | Client → Server | Handshake, capability negotiation |
| `tools/list` | Client → Server | Returns all available tools with schemas |
| `tools/call` | Client → Server | Invoke a tool by name with arguments |
| `resources/list` | Client → Server | List available MCP resources |
| `resources/read` | Client → Server | Read a resource by URI |
| `ping` | Client → Server | Keepalive |

---

## 2. New AWS Resources

### `infra/lib/mcp-stack.ts`

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
  userRole: iam.Role;           // MCP Lambda reuses user-role permissions
  dynamodbTableName: string;
  uploadsBucket: string;
  resultsBucket: string;
  uploadsKmsKeyId: string;
  queryLambdaArn: string;
  opensearchEndpoint: string;
  jobsTopicArn: string;
  ecsClusterArn: string;
}

export class MCPStack extends cdk.Stack {
  public readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: MCPStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // MCP Lambda role
    const mcpLambdaRole = new iam.Role(this, 'MCPLambdaRole', {
      roleName: `skills-svc-mcp-lambda-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    // Same permissions as the user role — MCP server acts on behalf of authenticated users
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDB',
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.dynamodbTableName}`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${props.dynamodbTableName}/index/*`,
      ],
    }));
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
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeQueryLambda',
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:skills-svc-query-${this.account}`],
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECSCancel',
      actions: ['ecs:StopTask', 'ecs:ListTasks'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:task/${props.ecsClusterArn.split('/').pop()}/*`],
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SNSPublish',
      actions: ['sns:Publish'],
      resources: [props.jobsTopicArn],
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KMSDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: ['*'],  // KMS CMKs — restrict to specific key ARNs in production
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/mcp/*`],
    }));
    mcpLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockEmbed',
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));

    // MCP Lambda function
    const mcpFn = new lambda.Function(this, 'MCPLambda', {
      functionName: `skills-svc-mcp-${this.account}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'mcp/handler.handler',
      code: lambda.Code.fromAsset('../packages/lambda/dist'),
      timeout: cdk.Duration.seconds(29),   // API GW HTTP API max timeout is 29s
      memorySize: 512,
      reservedConcurrentExecutions: 200,
      tracing: lambda.Tracing.ACTIVE,
      role: mcpLambdaRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ENV: envName,
        REGION: this.region,
        MCP_SERVER_NAME: 'skills-as-a-service',
        MCP_SERVER_VERSION: '1.0.0',
      },
      logRetention: logs.RetentionDays.THREE_MONTHS,
      description: 'MCP server — exposes skills pipeline tools to MCP clients',
    });

    // JWT Authorizer — validates tokens issued by AWS Cognito or any OIDC provider
    // For initial deploy, use IAM auth (sigv4) instead of JWT — simpler for CLI clients
    // Swap to JWT when integrating with Claude Desktop which uses OAuth
    const authorizer = new apigatewayv2Authorizers.HttpIamAuthorizer();

    // HTTP API
    const api = new apigatewayv2.HttpApi(this, 'MCPAPI', {
      apiName: `skills-svc-mcp-${envName}`,
      description: 'Skills as a Service MCP Server',
      corsPreflight: {
        allowOrigins: ['https://claude.ai', 'app://claudedesktop'],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
        maxAge: cdk.Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    // Single /mcp endpoint — all JSON-RPC 2.0 traffic
    api.addRoutes({
      path: '/mcp',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('MCPIntegration', mcpFn, {
        payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
      }),
      authorizer,
    });

    // Health check (no auth)
    api.addRoutes({
      path: '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('HealthIntegration', mcpFn, {
        payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    this.apiUrl = api.apiEndpoint;

    // WAF — rate limiting + AWS managed rules
    const waf = new wafv2.CfnWebACL(this, 'MCPWAF', {
      name: `skills-svc-mcp-waf-${envName}`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          statement: {
            rateBasedStatement: {
              limit: 500,            // 500 requests per 5-minute window per IP
              aggregateKeyType: 'IP',
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `skills-svc-mcp-rate-limit-${envName}`,
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `skills-svc-mcp-common-rules-${envName}`,
            sampledRequestsEnabled: false,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `skills-svc-mcp-bad-inputs-${envName}`,
            sampledRequestsEnabled: false,
          },
        },
      ],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `skills-svc-mcp-waf-${envName}`,
        sampledRequestsEnabled: false,
      },
    });

    // Associate WAF with API Gateway stage
    new wafv2.CfnWebACLAssociation(this, 'MCPWAFAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/apis/${api.apiId}/stages/$default`,
      webAclArn: waf.attrArn,
    });

    // Outputs
    new cdk.CfnOutput(this, 'MCPEndpoint', {
      value: `${api.apiEndpoint}/mcp`,
      description: 'MCP server endpoint — add to MCP client config',
    });

    new ssm.StringParameter(this, 'ParamMCPEndpoint', {
      parameterName: `/skills-svc/${envName}/mcp/endpoint`,
      stringValue: `${api.apiEndpoint}/mcp`,
    });
  }
}
```

---

## 3. MCP Lambda Handler

### `packages/lambda/src/mcp/handler.ts`

```typescript
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { captureAWSv3Client } from 'aws-xray-sdk';
import { randomUUID } from 'crypto';
import { MCPServer } from './server';
import { ALL_TOOLS } from './tools';
import { ALL_RESOURCES } from './resources';

const server = new MCPServer({
  name: process.env.MCP_SERVER_NAME ?? 'skills-as-a-service',
  version: process.env.MCP_SERVER_VERSION ?? '1.0.0',
  tools: ALL_TOOLS,
  resources: ALL_RESOURCES,
});

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Health check
  if (event.requestContext.http.method === 'GET' && event.rawPath === '/health') {
    return { statusCode: 200, body: JSON.stringify({ status: 'ok', server: server.name }) };
  }

  // Extract caller identity from IAM auth context
  const callerArn = event.requestContext.authorizer?.iam?.userArn ?? 'unknown';

  let body: unknown;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonRpcError(-32700, 'Parse error', null);
  }

  // Batch requests (array of JSON-RPC calls)
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(req => server.handle(req, callerArn)));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(responses.filter(Boolean)), // filter null (notifications)
    };
  }

  const response = await server.handle(body, callerArn);

  // Notifications (no id) get no response
  if (response === null) {
    return { statusCode: 204, body: '' };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  };
};

function jsonRpcError(code: number, message: string, id: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,  // JSON-RPC errors are still HTTP 200
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id }),
  };
}
```

### `packages/lambda/src/mcp/server.ts`

```typescript
import { MCPTool, MCPResource, MCPRequest, MCPResponse } from './types';

interface MCPServerConfig {
  name: string;
  version: string;
  tools: MCPTool[];
  resources: MCPResource[];
}

export class MCPServer {
  readonly name: string;
  private readonly version: string;
  private readonly toolMap: Map<string, MCPTool>;
  private readonly resourceMap: Map<string, MCPResource>;

  constructor(config: MCPServerConfig) {
    this.name    = config.name;
    this.version = config.version;
    this.toolMap = new Map(config.tools.map(t => [t.name, t]));
    this.resourceMap = new Map(config.resources.map(r => [r.uri, r]));
  }

  async handle(request: unknown, callerArn: string): Promise<MCPResponse | null> {
    const req = request as MCPRequest;

    // Notifications (no id) — fire-and-forget
    if (!('id' in req)) return null;

    try {
      switch (req.method) {
        case 'initialize':
          return this.respond(req.id, {
            protocolVersion: '2024-11-05',
            serverInfo: { name: this.name, version: this.version },
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
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });

        case 'tools/call': {
          const { name, arguments: args } = req.params as { name: string; arguments: unknown };
          const tool = this.toolMap.get(name);
          if (!tool) return this.error(req.id, -32602, `Unknown tool: ${name}`);

          // Validate required args
          const validationError = validateArgs(args, tool.inputSchema);
          if (validationError) return this.error(req.id, -32602, validationError);

          try {
            const result = await tool.execute(args as Record<string, unknown>, callerArn);
            return this.respond(req.id, {
              content: Array.isArray(result) ? result : [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
              isError: false,
            });
          } catch (err) {
            console.error(JSON.stringify({ event: 'tool_error', tool: name, err: String(err), callerArn }));
            return this.respond(req.id, {
              content: [{ type: 'text', text: `Tool error: ${String(err)}` }],
              isError: true,
            });
          }
        }

        case 'resources/list':
          return this.respond(req.id, {
            resources: [...this.resourceMap.values()].map(r => ({
              uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
            })),
          });

        case 'resources/read': {
          const { uri } = req.params as { uri: string };
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

  private respond(id: unknown, result: unknown): MCPResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: unknown, code: number, message: string): MCPResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

function validateArgs(args: unknown, schema: Record<string, unknown>): string | null {
  const required = (schema.required as string[] | undefined) ?? [];
  const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
  for (const field of required) {
    if (!args || typeof args !== 'object' || !(field in (args as object))) {
      return `Missing required argument: ${field}`;
    }
  }
  return null;
}
```

### `packages/lambda/src/mcp/types.ts`

```typescript
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
  execute: (args: Record<string, unknown>, callerArn: string) => Promise<MCPContent[] | string | object>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: (callerArn: string) => Promise<MCPResourceContent[]>;
}

export interface MCPContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType: string;
  text?: string;
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
```

---

## 4. MCP Tools

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

### `packages/lambda/src/mcp/tools/submit-job.ts`

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';
import { MCPTool, MCPContent } from '../types';

const s3  = new S3Client({});
const ssm = new SSMClient({});

export const submitJobTool: MCPTool = {
  name: 'submit_job',
  description: [
    'Submit a skills zip file to be processed by Bedrock Claude.',
    'The zip must contain a manifest.json and one or more .md skill files.',
    'Returns a job ID you can use to check status and retrieve results.',
    'Base64-encode the zip file content before passing it to this tool.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      zip_base64: {
        type: 'string',
        description: 'Base64-encoded content of the skills zip file (max 10MB via MCP)',
      },
      job_name: {
        type: 'string',
        description: 'Human-readable name for this job (max 128 chars)',
      },
      prompt: {
        type: 'string',
        description: 'Optional prompt override. If not set, uses defaultPrompt from manifest.json.',
      },
    },
    required: ['zip_base64', 'job_name'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const zipBase64 = args.zip_base64 as string;
    const jobName   = (args.job_name as string).slice(0, 128);
    const env       = process.env.ENV ?? 'prod';

    // Decode and validate size (10MB limit for MCP — CLI supports 500MB)
    const zipBuffer = Buffer.from(zipBase64, 'base64');
    if (zipBuffer.length > 10 * 1024 * 1024) {
      throw new Error('Zip file exceeds 10MB MCP limit. Use the CLI for larger files.');
    }

    // Validate magic bytes
    if (!zipBuffer.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      throw new Error('Provided content is not a valid ZIP file');
    }

    const bucket = await ssm.send(new GetParameterCommand({
      Name: `/skills-svc/${env}/s3/uploads-bucket`,
    })).then(r => r.Parameter!.Value!);

    const kmsKeyId = await ssm.send(new GetParameterCommand({
      Name: `/skills-svc/${env}/kms/uploads-key-id`,
    })).then(r => r.Parameter!.Value!);

    const s3Key = `uploads/mcp/${randomUUID()}/${jobName.replace(/[^a-zA-Z0-9-]/g, '_')}.zip`;

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: zipBuffer,
      ContentType: 'application/zip',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: kmsKeyId,
      ChecksumAlgorithm: 'SHA256',
      Metadata: {
        'job-name': jobName,
        'user-arn': callerArn,
        'mcp-submitted': 'true',
        ...(args.prompt ? { 'prompt-override': args.prompt as string } : {}),
      },
    }));

    return [{
      type: 'text',
      text: [
        `✅ Job submitted successfully.`,
        ``,
        `Job Name: ${jobName}`,
        `S3 Key:   ${s3Key}`,
        ``,
        `The pipeline has been triggered. Use the \`job_status\` tool to check progress.`,
        `Note: job ID will be available once the ingestion Lambda processes the upload (usually within 5–15 seconds).`,
        ``,
        `Use: list_jobs to find your job ID, then job_status <id> to track it.`,
      ].join('\n'),
    }];
  },
};
```

### `packages/lambda/src/mcp/tools/query.ts`

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
    'Results are scoped to the authenticated user\'s own jobs.',
    'Use this to find prior skill analysis results, reuse past outputs, or discover what skills have been run.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language search query, e.g. "how to classify text" or "eigenvalue computation"',
      },
      top_k: {
        type: 'string',
        description: 'Number of results to return (1–10, default: 5)',
      },
      min_score: {
        type: 'string',
        description: 'Minimum relevance score 0.0–1.0 (default: 0.5)',
      },
    },
    required: ['query'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const queryFnArn = process.env.QUERY_LAMBDA_ARN;
    if (!queryFnArn) throw new Error('QUERY_LAMBDA_ARN not configured');

    const req: QueryRequest = {
      query: args.query as string,
      callerUserArn: callerArn,
      topK: Math.min(parseInt(args.top_k as string ?? '5', 10), 10),
      minScore: parseFloat(args.min_score as string ?? '0.5'),
    };

    const invocation = await lambdaClient.send(new InvokeCommand({
      FunctionName: queryFnArn,
      Payload: JSON.stringify(req),
    }));

    if (invocation.FunctionError) {
      const err = JSON.parse(Buffer.from(invocation.Payload!).toString());
      throw new Error(err.errorMessage ?? 'Query failed');
    }

    const response: QueryResponse = JSON.parse(Buffer.from(invocation.Payload!).toString());

    if (!response.results.length) {
      return [{ type: 'text', text: 'No results found. Try a broader query or lower min_score.' }];
    }

    const formatted = response.results.map((r, i) => [
      `${i + 1}. **${r.jobName}** (score: ${(r.score * 100).toFixed(0)}%)`,
      `   Skills: ${r.skillNames.join(', ')}`,
      `   Date: ${new Date(r.createdAt).toLocaleDateString()}`,
      `   Summary: ${r.resultSummary.slice(0, 300)}${r.resultSummary.length > 300 ? '...' : ''}`,
      `   Job ID: \`${r.jobId}\``,
    ].join('\n')).join('\n\n');

    return [{
      type: 'text',
      text: `Found ${response.results.length} result(s) in ${response.queryDurationMs}ms:\n\n${formatted}`,
    }];
  },
};
```

### `packages/lambda/src/mcp/tools/job-status.ts`

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const jobStatusTool: MCPTool = {
  name: 'job_status',
  description: 'Get the current status and details of a specific job by its ID.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'The UUID job ID returned from submit_job or list_jobs' },
    },
    required: ['job_id'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId = args.job_id as string;
    const tableName = process.env.DYNAMODB_TABLE_NAME!;

    const res = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    if (!res.Item) {
      return [{ type: 'text', text: `Job not found: ${jobId}` }];
    }

    const job = res.Item;

    // Security: ensure the caller owns this job
    if (job.userArn !== callerArn) {
      throw new Error('Access denied: you do not own this job');
    }

    const statusEmoji: Record<string, string> = {
      PENDING: '⏳', RUNNING: '🔄', COMPLETE: '✅', FAILED: '❌',
    };

    const lines = [
      `${statusEmoji[job.status as string] ?? '?'} **${job.jobName}**`,
      ``,
      `Status:   ${job.status}`,
      `Job ID:   ${job.jobId}`,
      `Created:  ${new Date(job.createdAt as string).toLocaleString()}`,
      `Updated:  ${new Date(job.updatedAt as string).toLocaleString()}`,
    ];

    if (job.status === JobStatus.COMPLETE) {
      lines.push(`Result:   Use \`get_result\` with job_id \`${jobId}\` to retrieve the full output`);
    }
    if (job.status === JobStatus.FAILED && job.errorMessage) {
      lines.push(`Error:    ${job.errorMessage}`);
    }
    if (job.status === JobStatus.RUNNING) {
      const elapsed = Math.round((Date.now() - new Date(job.createdAt as string).getTime()) / 1000);
      lines.push(`Elapsed:  ${elapsed}s`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
};
```

### `packages/lambda/src/mcp/tools/list-jobs.ts`

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const listJobsTool: MCPTool = {
  name: 'list_jobs',
  description: 'List your recent jobs, optionally filtered by status. Returns job IDs you can use with job_status or get_result.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Filter by status',
        enum: ['PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'ALL'],
      },
      limit: {
        type: 'string',
        description: 'Max number of jobs to return (1–20, default: 10)',
      },
    },
    required: [],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const status  = (args.status as string | undefined) ?? 'ALL';
    const limit   = Math.min(parseInt(args.limit as string ?? '10', 10), 20);
    const tableName = process.env.DYNAMODB_TABLE_NAME!;

    const queryParams = status === 'ALL'
      ? {
          TableName: tableName,
          IndexName: 'GSI2-User',
          KeyConditionExpression: 'GSI2PK = :user',
          ExpressionAttributeValues: { ':user': `${DDB_KEY_PREFIX.USER}${callerArn}` },
          ScanIndexForward: false,
          Limit: limit,
        }
      : {
          TableName: tableName,
          IndexName: 'GSI1-Status',
          KeyConditionExpression: 'GSI1PK = :status',
          FilterExpression: 'userArn = :user',
          ExpressionAttributeValues: {
            ':status': `${DDB_KEY_PREFIX.STATUS}${status}`,
            ':user': callerArn,
          },
          ScanIndexForward: false,
          Limit: limit,
        };

    const res = await ddb.send(new QueryCommand(queryParams));
    const items = res.Items ?? [];

    if (!items.length) {
      return [{ type: 'text', text: `No jobs found${status !== 'ALL' ? ` with status ${status}` : ''}.` }];
    }

    const rows = items.map(item =>
      `• \`${item.jobId}\` — **${item.jobName}** — ${item.status} — ${new Date(item.createdAt as string).toLocaleDateString()}`
    ).join('\n');

    return [{
      type: 'text',
      text: `Your ${status !== 'ALL' ? status + ' ' : ''}jobs (${items.length}):\n\n${rows}`,
    }];
  },
};
```

### `packages/lambda/src/mcp/tools/get-result.ts`

```typescript
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus, RunResult } from '@skills-svc/shared';
import { envelopeDecrypt } from '@skills-svc/shared/crypto';

const s3  = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const getResultTool: MCPTool = {
  name: 'get_result',
  description: 'Retrieve the full result output of a completed job. Returns the structured JSON output from Bedrock Claude.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'Job ID of a COMPLETE job' },
      summary_only: {
        type: 'string',
        description: 'Return only the result summary (true) or the full output (false). Default: false',
      },
    },
    required: ['job_id'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId       = args.job_id as string;
    const summaryOnly = args.summary_only === 'true';
    const tableName   = process.env.DYNAMODB_TABLE_NAME!;
    const env         = process.env.ENV ?? 'prod';

    const jobRes = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    if (!jobRes.Item) throw new Error(`Job not found: ${jobId}`);
    if (jobRes.Item.userArn !== callerArn) throw new Error('Access denied: you do not own this job');
    if (jobRes.Item.status !== JobStatus.COMPLETE) {
      return [{
        type: 'text',
        text: `Job is not complete yet. Current status: ${jobRes.Item.status}. Use job_status to check progress.`,
      }];
    }

    const resultKey = jobRes.Item.s3ResultKey as string;
    if (!resultKey) throw new Error('Result key not found on job record');

    const bucket = process.env.RESULTS_BUCKET!;
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: resultKey }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of obj.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);

    const raw = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const plain = await envelopeDecrypt(raw, {
      jobId,
      purpose: 'skills-svc-result',
      environment: env,
    });
    const result: RunResult = JSON.parse(plain.toString('utf-8'));

    if (summaryOnly) {
      return [{ type: 'text', text: result.resultSummary }];
    }

    const formatted = [
      `## Result: ${result.jobName}`,
      ``,
      `**Skills analyzed:** ${result.skillNames.join(', ')}`,
      `**Duration:** ${Math.round(result.durationMs / 1000)}s`,
      `**Completed:** ${new Date(result.completedAt).toLocaleString()}`,
      ``,
      `### Output`,
      ``,
      typeof result.output === 'string' && result.output.startsWith('{')
        ? '```json\n' + JSON.stringify(JSON.parse(result.output), null, 2) + '\n```'
        : result.output,
    ].join('\n');

    return [{ type: 'text', text: formatted }];
  },
};
```

### `packages/lambda/src/mcp/tools/cancel-job.ts`

```typescript
import { ECSClient, StopTaskCommand, ListTasksCommand } from '@aws-sdk/client-ecs';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { MCPTool, MCPContent } from '../types';
import { DDB_KEY_PREFIX, JobStatus } from '@skills-svc/shared';

const ecs = new ECSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

export const cancelJobTool: MCPTool = {
  name: 'cancel_job',
  description: 'Cancel a pending or running job. Cannot cancel already-completed or failed jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'Job ID to cancel' },
      reason: { type: 'string', description: 'Reason for cancellation (recorded in audit log)' },
    },
    required: ['job_id'],
  },

  async execute(args, callerArn): Promise<MCPContent[]> {
    const jobId  = args.job_id as string;
    const reason = (args.reason as string | undefined) ?? 'Cancelled via MCP';
    const env    = process.env.ENV ?? 'prod';
    const tableName = process.env.DYNAMODB_TABLE_NAME!;

    const jobRes = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));

    if (!jobRes.Item) throw new Error(`Job not found: ${jobId}`);
    if (jobRes.Item.userArn !== callerArn) throw new Error('Access denied: you do not own this job');

    const status  = jobRes.Item.status as JobStatus;
    const version = jobRes.Item.version as number;

    if (status === JobStatus.COMPLETE || status === JobStatus.FAILED) {
      return [{ type: 'text', text: `Cannot cancel — job is already in terminal state: ${status}` }];
    }

    if (status === JobStatus.RUNNING) {
      const clusterArn = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${env}/ecs/cluster-arn`,
      })).then(r => r.Parameter!.Value!);

      const tasks = await ecs.send(new ListTasksCommand({
        cluster: clusterArn,
        startedBy: `skills-svc-ingestion-${jobId.slice(0, 8)}`,
      }));

      for (const taskArn of tasks.taskArns ?? []) {
        await ecs.send(new StopTaskCommand({ cluster: clusterArn, task: taskArn, reason }));
      }
    }

    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
      UpdateExpression: 'SET #s = :s, updatedAt = :now, #v = :nv, GSI1PK = :gsi, errorMessage = :err',
      ConditionExpression: '#v = :cv',
      ExpressionAttributeNames: { '#s': 'status', '#v': 'version' },
      ExpressionAttributeValues: {
        ':s': JobStatus.FAILED, ':now': new Date().toISOString(),
        ':nv': version + 1, ':cv': version,
        ':gsi': `${DDB_KEY_PREFIX.STATUS}${JobStatus.FAILED}`,
        ':err': `Cancelled via MCP: ${reason}`,
      },
    }));

    return [{ type: 'text', text: `✅ Job \`${jobId}\` cancelled successfully.\nReason: ${reason}` }];
  },
};
```

---

## 5. MCP Resources

### `packages/lambda/src/mcp/resources/index.ts`

```typescript
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MCPResource, MCPResourceContent } from '../types';
import { DDB_KEY_PREFIX } from '@skills-svc/shared';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const jobsResource: MCPResource = {
  uri: 'skills://jobs',
  name: 'My Jobs',
  description: 'All jobs submitted by the authenticated user, newest first',
  mimeType: 'application/json',

  async read(callerArn): Promise<MCPResourceContent[]> {
    const tableName = process.env.DYNAMODB_TABLE_NAME!;
    const res = await ddb.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI2-User',
      KeyConditionExpression: 'GSI2PK = :user',
      ExpressionAttributeValues: { ':user': `${DDB_KEY_PREFIX.USER}${callerArn}` },
      ScanIndexForward: false,
      Limit: 50,
    }));

    const jobs = (res.Items ?? []).map(item => ({
      jobId:     item.jobId,
      jobName:   item.jobName,
      status:    item.status,
      createdAt: item.createdAt,
      skillNames: item.skillNames ?? [],
    }));

    return [{
      uri: 'skills://jobs',
      mimeType: 'application/json',
      text: JSON.stringify(jobs, null, 2),
    }];
  },
};

export const ALL_RESOURCES: MCPResource[] = [jobsResource];
```

---

## 6. Claude Code / Claude Desktop Integration

### MCP Config for Claude Code (`~/.claude/mcp.json`)

```json
{
  "mcpServers": {
    "skills-as-a-service": {
      "transport": {
        "type": "http",
        "url": "https://<api-id>.execute-api.us-east-1.amazonaws.com/mcp",
        "headers": {
          "Authorization": "AWS4-HMAC-SHA256 ..."
        }
      }
    }
  }
}
```

Because API Gateway uses IAM auth (SigV4), the MCP client must sign requests. Add a CLI helper:

### `skills-svc mcp-config` — auto-generate MCP config

```bash
skills-svc mcp-config                    # prints config JSON
skills-svc mcp-config --install          # writes to ~/.claude/mcp.json
skills-svc mcp-config --profile staging  # uses staging profile
```

### `packages/cli/src/commands/mcp-config.ts`

```typescript
import { Command } from 'commander';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';

export function mcpConfigCommand(): Command {
  return new Command('mcp-config')
    .description('Generate MCP server config for Claude Code or Claude Desktop')
    .option('--install', 'Write config to ~/.claude/mcp.json', false)
    .option('--print', 'Print config to stdout (default)', true)
    .action(async (opts: { install: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });

      const mcpEndpoint = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/mcp/endpoint`,
      })).then(r => r.Parameter!.Value!);

      // The MCP client needs to sign requests with SigV4
      // We generate a config that uses the skills-svc assume-role credentials
      const credPath = path.join(os.homedir(), '.skills-svc', 'credentials.json');
      let accessKeyId = '', secretAccessKey = '', sessionToken = '';

      if (existsSync(credPath)) {
        const stored = JSON.parse(readFileSync(credPath, 'utf-8'));
        accessKeyId    = stored.accessKeyId;
        secretAccessKey = stored.secretAccessKey;
        sessionToken   = stored.sessionToken;
      }

      const mcpConfig = {
        mcpServers: {
          'skills-as-a-service': {
            transport: {
              type: 'http',
              url: mcpEndpoint,
              // SigV4 signing — Claude Code supports AWS_* env vars for signing
              // Set these before launching Claude Code:
              //   export AWS_ACCESS_KEY_ID=...
              //   export AWS_SECRET_ACCESS_KEY=...
              //   export AWS_SESSION_TOKEN=...
              //   export AWS_REGION=us-east-1
            },
            env: {
              AWS_ACCESS_KEY_ID:     accessKeyId,
              AWS_SECRET_ACCESS_KEY: secretAccessKey,
              AWS_SESSION_TOKEN:     sessionToken,
              AWS_REGION:            cfg.region,
            },
          },
        },
      };

      const configJson = JSON.stringify(mcpConfig, null, 2);

      if (opts.install) {
        const claudeDir = path.join(os.homedir(), '.claude');
        mkdirSync(claudeDir, { recursive: true });
        const mcpFile = path.join(claudeDir, 'mcp.json');

        // Merge with existing config if present
        let existing: any = { mcpServers: {} };
        if (existsSync(mcpFile)) {
          existing = JSON.parse(readFileSync(mcpFile, 'utf-8'));
        }
        existing.mcpServers['skills-as-a-service'] = mcpConfig.mcpServers['skills-as-a-service'];
        writeFileSync(mcpFile, JSON.stringify(existing, null, 2), { mode: 0o600 });
        console.log(chalk.green(`✓ MCP config written to ${mcpFile}`));
        console.log(chalk.dim('Restart Claude Code to pick up the new MCP server.'));
      } else {
        console.log(configJson);
        console.log(chalk.dim('\nTo install: skills-svc mcp-config --install'));
      }
    });
}
```

---

## 7. New CDK Stack Integration

### Add to `infra/bin/app.ts`

```typescript
import { MCPStack } from '../lib/mcp-stack';

const mcpStack = new MCPStack(app, `SkillsSvc-${envName}-MCP`, {
  env, envName,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  lambdaEnvKey: security.lambdaEnvKey,
  userRole: security.userRole,
  dynamodbTableName: storage.jobsTable.tableName,
  uploadsBucket: storage.uploadsBucket.bucketName,
  resultsBucket: storage.resultsBucket.bucketName,
  uploadsKmsKeyId: security.uploadsBucketKey.keyArn,
  queryLambdaArn: lambdaStack.queryFn.functionArn,
  opensearchEndpoint: '', // populated from SSM at runtime
  jobsTopicArn: messaging.jobsNotificationTopic.topicArn,
  ecsClusterArn: ecsStack.cluster.clusterArn,
});
mcpStack.addDependency(lambdaStack);
mcpStack.addDependency(ecsStack);
```

---

## 8. QA Checks (QA-135 through QA-144)

```typescript
// QA-135: MCP server responds to initialize with correct protocolVersion
test('QA-135: initialize returns protocolVersion 2024-11-05', async () => {
  const server = new MCPServer({ name: 'test', version: '1.0.0', tools: [], resources: [] });
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'arn:test');
  expect((res as any).result.protocolVersion).toBe('2024-11-05');
  expect((res as any).result.serverInfo.name).toBe('test');
});

// QA-136: tools/list returns all 6 tools
test('QA-136: tools/list returns exactly 6 tools', async () => {
  const server = new MCPServer({ name: 'test', version: '1.0.0', tools: ALL_TOOLS, resources: [] });
  const res = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'arn:test');
  expect((res as any).result.tools).toHaveLength(6);
  const names = (res as any).result.tools.map((t: any) => t.name);
  expect(names).toContain('submit_job');
  expect(names).toContain('query_knowledge_store');
  expect(names).toContain('job_status');
  expect(names).toContain('list_jobs');
  expect(names).toContain('get_result');
  expect(names).toContain('cancel_job');
});

// QA-137: tools/call returns error for unknown tool
test('QA-137: tools/call for unknown tool returns JSON-RPC error', async () => {
  const server = new MCPServer({ name: 'test', version: '1.0.0', tools: [], resources: [] });
  const res = await server.handle(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nonexistent', arguments: {} } },
    'arn:test'
  );
  expect((res as any).error.code).toBe(-32602);
  expect((res as any).error.message).toContain('Unknown tool');
});

// QA-138: tools/call validates required arguments
test('QA-138: tools/call rejects missing required argument', async () => {
  const server = new MCPServer({ name: 'test', version: '1.0.0', tools: ALL_TOOLS, resources: [] });
  const res = await server.handle(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'submit_job', arguments: {} } },
    'arn:test'
  );
  expect((res as any).error?.code ?? (res as any).result?.isError ? true : false).toBeTruthy();
});

// QA-139: job_status enforces ownership (callerArn check)
test('QA-139: job_status throws Access denied for wrong user', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({
    Item: { jobId: 'test', status: 'COMPLETE', userArn: 'arn:aws:iam::123:user/alice', jobName: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  });
  process.env.DYNAMODB_TABLE_NAME = 'test-table';

  await expect(jobStatusTool.execute({ job_id: 'test' }, 'arn:aws:iam::123:user/bob'))
    .rejects.toThrow('Access denied');
});

// QA-140: get_result enforces ownership
test('QA-140: get_result throws Access denied for wrong user', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  ddbMock.on(GetCommand).resolves({
    Item: { jobId: 'test', status: 'COMPLETE', userArn: 'arn:aws:iam::123:user/alice', s3ResultKey: 'results/test/result.json.enc' },
  });
  await expect(getResultTool.execute({ job_id: 'test' }, 'arn:aws:iam::123:user/bob'))
    .rejects.toThrow('Access denied');
});

// QA-141: submit_job rejects zip > 10MB via MCP
test('QA-141: submit_job rejects base64-encoded zip > 10MB', async () => {
  const largeZip = Buffer.alloc(11 * 1024 * 1024).toString('base64');
  await expect(submitJobTool.execute({ zip_base64: largeZip, job_name: 'test' }, 'arn:test'))
    .rejects.toThrow('10MB');
});

// QA-142: submit_job rejects non-ZIP content
test('QA-142: submit_job rejects non-ZIP base64 content', async () => {
  const notAZip = Buffer.from('this is not a zip file').toString('base64');
  await expect(submitJobTool.execute({ zip_base64: notAZip, job_name: 'test' }, 'arn:test'))
    .rejects.toThrow(/not a valid ZIP/i);
});

// QA-143: API Gateway WAF rate limit is 500 req/5-min
test('QA-143: WAF rate limit rule is set to 500 requests per IP', () => {
  const { templates } = buildTestApp();
  const acls = templates.mcp.findResources('AWS::WAFv2::WebACL');
  const acl = Object.values(acls)[0] as any;
  const rateRule = acl.Properties.Rules.find((r: any) => r.Name === 'RateLimit');
  expect(rateRule).toBeDefined();
  expect(rateRule.Statement.RateBasedStatement.Limit).toBe(500);
  expect(rateRule.Statement.RateBasedStatement.AggregateKeyType).toBe('IP');
});

// QA-144: mcp-config --install merges with existing ~/.claude/mcp.json
test('QA-144: mcp-config --install merges without overwriting existing servers', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa144-'));
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir);
  fs.writeFileSync(path.join(claudeDir, 'mcp.json'), JSON.stringify({
    mcpServers: { 'other-server': { transport: { type: 'stdio', command: 'node' } } },
  }));

  await runMcpConfig({ install: true, homeDir: tmpDir });

  const result = JSON.parse(fs.readFileSync(path.join(claudeDir, 'mcp.json'), 'utf-8'));
  expect(result.mcpServers['other-server']).toBeDefined();        // preserved
  expect(result.mcpServers['skills-as-a-service']).toBeDefined(); // added
});
```

---

## 9. Summary — New Files

```
packages/lambda/src/
└── mcp/
    ├── handler.ts          Lambda entry point — routes JSON-RPC 2.0
    ├── server.ts           MCPServer class — dispatch + capability negotiation
    ├── types.ts            MCPTool, MCPResource, MCPRequest, MCPResponse
    ├── tools/
    │   ├── index.ts        ALL_TOOLS export
    │   ├── submit-job.ts   Base64 zip upload → S3 → pipeline trigger
    │   ├── query.ts        Natural-language knowledge store search
    │   ├── job-status.ts   DDB GetItem with ownership check
    │   ├── list-jobs.ts    DDB GSI query scoped to caller
    │   ├── get-result.ts   S3 decrypt + format result
    │   └── cancel-job.ts   ECS StopTask + DDB update
    └── resources/
        └── index.ts        skills://jobs resource

packages/cli/src/commands/
└── mcp-config.ts           Generate + install ~/.claude/mcp.json

infra/lib/
└── mcp-stack.ts            API Gateway HTTP API + Lambda + WAF + IAM

infra/bin/app.ts            UPDATED — add MCPStack
```

## New npm dependencies (packages/lambda)

```json
{
  "@aws-sdk/client-wafv2": "^3.600.0"
}
```
