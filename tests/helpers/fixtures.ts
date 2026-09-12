import type pg from 'pg';
import { createRolePool, type DbRole } from '@setu/db';
import { loadEnv, TEST_DATABASE } from './env.js';

loadEnv();

const pools = new Map<DbRole, pg.Pool>();

/**
 * A pool against the test database.
 *
 * `runtime` is the role assertions should use — it cannot bypass RLS, so a query
 * through it reflects what a real service would see. `owner` is for provisioning
 * only; it ignores RLS entirely and will happily show you rows the platform is
 * supposed to be hiding.
 */
export function testPool(role: DbRole): pg.Pool {
  let pool = pools.get(role);
  if (!pool) {
    pool = createRolePool(role, { database: TEST_DATABASE, max: 4 });
    pools.set(role, pool);
  }
  return pool;
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

export interface TestProject {
  tenantId: string;
  projectId: string;
  schemaName: string;
  slug: string;
}

let counter = 0;

/**
 * Provision an isolated tenant + project + Postgres schema.
 *
 * The slug embeds the process id so parallel vitest forks cannot collide.
 */
export async function provisionProject(hint = 'proj'): Promise<TestProject> {
  const slug = `${hint}_${process.pid}_${++counter}`;
  const schemaName = `s_${slug}`;
  const owner = testPool('owner');

  const tenant = await owner.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Tenant ${slug}`, slug],
  );
  const tenantId = tenant.rows[0].id;

  const project = await owner.query<{ id: string }>(
    `INSERT INTO projects (tenant_id, name, slug, schema_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, `Project ${slug}`, slug, schemaName],
  );

  await owner.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
  await owner.query(
    `GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO setu_runtime, setu_control`,
  );

  return { tenantId, projectId: project.rows[0].id, schemaName, slug };
}

/** Drop everything the project owns. Safe to call twice. */
/**
 * Tear a project down.
 *
 * Serialised across worker processes, and retried on deadlock, because teardown
 * reaches further than it looks. Every generated collection table carries an FK
 * to public.principals, so deleting one project's tenant cascades to its
 * principals and Postgres must lock every table referencing them — including
 * collection tables belonging to other suites running in other forks. Two
 * teardowns overlapping, or one overlapping another suite's CREATE TABLE, can
 * therefore take the same locks in opposite orders.
 *
 * The advisory lock is transaction-scoped and taken first, so only one teardown
 * runs at a time. The retry covers the remaining case: a teardown racing a
 * collection being declared in another fork, which this cannot serialise because
 * that DDL is issued by the service rather than by these helpers.
 */
const TEARDOWN_LOCK = 918_273_645;
const DEADLOCK = '40P01';

export async function dropProject(project: TestProject, attempt = 0): Promise<void> {
  const owner = testPool('owner');
  const client = await owner.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [TEARDOWN_LOCK]);

    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(project.schemaName)} CASCADE`);
    // Audit and usage rows deliberately do not cascade: a chain that vanished
    // along with its project would not be an audit chain, and usage that vanished
    // would take the billing record with it. Test data still has to go, and the
    // Data service writes audit rows on every read, permitted or denied.
    await client.query(`DELETE FROM audit_edges WHERE project_id = $1`, [project.projectId]);
    await client.query(`DELETE FROM audit_records WHERE project_id = $1`, [project.projectId]);
    await client.query(`DELETE FROM usage_records WHERE tenant_id = $1`, [project.tenantId]);
    // Projects, principals, purposes and consent artifacts all cascade from tenants.
    await client.query(`DELETE FROM tenants WHERE id = $1`, [project.tenantId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);

    const code = (err as { code?: string }).code;
    if (code === DEADLOCK && attempt < 4) {
      client.release();
      // Stagger, so two losers do not immediately collide again.
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      return dropProject(project, attempt + 1);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function createPurpose(
  projectId: string,
  name: string,
  description = `${name} purpose`,
): Promise<string> {
  const res = await testPool('owner').query<{ id: string }>(
    `INSERT INTO purposes (project_id, name, description, legal_basis)
     VALUES ($1, $2, $3, 'consent') RETURNING id`,
    [projectId, name, description],
  );
  return res.rows[0].id;
}

export async function createPrincipal(
  projectId: string,
  attrs: { phone?: string; email?: string; displayName?: string } = {},
): Promise<string> {
  const res = await testPool('owner').query<{ id: string }>(
    `INSERT INTO principals (project_id, phone, email, display_name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [projectId, attrs.phone ?? null, attrs.email ?? null, attrs.displayName ?? null],
  );
  return res.rows[0].id;
}

export interface ConsentOptions {
  /** Omit for a non-expiring grant. A past value produces an expired artifact. */
  expiresAt?: Date | null;
  status?: 'active' | 'expired' | 'revoked';
  revokedAt?: Date | null;
}

/**
 * Grant consent for specific fields.
 *
 * `fields` is the principal's half of the two-gate field check — the tenant's
 * half lives in field_purpose_grants and is set when a collection is declared.
 */
export async function grantConsent(
  principalId: string,
  purposeId: string,
  fields: string[],
  opts: ConsentOptions = {},
): Promise<string> {
  const res = await testPool('owner').query<{ id: string }>(
    `INSERT INTO consent_artifacts (principal_id, purpose_id, fields, expires_at, revoked_at, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      principalId,
      purposeId,
      fields,
      opts.expiresAt ?? null,
      opts.revokedAt ?? null,
      opts.status ?? 'active',
    ],
  );
  return res.rows[0].id;
}

export async function revokeConsent(consentId: string): Promise<void> {
  await testPool('owner').query(
    `UPDATE consent_artifacts SET status = 'revoked', revoked_at = now() WHERE id = $1`,
    [consentId],
  );
}

/**
 * Quote an identifier for interpolation.
 *
 * Only ever used on identifiers this file generated. Anything originating from a
 * request goes through the Data service's validator instead — see its DDL module.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
