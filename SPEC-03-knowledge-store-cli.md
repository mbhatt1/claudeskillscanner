# Skills as a Service (SaaS) — Specification Part 3: Knowledge Store & CLI

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | [Part 2](SPEC-02-lambda-ecs.md) | [Part 3: Knowledge Store & CLI] | [Part 4](SPEC-04-qa-layers-1-50.md) | [Part 5](SPEC-05-qa-layers-51-100-deployment.md)

---

## 1. KnowledgeStoreStack (`infra/lib/knowledge-store-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface KnowledgeStoreStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  vpcesg: ec2.SecurityGroup;
  opensearchKey: kms.Key;
  resultsLambdaRole: iam.Role;
  ecsTaskRole: iam.Role;
  queryLambdaRole: iam.Role;
}

export class KnowledgeStoreStack extends cdk.Stack {
  public readonly collectionEndpoint: string;
  public readonly opensearchVpceId: string;

  constructor(scope: Construct, id: string, props: KnowledgeStoreStackProps) {
    super(scope, id, props);

    const { envName } = props;
    const collectionName = `skills-svc-${envName}`;

    // VPC Endpoint for OpenSearch Serverless
    const vpce = new opensearchserverless.CfnVpcEndpoint(this, 'OpenSearchVpce', {
      name: `skills-svc-${envName}-os`,
      vpcId: props.vpc.vpcId,
      subnetIds: props.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }).subnetIds,
      securityGroupIds: [props.vpcesg.securityGroupId],
    });
    this.opensearchVpceId = vpce.attrId;

    // Encryption policy — KMS CMK, not AWS-owned key
    const encPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'EncPolicy', {
      name: `${collectionName}-enc`,
      type: 'encryption',
      policy: JSON.stringify({
        Rules: [{ ResourceType: 'collection', Resource: [`collection/${collectionName}`] }],
        AWSOwnedKey: false,
        KMSKeyARN: props.opensearchKey.keyArn,
      }),
    });

    // Network policy — VPC endpoint access only, no public access
    const netPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'NetPolicy', {
      name: `${collectionName}-net`,
      type: 'network',
      policy: JSON.stringify([{
        Rules: [
          { ResourceType: 'collection', Resource: [`collection/${collectionName}`] },
          { ResourceType: 'dashboard', Resource: [`collection/${collectionName}`] },
        ],
        AllowFromPublic: false,
        SourceVPCEs: [vpce.attrId],
      }]),
    });

    // Data access policy — Lambda roles and ECS task role
    const dataPolicy = new opensearchserverless.CfnAccessPolicy(this, 'DataPolicy', {
      name: `${collectionName}-data`,
      type: 'data',
      policy: JSON.stringify([{
        Rules: [
          {
            ResourceType: 'index',
            Resource: [`index/${collectionName}/*`],
            Permission: [
              'aoss:CreateIndex',
              'aoss:DescribeIndex',
              'aoss:ReadDocument',
              'aoss:WriteDocument',
              'aoss:UpdateDocument',
              'aoss:DeleteDocument',
            ],
          },
          {
            ResourceType: 'collection',
            Resource: [`collection/${collectionName}`],
            Permission: ['aoss:DescribeCollectionItems'],
          },
        ],
        Principal: [
          props.resultsLambdaRole.roleArn,
          props.ecsTaskRole.roleArn,
          props.queryLambdaRole.roleArn,
        ],
        Description: 'Skills SaaS data access for Lambda and ECS roles',
      }]),
    });

    // Collection — VECTORSEARCH type
    const collection = new opensearchserverless.CfnCollection(this, 'Collection', {
      name: collectionName,
      type: 'VECTORSEARCH',
      description: `Skills as a Service knowledge store (${envName})`,
      standbyReplicas: envName === 'prod' ? 'ENABLED' : 'DISABLED',
    });

    // Explicit ordering: encryption policy must be created before collection
    collection.addDependency(encPolicy);
    collection.addDependency(netPolicy);

    this.collectionEndpoint = collection.attrCollectionEndpoint;

    // SSM params
    new ssm.StringParameter(this, 'ParamOSEndpoint', {
      parameterName: `/skills-svc/${envName}/opensearch/endpoint`,
      stringValue: collection.attrCollectionEndpoint,
    });
    new ssm.StringParameter(this, 'ParamOSIndexName', {
      parameterName: `/skills-svc/${envName}/opensearch/index-name`,
      stringValue: `${collectionName}-results`,
    });
    new ssm.StringParameter(this, 'ParamOSCollectionId', {
      parameterName: `/skills-svc/${envName}/opensearch/collection-id`,
      stringValue: collection.attrId,
    });
    new ssm.StringParameter(this, 'ParamBedrockModelId', {
      parameterName: `/skills-svc/${envName}/bedrock/embedding-model-id`,
      stringValue: 'amazon.titan-embed-text-v2:0',
    });
  }
}
```

---

## 2. OpenSearch Index Schema

The index is bootstrapped via a one-time CDK Custom Resource (Lambda) that runs after collection creation. File: `packages/lambda/src/bootstrap-index/handler.ts`.

```json
{
  "settings": {
    "index": {
      "knn": true,
      "knn.algo_param.ef_search": 512,
      "number_of_shards": 5,
      "number_of_replicas": 1,
      "refresh_interval": "5s"
    },
    "analysis": {
      "analyzer": {
        "skills_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "stop", "snowball"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "job_id":          { "type": "keyword" },
      "job_name":        { "type": "text", "analyzer": "skills_analyzer",
                           "fields": { "keyword": { "type": "keyword" } } },
      "user_arn":        { "type": "keyword" },
      "skill_names":     { "type": "keyword" },
      "prompt":          { "type": "text", "analyzer": "english" },
      "result_summary":  { "type": "text", "analyzer": "english" },
      "result_full_text":{ "type": "text", "analyzer": "english", "index_options": "offsets" },
      "result_embedding": {
        "type": "knn_vector",
        "dimension": 1536,
        "method": {
          "name": "hnsw",
          "space_type": "cosine",
          "engine": "faiss",
          "parameters": { "ef_construction": 256, "m": 48 }
        }
      },
      "created_at":    { "type": "date", "format": "strict_date_optional_time" },
      "completed_at":  { "type": "date", "format": "strict_date_optional_time" },
      "tags":          { "type": "keyword" },
      "s3_result_key": { "type": "keyword" },
      "duration_ms":   { "type": "long" },
      "exit_code":     { "type": "integer" },
      "version":       { "type": "integer" }
    }
  }
}
```

---

## 3. Knowledge Store Package

### 3.1 `packages/knowledge-store/package.json`

```json
{
  "name": "@skills-svc/knowledge-store",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.600.0",
    "@aws-sdk/client-ssm": "^3.600.0",
    "@aws-sdk/credential-provider-node": "^3.600.0",
    "@opensearch-project/opensearch": "^2.6.0"
  }
}
```

### 3.2 `packages/knowledge-store/src/client.ts`

```typescript
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

