#!/usr/bin/env node
/**
 * Apply pending migrations from packages/db/migrations.
 *
 * Migrations are the single source of truth for schema — the docker-entrypoint-initdb.d
 * hook was removed because it only ever fires once, on an empty volume, which makes
 * every subsequent schema change invisible to an existing database.
 *
 *   node scripts/migrate.mjs                  # migrate POSTGRES_DB
 *   node scripts/migrate.mjs --database=setu_test --create
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, createDb } from 'postgres-migrations';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(ROOT, 'packages', 'db', 'migrations');

/** Minimal .env reader — avoids a dotenv dependency for a script that runs twice a day. */
function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env — rely on the ambient environment.
  }
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

loadEnv();

const config = {
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'setu',
  password: process.env.POSTGRES_PASSWORD ?? 'setu_dev_password',
  database: arg('database') ?? process.env.POSTGRES_DB ?? 'setu',
};

// Passwords for the runtime roles live in the environment, never in a migration file.
const RUNTIME_PASSWORD = process.env.POSTGRES_RUNTIME_PASSWORD ?? 'setu_runtime_password';
const CONTROL_PASSWORD = process.env.POSTGRES_CONTROL_PASSWORD ?? 'setu_control_password';

async function main() {
  if (process.argv.includes('--create')) {
    await createDb(config.database, { ...config, defaultDatabase: 'postgres' });
    console.log(`[migrate] ensured database ${config.database}`);
  }

  const client = new pg.Client(config);
  await client.connect();

  try {
    const applied = await migrate({ client }, MIGRATIONS_DIR);
    if (applied.length === 0) {
      console.log('[migrate] nothing to apply');
    } else {
      for (const m of applied) console.log(`[migrate] applied ${m.id} ${m.name}`);
    }

    // Roles are created without a password by 002; set it here so credentials
    // are never committed to a migration file.
    await client.query(`ALTER ROLE setu_runtime WITH PASSWORD $1`.replace('$1', quote(RUNTIME_PASSWORD)));
    await client.query(`ALTER ROLE setu_control WITH PASSWORD $1`.replace('$1', quote(CONTROL_PASSWORD)));
    console.log('[migrate] runtime role passwords set');
  } finally {
    await client.end();
  }
}

/** ALTER ROLE ... PASSWORD does not accept a bind parameter, so the literal is escaped by hand. */
function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
