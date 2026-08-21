import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The database every integration suite runs against. Never the dev database. */
export const TEST_DATABASE = process.env.POSTGRES_TEST_DB ?? 'setu_test';

let loaded = false;

/**
 * Populate process.env from .env, without a dotenv dependency.
 * Ambient values always win, so CI can override anything.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  try {
    for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env — the createRolePool defaults match docker-compose, so this is fine.
  }
}
