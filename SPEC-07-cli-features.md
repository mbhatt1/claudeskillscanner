# Skills as a Service (SaaS) — Specification Part 7: CLI Features

**Version:** 1.0.0  
**Status:** AUTHORITATIVE  
**Parts:** [Part 1](SPEC-01-overview-architecture.md) | [Part 2](SPEC-02-lambda-ecs.md) | [Part 3](SPEC-03-knowledge-store-cli.md) | [Part 4](SPEC-04-qa-layers-1-50.md) | [Part 5](SPEC-05-qa-layers-51-100-deployment.md) | [Part 6](SPEC-06-security-hardening.md) | [Part 7: CLI Features]

---

## Overview

Four new CLI features added to `packages/cli/src/`:

| Feature | Command | New Files | New AWS Resources |
|---------|---------|-----------|-------------------|
| Local Validation | `skills-svc validate <zip>` | `commands/validate.ts`, `utils/token-counter.ts` | None — fully local |
| Streaming Results | `skills-svc upload --stream` | `utils/log-streamer.ts` | None — uses existing CloudWatch Logs |
| Watch Mode | `skills-svc watch <dir>` | `commands/watch.ts`, `utils/watcher.ts` | None — uses existing upload pipeline |
| Scheduled Jobs | `skills-svc schedule <sub>` | `commands/schedule.ts` | EventBridge Scheduler, DDB GSI3 |

All four share the existing `aws-clients.ts`, `config.ts`, and `pretty-print.ts` utilities.

---

## Feature 1: `skills-svc validate`

### Purpose
Run all zip validations locally before uploading. Catches errors instantly — no ECS task wasted, no job record created. Also estimates token count and cost.

### Command Signature

```bash
skills-svc validate <zip-path> [options]

Arguments:
  zip-path                  Path to the skills zip file

Options:
  --strict                  Fail on warnings (default: warnings are printed but exit 0)
  --estimate-cost           Print Bedrock cost estimate (default: true)
  --model <model-id>        Model to estimate against (default: anthropic.claude-3-5-sonnet-20241022-v2:0)
  --json                    Output results as JSON (for scripting)
```

### Example Output

```
$ skills-svc validate ./my-skills.zip

Validating my-skills.zip...

  Structure
  ─────────────────────────────────────────────
  ✅  Magic bytes         Valid ZIP archive
  ✅  manifest.json       Found and valid
  ✅  Skills declared     4 (greet, analyze, summarize, classify)
  ✅  Skill files         All 4 found in skills/
  ✅  Compressed size     2.3 MB (limit: 500 MB)
  ✅  Path traversal      No unsafe entries
  ✅  File count          12 files (limit: 10,000)
  ⚠   defaultPrompt       Not set — will use default analysis prompt

  Token Estimate (anthropic.claude-3-5-sonnet-20241022-v2:0)
  ─────────────────────────────────────────────
  Skill content tokens    ~3,420
  System prompt tokens    ~180
  Total input tokens      ~3,600
  Expected output tokens  ~2,000 (estimated)
  Total tokens            ~5,600

  Cost Estimate
  ─────────────────────────────────────────────
  Input  ($3.00 / 1M tokens)    $0.0108
  Output ($15.00 / 1M tokens)   $0.0300
  ECS Fargate (est. 3 min)      $0.0046
  ─────────────────────────────────────────────
  Estimated total               $0.0454

  Result: PASS (1 warning)
  Ready to upload: skills-svc upload ./my-skills.zip --job-name "my-job"
```

### `packages/cli/src/commands/validate.ts`

