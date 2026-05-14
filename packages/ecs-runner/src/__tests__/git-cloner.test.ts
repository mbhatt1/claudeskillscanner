/**
 * Unit tests for packages/ecs-runner/src/git-cloner.ts
 *
 * The git-cloner module (per SPEC-25 §5.4) accepts HTTPS and SSH git URLs,
 * validates destDir and gitRef, and shells out to git.
 *
 * An extended implementation adds:
 *  - SSM-backed token injection for GitHub / GitLab HTTPS clones
 *  - SSH private-key materialisation in /tmp/.ssh/id_rsa (wiped after clone)
 *  - Sparse-checkout support via `git sparse-checkout init/set`
 *
 * These tests are written against that extended interface.  The core spec
 * implementation (§5.4) satisfies the validation and basic-clone cases.
 */

import { jest } from '@jest/globals';

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

jest.mock('child_process');
jest.mock('@aws-sdk/client-ssm');
jest.mock('fs/promises');

// ── Imports ───────────────────────────────────────────────────────────────────

import { execFile } from 'child_process';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import * as fsp from 'fs/promises';

// ── Typed mock helpers ────────────────────────────────────────────────────────

/**
 * Wrap `promisify(execFile)` — the module under test calls
 * `promisify(execFile)` internally; we mock the underlying `execFile`.
 */
const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

/** Helper: make execFile resolve with given stdout for the NEXT call */
function execResolves(stdout = '', stderr = '') {
  // execFile callback signature: (error, stdout, stderr)
  mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
    // opts may be omitted — handle both arities
    const cb = typeof _opts === 'function' ? _opts : callback;
    cb(null, stdout, stderr);
    return {} as any;
  });
}

/** Helper: make execFile reject with an error for the NEXT call */
function execRejects(message: string) {
  mockExecFile.mockImplementationOnce((_cmd, _args, _opts, callback: any) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    cb(new Error(message), '', '');
    return {} as any;
  });
}

/** Helper: make ALL remaining execFile calls resolve successfully */
function execAlwaysResolves(stdout = '') {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback: any) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    cb(null, stdout, '');
    return {} as any;
  });
}

// ── SSM mock ─────────────────────────────────────────────────────────────────

const mockSsmSend = jest.fn();
(SSMClient as jest.MockedClass<typeof SSMClient>).mockImplementation(() => ({
  send: mockSsmSend,
}) as any);

function ssmReturns(value: string) {
  mockSsmSend.mockResolvedValueOnce({
    Parameter: { Value: value },
  });
}

// ── fs/promises mock ──────────────────────────────────────────────────────────

const mockFsp = fsp as jest.Mocked<typeof fsp>;

// ── Subject under test (imported after mocks are set up) ─────────────────────

// NOTE: Jest hoists `jest.mock()` calls, so the mocks above are active before
// the module is loaded even though the import appears here in source order.
import { cloneRepo } from '../git-cloner';

// ─────────────────────────────────────────────────────────────────────────────

const DEST = '/tmp/workspace/source';
const FULL_SHA = 'a'.repeat(40);            // 40 hex chars → "full SHA" path
const BRANCH = 'main';

beforeEach(() => {
  jest.clearAllMocks();
  mockFsp.mkdir.mockResolvedValue(undefined);
  mockFsp.writeFile.mockResolvedValue(undefined);
  mockFsp.unlink.mockResolvedValue(undefined);
  // Default: all git invocations succeed
  execAlwaysResolves('');
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. URL host detection
// ─────────────────────────────────────────────────────────────────────────────

describe('host detection — GitHub HTTPS', () => {
  it('detects https://github.com as "github" and reads the github-token SSM param', async () => {
    ssmReturns('ghp_test_token');
    execAlwaysResolves('');

    await cloneRepo('https://github.com/owner/repo', BRANCH, DEST);

    // SSM should have been queried for a github token
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    const cmd: GetParameterCommand = mockSsmSend.mock.calls[0][0];
    expect(cmd.input.Name).toMatch(/github[-_]token/i);
    expect(cmd.input.WithDecryption).toBe(true);
  });

  it('injects GitHub token via GIT_CONFIG_* env vars on the clone command', async () => {
    ssmReturns('ghp_test_token');

    const cloneCalls: { cmd: string; args: string[]; opts: any }[] = [];
    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
      const cb = typeof opts === 'function' ? opts : callback;
      cloneCalls.push({ cmd, args, opts: typeof opts === 'object' ? opts : {} });
      cb(null, '', '');
      return {} as any;
    });

    await cloneRepo('https://github.com/owner/repo', BRANCH, DEST);

    // Find the `git clone` call
    const cloneCall = cloneCalls.find(c => c.cmd === 'git' && c.args.includes('clone'));
    expect(cloneCall).toBeDefined();

    // Token must be passed via GIT_CONFIG_* environment variables, NOT embedded in the URL
    const env = cloneCall!.opts?.env ?? {};
    const envValues = Object.values(env) as string[];
    expect(envValues.some(v => v.includes('extraheader') || v.includes('Authorization'))).toBe(true);
    // The raw token must NOT appear in the URL argument
    const urlArg = cloneCall!.args.find((a: string) => a.startsWith('https://'));
    expect(urlArg).toBe('https://github.com/owner/repo');
  });
});

