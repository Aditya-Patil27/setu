import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError, contextFromHeaders, parseInput } from '@setu/shared';
import { verifyChain } from '../chain.js';

/**
 * M7 — Audit service routes.
 *
 * Read-only by construction. Records are appended by the database, inside the
 * transaction of the service that performed the access; this service reads them
 * back and can prove the chain has not been altered since.
 *
 * Every query is scoped to the project in the signed context. audit_records
 * carries no RLS policy of its own — it is platform-owned rather than tenant
 * data — so that scoping is this service's responsibility and appears in every
 * statement below.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const ListQuery = z.object({
  principalId: z.string().uuid().optional(),
  purpose: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(64)
    .optional(),
  action: z.enum(['read', 'create', 'update', 'delete']).optional(),
  outcome: z.enum(['permitted', 'denied']).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  /** Keyset cursor: the seq of the last row seen. */
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

interface RecordRow {
  id: string;
  seq: string;
  principal_id: string;
  purpose_name: string | null;
  action: string;
  resource: string;
  fields: string[];
  outcome: string;
  prev_hash: string;
  hash: string;
  created_at: Date;
}

const present = (row: RecordRow) => ({
  id: row.id,
  seq: Number(row.seq),
  principalId: row.principal_id,
  purpose: row.purpose_name,
  action: row.action,
  resource: row.resource,
  fields: row.fields,
  outcome: row.outcome,
  prevHash: row.prev_hash,
  hash: row.hash,
  createdAt: row.created_at,
});

const SELECT = `
  SELECT a.id, a.seq, a.principal_id, p.name AS purpose_name, a.action, a.resource,
         a.fields, a.outcome, a.prev_hash, a.hash, a.created_at
    FROM audit_records a
    LEFT JOIN purposes p ON p.id = a.purpose_id
`;

const routes: FastifyPluginAsync = async (app) => {
  /**
   * The access log for a project, oldest first so the order matches the chain.
   *
   * Denials appear here in full. They are opaque to the caller who was denied —
   * a 404 that cannot be distinguished from an absent row — and legible only to
   * the tenant reading their own audit trail, which is the point of recording
   * them separately at all.
   */
  app.get('/audit/records', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const query = parseInput(ListQuery, request.query, 'audit query');

    if (query.since && query.until && query.since > query.until) {
      throw new ValidationError('since must not be after until', {
        since: query.since,
        until: query.until,
      });
    }

    const where: string[] = ['a.project_id = $1'];
    const params: unknown[] = [ctx.projectId];
    const bind = (value: unknown) => `$${params.push(value)}`;

    if (query.principalId) where.push(`a.principal_id = ${bind(query.principalId)}`);
    if (query.purpose) where.push(`p.name = ${bind(query.purpose)}`);
    if (query.action) where.push(`a.action = ${bind(query.action)}`);
    if (query.outcome) where.push(`a.outcome = ${bind(query.outcome)}`);
    if (query.since) where.push(`a.created_at >= ${bind(query.since)}`);
    if (query.until) where.push(`a.created_at <= ${bind(query.until)}`);
    if (query.after !== undefined) where.push(`a.seq > ${bind(String(query.after))}`);

    const res = await app.pools.runtime.query<RecordRow>(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.seq LIMIT ${bind(query.limit)}`,
      params,
    );

    const records = res.rows.map(present);
    return {
      records,
      // Present only when the page was full, so a caller knows to ask again.
      nextCursor: records.length === query.limit ? records[records.length - 1].seq : undefined,
    };
  });

  app.get<{ Params: { id: string } }>('/audit/records/:id', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    if (!/^[0-9a-f-]{36}$/i.test(request.params.id)) {
      throw new ValidationError('Invalid record id', { id: request.params.id });
    }

    const res = await app.pools.runtime.query<RecordRow>(
      `${SELECT} WHERE a.project_id = $1 AND a.id = $2`,
      [ctx.projectId, request.params.id],
    );
    if (!res.rowCount) throw new NotFoundError('Audit record', request.params.id);

    return present(res.rows[0]);
  });

  /**
   * Recompute the whole chain and report every break.
   *
   * This is what makes the log tamper-evident rather than merely append-only:
   * editing a row breaks its own digest, and deleting one breaks the link its
   * successor carries. Neither can be repaired without the ability to rewrite
   * every row that follows.
   */
  app.get('/audit/verify', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const result = await verifyChain(app.pools.runtime, ctx.projectId);

    // A broken chain is a successful verification that found something, not a
    // failed request — 200 with intact: false, so a monitor reads the body.
    return reply.status(200).send(result);
  });
};

export default routes;