```typescript
import { Command } from 'commander';
import { statSync, readFileSync } from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { validateZipStructure, ZipManifest } from '@skills-svc/shared';
import { estimateTokens, estimateCost, ModelPricing } from '../utils/token-counter';
import { prettyJson } from '../utils/pretty-print';

const MAX_COMPRESSED_BYTES = 500 * 1024 * 1024;
const DEFAULT_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

interface ValidationReport {
  file: string;
  fileSizeBytes: number;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; detail: string }>;
  manifest?: ZipManifest;
  tokenEstimate?: TokenEstimate;
  costEstimate?: CostEstimate;
  passed: boolean;
  warnings: number;
  errors: number;
}

interface TokenEstimate {
  skillTokens: number;
  systemTokens: number;
  totalInput: number;
  estimatedOutput: number;
  total: number;
}

interface CostEstimate {
  inputCostUsd: number;
  outputCostUsd: number;
  ecsFargateCostUsd: number;
  totalUsd: number;
  modelId: string;
}

export function validateCommand(): Command {
  return new Command('validate')
    .description('Validate a skills zip locally — checks structure, tokens, and estimates cost')
    .argument('<zip-path>', 'Path to the skills zip file')
    .option('--strict', 'Exit non-zero on warnings', false)
    .option('--no-estimate-cost', 'Skip cost estimation')
    .option('--model <model-id>', 'Bedrock model ID for cost estimation', DEFAULT_MODEL)
    .option('--json', 'Output as JSON', false)
    .action(async (zipPath: string, opts: {
      strict: boolean;
      estimateCost: boolean;
      model: string;
      json: boolean;
    }) => {
      const report: ValidationReport = {
        file: path.resolve(zipPath),
        fileSizeBytes: 0,
        checks: [],
        passed: false,
        warnings: 0,
        errors: 0,
      };

      const addCheck = (name: string, status: 'pass' | 'fail' | 'warn', detail: string) => {
        report.checks.push({ name, status, detail });
        if (status === 'fail') report.errors++;
        if (status === 'warn') report.warnings++;
      };

      // ── File existence ──────────────────────────────────────────────
      let zipBuffer: Buffer;
      try {
        const stat = statSync(zipPath);
        report.fileSizeBytes = stat.size;
        addCheck('File exists', 'pass', `${(stat.size / 1024 / 1024).toFixed(2)} MB`);

        if (stat.size > MAX_COMPRESSED_BYTES) {
          addCheck('Compressed size', 'fail', `${(stat.size / 1024 / 1024).toFixed(0)} MB exceeds 500 MB limit`);
        } else {
          addCheck('Compressed size', 'pass', `${(stat.size / 1024 / 1024).toFixed(2)} MB (limit: 500 MB)`);
        }

        zipBuffer = readFileSync(zipPath);
      } catch (err) {
        addCheck('File exists', 'fail', `Cannot read file: ${String(err)}`);
        printReport(report, opts.json);
        process.exit(1);
      }

      // ── Structural validation (reuses shared validator) ─────────────
      const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      if (zipBuffer.slice(0, 4).equals(ZIP_MAGIC)) {
        addCheck('Magic bytes', 'pass', 'Valid ZIP archive');
      } else {
        addCheck('Magic bytes', 'fail', 'File is not a valid ZIP (bad magic bytes)');
      }

      const validation = validateZipStructure(zipBuffer);

      if (validation.valid && validation.manifest) {
        report.manifest = validation.manifest;
        addCheck('manifest.json', 'pass', 'Found and valid');
        addCheck(
          'Skills declared',
          'pass',
          `${validation.manifest.skills.length} (${validation.manifest.skills.join(', ')})`,
        );
        addCheck('Skill files', 'pass', `All ${validation.manifest.skills.length} found in skills/`);

        if (!validation.manifest.defaultPrompt) {
          addCheck('defaultPrompt', 'warn', 'Not set — will use default analysis prompt');
        } else {
          addCheck('defaultPrompt', 'pass', `"${validation.manifest.defaultPrompt.slice(0, 60)}..."`);
        }
      } else {
        addCheck('manifest.json', 'fail', validation.error ?? 'Validation failed');
      }

      // ── Path traversal check ─────────────────────────────────────────
      const AdmZip = require('adm-zip');
      try {
        const zip = new AdmZip(zipBuffer);
        const entries = zip.getEntries() as Array<{ entryName: string }>;
        const traversal = entries.find(e =>
          e.entryName.startsWith('/') || e.entryName.includes('../') || e.entryName.includes('..\\')
        );
        if (traversal) {
          addCheck('Path traversal', 'fail', `Unsafe entry: ${traversal.entryName}`);
        } else {
          addCheck('Path traversal', 'pass', 'No unsafe entries');
        }
        addCheck('File count', 'pass', `${entries.length} files (limit: 10,000)`);
      } catch {
        addCheck('Path traversal', 'warn', 'Could not inspect entries');
      }

      // ── Token + cost estimate ────────────────────────────────────────
      if (opts.estimateCost && report.manifest) {
        const skillText = buildSkillText(zipBuffer, report.manifest);
        const tokenEst = estimateTokens(skillText, report.manifest.defaultPrompt);
        report.tokenEstimate = tokenEst;

        if (opts.estimateCost) {
          report.costEstimate = estimateCost(tokenEst, opts.model);
        }
      }

      report.passed = report.errors === 0;

      if (opts.json) {
        prettyJson(report);
      } else {
        printReport(report, false);
      }

      const shouldFail = report.errors > 0 || (opts.strict && report.warnings > 0);
      process.exit(shouldFail ? 1 : 0);
    });
}

function buildSkillText(zipBuffer: Buffer, manifest: ZipManifest): string {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipBuffer);
  const parts: string[] = [];
  for (const skill of manifest.skills) {
    const entry = zip.getEntry(`skills/${skill}.md`) ?? zip.getEntry(`skills/${skill}`);
    if (entry) parts.push(entry.getData().toString('utf-8'));
  }
  return parts.join('\n\n');
}

function printReport(report: ValidationReport, asJson: boolean): void {
  if (asJson) return; // handled by caller

  console.log(`\nValidating ${path.basename(report.file)}...\n`);

  console.log('  ' + chalk.bold('Structure'));
  console.log('  ' + '─'.repeat(45));
  for (const check of report.checks) {
    const icon = check.status === 'pass' ? chalk.green('✅') :
                 check.status === 'warn' ? chalk.yellow('⚠ ') : chalk.red('❌');
    const name = check.name.padEnd(22);
    console.log(`  ${icon}  ${name} ${chalk.dim(check.detail)}`);
  }

  if (report.tokenEstimate) {
    const t = report.tokenEstimate;
    console.log('\n  ' + chalk.bold(`Token Estimate (${report.costEstimate?.modelId ?? 'unknown'})`));
    console.log('  ' + '─'.repeat(45));
    console.log(`  Skill content tokens    ~${t.skillTokens.toLocaleString()}`);
    console.log(`  System prompt tokens    ~${t.systemTokens.toLocaleString()}`);
    console.log(`  Total input tokens      ~${t.totalInput.toLocaleString()}`);
    console.log(`  Expected output tokens  ~${t.estimatedOutput.toLocaleString()} (estimated)`);
    console.log(`  Total tokens            ~${t.total.toLocaleString()}`);
  }

  if (report.costEstimate) {
    const c = report.costEstimate;
    console.log('\n  ' + chalk.bold('Cost Estimate'));
    console.log('  ' + '─'.repeat(45));
    console.log(`  Input  ($3.00 / 1M tokens)    $${c.inputCostUsd.toFixed(4)}`);
    console.log(`  Output ($15.00 / 1M tokens)   $${c.outputCostUsd.toFixed(4)}`);
    console.log(`  ECS Fargate (est. ~3 min)      $${c.ecsFargateCostUsd.toFixed(4)}`);
    console.log('  ' + '─'.repeat(45));
    console.log(`  Estimated total               ${chalk.bold('$' + c.totalUsd.toFixed(4))}`);
  }

  console.log();
  if (report.passed) {
    const warnMsg = report.warnings > 0 ? chalk.yellow(` (${report.warnings} warning${report.warnings > 1 ? 's' : ''})`) : '';
    console.log(`  Result: ${chalk.green('PASS')}${warnMsg}`);
    console.log(`  Ready to upload: ${chalk.cyan(`skills-svc upload ${path.basename(report.file)} --job-name "my-job"`)}`);
  } else {
    console.log(`  Result: ${chalk.red(`FAIL (${report.errors} error${report.errors > 1 ? 's' : ''})`)} `);
    console.log(`  Fix the errors above before uploading.`);
  }
  console.log();
}
```

### `packages/cli/src/utils/token-counter.ts`

```typescript
// Approximate token counting without calling an external API
// Uses the cl100k_base encoding heuristic: ~4 chars per token for English text

const CHARS_PER_TOKEN = 4;
const SYSTEM_PROMPT_TOKENS = 180; // fixed overhead from runner.ts system prompt

// Bedrock Claude pricing (us-east-1, on-demand, as of 2025)
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'anthropic.claude-3-haiku-20240307-v1:0':    { inputPer1M: 0.25,  outputPer1M: 1.25  },
  'anthropic.claude-opus-4-7':                 { inputPer1M: 15.00, outputPer1M: 75.00 },
};

// ECS Fargate pricing (2 vCPU, 4GB, us-east-1)
const ECS_CPU_PER_HOUR  = 0.04048;  // per vCPU-hour
const ECS_MEM_PER_HOUR  = 0.004445; // per GB-hour
const ECS_VCPU          = 2;
const ECS_GB            = 4;
const ESTIMATED_MINUTES = 3;        // conservative estimate for skill runs

export interface TokenEstimate {
  skillTokens: number;
  systemTokens: number;
  totalInput: number;
  estimatedOutput: number;
  total: number;
}

export interface CostEstimate {
  inputCostUsd: number;
  outputCostUsd: number;
  ecsFargateCostUsd: number;
  totalUsd: number;
  modelId: string;
}

export function estimateTokens(skillText: string, prompt?: string): TokenEstimate {
  const skillTokens   = Math.ceil(skillText.length / CHARS_PER_TOKEN);
  const promptTokens  = prompt ? Math.ceil(prompt.length / CHARS_PER_TOKEN) : 50;
  const totalInput    = skillTokens + promptTokens + SYSTEM_PROMPT_TOKENS;
  // Claude typically outputs ~55% of input token count for analysis tasks
  const estimatedOutput = Math.ceil(totalInput * 0.55);

  return {
    skillTokens,
    systemTokens: SYSTEM_PROMPT_TOKENS + promptTokens,
    totalInput,
    estimatedOutput,
    total: totalInput + estimatedOutput,
  };
}

export function estimateCost(tokens: TokenEstimate, modelId: string): CostEstimate {
  const pricing = MODEL_PRICING[modelId] ?? MODEL_PRICING['anthropic.claude-3-5-sonnet-20241022-v2:0'];

  const inputCostUsd  = (tokens.totalInput    / 1_000_000) * pricing.inputPer1M;
  const outputCostUsd = (tokens.estimatedOutput / 1_000_000) * pricing.outputPer1M;
  const ecsFargateCostUsd = (ESTIMATED_MINUTES / 60) * (
    ECS_VCPU * ECS_CPU_PER_HOUR + ECS_GB * ECS_MEM_PER_HOUR
  );

  return {
    inputCostUsd,
    outputCostUsd,
    ecsFargateCostUsd,
    totalUsd: inputCostUsd + outputCostUsd + ecsFargateCostUsd,
    modelId,
  };
}
```

---

## Feature 2: `skills-svc upload --stream`

### Purpose
After uploading, instead of printing "use `skills-svc status`", tail the ECS CloudWatch log group in real-time. Shows Bedrock output as it streams from the container. Feels like a local CLI tool despite running on Fargate.

### Command Changes

