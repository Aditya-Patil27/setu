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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * Three purposes, chosen so that none is a superset of another.
 *
 * That is the whole point. A delivery partner sees where the order is going but
 * not what it cost; analytics sees what it cost but has no idea whose order it
 * was. Neither is "more privileged" — so this cannot be expressed as a role
 * without inventing one role per combination, which is exactly the difference
 * between gating on who is asking and gating on why.
 */
export const PURPOSES = [
  ['delivery_partner', 'Delivering this order to the data subject', 'contract'],
  ['support_chat', 'Answering a support request from the data subject', 'consent'],
  ['analytics', 'Aggregate product analytics', 'legitimate_use'],
];

/**
 * Three customers whose consent differs, because one principal proves nothing.
 *
 * Each demonstrates a different gate:
 *
 *   Asha  — consents to everything. The baseline the others are read against.
 *   Biju  — never consented to analytics, so the RLS policy hides his row from
 *           that purpose entirely. Row visibility, not field masking.
 *   Priya — consents to analytics but withholds her phone from support, even
 *           though the tenant grants that field to support. Proves the two gates
 *           are independent: the tenant's grant alone is not enough.
 */
export const PRINCIPALS = [
  {
    displayName: 'Asha Menon',
    phone: '+919812345678',
    consents: {
      delivery_partner: ['customer_name', 'phone', 'address', 'city'],
      support_chat: ['customer_name', 'phone', 'city', 'item', 'amount'],
      analytics: ['city', 'item', 'amount'],
    },
  },
  {
    displayName: 'Biju Thomas',
    phone: '+919812340000',
    consents: {
      delivery_partner: ['customer_name', 'phone', 'address', 'city'],
      support_chat: ['customer_name', 'phone', 'city', 'item', 'amount'],
    },
  },
  {
    displayName: 'Priya Nair',
    phone: '+919812341111',
    consents: {
      delivery_partner: ['customer_name', 'phone', 'address', 'city'],
      // No 'phone'. The tenant grants it to support_chat; she does not.
      support_chat: ['customer_name', 'city', 'item', 'amount'],
      analytics: ['city', 'item', 'amount'],
    },
  },
];

/**
 * The collection the demo declares. Printed, not created: the DDL generator in
 * the Data service is the only thing permitted to emit collection DDL, and
 * duplicating it here would give the metadata a second, divergent source.
 *
 * `partial` on phone is what a delivery app actually shows you — '****1234'.
 * The difference is that theirs is application code a bug can step around, and
 * this is a generated view the database evaluates.
 *
 * amount is numeric, and a non-text column can only mask to null; the DDL
 * generator rejects the other strategies at declaration time rather than
 * producing a view that fails at read time.
 */
