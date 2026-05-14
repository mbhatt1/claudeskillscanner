// packages/ecs-runner/src/chunker.ts
//
// Splits a list of source files into token-bounded batches so that each
// Claude invocation stays well under the context-window limit.
//
// Token estimation: chars / 4  (rough but fast; safe because the prompt +
// output budget is subtracted from the 80 k ceiling at call time).

import * as fs from 'fs/promises';
import * as path from 'path';

export const MAX_TOKENS_PER_BATCH = 80_000; // leaves room for prompt + output

export interface FileEntry {
  /** Absolute path on disk */
  absolutePath: string;
  /** Relative path from the source root — stored in findings */
  relativePath: string;
  /** Estimated token count (chars / 4) */
  estimatedTokens: number;
}

export interface FileChunk {
  /** 0-based chunk index */
  index: number;
  files: FileEntry[];
  totalEstimatedTokens: number;
}

/**
 * Walk `sourceDir` recursively and return a `FileEntry` for every file found.
 * Files whose content cannot be read are silently skipped (e.g. broken symlinks).
 */
export async function buildFileList(sourceDir: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  await walk(sourceDir, sourceDir, entries);
  return entries;
}

async function walk(rootDir: string, currentDir: string, out: FileEntry[]): Promise<void> {
  let dirents: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    dirents = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip
  }

  for (const dirent of dirents) {
    const abs = path.join(currentDir, dirent.name);

    if (dirent.isSymbolicLink()) {
      // Resolve and check for escape; skip if it escapes the root
      try {
        const real = await fs.realpath(abs);
        if (!real.startsWith(path.resolve(rootDir))) continue;
        // Treat resolved symlinks as regular files below
        const stat = await fs.stat(abs);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
    }

    if (dirent.isDirectory()) {
      await walk(rootDir, abs, out);
      continue;
    }

    if (!dirent.isFile()) continue;

    const relativePath = path.relative(rootDir, abs);

    // Estimate token count without reading the whole file into memory for huge files;
    // read a stat first and fall back to stat.size / 4 for files > 10 MB.
    let estimatedTokens: number;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > 10 * 1024 * 1024) {
        // Very large file — estimate from size alone, will land in its own chunk
        estimatedTokens = Math.ceil(stat.size / 4);
      } else {
        const content = await fs.readFile(abs, 'utf-8');
        estimatedTokens = Math.ceil(content.length / 4);
      }
    } catch {
      continue; // unreadable — skip
    }

    out.push({ absolutePath: abs, relativePath, estimatedTokens });
  }
}

/**
 * Group `files` into batches where the total estimated token count of each
 * batch does not exceed `maxTokensPerBatch`.
 *
 * Files that individually exceed the limit are placed alone in their own chunk
 * (the caller must handle oversized files gracefully, e.g. by passing only the
 * first N bytes to Claude).
 */
export function chunkFiles(
  files: FileEntry[],
  maxTokensPerBatch: number = MAX_TOKENS_PER_BATCH,
): FileChunk[] {
  const chunks: FileChunk[] = [];
  let current: FileEntry[] = [];
  let currentTokens = 0;

  for (const file of files) {
    const t = file.estimatedTokens;

    if (current.length > 0 && currentTokens + t > maxTokensPerBatch) {
      // Flush current batch
      chunks.push({ index: chunks.length, files: current, totalEstimatedTokens: currentTokens });
      current = [];
      currentTokens = 0;
    }

    current.push(file);
    currentTokens += t;
  }

  if (current.length > 0) {
    chunks.push({ index: chunks.length, files: current, totalEstimatedTokens: currentTokens });
  }

  return chunks;
}

/**
 * Read the content of all files in a chunk and return a combined string
 * suitable for embedding in a Claude prompt.
 *
 * Format per file:
 *   === FILE: <relativePath> ===
 *   <content>
 *   (blank line)
 *
 * Oversized individual files are truncated to `maxTokensPerBatch * 4` chars
 * with a truncation notice appended.
 */
export async function renderChunkContent(
  chunk: FileChunk,
  maxTokensPerBatch: number = MAX_TOKENS_PER_BATCH,
): Promise<string> {
  const maxChars = maxTokensPerBatch * 4;
  const parts: string[] = [];

  for (const file of chunk.files) {
    let content: string;
    try {
      content = await fs.readFile(file.absolutePath, 'utf-8');
    } catch {
      content = '[UNREADABLE]';
    }

    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '\n[TRUNCATED — file exceeds per-file token budget]';
    }

    parts.push(`=== FILE: ${file.relativePath} ===\n${content}\n`);
  }

  return parts.join('\n');
}
