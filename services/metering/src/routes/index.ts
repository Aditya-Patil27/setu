import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError, contextFromHeaders, parseInput } from '@setu/shared';
import { assertMeter, listMeters } from '../meters.js';

/**
 * M8 — Metering routes.
 *
 * Usage is operational data: counts of what the platform did, never a fact
 * about a person. That is why nothing here binds a purpose and why
 * usage_records carries no principal — and why the meter vocabulary is closed
 * rather than free text. See meters.ts for what that closure prevents.
 *
 * Every statement scopes by the project in the signed context. usage_records has
 * no RLS policy of its own, in the same way audit_records has none: these are
 * platform-owned tables rather than tenant rows, so the scoping is this
 * service's responsibility and appears in each query below.
 */

const MAX_BATCH = 500;
const MAX_WINDOW_DAYS = 366;
const DEFAULT_WINDOW_DAYS = 30;

const Sample = z.object({
  service: z.string().min(1).max(40),
  metric: z.string().min(1).max(40),
  /** Finite by construction; the database rejects NaN and Infinity as well. */
  value: z.number().finite().default(1),
  recordedAt: z.coerce.date().optional(),
});

const Ingest = z.object({
  samples: z.array(Sample).min(1).max(MAX_BATCH),
});

const UsageQuery = z.object({
  service: z.string().max(40).optional(),
  metric: z.string().max(40).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

interface RollupRow {
  service: string;
  metric: string;
  total: string | number;
  samples: string | number;
  first_at: Date;
  last_at: Date;
}

const routes: FastifyPluginAsync = async (app) => {
  /** The meters this build accepts. */
  app.get('/metering/meters', async (request) => {
    contextFromHeaders(request.headers, app.signingSecret);
    return { meters: listMeters() };
  });

  /**
   * Record usage.
   *
   * Batched because the callers are services on a hot path: one insert per
   * request would make metering the most expensive thing the platform does.
   */
  app.post('/metering/records', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(Ingest, request.body, 'usage');

    for (const sample of body.samples) assertMeter(sample.service, sample.metric);

    // One multi-row INSERT rather than a loop: the batch is atomic, so a
    // rejected sample cannot leave half a batch recorded.
    const values: unknown[] = [];
    const tuples = body.samples.map((s, i) => {
      const base = i * 5;
      values.push(ctx.tenantId, ctx.projectId, s.service, s.metric, s.value);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    await app.pools.control.query(
      `INSERT INTO usage_records (tenant_id, project_id, service, metric, value)
       VALUES ${tuples.join(', ')}`,
      values,
    );

    return reply.status(202).send({ recorded: body.samples.length });
  });

  /**
   * Usage rolled up per meter over a window.
   *
   * The shape a bill or a dashboard actually wants: totals rather than rows, so
   * a caller never has to page through a million samples to learn one number.
   */
  app.get('/metering/usage', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const query = parseInput(UsageQuery, request.query, 'usage query');

    if (query.since && query.until && query.since > query.until) {
      throw new ValidationError('since must not be after until', {
        since: query.since,
        until: query.until,
      });
    }

    const oldest = Date.now() - MAX_WINDOW_DAYS * 86_400_000;
    const widest = query.until ? query.until.getTime() - MAX_WINDOW_DAYS * 86_400_000 : oldest;
    if (query.since && query.since.getTime() < widest) {
      throw new ValidationError(`window must not exceed ${MAX_WINDOW_DAYS} days`, {
        since: query.since,
        until: query.until,
      });
    }

    /**
     * Both bounds are the caller's or the database's, never this process's.
     *
     * Defaulting `until` to `new Date()` would compare a timestamp from the
     * service's clock against `recorded_at`, which Postgres fills from its own.
     * A few milliseconds of skew — routine between a container and its host —
     * is enough to drop the rows that were just written, so "usage up to now"
     * would silently omit the newest samples. An absent `until` therefore means
     * no upper bound at all, and an absent `since` is resolved by the database.
     */
    const where = ['project_id = $1'];
    const params: unknown[] = [ctx.projectId];

    if (query.since) {
      where.push(`recorded_at >= $${params.push(query.since)}`);
    } else {
      where.push(`recorded_at >= now() - make_interval(days => ${DEFAULT_WINDOW_DAYS})`);
    }
    if (query.until) where.push(`recorded_at <= $${params.push(query.until)}`);

    if (query.service) where.push(`service = $${params.push(query.service)}`);
    if (query.metric) where.push(`metric = $${params.push(query.metric)}`);

    const res = await app.pools.control.query<RollupRow>(
      `SELECT service, metric,
              SUM(value)  AS total,
              COUNT(*)    AS samples,
              MIN(recorded_at) AS first_at,
              MAX(recorded_at) AS last_at
         FROM usage_records
        WHERE ${where.join(' AND ')}
        GROUP BY service, metric
        ORDER BY service, metric`,
      params,
    );

    return {
      // Echoes what was asked for. A null bound is not "now" — it is unbounded,
      // and saying "now" would be this process's clock all over again.
      window: { since: query.since ?? null, until: query.until ?? null },
      usage: res.rows.map((row) => ({
        service: row.service,
        metric: row.metric,
        // SUM over float8 comes back as a number, COUNT as a bigint string.
        total: Number(row.total),
        samples: Number(row.samples),
        firstAt: row.first_at,
        lastAt: row.last_at,
      })),
    };
  });
};

export default routes;