```bash
# Existing:
skills-svc upload ./skills.zip --job-name "demo"

# New flag:
skills-svc upload ./skills.zip --job-name "demo" --stream
skills-svc upload ./skills.zip --job-name "demo" --stream --stream-timeout 1800
```

The `--stream` flag uploads normally then immediately enters streaming mode — equivalent to auto-running `skills-svc logs <job-id> --follow` after upload completes.

### `packages/cli/src/utils/log-streamer.ts`

```typescript
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  FilteredLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import chalk from 'chalk';
import { JobStatus, DDB_KEY_PREFIX } from '@skills-svc/shared';
import { CliConfig } from './config';
import { getCredentialProvider } from './aws-clients';

const POLL_INTERVAL_MS    = 2_000;
const JOB_START_TIMEOUT_MS = 120_000; // 2 min to wait for ECS task to start
const LOG_GROUP_TEMPLATE  = '/skills-svc/{env}/ecs/runner';

export interface StreamOptions {
  jobId: string;
  cfg: CliConfig;
  timeoutMs?: number;
  onEvent?: (line: string, timestamp: Date) => void;
}

export async function streamJobLogs(opts: StreamOptions): Promise<JobStatus> {
  const { jobId, cfg } = opts;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000; // 30 min default
  const logGroup  = LOG_GROUP_TEMPLATE.replace('{env}', cfg.envName);
  const logFilter = `{ $.jobId = "${jobId}" }`;

  const credProvider = await getCredentialProvider();
  const cwl = new CloudWatchLogsClient({ region: cfg.region, credentials: credProvider });
  const ddb = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: cfg.region, credentials: credProvider })
  );

  console.log(chalk.dim(`\nStreaming logs for job ${jobId}...`));
  console.log(chalk.dim(`Log group: ${logGroup}\n`));

  const startTime  = Date.now();
  let lastEventTime = Date.now() - 5_000; // start slightly in the past
  let taskStarted  = false;
  let finalStatus: JobStatus = JobStatus.RUNNING;

  // Spinner while waiting for ECS task to start
  const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinIdx = 0;

  const printSpin = (msg: string) => {
    process.stdout.write(`\r${chalk.cyan(spinFrames[spinIdx++ % spinFrames.length])}  ${msg}   `);
  };

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      console.log(chalk.yellow(`\n⚠  Stream timeout after ${timeoutMs / 1000}s`));
      break;
    }

    // Poll DDB for final status
    const jobRes = await ddb.send(new GetCommand({
      TableName: cfg.dynamodbTableName,
      Key: { PK: `${DDB_KEY_PREFIX.JOB}${jobId}`, SK: 'METADATA' },
    }));
    const status = jobRes.Item?.status as JobStatus | undefined;

    if (status === JobStatus.COMPLETE || status === JobStatus.FAILED) {
      finalStatus = status;
      // Drain any remaining logs
      await drainLogs(cwl, logGroup, logFilter, lastEventTime, opts.onEvent);
      break;
    }

    // Poll CloudWatch Logs
    try {
      const events = await cwl.send(new FilterLogEventsCommand({
        logGroupName: logGroup,
        filterPattern: logFilter,
        startTime: lastEventTime,
        limit: 100,
      }));

      const newEvents = (events.events ?? []).filter(
        e => (e.timestamp ?? 0) > lastEventTime - 1000
      );

      if (newEvents.length > 0) {
        if (!taskStarted) {
          process.stdout.write('\n'); // clear spinner line
          taskStarted = true;
        }
        for (const ev of newEvents) {
          renderLogEvent(ev);
          opts.onEvent?.(ev.message ?? '', new Date(ev.timestamp ?? 0));
          lastEventTime = Math.max(lastEventTime, (ev.timestamp ?? 0) + 1);
        }
      } else {
        if (!taskStarted) {
          const waitMsg = elapsed < JOB_START_TIMEOUT_MS
            ? `Waiting for ECS task to start (${Math.floor(elapsed / 1000)}s)...`
            : `ECS task running (${Math.floor(elapsed / 1000)}s elapsed)...`;
          printSpin(waitMsg);
        }
      }
    } catch (err: any) {
      if (err.name !== 'ResourceNotFoundException') throw err;
      // Log group not yet created — task hasn't started
      printSpin(`Waiting for log group... (${Math.floor(elapsed / 1000)}s)`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return finalStatus;
}

async function drainLogs(
  cwl: CloudWatchLogsClient,
  logGroup: string,
  filterPattern: string,
  since: number,
  onEvent?: StreamOptions['onEvent'],
): Promise<void> {
  await sleep(2000); // give CWL a moment to flush
  const events = await cwl.send(new FilterLogEventsCommand({
    logGroupName: logGroup,
    filterPattern,
    startTime: since,
    limit: 500,
  }));
  for (const ev of events.events ?? []) {
    renderLogEvent(ev);
    onEvent?.(ev.message ?? '', new Date(ev.timestamp ?? 0));
  }
}

function renderLogEvent(ev: FilteredLogEvent): void {
  const ts  = new Date(ev.timestamp ?? 0).toLocaleTimeString();
  const msg = ev.message?.trim() ?? '';

  // Parse JSON log lines (our structured logs)
  try {
    const parsed = JSON.parse(msg) as Record<string, unknown>;
    const event  = parsed.event as string | undefined;
    const prefix = chalk.dim(`[${ts}]`);

    switch (event) {
      case 'task_start':
        console.log(`${prefix} ${chalk.blue('▶ Task started')} — job: ${parsed.jobId}`);
        break;
      case 'zip_downloaded':
        console.log(`${prefix} ${chalk.blue('⬇ Zip downloaded')}`);
        break;
      case 'checksum_verified':
        console.log(`${prefix} ${chalk.green('✓ Checksum verified')}`);
        break;
      case 'task_complete':
        console.log(`${prefix} ${chalk.green('✅ Task complete')} — result: ${parsed.resultKey}`);
        break;
      case 'task_error':
        console.log(`${prefix} ${chalk.red('❌ Task error:')} ${parsed.err}`);
        break;
      case 'workspace_cleared':
        console.log(`${prefix} ${chalk.dim('🧹 Workspace cleared')}`);
        break;
      case 'dlp_findings_redacted':
        console.log(`${prefix} ${chalk.yellow(`⚠  DLP: ${parsed.findingCount} finding(s) redacted before indexing`)}`);
        break;
      default:
        // Raw line for non-structured logs
        console.log(`${prefix} ${chalk.dim(msg.slice(0, 200))}`);
    }
  } catch {
    // Non-JSON log line — print as-is
    console.log(`${chalk.dim(`[${ts}]`)} ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
```

### Updated `packages/cli/src/commands/upload.ts`

Add `--stream` flag and post-upload streaming logic:

```typescript
// Add to existing uploadCommand() options:
.option('--stream', 'Stream ECS task logs to stdout after upload', false)
.option('--stream-timeout <seconds>', 'Max seconds to stream before detaching', '1800')

