/**
 * code-review-stack.ts — CodeReviewStack
 *
 * Changes vs. the SPEC-25 baseline:
 *
 * GAP 3 fix — GSI4 on sourceRef:
 *   A new GSI (GSI4-SourceRef) on the findings table allows efficient lookup
 *   of all review records for a given git ref / commit SHA.
 *   Attributes: GSI4PK = SOURCEREF#{sourceRef}, GSI4SK = PKG#{packageName}
 *
 * GAP 3 fix — DDB write permission for COMMIT# markers:
 *   WebhookLambdaRole already has PutItem via the existing DDB policy; we
 *   extend it to cover the findings table ARN (previously the table did not
 *   exist at IAM-binding time — now we bind explicitly).
 *
 * GAP 6 fix — no additional table needed:
 *   Cooldown records (PK=WEBHOOK#COOLDOWN#...) are written to the SAME
 *   findings table — they share the PAY_PER_REQUEST billing and the existing
 *   TTL attribute.  No extra table, no extra CloudFormation resource.
 *   The Lambda role receives DynamoDB:PutItem + GetItem on the findings table.
 */

import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface CodeReviewStackProps extends cdk.StackProps {
  envName: string;
  vpc: ec2.Vpc;
  lambdaSg: ec2.SecurityGroup;
  dynamodbKey: kms.Key;
  lambdaEnvKey: kms.Key;
  uploadsBucket: string;
  ecsClusterArn: string;
  ecsTaskDefArn: string;
  ingestionQueueUrl: string;
}

export class CodeReviewStack extends cdk.Stack {
  public readonly findingsTable: dynamodb.Table;
  public readonly webhookFn: lambda.Function;
  public readonly webhookApi: apigatewayv2.HttpApi;

