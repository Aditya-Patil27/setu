import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadEnv, REPO_ROOT, TEST_DATABASE } from './helpers/env.js';

/**
 * Create and migrate the test database once, before any suite runs.
 *
 * Reuses scripts/migrate.mjs rather than duplicating migration logic, so the
 * tests exercise the same path a developer or deployment does.
 */
export default function setup(): void {
  loadEnv();

  execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts', 'migrate.mjs'), `--database=${TEST_DATABASE}`, '--create'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
}