let _client: Client | null = null;

export async function getOpenSearchClient(): Promise<Client> {
  if (_client) return _client;

  const ssm = new SSMClient({ region: process.env.REGION });
  const env = process.env.ENV ?? 'prod';
  const endpoint = await ssm
    .send(new GetParameterCommand({ Name: `/skills-svc/${env}/opensearch/endpoint` }))
    .then(r => r.Parameter!.Value!);

  _client = new Client({
    ...AwsSigv4Signer({
      region: process.env.REGION ?? 'us-east-1',
      service: 'aoss',  // OpenSearch Serverless service name
      getCredentials: defaultProvider(),
    }),
    node: endpoint,
    requestTimeout: 30_000,
    maxRetries: 3,
  });

  return _client;
}

export function resetClient(): void {
  _client = null; // for testing
}
```

### 3.3 `packages/knowledge-store/src/embeddings.ts`

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({ region: process.env.REGION ?? 'us-east-1' });

const MAX_INPUT_CHARS = 25_000; // ~6250 tokens; Titan v2 limit is 8192 tokens

export async function getEmbedding(text: string): Promise<number[]> {
  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: 'amazon.titan-embed-text-v2:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inputText: truncated,
      dimensions: 1536,
      normalize: true,
    }),
  }));

  const body = JSON.parse(Buffer.from(response.body).toString('utf-8')) as {
    embedding: number[];
    inputTextTokenCount: number;
  };

  return body.embedding;
}
```

### 3.4 `packages/knowledge-store/src/indexer.ts`

```typescript
import { getOpenSearchClient } from './client';
import { getEmbedding } from './embeddings';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { RunResult } from '@skills-svc/shared';

const ssm = new SSMClient({ region: process.env.REGION });

async function getIndexName(): Promise<string> {
  const env = process.env.ENV ?? 'prod';
  const res = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${env}/opensearch/index-name`,
  }));
  return res.Parameter!.Value!;
}

export async function indexJobResult(result: RunResult, env: string): Promise<string> {
  const client = await getOpenSearchClient();
  const indexName = await getIndexName();

  const embeddingText = [
    result.jobName,
    result.skillNames.join(' '),
    result.prompt,
    result.resultSummary,
  ].join(' ');

  const embedding = await getEmbedding(embeddingText);

  const document = {
    job_id: result.jobId,
    job_name: result.jobName,
    skill_names: result.skillNames,
    prompt: result.prompt,
    result_summary: result.resultSummary,
    result_full_text: result.output.slice(0, 50_000), // limit stored text
    result_embedding: embedding,
    created_at: new Date().toISOString(),
    completed_at: result.completedAt,
    duration_ms: result.durationMs,
    exit_code: result.exitCode,
    version: 1,
  };

  const response = await client.index({
    index: indexName,
    id: result.jobId,
    body: document,
    refresh: false, // async refresh for performance
  });

  console.log(JSON.stringify({ event: 'indexed', jobId: result.jobId, result: response.body.result }));
  return result.jobId;
}
```

### 3.5 `packages/knowledge-store/src/searcher.ts`

```typescript
import { getOpenSearchClient } from './client';
import { getEmbedding } from './embeddings';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

