# Skills as a Service (SaaS) — Specification Part 14: Cleanup

**Version:** 1.0.0  
**Status:** AUTHORITATIVE — final cleanup pass  
**Parts:** ... | [Part 13](SPEC-13-terminal-fixes.md) | [Part 14: Cleanup]

---

## Issues Resolved

| # | Issue | Source |
|---|-------|--------|
| 1 | Remove all Claude Desktop code introduced in SPEC-13 Fix 12 | SPEC-13 |
| 2 | Clean `MCPStack` — single `/mcp` route, IAM auth only | SPEC-09, SPEC-13 |
| 3 | Clean `mcp-config` command — SigV4 only, no `--desktop` flag | SPEC-09, SPEC-13 |
| 4 | Clean MCP handler — single `callerArn` extraction path | SPEC-13 |
| 5 | QA-189 asserts `/mcp/desktop` route — invert to assert it does NOT exist | SPEC-13 |
| 6 | `packages/ecs-runner/package.json` — never specified authoritatively | SPEC-06 partial |
| 7 | `packages/knowledge-store/package.json` — never specified authoritatively | SPEC-03 partial |
| 8 | `@aws-sdk/client-secrets-manager` in Lambda — needed for webhook (SPEC-06) but missing from authoritative package.json | SPEC-13 Fix 6 |
| 9 | `@aws-sdk/client-secrets-manager` in CLI package.json — only added for Claude Desktop; remove it | SPEC-13 |
| 10 | SPEC-09 CORS `allowOrigins` includes `app://claudedesktop` — remove | SPEC-09 |
| 11 | SPEC-09 description mentions Claude Desktop — clean up | SPEC-09 |
| 12 | `mcp-authorizer/handler.ts` referenced in Lambda file list — remove | SPEC-13 |

---

## Fix 1–5: Remove All Claude Desktop Code

### What SPEC-13 Fix 12 added — **delete entirely:**

- `mcpApiKeySecret` (Secrets Manager secret)
- `authorizerFn` (`MCPAuthorizerLambda`)
- `lambdaAuthorizer` (`HttpLambdaAuthorizer`)
- `/mcp/desktop` API Gateway route
- `packages/lambda/src/mcp-authorizer/handler.ts`
- `--desktop` option on `mcp-config` command

### Authoritative `infra/lib/mcp-stack.ts` — API Gateway section

Replaces everything added by SPEC-13 Fix 12. Single route, IAM auth:

```typescript
// Single /mcp route — IAM SigV4 only
api.addRoutes({
  path: '/mcp',
  methods: [apigatewayv2.HttpMethod.POST],
  integration: new apigatewayv2Integrations.HttpLambdaIntegration(
    'MCPIntegration', mcpFn,
    { payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0 },
  ),
  authorizer: new apigatewayv2Authorizers.HttpIamAuthorizer(),
});

// Health check — no auth
api.addRoutes({
  path: '/health',
  methods: [apigatewayv2.HttpMethod.GET],
  integration: new apigatewayv2Integrations.HttpLambdaIntegration(
    'HealthIntegration', mcpFn,
    { payloadFormatVersion: apigatewayv2.PayloadFormatVersion.VERSION_2_0 },
  ),
});
```

Remove the `corsPreflight` block's `app://claudedesktop` entry:

```typescript
corsPreflight: {
  allowOrigins: ['https://claude.ai'],   // remove 'app://claudedesktop'
  allowMethods: [apigatewayv2.CorsHttpMethod.POST],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
  maxAge: cdk.Duration.hours(1),
},
```

### Authoritative `packages/lambda/src/mcp/handler.ts` — callerArn extraction

Remove the Claude Desktop fallback path:

```typescript
// Single extraction path — SigV4 IAM only
const callerArn: string =
  event.requestContext.authorizer?.iam?.userArn ?? 'unknown';
```

### Authoritative `packages/cli/src/commands/mcp-config.ts`

Remove `--desktop` flag and Secrets Manager usage. Clean version:

```typescript
import { Command } from 'commander';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { StoredCredentials } from './assume-role';

const CREDS_FILE = path.join(os.homedir(), '.skills-svc', 'credentials.json');

export function mcpConfigCommand(): Command {
  return new Command('mcp-config')
    .description('Generate MCP server config for Claude Code')
    .option('--install', 'Write config to ~/.claude/mcp.json (merges with existing)', false)
    .option('--print', 'Print config JSON to stdout (default behaviour)')
    .action(async (opts: { install: boolean }) => {
      const cfg   = await loadConfig(process.env.SKILLS_SVC_PROFILE);
      const creds = await getCredentialProvider();
      const ssm   = new SSMClient({ region: cfg.region, credentials: creds });

      const mcpEndpoint = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/mcp/endpoint`,
      })).then(r => r.Parameter!.Value!);

      // Read assumed-role credentials for embedding in the config
      // Claude Code uses these env vars to sign SigV4 requests to the MCP endpoint
      let credEnv: Record<string, string> = {};
      if (existsSync(CREDS_FILE)) {
        const stored: StoredCredentials = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
        const expiry = new Date(stored.expiration);
        if (expiry <= new Date()) {
          console.warn(chalk.yellow(
            `⚠  Stored credentials expired at ${expiry.toLocaleString()}.\n` +
            `   Refresh with: skills-svc assume-role --role-arn ${stored.roleArn}`
          ));
        }
        credEnv = {
          AWS_ACCESS_KEY_ID:     stored.accessKeyId,
          AWS_SECRET_ACCESS_KEY: stored.secretAccessKey,
          AWS_SESSION_TOKEN:     stored.sessionToken,
          AWS_REGION:            cfg.region,
        };
      } else {
        console.warn(chalk.yellow(
          `⚠  No stored credentials found.\n` +
          `   Run: skills-svc assume-role --role-arn <arn> first.`
        ));
        // Fall back to ambient credentials — Claude Code will use its own credential chain
        credEnv = { AWS_REGION: cfg.region };
      }

      // Claude Code MCP HTTP config with SigV4 signing via env vars
      const mcpConfig = {
        mcpServers: {
          'skills-as-a-service': {
            type: 'http',
            url: mcpEndpoint,
            // Claude Code reads AWS_* env vars to sign requests with SigV4
            env: credEnv,
          },
        },
      };

      const configJson = JSON.stringify(mcpConfig, null, 2);

      if (opts.install) {
        const claudeDir = path.join(os.homedir(), '.claude');
        mkdirSync(claudeDir, { recursive: true });
        const mcpFile = path.join(claudeDir, 'mcp.json');

        // Merge — preserve existing MCP servers
        let existing: Record<string, unknown> = { mcpServers: {} };
        if (existsSync(mcpFile)) {
          existing = JSON.parse(readFileSync(mcpFile, 'utf-8'));
        }
        (existing.mcpServers as any)['skills-as-a-service'] =
          mcpConfig.mcpServers['skills-as-a-service'];

        writeFileSync(mcpFile, JSON.stringify(existing, null, 2), { mode: 0o600 });
        console.log(chalk.green(`✓ MCP config written to ${mcpFile}`));
        console.log(chalk.dim(`  Endpoint: ${mcpEndpoint}`));
        console.log(chalk.dim('  Restart Claude Code to pick up the new MCP server.'));
      } else {
        console.log(configJson);
        console.log(chalk.dim('\nTo install: skills-svc mcp-config --install'));
        console.log(chalk.dim('Note: credentials expire with your session. Re-run after assume-role.'));
      }
    });
}
```

### Updated QA-189 — assert `/mcp/desktop` does NOT exist

```typescript
// REPLACE QA-189:
test('QA-189: MCPStack has only /mcp and /health routes — no /mcp/desktop', () => {
  const { templates } = buildTestApp();
  const routes = templates.mcp.findResources('AWS::ApiGatewayV2::Route');
  const routeKeys = Object.values(routes).map((r: any) => r.Properties.RouteKey as string);
  // Must have /mcp and /health
  expect(routeKeys.some(r => r.includes('/mcp'))).toBe(true);
  expect(routeKeys.some(r => r.includes('/health'))).toBe(true);
  // Must NOT have /mcp/desktop
  expect(routeKeys.some(r => r.includes('/mcp/desktop'))).toBe(false);
  // Must NOT have a Lambda authorizer (IAM only)
  const authorizers = templates.mcp.findResources('AWS::ApiGatewayV2::Authorizer');
  const authTypes = Object.values(authorizers).map(
    (a: any) => a.Properties.AuthorizerType as string
  );
  expect(authTypes.every(t => t === 'AWS_IAM')).toBe(true);
});
```

### Updated SPEC-09 description (conceptual — apply when reading SPEC-09)

Anywhere SPEC-09 mentions "Claude Desktop":
- Line 11: `MCP Client (Claude Desktop / Claude Code)` → `MCP Client (Claude Code / custom agents)`
- Line 14: `MCP Client (Claude Desktop / Claude Code)` → `MCP Client (Claude Code)`
- Line 184: Remove the `// Swap to JWT when integrating with Claude Desktop` comment
- Line 192: Remove `'app://claudedesktop'` from `allowOrigins`

