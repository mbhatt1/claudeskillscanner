# Skills as a Service (SaaS) — Specification Part 1: Overview & Architecture

**Version:** 1.0.0  
**Status:** AUTHORITATIVE — drop into Claude Code to implement the full system  
**Parts:** [Part 1: Overview & Architecture] | [Part 2: Lambda & ECS](SPEC-02-lambda-ecs.md) | [Part 3: Knowledge Store & CLI](SPEC-03-knowledge-store-cli.md) | [Part 4: QA Layers 1–50](SPEC-04-qa-layers-1-50.md) | [Part 5: QA Layers 51–100 & Deployment](SPEC-05-qa-layers-51-100-deployment.md)

---

## 1. System Summary

**Skills as a Service** is a fully serverless AWS backend that lets users upload a zip file containing Claude Code skill files (`.md` files + `manifest.json`), automatically run those skills inside an ECS Fargate container, and index the structured results into an OpenSearch Serverless knowledge store. Future Claude Code sessions — or the CLI — can query that knowledge store with natural language.

**User interaction surface:**
- AWS IAM role assumption via CLI
- S3 zip upload (triggering the pipeline)
- SNS notifications (job status updates)
- CLI query interface (natural-language search over results)

**Security posture:** Production-grade. All data encrypted at rest with customer-managed KMS keys. No public subnets. No NAT gateways. No secrets in environment variables. Fully audited via CloudTrail. GuardDuty + Security Hub enabled.

---

## 2. ASCII Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              USER WORKSTATION                                   │
│                                                                                 │
│   $ skills-svc assume-role --role-arn arn:aws:iam::123456789012:role/UserRole   │
│   $ skills-svc upload ./my-skills.zip --job-name "math-helper"                 │
│   $ skills-svc query "how to calculate eigenvalues"                             │
└──────────────────────┬──────────────────────────────────────────┬───────────────┘
                       │ S3 PutObject (upload)                    │ Query results
                       ▼                                          │
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    AWS VPC (private subnets only, 3 AZs)                     │
│                                                                                              │
│  ┌─────────────────┐    S3 Event      ┌──────────────────┐    ┌──────────────────────────┐  │
│  │  S3 Uploads     │ ──────────────▶  │   SQS Ingestion  │    │  S3 Results Bucket       │  │
│  │  Bucket         │  Notification    │   Queue          │    │  (job JSON + artifacts)  │  │
│  │  (KMS encrypted)│                  │   (DLQ: max 3)   │    │  (KMS encrypted)         │  │
│  └─────────────────┘                  └────────┬─────────┘    └──────────────┬───────────┘  │
│                                                │ SQS trigger                 │              │
│                                                ▼                             │ Upload       │
│                                  ┌─────────────────────────┐                 │              │
│                                  │  SkillsIngestionLambda  │                 │              │
│                                  │  - validate zip         │                 │              │
│                                  │  - create DDB job record│                 │              │
│                                  │  - submit ECS task      │                 │              │
│                                  └────────────┬────────────┘                 │              │
│                                               │ ECS RunTask                  │              │
│                                               ▼                              │              │
│                                  ┌─────────────────────────┐                 │              │
│                                  │  ECS Fargate Task       │                 │              │
│                                  │  (skills-runner image)  │                 │              │
│                                  │  1. Download zip from S3│                 │              │
│                                  │  2. Unzip + validate    │                 │              │
│                                  │  3. Run `claude` CLI    │─────────────────┘              │
│                                  │  4. Upload results JSON │                                │
│                                  │  User: 1000 (non-root)  │                                │
│                                  │  ReadOnly rootfs        │                                │
│                                  └────────────┬────────────┘                                │
│                                               │ ECS Task State Change (STOPPED)             │
│                                               │ → EventBridge Rule                          │
│                                               ▼                                             │
│                                  ┌─────────────────────────┐    ┌────────────────────────┐ │
│                                  │ ResultsProcessorLambda  │    │  DynamoDB Jobs Table   │ │
│                                  │  - download result JSON │    │  (single-table design) │ │
│                                  │  - embed via Bedrock    │───▶│  PK=JOB#{id} SK=META  │ │
│                                  │  - index to OpenSearch  │    │  GSI1: by status       │ │
│                                  │  - update DDB status    │    │  GSI2: by user         │ │
│                                  │  - publish SNS notif.   │    │  (KMS encrypted, PITR) │ │
│                                  └────────────┬────────────┘    └────────────────────────┘ │
│                                               │                                             │
│                                               ▼                                             │
│                                  ┌─────────────────────────┐                               │
│                                  │  OpenSearch Serverless  │◀──── CLI query (knn + BM25)   │
│                                  │  Collection (VECTOR)    │                               │
│                                  │  Index: skills-results  │                               │
│                                  │  1536-dim knn_vector    │                               │
│                                  │  (Bedrock Titan embed)  │                               │
│                                  └─────────────────────────┘                               │
│                                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  VPC ENDPOINTS (private DNS, no internet)                                           │   │
│  │  S3(GW) DynamoDB(GW) ECR ECR-Docker CloudWatchLogs SSM SNS SQS SecretsManager      │   │
│  │  XRay BedrockRuntime OpenSearch(AOSS)                                               │   │
│  └─────────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
│  │  COMPLIANCE LAYER                                                                   │   │
│  │  CloudTrail (multi-region, log validation) | Config Recorder | GuardDuty           │   │
│  │  Security Hub | VPC Flow Logs | KMS key rotation (annual)                          │   │
│  └─────────────────────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

                              ┌────────────────────┐
                              │  SNS Notifications │
                              │  Topic → User email│
                              │  or SQS subscriber │
                              └────────────────────┘