// After successful S3 PutObject, add:
if (opts.stream) {
  console.log(chalk.dim('\nStreaming mode enabled — tailing job logs...\n'));

  // Poll DDB for the job ID (Lambda creates it asynchronously)
  let jobId: string | undefined;
  const pollStart = Date.now();
  while (!jobId && Date.now() - pollStart < 30_000) {
    await sleep(2_000);
    // Query GSI2 by userArn + recent timestamp to find the new job
    const res = await ddb.send(new QueryCommand({
      TableName: cfg.dynamodbTableName,
      IndexName: 'GSI2-User',
      KeyConditionExpression: 'GSI2PK = :userPk AND GSI2SK >= :since',
      ExpressionAttributeValues: {
        ':userPk': `USER#${identity.Arn}`,
        ':since': `CREATED_AT#${new Date(Date.now() - 60_000).toISOString()}`,
      },
      ScanIndexForward: false,
      Limit: 1,
    }));
    jobId = res.Items?.[0]?.jobId as string | undefined;
  }

  if (!jobId) {
    console.log(chalk.yellow('⚠  Could not determine job ID for streaming. Use `skills-svc list-jobs` to find it.'));
    return;
  }

  console.log(`Job ID: ${chalk.cyan(jobId)}\n`);

  const finalStatus = await streamJobLogs({
    jobId,
    cfg,
    timeoutMs: parseInt(opts.streamTimeout, 10) * 1000,
  });

  console.log();
  if (finalStatus === JobStatus.COMPLETE) {
    console.log(chalk.green(`✅ Job complete. Run: ${chalk.cyan(`skills-svc results ${jobId}`)}`));
  } else if (finalStatus === JobStatus.FAILED) {
    console.log(chalk.red(`❌ Job failed. Run: ${chalk.cyan(`skills-svc status ${jobId}`)} for details.`));
    process.exit(1);
  } else {
    console.log(chalk.yellow(`⏸  Detached from stream. Job still running.`));
    console.log(`   Track: ${chalk.cyan(`skills-svc logs ${jobId} --follow`)}`);
  }
}
```

### Updated `packages/cli/src/commands/logs.ts`

Wire `--follow` to `streamJobLogs`:

```typescript
import { Command } from 'commander';
import { streamJobLogs } from '../utils/log-streamer';
import { loadConfig } from '../utils/config';
import chalk from 'chalk';

export function logsCommand(): Command {
  return new Command('logs')
    .description('Fetch or tail logs for a job')
    .argument('<job-id>', 'Job ID to fetch logs for')
    .option('--follow', 'Tail logs in real-time until job completes', false)
    .option('--tail <n>', 'Show last N log lines (without --follow)', '100')
    .option('--stream-timeout <seconds>', 'Max seconds to follow before detaching', '1800')
    .action(async (jobId: string, opts: { follow: boolean; tail: string; streamTimeout: string }) => {
      const cfg = await loadConfig();

      if (opts.follow) {
        await streamJobLogs({
          jobId,
          cfg,
          timeoutMs: parseInt(opts.streamTimeout, 10) * 1000,
        });
      } else {
        // Non-follow: fetch last N lines from CloudWatch Logs
        const { CloudWatchLogsClient, FilterLogEventsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
        const { getCredentialProvider } = await import('../utils/aws-clients');
        const credProvider = await getCredentialProvider();
        const cwl = new CloudWatchLogsClient({ region: cfg.region, credentials: credProvider });
        const logGroup = `/skills-svc/${cfg.envName}/ecs/runner`;

        const res = await cwl.send(new FilterLogEventsCommand({
          logGroupName: logGroup,
          filterPattern: `{ $.jobId = "${jobId}" }`,
          limit: parseInt(opts.tail, 10),
          startTime: Date.now() - 24 * 60 * 60 * 1000, // last 24h
        }));

        if (!res.events?.length) {
          console.log(chalk.yellow('No logs found for this job.'));
          return;
        }

        for (const ev of res.events) {
          const ts = new Date(ev.timestamp ?? 0).toLocaleTimeString();
          console.log(`${chalk.dim(`[${ts}]`)} ${ev.message?.trim()}`);
        }
      }
    });
}
```

---

## Feature 3: `skills-svc watch`

### Purpose
Watch a local directory for `.md` skill file changes. On any save, auto-zip the directory, validate it, upload it, and stream the result. Turns the system into a live REPL for skill development — tight edit→run→result loop without manual zip/upload steps.

### Command Signature

```bash
skills-svc watch <skills-dir> [options]

Arguments:
  skills-dir                Directory containing skills/ and manifest.json

Options:
  --job-name <name>         Job name prefix (default: dir basename + timestamp)
  --debounce <ms>           Milliseconds to debounce file changes (default: 1500)
  --no-stream               Upload but don't stream logs (fire-and-forget)
  --ignore <patterns>       Comma-separated glob patterns to ignore (default: "*.tmp,*.swp")
  --max-runs <n>            Stop after N runs (default: unlimited)
  --on-fail <action>        Action on job failure: continue|stop (default: continue)
```

### Example Output

```
$ skills-svc watch ./my-skills --job-name "dev-run"

  👁  Watching ./my-skills for changes
  Debounce: 1500ms | Stream: enabled | Press Ctrl+C to stop

  ─────────────────────────────────────────────────────
  [10:14:22] Change detected: skills/analyze.md (modified)
  [10:14:24] Zipping directory... done (2.1 MB)
  [10:14:24] Validating...       PASS
  [10:14:24] Uploading...        done (job: dev-run-1715509464)
  [10:14:24] Streaming logs...
  [10:14:38] ▶ Task started
  [10:14:41] ⬇ Zip downloaded
  [10:14:41] ✓ Checksum verified
  [10:15:02] ✅ Task complete — result: results/abc123/result.json
  ─────────────────────────────────────────────────────
  Run #1 complete in 40s  |  Cost: ~$0.04  |  Job: dev-run-1715509464

  [10:15:02] Waiting for changes... (Ctrl+C to stop)
```

### `packages/cli/src/commands/watch.ts`

```typescript
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { streamJobLogs } from '../utils/log-streamer';
import { validateZipStructure } from '@skills-svc/shared';
import { zipDirectory } from '../utils/zipper';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { JobStatus, DDB_KEY_PREFIX } from '@skills-svc/shared';

export function watchCommand(): Command {
  return new Command('watch')
    .description('Watch a skills directory and auto-run on every change')
    .argument('<skills-dir>', 'Directory containing skills/ and manifest.json')
    .option('--job-name <name>', 'Job name prefix')
    .option('--debounce <ms>', 'Debounce delay in milliseconds', '1500')
    .option('--no-stream', 'Upload without streaming logs', false)
    .option('--ignore <patterns>', 'Comma-separated glob patterns to ignore', '*.tmp,*.swp,*.DS_Store')
    .option('--max-runs <n>', 'Stop after N runs (0 = unlimited)', '0')
    .option('--on-fail <action>', 'On failure: continue|stop', 'continue')
    .action(async (skillsDir: string, opts: {
      jobName?: string;
      debounce: string;
      stream: boolean;
      ignore: string;
      maxRuns: string;
      onFail: 'continue' | 'stop';
    }) => {
      const cfg        = await loadConfig();
      const absDir     = path.resolve(skillsDir);
      const debounceMs = parseInt(opts.debounce, 10);
      const maxRuns    = parseInt(opts.maxRuns, 10);
      const ignoreGlobs = opts.ignore.split(',').map(s => s.trim());
      const baseJobName = opts.jobName ?? path.basename(absDir);

      if (!fs.existsSync(absDir)) {
        console.error(chalk.red(`Directory not found: ${absDir}`));
        process.exit(1);
      }
      if (!fs.existsSync(path.join(absDir, 'manifest.json'))) {
        console.error(chalk.red(`manifest.json not found in ${absDir}`));
        process.exit(1);
      }

      console.log(chalk.bold(`\n  👁  Watching ${chalk.cyan(absDir)} for changes`));
      console.log(`  Debounce: ${debounceMs}ms | Stream: ${opts.stream ? 'enabled' : 'disabled'} | Press ${chalk.bold('Ctrl+C')} to stop\n`);

      let runCount   = 0;
      let running    = false;
      let debounceTimer: NodeJS.Timeout | null = null;

      const credProvider = await getCredentialProvider();
      const s3  = new S3Client({ region: cfg.region, credentials: credProvider });
      const sts = new STSClient({ region: cfg.region, credentials: credProvider });
      const ddb = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: cfg.region, credentials: credProvider })
      );
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      const triggerRun = async (changedFile: string) => {
        if (running) {
          console.log(chalk.dim(`  [${timestamp()}] Change in ${path.basename(changedFile)} queued (run in progress)`));
          return;
        }

        runCount++;
        if (maxRuns > 0 && runCount > maxRuns) {
          console.log(chalk.yellow(`\n  Max runs (${maxRuns}) reached. Stopping.`));
          process.exit(0);
        }

        running = true;
        const runStart = Date.now();
        const jobName  = `${baseJobName}-${Date.now()}`;
        console.log(`\n  ${'─'.repeat(55)}`);
        console.log(`  ${chalk.dim(`[${timestamp()}]`)} Change detected: ${chalk.cyan(path.relative(absDir, changedFile))} (modified)`);

        try {
          // 1. Zip the directory
          process.stdout.write(`  ${chalk.dim(`[${timestamp()}]`)} Zipping directory...    `);
          const tmpZip = path.join(os.tmpdir(), `skills-watch-${randomUUID()}.zip`);
          await zipDirectory(absDir, tmpZip, ignoreGlobs);
          const zipSize = fs.statSync(tmpZip).size;
          console.log(chalk.green(`done`) + chalk.dim(` (${(zipSize / 1024 / 1024).toFixed(1)} MB)`));

          // 2. Validate
          process.stdout.write(`  ${chalk.dim(`[${timestamp()}]`)} Validating...           `);
          const zipBuffer = fs.readFileSync(tmpZip);
          const validation = validateZipStructure(zipBuffer);
          if (!validation.valid) {
            console.log(chalk.red(`FAIL — ${validation.error}`));
            running = false;
            return;
          }
          console.log(chalk.green('PASS'));

          // 3. Upload
          process.stdout.write(`  ${chalk.dim(`[${timestamp()}]`)} Uploading...            `);
          const s3Key = `uploads/${randomUUID()}/${path.basename(absDir)}.zip`;
          await s3.send(new PutObjectCommand({
            Bucket: cfg.uploadsBucket,
            Key: s3Key,
            Body: zipBuffer,
            ContentType: 'application/zip',
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: cfg.uploadsKmsKeyId,
            ChecksumAlgorithm: 'SHA256',
            Metadata: {
              'job-name': jobName,
              'user-arn': identity.Arn!,
              'watch-mode': 'true',
            },
          }));
          console.log(chalk.green(`done`) + chalk.dim(` (job: ${jobName})`));

          // Cleanup temp zip
          fs.unlinkSync(tmpZip);

          if (!opts.stream) {
            console.log(`  ${chalk.dim(`[${timestamp()}]`)} ${chalk.green('Uploaded')} (fire-and-forget mode)`);
            running = false;
            return;
          }

          // 4. Resolve job ID from DDB
          console.log(`  ${chalk.dim(`[${timestamp()}]`)} Streaming logs...`);
          let jobId: string | undefined;
          const pollStart = Date.now();
          while (!jobId && Date.now() - pollStart < 30_000) {
            await sleep(2_000);
            const res = await ddb.send(new QueryCommand({
              TableName: cfg.dynamodbTableName,
              IndexName: 'GSI2-User',
              KeyConditionExpression: 'GSI2PK = :pk AND GSI2SK >= :since',
              ExpressionAttributeValues: {
                ':pk': `${DDB_KEY_PREFIX.USER}${identity.Arn}`,
                ':since': `CREATED_AT#${new Date(Date.now() - 60_000).toISOString()}`,
              },
              ScanIndexForward: false,
              Limit: 1,
            }));
            const candidate = res.Items?.[0];
            if (candidate?.jobName === jobName) jobId = candidate.jobId as string;
          }

          if (!jobId) {
            console.log(chalk.yellow(`  ⚠  Could not resolve job ID — detaching`));
            running = false;
            return;
          }

          // 5. Stream
          const finalStatus = await streamJobLogs({ jobId, cfg });
          const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);

          console.log(`  ${'─'.repeat(55)}`);
          if (finalStatus === JobStatus.COMPLETE) {
            console.log(`  Run #${runCount} ${chalk.green('complete')} in ${elapsed}s  |  Job: ${chalk.cyan(jobId)}`);
          } else if (finalStatus === JobStatus.FAILED) {
            console.log(`  Run #${runCount} ${chalk.red('FAILED')} in ${elapsed}s  |  Job: ${chalk.cyan(jobId)}`);
            if (opts.onFail === 'stop') {
              console.log(chalk.red('  --on-fail=stop: exiting watch mode'));
              process.exit(1);
            }
          }
        } catch (err) {
          console.log(chalk.red(`  Error: ${String(err)}`));
        } finally {
          running = false;
          console.log(`\n  ${chalk.dim(`[${timestamp()}]`)} Waiting for changes... (Ctrl+C to stop)`);
        }
      };

      // File watcher
      const watcher = fs.watch(absDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (ignoreGlobs.some(g => filename.endsWith(g.replace('*', '')))) return;
        if (filename.includes('.git/')) return;

        // Debounce: wait for rapid successive saves to settle
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          triggerRun(path.join(absDir, filename));
        }, debounceMs);
      });

      // Initial run on start
      await triggerRun(path.join(absDir, 'manifest.json'));

      // Keep process alive
      process.on('SIGINT', () => {
        watcher.close();
        console.log(chalk.dim('\n\n  Watch mode stopped.'));
        process.exit(0);
      });
    });
}

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
```

### `packages/cli/src/utils/zipper.ts`

```typescript
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

