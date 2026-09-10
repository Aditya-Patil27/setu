import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../services/metering/src/app.js';
import {
  closePools,
  dropProject,
  provisionProject,
  testPool,
  type TestProject,
} from '../helpers/fixtures.js';
import { signedHeaders, TEST_SECRET } from '../helpers/http.js';

/**
 * Usage is counts of what the platform did, never a fact about a person.
 *
 * usage_records has no principal, no purpose and no RLS, which makes it the
 * obvious place to smuggle personal data past every gate the platform has. The
 * closed meter vocabulary is what stops that, and most of what follows is about
 * proving the closure actually holds.
 */

let app: FastifyInstance;
let project: TestProject;

const headers = (p: TestProject = project) =>
  signedHeaders({ tenantId: p.tenantId, projectId: p.projectId });

const ingest = (samples: unknown[], p: TestProject = project) =>
  app.inject({
    method: 'POST',
    url: '/v1/metering/records',
    headers: headers(p),
    payload: { samples },
  });

const usage = (query = '', p: TestProject = project) =>
  app.inject({ method: 'GET', url: `/v1/metering/usage${query}`, headers: headers(p) });

beforeAll(async () => {
  project = await provisionProject('metering');
  app = await buildApp({ pools: { control: testPool('control') }, signingSecret: TEST_SECRET });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await dropProject(project);
  await closePools();
});

describe('recording usage', () => {
  it('accepts a batch and rolls it up per meter', async () => {
    const res = await ingest([
      { service: 'gateway', metric: 'requests', value: 3 },
      { service: 'gateway', metric: 'requests', value: 4 },
      { service: 'storage', metric: 'bytes_stored', value: 2048 },
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ recorded: 3 });

    const rolled = await usage();
    expect(rolled.statusCode).toBe(200);

    const rows = rolled.json().usage;
    expect(rows).toContainEqual(
      expect.objectContaining({ service: 'gateway', metric: 'requests', total: 7, samples: 2 }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ service: 'storage', metric: 'bytes_stored', total: 2048 }),
    );
  });

  it('defaults a sample with no value to one', async () => {
    const fresh = await provisionProject('meteringdefault');
    try {
      await ingest([{ service: 'auth', metric: 'sessions' }], fresh);
      const rows = (await usage('', fresh)).json().usage;
      expect(rows).toContainEqual(expect.objectContaining({ total: 1, samples: 1 }));
    } finally {
      await dropProject(fresh);
    }
  });

  it('narrows a rollup to one service or one metric', async () => {
    const byService = await usage('?service=gateway');
    expect(byService.json().usage.every((r: { service: string }) => r.service === 'gateway')).toBe(
      true,
    );

    const byMetric = await usage('?metric=bytes_stored');
    expect(
      byMetric.json().usage.every((r: { metric: string }) => r.metric === 'bytes_stored'),
    ).toBe(true);
  });

  /** A batch that half-applied would make every total quietly wrong. */
  it('records nothing at all when one sample in a batch is rejected', async () => {
    const fresh = await provisionProject('meteringatomic');
    try {
      const res = await ingest(
        [
          { service: 'gateway', metric: 'requests', value: 1 },
          { service: 'gateway', metric: 'not_a_meter', value: 1 },
        ],
        fresh,
      );
      expect(res.statusCode).toBe(400);

      const rows = (await usage('', fresh)).json().usage;
      expect(rows).toEqual([]);
    } finally {
      await dropProject(fresh);
    }
  });
});

describe('the meter vocabulary is closed', () => {
  /**
   * The one that matters. A free-text metric would let a caller write a fact
   * about a named person into a table with no principal, no purpose and no RLS
   * — and it would outlive that person revoking consent, because nothing in
   * metering consults consent at all.
   */
  it('refuses a metric that encodes a fact about someone', async () => {
    const res = await ingest([
      { service: 'data', metric: 'read.asha_menon.hiv_status', value: 1 },
    ]);
    expect(res.statusCode).toBe(400);
  });

  it('refuses an unknown service', async () => {
    const res = await ingest([{ service: 'shadow_service', metric: 'requests', value: 1 }]);
    expect(res.statusCode).toBe(400);
  });

  it('refuses a real metric attributed to the wrong service', async () => {
    // 'bytes_stored' exists, but on storage rather than gateway.
    const res = await ingest([{ service: 'gateway', metric: 'bytes_stored', value: 1 }]);
    expect(res.statusCode).toBe(400);
  });

  it('answers identically for an unknown service and an unknown metric', async () => {
    const unknownService = await ingest([{ service: 'nope', metric: 'requests' }]);
    const unknownMetric = await ingest([{ service: 'gateway', metric: 'nope' }]);
    expect(unknownService.statusCode).toBe(unknownMetric.statusCode);
  });

  it('publishes the vocabulary rather than making callers guess', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/metering/meters',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meters).toContainEqual(
      expect.objectContaining({ service: 'gateway', metrics: expect.arrayContaining(['requests']) }),
    );
  });
});

describe('values that can be summed', () => {
  /**
   * Postgres accepts NaN and Infinity in a float8 column, and one of either
   * poisons every SUM taken over it afterwards — including the ones an invoice
   * is built from. Rejected at the boundary, and again by a CHECK constraint.
   */
  it('refuses NaN and Infinity', async () => {
    for (const value of ['NaN', 'Infinity', '-Infinity']) {
      const res = await ingest([{ service: 'gateway', metric: 'requests', value }]);
      expect(res.statusCode).toBe(400);
    }
  });

  it('has a database constraint behind the validator', async () => {
    // Straight past the service, as a compromised caller would.
    await expect(
      testPool('owner').query(
        `INSERT INTO usage_records (tenant_id, project_id, service, metric, value)
         VALUES ($1, $2, 'gateway', 'requests', 'NaN')`,
        [project.tenantId, project.projectId],
      ),
    ).rejects.toThrow(/usage_records_value_finite/);
  });

  it('allows a negative value, for a correction', async () => {
    const fresh = await provisionProject('meteringneg');
    try {
      await ingest(
        [
          { service: 'gateway', metric: 'requests', value: 10 },
          { service: 'gateway', metric: 'requests', value: -4 },
        ],
        fresh,
      );
      const rows = (await usage('', fresh)).json().usage;
      expect(rows[0].total).toBe(6);
    } finally {
      await dropProject(fresh);
    }
  });
});

describe('scoping and windows', () => {
  it('shows a project nothing but its own usage', async () => {
    const other = await provisionProject('meteringother');
    try {
      expect((await usage('', other)).json().usage).toEqual([]);
    } finally {
      await dropProject(other);
    }
  });

  it('refuses a since later than its until', async () => {
    expect((await usage('?since=2030-01-01&until=2020-01-01')).statusCode).toBe(400);
  });

  it('refuses a window wider than a year', async () => {
    expect((await usage('?since=2000-01-01&until=2026-01-01')).statusCode).toBe(400);
  });

  it('excludes samples outside the window', async () => {
    const res = await usage('?since=2000-01-01&until=2000-12-31');
    expect(res.statusCode).toBe(200);
    expect(res.json().usage).toEqual([]);
  });

  it('refuses an unsigned request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/metering/usage' });
    expect(res.statusCode).toBe(401);
  });
});
