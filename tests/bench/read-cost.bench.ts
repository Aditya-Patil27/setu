/**
 * Where does a read actually spend its time?
 *
 *   npx tsx tests/bench/read-cost.bench.ts
 *
 * The lock benchmark showed that serialisation is not what limits throughput,
 * so the cost is in the read itself. This decomposes it by adding one layer at
 * a time and measuring the difference, which separates the two things that could
 * plausibly dominate: work the database does, and round trips spent asking it.
 *
 * A point read used to issue eight statements:
 *
 *   BEGIN, set_config x3, the masked SELECT, purpose lookup,
 *   setu_append_audit, COMMIT
 *
 * Six of those were bookkeeping. A round trip measured ~1ms against a local
 * container while the whole read measured ~12ms, so the enforcement machinery
 * was not what cost — the conversation about it was. Collapsing the three
 * set_config calls into one statement and memoising the purpose lookup removed
 * three of the eight without weakening any check.
 *
 * The steps below still add the layers one at a time, in raw SQL, so the shape
 * of the cost stays visible: the masked SELECT is the single most expensive
 * piece and is the next thing worth attacking.
 */
// Unconditional: .env sets LOG_LEVEL=debug, and a benchmark that prints a line
// per request spends its time measuring its own stdout. Override with
// BENCH_LOG_LEVEL when a run needs the service's logs.
process.env.LOG_LEVEL = process.env.BENCH_LOG_LEVEL ?? 'silent';

import type pg from 'pg';
import { withContext } from '@setu/db';
import {
  closePools,
  createPrincipal,
  createPurpose,
  dropProject,
  grantConsent,
  provisionProject,
  testPool,
  type TestProject,
} from '../helpers/fixtures.js';

const PURPOSE = 'support_chat';
const ITERATIONS = 300;

interface Timing {
  label: string;
  perOpMs: number;
  note: string;
}

async function time(label: string, note: string, fn: () => Promise<void>): Promise<Timing> {
  // Warm, so the first sample does not carry connection setup.
  for (let i = 0; i < 20; i += 1) await fn();

  const started = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) await fn();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  return { label, perOpMs: elapsedMs / ITERATIONS, note };
}

async function main(): Promise<void> {
  const pool = testPool('runtime');
  const owner = testPool('owner');

  const project: TestProject = await provisionProject('benchcost');
  const purposeId = await createPurpose(project.projectId, PURPOSE);
  const principalId = await createPrincipal(project.projectId, { displayName: 'bench' });
  await grantConsent(principalId, purposeId, ['customer_name', 'city']);

  // A collection table, its policy and its masking view, built the same way the
  // Data service builds them — via the service, so nothing here can drift from it.
  const { buildApp } = await import('../../services/data/src/app.js');
  const { signedHeaders, TEST_SECRET } = await import('../helpers/http.js');
  const app = await buildApp({ pools: { runtime: pool, owner }, signingSecret: TEST_SECRET });

  const base = { tenantId: project.tenantId, projectId: project.projectId };
  await app.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: signedHeaders(base),
    payload: {
      name: 'orders',
      fields: [
        { name: 'customer_name', type: 'text', mask: 'redact', purposes: [PURPOSE] },
        { name: 'city', type: 'text', mask: 'null', purposes: [PURPOSE] },
      ],
    },
  });

  const created = await app.inject({
    method: 'POST',
    url: '/v1/collections/orders/records',
    headers: signedHeaders({ ...base, purpose: PURPOSE }),
    payload: { principalId, customer_name: 'Bench Customer', city: 'Pune' },
  });
  const recordId = created.json().id;

  const ctx = { projectId: project.projectId, purpose: PURPOSE, principalId };
  const view = `"${project.schemaName}"."orders_masked"`;

  const results: Timing[] = [];

  results.push(
    await time('round trip', '1 statement — the floor for anything at all', async () => {
      await pool.query('SELECT 1');
    }),
  );

  results.push(
    await time('empty txn', '2 statements — BEGIN, COMMIT', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }),
  );

  results.push(
    await time('withContext', '3 statements — BEGIN, one combined set_config, COMMIT', async () => {
      await withContext(pool, ctx, async () => undefined);
    }),
  );

  results.push(
    await time(
      '+ masked read',
      '4 statements — the enforcement actually doing its job',
      async () => {
        await withContext(pool, ctx, async (client: pg.PoolClient) => {
          await client.query(`SELECT * FROM ${view} WHERE id = $1::uuid`, [recordId]);
        });
      },
    ),
  );

  results.push(
    await time(
      '+ purpose id',
      '5 statements — the lookup, which the service now memoises away',
      async () => {
        await withContext(pool, ctx, async (client: pg.PoolClient) => {
          await client.query(`SELECT * FROM ${view} WHERE id = $1::uuid`, [recordId]);
          await client.query(`SELECT id FROM purposes WHERE project_id = $1 AND name = $2`, [
            ctx.projectId,
            ctx.purpose,
          ]);
        });
      },
    ),
  );

  results.push(
    await time('+ audit append', '6 statements — the whole read, lock included', async () => {
      await withContext(pool, ctx, async (client: pg.PoolClient) => {
        await client.query(`SELECT * FROM ${view} WHERE id = $1::uuid`, [recordId]);
        const p = await client.query<{ id: string }>(
          `SELECT id FROM purposes WHERE project_id = $1 AND name = $2`,
          [ctx.projectId, ctx.purpose],
        );
        await client.query(`SELECT public.setu_append_audit($1, $2, $3, $4, $5, $6::text[], $7)`, [
          ctx.projectId,
          principalId,
          p.rows[0].id,
          'read',
          `${project.schemaName}.orders/${recordId}`,
          ['customer_name', 'city'],
          'permitted',
        ]);
      });
    }),
  );

  console.log('');
  console.log(`[bench] cost of one point read — ${ITERATIONS} iterations each, serial`);
  console.log('');

  let previous = 0;
  for (const r of results) {
    const delta = r.perOpMs - previous;
    console.log(
      `  ${r.label.padEnd(15)} ${r.perOpMs.toFixed(2).padStart(6)}ms` +
        `  (+${delta.toFixed(2).padStart(5)}ms)   ${r.note}`,
    );
    previous = r.perOpMs;
  }

  const rtt = results[0].perOpMs;
  const total = results[results.length - 1].perOpMs;
  console.log('');
  // Five in the service path: the purpose lookup is memoised, so it costs a
  // round trip here but none in production.
  const STATEMENTS = 5;
  console.log(
    `  one round trip costs ~${rtt.toFixed(2)}ms; the service path spends ${STATEMENTS} of them.`,
  );
  console.log(
    `  round trips account for ~${((rtt * STATEMENTS) / total) * 100 > 100 ? 100 : (((rtt * STATEMENTS) / total) * 100).toFixed(0)}% of the ${total.toFixed(2)}ms measured here.`,
  );
  console.log('');

  await app.close();
  await dropProject(project);
  await closePools();
}

main().catch((err: unknown) => {
  console.error('[bench] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
