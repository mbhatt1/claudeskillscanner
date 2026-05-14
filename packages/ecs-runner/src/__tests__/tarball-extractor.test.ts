/**
 * Unit tests for packages/ecs-runner/src/tarball-extractor.ts
 *
 * The extractor (SPEC-25 §5.3):
 *  - Uses `tar` (CLI) for .tar.gz / .tgz / .tar.bz2 / .tar.xz / .tar archives
 *  - Uses `unzip` (CLI) for .zip archives
 *  - Rejects anything else with "Unsupported archive format"
 *  - Calls verifyNoEscape() after extraction — throws on symlink escapes
 *
 * Size-limit enforcement (2 GB cap on total uncompressed content) is tested
 * by mocking `tar --list --verbose` / `unzip -v` outputs that the extractor
 * reads BEFORE running actual extraction.
 *
 * NOTE: The spec's §5.3 implementation does NOT include a pre-flight size
 * check; that is an extension.  If the module does not call execFile for a
 * listing, the size-limit tests will pass vacuously with the mocks set up here
 * because the actual tar/unzip invocations are mocked to succeed.  Update the
 * mocks to match the real pre-flight signature once implemented.
 */

import { jest } from '@jest/globals';

// ── Module-level mocks ────────────────────────────────────────────────────────

jest.mock('child_process');
jest.mock('fs/promises');

// ── Imports ───────────────────────────────────────────────────────────────────

import { execFile } from 'child_process';
import * as fsp from 'fs/promises';

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;
const mockFsp = fsp as jest.Mocked<typeof fsp>;

/**
 * Make execFile resolve with given stdout on its NEXT call.
 * Handles the two-arity forms: (cmd, args, callback) and (cmd, args, opts, callback).
 */
function execResolves(stdout = '', stderr = '') {
  mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    cb(null, stdout, stderr);
    return {} as any;
  });
}

function execRejects(message: string) {
  mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, callback: any) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    cb(new Error(message), '', '');
    return {} as any;
  });
}

function execAlwaysResolves(stdout = '') {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    cb(null, stdout, '');
    return {} as any;
  });
}

// ── Subject under test ────────────────────────────────────────────────────────

import { extractTarball } from '../tarball-extractor';

// ─────────────────────────────────────────────────────────────────────────────

const DEST = '/tmp/workspace/source';

/** Build a `tar --list --verbose` output line for a file of `sizeBytes` */
function tarVerboseLine(sizeBytes: number, name = 'file.txt'): string {
  // Format: permissions  links  owner  group  size  date  time  name
  return `-rw-r--r-- 0/0 ${sizeBytes} 2024-01-01 00:00 ${name}`;
}

/** Build a `unzip -v` summary line for a file of `sizeBytes` */
function unzipVerboseLine(sizeBytes: number, name = 'file.txt'): string {
  // Format: length  method  size  cmpr  date  time  crc-32  name
  return `${sizeBytes.toString().padStart(9)}  Defl:N ${sizeBytes.toString().padStart(9)}   0%  2024-01-01 00:00  00000000  ${name}`;
}

const TWO_GB = 2 * 1024 * 1024 * 1024;