export interface SearchResult {
  jobId: string;
  jobName: string;
  resultSummary: string;
  score: number;
  createdAt: string;
  s3ResultKey: string;
  skillNames: string[];
}

const ssm = new SSMClient({ region: process.env.REGION });
let _indexName: string | null = null;

async function getIndexName(): Promise<string> {
  if (_indexName) return _indexName;
  const env = process.env.ENV ?? 'prod';
  const res = await ssm.send(new GetParameterCommand({
    Name: `/skills-svc/${env}/opensearch/index-name`,
  }));
  _indexName = res.Parameter!.Value!;
  return _indexName;
}

export async function hybridSearch(
  query: string,
  topK = 5,
  minScore = 0.5,
): Promise<SearchResult[]> {
  const client = await getOpenSearchClient();
  const indexName = await getIndexName();
  const embedding = await getEmbedding(query);

  // OpenSearch hybrid query: reciprocal rank fusion of knn + BM25
  const response = await client.search({
    index: indexName,
    body: {
      size: topK,
      query: {
        hybrid: {
          queries: [
            {
              knn: {
                result_embedding: {
                  vector: embedding,
                  k: topK * 2,
                },
              },
            },
            {
              multi_match: {
                query,
                fields: [
                  'job_name^2',
                  'result_summary^3',
                  'result_full_text^1',
                  'skill_names^1.5',
                  'prompt^1',
                ],
                type: 'best_fields',
                fuzziness: 'AUTO',
              },
            },
          ],
        },
      },
      _source: [
        'job_id', 'job_name', 'result_summary', 'created_at', 's3_result_key', 'skill_names',
      ],
      min_score: minScore,
    },
  });

  const hits = response.body.hits?.hits ?? [];
  return (hits as any[]).map(hit => ({
    jobId: hit._source.job_id as string,
    jobName: hit._source.job_name as string,
    resultSummary: hit._source.result_summary as string,
    score: hit._score as number,
    createdAt: hit._source.created_at as string,
    s3ResultKey: hit._source.s3_result_key as string ?? '',
    skillNames: (hit._source.skill_names as string[]) ?? [],
  }));
}
```

---

## 4. Shared Types Package

### 4.1 `packages/shared/src/types.ts`

```typescript
export enum JobStatus {
  PENDING  = 'PENDING',
  RUNNING  = 'RUNNING',
  COMPLETE = 'COMPLETE',
  FAILED   = 'FAILED',
}

export const DDB_KEY_PREFIX = {
  JOB:    'JOB#',
  STATUS: 'STATUS#',
  USER:   'USER#',
  ETAG:   'ETAG#',
} as const;

// State machine — mathematically defines valid transitions
// Adjacency list: from → allowed-to values
export const STATE_TRANSITIONS: Record<JobStatus, ReadonlyArray<JobStatus>> = {
  [JobStatus.PENDING]:  [JobStatus.RUNNING, JobStatus.FAILED],
  [JobStatus.RUNNING]:  [JobStatus.COMPLETE, JobStatus.FAILED],
  [JobStatus.COMPLETE]: [],
  [JobStatus.FAILED]:   [],
};

export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  return (STATE_TRANSITIONS[from] as JobStatus[]).includes(to);
}

export interface JobRecord {
  PK: string;           // JOB#{jobId}
  SK: string;           // METADATA
  GSI1PK: string;       // STATUS#{status}
  GSI1SK: string;       // CREATED_AT#{iso}
  GSI2PK: string;       // USER#{userArn}
  GSI2SK: string;       // CREATED_AT#{iso}
  jobId: string;
  jobName: string;
  userArn: string;
  status: JobStatus;
  s3Bucket: string;
  s3Key: string;
  s3ETag: string;
  s3ResultKey?: string;
  createdAt: string;    // ISO 8601
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
  idempotencyKey: string;
  version: number;      // optimistic locking counter
  ttl: number;          // Unix epoch seconds
}

export interface ZipManifest {
  jobName: string;
  version: string;
  skills: string[];
  defaultPrompt?: string;
  tags?: Record<string, string>;
}

export interface RunResult {
  jobId: string;
  jobName: string;
  skillNames: string[];
  prompt: string;
  output: string;
  resultSummary: string;
  durationMs: number;
  exitCode: number;
  completedAt: string;
}

export interface SNSJobNotification {
  jobId: string;
  jobName: string;
  status: JobStatus;
  message: string;
  resultSummary?: string;
  s3ResultKey?: string;
  timestamp: string;
}

export interface QueryRequest {
  query: string;
  topK?: number;
  minScore?: number;
  filterByUser?: string;
}

export interface QueryResponse {
  results: SearchResult[];
  queryDurationMs: number;
}