---

## Fix 6: Authoritative `packages/ecs-runner/package.json`

SPEC-06 lists deps inline but never gives a complete package.json:

```json
{
  "name": "@skills-svc/ecs-runner",
  "version": "1.0.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "jest --passWithNoTests"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.600.0",
    "@aws-sdk/client-dynamodb":        "^3.600.0",
    "@aws-sdk/client-s3":              "^3.600.0",
    "@aws-sdk/client-sns":             "^3.600.0",
    "@aws-sdk/client-ssm":             "^3.600.0",
    "@aws-sdk/lib-dynamodb":           "^3.600.0",
    "unzipper":                        "^0.12.3",
    "@skills-svc/shared":              "*"
  },
  "devDependencies": {
    "@types/node":   "^20.0.0",
    "jest":          "^29.7.0",
    "ts-jest":       "^29.1.0",
    "typescript":    "^5.4.0"
  }
}
```

### Authoritative `packages/ecs-runner/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Fix 7: Authoritative `packages/knowledge-store/package.json`

```json
{
  "name": "@skills-svc/knowledge-store",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "test": "jest --passWithNoTests"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime":   "^3.600.0",
    "@aws-sdk/client-ssm":               "^3.600.0",
    "@aws-sdk/credential-provider-node": "^3.600.0",
    "@opensearch-project/opensearch":    "^2.6.0",
    "@skills-svc/shared":                "*"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "jest":        "^29.7.0",
    "ts-jest":     "^29.1.0",
    "typescript":  "^5.4.0"
  }
}
```

### Authoritative `packages/knowledge-store/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Fix 8: Add `@aws-sdk/client-secrets-manager` to Lambda `package.json`

SPEC-06 results-processor uses `SecretsManagerClient` for the optional notification webhook. It was missing from the authoritative Lambda package.json written in SPEC-13 Fix 6.

**Update `packages/lambda/package.json` dependencies — add one line:**

```json
"@aws-sdk/client-secrets-manager": "^3.600.0"
```

Full updated dependencies block (replaces SPEC-13 Fix 6):

```json
{
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime":   "^3.600.0",
    "@aws-sdk/client-cloudwatch-logs":   "^3.600.0",
    "@aws-sdk/client-comprehend":        "^3.600.0",
    "@aws-sdk/client-dynamodb":          "^3.600.0",
    "@aws-sdk/client-ecs":               "^3.600.0",
    "@aws-sdk/client-s3":                "^3.600.0",
    "@aws-sdk/client-secrets-manager":   "^3.600.0",
    "@aws-sdk/client-sns":               "^3.600.0",
    "@aws-sdk/client-ssm":               "^3.600.0",
    "@aws-sdk/client-sfn":               "^3.600.0",
    "@aws-sdk/credential-provider-node": "^3.600.0",
    "@aws-sdk/lib-dynamodb":             "^3.600.0",
    "@opensearch-project/opensearch":    "^2.6.0",
    "aws-xray-sdk":                      "^3.6.0",
    "@skills-svc/shared":                "*"
  }
}
```

---

## Fix 9: Remove `@aws-sdk/client-secrets-manager` from CLI `package.json`

This was only added in SPEC-13 Fix 12 for Claude Desktop API key fetching. No CLI command needs Secrets Manager after removing Claude Desktop.

