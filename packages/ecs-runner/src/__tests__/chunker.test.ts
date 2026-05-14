// packages/ecs-runner/src/__tests__/chunker.test.ts

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  buildFileList,
  chunkFiles,
  renderChunkContent,
  MAX_TOKENS_PER_BATCH,
  FileEntry,
  FileChunk,
} from '../chunker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `chunker-test-${Math.random().toString(36).slice(2)}`);
}

/** Write a file whose content is `charCount` repetitions of 'a'. */
async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

function repeatChar(char: string, n: number): string {
  return char.repeat(n);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = makeTmpDir();
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildFileList tests
// ---------------------------------------------------------------------------

describe('buildFileList', () => {
  test('empty directory returns empty array', async () => {
    const entries = await buildFileList(tmpDir);
    expect(entries).toEqual([]);
  });

  test('single small file produces one FileEntry', async () => {
    const content = 'hello world';
    await writeFile(path.join(tmpDir, 'file.ts'), content);

    const entries = await buildFileList(tmpDir);

    expect(entries).toHaveLength(1);
    expect(entries[0].relativePath).toBe('file.ts');
    expect(entries[0].absolutePath).toBe(path.join(tmpDir, 'file.ts'));
    expect(entries[0].estimatedTokens).toBe(Math.ceil(content.length / 4));
  });

  test('file >10MB uses stat.size/4 for token estimate (not full file read)', async () => {
    const TEN_MB_PLUS_ONE = 10 * 1024 * 1024 + 1;
    const filePath = path.join(tmpDir, 'huge.bin');

    // Create a sparse/truncated file at exactly the threshold + 1 byte.
    // We use truncate so we don't actually write 10 MB of data to disk.
    await fs.writeFile(filePath, '');
    await fs.truncate(filePath, TEN_MB_PLUS_ONE);

    const entries = await buildFileList(tmpDir);

    expect(entries).toHaveLength(1);
    // Token estimate must be ceil(size / 4), NOT based on reading content.
    expect(entries[0].estimatedTokens).toBe(Math.ceil(TEN_MB_PLUS_ONE / 4));
  });

  test('symlink pointing outside sourceDir is excluded', async () => {
    // Create a file outside the source directory.
    const outsideDir = makeTmpDir();
    await fs.mkdir(outsideDir, { recursive: true });
    const externalFile = path.join(outsideDir, 'secret.ts');
    await fs.writeFile(externalFile, 'secret content');

    // Create a symlink inside tmpDir pointing to the external file.
    const symlinkPath = path.join(tmpDir, 'evil-link.ts');
    await fs.symlink(externalFile, symlinkPath);

    try {
      const entries = await buildFileList(tmpDir);
      const paths = entries.map(e => e.relativePath);
      expect(paths).not.toContain('evil-link.ts');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('returns paths sorted deterministically', async () => {
    // Write files in non-alphabetical creation order.
    await writeFile(path.join(tmpDir, 'zebra.ts'), 'z');
    await writeFile(path.join(tmpDir, 'apple.ts'), 'a');
    await writeFile(path.join(tmpDir, 'mango.ts'), 'm');

    const entries1 = await buildFileList(tmpDir);
    const entries2 = await buildFileList(tmpDir);

    const paths1 = entries1.map(e => e.relativePath);
    const paths2 = entries2.map(e => e.relativePath);

    // Order must be identical across two calls.
    expect(paths1).toEqual(paths2);
  });
});

// ---------------------------------------------------------------------------
// chunkFiles tests
// ---------------------------------------------------------------------------

describe('chunkFiles', () => {
  /** Build a synthetic FileEntry with the given token count. */
  function makeEntry(name: string, tokens: number): FileEntry {
    return {
      absolutePath: `/fake/${name}`,
      relativePath: name,
      estimatedTokens: tokens,
    };
  }

  test('empty file list returns empty chunks array', () => {
    expect(chunkFiles([])).toEqual([]);
  });

  test('single small file (<80k tokens) produces one chunk', () => {
    const files = [makeEntry('a.ts', 1000)];
    const chunks = chunkFiles(files);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].files).toHaveLength(1);
    expect(chunks[0].totalEstimatedTokens).toBe(1000);
  });

  test('three files summing to exactly 80k tokens produce one chunk', () => {
    const files = [
      makeEntry('a.ts', 20_000),
      makeEntry('b.ts', 30_000),
      makeEntry('c.ts', 30_000),
    ];
    const chunks = chunkFiles(files);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].totalEstimatedTokens).toBe(80_000);
  });

  test('fourth file that pushes total over 80k produces two chunks', () => {
    // First three = exactly 80k, fourth pushes over.
    const files = [
      makeEntry('a.ts', 20_000),
      makeEntry('b.ts', 30_000),
      makeEntry('c.ts', 30_000),
      makeEntry('d.ts', 1),
    ];
    const chunks = chunkFiles(files);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].files.map(f => f.relativePath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(chunks[1].files.map(f => f.relativePath)).toEqual(['d.ts']);
  });

  test('single file exceeding 80k tokens is placed alone in its own chunk (not split)', () => {
    const files = [makeEntry('giant.ts', 200_000)];
    const chunks = chunkFiles(files);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].files).toHaveLength(1);
    expect(chunks[0].files[0].relativePath).toBe('giant.ts');
    expect(chunks[0].totalEstimatedTokens).toBe(200_000);
  });

  test('oversized file that follows normal files starts a new chunk', () => {
    const files = [
      makeEntry('small.ts', 1_000),
      makeEntry('giant.ts', 200_000),
    ];
    const chunks = chunkFiles(files);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].files[0].relativePath).toBe('small.ts');
    expect(chunks[1].files[0].relativePath).toBe('giant.ts');
  });

  test('chunk indices are 0-based and contiguous', () => {
    const files = [
      makeEntry('a.ts', 50_000),
      makeEntry('b.ts', 50_000),
      makeEntry('c.ts', 50_000),
    ];
    const chunks = chunkFiles(files);

    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
    });
  });
});