export interface SearchResult {
  jobId: string;
  jobName: string;
  resultSummary: string;
  score: number;
  createdAt: string;
  s3ResultKey: string;
  skillNames: string[];
}
```

---

## 5. CLI Package

### 5.1 `packages/cli/src/index.ts`

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { configureCommand }  from './commands/configure';
import { assumeRoleCommand } from './commands/assume-role';
import { uploadCommand }     from './commands/upload';
import { statusCommand }     from './commands/status';
import { listJobsCommand }   from './commands/list-jobs';
import { queryCommand }      from './commands/query';
import { resultsCommand }    from './commands/results';
import { logsCommand }       from './commands/logs';

const program = new Command();

program
  .name('skills-svc')
  .description('Skills as a Service CLI — upload skills, run them on AWS, query results')
  .version('1.0.0');

program.addCommand(configureCommand());
program.addCommand(assumeRoleCommand());
program.addCommand(uploadCommand());
program.addCommand(statusCommand());
program.addCommand(listJobsCommand());
program.addCommand(queryCommand());
program.addCommand(resultsCommand());
program.addCommand(logsCommand());

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
```

### 5.2 `packages/cli/src/commands/assume-role.ts`

```typescript
import { Command } from 'commander';
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

const CREDS_DIR = path.join(os.homedir(), '.skills-svc');
const CREDS_FILE = path.join(CREDS_DIR, 'credentials.json');

export interface StoredCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
  roleArn: string;
  sessionName: string;
}

export function assumeRoleCommand(): Command {
  return new Command('assume-role')
    .description('Assume the skills-svc IAM role and store temporary credentials')
    .requiredOption('--role-arn <arn>', 'IAM Role ARN to assume')
    .option('--session-name <name>', 'Session name', `skills-svc-${Date.now()}`)
    .option('--duration-seconds <seconds>', 'Credential duration (max 43200)', '3600')
    .action(async (opts: { roleArn: string; sessionName: string; durationSeconds: string }) => {
      const sts = new STSClient({});

      const durationSecs = parseInt(opts.durationSeconds, 10);
      if (isNaN(durationSecs) || durationSecs < 900 || durationSecs > 43200) {
        console.error(chalk.red('--duration-seconds must be between 900 and 43200'));
        process.exit(1);
      }

      console.log(chalk.blue(`Assuming role: ${opts.roleArn}`));

      const res = await sts.send(new AssumeRoleCommand({
        RoleArn: opts.roleArn,
        RoleSessionName: opts.sessionName,
        DurationSeconds: durationSecs,
      }));

      const creds = res.Credentials!;
      const stored: StoredCredentials = {
        accessKeyId: creds.AccessKeyId!,
        secretAccessKey: creds.SecretAccessKey!,
        sessionToken: creds.SessionToken!,
        expiration: creds.Expiration!.toISOString(),
        roleArn: opts.roleArn,
        sessionName: opts.sessionName,
      };

      mkdirSync(CREDS_DIR, { recursive: true });
      writeFileSync(CREDS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });

      console.log(chalk.green(`✓ Credentials stored to ${CREDS_FILE}`));
      console.log(`  Expires: ${stored.expiration}`);
      console.log(`  Session: ${opts.sessionName}`);
    });
}
```

### 5.3 `packages/cli/src/commands/upload.ts`

```typescript
import { Command } from 'commander';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { readFileSync, statSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { prettyTable } from '../utils/pretty-print';
import chalk from 'chalk';

const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB

export function uploadCommand(): Command {
  return new Command('upload')
    .description('Upload a skills zip file to start a processing job')
    .argument('<zip-path>', 'Path to the skills zip file')
    .requiredOption('--job-name <name>', 'Human-readable job name (max 128 chars)')
    .option('--tags <tags>', 'Comma-separated key=value tags (e.g. team=ml,env=test)')
    .action(async (zipPath: string, opts: { jobName: string; tags?: string }) => {
      const cfg = await loadConfig();
      const credProvider = await getCredentialProvider();
      const s3 = new S3Client({ region: cfg.region, credentials: credProvider });
      const sts = new STSClient({ region: cfg.region, credentials: credProvider });

      // Validate file
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(zipPath);
      } catch {
        console.error(chalk.red(`File not found: ${zipPath}`));
        process.exit(1);
      }

      if (stat.size > MAX_FILE_BYTES) {
        console.error(chalk.red(`File size ${(stat.size / 1024 / 1024).toFixed(1)}MB exceeds 500MB limit`));
        process.exit(1);
      }

      if (!zipPath.endsWith('.zip')) {
        console.error(chalk.red('File must have .zip extension'));
        process.exit(1);
      }

      if (opts.jobName.length > 128) {
        console.error(chalk.red('--job-name must be 128 characters or fewer'));
        process.exit(1);
      }

      const identity = await sts.send(new GetCallerIdentityCommand({}));
      const s3Key = `uploads/${randomUUID()}/${path.basename(zipPath)}`;

      const tagMetadata: Record<string, string> = {};
      if (opts.tags) {
        for (const pair of opts.tags.split(',')) {
          const [k, v] = pair.trim().split('=');
          if (k && v) tagMetadata[`tag-${k}`] = v;
        }
      }

      console.log(chalk.blue(`Uploading ${path.basename(zipPath)} (${(stat.size / 1024 / 1024).toFixed(2)} MB)...`));

      await s3.send(new PutObjectCommand({
        Bucket: cfg.uploadsBucket,
        Key: s3Key,
        Body: readFileSync(zipPath),
        ContentType: 'application/zip',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: cfg.uploadsKmsKeyId,
        ChecksumAlgorithm: 'SHA256',
        Metadata: {
          'job-name': opts.jobName,
          'user-arn': identity.Arn!,
          ...tagMetadata,
        },
      }));

      prettyTable([
        ['Field', 'Value'],
        ['Status', chalk.yellow('PENDING — job submitted')],
        ['S3 Key', s3Key],
        ['Job Name', opts.jobName],
        ['File Size', `${(stat.size / 1024 / 1024).toFixed(2)} MB`],
        ['Uploaded By', identity.Arn!],
      ]);

      console.log(`\nTrack progress: ${chalk.cyan(`skills-svc list-jobs --status PENDING`)}`);
    });
}
```

