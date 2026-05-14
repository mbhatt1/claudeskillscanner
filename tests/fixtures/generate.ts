/**
 * tests/fixtures/generate.ts
 *
 * Generates all binary test fixtures used by the Jest test suite.
 * Run with: npx ts-node tests/fixtures/generate.ts
 *
 * Produces:
 *   tests/fixtures/valid-skills.zip
 *   tests/fixtures/invalid-manifest.zip
 *   tests/fixtures/path-traversal.zip
 *   tests/fixtures/large-skills.zip
 *   tests/fixtures/source-package.tar.gz
 *   tests/fixtures/source-package-with-scope.tar.gz
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import tar from 'tar';

const FIXTURES_DIR = path.join(__dirname);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 1. valid-skills.zip
//    A well-formed zip: manifest.json + two skill markdown files.
// ---------------------------------------------------------------------------
function generateValidSkillsZip(): void {
  const zip = new AdmZip();

  const manifest = {
    jobName: 'Test Skills Job',
    description: 'A fixture skill package with two skills for testing',
    version: '1.0.0',
    author: 'test-author',
    visibility: 'private',
    skills: ['skill-one', 'skill-two'],
    defaultPrompt: 'Analyze the provided code and return structured output.',
    tags: { category: 'testing', type: 'fixture' },
  };

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  zip.addFile(
    'skills/skill-one.md',
    Buffer.from(
      '# Skill One\n\nYou are an expert analyst.\n\n## Task\n\nAnalyze the input and return findings.\n',
      'utf8',
    ),
  );

  zip.addFile(
    'skills/skill-two.md',
    Buffer.from(
      '# Skill Two\n\nYou are a code quality reviewer.\n\n## Task\n\nReview code for quality issues.\n',
      'utf8',
    ),
  );

  const outPath = path.join(FIXTURES_DIR, 'valid-skills.zip');
  zip.writeZip(outPath);
  console.log(`✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// 2. invalid-manifest.zip
//    A zip whose manifest.json is missing required fields (no jobName, no skills).
// ---------------------------------------------------------------------------
function generateInvalidManifestZip(): void {
  const zip = new AdmZip();

  const badManifest = {
    // Missing: jobName, skills, defaultPrompt
    description: 'Intentionally broken manifest for negative-path tests',
    version: 'not-semver',
  };

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(badManifest, null, 2), 'utf8'));
  zip.addFile('skills/orphan.md', Buffer.from('# Orphan skill — manifest does not reference this', 'utf8'));

  const outPath = path.join(FIXTURES_DIR, 'invalid-manifest.zip');
  zip.writeZip(outPath);
  console.log(`✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// 3. path-traversal.zip
//    A zip containing an entry named ../../etc/passwd for security tests.
//    adm-zip allows arbitrary entry names so we can craft this directly.
// ---------------------------------------------------------------------------
function generatePathTraversalZip(): void {
  const zip = new AdmZip();

  // Legitimate entry so the zip isn't completely empty
  zip.addFile('manifest.json', Buffer.from('{"jobName":"legit","skills":["x"]}', 'utf8'));

  // Malicious entry — path traversal outside extraction root
  zip.addFile('../../etc/passwd', Buffer.from('root:x:0:0:root:/root:/bin/bash\n', 'utf8'));

  // Another variant that targets Windows-style traversal
  zip.addFile('..\\..\\Windows\\System32\\evil.dll', Buffer.from('MZ', 'utf8'));

  const outPath = path.join(FIXTURES_DIR, 'path-traversal.zip');
  zip.writeZip(outPath);
  console.log(`✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// 4. large-skills.zip
//    A zip containing a single skills/big.md that is exactly 5 MiB.
// ---------------------------------------------------------------------------
function generateLargeSkillsZip(): void {
  const zip = new AdmZip();

  const manifest = {
    jobName: 'Large Skills Job',
    skills: ['big'],
    defaultPrompt: 'Process the large skill file.',
  };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

  // 5 MiB = 5 * 1024 * 1024 bytes, filled with repeated ASCII so it's valid text
  const TARGET_BYTES = 5 * 1024 * 1024;
  const line = '# Large Skill File\n\nThis line is repeated to reach the 5 MiB size limit threshold.\n';
  const repeats = Math.ceil(TARGET_BYTES / line.length);
  const rawContent = line.repeat(repeats).slice(0, TARGET_BYTES);
  zip.addFile('skills/big.md', Buffer.from(rawContent, 'utf8'));

  const outPath = path.join(FIXTURES_DIR, 'large-skills.zip');
  zip.writeZip(outPath);
  console.log(`✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// 5. source-package.tar.gz
//    Small Node.js package with an intentional SQL injection in src/index.ts,
//    plus package.json and README.md — used for code review tests.
// ---------------------------------------------------------------------------
async function generateSourcePackageTarball(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-pkg-'));
  const pkgDir = path.join(tmpDir, 'source-package');
  ensureDir(path.join(pkgDir, 'src'));

  // src/index.ts — intentional SQL injection (CWE-89) for review tests
  fs.writeFileSync(
    path.join(pkgDir, 'src', 'index.ts'),
    `import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Fetch user by username.
 * SECURITY BUG: username is concatenated directly into the SQL query
 * without parameterization, enabling SQL injection (CWE-89).
 */