// ---------------------------------------------------------------------------
// renderChunkContent tests
// ---------------------------------------------------------------------------

describe('renderChunkContent', () => {
  function makeChunk(files: FileEntry[], index = 0): FileChunk {
    const totalEstimatedTokens = files.reduce((s, f) => s + f.estimatedTokens, 0);
    return { index, files, totalEstimatedTokens };
  }

  test('formats output as "=== FILE: <relativePath> ===\\n<content>"', async () => {
    const content = 'const x = 1;\n';
    const filePath = path.join(tmpDir, 'src', 'app.ts');
    await writeFile(filePath, content);

    const entry: FileEntry = {
      absolutePath: filePath,
      relativePath: 'src/app.ts',
      estimatedTokens: Math.ceil(content.length / 4),
    };
    const chunk = makeChunk([entry]);
    const rendered = await renderChunkContent(chunk);

    expect(rendered).toContain('=== FILE: src/app.ts ===');
    expect(rendered).toContain(content);
    // Header must immediately precede content
    const headerIdx = rendered.indexOf('=== FILE: src/app.ts ===\n');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const afterHeader = rendered.slice(headerIdx + '=== FILE: src/app.ts ===\n'.length);
    expect(afterHeader.startsWith(content)).toBe(true);
  });

  test('truncates file content at maxTokensPerBatch*4 chars with [TRUNCATED] marker', async () => {
    const maxTokens = 100; // use a tiny budget for this test
    const maxChars = maxTokens * 4; // 400
    // Write a file longer than maxChars
    const longContent = repeatChar('x', maxChars + 50);
    const filePath = path.join(tmpDir, 'long.ts');
    await writeFile(filePath, longContent);

    const entry: FileEntry = {
      absolutePath: filePath,
      relativePath: 'long.ts',
      estimatedTokens: Math.ceil(longContent.length / 4),
    };
    const chunk = makeChunk([entry]);
    const rendered = await renderChunkContent(chunk, maxTokens);

    // Content must be cut to maxChars characters before the marker
    expect(rendered).toContain('[TRUNCATED');
    // The content portion before [TRUNCATED] must be exactly maxChars chars of 'x'
    const contentStart = rendered.indexOf('=== FILE: long.ts ===\n') + '=== FILE: long.ts ===\n'.length;
    const contentSection = rendered.slice(contentStart, contentStart + maxChars);
    expect(contentSection).toBe(repeatChar('x', maxChars));
    // The part just after must be the truncation notice
    expect(rendered.slice(contentStart + maxChars)).toContain('[TRUNCATED');
  });

  test('multiple files in chunk are separated and all rendered', async () => {
    await writeFile(path.join(tmpDir, 'a.ts'), 'aaa');
    await writeFile(path.join(tmpDir, 'b.ts'), 'bbb');

    const entries: FileEntry[] = [
      { absolutePath: path.join(tmpDir, 'a.ts'), relativePath: 'a.ts', estimatedTokens: 1 },
      { absolutePath: path.join(tmpDir, 'b.ts'), relativePath: 'b.ts', estimatedTokens: 1 },
    ];
    const chunk = makeChunk(entries);
    const rendered = await renderChunkContent(chunk);

    expect(rendered).toContain('=== FILE: a.ts ===');
    expect(rendered).toContain('=== FILE: b.ts ===');
    expect(rendered).toContain('aaa');
    expect(rendered).toContain('bbb');
  });

  test('unreadable file produces [UNREADABLE] marker', async () => {
    const entry: FileEntry = {
      absolutePath: path.join(tmpDir, 'nonexistent.ts'),
      relativePath: 'nonexistent.ts',
      estimatedTokens: 0,
    };
    const chunk = makeChunk([entry]);
    const rendered = await renderChunkContent(chunk);

    expect(rendered).toContain('[UNREADABLE]');
  });
});