### 5.4 `packages/cli/src/commands/query.ts`

```typescript
import { Command } from 'commander';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { prettySearchResults } from '../utils/pretty-print';
import { QueryRequest, QueryResponse } from '@skills-svc/shared';
import chalk from 'chalk';

export function queryCommand(): Command {
  return new Command('query')
    .description('Query the knowledge store with a natural-language question')
    .argument('<question>', 'Natural-language query (e.g. "how to compute eigenvalues")')
    .option('--top-k <n>', 'Number of results to return', '5')
    .option('--min-score <n>', 'Minimum relevance score 0-1', '0.5')
    .option('--format <fmt>', 'Output format: table|json|pretty', 'pretty')
    .action(async (question: string, opts: { topK: string; minScore: string; format: string }) => {
      const cfg = await loadConfig();
      const credProvider = await getCredentialProvider();
      const lambdaClient = new LambdaClient({ region: cfg.region, credentials: credProvider });

      const req: QueryRequest = {
        query: question,
        topK: parseInt(opts.topK, 10),
        minScore: parseFloat(opts.minScore),
      };

      console.log(chalk.blue(`Searching knowledge store for: "${question}"...`));

      const invocation = await lambdaClient.send(new InvokeCommand({
        FunctionName: cfg.queryLambdaArn,
        Payload: JSON.stringify(req),
        LogType: 'None',
      }));

      if (invocation.FunctionError) {
        const errPayload = invocation.Payload
          ? JSON.parse(Buffer.from(invocation.Payload).toString())
          : {};
        console.error(chalk.red(`Query failed: ${errPayload.errorMessage ?? 'Unknown error'}`));
        process.exit(1);
      }

      const response: QueryResponse = JSON.parse(Buffer.from(invocation.Payload!).toString());

      if (response.results.length === 0) {
        console.log(chalk.yellow('No results found. Try a broader query or lower --min-score.'));
        return;
      }

      if (opts.format === 'json') {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      prettySearchResults(response.results);
      console.log(chalk.dim(`\nQuery completed in ${response.queryDurationMs}ms`));
    });
}
```

### 5.5 `packages/cli/src/commands/status.ts`

```typescript
import { Command } from 'commander';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { JobRecord, DDB_KEY_PREFIX } from '@skills-svc/shared';
import { prettyTable, prettyJobStatus } from '../utils/pretty-print';
import chalk from 'chalk';

export function statusCommand(): Command {
  return new Command('status')
    .description('Get the status of a specific job')
    .argument('<job-id>', 'Job ID (UUID)')
    .action(async (jobId: string) => {
      const cfg = await loadConfig();
      const credProvider = await getCredentialProvider();
      const ddb = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: cfg.region, credentials: credProvider })
      );

      const res = await ddb.send(new GetCommand({
        TableName: cfg.dynamodbTableName,
        Key: {
          PK: `${DDB_KEY_PREFIX.JOB}${jobId}`,
          SK: 'METADATA',
        },
      }));

      if (!res.Item) {
        console.error(chalk.red(`Job not found: ${jobId}`));
        process.exit(1);
      }

      const job = res.Item as JobRecord;
      prettyTable([
        ['Field', 'Value'],
        ['Job ID', job.jobId],
        ['Job Name', job.jobName],
        ['Status', prettyJobStatus(job.status)],
        ['Created', new Date(job.createdAt).toLocaleString()],
        ['Updated', new Date(job.updatedAt).toLocaleString()],
        ['User ARN', job.userArn],
        ['S3 Key', job.s3Key],
        ['Result Key', job.s3ResultKey ?? 'N/A'],
        ['Error', job.errorMessage ?? 'N/A'],
      ]);
    });
}
```

### 5.6 `packages/cli/src/commands/list-jobs.ts`

