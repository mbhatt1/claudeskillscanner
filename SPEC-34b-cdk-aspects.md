# SPEC-34b — CDK Aspects: Invariant Enforcement Layer

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-01 (architecture), SPEC-33 (gap-audit fixes)
**Target files:**
- `infra/aspects/invariants.ts` — 8 new CDK Aspects
- `infra/bin/app.ts` — registration of all 8 aspects
- `infra/test/aspects/invariants.test.ts` — Jest test suite

These aspects codify invariants that regressed repeatedly across SPEC-01 through SPEC-33.
All aspects block synthesis (`addError`) on hard violations and warn (`addWarning`) on soft ones.

---

## 1. Background: Invariants That Kept Breaking

| # | Invariant | First broken | Pattern |
|---|-----------|-------------|---------|
| 1 | `results-processor` / `query` / `mcp` Lambdas missing `USER_ARN` env var | SPEC-07 | Envelope decrypt called without caller identity |
| 2 | ECS-submitting Lambdas missing cluster/task-def env vars | SPEC-11 | `RunTaskCommand` called but env vars absent |
| 3 | `results-processor` overwrites status without checking current value | SPEC-14 | `JOBS_TABLE_NAME` missing → no pre-check possible |
| 4 | Lambda has `dynamodb:PutItem` but no `*_TABLE_NAME` env var | SPEC-18 | Hardcoded ARNs instead of env-var references |
| 5 | KMS key for results/uploads allows `Principal: '*'` on Decrypt | SPEC-20 | Overbroad key policies |
| 6 | MCP auth Lambda shares a role or has excessive permissions | SPEC-24 | Role reuse leaks permissions across functions |
| 7 | EventBridge rule uses `startedBy` prefix instead of `clusterArn` filter | SPEC-28 | Wrong field name in ECS task-stopped event pattern |
| 8 | Backfill Lambda missing checkpoint SSM param or has too-long timeout | SPEC-31 | Pagination state lost on timeout |

---

## 2. `infra/aspects/invariants.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import { IConstruct } from 'constructs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the plain environment map of a CfnFunction (may be undefined). */
function cfnEnv(node: lambda.CfnFunction): Record<string, string> {
  return (node.environment as any)?.variables ?? {};
}

/** Return true if the string value contains any of the substrings. */
function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some(n => haystack.includes(n));
}

/** Walk all inline policy documents attached to a CfnRole and collect all actions. */
function roleActions(role: iam.CfnRole): string[] {
  const docs: any[] = (role.policies as any[]) ?? [];
  const actions: string[] = [];
  for (const pol of docs) {
    const stmts: any[] = pol?.policyDocument?.Statement ?? [];
    for (const stmt of stmts) {
      const a = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      actions.push(...a);
    }
  }
  return actions;
}