```

---

## 3. Monorepo Structure

```
skills-as-a-service/
├── package.json                      # root npm workspaces
├── tsconfig.base.json                # shared TS config (strict: true, target: ES2022)
├── .eslintrc.js                      # strict ESLint (no-floating-promises, etc.)
├── jest.config.ts                    # root Jest config (projects: [...])
├── .nvmrc                            # "20"
├── Makefile                          # targets: build test qa deploy synth lint
├── infra/
│   ├── package.json
│   ├── tsconfig.json
│   ├── cdk.json                      # { "app": "npx ts-node bin/app.ts", "context": {...} }
│   ├── bin/
│   │   └── app.ts                    # CDK App entry — applies all Aspects
│   ├── lib/
│   │   ├── network-stack.ts
│   │   ├── security-stack.ts
│   │   ├── storage-stack.ts
│   │   ├── messaging-stack.ts
│   │   ├── lambda-stack.ts
│   │   ├── ecs-stack.ts
│   │   ├── knowledge-store-stack.ts
│   │   ├── monitoring-stack.ts
│   │   └── compliance-stack.ts
│   ├── test/
│   │   ├── network-stack.test.ts
│   │   ├── security-stack.test.ts
│   │   ├── storage-stack.test.ts
│   │   ├── messaging-stack.test.ts
│   │   ├── lambda-stack.test.ts
│   │   ├── ecs-stack.test.ts
│   │   ├── knowledge-store-stack.test.ts
│   │   ├── monitoring-stack.test.ts
│   │   └── compliance-stack.test.ts
│   └── aspects/
│       ├── no-wildcard-iam.ts        # CDK Aspect: error if Resource: '*' in any IAM policy
│       ├── encryption-enforcer.ts    # CDK Aspect: error if any resource missing KMS
│       └── tagging-enforcer.ts       # CDK Aspect: error if missing required tags
├── packages/
│   ├── shared/
│   │   ├── package.json              # name: "@skills-svc/shared"
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── types.ts              # all TypeScript interfaces + enums
│   │       ├── constants.ts          # SSM param paths, DDB key prefixes, state machine
│   │       └── index.ts
│   ├── lambda/
│   │   ├── package.json              # name: "@skills-svc/lambda"
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── ingestion/
│   │       │   ├── handler.ts        # SQS handler → validate + DDB + ECS submit
│   │       │   ├── validator.ts      # zip structural validation (zip bomb, path traversal)
│   │       │   └── ecs-submitter.ts  # ECS RunTask wrapper
│   │       ├── results-processor/
│   │       │   ├── handler.ts        # EventBridge ECS-stopped handler
│   │       │   └── indexer.ts        # OpenSearch document indexer
│   │       └── __tests__/
│   │           ├── ingestion.test.ts
│   │           └── results-processor.test.ts
│   ├── ecs-runner/
│   │   ├── package.json              # name: "@skills-svc/ecs-runner"
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   ├── .dockerignore
│   │   └── src/
│   │       ├── main.ts               # entrypoint — orchestrates download→extract→run→upload
│   │       ├── downloader.ts         # S3 streaming download
│   │       ├── extractor.ts          # zip extraction + path traversal protection
│   │       ├── runner.ts             # claude CLI invocation (25-min timeout)
│   │       ├── uploader.ts           # S3 result upload
│   │       └── job-status.ts         # DynamoDB status update
│   ├── knowledge-store/
│   │   ├── package.json              # name: "@skills-svc/knowledge-store"
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── client.ts             # OpenSearch Serverless client (SigV4 signed)
│   │       ├── embeddings.ts         # Bedrock Titan embed text v2
│   │       ├── indexer.ts            # PUT document to OpenSearch
│   │       └── searcher.ts           # hybrid knn + BM25 query
│   └── cli/
│       ├── package.json              # name: "@skills-svc/cli", bin: { "skills-svc": ... }
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts              # Commander program entry
│           ├── commands/
│           │   ├── configure.ts      # auto-discover stack outputs
│           │   ├── assume-role.ts    # STS AssumeRole → credentials file
│           │   ├── upload.ts         # S3 PutObject with metadata
│           │   ├── status.ts         # DynamoDB GetItem
│           │   ├── list-jobs.ts      # DynamoDB GSI query
│           │   ├── query.ts          # OpenSearch hybrid search
│           │   ├── results.ts        # S3 GetObject + pretty print
│           │   └── logs.ts           # CloudWatch Logs GetLogEvents
│           └── utils/
│               ├── aws-clients.ts    # credential-aware client factory
│               ├── config.ts         # ~/.skills-svc/config.json read/write
│               └── pretty-print.ts  # chalk + cli-table3 formatters
├── scripts/
│   ├── qa-run-all.sh                 # runs all 100 QA checks, exits non-zero on any failure
│   ├── deploy.sh                     # ordered stack deployment
│   ├── build-push-ecs.sh             # docker build + ECR push
│   └── smoke-test.sh                 # end-to-end smoke (requires deployed infra)
└── .github/
    └── workflows/
        ├── ci.yml                    # PR: build + qa + synth + docker build
        └── deploy.yml                # push to main: deploy staging; tag: deploy prod
