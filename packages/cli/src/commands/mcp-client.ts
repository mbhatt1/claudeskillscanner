/**
 * mcp-client.ts — `skills-svc mcp <subcommand>`
 *
 * CLI MCP client: lets you test, debug, and call MCP tools directly without
 * a full Claude session. Makes real HTTP JSON-RPC 2.0 calls to the API Gateway
 * MCP endpoint using the X-API-Key token written by `skills-svc mcp-config`.
 *
 * Subcommands:
 *   mcp tools                                   — list all available MCP tools
 *   mcp call <tool-name> [--args '{"k":"v"}']   — call any tool directly
 *   mcp submit <zip-path> [--job-name <n>]      — wraps submit_job
 *   mcp status <job-id>                         — wraps job_status
 *   mcp result <job-id> [--summary-only]        — wraps get_result
 *   mcp query "<text>" [--top-k 5] [--from 0]  — wraps query_knowledge_store
 *   mcp ping                                    — JSON-RPC ping + latency
 *   mcp resources                               — list available MCP resources
 *
 * Config source (in priority order):
 *   1. ~/.claude/mcp.json  — written by `skills-svc mcp-config --install`
 *   2. ~/.skills-svc/mcp.json — fallback location
 *
 * Spec references:
 *   SPEC-03 §5 — CLI package patterns and utility conventions
 *   SPEC-07    — CLI feature patterns (chalk, prettyTable, Commander usage)
 *   SPEC-29    — MCP server protocol, tools, and JSON-RPC 2.0 wire format
 */

import { Command } from 'commander';
import { readFileSync, existsSync, readFileSync as fsReadFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';

// ── Config types ────────────────────────────────────────────────────────────────

/**
 * Shape of ~/.claude/mcp.json (written by `skills-svc mcp-config --install`).
 * Only the 'skills-as-a-service' entry is relevant here.
 */
interface McpJsonConfig {
  mcpServers?: {
    'skills-as-a-service'?: {
      transport?: {
        type?: string;
        url?: string;
        headers?: Record<string, string>;
      };
    };
    [key: string]: unknown;
  };
}

export interface McpConfig {
  endpoint: string;
  apiKey: string;
}

// ── JSON-RPC 2.0 types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP content block — matches server types (SPEC-29 §5 types.ts).
 * type:'text'     → plain text output
 * type:'resource' → machine-readable JSON embedded in resource.text
 */
interface McpContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  resource?: {
    uri: string;
    mimeType: string;
    text?: string;
    blob?: string;
  };
}

// Counter used to generate unique JSON-RPC request IDs within a CLI invocation.
let _rpcId = 1;

// ── loadMcpConfig ────────────────────────────────────────────────────────────────

/**
 * Reads mcp.json and extracts endpoint URL + X-API-Key token.
 *
 * Search order:
 *   1. ~/.claude/mcp.json   (written by --install flag)
 *   2. ~/.skills-svc/mcp.json (manual placement fallback)
 *
 * Throws a user-readable error if the file is absent or the server entry
 * is missing / malformed.
 */
export function loadMcpConfig(): McpConfig {
  const candidates = [
    path.join(os.homedir(), '.claude', 'mcp.json'),
    path.join(os.homedir(), '.skills-svc', 'mcp.json'),
  ];

  let mcpFile: string | undefined;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      mcpFile = candidate;
      break;
    }
  }

  if (!mcpFile) {
    throw new Error(
      `MCP config not found. Run:\n\n` +
      `  skills-svc mcp-config --install\n\n` +
      `This generates a token and writes the server config to ~/.claude/mcp.json.\n` +
      `Searched:\n` +
      candidates.map(c => `  ${c}`).join('\n'),
    );
  }

  let parsed: McpJsonConfig;
  try {
    parsed = JSON.parse(fsReadFileSync(mcpFile, 'utf-8')) as McpJsonConfig;
  } catch (err) {
    throw new Error(`Failed to parse MCP config at ${mcpFile}: ${String(err)}`);
  }

  const server = parsed?.mcpServers?.['skills-as-a-service'];
  if (!server) {
    throw new Error(
      `No 'skills-as-a-service' entry found in ${mcpFile}.\n` +
      `Run: skills-svc mcp-config --install`,
    );
  }

  const transport = server.transport;
  if (!transport?.url) {
    throw new Error(
      `MCP server entry in ${mcpFile} is missing transport.url.\n` +
      `Run: skills-svc mcp-config --install  to regenerate the config.`,
    );
  }

  const apiKey = transport.headers?.['X-API-Key'];
  if (!apiKey) {
    throw new Error(
      `MCP server entry in ${mcpFile} is missing X-API-Key header.\n` +
      `Run: skills-svc mcp-config --install  to generate a fresh token.`,
    );
  }

  return { endpoint: transport.url, apiKey };
}

