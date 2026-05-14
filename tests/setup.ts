/**
 * tests/setup.ts
 *
 * Jest globalSetup — runs once before all test suites in the process.
 * Generates binary fixtures (zip files, tarballs) if they don't already exist.
 *
 * Referenced in jest.config.ts / jest.config.js:
 *   module.exports = { globalSetup: './tests/setup.ts' }
 *
 * The actual generation logic lives in tests/fixtures/generate.ts so it can
 * also be invoked directly via:
 *   npx ts-node tests/fixtures/generate.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Paths of all expected fixture files */
const EXPECTED_FIXTURES: string[] = [
  'valid-skills.zip',
  'invalid-manifest.zip',
  'path-traversal.zip',
  'large-skills.zip',
  'source-package.tar.gz',
  'source-package-with-scope.tar.gz',
];

function allFixturesExist(): boolean {
  return EXPECTED_FIXTURES.every(name => {
    const fullPath = path.join(FIXTURES_DIR, name);
    return fs.existsSync(fullPath) && fs.statSync(fullPath).size > 0;
  });
}

async function generateFixtures(): Promise<void> {
  // Dynamically require to avoid loading adm-zip / tar at startup when not needed
  const generateModule = await import('./fixtures/generate');

  // generate.ts exports nothing — it runs as a side-effectful main script.
  // We re-invoke it by requiring the module, which triggers the main() call.
  // If generate.ts has already been loaded (cached), the module won't re-run.
  // To handle this edge case we call the module's default export if one exists,
  // otherwise we fall back to spawning a child process.

  if (typeof generateModule.default === 'function') {
    await generateModule.default();
  } else {
    // Fallback: spawn ts-node as a child process
    const { execSync } = await import('child_process');
    const generateScript = path.join(FIXTURES_DIR, 'generate.ts');
    execSync(`npx ts-node "${generateScript}"`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
    });
  }
}

/**
 * Jest globalSetup entry point.
 * Jest calls this function once before running any tests.
 */
export default async function setup(): Promise<void> {
  if (allFixturesExist()) {
    console.log('[setup] All fixtures present — skipping generation.');
    return;
  }

  const missing = EXPECTED_FIXTURES.filter(name => {
    const fullPath = path.join(FIXTURES_DIR, name);
    return !fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0;
  });

  console.log(`[setup] Missing fixtures: ${missing.join(', ')}`);
  console.log('[setup] Generating fixtures...');

  try {
    await generateFixtures();
    console.log('[setup] Fixture generation complete.');
  } catch (err) {
    console.error('[setup] Fixture generation failed:', err);
    throw err;
  }

  // Verify all fixtures were created
  const stillMissing = EXPECTED_FIXTURES.filter(name => {
    const fullPath = path.join(FIXTURES_DIR, name);
    return !fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0;
  });

  if (stillMissing.length > 0) {
    throw new Error(
      `[setup] Fixture generation completed but the following files are missing or empty: ${stillMissing.join(', ')}`,
    );
  }
}