```typescript
import { Command } from 'commander';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { JobStatus, DDB_KEY_PREFIX, JobRecord } from '@skills-svc/shared';
import { prettyTable, prettyJobStatus } from '../utils/pretty-print';
import chalk from 'chalk';

export function listJobsCommand(): Command {
  return new Command('list-jobs')
    .description('List jobs, optionally filtered by status')
    .option('--status <status>', 'Filter by status: PENDING|RUNNING|COMPLETE|FAILED')
    .option('--limit <n>', 'Max results', '20')
    .action(async (opts: { status?: string; limit: string }) => {
      const cfg = await loadConfig();
      const credProvider = await getCredentialProvider();
      const ddb = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: cfg.region, credentials: credProvider })
      );

      const limit = Math.min(parseInt(opts.limit, 10), 100);

      if (opts.status && !Object.values(JobStatus).includes(opts.status as JobStatus)) {
        console.error(chalk.red(`Invalid status: ${opts.status}. Must be one of: ${Object.values(JobStatus).join(', ')}`));
        process.exit(1);
      }

      let items: JobRecord[];

      if (opts.status) {
        const res = await ddb.send(new QueryCommand({
          TableName: cfg.dynamodbTableName,
          IndexName: 'GSI1-Status',
          KeyConditionExpression: 'GSI1PK = :gsi1pk',
          ExpressionAttributeValues: {
            ':gsi1pk': `${DDB_KEY_PREFIX.STATUS}${opts.status}`,
          },
          ScanIndexForward: false, // newest first
          Limit: limit,
        }));
        items = (res.Items ?? []) as JobRecord[];
      } else {
        // Scan is acceptable here — this is a CLI tool with low QPS
        console.log(chalk.yellow('Tip: use --status to filter results efficiently'));
        items = []; // For brevity — implement GSI2 user-based query in practice
      }

      if (items.length === 0) {
        console.log(chalk.yellow('No jobs found.'));
        return;
      }

      prettyTable([
        ['Job ID', 'Name', 'Status', 'Created', 'Duration'],
        ...items.map(j => [
          j.jobId.slice(0, 8) + '...',
          j.jobName,
          prettyJobStatus(j.status),
          new Date(j.createdAt).toLocaleString(),
          j.completedAt
            ? `${Math.round((new Date(j.completedAt).getTime() - new Date(j.createdAt).getTime()) / 1000)}s`
            : 'running...',
        ]),
      ]);
    });
}
```

### 5.7 `packages/cli/src/utils/config.ts`

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.skills-svc');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  region: string;
  accountId: string;
  envName: string;
  uploadsBucket: string;
  resultsBucket: string;
  uploadsKmsKeyId: string;
  jobsTopicArn: string;
  opensearchEndpoint: string;
  queryLambdaArn: string;
  dynamodbTableName: string;
}

export async function loadConfig(): Promise<CliConfig> {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `Config not found. Run: skills-svc configure --region us-east-1 --account <ACCOUNT_ID>`
    );
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as CliConfig;
}

export function saveConfig(cfg: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
```

### 5.8 `packages/cli/src/utils/pretty-print.ts`

```typescript
import Table from 'cli-table3';
import chalk from 'chalk';
import { JobStatus, SearchResult } from '@skills-svc/shared';

export function prettyTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const [headers, ...body] = rows;
  const table = new Table({
    head: headers.map(h => chalk.bold.cyan(h)),
    style: { head: [], border: ['grey'] },
  });
  body.forEach(row => table.push(row));
  console.log(table.toString());
}

export function prettyJobStatus(status: JobStatus): string {
  switch (status) {
    case JobStatus.PENDING:  return chalk.yellow('⏳ PENDING');
    case JobStatus.RUNNING:  return chalk.blue('🔄 RUNNING');
    case JobStatus.COMPLETE: return chalk.green('✅ COMPLETE');
    case JobStatus.FAILED:   return chalk.red('❌ FAILED');
    default: return status;
  }
}

export function prettySearchResults(results: SearchResult[]): void {
  console.log(chalk.bold(`\nFound ${results.length} result${results.length !== 1 ? 's' : ''}:\n`));

  results.forEach((r, i) => {
    const scoreBar = scoreToBar(r.score);
    console.log(chalk.bold(`${i + 1}. ${r.jobName}`));
    console.log(`   Score: ${scoreBar} ${(r.score * 100).toFixed(1)}%`);
    console.log(`   Skills: ${chalk.cyan(r.skillNames.join(', '))}`);
    console.log(`   Date:   ${new Date(r.createdAt).toLocaleString()}`);
    console.log(`   Summary: ${chalk.dim(r.resultSummary.slice(0, 200))}${r.resultSummary.length > 200 ? '...' : ''}`);
    console.log(`   Job ID: ${chalk.dim(r.jobId)}`);
    console.log();
  });
}

function scoreToBar(score: number): string {
  const filled = Math.round(score * 10);
  return chalk.green('█'.repeat(filled)) + chalk.grey('░'.repeat(10 - filled));
}

