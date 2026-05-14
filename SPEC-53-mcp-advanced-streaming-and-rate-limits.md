# SPEC-53 — MCP Advanced: Resource Subscriptions, Streaming, Per-Client Rate Limits

**Version:** 1.0.0
**Status:** AUTHORITATIVE
**Depends on:** SPEC-09 (MCP server), SPEC-29 (MCP rewrite), SPEC-31 (round-2), SPEC-32 (round-2 fixes)
**Related:** SPEC-44 (contracts), SPEC-45 (authz), SPEC-49 (job groups)

> Existing MCP specs cover the protocol surface. This spec adds long-running-job streaming, sampling, per-client quotas, and per-tool observability — the things needed to operate MCP under multi-client load.

---

## 1. Resource Subscriptions for Long-Running Jobs

MCP supports `resources/subscribe` + `notifications/resources/updated`. Expose:

| URI scheme                              | Backed by                         |
|-----------------------------------------|-----------------------------------|
| `skills://jobs/{job_id}/status`         | DDB stream + SSE channel          |
| `skills://groups/{group_id}/progress`   | SPEC-49 aggregates                |
| `skills://jobs/{job_id}/log`            | CW Logs filtered, last 1000 lines |
| `skills://jobs/{job_id}/sarif`          | S3 SARIF object (final only)      |

```ts
// packages/mcp-server/src/resources/job-status.ts
server.registerResource({
  uriTemplate: 'skills://jobs/{job_id}/status',
  async read({ job_id }) { return { contents: [{ mimeType: 'application/json', text: JSON.stringify(await getJob(job_id)) }] }; },
  async subscribe({ job_id }, send) {
    const stream = ddbStreams.subscribe(`JOB#${job_id}`);
    stream.on('change', async () => send({ uri: `skills://jobs/${job_id}/status` }));
    return () => stream.close();
  },
});
```

Client receives `notifications/resources/updated` and re-reads.

---

## 2. Streaming Output via Tool Progress

For tools that take > 5 s, emit progress notifications (per MCP spec `progressToken`):

```ts
server.registerTool('skills_v2.run', async (args, ctx) => {
  const job = await submitJob(args);
  let lastPct = 0;
  for await (const evt of subscribeProgress(job.id)) {
    if (evt.pct >= lastPct + 5) {
      await ctx.notifyProgress(args._meta?.progressToken, { progress: evt.pct, total: 100, message: evt.stage });
      lastPct = evt.pct;
    }
    if (evt.done) return formatResult(evt.result);
  }
});
```

Client UI / agent can show stage transitions (`unzip`, `bedrock`, `index`, `done`).

---

## 3. Sampling Capability (Server → Client LLM Calls)

For workflows where the server wants the *client's* LLM to help (e.g. summarize a SARIF batch in the user's preferred style), use MCP `sampling/createMessage`:

```ts
const summary = await ctx.requestSampling({
  messages: [{ role: 'user', content: { type: 'text', text: 'Summarize these findings in 3 bullets:\n' + json } }],
  modelPreferences: { intelligencePriority: 0.6, costPriority: 0.4 },
  maxTokens: 400,
});
```

Server never assumes a specific client model; sampling is **opt-in** per server tool. Disabled by default; turn on via manifest `mcp.allow_sampling: true`.

---

## 4. Per-Client Rate Limits

Each authenticated principal gets a token bucket per tool:

```
tool_rate_limits:
  default:               { rps: 5,   burst: 20  }
  skills_v2.upload:      { rps: 1,   burst: 5   }
  skills_v2.query:       { rps: 10,  burst: 30  }
  skills_v2.group_submit:{ rps: 0.1, burst: 1   }
```

Storage: DDB single-table item `RATELIMIT#${principal}#${tool}` updated via conditional `SET tokens = tokens - 1` with refill window — or memoized in Lambda extension for hot paths.

On exhaustion:

```jsonc
// Error response (JSON-RPC 2.0)
{
  "jsonrpc": "2.0", "id": ..., "error": {
    "code": -32099,                                 // domain-specific
    "message": "rate limit exceeded",
    "data": { "retry_after_ms": 8200, "tool": "skills_v2.upload" }
  }
}
```

Tier overrides via Cedar attribute `principal.tier ∈ {free, premium, internal}` (SPEC-45).

---

## 5. Per-Tool Observability

Every tool call emits structured EMF:

```ts
emit({
  namespace: 'Skills/MCP',
  metrics: { Invocations: 1, LatencyMs: t, BillableMs: t, Errors: ok ? 0 : 1 },
  dims: { tool, principal_persona, principal_id_hash, version, outcome },
});
```

Dashboards per tool:
- p50/p95/p99 latency
- error rate
- top callers
- rate-limit hits

Slow-call audit log: tool calls > p99 budget land in S3 jsonl for triage.

---

## 6. Capability Negotiation

Server announces capabilities:
```json
{
  "capabilities": {
    "tools":     { "listChanged": true },
    "resources": { "listChanged": true, "subscribe": true },
    "prompts":   { "listChanged": true },
    "logging":   {},
    "sampling":  { "models": ["client-default"] }
  }
}
```

Clients without `subscribe` fall back to polling `tools/call` for status. Servers downgrade gracefully — no hard requirement on client capabilities.

---

## 7. Auth on stdio Transport

Stdio MCP currently trusts the parent process (SPEC-32). Add a process-local capability token issued by the CLI on startup; included in `initialize` request `_meta.cap_token`. Prevents a co-located process from hijacking an open stdio MCP server.

```ts
// packages/cli/src/mcp/launch.ts
const tok = randomBytes(32).toString('hex');
const child = spawn('skills-svc-mcp', { env: { MCP_CAP_TOKEN: tok }, stdio: 'pipe' });
// pass tok to peer via initialize _meta.cap_token
```

---

## 8. Connection Lifecycle

- **Idle timeout:** 30 min — server drops with `disconnect`; client reconnects.
- **Max session length:** 4 h — forced re-`initialize` (refreshes auth, picks up tool changes).
- **Backoff on reconnect:** full-jitter exponential, 500 ms..30 s.

Server emits `Skills/MCP/SessionDuration` and `Skills/MCP/Reconnects` for capacity planning.

---

## 9. Schema Validation

Every tool's input schema is enforced via Zod at the boundary:

```ts
const InputSchema = z.object({ /* ... */ });
server.registerTool('skills_v2.run', async (rawInput) => {
  const input = InputSchema.parse(rawInput);  // throws → -32602 INVALID_PARAMS
  // ...
});
```

Output schema asserted only in dev/CI to catch drift; in prod just logged.

---

## 10. Multi-Tool Sagas (Future-Friendly)

A *saga* is a sequence: `upload → wait → results → query`. Reified as a single tool `skills_v2.workflow` that chains internally with progress events. Lets clients invoke a workflow as one call. Saga definition is declarative:

```yaml
sagas/find-cwe-79.yml:
  steps:
    - tool: skills_v2.upload
      args: { source: "{repo}", skill: security-review }
      bind: job
    - tool: skills_v2.wait_for_completion
      args: { job_id: "{job.id}" }
    - tool: skills_v2.findings
      args: { job_id: "{job.id}", cwe: "CWE-79" }
```

Server compiles to a workflow plan; failures emit structured `WorkflowError` with which step failed.

---

## 11. Acceptance Criteria

- [ ] Resource subscriptions work end-to-end (DDB stream → MCP notification)
- [ ] Progress notifications emitted for `skills_v2.run`
- [ ] Sampling opt-in tested with a mock client
- [ ] Rate-limit token bucket enforces per-tool quotas (load test verified)
- [ ] Tool-level dashboards live
- [ ] Stdio capability token enforced
- [ ] Idle/max-session timeouts drilled
- [ ] Zod schemas at every tool boundary
- [ ] One saga shipped end-to-end
