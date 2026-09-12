/**
 * What does the audit chain cost?
 *
 *   npx tsx tests/bench/audit-lock.bench.ts
 *
 * `setu_append_audit` takes `pg_advisory_xact_lock(hashtext(project_id))` and
 * holds it to end of transaction, so every audited operation on one project is
 * serialised against every other. Reads are audited too, so this is not a
 * write-path cost — it is the read path.
 *
 * The measurement isolates the lock by changing exactly one variable. The same
 * number of concurrent readers, the same rows, the same masking work, run twice:
 * once all against a single project, once spread across many. If the lock is
 * what limits throughput, the first curve is flat in concurrency and the second
 * is not, and the ratio between them is the cost attributable to serialisation
 * rather than to anything else the query does.
 *
 * Not a substitute for a load test: this drives the service in-process, so it
 * excludes HTTP, the gateway hop and signature verification on purpose. Those
 * are constant per request and would only dilute what is being measured.
 */
// Set before the service module is loaded, because it reads this when building
// its logger — and a benchmark that prints a line per request measures its own
// stdout. A static import would hoist above this assignment, so the app is
// imported dynamically inside main() instead.
// Unconditional: .env sets LOG_LEVEL=debug, and a benchmark that prints a line
// per request spends its time measuring its own stdout. Override with
// BENCH_LOG_LEVEL when a run needs the service's logs.
process.env.LOG_LEVEL = process.env.BENCH_LOG_LEVEL ?? 'silent';

import type { FastifyInstance } from 'fastify';
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
import { TEST_SECRET, signedHeaders } from '../helpers/http.js';

const PURPOSE = 'support_chat';

/** Concurrency levels to sweep. */
const CONCURRENCY = [1, 2, 4, 8, 16];
/** Reads per level. Enough to average out scheduling noise, few enough to finish. */
const READS_PER_LEVEL = 200;
/** Distinct projects for the contrast arm. */
const PROJECTS = 8;
/** Rows per collection. Kept small so row count is not the thing being measured. */
const ROWS = 5;

interface Fixture {
  project: TestProject;
  recordIds: string[];
}

let app: FastifyInstance;

function headers(project: TestProject) {
  return signedHeaders({
    tenantId: project.tenantId,
    projectId: project.projectId,
    purpose: PURPOSE,
  });
}

async function setUpProject(hint: string): Promise<Fixture> {
  const project = await provisionProject(hint);
  const purposeId = await createPurpose(project.projectId, PURPOSE);

  const declared = await app.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: signedHeaders({ tenantId: project.tenantId, projectId: project.projectId }),
    payload: {
      name: 'orders',
      fields: [
        { name: 'customer_name', type: 'text', mask: 'redact', purposes: [PURPOSE] },
        { name: 'city', type: 'text', mask: 'null', purposes: [PURPOSE] },
      ],
    },
  });
  if (declared.statusCode !== 201) {
    throw new Error(`declare failed: ${declared.statusCode} ${declared.body}`);
  }

  const recordIds: string[] = [];
  for (let i = 0; i < ROWS; i += 1) {
    const principalId = await createPrincipal(project.projectId, { displayName: `p${i}` });
    await grantConsent(principalId, purposeId, ['customer_name', 'city']);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/collections/orders/records',
      headers: headers(project),
      payload: { principalId, customer_name: `Customer ${i}`, city: 'Pune' },
    });
    if (created.statusCode !== 201) {
      throw new Error(`create failed: ${created.statusCode} ${created.body}`);
    }
    recordIds.push(created.json().id);
  }

  return { project, recordIds };
}

/** One audited point read. This is the operation under test. */
async function readOne(fixture: Fixture, i: number): Promise<void> {
  const id = fixture.recordIds[i % fixture.recordIds.length];
  const res = await app.inject({
    method: 'GET',
    url: `/v1/collections/orders/records/${id}`,
    headers: headers(fixture.project),
  });
  if (res.statusCode !== 200) {
    throw new Error(`read failed: ${res.statusCode} ${res.body}`);
  }
}

interface Sample {
  opsPerSecond: number;
  p50: number;
  p95: number;
}

/**
 * Run `total` reads with `concurrency` in flight, picking the fixture per
 * operation so the two arms differ only in which projects are touched.
 */
async function measure(
  pick: (i: number) => Fixture,
  concurrency: number,
  total: number,
): Promise<Sample> {
  const latencies: number[] = [];
  let issued = 0;

  const startedAt = process.hrtime.bigint();

  async function worker(): Promise<void> {
    for (;;) {
      const i = issued;
      if (i >= total) return;
      issued += 1;

      const t0 = process.hrtime.bigint();
      await readOne(pick(i), i);
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  latencies.sort((a, b) => a - b);

  return {
    opsPerSecond: (total / elapsedMs) * 1000,
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p95: latencies[Math.floor(latencies.length * 0.95)],
  };
}

function row(label: string, s: Sample): string {
  return [
    label.padEnd(14),
    `${s.opsPerSecond.toFixed(0).padStart(8)} ops/s`,
    `p50 ${s.p50.toFixed(1).padStart(6)}ms`,
    `p95 ${s.p95.toFixed(1).padStart(6)}ms`,
  ].join('  ');
}

async function main(): Promise<void> {
  const { buildApp: buildData } = await import('../../services/data/src/app.js');
  app = await buildData({
    pools: { runtime: testPool('runtime'), owner: testPool('owner') },
    signingSecret: TEST_SECRET,
  });

  console.log('[bench] provisioning…');
  const shared = await setUpProject('benchshared');
  const spread: Fixture[] = [];
  for (let i = 0; i < PROJECTS; i += 1) {
    spread.push(await setUpProject(`benchspread${i}`));
  }

  // Warm the pools and the plan cache so the first level is not penalised.
  await measure(() => shared, 4, 40);

  console.log('');
  console.log(`[bench] audited point reads — ${READS_PER_LEVEL} per level`);
  console.log('');
  console.log('  one project (lock contended)          many projects (uncontended)');
  console.log('  ' + '-'.repeat(74));

  const results: Array<{ concurrency: number; one: Sample; many: Sample }> = [];

  for (const concurrency of CONCURRENCY) {
    const one = await measure(() => shared, concurrency, READS_PER_LEVEL);
    const many = await measure((i) => spread[i % spread.length], concurrency, READS_PER_LEVEL);

    results.push({ concurrency, one, many });

    console.log(
      `  c=${String(concurrency).padEnd(3)} ${row('same', one)}   |  ${row('spread', many)}`,
    );
  }

  const base = results[0];
  const top = results[results.length - 1];

  console.log('');
  console.log('[bench] scaling from c=1 to c=' + top.concurrency + ':');
  console.log(
    `  one project : ${(top.one.opsPerSecond / base.one.opsPerSecond).toFixed(2)}x  ` +
      '(1.00x would mean fully serialised)',
  );
  console.log(`  many projects: ${(top.many.opsPerSecond / base.many.opsPerSecond).toFixed(2)}x`);
  console.log('');

  for (const fixture of [shared, ...spread]) await dropProject(fixture.project);
  await app.close();
  await closePools();
}

main().catch((err: unknown) => {
  console.error('[bench] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