describe('host detection — GitLab HTTPS', () => {
  it('detects https://gitlab.com as "gitlab" and reads the gitlab-token SSM param', async () => {
    ssmReturns('glpat_test_token');
    execAlwaysResolves('');

    await cloneRepo('https://gitlab.com/group/project', BRANCH, DEST);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    const cmd: GetParameterCommand = mockSsmSend.mock.calls[0][0];
    expect(cmd.input.Name).toMatch(/gitlab[-_]token/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SSH clone path
// ─────────────────────────────────────────────────────────────────────────────

describe('SSH clone (git+ssh:// or ssh://git@)', () => {
  const SSH_URL = 'ssh://git@github.com/owner/repo';
  const FAKE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n';
  const SSH_KEY_PATH = '/tmp/.ssh/id_rsa';

  beforeEach(() => {
    ssmReturns(FAKE_KEY);
    execAlwaysResolves('');
  });

  it('reads SSH private key from SSM', async () => {
    await cloneRepo(SSH_URL, BRANCH, DEST);

    expect(mockSsmSend).toHaveBeenCalledTimes(1);
    const cmd: GetParameterCommand = mockSsmSend.mock.calls[0][0];
    expect(cmd.input.Name).toMatch(/ssh[-_](private[-_])?key/i);
    expect(cmd.input.WithDecryption).toBe(true);
  });

  it('writes the SSH key to /tmp/.ssh/id_rsa with mode 0o600 before cloning', async () => {
    await cloneRepo(SSH_URL, BRANCH, DEST);

    expect(mockFsp.writeFile).toHaveBeenCalledWith(
      SSH_KEY_PATH,
      FAKE_KEY,
      expect.objectContaining({ mode: 0o600 }),
    );
  });

  it('sets GIT_SSH_COMMAND pointing to the key file on the clone call', async () => {
    const cloneCalls: { cmd: string; args: string[]; opts: any }[] = [];
    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
      const cb = typeof opts === 'function' ? opts : callback;
      cloneCalls.push({ cmd, args, opts: typeof opts === 'object' ? opts : {} });
      cb(null, '', '');
      return {} as any;
    });

    await cloneRepo(SSH_URL, BRANCH, DEST);

    const cloneCall = cloneCalls.find(c => c.cmd === 'git' && c.args.includes('clone'));
    expect(cloneCall).toBeDefined();
    const env = cloneCall!.opts?.env ?? {};
    expect(env['GIT_SSH_COMMAND']).toMatch(/id_rsa/);
    expect(env['GIT_SSH_COMMAND']).toMatch(/StrictHostKeyChecking/);
  });

  it('wipes (overwrites with zeros then unlinks) the SSH key after a successful clone', async () => {
    await cloneRepo(SSH_URL, BRANCH, DEST);

    // Should overwrite with zeros
    expect(mockFsp.writeFile).toHaveBeenCalledWith(
      SSH_KEY_PATH,
      expect.stringMatching(/^0+$/),
      expect.anything(),
    );
    // Should then unlink
    expect(mockFsp.unlink).toHaveBeenCalledWith(SSH_KEY_PATH);
  });

  it('wipes the SSH key even when the clone fails', async () => {
    // SSM call succeeds → key is written
    // Then git clone fails
    ssmReturns(FAKE_KEY); // second call for the test-level beforeEach already set one; clear and reset
    jest.clearAllMocks();
    mockFsp.mkdir.mockResolvedValue(undefined);
    mockFsp.writeFile.mockResolvedValue(undefined);
    mockFsp.unlink.mockResolvedValue(undefined);
    ssmReturns(FAKE_KEY);

    // First execFile (git clone) fails
    execRejects('network error');
    // Any subsequent calls (rm -rf .git etc.) succeed
    execAlwaysResolves('');

    await expect(cloneRepo(SSH_URL, BRANCH, DEST)).rejects.toThrow();

    // Key wipe must still happen
    expect(mockFsp.writeFile).toHaveBeenCalledWith(
      SSH_KEY_PATH,
      expect.stringMatching(/^0+$/),
      expect.anything(),
    );
    expect(mockFsp.unlink).toHaveBeenCalledWith(SSH_KEY_PATH);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('URL scheme validation', () => {
  it('throws "Unsupported git URL scheme" for ftp:// URLs', async () => {
    await expect(
      cloneRepo('ftp://example.com/repo.git', BRANCH, DEST),
    ).rejects.toThrow(/Unsupported git URL scheme/i);
  });

  it('throws for plain http:// URLs', async () => {
    await expect(
      cloneRepo('http://github.com/owner/repo', BRANCH, DEST),
    ).rejects.toThrow(/Unsupported git URL scheme/i);
  });

  it('throws for file:// URLs', async () => {
    await expect(
      cloneRepo('file:///etc/passwd', BRANCH, DEST),
    ).rejects.toThrow(/Unsupported git URL scheme/i);
  });
});

describe('destDir validation', () => {
  it('throws when destDir is not under /tmp/', async () => {
    await expect(
      cloneRepo('https://github.com/owner/repo', BRANCH, '/var/task/source'),
    ).rejects.toThrow(/destDir must be under \/tmp\//i);
  });

  it('throws for destDir = /tmp (no trailing slash subdirectory)', async () => {
    await expect(
      cloneRepo('https://github.com/owner/repo', BRANCH, '/tmp'),
    ).rejects.toThrow(/destDir must be under \/tmp\//i);
  });

  it('accepts /tmp/workspace/source as a valid destDir', async () => {
    ssmReturns('ghp_token');
    execAlwaysResolves('');
    await expect(
      cloneRepo('https://github.com/owner/repo', BRANCH, '/tmp/workspace/source'),
    ).resolves.not.toThrow();
  });
});

describe('gitRef validation', () => {
  it('throws "Invalid git ref" when ref contains shell metacharacters (; rm -rf)', async () => {
    await expect(
      cloneRepo('https://github.com/owner/repo', '; rm -rf /', DEST),
    ).rejects.toThrow(/Invalid git ref/i);
  });

  it('throws for ref containing $() subshell syntax', async () => {
    await expect(
      cloneRepo('https://github.com/owner/repo', '$(whoami)', DEST),
    ).rejects.toThrow(/Invalid git ref/i);
  });

  it('throws for ref containing backtick injection', async () => {
    await expect(
      cloneRepo('https://github.com/owner/repo', '`id`', DEST),
    ).rejects.toThrow(/Invalid git ref/i);
  });

  it('accepts a valid short branch name', async () => {
    ssmReturns('ghp_token');
    execAlwaysResolves('');
    await expect(
      cloneRepo('https://github.com/owner/repo', 'feat/my-feature', DEST),
    ).resolves.not.toThrow();
  });

  it('accepts a full 40-char hex SHA', async () => {
    ssmReturns('ghp_token');
    execAlwaysResolves(FULL_SHA + '\n'); // rev-parse HEAD returns the SHA
    await expect(
      cloneRepo('https://github.com/owner/repo', FULL_SHA, DEST),
    ).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Full SHA vs. branch/tag clone path
// ─────────────────────────────────────────────────────────────────────────────

describe('cloneFullSha vs cloneBranchOrTag', () => {
  it('uses depth-1 clone then fetch+checkout for a full 40-char SHA', async () => {
    ssmReturns('ghp_token');

    const calls: { cmd: string; args: string[] }[] = [];
    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
      const cb = typeof opts === 'function' ? opts : callback;
      calls.push({ cmd, args });
      // rev-parse HEAD → return the same SHA so we don't throw
      if (args.includes('rev-parse')) {
        cb(null, FULL_SHA + '\n', '');
      } else {
        cb(null, '', '');
      }
      return {} as any;
    });

    await cloneRepo('https://github.com/owner/repo', FULL_SHA, DEST);

    const gitArgs = calls.filter(c => c.cmd === 'git').map(c => c.args);

    // Should have a plain clone (without --branch flag)
    const cloneCall = gitArgs.find(a => a.includes('clone') && !a.includes('--branch'));
    expect(cloneCall).toBeDefined();

    // Should have a fetch of the specific SHA
    const fetchCall = gitArgs.find(a => a.includes('fetch') && a.includes(FULL_SHA));
    expect(fetchCall).toBeDefined();

    // Should have a checkout of the specific SHA
    const checkoutCall = gitArgs.find(a => a.includes('checkout') && a.includes(FULL_SHA));
    expect(checkoutCall).toBeDefined();
  });

  it('uses --branch flag for a short branch name (cloneBranchOrTag path)', async () => {
    ssmReturns('ghp_token');

    const calls: { cmd: string; args: string[] }[] = [];
    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
      const cb = typeof opts === 'function' ? opts : callback;
      calls.push({ cmd, args });
      cb(null, '', '');
      return {} as any;
    });

    await cloneRepo('https://github.com/owner/repo', 'release/v2.0', DEST);

    const gitArgs = calls.filter(c => c.cmd === 'git').map(c => c.args);

    // Should have clone with --branch
    const cloneWithBranch = gitArgs.find(a => a.includes('clone') && a.includes('--branch'));
    expect(cloneWithBranch).toBeDefined();
    expect(cloneWithBranch).toContain('release/v2.0');

    // Should NOT have a separate fetch for a SHA
    const fetchWithSha = gitArgs.find(a => a.includes('fetch') && a.some((v: string) => /^[0-9a-f]{40}$/.test(v)));
    expect(fetchWithSha).toBeUndefined();
  });

  it('removes the .git directory after a successful clone', async () => {
    ssmReturns('ghp_token');

    const calls: { cmd: string; args: string[] }[] = [];
    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
      const cb = typeof opts === 'function' ? opts : callback;
      calls.push({ cmd, args });
      cb(null, '', '');
      return {} as any;
    });

    await cloneRepo('https://github.com/owner/repo', BRANCH, DEST);

    // rm -rf <destDir>/.git
    const rmCall = calls.find(c => c.cmd === 'rm' && c.args.includes('-rf'));
    expect(rmCall).toBeDefined();
    expect(rmCall!.args.some((a: string) => a.endsWith('.git'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Sparse-checkout (subpath option)
// ─────────────────────────────────────────────────────────────────────────────

describe('sparse-checkout / subpath option', () => {
  it('calls git sparse-checkout init and git sparse-checkout set with the subpath', async () => {
    ssmReturns('ghp_token');

    const calls: { cmd: string; args: string[] }[] = [];
    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, callback: any) => {
      const cb = typeof opts === 'function' ? opts : callback;
      calls.push({ cmd, args });
      cb(null, '', '');
      return {} as any;
    });

    await cloneRepo('https://github.com/owner/repo', BRANCH, DEST, { subpath: 'packages/api' });

    const gitArgs = calls.filter(c => c.cmd === 'git').map(c => c.args);

    const sparseInit = gitArgs.find(a => a.includes('sparse-checkout') && a.includes('init'));
    expect(sparseInit).toBeDefined();

    const sparseSet = gitArgs.find(a => a.includes('sparse-checkout') && a.includes('set'));
    expect(sparseSet).toBeDefined();
    expect(sparseSet).toContain('packages/api');
  });

  it('throws "Invalid" for a subpath containing traversal sequences (../../etc/passwd)', async () => {
    await expect(
      cloneRepo('https://github.com/owner/repo', BRANCH, DEST, { subpath: '../../etc/passwd' }),
    ).rejects.toThrow(/Invalid/i);
  });

  it('throws for an absolute subpath (/etc/passwd)', async () => {
    await expect(
      cloneRepo('https://github.com/owner/repo', BRANCH, DEST, { subpath: '/etc/passwd' }),
    ).rejects.toThrow(/Invalid/i);
  });
});