beforeEach(() => {
  jest.clearAllMocks();
  mockFsp.mkdir.mockResolvedValue(undefined);
  // Default: empty directory (no entries → verifyNoEscape is a no-op)
  mockFsp.readdir.mockResolvedValue([] as any);
  execAlwaysResolves('');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Supported format routing
// ─────────────────────────────────────────────────────────────────────────────

describe('format routing', () => {
  describe('.tgz / .tar.gz', () => {
    it('calls tar with --strip-components=1 --no-same-owner for a .tgz file', async () => {
      const calls: { cmd: string; args: string[] }[] = [];
      mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        const cb = typeof opts === 'function' ? opts : callback;
        calls.push({ cmd, args });
        cb(null, '', '');
        return {} as any;
      });

      await extractTarball('/tmp/archive.tgz', DEST);

      const tarCall = calls.find(c => c.cmd === 'tar');
      expect(tarCall).toBeDefined();
      expect(tarCall!.args).toContain('--strip-components=1');
      expect(tarCall!.args).toContain('--no-same-owner');
    });

    it('calls tar with --strip-components=1 --no-same-owner for a .tar.gz file', async () => {
      const calls: { cmd: string; args: string[] }[] = [];
      mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        const cb = typeof opts === 'function' ? opts : callback;
        calls.push({ cmd, args });
        cb(null, '', '');
        return {} as any;
      });

      await extractTarball('/tmp/pkg-1.0.0.tar.gz', DEST);

      const tarCall = calls.find(c => c.cmd === 'tar');
      expect(tarCall).toBeDefined();
      expect(tarCall!.args).toContain('--strip-components=1');
      expect(tarCall!.args).toContain('--no-same-owner');
    });

    it('passes the archive path and destination directory to tar', async () => {
      const archivePath = '/tmp/pkg-1.0.0.tgz';
      const calls: { cmd: string; args: string[] }[] = [];
      mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        const cb = typeof opts === 'function' ? opts : callback;
        calls.push({ cmd, args });
        cb(null, '', '');
        return {} as any;
      });

      await extractTarball(archivePath, DEST);

      const tarCall = calls.find(c => c.cmd === 'tar');
      expect(tarCall!.args).toContain(archivePath);
      expect(tarCall!.args).toContain(DEST);
    });
  });

  describe('.zip', () => {
    it('calls unzip (not tar) for a .zip file', async () => {
      const calls: { cmd: string; args: string[] }[] = [];
      mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
        const cb = typeof opts === 'function' ? opts : callback;
        calls.push({ cmd, args });
        cb(null, '', '');
        return {} as any;
      });

      await extractTarball('/tmp/archive.zip', DEST);

      const unzipCall = calls.find(c => c.cmd === 'unzip');
      expect(unzipCall).toBeDefined();
      const tarCall = calls.find(c => c.cmd === 'tar');
      expect(tarCall).toBeUndefined();
    });
  });

  describe('unsupported formats', () => {
    it('throws "Unsupported archive format" for a .rar file', async () => {
      await expect(extractTarball('/tmp/archive.rar', DEST)).rejects.toThrow(
        /Unsupported archive format/i,
      );
    });

    it('throws for a .7z file', async () => {
      await expect(extractTarball('/tmp/archive.7z', DEST)).rejects.toThrow(
        /Unsupported archive format/i,
      );
    });

    it('throws for a .exe file', async () => {
      await expect(extractTarball('/tmp/payload.exe', DEST)).rejects.toThrow(
        /Unsupported archive format/i,
      );
    });

    it('does not call execFile before throwing', async () => {
      await expect(extractTarball('/tmp/archive.rar', DEST)).rejects.toThrow();
      // No listing or extraction should have been attempted
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Size-limit enforcement (pre-flight check)
// ─────────────────────────────────────────────────────────────────────────────
//
// The extractor is expected to run `tar --list --verbose` (or `unzip -v`)
// before extraction and sum the uncompressed sizes.  Tests mock these outputs.
//
// If the implementation does not yet perform a pre-flight check, the size-limit
// tests will still pass because the mock is set up to make the actual extraction
// succeed regardless.  Add `expect(…).rejects` assertions here once the
// pre-flight is wired in.

describe('size-limit enforcement — .tar.gz', () => {
  /**
   * Build a tar verbose listing whose total uncompressed size equals `totalBytes`.
   * We use two files, each half the total.
   */
  function buildTarListing(totalBytes: number): string {
    const half = Math.floor(totalBytes / 2);
    return [
      tarVerboseLine(half, 'pkg/a.js'),
      tarVerboseLine(half, 'pkg/b.js'),
    ].join('\n');
  }

  it('proceeds with extraction when total uncompressed size is under 2 GB', async () => {
    // Pre-flight listing → under 2 GB
    execResolves(buildTarListing(TWO_GB - 1));
    // Actual extraction → success
    execResolves('');

    await expect(extractTarball('/tmp/small.tar.gz', DEST)).resolves.not.toThrow();
  });

  it('throws a clear message when total uncompressed size exceeds 2 GB', async () => {
    // Pre-flight listing → over 2 GB
    execResolves(buildTarListing(TWO_GB + 1));
    // Extraction must NOT be attempted, so we do not queue another resolve

    await expect(extractTarball('/tmp/huge.tar.gz', DEST)).rejects.toThrow(
      /2\s*GB|size limit|too large/i,
    );
  });
});

describe('size-limit enforcement — .zip', () => {
  /**
   * Build a `unzip -v` listing whose total uncompressed size equals `totalBytes`.
   */
  function buildUnzipListing(totalBytes: number): string {
    const half = Math.floor(totalBytes / 2);
    const lines = [
      'Archive:  archive.zip',
      ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name',
      '--------  ------  ------  ----  ---------- -----  --------  ----',
      unzipVerboseLine(half, 'pkg/a.js'),
      unzipVerboseLine(half, 'pkg/b.js'),
      '--------          ------                            -------',
      `${totalBytes}           ${totalBytes}                            2 files`,
    ].join('\n');
    return lines;
  }

  it('proceeds when total uncompressed zip entries are under 2 GB', async () => {
    execResolves(buildUnzipListing(TWO_GB - 1024));
    execResolves(''); // actual unzip

    await expect(extractTarball('/tmp/small.zip', DEST)).resolves.not.toThrow();
  });

  it('throws when total uncompressed zip entries exceed 2 GB', async () => {
    execResolves(buildUnzipListing(TWO_GB + 1024));

    await expect(extractTarball('/tmp/huge.zip', DEST)).rejects.toThrow(
      /2\s*GB|size limit|too large/i,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Symlink escape detection (verifyNoEscape)
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyNoEscape — symlink safety', () => {
  /**
   * Set up fs.readdir to return a single symlink entry whose realpath
   * resolves to `resolvedTarget`.
   */
  function setupSymlink(resolvedTarget: string) {
    const symlinkEntry = {
      name: 'evil-link',
      isSymbolicLink: () => true,
      isFile: () => false,
      isDirectory: () => false,
      // Node.js >= 18 `readdir` with `recursive` includes `path`
      path: DEST,
    };
    mockFsp.readdir.mockResolvedValueOnce([symlinkEntry] as any);
    mockFsp.realpath.mockResolvedValueOnce(resolvedTarget as any);
  }

  it('throws "Symlink escape detected" when a symlink points outside destDir', async () => {
    // Extraction succeeds
    execAlwaysResolves('');
    // Symlink resolves outside DEST
    setupSymlink('/etc/passwd');

    await expect(extractTarball('/tmp/evil.tgz', DEST)).rejects.toThrow(
      /Symlink escape detected/i,
    );
  });

  it('does not throw when a symlink resolves inside destDir', async () => {
    execAlwaysResolves('');
    // Symlink resolves inside DEST
    setupSymlink(`${DEST}/subdir/real-file.txt`);

    await expect(extractTarball('/tmp/safe.tgz', DEST)).resolves.not.toThrow();
  });

  it('does not throw when there are no symlinks in the archive', async () => {
    execAlwaysResolves('');
    // readdir returns a regular file entry
    const regularEntry = {
      name: 'main.js',
      isSymbolicLink: () => false,
      isFile: () => true,
      isDirectory: () => false,
      path: DEST,
    };
    mockFsp.readdir.mockResolvedValueOnce([regularEntry] as any);

    await expect(extractTarball('/tmp/normal.tgz', DEST)).resolves.not.toThrow();
    expect(mockFsp.realpath).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe('error propagation', () => {
  it('re-throws tar extraction errors', async () => {
    execRejects('tar: Unexpected EOF in archive');

    await expect(extractTarball('/tmp/corrupt.tgz', DEST)).rejects.toThrow(
      /Unexpected EOF/i,
    );
  });

  it('re-throws unzip extraction errors', async () => {
    execRejects('unzip: cannot find zipfile directory');

    await expect(extractTarball('/tmp/corrupt.zip', DEST)).rejects.toThrow(
      /cannot find zipfile/i,
    );
  });

  it('creates destDir before extracting', async () => {
    execAlwaysResolves('');
    await extractTarball('/tmp/pkg.tgz', DEST);

    expect(mockFsp.mkdir).toHaveBeenCalledWith(DEST, { recursive: true });
  });
});
