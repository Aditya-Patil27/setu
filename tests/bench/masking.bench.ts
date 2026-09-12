/**
 * What does enforcement cost, and how does that cost grow?
 *
 *   npx tsx tests/bench/masking.bench.ts
 *
 * The read-cost benchmark left the masked SELECT as the largest single item.
 * This measures it against two baselines over the same rows, so the number
 * attributable to each layer is a difference rather than an estimate:
 *
 *   plain   an ordinary table, no policy, no view — what the same query costs
 *           a system that does not enforce anything
 *   rls     the real collection table through its consent policy — the cost of
 *           deciding which rows this purpose may see
 *   masked  the generated view over that table — adds the per-field check
 *
 * masked minus rls is the price of field-level masking; rls minus plain is the
 * price of row-level visibility; masked over plain is what the platform's
 * central claim costs in total.
 *
 * The sweep is two-dimensional on purpose. Every column of every row calls
 * public.setu_field_visible, which is a five-table EXISTS, so the work should
 * grow as rows x fields rather than with either alone. Whether it actually does
 * is the question — the planner is free to hoist or cache in ways that are hard
 * to predict from the SQL.
 */
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

const FIELD_COUNTS = [2, 8, 16];
const ROW_COUNTS = [1, 25, 100];
const ITERATIONS = 60;

interface Arm {
  plain: number;
  rls: number;
  masked: number;
}

async function timeIt(iterations: number, fn: () => Promise<void>): Promise<number> {
  for (let i = 0; i < 10; i += 1) await fn();

  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) await fn();
  return Number(process.hrtime.bigint() - started) / 1e6 / iterations;
}

async function main(): Promise<void> {
  const runtime = testPool('runtime');
  const owner = testPool('owner');

  const project: TestProject = await provisionProject('benchmask');
  const purposeId = await createPurpose(project.projectId, PURPOSE);

  const { buildApp } = await import('../../services/data/src/app.js');
  const { signedHeaders, TEST_SECRET } = await import('../helpers/http.js');
  const app = await buildApp({
    pools: { runtime, owner },
    signingSecret: TEST_SECRET,
  });

  const base = { tenantId: project.tenantId, projectId: project.projectId };
  const ctx = { projectId: project.projectId, purpose: PURPOSE };
  const schema = `"${project.schemaName}"`;

  const grid: Array<{ fields: number; rows: number; arm: Arm }> = [];

  for (const fieldCount of FIELD_COUNTS) {
    const names = Array.from({ length: fieldCount }, (_, i) => `field_${i}`);
    const collection = `orders_f${fieldCount}`;

    const declared = await app.inject({
      method: 'POST',
      url: '/v1/collections',
      headers: signedHeaders(base),
      payload: {
        name: collection,
        fields: names.map((name) => ({
          name,
          type: 'text',
          mask: 'redact',
          purposes: [PURPOSE],
        })),
      },
    });
    if (declared.statusCode !== 201) {
      throw new Error(`declare failed: ${declared.statusCode} ${declared.body}`);
    }

    // One principal per row, each consenting to every field, so nothing is
    // filtered out and the two arms return the same number of rows.
    const maxRows = Math.max(...ROW_COUNTS);
    for (let r = 0; r < maxRows; r += 1) {
      const principalId = await createPrincipal(project.projectId, { displayName: `p${r}` });
      await grantConsent(principalId, purposeId, names);

      const payload: Record<string, unknown> = { principalId };
      for (const name of names) payload[name] = `${name}-value-${r}`;

      const created = await app.inject({
        method: 'POST',
        url: `/v1/collections/${collection}/records`,
        headers: signedHeaders({ ...base, purpose: PURPOSE }),
        payload,
      });
      if (created.statusCode !== 201) {
        throw new Error(`create failed: ${created.statusCode} ${created.body}`);
      }
    }

    /**
     * The unprotected baseline: same columns, same values, no policy and no
     * view. Built by copying the real table so the comparison cannot drift
     * from the shape the generator actually produced.
     */
    const plain = `${schema}."${collection}_plain"`;
    await owner.query(`CREATE TABLE ${plain} AS SELECT * FROM ${schema}."${collection}"`);

    for (const rows of ROW_COUNTS) {
      const cols = ['id', 'principal_id', ...names].map((c) => `"${c}"`).join(', ');

      const plainMs = await timeIt(ITERATIONS, async () => {
        await owner.query(`SELECT ${cols} FROM ${plain} LIMIT $1`, [rows]);
      });

      const rlsMs = await timeIt(ITERATIONS, async () => {
        await withContext(runtime, ctx, async (client: pg.PoolClient) => {
          await client.query(`SELECT ${cols} FROM ${schema}."${collection}" LIMIT $1`, [rows]);
        });
      });

      const maskedMs = await timeIt(ITERATIONS, async () => {
        await withContext(runtime, ctx, async (client: pg.PoolClient) => {
          await client.query(`SELECT ${cols} FROM ${schema}."${collection}_masked" LIMIT $1`, [
            rows,
          ]);
        });
      });

      grid.push({
        fields: fieldCount,
        rows,
        arm: { plain: plainMs, rls: rlsMs, masked: maskedMs },
      });
    }
  }

  console.log('');
  console.log(`[bench] cost of enforcement — ${ITERATIONS} iterations per cell`);
  console.log('');
  console.log(
    '  fields  rows     plain      rls   masked    mask cost   total vs plain   per cell',
  );
  console.log('  ' + '-'.repeat(80));

  for (const { fields, rows, arm } of grid) {
    // The transaction wrapper is in both enforced arms and neither is the
    // baseline's concern, so masking cost is masked minus rls, not minus plain.
    const maskCost = arm.masked - arm.rls;
    const perCell = (maskCost / (rows * fields)) * 1000;

    console.log(
      `  ${String(fields).padStart(6)}  ${String(rows).padStart(4)}  ` +
        `${arm.plain.toFixed(2).padStart(7)}ms ${arm.rls.toFixed(2).padStart(7)}ms ` +
        `${arm.masked.toFixed(2).padStart(7)}ms ` +
        `${maskCost.toFixed(2).padStart(8)}ms ` +
        `${(arm.masked / arm.plain).toFixed(1).padStart(13)}x ` +
        `${perCell.toFixed(1).padStart(9)}us`,
    );
  }

  console.log('');
  console.log('  mask cost = masked - rls (the per-field check alone)');
  console.log('  per cell  = mask cost / (rows x fields) — flat means it is genuinely N x M');
  console.log('');

  for (const fieldCount of FIELD_COUNTS) {
    await owner.query(`DROP TABLE IF EXISTS ${schema}."orders_f${fieldCount}_plain"`);
  }
  await app.close();
  await dropProject(project);
  await closePools();
}

main().catch((err: unknown) => {
  console.error('[bench] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