export const COLLECTION_FIELDS = [
  {
    name: 'customer_name',
    type: 'text',
    sensitivity: 'personal',
    mask: 'redact',
    purposes: ['delivery_partner', 'support_chat'],
  },
  {
    name: 'phone',
    type: 'text',
    sensitivity: 'personal',
    mask: 'partial',
    // Support only. A delivery partner gets '****5678', which is what a real
    // delivery app shows — and note the mask is a property of the field, not of
    // the purpose, so every purpose that may not read it sees the same last
    // four digits. If that is too much disclosure the field wants 'redact' or
    // 'hash'; the tenant decides, and the database enforces whatever they chose.
    purposes: ['support_chat'],
  },
  {
    name: 'address',
    type: 'text',
    sensitivity: 'sensitive',
    mask: 'redact',
    purposes: ['delivery_partner'],
  },
  {
    name: 'city',
    type: 'text',
    sensitivity: 'public',
    mask: 'null',
    purposes: ['delivery_partner', 'support_chat', 'analytics'],
  },
  {
    name: 'item',
    type: 'text',
    sensitivity: 'public',
    mask: 'null',
    purposes: ['support_chat', 'analytics'],
  },
  {
    name: 'amount',
    type: 'numeric',
    sensitivity: 'public',
    mask: 'null',
    purposes: ['support_chat', 'analytics'],
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
    const principalIds = await seedPrincipals(client, project, purposeIds);
    const key = await issueKey(client, project);

    await client.query('COMMIT');
    report(project, key, principalIds);
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
  const ids = {};

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

    ids[spec.displayName] = principalId;
  }

  return ids;
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

function report(projectId, key, principalIds) {
  const lines = [
    '',
    `[seed] project ${projectId} (slug: ${SLUG}, schema: ${SCHEMA})`,
    `[seed] purposes: ${PURPOSES.map(([n]) => n).join(', ')}`,
    ...PRINCIPALS.map((p) => `[seed] ${p.displayName.padEnd(12)} ${principalIds[p.displayName]}`),
    '',
    '[seed] API key — shown once, not recoverable:',
    '',
    `    ${key.plaintext}`,
    '',
    `    export SETU_KEY=${key.plaintext}`,
    `    export SETU=${GATEWAY}`,
    '',
    '[seed] 1. Declare the collection. The `purposes` on each field are the',
    '[seed]    tenant half of the gate; the consent seeded above is the other.',
    '',
    '    curl -sS $SETU/v1/collections \\',
    '      -H "authorization: Bearer $SETU_KEY" -H "content-type: application/json" \\',
    `      -d '{"name":"orders","fields":[`,
    ...COLLECTION_FIELDS.map(
      (f, i) => `        ${JSON.stringify(f)}${i < COLLECTION_FIELDS.length - 1 ? ',' : ''}`,
    ),
    `      ]}'`,
    '',
    '[seed] 2. Create an order. Any purpose that may write will do.',
    '',
    '    curl -sS $SETU/v1/collections/orders/records \\',
    '      -H "authorization: Bearer $SETU_KEY" -H "content-type: application/json" \\',
    '      -H "x-setu-purpose: support_chat" \\',
    `      -d '${JSON.stringify({
      principalId: principalIds['Asha Menon'],
      customer_name: 'Asha Menon',
      phone: '+919812345678',
      address: '12 MG Road, Pune',
      city: 'Pune',
      item: 'Masala Dosa',
      amount: '240.00',
    })}'`,
    '',
    '[seed] 3. Read the same order back under each purpose, changing only the',
    '[seed]    x-setu-purpose header. Nothing else about the request differs.',
    '',
    '    for p in delivery_partner support_chat analytics; do',
    '      echo "--- $p"',
    '      curl -sS "$SETU/v1/collections/orders/records" \\',
    '        -H "authorization: Bearer $SETU_KEY" -H "x-setu-purpose: $p"',
    '    done',
    '',
    '[seed]    delivery_partner  address and name in full, phone as ****5678,',
    '[seed]                        never the amount',
    '[seed]    support_chat      name, phone and amount in full, never the address',
    '[seed]    analytics         city, item and amount only — no name, no address',
    '',
    '[seed]    Both gates bite, independently:',
    '[seed]      - Biju never consented to analytics, so that purpose does not',
    '[seed]        see his row at all. Row visibility, not field masking.',
    '[seed]      - Priya withheld her phone from support, so hers reads',
    "[seed]        '****1111' there while Asha's reads in full. The tenant",
    '[seed]        granted that field; her consent is what withholds it.',
    '[seed]      - Every customer consented to phone for delivery_partner, but',
    '[seed]        the tenant never granted it to that purpose — so it is masked',
    '[seed]        there regardless. The mirror image of the line above.',
    '',
    '[seed] 4. The bypass attempt. Connect as the runtime role the services use',
    '[seed]    and try to read the table directly — RLS refuses, because the',
    '[seed]    guarantee is in the database, not in the service.',
    '',
    `    psql "postgresql://setu_runtime@localhost/${process.env.POSTGRES_DB ?? 'setu'}" \\`,
    `      -c 'SELECT * FROM "${SCHEMA}".orders'`,
    '',
    '[seed] 5. Consent-bound inference. Build vectors per purpose, then ask the',
    '[seed]    same question under two of them.',
    '',
    '    curl -sS $SETU/v1/ai/embeddings -H "authorization: Bearer $SETU_KEY" \\',
    '      -H "content-type: application/json" -H "x-setu-purpose: delivery_partner" \\',
    `      -d '{"collection":"orders"}'`,
    '',
    '    curl -sS $SETU/v1/ai/ask -H "authorization: Bearer $SETU_KEY" \\',
    '      -H "content-type: application/json" -H "x-setu-purpose: delivery_partner" \\',
    `      -d '{"collection":"orders","question":"where is the Pune order going?"}'`,
    '',
    '[seed]    The response carries the context the model was given. Ask the same',
    '[seed]    under analytics and the address is not in it — so no answer can',
    '[seed]    contain it, whatever the model does.',
    '',
    '[seed] 6. Revoke, then look again. The row leaves retrieval immediately,',
    '[seed]    and the derived vectors are deleted rather than hidden:',
    '',
    '    curl -sS -X POST $SETU/v1/consents/<consent-id>/revoke \\',
    '      -H "authorization: Bearer $SETU_KEY"',
    '',
    `    psql "postgresql://setu@localhost/${process.env.POSTGRES_DB ?? 'setu'}" \\`,
    "      -c 'SELECT count(*) FROM record_embeddings'",
    '',
  ];
  console.log(lines.join('\n'));
}

/**
 * Only seed when run directly. The constants above are imported by the suite
 * that checks the claims this script prints are actually true, and importing a
 * module must not write to a database.
 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('[seed] failed:', err.message);
    process.exit(1);
  });
}