```

---

## 4. CDK Stack Dependency Graph

Stacks must be deployed in this exact order. Each depends on all stacks above it.

```
NetworkStack          ← no dependencies
    │
    ▼
SecurityStack         ← NetworkStack (SGs live in VPC)
    │
    ▼
StorageStack          ← SecurityStack (KMS keys for encryption)
    │
    ▼
MessagingStack        ← StorageStack (S3 bucket ARN for notifications)
    │
    ▼
LambdaStack           ← MessagingStack + StorageStack + SecurityStack
ECSStack              ← NetworkStack + SecurityStack + StorageStack  (parallel with LambdaStack)
KnowledgeStoreStack   ← NetworkStack + SecurityStack                 (parallel with above)
    │                 (all three can deploy in parallel once their deps are done)
    ▼
MonitoringStack       ← all above (needs ARNs for alarms)
    │
    ▼
ComplianceStack       ← all above (needs bucket ARNs for CloudTrail)
```

In CDK `bin/app.ts`, express with `stackB.addDependency(stackA)`.

---

## 5. CDK Stack Specifications

### 5.1 `infra/bin/app.ts`

```typescript
import { App, Aspects, Tags } from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';
import { StorageStack } from '../lib/storage-stack';
import { MessagingStack } from '../lib/messaging-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { ECSStack } from '../lib/ecs-stack';
import { KnowledgeStoreStack } from '../lib/knowledge-store-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { ComplianceStack } from '../lib/compliance-stack';
import { NoWildcardIAMAspect } from '../aspects/no-wildcard-iam';
import { EncryptionEnforcerAspect } from '../aspects/encryption-enforcer';
import { TaggingEnforcerAspect } from '../aspects/tagging-enforcer';

const app = new App();
const envName = app.node.tryGetContext('envName') as string ?? 'prod';
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// Apply aspects BEFORE stacks so they validate during synth
Aspects.of(app).add(new NoWildcardIAMAspect());
Aspects.of(app).add(new EncryptionEnforcerAspect());
Aspects.of(app).add(new TaggingEnforcerAspect({
  requiredTags: ['Environment', 'Project', 'CostCenter', 'DataClassification'],
}));

// Apply global tags
Tags.of(app).add('Project', 'skills-as-a-service');
Tags.of(app).add('Environment', envName);
Tags.of(app).add('CostCenter', 'engineering');
Tags.of(app).add('DataClassification', 'confidential');
Tags.of(app).add('ManagedBy', 'cdk');

const network = new NetworkStack(app, `SkillsSvc-${envName}-Network`, { env, envName });
const security = new SecurityStack(app, `SkillsSvc-${envName}-Security`, { env, envName, vpc: network.vpc });
security.addDependency(network);