export function prettyJson(obj: unknown): void {
  const json = JSON.stringify(obj, null, 2);
  // Syntax-highlight keys and values
  const highlighted = json
    .replace(/"([^"]+)":/g, chalk.cyan('"$1"') + ':')
    .replace(/: "([^"]+)"/g, ': ' + chalk.green('"$1"'))
    .replace(/: (\d+)/g, ': ' + chalk.yellow('$1'))
    .replace(/: (true|false)/g, ': ' + chalk.magenta('$1'))
    .replace(/: null/g, ': ' + chalk.grey('null'));
  console.log(highlighted);
}
```

### 5.9 `packages/cli/src/utils/aws-clients.ts`

```typescript
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StoredCredentials } from '../commands/assume-role';
import { AwsCredentialIdentity, Provider } from '@aws-sdk/types';
import chalk from 'chalk';

const CREDS_FILE = path.join(os.homedir(), '.skills-svc', 'credentials.json');
const WARN_BEFORE_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

export async function getCredentialProvider(): Promise<AwsCredentialIdentity | Provider<AwsCredentialIdentity>> {
  if (!existsSync(CREDS_FILE)) {
    // Fall back to default credential chain (env vars, ~/.aws/credentials, instance metadata)
    return undefined as any; // AWS SDK uses default provider when undefined
  }

  const stored: StoredCredentials = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  const expiry = new Date(stored.expiration);
  const now = new Date();

  if (expiry <= now) {
    console.error(chalk.red(`Credentials expired at ${expiry.toLocaleString()}`));
    console.error(chalk.red(`Run: skills-svc assume-role --role-arn ${stored.roleArn}`));
    process.exit(1);
  }

  if (expiry.getTime() - now.getTime() < WARN_BEFORE_EXPIRY_MS) {
    console.warn(chalk.yellow(
      `⚠ Credentials expire in ${Math.round((expiry.getTime() - now.getTime()) / 60000)} minutes. ` +
      `Re-run: skills-svc assume-role --role-arn ${stored.roleArn}`
    ));
  }

  return {
    accessKeyId: stored.accessKeyId,
    secretAccessKey: stored.secretAccessKey,
    sessionToken: stored.sessionToken,
  };
}
```

---

## 6. MonitoringStack (`infra/lib/monitoring-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

interface MonitoringStackProps extends cdk.StackProps {
  envName: string;
  ingestionFn: lambda.Function;
  resultsProcessorFn: lambda.Function;
  ingestionDLQ: sqs.Queue;
  resultsDLQ: sqs.Queue;
  alarmTopic: sns.Topic;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { envName } = props;
    const alarmAction = new cloudwatchActions.SnsAction(props.alarmTopic);

    const alarms: cloudwatch.Alarm[] = [];