  constructor(scope: Construct, id: string, props: CodeReviewStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // ── Findings DynamoDB Table ───────────────────────────────────────────────
    //
    // Schema (primary + GSIs):
    //   PK  = PKG#{packageName}#{packageVersion}   (findings)
    //       | PKG#{packageName}                    (COMMIT# idempotency markers)
    //       | WEBHOOK#COOLDOWN#{sha256hash}        (GAP 6 cooldown records)
    //   SK  = FINDING#{findingId}                  (findings)
    //       | COMMIT#{commitSha}                   (idempotency markers)
    //       | TS                                   (cooldown records)
    //
    //   GSI1: PKG+severity   GSI1PK = PKG#name#ver#SEV#sev, GSI1SK = CREATED_AT#iso
    //   GSI2: CWE across pkgs  GSI2PK = CWE#{cweId},          GSI2SK = CREATED_AT#iso
    //   GSI3: all findings for a job  GSI3PK = JOB#{jobId},   GSI3SK = FINDING#{id}
    //   GSI4: by sourceRef    GSI4PK = SOURCEREF#{ref},       GSI4SK = PKG#{name}  ← NEW
    //
    // All three record types share the same table so they benefit from:
    //   - Single per-request pricing model
    //   - Single TTL sweep (the `ttl` attribute is set on every record type)
    //   - No extra DDB tables to manage/IAM-grant

    this.findingsTable = new dynamodb.Table(this, 'FindingsTable', {
      tableName: `skills-svc-findings-${this.account}-${this.region}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption:  dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dynamodbKey,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
    });

    // GSI1 — query findings by package + severity
    this.findingsTable.addGlobalSecondaryIndex({
      indexName:       'GSI1-Severity',
      partitionKey:    { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey:         { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType:  dynamodb.ProjectionType.ALL,
    });

    // GSI2 — query by CWE ID across all packages
    this.findingsTable.addGlobalSecondaryIndex({
      indexName:       'GSI2-CWE',
      partitionKey:    { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey:         { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType:  dynamodb.ProjectionType.ALL,
    });

    // GSI3 — query all findings for a specific job
    this.findingsTable.addGlobalSecondaryIndex({
      indexName:       'GSI3-Job',
      partitionKey:    { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey:         { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
      projectionType:  dynamodb.ProjectionType.ALL,
    });

    // GSI4 — query COMMIT# records and findings by sourceRef (git commit SHA / tag)
    //
    // GAP 3: enables efficient lookup of "has this ref been reviewed?" without
    // needing to know the packageName upfront (e.g., from the CLI or a
    // cross-package dashboard).
    //
    // GSI4PK = SOURCEREF#{sourceRef}   (written by dedup.ts writeCommitRecord)
    // GSI4SK = PKG#{packageName}
    //
    // Projection: KEYS_ONLY is sufficient for the dedup check; consumers that
    // need full record data can follow up with a GetItem on the base table.
    this.findingsTable.addGlobalSecondaryIndex({
      indexName:       'GSI4-SourceRef',
      partitionKey:    { name: 'GSI4PK', type: dynamodb.AttributeType.STRING },
      sortKey:         { name: 'GSI4SK', type: dynamodb.AttributeType.STRING },
      projectionType:  dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['jobId', 'status', 'createdAt'],
    });

    // SSM param for other stacks / Lambda env resolution
    new ssm.StringParameter(this, 'FindingsTableParam', {
      parameterName: `/skills-svc/${envName}/dynamodb/findings-table-name`,
      stringValue: this.findingsTable.tableName,
    });

    // ── Webhook Lambda ─────────────────────────────────────────────────────────

    const webhookLogGroup = new logs.LogGroup(this, 'WebhookLogGroup', {
      logGroupName:  `/skills-svc/${envName}/lambda/webhook`,
      retention:     logs.RetentionDays.THREE_MONTHS,
      encryptionKey: props.lambdaEnvKey,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const webhookRole = new iam.Role(this, 'WebhookLambdaRole', {
      roleName:   `skills-svc-webhook-lambda-${envName}`,
      assumedBy:  new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid:       'CloudWatchLogs',
      actions:   ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [webhookLogGroup.logGroupArn],
    }));

    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid:       'SSMRead',
      actions:   ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/skills-svc/${envName}/*`],
    }));

    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid:       'S3PutMetadata',
      actions:   ['s3:PutObject'],
      resources: [`arn:aws:s3:::skills-svc-uploads-${this.account}-${this.region}/reviews/*`],
    }));

    // GAP 3 + GAP 6: Lambda must read and write to the findings table for
    //   - COMMIT# idempotency markers    (GetItem + PutItem)
    //   - WEBHOOK#COOLDOWN# cooldown TTL records (GetItem + PutItem)
    // ConditionExpression (attribute_not_exists) requires no extra permissions.
    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DDBIdempotencyAndCooldown',
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
      ],
      resources: [
        this.findingsTable.tableArn,
      ],
    }));

    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid:       'KMSEncrypt',
      actions:   ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [props.dynamodbKey.keyArn, props.lambdaEnvKey.keyArn],
    }));

    webhookRole.addToPolicy(new iam.PolicyStatement({
      sid:       'XRayWrite',
      actions:   ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }));

    this.webhookFn = new lambda.Function(this, 'WebhookLambda', {
      functionName:   `skills-svc-webhook-${envName}`,
      runtime:        lambda.Runtime.NODEJS_20_X,
      code:           lambda.Code.fromAsset('../packages/lambda/dist'),
      handler:        'webhook/handler.handler',
      timeout:        cdk.Duration.seconds(30),
      memorySize:     256,
      role:           webhookRole,
      vpc:            props.vpc,
      vpcSubnets:     { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSg],
      tracing:        lambda.Tracing.ACTIVE,
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ENV:          envName,
        REGION:       this.region,
        LOG_LEVEL:    'INFO',
      },
      description: 'Receives GitHub/GitLab webhooks, validates signatures, submits code review jobs',
    });

    // ── API Gateway HTTP API ───────────────────────────────────────────────────

    this.webhookApi = new apigatewayv2.HttpApi(this, 'WebhookApi', {
      apiName:            `skills-svc-webhook-${envName}`,
      description:        'Public endpoint for GitHub and GitLab webhook events (code review)',
      createDefaultStage: true,
    });

    const webhookIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'WebhookIntegration',
      this.webhookFn,
    );

    this.webhookApi.addRoutes({
      path:        '/webhook/github',
      methods:     [apigatewayv2.HttpMethod.POST],
      integration: webhookIntegration,
    });

    this.webhookApi.addRoutes({
      path:        '/webhook/gitlab',
      methods:     [apigatewayv2.HttpMethod.POST],
      integration: webhookIntegration,
    });

    // ── WAF — Rate Limiting ───────────────────────────────────────────────────
    //
    // The WAF IP rate limit (500 req / 5 min) is the last line of defence.
    // GAP 6 DDB cooldown is the first — it absorbs per-commit storms before
    // any ECS task is queued.

    const webAcl = new wafv2.CfnWebACL(this, 'WebhookWaf', {
      name:          `skills-svc-webhook-waf-${envName}`,
      scope:         'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName:               `skills-svc-webhook-waf-${envName}`,
        sampledRequestsEnabled:   true,
      },
      rules: [
        {
          name:     'RateLimit',
          priority: 1,
          action:   { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName:               'WebhookRateLimit',
            sampledRequestsEnabled:   true,
          },
          statement: {
            rateBasedStatement: {
              limit:            500,   // 500 requests per 5-minute window per IP
              aggregateKeyType: 'IP',
            },
          },
        },
        {
          name:           'AWSManagedRulesCommonRuleSet',
          priority:       2,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName:               'CommonRuleSet',
            sampledRequestsEnabled:   false,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name:       'AWSManagedRulesCommonRuleSet',
            },
          },
        },
      ],
    });

    // Associate WAF with the HTTP API default stage
    new wafv2.CfnWebACLAssociation(this, 'WebhookWafAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${this.webhookApi.apiId}/stages/\$default`,
      webAclArn:   webAcl.attrArn,
    });

    // SSM params
    new ssm.StringParameter(this, 'WebhookUrlParam', {
      parameterName: `/skills-svc/${envName}/webhook/api-url`,
      stringValue:   this.webhookApi.apiEndpoint,
    });
  }
}