const storage = new StorageStack(app, `SkillsSvc-${envName}-Storage`, {
  env, envName,
  uploadsBucketKey: security.uploadsBucketKey,
  resultsBucketKey: security.resultsBucketKey,
  dynamodbKey: security.dynamodbKey,
});
storage.addDependency(security);

const messaging = new MessagingStack(app, `SkillsSvc-${envName}-Messaging`, {
  env, envName,
  messagingKey: security.messagingKey,
  uploadsBucket: storage.uploadsBucket,
});
messaging.addDependency(storage);

const lambdaStack = new LambdaStack(app, `SkillsSvc-${envName}-Lambda`, {
  env, envName,
  vpc: network.vpc,
  lambdaSg: network.lambdaSg,
  ingestionQueue: messaging.ingestionQueue,
  ingestionDLQ: messaging.ingestionDLQ,
  resultsDLQ: messaging.resultsDLQ,
  jobsNotificationTopic: messaging.jobsNotificationTopic,
  jobsTable: storage.jobsTable,
  uploadsBucket: storage.uploadsBucket,
  resultsBucket: storage.resultsBucket,
  ingestionLambdaRole: security.ingestionLambdaRole,
  resultsLambdaRole: security.resultsLambdaRole,
  lambdaEnvKey: security.lambdaEnvKey,
});
lambdaStack.addDependency(messaging);

const ecsStack = new ECSStack(app, `SkillsSvc-${envName}-ECS`, {
  env, envName,
  vpc: network.vpc,
  ecsSg: network.ecsSg,
  ecsTaskRole: security.ecsTaskRole,
  ecsExecutionRole: security.ecsExecutionRole,
  ecsLogKey: security.ecsLogKey,
  ecrKey: security.ecrKey,
  uploadsBucket: storage.uploadsBucket,
  resultsBucket: storage.resultsBucket,
});
ecsStack.addDependency(security);

const knowledgeStore = new KnowledgeStoreStack(app, `SkillsSvc-${envName}-KnowledgeStore`, {
  env, envName,
  vpc: network.vpc,
  vpcesg: network.vpcesg,
  opensearchKey: security.opensearchKey,
  resultsLambdaRole: security.resultsLambdaRole,
  ecsTaskRole: security.ecsTaskRole,
  queryLambdaRole: security.queryLambdaRole,
});
knowledgeStore.addDependency(security);

const monitoring = new MonitoringStack(app, `SkillsSvc-${envName}-Monitoring`, {
  env, envName,
  ingestionFn: lambdaStack.ingestionFn,
  resultsProcessorFn: lambdaStack.resultsProcessorFn,
  ingestionDLQ: messaging.ingestionDLQ,
  resultsDLQ: messaging.resultsDLQ,
  alarmTopic: messaging.jobsNotificationTopic,
});
monitoring.addDependency(lambdaStack);
monitoring.addDependency(ecsStack);

const compliance = new ComplianceStack(app, `SkillsSvc-${envName}-Compliance`, {
  env, envName,
  auditKey: security.auditKey,
  uploadsBucket: storage.uploadsBucket,
  resultsBucket: storage.resultsBucket,
});
compliance.addDependency(monitoring);

app.synth();
```

---

### 5.2 `infra/lib/network-stack.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface NetworkStackProps extends cdk.StackProps {
  envName: string;
}

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSg: ec2.SecurityGroup;
  public readonly ecsSg: ec2.SecurityGroup;
  public readonly vpcesg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `skills-svc-${props.envName}`,
      maxAzs: 3,
      natGateways: 0,                          // No NAT — use VPC endpoints only
      subnetConfiguration: [
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // VPC endpoint security group — accepts 443 from lambda and ecs SGs
    this.vpcesg = new ec2.SecurityGroup(this, 'VpceSecurityGroup', {
      vpc: this.vpc,
      description: 'Allow HTTPS from Lambda and ECS to VPC endpoints',
      allowAllOutbound: false,
    });

    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      description: 'Lambda functions security group',
      allowAllOutbound: false,
    });
    this.lambdaSg.addEgressRule(this.vpcesg, ec2.Port.tcp(443), 'HTTPS to VPC endpoints');

    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc,
      description: 'ECS Fargate tasks security group',
      allowAllOutbound: false,
    });
    this.ecsSg.addEgressRule(this.vpcesg, ec2.Port.tcp(443), 'HTTPS to VPC endpoints');

    this.vpcesg.addIngressRule(this.lambdaSg, ec2.Port.tcp(443), 'From Lambda');
    this.vpcesg.addIngressRule(this.ecsSg, ec2.Port.tcp(443), 'From ECS');

    // Gateway endpoints (S3 and DynamoDB) — free, route-table based
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Interface endpoints — all private DNS enabled
    const interfaceEndpoints: [string, ec2.InterfaceVpcEndpointAwsService][] = [
      ['ECR', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['ECRDocker', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['CloudWatchLogs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['SSM', ec2.InterfaceVpcEndpointAwsService.SSM],
      ['SNS', ec2.InterfaceVpcEndpointAwsService.SNS],
      ['SQS', ec2.InterfaceVpcEndpointAwsService.SQS],
      ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ['XRay', ec2.InterfaceVpcEndpointAwsService.XRAY],
      ['BedrockRuntime', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
      ['KMS', ec2.InterfaceVpcEndpointAwsService.KMS],
    ];

    for (const [name, service] of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [this.vpcesg],
      });
    }

    // VPC Flow Logs
    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      trafficType: ec2.FlowLogTrafficType.ALL,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
    });
  }
}
```

---

### 5.3 `infra/lib/security-stack.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface SecurityStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
}