**Updated `packages/cli/package.json` dependencies (replaces SPEC-13 Fix 7):**

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

## Fix 10–12: Already resolved by Fixes 1–5 above

- SPEC-09 CORS `allowOrigins` — remove `app://claudedesktop` (Fix 2)
- SPEC-09 description — strip Claude Desktop mentions (Fix 1 notes)
- `mcp-authorizer/handler.ts` — never create this file (Fix 1)

---

## Authoritative Complete File List

Every file that must exist in the monorepo. No file mentioned in any spec that isn't listed here should be created.

```
skills-as-a-service/
├── package.json                          # root workspace
├── tsconfig.base.json
├── .eslintrc.js
├── jest.config.ts
├── .nvmrc                                # "20"
├── Makefile
│
├── infra/
│   ├── package.json
│   ├── tsconfig.json
│   ├── cdk.json
│   ├── bin/
│   │   └── app.ts                        # SPEC-12 Fix 4 (updated SPEC-13 Fix 1-3)
│   ├── lib/
│   │   ├── network-stack.ts              # SPEC-01
│   │   ├── security-stack.ts             # SPEC-01 + SPEC-11 (runSkillLambdaRole, registryBucketKey)
│   │   ├── storage-stack.ts              # SPEC-02 + SPEC-12 Fix 2 (5 GSIs)
│   │   ├── messaging-stack.ts            # SPEC-02
│   │   ├── lambda-stack.ts               # SPEC-02 + SPEC-13 Fix 1-2 (runSkillFn, skillsTableName, registryBucket props)
│   │   ├── ecs-stack.ts                  # SPEC-02
│   │   ├── knowledge-store-stack.ts      # SPEC-03
│   │   ├── monitoring-stack.ts           # SPEC-03
│   │   ├── compliance-stack.ts           # SPEC-03 + SPEC-06 (Bedrock logging)
│   │   ├── batch-stack.ts                # SPEC-08 + SPEC-12 Fix 6-7-8 (env vars, perms, GSI)
│   │   ├── mcp-stack.ts                  # SPEC-09 + this spec (no desktop route)
│   │   └── skill-registry-stack.ts       # SPEC-10 + SPEC-12 Fix 13 + SPEC-13 Fix 8
│   ├── aspects/
│   │   ├── no-wildcard-iam.ts            # SPEC-01
│   │   ├── encryption-enforcer.ts        # SPEC-01
│   │   └── tagging-enforcer.ts           # SPEC-01
│   └── test/
│       ├── helpers.ts                    # SPEC-13 (authoritative buildTestApp)
│       ├── network-stack.test.ts
│       ├── security-stack.test.ts
│       ├── storage-stack.test.ts
│       ├── messaging-stack.test.ts
│       ├── lambda-stack.test.ts
│       ├── ecs-stack.test.ts
│       ├── knowledge-store-stack.test.ts
│       ├── skill-registry-stack.test.ts
│       ├── batch-stack.test.ts
│       ├── mcp-stack.test.ts
│       ├── monitoring-stack.test.ts
│       └── compliance-stack.test.ts
│
├── packages/
│   ├── shared/
│   │   ├── package.json                  # SPEC-12 Fix 9-10
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts                  # SPEC-12 Fix 9
│   │       ├── types.ts                  # SPEC-02 + SPEC-08 + SPEC-10 + SPEC-11 + SPEC-13 Fix 9
│   │       ├── constants.ts
│   │       ├── validator.ts              # SPEC-11 Fix 1 (moved from lambda)
│   │       ├── crypto.ts                 # SPEC-06
│   │       └── utils.ts                  # SPEC-12 Fix 11 (clampConcurrency, parseSkillRef)
│   │
│   ├── lambda/
│   │   ├── package.json                  # this spec Fix 8
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── ingestion/
│   │       │   ├── handler.ts            # SPEC-02 + SPEC-10 + SPEC-11 (runId, skillName, GSI5)
│   │       │   └── validator.ts          # shim → re-exports from @skills-svc/shared
│   │       ├── results-processor/
│   │       │   ├── handler.ts            # SPEC-02 + SPEC-06 (envelopeDecrypt, DLP)
│   │       │   └── indexer.ts            # SPEC-02 + SPEC-06 (dlpScan, skill fields)
│   │       ├── query/
│   │       │   └── handler.ts            # SPEC-03 (callerUserArn, row-level security)
│   │       ├── run-skill/
│   │       │   └── handler.ts            # SPEC-11 Fix 8 + SPEC-12 Fix 1
│   │       ├── skill-validator/
│   │       │   └── handler.ts            # SPEC-10
│   │       ├── schedule-trigger/
│   │       │   └── handler.ts            # SPEC-07
│   │       ├── batch-submit/
│   │       │   └── handler.ts            # SPEC-11 Fix 15
│   │       ├── batch-status/
│   │       │   └── handler.ts            # SPEC-11 Fix 15
│   │       ├── bootstrap-index/
│   │       │   └── handler.ts            # SPEC-03 (OpenSearch index bootstrap)
│   │       └── mcp/
│   │           ├── handler.ts            # SPEC-09 + this spec (clean callerArn)
│   │           ├── server.ts             # SPEC-09
│   │           ├── types.ts              # SPEC-09
│   │           ├── tools/
│   │           │   ├── index.ts
│   │           │   ├── submit-job.ts     # SPEC-09 + SPEC-10 (skill_ref via RunSkillLambda)
│   │           │   ├── query.ts          # SPEC-09
│   │           │   ├── job-status.ts     # SPEC-09
│   │           │   ├── list-jobs.ts      # SPEC-09
│   │           │   ├── get-result.ts     # SPEC-09
│   │           │   └── cancel-job.ts     # SPEC-09
│   │           └── resources/
│   │               └── index.ts          # SPEC-09
│   │
│   ├── ecs-runner/
│   │   ├── package.json                  # this spec Fix 6
│   │   ├── tsconfig.json                 # this spec Fix 6
│   │   ├── Dockerfile                    # SPEC-06
│   │   ├── .dockerignore
│   │   └── src/
│   │       ├── main.ts                   # SPEC-02 + SPEC-06 (SIGTERM, wipe, verify)
│   │       ├── downloader.ts             # SPEC-02
│   │       ├── extractor.ts              # SPEC-02
│   │       ├── runner.ts                 # SPEC-06 (Bedrock) + SPEC-13 (token counts)
│   │       ├── uploader.ts               # SPEC-06 (envelope encrypt)
│   │       └── job-status.ts             # SPEC-13 Fix 9 (token counts param)
│   │
│   ├── knowledge-store/
│   │   ├── package.json                  # this spec Fix 7
│   │   ├── tsconfig.json                 # this spec Fix 7
│   │   └── src/
│   │       ├── index.ts
│   │       ├── client.ts                 # SPEC-03
│   │       ├── embeddings.ts             # SPEC-03
│   │       ├── indexer.ts                # SPEC-03 + SPEC-06 (DLP, skill fields)
│   │       └── searcher.ts               # SPEC-03 + SPEC-06 (user_arn filter)
│   │
│   └── cli/
│       ├── package.json                  # this spec Fix 9
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts                  # SPEC-03 + all command registrations
│           ├── commands/
│           │   ├── configure.ts          # SPEC-12 Fix 17 + SPEC-13 Fix 11
│           │   ├── assume-role.ts        # SPEC-03
│           │   ├── upload.ts             # SPEC-03 + SPEC-07 (--stream)
│           │   ├── status.ts             # SPEC-03
│           │   ├── list-jobs.ts          # SPEC-03
│           │   ├── query.ts              # SPEC-03 + SPEC-06 (callerUserArn)
│           │   ├── results.ts            # SPEC-03
│           │   ├── logs.ts               # SPEC-07
│           │   ├── validate.ts           # SPEC-07
│           │   ├── watch.ts              # SPEC-07
│           │   ├── schedule.ts           # SPEC-07
│           │   ├── cancel.ts             # SPEC-08
│           │   ├── profile.ts            # SPEC-08
│           │   ├── batch.ts              # SPEC-08 + SPEC-12 Fix 5-8
│           │   ├── diff.ts               # SPEC-08
│           │   ├── cost.ts               # SPEC-08
│           │   ├── notify.ts             # SPEC-08 + SPEC-11 (full ARN in list)
│           │   ├── audit.ts              # SPEC-08
│           │   ├── skill.ts              # SPEC-10 + SPEC-12 Fix 11 (parseSkillRef from shared)
│           │   ├── run.ts                # SPEC-10 + SPEC-11 Fix 8 (RunSkillLambda)
│           │   └── mcp-config.ts         # this spec (clean, SigV4 only)
│           └── utils/
│               ├── config.ts             # SPEC-12 Fix 11 (authoritative CliConfig)
│               ├── aws-clients.ts        # SPEC-03
│               ├── pretty-print.ts       # SPEC-03
│               ├── log-streamer.ts       # SPEC-07
│               ├── token-counter.ts      # SPEC-07
│               ├── zipper.ts             # SPEC-07
│               └── cache.ts              # SPEC-08
│
├── scripts/
│   ├── qa-run-all.sh                     # SPEC-05 + all QA additions
│   ├── deploy.sh                         # SPEC-13 Fix 4 (authoritative 12-stack order)
│   ├── build-push-ecs.sh
│   └── smoke-test.sh
│
├── docs/
│   └── break-glass-runbook.md            # SPEC-06
│
└── .github/
    └── workflows/
        ├── ci.yml                        # SPEC-05 + SPEC-06 (ECR gate, SBOM)
        └── deploy.yml
```

