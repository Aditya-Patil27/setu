#!/usr/bin/env node
/**
 * Seed a demo tenant, project, purposes, principals and API key.
 *
 * Everything here is control-plane state: rows the platform owns. Collections
 * are deliberately not seeded — the DDL generator in the Data service is the
 * only thing permitted to emit collection DDL, and duplicating it here would
 * give the metadata a second, divergent source of truth. The script prints the
 * requests that declare one instead.
 *
 *   node scripts/seed.mjs
 *   node scripts/seed.mjs --database=setu_dev
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hash as argonHash } from '@node-rs/argon2';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader — matches scripts/migrate.mjs rather than adding dotenv. */
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

const SLUG = 'demo';
const SCHEMA = 's_demo';
const GATEWAY = `http://localhost:${process.env.GATEWAY_PORT ?? 3000}`;

/** The purposes the demo reads under. Field grants are declared with the collection. */
const PURPOSES = [
  ['support_chat', 'Answering a support request from the data subject', 'consent'],
  ['analytics', 'Aggregate product analytics', 'consent'],
];

/**
 * Two principals whose consent differs, because one principal proves nothing.
 * Biju withholds his name from support, so the same purpose sees the two rows
 * differently — which is the behaviour worth demonstrating.
 */
const PRINCIPALS = [
  {
    displayName: 'Asha Menon',
    phone: '+919812345678',
    consents: {
      support_chat: ['full_name', 'phone', 'city'],
      analytics: ['full_name', 'phone', 'city'],
    },
  },
  {
    displayName: 'Biju Thomas',
    phone: '+919812340000',
    consents: { support_chat: ['phone', 'city'] },
  },
];

/**
 * `setu_<prefix>_<secret>`: the prefix is the searchable handle, the secret is
 * verified against an argon2id digest. Shapes must match the gateway's parser.
 */
function generateKey() {
  const prefix = randomBytes(8).toString('hex').slice(0, 8);
  const secret = randomBytes(24).toString('base64url');
  return { prefix, secret, plaintext: `setu_${prefix}_${secret}` };
}

async function main() {
  const client = new pg.Client(config);
  await client.connect();

  try {
    await client.query('BEGIN');

    const tenant = await upsertTenant(client);
    const project = await upsertProject(client, tenant);

    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await client.query(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO setu_runtime, setu_control`);

    const purposeIds = await seedPurposes(client, project);
    await seedPrincipals(client, project, purposeIds);
    const key = await issueKey(client, project);

    await client.query('COMMIT');
    report(project, key);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

async function upsertTenant(client) {
  const res = await client.query(
    `INSERT INTO tenants (name, slug) VALUES ('Demo Tenant', $1)
     ON CONFLICT (slug) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [SLUG],
  );
  return res.rows[0].id;
}

async function upsertProject(client, tenantId) {
  const res = await client.query(
    `INSERT INTO projects (tenant_id, name, slug, schema_name)
     VALUES ($1, 'Demo Project', $2, $3)
     ON CONFLICT (tenant_id, slug) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [tenantId, SLUG, SCHEMA],
  );
  return res.rows[0].id;
}

async function seedPurposes(client, projectId) {
  const ids = {};
  for (const [name, description, legalBasis] of PURPOSES) {
    const res = await client.query(
      `INSERT INTO purposes (project_id, name, description, legal_basis)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description
       RETURNING id`,
      [projectId, name, description, legalBasis],
    );
    ids[name] = res.rows[0].id;
  }
  return ids;
}

async function seedPrincipals(client, projectId, purposeIds) {
  for (const spec of PRINCIPALS) {
    const existing = await client.query(
      `SELECT id FROM principals WHERE project_id = $1 AND phone = $2`,
      [projectId, spec.phone],
    );

    const principalId = existing.rowCount
      ? existing.rows[0].id
      : (
          await client.query(
            `INSERT INTO principals (project_id, phone, display_name)
             VALUES ($1, $2, $3) RETURNING id`,
            [projectId, spec.phone, spec.displayName],
          )
        ).rows[0].id;

    for (const [purpose, fields] of Object.entries(spec.consents)) {
      // Re-seeding must not stack a second active artifact for one pair: the
      // RLS policy would honour whichever matched first, making "what did they
      // agree to" ambiguous.
      await client.query(
        `UPDATE consent_artifacts SET status = 'revoked', revoked_at = now()
          WHERE principal_id = $1 AND purpose_id = $2 AND status = 'active'`,
        [principalId, purposeIds[purpose]],
      );
      await client.query(
        `INSERT INTO consent_artifacts (principal_id, purpose_id, fields, status)
         VALUES ($1, $2, $3, 'active')`,
        [principalId, purposeIds[purpose], fields],
      );
    }
  }
}

async function issueKey(client, projectId) {
  const key = generateKey();
  // An argon2id digest is salted and therefore not searchable, so a re-run
  // cannot recover the old plaintext — it issues a new key and retires the old.
  await client.query(`DELETE FROM api_keys WHERE project_id = $1 AND name = 'demo key'`, [
    projectId,
  ]);
  await client.query(
    `INSERT INTO api_keys (project_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'demo key')`,
    [projectId, await argonHash(key.secret), key.prefix],
  );
  return key;
}

function report(projectId, key) {
  const lines = [
    '',
    `[seed] project ${projectId} (slug: ${SLUG}, schema: ${SCHEMA})`,
    `[seed] purposes: ${PURPOSES.map(([n]) => n).join(', ')}`,
    `[seed] principals: ${PRINCIPALS.map((p) => p.displayName).join(', ')}`,
    '',
    '[seed] API key — shown once, not recoverable:',
    '',
    `    ${key.plaintext}`,
    '',
    '[seed] Declare a collection, then read one row under two purposes:',
    '',
    `    export SETU_KEY=${key.plaintext}`,
    '',
    `    curl -sS ${GATEWAY}/v1/collections \\`,
    '      -H "authorization: Bearer $SETU_KEY" -H "content-type: application/json" \\',
    `      -d '{"name":"patients","fields":[`,
    `        {"name":"full_name","type":"text","mask":"redact","purposes":["support_chat"]},`,
    `        {"name":"phone","type":"text","mask":"partial","purposes":["support_chat"]},`,
    `        {"name":"city","type":"text","mask":"null","purposes":["support_chat","analytics"]}]}'`,
    '',
    '    # then POST a record with x-setu-purpose: support_chat, and GET it back',
    '    # under each purpose — full_name is readable for one and "***" for the other.',
    '',
  ];
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