function makeKey(scope: Construct, id: string, alias: string): kms.Key {
  return new kms.Key(scope, id, {
    alias: `alias/skills-svc/${alias}`,
    enableKeyRotation: true,
    keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
    keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
    pendingWindow: cdk.Duration.days(30),
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    description: `skills-as-a-service ${alias} encryption key`,
  });
}

export class SecurityStack extends cdk.Stack {
  // KMS Keys — one per resource type for blast-radius isolation
  public readonly uploadsBucketKey: kms.Key;
  public readonly resultsBucketKey: kms.Key;
  public readonly dynamodbKey: kms.Key;
  public readonly opensearchKey: kms.Key;
  public readonly lambdaEnvKey: kms.Key;
  public readonly ecsLogKey: kms.Key;
  public readonly ecrKey: kms.Key;
  public readonly messagingKey: kms.Key;
  public readonly auditKey: kms.Key;

  // IAM Roles
  public readonly ecsTaskRole: iam.Role;
  public readonly ecsExecutionRole: iam.Role;
  public readonly ingestionLambdaRole: iam.Role;
  public readonly resultsLambdaRole: iam.Role;
  public readonly queryLambdaRole: iam.Role;
  public readonly userRole: iam.Role;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { envName } = props;

    this.uploadsBucketKey = makeKey(this, 'UploadsBucketKey', `${envName}/uploads`);
    this.resultsBucketKey = makeKey(this, 'ResultsBucketKey', `${envName}/results`);
    this.dynamodbKey      = makeKey(this, 'DynamoDBKey',      `${envName}/dynamodb`);
    this.opensearchKey    = makeKey(this, 'OpenSearchKey',    `${envName}/opensearch`);
    this.lambdaEnvKey     = makeKey(this, 'LambdaEnvKey',     `${envName}/lambda-env`);
    this.ecsLogKey        = makeKey(this, 'EcsLogKey',        `${envName}/ecs-logs`);
    this.ecrKey           = makeKey(this, 'EcrKey',           `${envName}/ecr`);
    this.messagingKey     = makeKey(this, 'MessagingKey',     `${envName}/messaging`);
    this.auditKey         = makeKey(this, 'AuditKey',         `${envName}/audit`);

