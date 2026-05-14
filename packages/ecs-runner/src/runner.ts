// packages/ecs-runner/src/runner.ts
//
// Orchestrates Claude invocations for the code-review skill.
//
// Key responsibilities:
//   1. Apply file exclusions via ignorer.ts  (BEFORE token estimation)
//   2. Build file list and split into token-bounded chunks via chunker.ts
//   3. Run one Claude CLI invocation per chunk
//   4. Merge and deduplicate findings by (file, line, cwe_id)
//   5. Upload merged result JSON to S3

import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

import { ReviewOutput, SecurityFinding, BatchManifestEntry } from '@skills-svc/shared';
import { buildIgnorer, Ignorer } from './ignorer';
import {
  buildFileList,
  chunkFiles,
  renderChunkContent,
  FileChunk,
  MAX_TOKENS_PER_BATCH,
} from './chunker';

const execFileAsync = promisify(execFile);
const s3 = new S3Client({});

// Claude CLI timeout per chunk (10 minutes)
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;

// ── Public entry point ─────────────────────────────────────────────────────────

/**
 * Run the code-review skill against `sourceDir`.
 *
 * @param skillsDir   Directory containing the unpacked skill (prompt files, manifest.json)
 * @param sourceDir   Directory containing the extracted source code to review
 * @param jobId       Unique job identifier (used for S3 result key and log correlation)
 * @param env         Deployment environment name (prod, staging, …)
 * @param manifest    Optional batch manifest entry — used for `excludePatterns`
 * @returns           The S3 key where the merged results JSON was uploaded
 */
export async function runSkills(
  skillsDir: string,
  sourceDir: string,
  jobId: string,
  env: string,
  manifest?: Pick<BatchManifestEntry, 'excludePatterns'>,
): Promise<ReviewOutput> {
  // ── 1. Build ignorer (DEFAULT_EXCLUDES + .skillsignore + manifest excludes) ──
  const ignorer: Ignorer = await buildIgnorer(sourceDir, manifest?.excludePatterns ?? []);

  // ── 2. Walk source directory and filter excluded files ──────────────────────
  const allFiles = await buildFileList(sourceDir);
  const includedFiles = allFiles.filter(f => !ignorer.isIgnored(f.relativePath));

  console.log(JSON.stringify({
    event: 'files_enumerated',
    jobId,
    total: allFiles.length,
    included: includedFiles.length,
    excluded: allFiles.length - includedFiles.length,
  }));

  if (includedFiles.length === 0) {
    console.log(JSON.stringify({ event: 'no_files_to_review', jobId }));
    return {
      findings: [],
      summary: 'No reviewable source files found after applying exclusion rules.',
      risk_level: 'none',
    };
  }

  // ── 3. Split into token-bounded chunks ──────────────────────────────────────
  const chunks = chunkFiles(includedFiles, MAX_TOKENS_PER_BATCH);

  console.log(JSON.stringify({
    event: 'chunks_created',
    jobId,
    chunkCount: chunks.length,
    fileCount: includedFiles.length,
  }));

  // ── 4. Load the skill prompt ─────────────────────────────────────────────────
  const skillPrompt = await loadSkillPrompt(skillsDir);

  // ── 5. Run Claude per chunk, collect outputs ─────────────────────────────────
  const allFindings: SecurityFinding[] = [];
  const summaries: string[] = [];
  let highestRisk: ReviewOutput['risk_level'] = 'none';

  for (const chunk of chunks) {
    console.log(JSON.stringify({
      event: 'chunk_start',
      jobId,
      chunkIndex: chunk.index,
      fileCount: chunk.files.length,
      estimatedTokens: chunk.totalEstimatedTokens,
    }));

    let output: ReviewOutput;
    try {
      output = await runClaudeOnChunk(chunk, skillPrompt, sourceDir, jobId);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'chunk_error',
        jobId,
        chunkIndex: chunk.index,
        err: String(err),
      }));
      // Continue with remaining chunks; don't abort the whole job for one failure
      continue;
    }

    allFindings.push(...output.findings);
    summaries.push(output.summary);
    highestRisk = riskMax(highestRisk, output.risk_level);

    console.log(JSON.stringify({
      event: 'chunk_complete',
      jobId,
      chunkIndex: chunk.index,
      findingsCount: output.findings.length,
      riskLevel: output.risk_level,
    }));
  }

  // ── 6. Merge and deduplicate findings ────────────────────────────────────────
  const merged = deduplicateFindings(allFindings);

  // Re-number finding IDs sequentially after dedup
  const renumbered = merged.map((f, i) => ({
    ...f,
    id: `FINDING-${String(i + 1).padStart(3, '0')}`,
  }));

  const mergedOutput: ReviewOutput = {
    findings: renumbered,
    summary: summaries.join(' | ') || 'No security vulnerabilities identified.',
    risk_level: highestRisk,
  };

  console.log(JSON.stringify({
    event: 'merge_complete',
    jobId,
    totalFindings: renumbered.length,
    riskLevel: highestRisk,
    chunkCount: chunks.length,
  }));

  return mergedOutput;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Load and concatenate all *.md skill files found under `skillsDir/skills/`.
 * Falls back to the `defaultPrompt` in manifest.json if no .md files exist.
 */