**Files that must NOT be created** (introduced then removed):
- `packages/lambda/src/mcp-authorizer/handler.ts` — Claude Desktop only, removed this spec

---

## QA Check Updates (QA-191 through QA-193)

```typescript
// QA-191: CLI package.json does NOT include @aws-sdk/client-secrets-manager
test('QA-191: CLI package.json has no @aws-sdk/client-secrets-manager dependency', () => {
  const pkg = JSON.parse(readFileSync('packages/cli/package.json', 'utf-8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  expect(Object.keys(deps)).not.toContain('@aws-sdk/client-secrets-manager');
});

// QA-192: Lambda package.json includes @aws-sdk/client-secrets-manager (for webhook)
test('QA-192: Lambda package.json has @aws-sdk/client-secrets-manager', () => {
  const pkg = JSON.parse(readFileSync('packages/lambda/package.json', 'utf-8'));
  expect(Object.keys(pkg.dependencies ?? {})).toContain('@aws-sdk/client-secrets-manager');
});

// QA-193: mcp-authorizer directory does not exist
test('QA-193: mcp-authorizer handler file must not exist', () => {
  const exists = require('fs').existsSync(
    'packages/lambda/src/mcp-authorizer/handler.ts'
  );
  expect(exists).toBe(false);
});
```