    // Lambda error alarms
    for (const [name, fn] of [
      ['IngestionLambda', props.ingestionFn],
      ['ResultsProcessorLambda', props.resultsProcessorFn],
    ] as [string, lambda.Function][]) {
      const alarm = new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        alarmName: `skills-svc-${envName}-${name.toLowerCase()}-errors`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} error count >= 1`,
      });
      alarm.addAlarmAction(alarmAction);
      alarms.push(alarm);
    }

    // DLQ depth alarms
    for (const [name, queue] of [
      ['IngestionDLQ', props.ingestionDLQ],
      ['ResultsDLQ', props.resultsDLQ],
    ] as [string, sqs.Queue][]) {
      const alarm = new cloudwatch.Alarm(this, `${name}DepthAlarm`, {
        alarmName: `skills-svc-${envName}-${name.toLowerCase()}-depth`,
        metric: queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} has messages — potential processing failure`,
      });
      alarm.addAlarmAction(alarmAction);
      alarms.push(alarm);
    }

    // ECS task failure alarm (custom metric)
    const ecsFailureAlarm = new cloudwatch.Alarm(this, 'EcsTaskFailureAlarm', {
      alarmName: `skills-svc-${envName}-ecs-task-failures`,
      metric: new cloudwatch.Metric({
        namespace: 'skills-svc/ECS',
        metricName: 'TaskFailures',
        dimensionsMap: { Environment: envName },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    ecsFailureAlarm.addAlarmAction(alarmAction);
    alarms.push(ecsFailureAlarm);

    // Dashboard
    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'SkillsSaaSDashboard',
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Lambda Invocations & Errors',
            left: [
              props.ingestionFn.metricInvocations(),
              props.resultsProcessorFn.metricInvocations(),
            ],
            right: [
              props.ingestionFn.metricErrors(),
              props.resultsProcessorFn.metricErrors(),
            ],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'Lambda Duration p50/p95/p99',
            left: [
              props.ingestionFn.metricDuration({ statistic: 'p50' }),
              props.ingestionFn.metricDuration({ statistic: 'p95' }),
              props.ingestionFn.metricDuration({ statistic: 'p99' }),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'DLQ Depths',
            left: [
              props.ingestionDLQ.metricApproximateNumberOfMessagesVisible(),
              props.resultsDLQ.metricApproximateNumberOfMessagesVisible(),
            ],
            width: 12,
          }),
          new cloudwatch.AlarmStatusWidget({
            title: 'Alarm Status',
            alarms,
            width: 12,
          }),
        ],
      ],
    });
  }
}
```

---

## 7. ComplianceStack (`infra/lib/compliance-stack.ts`)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as config from 'aws-cdk-lib/aws-config';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ComplianceStackProps extends cdk.StackProps {
  envName: string;
  auditKey: kms.Key;
  uploadsBucket: s3.Bucket;
  resultsBucket: s3.Bucket;
}

export class ComplianceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ComplianceStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // Audit log bucket — separate from data buckets
    const auditLogBucket = new s3.Bucket(this, 'AuditLogBucket', {
      bucketName: `skills-svc-audit-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // CloudTrail requires S3-managed or KMS
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{
        id: 'audit-retention',
        expiration: cdk.Duration.days(2555), // 7 years for compliance
      }],
    });

    // CloudTrail — multi-region, log file validation
    const trail = new cloudtrail.Trail(this, 'AuditTrail', {
      trailName: `skills-svc-audit-${envName}`,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      encryptionKey: props.auditKey,
      bucket: auditLogBucket,
      sendToCloudWatchLogs: true,
      cloudWatchLogsRetention: logs.RetentionDays.THREE_YEARS,
    });

    // Add specific data events for our S3 buckets
    trail.addS3EventSelector([
      { bucket: props.uploadsBucket },
      { bucket: props.resultsBucket },
    ], {
      readWriteType: cloudtrail.ReadWriteType.ALL,
      includeManagementEvents: true,
    });

    // AWS Config — record all supported resource types
    const configRole = new config.ManagedRule(this, 'S3BucketPublicAccessProhibited', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_WRITE_PROHIBITED,
      ruleScope: config.RuleScope.fromResources([config.ResourceType.S3_BUCKET]),
    });

    new config.ManagedRule(this, 'S3BucketSSLRequestsOnly', {
      identifier: config.ManagedRuleIdentifiers.S3_BUCKET_SSL_REQUESTS_ONLY,
      ruleScope: config.RuleScope.fromResources([config.ResourceType.S3_BUCKET]),
    });

    new config.ManagedRule(this, 'EncryptedVolumes', {
      identifier: config.ManagedRuleIdentifiers.ENCRYPTED_VOLUMES,
    });

    new config.ManagedRule(this, 'KMSKeyRotationEnabled', {
      identifier: config.ManagedRuleIdentifiers.CMK_BACKING_KEY_ROTATION_ENABLED,
    });

    new config.ManagedRule(this, 'IAMPasswordPolicy', {
      identifier: config.ManagedRuleIdentifiers.IAM_PASSWORD_POLICY,
    });

    new config.ManagedRule(this, 'DynamoDBPITREnabled', {
      identifier: config.ManagedRuleIdentifiers.DYNAMODB_PITR_ENABLED,
      ruleScope: config.RuleScope.fromResources([config.ResourceType.DYNAMODB_TABLE]),
    });

    // GuardDuty
    new guardduty.CfnDetector(this, 'GuardDutyDetector', {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
      features: [
        { name: 'S3_DATA_EVENTS', status: 'ENABLED' },
        { name: 'EKS_AUDIT_LOGS', status: 'ENABLED' },
        { name: 'RDS_LOGIN_EVENTS', status: 'ENABLED' },
        { name: 'LAMBDA_NETWORK_LOGS', status: 'ENABLED' },
      ],
    });

    // Security Hub
    new securityhub.CfnHub(this, 'SecurityHub', {
      autoEnableControls: true,
      controlFindingGenerator: 'SECURITY_CONTROL',
    });
  }
}
```

---

## 8. DynamoDB Access Patterns Reference

| Pattern | PK | SK | Index | Operation |
|---------|----|----|-------|-----------|
| Get job by ID | `JOB#{jobId}` | `METADATA` | — | `GetItem` |
| Update job status | `JOB#{jobId}` | `METADATA` | — | `UpdateItem` + `version = N` |
| List jobs by status | `STATUS#{status}` | — | GSI1 | `Query` on `GSI1PK` |
| List jobs by user | `USER#{userArn}` | — | GSI2 | `Query` on `GSI2PK` |
| Idempotency check | `JOB#{jobId}` | `METADATA` | — | `GetItem` → check `idempotencyKey` |

**Optimistic locking UpdateItem (full expression):**

```typescript
await ddb.send(new UpdateCommand({
  TableName: tableName,
  Key: { PK: `JOB#${jobId}`, SK: 'METADATA' },
  UpdateExpression:
    'SET #status = :status, updatedAt = :now, #ver = :newVer, GSI1PK = :gsi1pk',
  ConditionExpression: '#ver = :curVer',
  ExpressionAttributeNames: {
    '#status': 'status',
    '#ver': 'version',
  },
  ExpressionAttributeValues: {
    ':status': newStatus,
    ':now': new Date().toISOString(),
    ':newVer': currentVersion + 1,
    ':curVer': currentVersion,
    ':gsi1pk': `STATUS#${newStatus}`,
  },
}));
```
