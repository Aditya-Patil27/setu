import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { NotFoundError, contextFromHeaders, parseInput, ValidationError } from '@setu/shared';
import { CONSENT_CHANGED } from '../events.js';

const CreateConsent = z.object({
  principalId: z.string().uuid(),
  /** Purpose name, not id — the same token the caller later sends as x-setu-purpose. */
  purpose: z.string().min(1).max(64),
  fields: z.array(z.string().min(1).max(63)).min(1),
  expiresAt: z.string().datetime().optional(),
});

const ListQuery = z.object({
  principalId: z.string().uuid().optional(),
});

const CheckQuery = z.object({
  principalId: z.string().uuid(),
  purpose: z.string().min(1),
});

export interface ArtifactRow {
  id: string;
  principal_id: string;
  purpose_id: string;
  purpose_name: string;
  fields: string[];
  granted_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  status: string;
}

export const presentArtifact = (row: ArtifactRow) => ({
  id: row.id,
  principalId: row.principal_id,
  purposeId: row.purpose_id,
  purpose: row.purpose_name,
  fields: row.fields,
  grantedAt: row.granted_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  status: row.status,
});

/** Columns every artifact response is built from. */
export const ARTIFACT_COLUMNS = `
  ca.id, ca.principal_id, ca.purpose_id, p.name AS purpose_name,
  ca.fields, ca.granted_at, ca.expires_at, ca.revoked_at, ca.status
`;

/**
 * Resolve a purpose within the caller's project.
 *
 * Platform tables carry no row-level security, so every query here is scoped by
 * project_id explicitly. Getting this wrong would leak another tenant's consent
 * state, which no amount of downstream RLS would catch.
 */
async function requirePurposeId(
  client: pg.Pool,
  projectId: string,
  name: string,
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM purposes WHERE project_id = $1 AND name = $2`,
    [projectId, name],
  );
  if (!res.rowCount) throw new NotFoundError('Purpose', name);
  return res.rows[0].id;
}

async function requirePrincipalInProject(
  client: pg.Pool,
  projectId: string,
  principalId: string,
): Promise<void> {
  const res = await client.query(`SELECT 1 FROM principals WHERE id = $1 AND project_id = $2`, [
    principalId,
    projectId,
  ]);
  if (!res.rowCount) throw new NotFoundError('Principal', principalId);
}

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Grant consent.
   *
   * A new grant supersedes any active artifact for the same (principal, purpose):
   * two simultaneously active artifacts would make "what did they agree to"
   * ambiguous, and the RLS policy would honour whichever matched first.
   */
  app.post('/consents', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(CreateConsent, request.body, 'consent');

    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) {
      throw new ValidationError('expiresAt must be in the future', { expiresAt: body.expiresAt });
    }

    const pool = app.pools.control;
    await requirePrincipalInProject(pool, ctx.projectId, body.principalId);
    const purposeId = await requirePurposeId(pool, ctx.projectId, body.purpose);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE consent_artifacts SET status = 'revoked', revoked_at = now()
          WHERE principal_id = $1 AND purpose_id = $2 AND status = 'active'`,
        [body.principalId, purposeId],
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO consent_artifacts (principal_id, purpose_id, fields, expires_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.principalId, purposeId, body.fields, body.expiresAt ?? null],
      );

      await client.query('COMMIT');

      const res = await pool.query<ArtifactRow>(
        `SELECT ${ARTIFACT_COLUMNS} FROM consent_artifacts ca
           JOIN purposes p ON p.id = ca.purpose_id
          WHERE ca.id = $1`,
        [inserted.rows[0].id],
      );

      await app.events.publish(CONSENT_CHANGED, {
        projectId: ctx.projectId,
        principalId: body.principalId,
        purpose: body.purpose,
        action: 'granted',
      });

      return reply.status(201).send(presentArtifact(res.rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  app.get('/consents', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const query = parseInput(ListQuery, request.query, 'query');

    const res = await app.pools.control.query<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS}
         FROM consent_artifacts ca
         JOIN purposes p    ON p.id = ca.purpose_id
         JOIN principals pr ON pr.id = ca.principal_id
        WHERE pr.project_id = $1
          AND ($2::uuid IS NULL OR ca.principal_id = $2::uuid)
        ORDER BY ca.granted_at DESC`,
      [ctx.projectId, query.principalId ?? null],
    );

    return { consents: res.rows.map(presentArtifact) };
  });

  app.post<{ Params: { id: string } }>('/consents/:id/revoke', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);

    const res = await app.pools.control.query<{ id: string; purpose_name: string }>(
      `UPDATE consent_artifacts ca
          SET status = 'revoked', revoked_at = now()
         FROM principals pr, purposes p
        WHERE ca.id = $1
          AND pr.id = ca.principal_id
          AND p.id  = ca.purpose_id
          AND pr.project_id = $2
          AND ca.status = 'active'
      RETURNING ca.id, p.name AS purpose_name`,
      [request.params.id, ctx.projectId],
    );

    if (!res.rowCount) throw new NotFoundError('Active consent artifact', request.params.id);

    await app.events.publish(CONSENT_CHANGED, {
      projectId: ctx.projectId,
      consentId: res.rows[0].id,
      purpose: res.rows[0].purpose_name,
      action: 'revoked',
    });

    return { id: res.rows[0].id, status: 'revoked' };
  });

  /**
   * Advisory only — for dashboards and debugging.
   *
   * Do NOT put this on a read path. Consent is evaluated inside Postgres by the
   * RLS policy and the masking view; asking a service first would move the
   * decision back into application code, which is the thing this platform exists
   * to avoid. The answer here can also be stale by the time a caller acts on it.
   */
  app.get('/consents/check', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const query = parseInput(CheckQuery, request.query, 'query');

    const res = await app.pools.control.query<{ fields: string[] }>(
      `SELECT ca.fields
         FROM consent_artifacts ca
         JOIN purposes p    ON p.id = ca.purpose_id
         JOIN principals pr ON pr.id = ca.principal_id
        WHERE pr.project_id = $1
          AND ca.principal_id = $2
          AND p.name = $3
          AND ca.status = 'active'
          AND ca.revoked_at IS NULL
          AND (ca.expires_at IS NULL OR ca.expires_at > now())
        LIMIT 1`,
      [ctx.projectId, query.principalId, query.purpose],
    );

    return {
      advisory: true,
      permitted: res.rowCount > 0,
      fields: res.rows[0]?.fields ?? [],
    };
  });
};

export default routes;