---

## Final Spec Index

| Spec | Lines | Purpose |
|------|-------|---------|
| SPEC-01 | 966 | Architecture, VPC, CDK stack design, SSM layout |
| SPEC-02 | 1,358 | Storage, Messaging, Lambda, ECS stacks + handlers |
| SPEC-03 | 1,367 | Knowledge store, CLI commands, monitoring, compliance |
| SPEC-04 | 1,229 | QA-001–050 |
| SPEC-05 | 1,412 | QA-051–100, deployment runbook, cost model |
| SPEC-06 | ~1,600 | Security: Bedrock migration, envelope encryption, DLP, SCPs |
| SPEC-07 | 1,641 | CLI: validate, --stream, watch, schedule |
| SPEC-08 | 1,735 | CLI: cancel, profiles, cache, batch, diff, cost, notify, audit |
| SPEC-09 | 1,412 | MCP server: 6 tools, 1 resource, Claude Code integration |
| SPEC-10 | 1,767 | Skill Registry: DDB schema, validator Lambda, skill/run CLI |
| SPEC-11 | 1,457 | Errata I: 25 fixes (shared validator, GSIs, IAM, batch handlers) |
| SPEC-12 | 1,069 | Errata II: 30 fixes (RunSkillLambda wiring, buildTestApp, imports) |
| SPEC-13 | 1,055 | Errata III: 14 fixes (empty env vars, deploy order, token counts) |
| SPEC-14 | ~600 | Cleanup: remove Claude Desktop, authoritative package.json files |
| **Total** | **~18,700** | |