export async function zipDirectory(
  sourceDir: string,
  outputPath: string,
  ignorePatterns: string[] = [],
): Promise<void> {
  const zip = new AdmZip();

  const addDir = (dir: string, zipPrefix: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const zipPath  = path.join(zipPrefix, entry.name);

      // Apply ignore patterns
      if (ignorePatterns.some(p => {
        const ext = p.replace('*', '');
        return entry.name.endsWith(ext) || entry.name === p;
      })) continue;

      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        addDir(fullPath, zipPath);
      } else {
        zip.addLocalFile(fullPath, path.dirname(zipPath));
      }
    }
  };

  addDir(sourceDir, '');
  zip.writeZip(outputPath);
}
```

---

## Feature 4: `skills-svc schedule`

### Purpose
Register a recurring job that uploads skills on a cron schedule via EventBridge Scheduler. The CLI manages the schedule lifecycle; the scheduled trigger invokes the existing ingestion pipeline unchanged.

### Command Signatures

```bash
skills-svc schedule create <zip-path> --job-name <name> --cron <expr> [options]
skills-svc schedule list [--status enabled|disabled]
skills-svc schedule enable  <schedule-id>
skills-svc schedule disable <schedule-id>
skills-svc schedule delete  <schedule-id>
skills-svc schedule history <schedule-id> [--limit 10]
```

### New AWS Resources

#### `infra/lib/messaging-stack.ts` additions

```typescript
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';

// Scheduler execution role — allowed to put objects to uploads bucket
const schedulerRole = new iam.Role(this, 'SchedulerRole', {
  roleName: `skills-svc-scheduler-${props.envName}`,
  assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
  description: 'EventBridge Scheduler role for recurring skill jobs',
});
schedulerRole.addToPolicy(new iam.PolicyStatement({
  sid: 'PutToUploadsBucket',
  actions: ['s3:PutObject'],
  resources: [`${props.uploadsBucket.bucketArn}/uploads/scheduled/*`],
  conditions: {
    StringEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
    Bool: { 'aws:SecureTransport': 'true' },
  },
}));
schedulerRole.addToPolicy(new iam.PolicyStatement({
  sid: 'KMSForScheduledUploads',
  actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
  resources: [props.uploadsBucketKey.keyArn],
}));

// Scheduler schedule group — all skills-svc schedules in one group
const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'ScheduleGroup', {
  name: `skills-svc-${props.envName}`,
});

