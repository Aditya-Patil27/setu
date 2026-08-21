import type { FastifyPluginAsync } from 'fastify';
import { NotFoundError, contextFromHeaders } from '@setu/shared';
import { ARTIFACT_COLUMNS, presentArtifact, type ArtifactRow } from './consents.js';
import { CONSENT_CHANGED } from '../events.js';

/**
 * Principal-facing routes.
 *
 * These require a principal in the request context, which in practice means a
 * session token rather than a project API key: a data subject inspecting and
 * withdrawing their own consent, without going through the tenant.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.get('/me/consents', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, {
      requirePrincipal: true,
    });

    const res = await app.pools.control.query<ArtifactRow>(
      `SELECT ${ARTIFACT_COLUMNS}
         FROM consent_artifacts ca
         JOIN purposes p    ON p.id = ca.purpose_id
         JOIN principals pr ON pr.id = ca.principal_id
        WHERE pr.project_id = $1 AND ca.principal_id = $2
        ORDER BY ca.granted_at DESC`,
      [ctx.projectId, ctx.principalId],
    );

    return { consents: res.rows.map(presentArtifact) };
  });

  app.post<{ Params: { id: string } }>('/me/consents/:id/revoke', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, {
      requirePrincipal: true,
    });

    // Scoped by principal_id as well as project: a principal may only revoke
    // their own artifact, never another subject's.
    const res = await app.pools.control.query<{ id: string; purpose_name: string }>(
      `UPDATE consent_artifacts ca
          SET status = 'revoked', revoked_at = now()
         FROM principals pr, purposes p
        WHERE ca.id = $1
          AND pr.id = ca.principal_id
          AND p.id  = ca.purpose_id
          AND pr.project_id  = $2
          AND ca.principal_id = $3
          AND ca.status = 'active'
      RETURNING ca.id, p.name AS purpose_name`,
      [request.params.id, ctx.projectId, ctx.principalId],
    );

    if (!res.rowCount) throw new NotFoundError('Active consent artifact', request.params.id);

    await app.events.publish(CONSENT_CHANGED, {
      projectId: ctx.projectId,
      principalId: ctx.principalId,
      consentId: res.rows[0].id,
      purpose: res.rows[0].purpose_name,
      action: 'revoked-by-principal',
    });

    return { id: res.rows[0].id, status: 'revoked' };
  });
};

export default routes;