/** Find the CfnRole a Lambda's role resolves to, by walking sibling constructs. */
function findCfnRoleForLambda(fn: lambda.CfnFunction): iam.CfnRole | undefined {
  // The CDK-generated role is typically a sibling of the CfnFunction
  const parent = fn.node.scope;
  if (!parent) return undefined;
  for (const child of parent.node.children) {
    if (child instanceof iam.CfnRole) return child;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Aspect 1: EnvelopeDecryptUserArnAspect
// ---------------------------------------------------------------------------

/**
 * Any Lambda whose name marks it as a caller of envelopeDecrypt must carry
 * USER_ARN or JOB_USER_ARN in its environment so the decryptor knows the
 * principal. ECS runner is exempt (it reads from process.env at runtime).
 *
 * Invariant broken in: SPEC-07, SPEC-13, SPEC-19
 */
export class EnvelopeDecryptUserArnAspect implements cdk.IAspect {
  private static readonly CALLER_PATTERNS = [
    'results-processor',
    'query',
    'mcp',
    'get-result',
  ];
  private static readonly ECS_RUNNER_MARKER = 'ecs-runner';

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) return;

    const fnName: string = node.functionName ?? node.node.id ?? '';

    // ECS runner is exempt — it receives userArn via ECS environment injection
    if (fnName.includes(EnvelopeDecryptUserArnAspect.ECS_RUNNER_MARKER)) return;

    const isCaller = containsAny(fnName, EnvelopeDecryptUserArnAspect.CALLER_PATTERNS);
    if (!isCaller) return;

    const env = cfnEnv(node);
    const hasUserArn =
      Object.prototype.hasOwnProperty.call(env, 'USER_ARN') ||
      Object.prototype.hasOwnProperty.call(env, 'JOB_USER_ARN');

    if (!hasUserArn) {
      cdk.Annotations.of(node).addError(
        `[EnvelopeDecryptUserArnAspect] Lambda "${fnName}" calls envelopeDecrypt ` +
        `but has neither USER_ARN nor JOB_USER_ARN in its environment. ` +
        `The decrypt operation will fail at runtime without caller identity. ` +
        `Node: ${node.node.path}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Aspect 2: EcsEnvironmentAspect
// ---------------------------------------------------------------------------

/**
 * Any Lambda that has ecs:RunTask in its role's inline policies must have
 * ECS_CLUSTER_ARN, ECS_TASK_DEFINITION_ARN, ECS_SUBNET_IDS, and
 * ECS_SECURITY_GROUP_IDS in its environment — otherwise RunTaskCommand
 * construction will fail at runtime with a cryptic "undefined" ARN.
 *
 * Invariant broken in: SPEC-11, SPEC-22
 */
export class EcsEnvironmentAspect implements cdk.IAspect {
  private static readonly REQUIRED_VARS = [
    'ECS_CLUSTER_ARN',
    'ECS_TASK_DEFINITION_ARN',
    'ECS_SUBNET_IDS',
    'ECS_SECURITY_GROUP_IDS',
  ] as const;

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) return;

    const role = findCfnRoleForLambda(node);
    if (!role) return;

    const actions = roleActions(role);
    const hasRunTask = actions.some(a => a === 'ecs:RunTask' || a === 'ecs:*');
    if (!hasRunTask) return;

    const env = cfnEnv(node);
    const fnName: string = node.functionName ?? node.node.id ?? '';

    for (const varName of EcsEnvironmentAspect.REQUIRED_VARS) {
      if (!Object.prototype.hasOwnProperty.call(env, varName)) {
        cdk.Annotations.of(node).addError(
          `[EcsEnvironmentAspect] Lambda "${fnName}" has ecs:RunTask permission ` +
          `but is missing environment variable "${varName}". ` +
          `RunTaskCommand will fail at runtime. Node: ${node.node.path}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Aspect 3: CancelledStatusPropagationAspect
// ---------------------------------------------------------------------------

/**
 * results-processor Lambdas must have JOBS_TABLE_NAME in their environment so
 * they can read the current job status before writing. Without this, a CANCELLED
 * job can be overwritten to COMPLETE by a racing processor.
 *
 * Invariant broken in: SPEC-14, SPEC-25
 */
export class CancelledStatusPropagationAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) return;

    const fnName: string = node.functionName ?? node.node.id ?? '';
    if (!fnName.includes('results-processor')) return;

    const env = cfnEnv(node);
    if (!Object.prototype.hasOwnProperty.call(env, 'JOBS_TABLE_NAME')) {
      cdk.Annotations.of(node).addWarning(
        `[CancelledStatusPropagationAspect] Lambda "${fnName}" is a results-processor ` +
        `but lacks JOBS_TABLE_NAME in its environment. Without reading current status ` +
        `before writing, a CANCELLED job can be erroneously overwritten to COMPLETE. ` +
        `Node: ${node.node.path}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Aspect 4: DDBKeyPrefixAspect
// ---------------------------------------------------------------------------

/**
 * Any Lambda with dynamodb:PutItem on a table must have at least one
 * environment variable whose name ends with _TABLE_NAME. This ensures the
 * function was wired to the correct table and avoids hardcoded ARN drift.
 *
 * Invariant broken in: SPEC-18, SPEC-29
 */
export class DDBKeyPrefixAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) return;

    const role = findCfnRoleForLambda(node);
    if (!role) return;

    const actions = roleActions(role);
    const hasPutItem = actions.some(
      a => a === 'dynamodb:PutItem' || a === 'dynamodb:*',
    );
    if (!hasPutItem) return;

    const env = cfnEnv(node);
    const hasTableNameVar = Object.keys(env).some(k => k.endsWith('_TABLE_NAME'));

    if (!hasTableNameVar) {
      const fnName: string = node.functionName ?? node.node.id ?? '';
      cdk.Annotations.of(node).addError(
        `[DDBKeyPrefixAspect] Lambda "${fnName}" has dynamodb:PutItem permission ` +
        `but has no *_TABLE_NAME environment variable. ` +
        `The function cannot locate its table at runtime without an env-var reference. ` +
        `Node: ${node.node.path}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Aspect 5: KmsContextAspect
// ---------------------------------------------------------------------------

/**
 * KMS keys whose alias contains 'results' or 'uploads' are used for envelope
 * encryption of user data. Their resource policy must not allow kms:Decrypt to
 * Principal: '*'. A warning is also emitted if the Decrypt statement has no
 * conditions, since unconditional grants to named principals are still risky.
 *
 * Invariant broken in: SPEC-20, SPEC-26
 */
export class KmsContextAspect implements cdk.IAspect {
  private static readonly SENSITIVE_ALIAS_PATTERNS = ['results', 'uploads'];

  visit(node: IConstruct): void {
    if (!(node instanceof kms.CfnKey)) return;

    const aliases: string[] = node.node.metadata
      .filter(m => m.type === 'aws:cdk:logicalId')
      .map(m => String(m.data));

    // Heuristic: check the node path for alias tokens
    const nodePath = node.node.path.toLowerCase();
    const isSensitive = KmsContextAspect.SENSITIVE_ALIAS_PATTERNS.some(p =>
      nodePath.includes(p),
    );
    if (!isSensitive) return;

    const policy: any = node.keyPolicy;
    if (!policy) return;

    const stmts: any[] = policy?.Statement ?? [];
    for (const stmt of stmts) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      const isDecrypt = actions.some(
        (a: string) => a === 'kms:Decrypt' || a === 'kms:*',
      );
      if (!isDecrypt) continue;

      // Check for wildcard principal
      const principal = stmt.Principal;
      const isWildcard =
        principal === '*' ||
        principal?.AWS === '*' ||
        (Array.isArray(principal?.AWS) && principal.AWS.includes('*'));

      if (isWildcard) {
        cdk.Annotations.of(node).addError(
          `[KmsContextAspect] KMS key at "${node.node.path}" (results/uploads) ` +
          `has a kms:Decrypt statement with Principal: '*'. ` +
          `This allows any AWS principal to decrypt user data. ` +
          `Restrict to specific role ARNs. Node: ${node.node.path}`,
        );
      } else if (!stmt.Condition) {
        cdk.Annotations.of(node).addWarning(
          `[KmsContextAspect] KMS key at "${node.node.path}" (results/uploads) ` +
          `has a kms:Decrypt statement with no Condition block. ` +
          `Consider adding aws:PrincipalArn or aws:SourceAccount conditions. ` +
          `Node: ${node.node.path}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Aspect 6: McpAuthIsolationAspect
// ---------------------------------------------------------------------------

/**
 * MCP auth Lambdas must have a dedicated role (not shared) and that role must
 * not include s3:*, ecs:*, or lambda:InvokeFunction. MCP auth only needs
 * dynamodb:GetItem + logs:* + kms:Decrypt.
 *
 * Invariant broken in: SPEC-24, SPEC-30
 */
export class McpAuthIsolationAspect implements cdk.IAspect {
  private static readonly FORBIDDEN_ACTIONS = ['s3:*', 'ecs:*', 'lambda:InvokeFunction'];

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) return;

    const fnName: string = node.functionName ?? node.node.id ?? '';
    if (!fnName.includes('mcp-auth')) return;

    const role = findCfnRoleForLambda(node);
    if (!role) return;

    const actions = roleActions(role);

    for (const forbidden of McpAuthIsolationAspect.FORBIDDEN_ACTIONS) {
      if (actions.includes(forbidden)) {
        cdk.Annotations.of(node).addError(
          `[McpAuthIsolationAspect] MCP auth Lambda "${fnName}" has forbidden ` +
          `action "${forbidden}" in its role. MCP auth may only have ` +
          `dynamodb:GetItem, logs:*, and kms:Decrypt. ` +
          `Node: ${node.node.path}`,
        );
      }
    }

    // Warn if the role's logical name suggests it is shared
    const roleName: string = (role as any).roleName ?? role.node.id ?? '';
    if (!roleName.includes('mcp-auth') && !roleName.includes('McpAuth')) {
      cdk.Annotations.of(node).addWarning(
        `[McpAuthIsolationAspect] MCP auth Lambda "${fnName}" appears to share ` +
        `role "${roleName}" which does not seem dedicated to mcp-auth. ` +
        `Ensure this role is not attached to any other Lambda function. ` +
        `Node: ${node.node.path}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Aspect 7: EventBridgeRuleAspect
// ---------------------------------------------------------------------------

/**
 * EventBridge rules that target a results-processor Lambda must filter on
 * detail.clusterArn, NOT detail.startedBy with a prefix match. The
 * startedBy-prefix approach caused missed events whenever ECS task names
 * changed format.
 *
 * Invariant broken in: SPEC-28, SPEC-32, SPEC-33
 */
export class EventBridgeRuleAspect implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof events.CfnRule)) return;

    const targets: any[] = (node.targets as any[]) ?? [];
    const targetsResultsProcessor = targets.some((t: any) => {
      const arn: string = typeof t.arn === 'string' ? t.arn : JSON.stringify(t.arn ?? '');
      return arn.includes('results-processor');
    });

    if (!targetsResultsProcessor) return;

    const pattern: any =
      typeof node.eventPattern === 'string'
        ? JSON.parse(node.eventPattern)
        : node.eventPattern ?? {};

    const detail: any = pattern?.detail ?? {};

    if (detail.startedBy !== undefined) {
      cdk.Annotations.of(node).addError(
        `[EventBridgeRuleAspect] EventBridge rule "${node.node.path}" targets ` +
        `results-processor but filters on "detail.startedBy". ` +
        `This field changes format and causes missed events. ` +
        `Use "detail.clusterArn" as the discriminator instead. ` +
        `Node: ${node.node.path}`,
      );
    }

    if (detail.clusterArn === undefined) {
      cdk.Annotations.of(node).addWarning(
        `[EventBridgeRuleAspect] EventBridge rule "${node.node.path}" targets ` +
        `results-processor but has no "detail.clusterArn" filter. ` +
        `Without this filter the rule may fire for unrelated ECS clusters. ` +
        `Node: ${node.node.path}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Aspect 8: BackfillLambdaCheckpointAspect
// ---------------------------------------------------------------------------

/**
 * Backfill Lambdas paginate over large DynamoDB scans and must checkpoint
 * progress in SSM so they can resume after a timeout. They also must not be
 * configured with a timeout over 15 minutes (hard Lambda limit), and a warning
 * fires at > 13 minutes to leave headroom for final checkpoint writes.
 *
 * Invariant broken in: SPEC-31
 */
export class BackfillLambdaCheckpointAspect implements cdk.IAspect {
  private static readonly MAX_TIMEOUT_SECONDS = 15 * 60;      // 900 s — hard limit
  private static readonly WARN_TIMEOUT_SECONDS = 13 * 60;     // 780 s — soft deadline

  visit(node: IConstruct): void {
    if (!(node instanceof lambda.CfnFunction)) return;

    const fnName: string = node.functionName ?? node.node.id ?? '';
    if (!fnName.includes('backfill')) return;

    // Check for checkpoint SSM param env var
    const env = cfnEnv(node);
    if (!Object.prototype.hasOwnProperty.call(env, 'SSM_CHECKPOINT_PARAM')) {
      cdk.Annotations.of(node).addWarning(
        `[BackfillLambdaCheckpointAspect] Backfill Lambda "${fnName}" is missing ` +
        `SSM_CHECKPOINT_PARAM in its environment. Without this, pagination state ` +
        `cannot be saved between invocations and a timeout will lose progress. ` +
        `Node: ${node.node.path}`,
      );
    }

    // Check timeout
    const timeoutSec: number = (node.timeout as number) ?? 0;
    if (timeoutSec > BackfillLambdaCheckpointAspect.MAX_TIMEOUT_SECONDS) {
      cdk.Annotations.of(node).addError(
        `[BackfillLambdaCheckpointAspect] Backfill Lambda "${fnName}" has timeout ` +
        `${timeoutSec}s which exceeds the Lambda maximum of ` +
        `${BackfillLambdaCheckpointAspect.MAX_TIMEOUT_SECONDS}s. ` +
        `Node: ${node.node.path}`,
      );
    } else if (timeoutSec > BackfillLambdaCheckpointAspect.WARN_TIMEOUT_SECONDS) {
      cdk.Annotations.of(node).addWarning(
        `[BackfillLambdaCheckpointAspect] Backfill Lambda "${fnName}" has timeout ` +
        `${timeoutSec}s (> ${BackfillLambdaCheckpointAspect.WARN_TIMEOUT_SECONDS}s). ` +
        `This leaves less than 2 minutes for checkpoint writes before hard termination. ` +
        `Consider reducing to <= 780s. Node: ${node.node.path}`,
      );
    }
  }
}
```

---

## 3. `infra/bin/app.ts` — Updated registration block

Add the following imports and `Aspects.of(app).add(...)` calls after the existing three aspect registrations:

```typescript
// --- add to existing imports in infra/bin/app.ts ---
import { EnvelopeDecryptUserArnAspect }    from '../aspects/invariants';
import { EcsEnvironmentAspect }            from '../aspects/invariants';
import { CancelledStatusPropagationAspect } from '../aspects/invariants';
import { DDBKeyPrefixAspect }              from '../aspects/invariants';
import { KmsContextAspect }                from '../aspects/invariants';
import { McpAuthIsolationAspect }          from '../aspects/invariants';
import { EventBridgeRuleAspect }           from '../aspects/invariants';
import { BackfillLambdaCheckpointAspect }  from '../aspects/invariants';

// --- add after existing Aspects.of(app).add(...) lines ---
cdk.Aspects.of(app).add(new EnvelopeDecryptUserArnAspect());
cdk.Aspects.of(app).add(new EcsEnvironmentAspect());
cdk.Aspects.of(app).add(new CancelledStatusPropagationAspect());
cdk.Aspects.of(app).add(new DDBKeyPrefixAspect());
cdk.Aspects.of(app).add(new KmsContextAspect());
cdk.Aspects.of(app).add(new McpAuthIsolationAspect());
cdk.Aspects.of(app).add(new EventBridgeRuleAspect());
cdk.Aspects.of(app).add(new BackfillLambdaCheckpointAspect());
```

Full updated `infra/bin/app.ts` (only the aspect section shown; rest is unchanged from SPEC-01):

```typescript
// Apply aspects BEFORE stacks so they validate during synth
Aspects.of(app).add(new NoWildcardIAMAspect());
Aspects.of(app).add(new EncryptionEnforcerAspect());
Aspects.of(app).add(new TaggingEnforcerAspect({
  requiredTags: ['Environment', 'Project', 'CostCenter', 'DataClassification'],
}));

// Invariant aspects — prevent regressions caught in SPEC-07 through SPEC-33
cdk.Aspects.of(app).add(new EnvelopeDecryptUserArnAspect());
cdk.Aspects.of(app).add(new EcsEnvironmentAspect());
cdk.Aspects.of(app).add(new CancelledStatusPropagationAspect());
cdk.Aspects.of(app).add(new DDBKeyPrefixAspect());
cdk.Aspects.of(app).add(new KmsContextAspect());
cdk.Aspects.of(app).add(new McpAuthIsolationAspect());
cdk.Aspects.of(app).add(new EventBridgeRuleAspect());
cdk.Aspects.of(app).add(new BackfillLambdaCheckpointAspect());
```

---

## 4. `infra/test/aspects/invariants.test.ts`

```typescript
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as events from 'aws-cdk-lib/aws-events';
import {
  EnvelopeDecryptUserArnAspect,
  EcsEnvironmentAspect,
  CancelledStatusPropagationAspect,
  DDBKeyPrefixAspect,
  KmsContextAspect,
  McpAuthIsolationAspect,
  EventBridgeRuleAspect,
  BackfillLambdaCheckpointAspect,
} from '../../aspects/invariants';

// ---------------------------------------------------------------------------
// Helper — build a minimal Lambda CfnFunction in a fresh stack
// ---------------------------------------------------------------------------
function makeCfnFunction(
  stack: cdk.Stack,
  id: string,
  opts: {
    functionName?: string;
    environment?: Record<string, string>;
    timeout?: number;
    role?: iam.CfnRole;
  } = {},
): lambda.CfnFunction {
  const role =
    opts.role ??
    new iam.CfnRole(stack, `${id}Role`, {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });

  return new lambda.CfnFunction(stack, id, {
    functionName: opts.functionName ?? id,
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    role: cdk.Fn.getAtt(role.logicalId, 'Arn').toString(),
    code: { zipFile: 'exports.handler = async () => ({});' },
    environment: opts.environment
      ? { variables: opts.environment }
      : undefined,
    timeout: opts.timeout,
  });
}

// ---------------------------------------------------------------------------
// Aspect 1: EnvelopeDecryptUserArnAspect
// ---------------------------------------------------------------------------
describe('EnvelopeDecryptUserArnAspect', () => {
  test('errors when results-processor Lambda lacks USER_ARN', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-results-processor',
      environment: { JOBS_TABLE_NAME: 'some-table' }, // USER_ARN intentionally absent
    });

    cdk.Aspects.of(app).add(new EnvelopeDecryptUserArnAspect());
    const template = app.synth({ force: true });

    Annotations.fromStack(stack).hasError(
      '/Stack/Fn',
      Match.stringLikeRegexp('EnvelopeDecryptUserArnAspect'),
    );
  });

  test('passes when query Lambda has JOB_USER_ARN', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-query',
      environment: { JOB_USER_ARN: 'arn:aws:iam::123:role/User' },
    });

    cdk.Aspects.of(app).add(new EnvelopeDecryptUserArnAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasNoError(
      '/Stack/Fn',
      Match.stringLikeRegexp('EnvelopeDecryptUserArnAspect'),
    );
  });
});

// ---------------------------------------------------------------------------
// Aspect 2: EcsEnvironmentAspect
// ---------------------------------------------------------------------------
describe('EcsEnvironmentAspect', () => {
  test('errors when Lambda with ecs:RunTask lacks ECS_CLUSTER_ARN', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    const role = new iam.CfnRole(stack, 'FnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      policies: [
        {
          policyName: 'AllowEcs',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Action: 'ecs:RunTask', Resource: '*' }],
          },
        },
      ],
    });

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-ingestion',
      role,
      environment: {
        // ECS_CLUSTER_ARN intentionally absent; only partial vars present
        ECS_TASK_DEFINITION_ARN: 'arn:aws:ecs:us-east-1:123:task-definition/foo:1',
        ECS_SUBNET_IDS: 'subnet-abc',
        ECS_SECURITY_GROUP_IDS: 'sg-abc',
      },
    });

    cdk.Aspects.of(app).add(new EcsEnvironmentAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasError(
      '/Stack/Fn',
      Match.stringLikeRegexp('ECS_CLUSTER_ARN'),
    );
  });

  test('passes when all four ECS env vars are present', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    const role = new iam.CfnRole(stack, 'FnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      policies: [
        {
          policyName: 'AllowEcs',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Action: 'ecs:RunTask', Resource: '*' }],
          },
        },
      ],
    });

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-ingestion',
      role,
      environment: {
        ECS_CLUSTER_ARN: 'arn:aws:ecs:us-east-1:123:cluster/c',
        ECS_TASK_DEFINITION_ARN: 'arn:aws:ecs:us-east-1:123:task-definition/foo:1',
        ECS_SUBNET_IDS: 'subnet-abc',
        ECS_SECURITY_GROUP_IDS: 'sg-abc',
      },
    });

    cdk.Aspects.of(app).add(new EcsEnvironmentAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasNoError(
      '/Stack/Fn',
      Match.stringLikeRegexp('EcsEnvironmentAspect'),
    );
  });
});

// ---------------------------------------------------------------------------
// Aspect 3: CancelledStatusPropagationAspect
// ---------------------------------------------------------------------------
describe('CancelledStatusPropagationAspect', () => {
  test('warns when results-processor lacks JOBS_TABLE_NAME', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-results-processor',
      environment: { USER_ARN: 'arn:aws:iam::123:role/User' },
      // JOBS_TABLE_NAME intentionally absent
    });

    cdk.Aspects.of(app).add(new CancelledStatusPropagationAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasWarning(
      '/Stack/Fn',
      Match.stringLikeRegexp('CancelledStatusPropagationAspect'),
    );
  });

  test('passes when results-processor has JOBS_TABLE_NAME', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-results-processor',
      environment: {
        USER_ARN: 'arn:aws:iam::123:role/User',
        JOBS_TABLE_NAME: 'skills-svc-jobs-123-us-east-1',
      },
    });

    cdk.Aspects.of(app).add(new CancelledStatusPropagationAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasNoWarning(
      '/Stack/Fn',
      Match.stringLikeRegexp('CancelledStatusPropagationAspect'),
    );
  });
});

// ---------------------------------------------------------------------------
// Aspect 4: DDBKeyPrefixAspect
// ---------------------------------------------------------------------------
describe('DDBKeyPrefixAspect', () => {
  test('errors when Lambda with dynamodb:PutItem has no *_TABLE_NAME env var', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    const role = new iam.CfnRole(stack, 'FnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      policies: [
        {
          policyName: 'AllowDDB',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: 'arn:aws:dynamodb:::table/t' },
            ],
          },
        },
      ],
    });

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-ingestion',
      role,
      environment: { USER_ARN: 'arn:aws:iam::123:role/User' }, // no *_TABLE_NAME
    });

    cdk.Aspects.of(app).add(new DDBKeyPrefixAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasError(
      '/Stack/Fn',
      Match.stringLikeRegexp('DDBKeyPrefixAspect'),
    );
  });

  test('passes when Lambda with dynamodb:PutItem has JOBS_TABLE_NAME', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    const role = new iam.CfnRole(stack, 'FnRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      policies: [
        {
          policyName: 'AllowDDB',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 'dynamodb:PutItem', Resource: 'arn:aws:dynamodb:::table/t' },
            ],
          },
        },
      ],
    });

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-ingestion',
      role,
      environment: { JOBS_TABLE_NAME: 'skills-svc-jobs-123-us-east-1' },
    });

    cdk.Aspects.of(app).add(new DDBKeyPrefixAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasNoError(
      '/Stack/Fn',
      Match.stringLikeRegexp('DDBKeyPrefixAspect'),
    );
  });
});

// ---------------------------------------------------------------------------
// Aspect 5: KmsContextAspect
// ---------------------------------------------------------------------------
describe('KmsContextAspect', () => {
  test('errors when results KMS key allows kms:Decrypt to Principal *', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    // Node path will contain 'results' due to the id
    new kms.CfnKey(stack, 'results-key', {
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 'kms:Decrypt',
            Resource: '*',
          },
        ],
      },
    });

    cdk.Aspects.of(app).add(new KmsContextAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasError(
      Match.stringLikeRegexp('results-key'),
      Match.stringLikeRegexp('KmsContextAspect'),
    );
  });

  test('warns when results KMS key has Decrypt with no Condition', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    new kms.CfnKey(stack, 'results-key', {
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::123456789012:role/MyRole' },
            Action: 'kms:Decrypt',
            Resource: '*',
            // Condition intentionally absent
          },
        ],
      },
    });

    cdk.Aspects.of(app).add(new KmsContextAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasWarning(
      Match.stringLikeRegexp('results-key'),
      Match.stringLikeRegexp('KmsContextAspect'),
    );
  });
});

// ---------------------------------------------------------------------------
// Aspect 6: McpAuthIsolationAspect
// ---------------------------------------------------------------------------
describe('McpAuthIsolationAspect', () => {
  test('errors when mcp-auth Lambda role contains s3:*', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    const role = new iam.CfnRole(stack, 'SharedRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      policies: [
        {
          policyName: 'Overpermissioned',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 's3:*', Resource: '*' }, // forbidden
            ],
          },
        },
      ],
    });

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-mcp-auth-token-validator',
      role,
    });

    cdk.Aspects.of(app).add(new McpAuthIsolationAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasError(
      '/Stack/Fn',
      Match.stringLikeRegexp('McpAuthIsolationAspect'),
    );
  });

  test('passes when mcp-auth Lambda role has only dynamodb:GetItem', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    const role = new iam.CfnRole(stack, 'McpAuthRole', {
      roleName: 'mcp-auth-role',
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      },
      policies: [
        {
          policyName: 'MinimalAccess',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 'dynamodb:GetItem', Resource: 'arn:aws:dynamodb:::table/t' },
              { Effect: 'Allow', Action: 'kms:Decrypt', Resource: 'arn:aws:kms:::key/k' },
            ],
          },
        },
      ],
    });

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-mcp-auth-token-validator',
      role,
    });

    cdk.Aspects.of(app).add(new McpAuthIsolationAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasNoError(
      '/Stack/Fn',
      Match.stringLikeRegexp('McpAuthIsolationAspect'),
    );
  });
});

// ---------------------------------------------------------------------------
// Aspect 7: EventBridgeRuleAspect
// ---------------------------------------------------------------------------
describe('EventBridgeRuleAspect', () => {
  test('errors when results-processor rule uses startedBy filter', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    new events.CfnRule(stack, 'Rule', {
      eventPattern: {
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: {
          lastStatus: ['STOPPED'],
          startedBy: [{ prefix: 'skills-svc' }], // the recurring bug
        },
      },
      targets: [
        {
          id: 'ResultsProcessor',
          arn: 'arn:aws:lambda:us-east-1:123:function:skills-svc-results-processor',
        },
      ],
    });

    cdk.Aspects.of(app).add(new EventBridgeRuleAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasError(
      '/Stack/Rule',
      Match.stringLikeRegexp('EventBridgeRuleAspect'),
    );
  });

  test('passes when results-processor rule uses clusterArn filter', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    new events.CfnRule(stack, 'Rule', {
      eventPattern: {
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: {
          lastStatus: ['STOPPED'],
          clusterArn: ['arn:aws:ecs:us-east-1:123:cluster/skills-svc-prod'],
        },
      },
      targets: [
        {
          id: 'ResultsProcessor',
          arn: 'arn:aws:lambda:us-east-1:123:function:skills-svc-results-processor',
        },
      ],
    });

    cdk.Aspects.of(app).add(new EventBridgeRuleAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasNoError(
      '/Stack/Rule',
      Match.stringLikeRegexp('startedBy'),
    );
  });
});

// ---------------------------------------------------------------------------
// Aspect 8: BackfillLambdaCheckpointAspect
// ---------------------------------------------------------------------------
describe('BackfillLambdaCheckpointAspect', () => {
  test('warns when backfill Lambda lacks SSM_CHECKPOINT_PARAM', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-backfill-embeddings',
      timeout: 600,
      // SSM_CHECKPOINT_PARAM intentionally absent
    });

    cdk.Aspects.of(app).add(new BackfillLambdaCheckpointAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasWarning(
      '/Stack/Fn',
      Match.stringLikeRegexp('SSM_CHECKPOINT_PARAM'),
    );
  });

  test('warns when backfill Lambda timeout > 780s', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-backfill-embeddings',
      timeout: 850, // > 780s warning threshold
      environment: { SSM_CHECKPOINT_PARAM: '/skills-svc/prod/backfill/checkpoint' },
    });

    cdk.Aspects.of(app).add(new BackfillLambdaCheckpointAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasWarning(
      '/Stack/Fn',
      Match.stringLikeRegexp('BackfillLambdaCheckpointAspect'),
    );
  });

  test('passes when backfill Lambda has checkpoint param and safe timeout', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Stack');

    makeCfnFunction(stack, 'Fn', {
      functionName: 'skills-svc-backfill-embeddings',
      timeout: 600,
      environment: { SSM_CHECKPOINT_PARAM: '/skills-svc/prod/backfill/checkpoint' },
    });

    cdk.Aspects.of(app).add(new BackfillLambdaCheckpointAspect());
    app.synth({ force: true });

    Annotations.fromStack(stack).hasNoWarning(
      '/Stack/Fn',
      Match.stringLikeRegexp('BackfillLambdaCheckpointAspect'),
    );
  });
});
```

---

## 5. Implementation Notes

### 5.1 Why env-var presence is used as a proxy for code paths

CDK Aspects run at synth time and cannot inspect Lambda source code. Environment variable presence is the correct synth-time signal because:
- All real Lambda deployments in this codebase set env vars before calling the relevant SDK command.
- The pattern is enforced uniformly: if the env var is absent the code will throw at startup (validated by `!process.env.X && process.exit(1)` guards already in handlers).

### 5.2 Role-lookup heuristic limitation

`findCfnRoleForLambda` walks the parent scope for a `CfnRole` sibling. This works for CDK-generated roles (which are always siblings of their function) but will not find imported roles. If a Lambda uses `lambda.Function.fromFunctionArn`, the aspect is silently skipped for that function — this is acceptable because imported functions are not managed by this CDK app.

### 5.3 KmsContextAspect path matching

KMS key aliases are not directly accessible from `CfnKey` properties (the alias is a separate `CfnAlias` resource). The aspect uses `node.node.path` as a heuristic, which works reliably because key constructs in this codebase are named after their alias (e.g., `ResultsBucketKey`, `UploadsBucketKey`). A future improvement is to walk `CfnAlias` nodes and cross-reference by `targetKeyId`.

### 5.4 EventBridge pattern shape

CDK's `CfnRule.eventPattern` accepts either a JSON string or an object. The aspect handles both forms. The event pattern field name in ECS task-stopped events is `detail.clusterArn` (as confirmed by AWS EventBridge schema registry for `aws.ecs / ECS Task State Change`). The `detail.startedBy` field is present in the event but using it as the primary filter was the recurring bug.

### 5.5 Test isolation

Each test creates a fresh `cdk.App()` and `cdk.Stack`. The `app.synth({ force: true })` call triggers aspect traversal without writing to disk. `Annotations.fromStack(stack)` then queries the in-memory annotation store. No mocking of AWS SDK calls is required.

---

## 6. File Summary

| File | Lines (approx.) | Purpose |
|------|-----------------|---------|
| `infra/aspects/invariants.ts` | ~280 | All 8 CDK Aspect classes |
| `infra/bin/app.ts` (delta) | ~10 | Import + register 8 aspects |
| `infra/test/aspects/invariants.test.ts` | ~330 | 16 Jest tests (pass + fail per aspect) |
| **Total** | **~620** | |
