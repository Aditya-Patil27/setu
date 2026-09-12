import type pg from 'pg';
import { withContext, type DbContext } from '@setu/db';

/**
 * Audit writes for the Data service.
 *
 * `appendAudit` takes an open client because a permitted access and its audit
 * entry commit together or not at all, so the chain cannot claim an access whose
 * response never shipped. `recordDenial` is the deliberate exception — see it.
 */

/**
 * Memoised purpose name to id, per project.
 *
 * This lookup ran on every audited operation and cost a full round trip — ~0.9ms
 * against a local container, on an ~11.8ms read. What it resolves is immutable:
 * a purpose's id is assigned at creation and its (project_id, name) pair is
 * unique, so a name that resolved once resolves to the same id forever.
 *
 * Only successful resolutions are remembered. A miss means a purpose that does
 * not exist yet, and caching that would keep a newly registered purpose broken;
 * it also throws, so there is no id to remember either way.
 *
 * Deletion is the one case this would get wrong, and it is not reachable: the
 * purposes table has no delete path in the service, and a purpose with consent
 * artifacts referencing it could not be removed without taking those with it.
 */
const purposeIds = new Map<string, string>();

/** Exposed for tests, which provision and drop projects within one process. */
export function clearPurposeCache(): void {
  purposeIds.clear();
}

export async function purposeId(
  exec: pg.Pool | pg.PoolClient,
  projectId: string,
  purpose: string,
): Promise<string> {
  const key = `${projectId}:${purpose}`;
  const cached = purposeIds.get(key);
  if (cached) return cached;

  const res = await exec.query<{ id: string }>(
    `SELECT id FROM purposes WHERE project_id = $1 AND name = $2`,
    [projectId, purpose],
  );
  if (!res.rowCount) {
    // The gateway validates purposes before signing context, so reaching here
    // means a direct call forged a purpose. Fail closed rather than auditing.
    throw new Error(`unknown purpose '${purpose}' for project ${projectId}`);
  }

  purposeIds.set(key, res.rows[0].id);
  return res.rows[0].id;
}

export interface AccessRecord {
  projectId: string;
  /** The data subject the accessed row is about — the subject of the audit row. */
  principalId: string;
  purposeId: string;
  action: 'read' | 'list' | 'create' | 'update' | 'delete';
  resource: string;
  fields: string[];
}

/** Append one hash-chained entry. Must run inside the caller's transaction. */
export async function appendAudit(client: pg.PoolClient, rec: AccessRecord): Promise<void> {
  await client.query(`SELECT public.setu_append_audit($1, $2, $3, $4, $5, $6::text[], $7)`, [
    rec.projectId,
    rec.principalId,
    rec.purposeId,
    rec.action,
    rec.resource,
    rec.fields,
    'permitted',
  ]);
}

export interface DenialRecord {
  projectId: string;
  schemaName: string;
  tableName: string;
  recordId: string | null;
  purposeId: string;
  action: AccessRecord['action'];
  fields: string[];
}

/**
 * Record a denial with full detail while answering the caller opaquely.
 *
 * `setu_audit_denial` is SECURITY DEFINER: it looks behind RLS to learn whether
 * the row even exists and who its subject is — exactly what this service must
 * NOT learn, since "absent" vs "forbidden" is itself a leak.
 *
 * `recordId` is null for list denials; the function attributes the attempt to
 * the acting principal from app.principal_id when it cannot find a row owner,
 * which is why this runs through `withContext` rather than a bare connection.
 *
 * Unlike `appendAudit`, this deliberately runs in a transaction of its own.
 *
 * Every denial ends with the caller's transaction being rolled back — that is
 * what a denial *is* — so an entry written inside it would be rolled back too,
 * and the trail would record permitted access and nothing else. The independence
 * is the whole point: a denial has no access to commit alongside.
 *
 * Safe against the advisory lock `setu_append_audit` takes per project, because
 * every caller reaches here before appending any audit row of its own, so the
 * outer transaction never holds the lock this one waits for.
 */
export async function recordDenial(
  pool: pg.Pool,
  ctx: DbContext,
  rec: DenialRecord,
): Promise<void> {
  const uuidNil = '00000000-0000-0000-0000-000000000000';
  await withContext(pool, ctx, async (client) => {
    await client.query(
      `SELECT public.setu_audit_denial($1, $2, $3, $4::uuid, $5, $6, $7::text[])`,
      [
        rec.projectId,
        rec.schemaName,
        rec.tableName,
        rec.recordId ?? uuidNil,
        rec.purposeId,
        rec.action,
        rec.fields,
      ],
    );
  });
}