// ── mcpCall ──────────────────────────────────────────────────────────────────────

/**
 * Sends a JSON-RPC 2.0 request to the MCP endpoint and returns the parsed response.
 *
 * Uses Node's built-in fetch (Node 18+). Falls back to a clear error if the
 * endpoint is unreachable or the token is expired/invalid.
 *
 * @param cfg      MCP config (endpoint + apiKey)
 * @param method   JSON-RPC method, e.g. 'tools/list' or 'tools/call'
 * @param params   Optional params object
 */
export async function mcpCall(
  cfg: McpConfig,
  method: string,
  params?: unknown,
): Promise<JsonRpcResponse> {
  const id = _rpcId++;

  const reqBody: JsonRpcRequest = {
    jsonrpc: '2.0',
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  };

  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.apiKey,
      },
      body: JSON.stringify(reqBody),
    });
  } catch (err) {
    // Network-level error — endpoint unreachable
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach MCP endpoint: ${cfg.endpoint}\n` +
      `Network error: ${msg}\n\n` +
      `Check:\n` +
      `  1. You have network access to the API Gateway endpoint.\n` +
      `  2. The endpoint URL in ~/.claude/mcp.json is correct.\n` +
      `  3. Run: skills-svc mcp-config --install  to regenerate if unsure.`,
    );
  }

  // HTTP-level errors
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `MCP authentication failed (HTTP ${res.status}).\n` +
      `Your X-API-Key token has likely expired or been revoked.\n` +
      `Run: skills-svc mcp-config --install  to generate a fresh token.`,
    );
  }
  if (res.status === 429) {
    throw new Error(
      `Rate limited by the MCP endpoint (HTTP 429).\n` +
      `Wait a moment and try again. The WAF limit is 300 req/token/5min.`,
    );
  }
  if (res.status === 204) {
    // Notification response — no body
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)');
    throw new Error(`MCP endpoint returned HTTP ${res.status}: ${body}`);
  }

  let data: JsonRpcResponse;
  try {
    data = (await res.json()) as JsonRpcResponse;
  } catch (err) {
    throw new Error(`MCP endpoint returned non-JSON response: ${String(err)}`);
  }

  return data;
}

// ── pretty-printers ──────────────────────────────────────────────────────────────

/**
 * Pretty-prints an MCP content array to stdout.
 *
 * Handles:
 *   type:'text'     — printed directly (may be Markdown/plain)
 *   type:'resource' — JSON parsed and syntax-highlighted; uri shown as label
 */
function printMcpContent(content: McpContent[], format: 'pretty' | 'json' = 'pretty'): void {
  if (format === 'json') {
    console.log(JSON.stringify(content, null, 2));
    return;
  }

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      console.log(block.text);
    } else if (block.type === 'resource' && block.resource) {
      const { uri, mimeType, text } = block.resource;
      console.log(chalk.dim(`\n[resource: ${uri}  mime: ${mimeType}]`));
      if (text) {
        try {
          const obj = JSON.parse(text);
          console.log(syntaxHighlightJson(JSON.stringify(obj, null, 2)));
        } catch {
          console.log(chalk.dim(text));
        }
      }
    }
  }
}

/** Minimal JSON syntax highlighting without external dependencies. */
function syntaxHighlightJson(json: string): string {
  return json
    .replace(/"([^"]+)":/g, chalk.cyan('"$1"') + ':')
    .replace(/: "([^"]*)"/g, ': ' + chalk.green('"$1"'))
    .replace(/: (-?\d+(?:\.\d+)?)/g, ': ' + chalk.yellow('$1'))
    .replace(/: (true|false)/g, ': ' + chalk.magenta('$1'))
    .replace(/: null/g, ': ' + chalk.grey('null'));
}

/** Extract the content array from a tools/call result, or throw on error. */
function extractContent(rpc: JsonRpcResponse, toolName: string): McpContent[] {
  if (rpc.error) {
    throw new Error(
      `MCP error ${rpc.error.code}: ${rpc.error.message}` +
      (rpc.error.code === -32602 && rpc.error.message.includes('Unknown tool')
        ? `\n\nRun: skills-svc mcp tools  to see available tool names.`
        : ''),
    );
  }

  const result = rpc.result as { content?: McpContent[]; isError?: boolean } | undefined;

  if (result?.isError === true) {
    const errText = result.content
      ?.filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n') ?? 'Tool returned an error';
    throw new Error(`Tool '${toolName}' reported an error:\n${errText}`);
  }

  return (result?.content as McpContent[] | undefined) ?? [];
}

// ── registerMcpClientCommands ────────────────────────────────────────────────────

/**
 * Registers all `skills-svc mcp <subcommand>` commands with Commander.
 *
 * Called from the main CLI entry point (packages/cli/src/index.ts).
 */
export function registerMcpClientCommands(program: Command): void {
  const mcp = program
    .command('mcp')
    .description(
      'Call the MCP server directly from the CLI — for testing, debugging, and tool exploration.\n' +
      'Requires a valid token: run `skills-svc mcp-config --install` first.',
    );

  // ── mcp tools ──────────────────────────────────────────────────────────────
  mcp
    .command('tools')
    .description('List all available MCP tools with their input schemas')
    .option('--format <fmt>', 'Output format: pretty|json', 'pretty')
    .action(async (opts: { format: string }) => {
      const cfg = loadMcpConfig();
      const rpc = await mcpCall(cfg, 'tools/list');

      if (rpc.error) {
        console.error(chalk.red(`Error: ${rpc.error.message}`));
        process.exit(1);
      }

      const tools = (rpc.result as { tools?: unknown[] } | undefined)?.tools ?? [];

      if (opts.format === 'json') {
        console.log(JSON.stringify(tools, null, 2));
        return;
      }

      if (!tools.length) {
        console.log(chalk.yellow('No tools returned by the MCP server.'));
        return;
      }

      console.log(chalk.bold(`\nAvailable MCP tools (${tools.length}):\n`));
      for (const tool of tools as Array<{
        name: string;
        description?: string;
        inputSchema?: { properties?: Record<string, { type: string; description?: string }>; required?: string[] };
      }>) {
        console.log(`  ${chalk.bold.cyan(tool.name)}`);
        if (tool.description) {
          // Wrap long descriptions at ~72 chars
          const desc = tool.description.length > 72
            ? tool.description.slice(0, 69) + '...'
            : tool.description;
          console.log(`  ${chalk.dim(desc)}`);
        }

        const props = tool.inputSchema?.properties ?? {};
        const required = new Set(tool.inputSchema?.required ?? []);
        const propNames = Object.keys(props);

        if (propNames.length > 0) {
          console.log(`  ${chalk.dim('Arguments:')}`);
          for (const name of propNames) {
            const prop = props[name];
            const req = required.has(name) ? chalk.red('*') : ' ';
            console.log(
              `    ${req} ${chalk.yellow(name)}: ${chalk.dim(prop.type)}` +
              (prop.description ? `  — ${chalk.dim(prop.description.slice(0, 60))}` : ''),
            );
          }
        }
        console.log();
      }

      console.log(chalk.dim('* = required argument'));
      console.log(chalk.dim(`\nCall a tool: skills-svc mcp call <tool-name> --args '{"key":"value"}'`));
    });

  // ── mcp call ────────────────────────────────────────────────────────────────
  mcp
    .command('call <tool-name>')
    .description(
      'Call any MCP tool by name and pretty-print the result.\n' +
      "Use --args to pass a JSON object of arguments. This is the escape hatch\n" +
      'for any tool not wrapped by a dedicated subcommand.',
    )
    .option('--args <json>', 'JSON object of tool arguments, e.g. \'{"job_id":"abc123"}\'', '{}')
    .option('--format <fmt>', 'Output format: pretty|json', 'pretty')
    .action(async (toolName: string, opts: { args: string; format: string }) => {
      const cfg = loadMcpConfig();

      let toolArgs: Record<string, unknown>;
      try {
        toolArgs = JSON.parse(opts.args) as Record<string, unknown>;
      } catch {
        console.error(chalk.red(`--args must be valid JSON. Got: ${opts.args}`));
        process.exit(1);
      }

      const rpc = await mcpCall(cfg, 'tools/call', { name: toolName, arguments: toolArgs });

      let content: McpContent[];
      try {
        content = extractContent(rpc, toolName);
      } catch (err) {
        console.error(chalk.red(`${String(err)}`));
        process.exit(1);
      }

      printMcpContent(content, opts.format as 'pretty' | 'json');
    });

  // ── mcp submit ──────────────────────────────────────────────────────────────
  mcp
    .command('submit <zip-path>')
    .description(
      'Submit a skills zip file via the MCP submit_job tool.\n' +
      'Base64-encodes the zip and calls submit_job. Returns the job ID immediately.\n' +
      'Use `skills-svc mcp status <job-id>` to track progress.',
    )
    .option('--job-name <name>', 'Human-readable job name (max 128 chars)', `mcp-cli-${Date.now()}`)
    .option('--prompt <text>', 'Optional prompt override for the skill run')
    .option('--format <fmt>', 'Output format: pretty|json', 'pretty')
    .action(async (zipPath: string, opts: { jobName: string; prompt?: string; format: string }) => {
      const cfg = loadMcpConfig();

      // Validate file exists and is a zip
      if (!existsSync(zipPath)) {
        console.error(chalk.red(`File not found: ${zipPath}`));
        process.exit(1);
      }
      if (!zipPath.endsWith('.zip')) {
        console.error(chalk.red('File must have .zip extension'));
        process.exit(1);
      }

      let zipBuffer: Buffer;
      try {
        zipBuffer = readFileSync(zipPath);
      } catch (err) {
        console.error(chalk.red(`Cannot read file: ${String(err)}`));
        process.exit(1);
      }

      // Validate ZIP magic bytes locally before sending
      const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      if (zipBuffer.length < 4 || !zipBuffer.subarray(0, 4).equals(ZIP_MAGIC)) {
        console.error(chalk.red('File does not appear to be a valid ZIP archive (bad magic bytes).'));
        process.exit(1);
      }

      const zipBase64 = zipBuffer.toString('base64');
      const sizeMB = (zipBase64.length / 1024 / 1024).toFixed(2);

      // Enforce the MCP encoded size limit (SPEC-29 Fix 7: 7MB encoded)
      const MAX_ENCODED_MB = 7;
      if (zipBase64.length > MAX_ENCODED_MB * 1024 * 1024) {
        console.error(
          chalk.red(
            `Zip is too large for MCP upload (encoded: ${sizeMB}MB, limit: ${MAX_ENCODED_MB}MB).\n` +
            `Use: skills-svc upload ${zipPath} --job-name "${opts.jobName}"  for large files.`,
          ),
        );
        process.exit(1);
      }

      console.log(chalk.blue(`Submitting ${path.basename(zipPath)} (${sizeMB}MB encoded) via MCP...`));

      const toolArgs: Record<string, unknown> = {
        zip_base64: zipBase64,
        job_name:   opts.jobName.slice(0, 128),
      };
      if (opts.prompt) toolArgs.prompt = opts.prompt;

      const rpc = await mcpCall(cfg, 'tools/call', { name: 'submit_job', arguments: toolArgs });

      let content: McpContent[];
      try {
        content = extractContent(rpc, 'submit_job');
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }

      printMcpContent(content, opts.format as 'pretty' | 'json');

      // Extract job ID from resource block for convenience hint
      const resourceBlock = content.find(c => c.type === 'resource');
      if (resourceBlock?.resource?.text && opts.format === 'pretty') {
        try {
          const data = JSON.parse(resourceBlock.resource.text) as { jobId?: string };
          if (data.jobId) {
            console.log(chalk.dim(`\nTrack: skills-svc mcp status ${data.jobId}`));
          }
        } catch { /* ignore parse errors */ }
      }
    });

  // ── mcp status ──────────────────────────────────────────────────────────────
  mcp
    .command('status <job-id>')
    .description(
      'Get the current status of a job via the MCP job_status tool.\n' +
      'Returns human-readable status and a machine-readable JSON resource block.',
    )
    .option('--format <fmt>', 'Output format: pretty|json', 'pretty')
    .action(async (jobId: string, opts: { format: string }) => {
      const cfg = loadMcpConfig();

      const rpc = await mcpCall(cfg, 'tools/call', {
        name:      'job_status',
        arguments: { job_id: jobId },
      });

      let content: McpContent[];
      try {
        content = extractContent(rpc, 'job_status');
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }

      printMcpContent(content, opts.format as 'pretty' | 'json');

      // Provide a polling hint if the job is not yet terminal
      if (opts.format === 'pretty') {
        const resourceBlock = content.find(c => c.type === 'resource');
        if (resourceBlock?.resource?.text) {
          try {
            const data = JSON.parse(resourceBlock.resource.text) as {
              isTerminal?: boolean;
              pollAgainInSeconds?: number | null;
              status?: string;
            };
            if (!data.isTerminal && data.pollAgainInSeconds) {
              console.log(
                chalk.dim(
                  `\nJob is ${data.status ?? 'not yet complete'}. ` +
                  `Poll again in ~${data.pollAgainInSeconds}s:`,
                ),
              );
              console.log(chalk.dim(`  skills-svc mcp status ${jobId}`));
            } else if (data.isTerminal && data.status === 'COMPLETE') {
              console.log(chalk.dim(`\nFetch result: skills-svc mcp result ${jobId}`));
            }
          } catch { /* ignore */ }
        }
      }
    });

  // ── mcp result ──────────────────────────────────────────────────────────────
  mcp
    .command('result <job-id>')
    .description(
      'Retrieve the output of a completed job via the MCP get_result tool.\n' +
      'For results >4MB, the server returns a presigned S3 URL instead of inline content.',
    )
    .option('--summary-only', 'Return only the result summary, not the full output', false)
    .option('--format <fmt>', 'Output format: pretty|json', 'pretty')
    .action(async (jobId: string, opts: { summaryOnly: boolean; format: string }) => {
      const cfg = loadMcpConfig();

      const rpc = await mcpCall(cfg, 'tools/call', {
        name:      'get_result',
        arguments: { job_id: jobId, summary_only: opts.summaryOnly },
      });

      let content: McpContent[];
      try {
        content = extractContent(rpc, 'get_result');
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }

      printMcpContent(content, opts.format as 'pretty' | 'json');
    });

  // ── mcp query ───────────────────────────────────────────────────────────────
  mcp
    .command('query <question>')
    .description(
      'Search the skills knowledge store with a natural language query\n' +
      'via the MCP query_knowledge_store tool.',
    )
    .option('--top-k <n>', 'Number of results to return (1–20)', '5')
    .option('--min-score <n>', 'Minimum relevance score 0.0–1.0', '0.5')
    .option('--from <n>', 'Pagination offset (number of results to skip)', '0')
    .option('--format <fmt>', 'Output format: pretty|json', 'pretty')
    .action(async (question: string, opts: {
      topK: string;
      minScore: string;
      from: string;
      format: string;
    }) => {
      const cfg = loadMcpConfig();

      const topK     = Math.min(Math.max(1, parseInt(opts.topK, 10) || 5), 20);
      const minScore = Math.min(Math.max(0, parseFloat(opts.minScore) || 0.5), 1);
      const from     = Math.max(0, parseInt(opts.from, 10) || 0);

      console.log(chalk.blue(`Querying knowledge store: "${question}"...`));

      const rpc = await mcpCall(cfg, 'tools/call', {
        name:      'query_knowledge_store',
        arguments: { query: question, top_k: topK, min_score: minScore, from },
      });

      let content: McpContent[];
      try {
        content = extractContent(rpc, 'query_knowledge_store');
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      }

      printMcpContent(content, opts.format as 'pretty' | 'json');

      // If there are more results, show a pagination hint
      if (opts.format === 'pretty') {
        const resourceBlock = content.find(c => c.type === 'resource');
        if (resourceBlock?.resource?.text) {
          try {
            const data = JSON.parse(resourceBlock.resource.text) as {
              hasMore?: boolean;
              from?: number;
              total?: number;
            };
            if (data.hasMore) {
              const nextFrom = (data.from ?? 0) + topK;
              console.log(
                chalk.dim(`\nMore results available. Next page:`),
              );
              console.log(
                chalk.dim(
                  `  skills-svc mcp query "${question}" --from ${nextFrom} --top-k ${topK}`,
                ),
              );
            }
          } catch { /* ignore */ }
        }
      }
    });

  // ── mcp ping ────────────────────────────────────────────────────────────────
  mcp
    .command('ping')
    .description(
      'Send a JSON-RPC ping to the MCP endpoint and report round-trip latency.\n' +
      'Useful for verifying that the endpoint is reachable and the token is valid.',
    )
    .option('--count <n>', 'Number of pings to send', '3')
    .action(async (opts: { count: string }) => {
      const cfg   = loadMcpConfig();
      const count = Math.min(Math.max(1, parseInt(opts.count, 10) || 3), 10);

      console.log(chalk.blue(`Pinging ${cfg.endpoint} (${count} times)...\n`));

      const latencies: number[] = [];
      let failures = 0;

      for (let i = 0; i < count; i++) {
        const start = Date.now();
        try {
          const rpc = await mcpCall(cfg, 'ping');
          const latencyMs = Date.now() - start;

          if (rpc.error) {
            console.log(
              chalk.dim(`[${i + 1}]`) +
              chalk.red(` ERROR: ${rpc.error.message}`) +
              chalk.dim(` (${latencyMs}ms)`),
            );
            failures++;
          } else {
            latencies.push(latencyMs);
            const color = latencyMs < 200 ? chalk.green : latencyMs < 500 ? chalk.yellow : chalk.red;
            console.log(
              chalk.dim(`[${i + 1}]`) +
              chalk.green(' PONG') +
              color(` ${latencyMs}ms`),
            );
          }
        } catch (err) {
          const latencyMs = Date.now() - start;
          console.log(
            chalk.dim(`[${i + 1}]`) +
            chalk.red(` UNREACHABLE: ${String(err).split('\n')[0]}`) +
            chalk.dim(` (${latencyMs}ms)`),
          );
          failures++;
        }

        // Small delay between pings to avoid hitting rate limits
        if (i < count - 1) {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      console.log();
      if (latencies.length > 0) {
        const avg  = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
        const min  = Math.min(...latencies);
        const max  = Math.max(...latencies);
        console.log(`  Endpoint:   ${chalk.cyan(cfg.endpoint)}`);
        console.log(`  Responses:  ${chalk.green(String(latencies.length))}/${count}`);
        console.log(`  Latency:    avg ${chalk.bold(avg + 'ms')}  min ${min}ms  max ${max}ms`);
        if (failures > 0) {
          console.log(`  Failures:   ${chalk.red(String(failures))}`);
        }
      } else {
        console.error(chalk.red('All pings failed. Check endpoint and token validity.'));
        console.error(chalk.dim(`Run: skills-svc mcp-config --install  to regenerate token.`));
        process.exit(1);
      }
    });

  // ── mcp resources ───────────────────────────────────────────────────────────
  mcp
    .command('resources')
    .description('List available MCP resources (calls resources/list)')
    .option('--format <fmt>', 'Output format: pretty|json', 'pretty')
    .action(async (opts: { format: string }) => {
      const cfg = loadMcpConfig();
      const rpc = await mcpCall(cfg, 'resources/list');

      if (rpc.error) {
        console.error(chalk.red(`Error: ${rpc.error.message}`));
        process.exit(1);
      }

      const resources = (rpc.result as { resources?: unknown[] } | undefined)?.resources ?? [];

      if (opts.format === 'json') {
        console.log(JSON.stringify(resources, null, 2));
        return;
      }

      if (!resources.length) {
        console.log(chalk.yellow('No resources returned by the MCP server.'));
        return;
      }

      console.log(chalk.bold(`\nAvailable MCP resources (${resources.length}):\n`));
      for (const resource of resources as Array<{
        uri: string;
        name?: string;
        description?: string;
        mimeType?: string;
      }>) {
        console.log(`  ${chalk.bold.cyan(resource.uri)}`);
        if (resource.name)        console.log(`  Name:     ${resource.name}`);
        if (resource.description) console.log(`  ${chalk.dim(resource.description)}`);
        if (resource.mimeType)    console.log(`  MIME:     ${chalk.dim(resource.mimeType)}`);
        console.log();
      }

      console.log(
        chalk.dim(`Read a resource via the generic call:\n`) +
        chalk.dim(`  skills-svc mcp call resources/read --args '{"uri":"skills://jobs"}'`),
      );
    });
}