async function loadSkillPrompt(skillsDir: string): Promise<string> {
  const skillsMdDir = path.join(skillsDir, 'skills');
  let mdFiles: string[] = [];

  try {
    const dirents = await fs.readdir(skillsMdDir, { withFileTypes: true });
    mdFiles = dirents
      .filter(d => d.isFile() && d.name.endsWith('.md'))
      .map(d => path.join(skillsMdDir, d.name))
      .sort();
  } catch {
    // skills/ subdirectory missing — fall through to manifest defaultPrompt
  }

  if (mdFiles.length > 0) {
    const parts = await Promise.all(mdFiles.map(f => fs.readFile(f, 'utf-8')));
    return parts.join('\n\n---\n\n');
  }

  // Fall back to manifest.json defaultPrompt
  const manifestPath = path.join(skillsDir, 'manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    if (manifest.defaultPrompt) return manifest.defaultPrompt as string;
  } catch {
    // ignore
  }

  throw new Error(`No skill prompt found in ${skillsDir}`);
}

/**
 * Invoke the Claude CLI for a single chunk.
 *
 * The chunk's file contents are written to a temp file and fed to Claude via
 * stdin so that we avoid shell-argument length limits.
 *
 * Expected Claude output: a single JSON object matching `ReviewOutput`.
 */
async function runClaudeOnChunk(
  chunk: FileChunk,
  skillPrompt: string,
  sourceDir: string,
  jobId: string,
): Promise<ReviewOutput> {
  // Render all file contents into a single string
  const codeContent = await renderChunkContent(chunk, MAX_TOKENS_PER_BATCH);

  // Write to a temp file so the prompt does not need shell escaping
  const tmpDir = `/tmp/chunks/${jobId}`;
  await fs.mkdir(tmpDir, { recursive: true });
  const chunkFile = path.join(tmpDir, `chunk-${chunk.index}.txt`);

  const fullPrompt = [
    skillPrompt,
    '',
    '## Source Files for This Review Batch',
    '',
    codeContent,
  ].join('\n');

  await fs.writeFile(chunkFile, fullPrompt, 'utf-8');

  // Invoke Claude CLI: read prompt from file via stdin redirection
  // claude --print reads from stdin when no file argument is given.
  const { stdout, stderr } = await execFileAsync(
    'claude',
    [
      '--print',            // non-interactive: print output and exit
      '--output-format', 'text',
    ],
    {
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024, // 20 MB stdout buffer
      env: {
        ...process.env,
        // Disable interactive features inside ECS
        CLAUDE_NO_COLOR: '1',
        NO_COLOR: '1',
      },
      // Feed the prompt via stdin
      input: fullPrompt,
    },
  );

  if (stderr && stderr.trim()) {
    console.warn(JSON.stringify({ event: 'claude_stderr', jobId, chunkIndex: chunk.index, stderr: stderr.slice(0, 500) }));
  }

  // Clean up temp file
  await fs.unlink(chunkFile).catch(() => {});

  // Parse JSON output — Claude is instructed to output ONLY JSON
  return parseClaudeOutput(stdout, chunk.index, jobId);
}

/**
 * Parse raw Claude stdout into a `ReviewOutput`.
 * Strips any accidental markdown code fences before parsing.
 */
function parseClaudeOutput(raw: string, chunkIndex: number, jobId: string): ReviewOutput {
  let text = raw.trim();

  // Strip optional markdown fences (```json … ``` or ``` … ```)
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Claude output for chunk ${chunkIndex} is not valid JSON. ` +
      `Parse error: ${String(err)}. ` +
      `First 200 chars: ${text.slice(0, 200)}`,
    );
  }

  // Basic shape validation
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    throw new Error(`Claude output for chunk ${chunkIndex} missing "findings" array`);
  }

  return obj as unknown as ReviewOutput;
}

// ── Finding deduplication ──────────────────────────────────────────────────────

/** Deduplication key: same file + line + CWE = same finding */
type DedupeKey = string;

function findingKey(f: SecurityFinding): DedupeKey {
  return `${f.file}:${f.line}:${f.cwe_id}`;
}

/**
 * Remove duplicate findings across chunks.
 * When duplicates exist, keep the one with the highest severity (first wins
 * on tie — chunks are processed in order so earlier batches take precedence).
 */
function deduplicateFindings(findings: SecurityFinding[]): SecurityFinding[] {
  const SEVERITY_RANK: Record<SecurityFinding['severity'], number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };

  const seen = new Map<DedupeKey, SecurityFinding>();

  for (const f of findings) {
    const key = findingKey(f);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, f);
    } else {
      // Keep the higher-severity duplicate
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
        seen.set(key, f);
      }
    }
  }

  return Array.from(seen.values());
}

// ── Risk level helpers ─────────────────────────────────────────────────────────

const RISK_RANK: Record<ReviewOutput['risk_level'], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  none: 0,
};

function riskMax(
  a: ReviewOutput['risk_level'],
  b: ReviewOutput['risk_level'],
): ReviewOutput['risk_level'] {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}