    // ECS Task Role — least privilege for what the container actually needs
    this.ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: `skills-svc-ecs-task-${envName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS Fargate task role for skills runner container',
    });
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadUploadsBucket',
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:HeadObject'],
      resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/*`],
    }));
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteResultsBucket',
      effect: iam.Effect.ALLOW,
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::skills-svc-results-${this.account}-${this.region}/*`],
    }));
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadSSMParams',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'UpdateDDBJobStatus',
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-jobs-${this.account}-${this.region}`],
    }));
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PublishSNS',
      effect: iam.Effect.ALLOW,
      actions: ['sns:Publish'],
      resources: [`arn:aws:sns:${this.region}:${this.account}:skills-svc-jobs-notifications`],
    }));
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DecryptKMS',
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [
        this.uploadsBucketKey.keyArn,
        this.resultsBucketKey.keyArn,
        this.dynamodbKey.keyArn,
        this.messagingKey.keyArn,
      ],
    }));
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeBedrockEmbeddings',
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));
    this.ecsTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayWrite',
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'], // XRay has no resource-level restrictions — document exception
    }));

    // ECS Execution Role — ECR pull + CloudWatch logs
    this.ecsExecutionRole = new iam.Role(this, 'EcsExecutionRole', {
      roleName: `skills-svc-ecs-execution-${envName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });
    this.ecsExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DecryptECR',
      actions: ['kms:Decrypt'],
      resources: [this.ecrKey.keyArn],
    }));

    // Ingestion Lambda Role
    this.ingestionLambdaRole = new iam.Role(this, 'IngestionLambdaRole', {
      roleName: `skills-svc-ingestion-lambda-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/skills-svc-ingestion-*`],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SQSConsume',
      actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:GetQueueAttributes', 'sqs:ChangeMessageVisibility'],
      resources: [`arn:aws:sqs:${this.region}:${this.account}:skills-svc-ingestion`],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3ReadUploads',
      actions: ['s3:GetObject', 's3:HeadObject'],
      resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/*`],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DDBWrite',
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-jobs-${this.account}-${this.region}`],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECSRunTask',
      actions: ['ecs:RunTask'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:task-definition/skills-svc-runner-${envName}:*`],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassECSRoles',
      actions: ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${this.account}:role/skills-svc-ecs-task-${envName}`,
        `arn:aws:iam::${this.account}:role/skills-svc-ecs-execution-${envName}`,
      ],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KMSDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [
        this.uploadsBucketKey.keyArn,
        this.messagingKey.keyArn,
        this.dynamodbKey.keyArn,
        this.lambdaEnvKey.keyArn,
      ],
    }));
    this.ingestionLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayWrite',
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));

    // Results Processor Lambda Role
    this.resultsLambdaRole = new iam.Role(this, 'ResultsLambdaRole', {
      roleName: `skills-svc-results-lambda-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/skills-svc-results-*`],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3ReadResults',
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::skills-svc-results-${this.account}-${this.region}/*`],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DDBUpdate',
      actions: ['dynamodb:UpdateItem', 'dynamodb:GetItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-jobs-${this.account}-${this.region}`],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'OpenSearchIndex',
      actions: ['aoss:APIAccessAll'],
      resources: [`arn:aws:aoss:${this.region}:${this.account}:collection/*`],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockEmbed',
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SNSPublish',
      actions: ['sns:Publish'],
      resources: [`arn:aws:sns:${this.region}:${this.account}:skills-svc-jobs-notifications`],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'KMSDecrypt',
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: [
        this.resultsBucketKey.keyArn,
        this.dynamodbKey.keyArn,
        this.messagingKey.keyArn,
        this.opensearchKey.keyArn,
      ],
    }));
    this.resultsLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'XRayWrite',
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));

    // Query Lambda Role (for CLI → Lambda → OpenSearch query path)
    this.queryLambdaRole = new iam.Role(this, 'QueryLambdaRole', {
      roleName: `skills-svc-query-lambda-${envName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'OpenSearchQuery',
      actions: ['aoss:APIAccessAll'],
      resources: [`arn:aws:aoss:${this.region}:${this.account}:collection/*`],
    }));
    this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockEmbed',
      actions: ['bedrock:InvokeModel'],
      resources: [`arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`],
    }));
    this.queryLambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SSMRead',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));

    // User Role — assumed via CLI
    this.userRole = new iam.Role(this, 'UserRole', {
      roleName: `skills-svc-user-${envName}`,
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Role assumed by CLI users to interact with the skills pipeline',
      maxSessionDuration: cdk.Duration.hours(8),
    });
    this.userRole.addToPolicy(new iam.PolicyStatement({
      sid: 'S3UploadOnly',
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/uploads/*`],
      conditions: {
        StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        Bool: { 'aws:SecureTransport': 'true' },
      },
    }));
    this.userRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DDBReadJobs',
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-jobs-${this.account}-${this.region}`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/skills-svc-jobs-${this.account}-${this.region}/index/*`,
      ],
    }));
    this.userRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeQueryLambda',
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:skills-svc-query-${this.account}`],
    }));
    this.userRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogsRead',
      actions: ['logs:GetLogEvents', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/skills-svc/${envName}/ecs/runner:*`],
    }));
  }
}
```

---

### 5.4 `infra/aspects/no-wildcard-iam.ts`

```typescript
import { IAspect, Annotations } from 'aws-cdk-lib';
import { CfnPolicy, CfnRole, CfnManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { IConstruct } from 'constructs';

const WILDCARD_EXCEPTION_SIDS = new Set(['XRayWrite']); // documented exceptions

export class NoWildcardIAMAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnPolicy || node instanceof CfnRole || node instanceof CfnManagedPolicy) {
      this.checkDocument(node, (node as any).policyDocument ?? (node as any).document);
    }
  }

  private checkDocument(node: IConstruct, doc: any): void {
    if (!doc) return;
    const statements: any[] = doc.Statement ?? doc.statements ?? [];
    for (const stmt of statements) {
      const sid: string = stmt.Sid ?? '';
      if (WILDCARD_EXCEPTION_SIDS.has(sid)) continue; // documented exception
      const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
      for (const r of resources) {
        if (r === '*') {
          Annotations.of(node).addError(
            `[NoWildcardIAM] Statement "${sid}" uses Resource: '*'. ` +
            `Add Sid to WILDCARD_EXCEPTION_SIDS with justification, or use a specific ARN. ` +
            `Node: ${node.node.path}`
          );
        }
      }
    }
  }
}
```

---

### 5.5 `infra/aspects/encryption-enforcer.ts`

```typescript
import { IAspect, Annotations } from 'aws-cdk-lib';
import { CfnBucket } from 'aws-cdk-lib/aws-s3';
import { CfnTable } from 'aws-cdk-lib/aws-dynamodb';
import { CfnQueue } from 'aws-cdk-lib/aws-sqs';
import { CfnTopic } from 'aws-cdk-lib/aws-sns';
import { CfnLogGroup } from 'aws-cdk-lib/aws-logs';
import { IConstruct } from 'constructs';

export class EncryptionEnforcerAspect implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnBucket) {
      const enc = (node as any).bucketEncryption;
      if (!enc?.serverSideEncryptionConfiguration?.[0]?.serverSideEncryptionByDefault?.kmsMasterKeyId) {
        // Access log bucket uses SSE-S3 — skip if name contains 'access-log'
        if (!node.node.id.toLowerCase().includes('accesslog')) {
          Annotations.of(node).addError(
            `[EncryptionEnforcer] S3 Bucket "${node.node.path}" must use KMS encryption.`
          );
        }
      }
    }
    if (node instanceof CfnTable) {
      const sse = (node as any).sseSpecification;
      if (!sse?.sseEnabled || sse?.sseType !== 'KMS') {
        Annotations.of(node).addError(
          `[EncryptionEnforcer] DynamoDB Table "${node.node.path}" must use KMS SSE.`
        );
      }
    }
    if (node instanceof CfnQueue) {
      if (!(node as any).kmsMasterKeyId) {
        Annotations.of(node).addError(
          `[EncryptionEnforcer] SQS Queue "${node.node.path}" must use KMS encryption.`
        );
      }
    }
    if (node instanceof CfnLogGroup) {
      if (!(node as any).kmsKeyId) {
        Annotations.of(node).addError(
          `[EncryptionEnforcer] CloudWatch Log Group "${node.node.path}" must use KMS encryption.`
        );
      }
    }
  }
}
```

---

## 6. Data Flow Sequence (Numbered Steps)

```
 1. User: skills-svc assume-role → writes ~/.skills-svc/credentials.json (mode 0600)
 2. User: skills-svc upload ./skills.zip --job-name "demo"
    → S3 PutObject to uploads-bucket/uploads/{uuid}/skills.zip
    → Metadata: job-name, user-arn, checksum-sha256
 3. S3 → SQS event notification (S3 wraps event in SQS message body)
 4. SQS → SkillsIngestionLambda (batch size 1)
    → DDB PutItem: PK=JOB#{uuid}, status=PENDING, version=0
       ConditionExpression: attribute_not_exists(PK)  [idempotency]
    → ECS RunTask (Fargate, private subnet, no public IP)
    → Lambda returns { batchItemFailures: [] } on success
 5. ECS container starts:
    → SSM GetParameter: anthropic/api-key (SecureString, decrypted)
    → S3 GetObject: download zip to /tmp/workspace/upload.zip (streaming)
    → Validate zip (magic bytes, size, path traversal, manifest.json)
    → Extract to /tmp/workspace/skills/
    → Run: claude --skills-dir /tmp/workspace/skills --output-format json --print "<prompt>"
    → Capture stdout JSON
    → S3 PutObject: results-bucket/results/{jobId}/result.json
    → DDB UpdateItem: status=RUNNING → COMPLETE, version=0→1
 6. ECS task STOPPED → EventBridge rule fires
    → ResultsProcessorLambda invoked
    → Read exit code from event detail
    → If exitCode=0: S3 GetObject result.json
       → Bedrock Titan embed(result.resultSummary)
       → OpenSearch PUT /skills-results/_doc/{jobId}
       → DDB UpdateItem: status=COMPLETE, s3ResultKey=..., version=1→2
       → SNS Publish: { jobId, status: COMPLETE, resultSummary }
    → If exitCode≠0: DDB UpdateItem: status=FAILED, errorMessage=...
       → SNS Publish: { jobId, status: FAILED, errorMessage }
 7. User: skills-svc query "how do I do X"
    → CLI assumes user role (reads credentials file)
    → Lambda InvokeFunction (QueryLambda)
    → Bedrock Titan embed(query)
    → OpenSearch hybrid search (knn + BM25)
    → Return top-K results sorted by score
    → CLI pretty-prints results table

ERROR PATHS:
 - Step 4 fails (invalid zip, ECS submit fails): Lambda returns batchItemFailures → SQS makes message visible again → retried up to 3 times → DLQ
 - Step 5 ECS exits with code 1 → ResultsProcessorLambda sets FAILED
 - Step 6 ResultsProcessorLambda fails → EventBridge retries 2 times → DLQ
```

---

## 7. Key Design Decisions

| Decision | Alternative Considered | Reason Chosen |
|----------|------------------------|---------------|
| No NAT gateway | NAT gateway per AZ | Saves ~$100/month; VPC endpoints provide equivalent access |
| SQS between S3 and Lambda | Direct S3 → Lambda trigger | SQS provides backpressure, DLQ, and retry semantics |
| OpenSearch Serverless | OpenSearch managed cluster | No cluster management, scales to zero cost, AOSS pricing |
| Bedrock Titan embeddings | OpenAI embeddings | No external API key, stays within AWS IAM boundary |
| Single-table DynamoDB | Separate tables | Single-table avoids join overhead, all access patterns via GSIs |
| EventBridge for ECS completion | Lambda polling | Event-driven avoids polling Lambda cost; EventBridge is near-real-time |
| Node.js 20.x Lambda | Python 3.12 | TypeScript throughout monorepo for type-safety + shared types |
| ECS Fargate | Lambda (for running claude) | Claude Code CLI runtime can exceed 15-min Lambda limit |
| SQS batch size 1 | Batch size > 1 | Each zip is independent; batch=1 simplifies error isolation |
| Immutable ECR tags | Mutable `latest` | Immutable tags ensure deployment reproducibility |

---

## 8. SSM Parameter Store Layout

All SSM parameters are written by CDK using `new ssm.StringParameter(this, ...)`. Lambda and ECS containers read them at runtime (cached 5 minutes).

| Parameter Path | Type | Written By | Read By |
|---------------|------|-----------|---------|
| `/skills-svc/{env}/dynamodb/table-name` | String | StorageStack | Lambda, ECS |
| `/skills-svc/{env}/s3/uploads-bucket` | String | StorageStack | Lambda, ECS, CLI |
| `/skills-svc/{env}/s3/results-bucket` | String | StorageStack | Lambda, ECS, CLI |
| `/skills-svc/{env}/sns/jobs-topic-arn` | String | MessagingStack | Lambda, ECS |
| `/skills-svc/{env}/ecs/cluster-arn` | String | ECSStack | Lambda |
| `/skills-svc/{env}/ecs/task-definition-arn` | String | ECSStack | Lambda |
| `/skills-svc/{env}/vpc/private-subnet-ids` | String (comma-sep) | NetworkStack | Lambda |
| `/skills-svc/{env}/vpc/ecs-sg-id` | String | NetworkStack | Lambda |
| `/skills-svc/{env}/opensearch/endpoint` | String | KnowledgeStoreStack | Lambda, CLI |
| `/skills-svc/{env}/opensearch/index-name` | String | KnowledgeStoreStack | Lambda, CLI |
| `/skills-svc/{env}/opensearch/collection-id` | String | KnowledgeStoreStack | Lambda |
| `/skills-svc/{env}/bedrock/embedding-model-id` | String | KnowledgeStoreStack | Lambda, ECS |
| `/skills-svc/{env}/kms/uploads-key-id` | String | SecurityStack | CLI (for upload) |
| `/skills-svc/{env}/kms/results-key-id` | String | SecurityStack | ECS |
| `/skills-svc/{env}/anthropic/api-key` | SecureString | Manual (post-deploy) | ECS |
| `/skills-svc/{env}/lambda/query-function-arn` | String | LambdaStack | CLI |
| `/skills-svc/{env}/ecr/repo-uri` | String | ECSStack | deploy script |