// SSM params
new ssm.StringParameter(this, 'ParamSchedulerRoleArn', {
  parameterName: `/skills-svc/${props.envName}/scheduler/role-arn`,
  stringValue: schedulerRole.roleArn,
});
new ssm.StringParameter(this, 'ParamScheduleGroupName', {
  parameterName: `/skills-svc/${props.envName}/scheduler/group-name`,
  stringValue: `skills-svc-${props.envName}`,
});
```

#### New DDB GSI for schedule lookup (`infra/lib/storage-stack.ts`)

```typescript
// GSI3: query by schedule ID
this.jobsTable.addGlobalSecondaryIndex({
  indexName: 'GSI3-Schedule',
  partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING }, // SCHEDULE#{scheduleId}
  sortKey:      { name: 'GSI3SK', type: dynamodb.AttributeType.STRING }, // CREATED_AT#{iso}
  projectionType: dynamodb.ProjectionType.INCLUDE,
  nonKeyAttributes: ['jobId', 'jobName', 'status', 'createdAt'],
});
```

Add `GSI3PK` / `GSI3SK` fields to `JobRecord` in `packages/shared/src/types.ts`:
```typescript
GSI3PK?: string;  // SCHEDULE#{scheduleId} — only set for scheduled jobs
GSI3SK?: string;  // CREATED_AT#{iso}
```

### `packages/cli/src/commands/schedule.ts`

```typescript
import { Command } from 'commander';
import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { readFileSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';
import chalk from 'chalk';
import { loadConfig } from '../utils/config';
import { getCredentialProvider } from '../utils/aws-clients';
import { prettyTable } from '../utils/pretty-print';
import { DDB_KEY_PREFIX } from '@skills-svc/shared';

export function scheduleCommand(): Command {
  const cmd = new Command('schedule').description('Manage recurring scheduled skill jobs');

  // ── schedule create ─────────────────────────────────────────────────
  cmd.command('create <zip-path>')
    .description('Create a recurring schedule to run a skills zip on a cron')
    .requiredOption('--job-name <name>', 'Job name (used as schedule name prefix)')
    .requiredOption('--cron <expr>', 'Cron expression, e.g. "0 6 ? * MON *" (EventBridge format)')
    .option('--timezone <tz>', 'IANA timezone for cron expression', 'UTC')
    .option('--start-date <iso>', 'When to start the schedule (ISO 8601)')
    .option('--end-date <iso>', 'When to stop the schedule (ISO 8601)')
    .option('--disabled', 'Create schedule in disabled state', false)
    .action(async (zipPath: string, opts: {
      jobName: string;
      cron: string;
      timezone: string;
      startDate?: string;
      endDate?: string;
      disabled: boolean;
    }) => {
      const cfg = await loadConfig();
      const credProvider = await getCredentialProvider();
      const scheduler = new SchedulerClient({ region: cfg.region, credentials: credProvider });
      const s3  = new S3Client({ region: cfg.region, credentials: credProvider });
      const sts = new STSClient({ region: cfg.region, credentials: credProvider });
      const ssm = new SSMClient({ region: cfg.region, credentials: credProvider });

      // Validate file
      const stat = statSync(zipPath);
      if (stat.size > 500 * 1024 * 1024) {
        console.error(chalk.red('Zip exceeds 500MB limit'));
        process.exit(1);
      }

      // Upload zip to a stable S3 key for the schedule (not the per-run key)
      const scheduleId = randomUUID().slice(0, 8);
      const scheduleS3Key = `uploads/scheduled/${scheduleId}/${path.basename(zipPath)}`;
      const identity = await sts.send(new GetCallerIdentityCommand({}));

      console.log(chalk.blue(`Uploading schedule zip to S3 (permanent key)...`));
      await s3.send(new PutObjectCommand({
        Bucket: cfg.uploadsBucket,
        Key: scheduleS3Key,
        Body: readFileSync(zipPath),
        ContentType: 'application/zip',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: cfg.uploadsKmsKeyId,
        ChecksumAlgorithm: 'SHA256',
        Metadata: {
          'job-name': opts.jobName,
          'user-arn': identity.Arn!,
          'schedule-id': scheduleId,
          'scheduled': 'true',
        },
      }));

      // Get scheduler role ARN and group name from SSM
      const schedulerRoleArn = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/scheduler/role-arn`,
      })).then(r => r.Parameter!.Value!);
      const groupName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/scheduler/group-name`,
      })).then(r => r.Parameter!.Value!);

      // EventBridge Scheduler: on each trigger, copy the zip to a new run key
      // (triggers S3 event → SQS → ingestion Lambda)
      // The target is S3 PutObject — copies the schedule zip to a per-run prefix
      const scheduleName = `${opts.jobName.replace(/[^a-zA-Z0-9-_]/g, '-')}-${scheduleId}`;

      await scheduler.send(new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: groupName,
        Description: `Recurring job: ${opts.jobName} | Zip: ${scheduleS3Key}`,
        ScheduleExpression: `cron(${opts.cron})`,
        ScheduleExpressionTimezone: opts.timezone,
        State: opts.disabled ? 'DISABLED' : 'ENABLED',
        StartDate: opts.startDate ? new Date(opts.startDate) : undefined,
        EndDate:   opts.endDate   ? new Date(opts.endDate)   : undefined,
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        Target: {
          // Target: Lambda that copies the zip to a new run prefix to trigger the pipeline
          Arn: `arn:aws:lambda:${cfg.region}:${cfg.accountId}:function:skills-svc-schedule-trigger-${cfg.accountId}`,
          RoleArn: schedulerRoleArn,
          Input: JSON.stringify({
            scheduleId,
            scheduleName,
            jobName: opts.jobName,
            s3Bucket: cfg.uploadsBucket,
            s3Key: scheduleS3Key,
            userArn: identity.Arn,
            envName: cfg.envName,
          }),
        },
      }));

      prettyTable([
        ['Field', 'Value'],
        ['Schedule ID',   scheduleId],
        ['Schedule Name', scheduleName],
        ['Cron',          `cron(${opts.cron})`],
        ['Timezone',      opts.timezone],
        ['Status',        opts.disabled ? chalk.yellow('DISABLED') : chalk.green('ENABLED')],
        ['Zip S3 Key',    scheduleS3Key],
        ['Start Date',    opts.startDate ?? 'immediately'],
        ['End Date',      opts.endDate ?? 'never'],
      ]);

      console.log(`\nManage: ${chalk.cyan(`skills-svc schedule list`)}`);
    });

  // ── schedule list ────────────────────────────────────────────────────
  cmd.command('list')
    .description('List all registered schedules')
    .option('--status <status>', 'Filter by status: enabled|disabled')
    .option('--limit <n>', 'Max results', '20')
    .action(async (opts: { status?: string; limit: string }) => {
      const cfg = await loadConfig();
      const credProvider = await getCredentialProvider();
      const scheduler = new SchedulerClient({ region: cfg.region, credentials: credProvider });
      const ssm = new SSMClient({ region: cfg.region, credentials: credProvider });
      const groupName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/scheduler/group-name`,
      })).then(r => r.Parameter!.Value!);

      const res = await scheduler.send(new ListSchedulesCommand({
        GroupName: groupName,
        State: opts.status?.toUpperCase() as 'ENABLED' | 'DISABLED' | undefined,
        MaxResults: parseInt(opts.limit, 10),
      }));

      if (!res.Schedules?.length) {
        console.log(chalk.yellow('No schedules found.'));
        return;
      }

      prettyTable([
        ['Name', 'State', 'Expression', 'Next Run', 'Created'],
        ...(res.Schedules ?? []).map(s => [
          s.Name ?? '',
          s.State === 'ENABLED' ? chalk.green('ENABLED') : chalk.yellow('DISABLED'),
          s.ScheduleExpression ?? '',
          s.NextInvocationTime?.toLocaleString() ?? 'N/A',
          s.CreationDate?.toLocaleDateString() ?? 'N/A',
        ]),
      ]);
    });

  // ── schedule enable / disable ────────────────────────────────────────
  for (const action of ['enable', 'disable'] as const) {
    cmd.command(`${action} <schedule-name>`)
      .description(`${action === 'enable' ? 'Enable' : 'Disable'} a schedule`)
      .action(async (scheduleName: string) => {
        const cfg = await loadConfig();
        const credProvider = await getCredentialProvider();
        const scheduler = new SchedulerClient({ region: cfg.region, credentials: credProvider });
        const ssm = new SSMClient({ region: cfg.region, credentials: credProvider });
        const groupName = await ssm.send(new GetParameterCommand({
          Name: `/skills-svc/${cfg.envName}/scheduler/group-name`,
        })).then(r => r.Parameter!.Value!);

        const existing = await scheduler.send(new GetScheduleCommand({
          Name: scheduleName,
          GroupName: groupName,
        }));

        await scheduler.send(new UpdateScheduleCommand({
          Name: scheduleName,
          GroupName: groupName,
          ScheduleExpression: existing.ScheduleExpression!,
          FlexibleTimeWindow: existing.FlexibleTimeWindow!,
          Target: existing.Target!,
          State: action === 'enable' ? 'ENABLED' : 'DISABLED',
        }));

        const color = action === 'enable' ? chalk.green : chalk.yellow;
        console.log(color(`✓ Schedule "${scheduleName}" ${action}d`));
      });
  }

  // ── schedule delete ──────────────────────────────────────────────────
  cmd.command('delete <schedule-name>')
    .description('Delete a schedule permanently')
    .option('--force', 'Skip confirmation prompt', false)
    .action(async (scheduleName: string, opts: { force: boolean }) => {
      const cfg = await loadConfig();

      if (!opts.force) {
        const { default: readline } = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const confirmed = await new Promise<boolean>(resolve => {
          rl.question(
            chalk.yellow(`Delete schedule "${scheduleName}"? This cannot be undone. (yes/N): `),
            answer => { rl.close(); resolve(answer.toLowerCase() === 'yes'); }
          );
        });
        if (!confirmed) { console.log('Aborted.'); return; }
      }

      const credProvider = await getCredentialProvider();
      const scheduler = new SchedulerClient({ region: cfg.region, credentials: credProvider });
      const ssm = new SSMClient({ region: cfg.region, credentials: credProvider });
      const groupName = await ssm.send(new GetParameterCommand({
        Name: `/skills-svc/${cfg.envName}/scheduler/group-name`,
      })).then(r => r.Parameter!.Value!);

      await scheduler.send(new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: groupName,
      }));

      console.log(chalk.green(`✓ Schedule "${scheduleName}" deleted`));
    });

  // ── schedule history ─────────────────────────────────────────────────
  cmd.command('history <schedule-name>')
    .description('Show recent job runs triggered by a schedule')
    .option('--limit <n>', 'Max results', '10')
    .action(async (scheduleName: string, opts: { limit: string }) => {
      const cfg = await loadConfig();
      const credProvider = await getCredentialProvider();
      const ddb = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: cfg.region, credentials: credProvider })
      );

      // Extract schedule ID from name (last 8 chars by convention)
      const scheduleId = scheduleName.split('-').pop() ?? scheduleName;

      const res = await ddb.send(new QueryCommand({
        TableName: cfg.dynamodbTableName,
        IndexName: 'GSI3-Schedule',
        KeyConditionExpression: 'GSI3PK = :pk',
        ExpressionAttributeValues: {
          ':pk': `${DDB_KEY_PREFIX.SCHEDULE ?? 'SCHEDULE#'}${scheduleId}`,
        },
        ScanIndexForward: false,
        Limit: parseInt(opts.limit, 10),
      }));

      if (!res.Items?.length) {
        console.log(chalk.yellow('No history found for this schedule.'));
        return;
      }

      prettyTable([
        ['Job ID', 'Status', 'Created', 'Duration'],
        ...res.Items.map(item => [
          (item.jobId as string).slice(0, 8) + '...',
          item.status as string,
          new Date(item.createdAt as string).toLocaleString(),
          item.completedAt
            ? `${Math.round((new Date(item.completedAt as string).getTime() - new Date(item.createdAt as string).getTime()) / 1000)}s`
            : 'running...',
        ]),
      ]);
    });

  return cmd;
}
```

### New Lambda: Schedule Trigger (`packages/lambda/src/schedule-trigger/handler.ts`)

EventBridge Scheduler can't directly PutObject to S3 with metadata — it uses a Lambda intermediary that copies the stored zip to a per-run prefix (which triggers the S3 event notification → ingestion pipeline).

```typescript
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3 = new S3Client({});

interface ScheduleTriggerInput {
  scheduleId: string;
  scheduleName: string;
  jobName: string;
  s3Bucket: string;
  s3Key: string;          // permanent schedule zip key
  userArn: string;
  envName: string;
}

export const handler = async (event: ScheduleTriggerInput): Promise<void> => {
  const runId    = randomUUID();
  const destKey  = `uploads/${runId}/scheduled-${event.scheduleId}.zip`;

  // Copy stored zip to a new per-run key — triggers S3 event → SQS → ingestion Lambda
  await s3.send(new CopyObjectCommand({
    Bucket: event.s3Bucket,
    CopySource: `${event.s3Bucket}/${event.s3Key}`,
    Key: destKey,
    ServerSideEncryption: 'aws:kms',
    MetadataDirective: 'REPLACE',
    Metadata: {
      'job-name':    `${event.jobName}-scheduled-${new Date().toISOString().slice(0, 10)}`,
      'user-arn':    event.userArn,
      'schedule-id': event.scheduleId,
      'run-id':      runId,
      'scheduled':   'true',
    },
  }));

  console.log(JSON.stringify({
    event: 'schedule_triggered',
    scheduleId: event.scheduleId,
    jobName: event.jobName,
    runId,
    destKey,
  }));
};
```

Add to `LambdaStack`:
```typescript
const scheduleTriggerFn = new lambda.Function(this, 'ScheduleTriggerLambda', {
  ...sharedLambdaProps,
  functionName: `skills-svc-schedule-trigger-${this.account}`,
  handler: 'schedule-trigger/handler.handler',
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
  reservedConcurrentExecutions: 10,
  role: props.ingestionLambdaRole, // reuse — needs S3 copy permission
  description: 'Invoked by EventBridge Scheduler to copy stored zip to per-run S3 prefix',
});

// Grant scheduler service permission to invoke
scheduleTriggerFn.addPermission('AllowScheduler', {
  principal: new iam.ServicePrincipal('scheduler.amazonaws.com'),
  sourceArn: `arn:aws:scheduler:${this.region}:${this.account}:schedule/skills-svc-${props.envName}/*`,
});
```

---

## Updated `packages/cli/src/index.ts`

Register all new commands:

```typescript
import { validateCommand }  from './commands/validate';
import { watchCommand }     from './commands/watch';
import { scheduleCommand }  from './commands/schedule';

// Add alongside existing commands:
program.addCommand(validateCommand());
program.addCommand(watchCommand());
program.addCommand(scheduleCommand());
```

---

## QA Checks (QA-115 through QA-124)

```typescript
// QA-115: validate command exits 0 on valid zip
test('QA-115: validate exits 0 for a well-formed zip', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    jobName: 'test', version: '1.0.0', skills: ['a'], defaultPrompt: 'analyze',
  })));
  zip.addFile('skills/a.md', Buffer.from('# Skill A'));
  zip.writeZip('/tmp/qa115-test.zip');

  const { status } = spawnSync('node', ['dist/index.js', 'validate', '/tmp/qa115-test.zip'], {
    cwd: 'packages/cli',
  });
  expect(status).toBe(0);
});

// QA-116: validate exits 1 on missing manifest.json
test('QA-116: validate exits 1 when manifest.json is absent', async () => {
  const zip = new AdmZip();
  zip.addFile('skills/a.md', Buffer.from('# Skill A'));
  zip.writeZip('/tmp/qa116-test.zip');
  const { status } = spawnSync('node', ['dist/index.js', 'validate', '/tmp/qa116-test.zip'], { cwd: 'packages/cli' });
  expect(status).toBe(1);
});

// QA-117: validate --strict exits 1 on warning (missing defaultPrompt)
test('QA-117: validate --strict exits 1 on warning', async () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ jobName: 'test', version: '1.0.0', skills: ['a'] })));
  zip.addFile('skills/a.md', Buffer.from('# A'));
  zip.writeZip('/tmp/qa117-test.zip');
  const { status } = spawnSync('node', ['dist/index.js', 'validate', '/tmp/qa117-test.zip', '--strict'], { cwd: 'packages/cli' });
  expect(status).toBe(1);
});

// QA-118: Token estimate math is correct
test('QA-118: estimateTokens is mathematically correct', () => {
  const { estimateTokens } = require('../utils/token-counter');
  const text = 'a'.repeat(4000); // exactly 1000 tokens at 4 chars/token
  const result = estimateTokens(text, 'analyze');
  expect(result.skillTokens).toBe(1000);
  // system (180) + prompt (7 chars / 4 ≈ 2) = ~182 system tokens
  expect(result.totalInput).toBe(result.skillTokens + result.systemTokens);
  // Output estimate: 55% of input
  expect(result.estimatedOutput).toBe(Math.ceil(result.totalInput * 0.55));
  expect(result.total).toBe(result.totalInput + result.estimatedOutput);
});

// QA-119: Cost estimate uses correct pricing
test('QA-119: estimateCost uses correct Bedrock Claude Sonnet pricing', () => {
  const { estimateTokens, estimateCost } = require('../utils/token-counter');
  const tokens = estimateTokens('a'.repeat(4_000_000)); // 1M tokens
  const cost = estimateCost(tokens, 'anthropic.claude-3-5-sonnet-20241022-v2:0');
  // 1M input tokens at $3.00/1M = $3.00
  expect(cost.inputCostUsd).toBeCloseTo(tokens.totalInput / 1_000_000 * 3.00, 4);
  expect(cost.outputCostUsd).toBeCloseTo(tokens.estimatedOutput / 1_000_000 * 15.00, 4);
});

// QA-120: streamJobLogs polls DDB and exits on COMPLETE status
test('QA-120: streamJobLogs exits when DDB status becomes COMPLETE', async () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const cwlMock = mockClient(CloudWatchLogsClient);
  let callCount = 0;
  ddbMock.on(GetCommand).callsFake(() => {
    callCount++;
    return { Item: { status: callCount < 3 ? 'RUNNING' : 'COMPLETE' } };
  });
  cwlMock.on(FilterLogEventsCommand).resolves({ events: [] });

  const status = await streamJobLogs({ jobId: 'test-001', cfg: mockCfg, timeoutMs: 60_000 });
  expect(status).toBe('COMPLETE');
  expect(callCount).toBeGreaterThanOrEqual(3);
});

// QA-121: watch debounces rapid file changes
test('QA-121: watch mode debounces multiple file events within debounce window', async () => {
  jest.useFakeTimers();
  const uploadSpy = jest.fn().mockResolvedValue(undefined);
  // Simulate 5 file change events within 1500ms
  for (let i = 0; i < 5; i++) triggerFileEvent('skills/a.md');
  jest.advanceTimersByTime(1500);
  await Promise.resolve();
  expect(uploadSpy).toHaveBeenCalledTimes(1); // only one upload despite 5 events
  jest.useRealTimers();
});

// QA-122: zipDirectory excludes .git and node_modules
test('QA-122: zipDirectory excludes .git and node_modules from archive', async () => {
  const { zipDirectory } = require('../utils/zipper');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa122-'));
  fs.mkdirSync(path.join(tmpDir, '.git'));
  fs.mkdirSync(path.join(tmpDir, 'node_modules'));
  fs.mkdirSync(path.join(tmpDir, 'skills'));
  fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{}');
  fs.writeFileSync(path.join(tmpDir, 'skills/a.md'), '# A');
  fs.writeFileSync(path.join(tmpDir, '.git/config'), 'gitconfig');
  fs.writeFileSync(path.join(tmpDir, 'node_modules/pkg.js'), 'code');

  const outZip = path.join(os.tmpdir(), 'qa122-out.zip');
  await zipDirectory(tmpDir, outZip, []);

  const zip = new AdmZip(outZip);
  const entries = zip.getEntries().map(e => e.entryName);
  expect(entries.some(e => e.includes('.git'))).toBe(false);
  expect(entries.some(e => e.includes('node_modules'))).toBe(false);
  expect(entries.some(e => e.includes('skills/a.md'))).toBe(true);
});

// QA-123: schedule create constructs correct cron expression
test('QA-123: schedule create sends correct cron to EventBridge', async () => {
  const schedulerMock = mockClient(SchedulerClient);
  schedulerMock.on(CreateScheduleCommand).resolves({});
  // ... run schedule create command ...
  const createCall = schedulerMock.commandCalls(CreateScheduleCommand)[0];
  const expr = createCall.args[0].input.ScheduleExpression;
  expect(expr).toMatch(/^cron\(.+\)$/);
});

// QA-124: schedule trigger Lambda copies zip to per-run prefix
test('QA-124: schedule trigger handler copies zip to uploads/ prefix', async () => {
  const s3Mock = mockClient(S3Client);
  s3Mock.on(CopyObjectCommand).resolves({});

  await handler({
    scheduleId: 'abc12345',
    scheduleName: 'test-schedule',
    jobName: 'test',
    s3Bucket: 'test-bucket',
    s3Key: 'uploads/scheduled/abc12345/skills.zip',
    userArn: 'arn:aws:iam::123:user/test',
    envName: 'prod',
  });

  const copyCall = s3Mock.commandCalls(CopyObjectCommand)[0];
  expect(copyCall.args[0].input.Key).toMatch(/^uploads\/.+\/scheduled-abc12345\.zip$/);
  expect(copyCall.args[0].input.Metadata?.['schedule-id']).toBe('abc12345');
});
```

---

## Summary of New Files

```
packages/cli/src/
├── commands/
│   ├── validate.ts        NEW — local zip validation + cost estimate
│   ├── watch.ts           NEW — directory watcher + auto-upload + stream
│   └── schedule.ts        NEW — EventBridge Scheduler CRUD
└── utils/
    ├── token-counter.ts   NEW — tiktoken-approximation + Bedrock pricing
    ├── log-streamer.ts    NEW — CloudWatch Logs tail with structured rendering
    └── zipper.ts          NEW — directory → zip utility

packages/lambda/src/
└── schedule-trigger/
    └── handler.ts         NEW — copies stored zip to per-run S3 prefix

infra/lib/
├── messaging-stack.ts     UPDATED — add SchedulerRole + ScheduleGroup
└── storage-stack.ts       UPDATED — add GSI3 (schedule history queries)
└── lambda-stack.ts        UPDATED — add ScheduleTriggerLambda
```

## New npm dependencies

```json
// packages/cli/package.json — add:
{
  "@aws-sdk/client-cloudwatch-logs": "^3.600.0",
  "@aws-sdk/client-scheduler": "^3.600.0",
  "adm-zip": "^0.5.10",
  "chokidar": "^3.6.0"
}

// packages/lambda/package.json — add:
{
  "@aws-sdk/client-scheduler": "^3.600.0"
}
```