export async function getUserByUsername(username: string): Promise<any> {
  // Intentional SQL injection — do not ship to production
  const result = await pool.query(
    \`SELECT * FROM users WHERE username = '\${username}'\`,  // CWE-89
  );
  return result.rows[0];
}

/**
 * Log a user action.
 * SECURITY BUG: action is passed to eval() enabling code injection (CWE-95).
 */
export function logAction(action: string): void {
  // Intentional code injection — do not ship to production
  eval(\`console.log('Action: ' + \${action})\`);  // CWE-95
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
`,
    'utf8',
  );

  // package.json
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: 'source-package',
        version: '1.0.0',
        description: 'Fixture package for code review tests',
        main: 'dist/index.js',
        scripts: { build: 'tsc', test: 'jest' },
        dependencies: { pg: '^8.11.0' },
        devDependencies: { '@types/pg': '^8.10.0', typescript: '^5.0.0' },
      },
      null,
      2,
    ),
    'utf8',
  );

  // README.md
  fs.writeFileSync(
    path.join(pkgDir, 'README.md'),
    `# source-package

Fixture Node.js package for testing the automated security code review skill.

Contains intentional security vulnerabilities (SQL injection in \`src/index.ts\`)
for use in positive test assertions against the code review pipeline.
`,
    'utf8',
  );

  const outPath = path.join(FIXTURES_DIR, 'source-package.tar.gz');
  await tar.create(
    {
      gzip: true,
      file: outPath,
      cwd: tmpDir,
    },
    ['source-package'],
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// 6. source-package-with-scope.tar.gz
//    Same package as above plus a .review-scope.json that restricts review
//    to only src/index.ts — used for scoped review tests.
// ---------------------------------------------------------------------------
async function generateSourcePackageWithScopeTarball(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-pkg-scope-'));
  const pkgDir = path.join(tmpDir, 'source-package-with-scope');
  ensureDir(path.join(pkgDir, 'src'));

  // src/index.ts — same intentional SQL injection
  fs.writeFileSync(
    path.join(pkgDir, 'src', 'index.ts'),
    `import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * SECURITY BUG: SQL injection (CWE-89).
 */
export async function getUserByUsername(username: string): Promise<any> {
  const result = await pool.query(
    \`SELECT * FROM users WHERE username = '\${username}'\`,  // CWE-89
  );
  return result.rows[0];
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
`,
    'utf8',
  );

  // package.json
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: 'source-package-with-scope',
        version: '1.0.0',
        description: 'Fixture package with review scope restriction',
        main: 'dist/index.js',
        dependencies: { pg: '^8.11.0' },
      },
      null,
      2,
    ),
    'utf8',
  );

  // README.md (should NOT be in scope per .review-scope.json)
  fs.writeFileSync(
    path.join(pkgDir, 'README.md'),
    `# source-package-with-scope

This package has a .review-scope.json restricting review to only src/index.ts.
The README should be excluded from review.
`,
    'utf8',
  );

  // .review-scope.json — restricts code review to only src/index.ts
  fs.writeFileSync(
    path.join(pkgDir, '.review-scope.json'),
    JSON.stringify(
      {
        include: ['src/index.ts'],
        exclude: [],
        description: 'Only review the main source file, not tests or documentation',
      },
      null,
      2,
    ),
    'utf8',
  );

  const outPath = path.join(FIXTURES_DIR, 'source-package-with-scope.tar.gz');
  await tar.create(
    {
      gzip: true,
      file: outPath,
      cwd: tmpDir,
    },
    ['source-package-with-scope'],
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`✓ ${outPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function generateAllFixtures(): Promise<void> {
  ensureDir(FIXTURES_DIR);

  console.log('Generating test fixtures...\n');

  generateValidSkillsZip();
  generateInvalidManifestZip();
  generatePathTraversalZip();
  generateLargeSkillsZip();
  await generateSourcePackageTarball();
  await generateSourcePackageWithScopeTarball();

  console.log('\nAll fixtures generated successfully.');
}

// Allow direct execution: npx ts-node tests/fixtures/generate.ts
if (require.main === module) {
  generateAllFixtures().catch(err => {
    console.error('Fixture generation failed:', err);
    process.exit(1);
  });
}

export default generateAllFixtures;
