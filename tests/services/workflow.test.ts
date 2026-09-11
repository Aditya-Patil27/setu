import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SignedContext } from '@setu/shared';
import { buildApp } from '../../services/workflow/src/app.js';
import type { StepInvoker, StepResult } from '../../services/workflow/src/invoker.js';
import {
  closePools,
  createPurpose,
  dropProject,
  provisionProject,
  testPool,
  type TestProject,
} from '../helpers/fixtures.js';
import { signedHeaders, TEST_SECRET } from '../helpers/http.js';

/**
 * Two claims carry the weight here, and both are about what the database
 * enforces rather than what this service remembers to do:
 *
 *   - a step runs at most once while its lease holds
 *   - a workflow cannot reach a function that never declared its purpose
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';

let app: FastifyInstance;
let project: TestProject;

/** Records every invocation so the tests can count them. */
interface Recorder extends StepInvoker {
  calls: Array<{ fn: string; input: unknown; purpose?: string }>;
  behaviour: Map<string, () => Promise<StepResult>>;
}

function createRecorder(): Recorder {
  const calls: Recorder['calls'] = [];
  const behaviour = new Map<string, () => Promise<StepResult>>();

  return {
    calls,
    behaviour,
    async invoke(fn: string, input: unknown, context: SignedContext) {
      calls.push({ fn, input, purpose: context.purpose });
      const scripted = behaviour.get(fn);
      if (scripted) return scripted();
      return { status: 'succeeded', output: { ranBy: fn, got: input } };
    },
  };
}

let invoker: Recorder;

const headers = (purpose?: string, p: TestProject = project) =>
  signedHeaders({ tenantId: p.tenantId, projectId: p.projectId, purpose });

/** Functions are declared straight into the table: this suite is not testing M6. */
async function declareFunction(name: string, purposes: string[]): Promise<void> {
  await testPool('owner').query(
    `INSERT INTO function_definitions (project_id, name, source, purposes)
     VALUES ($1, $2, 'export default async () => null;', $3::text[])
     ON CONFLICT (project_id, name) DO UPDATE SET purposes = EXCLUDED.purposes`,
    [project.projectId, name, purposes],
  );
}

const defineWorkflow = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/v1/workflows', headers: headers(), payload: body });

const start = (name: string, purpose?: string, input?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/v1/workflows/${name}/start`,
    headers: headers(purpose),
    payload: { input },
  });

const advance = (id: string, purpose?: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/workflows/executions/${id}/advance`,
    headers: headers(purpose),
  });

const run = (id: string, purpose?: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/workflows/executions/${id}/run`,
    headers: headers(purpose),
  });

const inspect = (id: string) =>
  app.inject({ method: 'GET', url: `/v1/workflows/executions/${id}`, headers: headers() });

beforeAll(async () => {
  project = await provisionProject('wf');
  await createPurpose(project.projectId, SUPPORT);
  await createPurpose(project.projectId, ANALYTICS);

  await declareFunction('extract', [SUPPORT]);
  await declareFunction('transform', [SUPPORT]);
  await declareFunction('load', [SUPPORT]);
  await declareFunction('analytics_only', [ANALYTICS]);
  await declareFunction('no_purpose', []);

  invoker = createRecorder();
  app = await buildApp({
    pools: { control: testPool('control') },
    signingSecret: TEST_SECRET,
    invoker,
    leaseSeconds: 60,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await dropProject(project);
  await closePools();
});

describe('running a workflow to completion', () => {
  beforeAll(async () => {
    const res = await defineWorkflow({
      name: 'etl',
      purposes: [SUPPORT],
      steps: [
        { name: 'one', function: 'extract' },
        { name: 'two', function: 'transform' },
        { name: 'three', function: 'load' },
      ],
    });
    expect(res.statusCode).toBe(201);
  });

  it('advances one step per call and settles on the last', async () => {
    const execution = (await start('etl', SUPPORT, { seed: 1 })).json();
    expect(execution.status).toBe('pending');

    const first = await advance(execution.id, SUPPORT);
    expect(first.json()).toMatchObject({ advanced: true, status: 'running' });
    expect(first.json().step).toMatchObject({ index: 0, name: 'one', status: 'succeeded' });

    await advance(execution.id, SUPPORT);
    const third = await advance(execution.id, SUPPORT);
    expect(third.json().status).toBe('succeeded');

    const after = await advance(execution.id, SUPPORT);
    expect(after.json()).toMatchObject({ advanced: false, reason: 'already settled' });
  });

  /** Each step receives the previous step's output; the first receives the input. */
  it('chains each step output into the next step input', async () => {
    invoker.calls.length = 0;
    const execution = (await start('etl', SUPPORT, { seed: 2 })).json();
    await run(execution.id, SUPPORT);

    const forThis = invoker.calls.slice(-3);
    expect(forThis[0].input).toEqual({ seed: 2 });
    expect(forThis[1].input).toEqual({ ranBy: 'extract', got: { seed: 2 } });
    expect(forThis[2].input).toEqual({ ranBy: 'transform', got: forThis[1].input });
  });

  it('runs every step under the purpose the execution was started with', async () => {
    invoker.calls.length = 0;
    const execution = (await start('etl', SUPPORT, {})).json();
    await run(execution.id, SUPPORT);

    expect(invoker.calls.every((c) => c.purpose === SUPPORT)).toBe(true);
  });

  it('reports per-step state', async () => {
    const execution = (await start('etl', SUPPORT, {})).json();
    await run(execution.id, SUPPORT);

    const state = (await inspect(execution.id)).json();
    expect(state.execution.status).toBe('succeeded');
    expect(state.steps).toHaveLength(3);
    expect(state.steps.map((s: { status: string }) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
  });
});

describe('a step runs at most once', () => {
  /**
   * The load-bearing durability test. Two workers advance the same execution
   * simultaneously; the unique constraint means exactly one claims step 0, and
   * the function is invoked once rather than twice.
   */
  /**
   * While a step is genuinely in flight, every other worker must bounce off it.
   *
   * The step is made slow on purpose so all eight contend for the same index.
   * Without that, a worker arriving after the first finished would correctly
   * claim the *next* step, and "exactly one advanced" would be the wrong thing
   * to assert — see the test below for what is actually guaranteed.
   */
  it('lets exactly one of eight workers claim a step that is in flight', async () => {
    const WORKERS = 8;
    await declareFunction('slow', [SUPPORT]);
    await defineWorkflow({
      name: 'contended',
      purposes: [SUPPORT],
      steps: [{ name: 'only', function: 'slow' }],
    });

    invoker.behaviour.set('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: 'succeeded', output: 'done' };
    });

    try {
      const execution = (await start('contended', SUPPORT, {})).json();
      invoker.calls.length = 0;

      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => advance(execution.id, SUPPORT)),
      );

      expect(results.filter((r) => r.json().advanced)).toHaveLength(1);
      // The consequence that matters: a second invocation is a side effect
      // happening twice, which is what the unique constraint prevents.
      expect(invoker.calls).toHaveLength(1);

      for (const loser of results.filter((r) => !r.json().advanced)) {
        expect(loser.json().reason).toBe('step is already being worked on');
      }
    } finally {
      invoker.behaviour.delete('slow');
    }
  });

  /**
   * With fast steps, several workers legitimately make progress at once — one
   * finishes step 0 and the next picks up step 1. That is not a violation. What
   * must never happen is the same step running twice, so that is what is asserted.
   */
  it('never runs any step twice, even under eight concurrent workers', async () => {
    const execution = (await start('etl', SUPPORT, { race: true })).json();
    invoker.calls.length = 0;

    await Promise.all(Array.from({ length: 8 }, () => advance(execution.id, SUPPORT)));
    // Drain anything still outstanding so the execution reaches a terminal state.
    await run(execution.id, SUPPORT);

    // Three steps, so at most three invocations — and each function exactly once.
    const invoked = invoker.calls.map((c) => c.fn);
    expect(invoked).toHaveLength(3);
    expect(new Set(invoked).size).toBe(3);

    const rows = await testPool('owner').query<{ step_index: number; attempts: number }>(
      `SELECT step_index, attempts FROM workflow_step_executions
        WHERE execution_id = $1 ORDER BY step_index`,
      [execution.id],
    );
    expect(rows.rows.map((r) => r.step_index)).toEqual([0, 1, 2]);
    // One attempt each: nothing was claimed twice.
    expect(rows.rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it('never re-runs a step that already succeeded', async () => {
    const execution = (await start('etl', SUPPORT, {})).json();
    await advance(execution.id, SUPPORT);

    invoker.calls.length = 0;
    // Step 0 is done; advancing again must move on to step 1, not repeat step 0.
    await advance(execution.id, SUPPORT);

    expect(invoker.calls).toHaveLength(1);
    expect(invoker.calls[0].fn).toBe('transform');
  });

  /**
   * A worker that dies leaves its step `running`. Without a lease the execution
   * would wedge forever, so a step whose lease has expired is reclaimable — and
   * until it expires, it is not.
   */
  it('reclaims a step abandoned by a dead worker, but only once its lease expires', async () => {
    const execution = (await start('etl', SUPPORT, {})).json();
    await advance(execution.id, SUPPORT);
    await advance(execution.id, SUPPORT);

    // Simulate a worker that claimed step 2 and then died.
    await testPool('owner').query(
      `INSERT INTO workflow_step_executions
         (execution_id, step_index, step_name, function_name, status, attempts, started_at)
       VALUES ($1, 2, 'three', 'load', 'running', 1, now())`,
      [execution.id],
    );

    invoker.calls.length = 0;
    const blocked = await advance(execution.id, SUPPORT);
    expect(blocked.json().advanced).toBe(false);
    expect(invoker.calls).toHaveLength(0);

    // Age the claim past the 60s lease this app was built with.
    await testPool('owner').query(
      `UPDATE workflow_step_executions
          SET started_at = now() - interval '10 minutes'
        WHERE execution_id = $1 AND step_index = 2`,
      [execution.id],
    );

    const reclaimed = await advance(execution.id, SUPPORT);
    expect(reclaimed.json().advanced).toBe(true);
    expect(invoker.calls).toHaveLength(1);
  });

  it('resumes mid-flight rather than restarting', async () => {
    const execution = (await start('etl', SUPPORT, { resume: true })).json();
    await advance(execution.id, SUPPORT);

    // A fresh app stands in for a restarted process: state lives in the database,
    // not in the one that started the work.
    const reborn = await buildApp({
      pools: { control: testPool('control') },
      signingSecret: TEST_SECRET,
      invoker,
      leaseSeconds: 60,
    });
    await reborn.ready();

    try {
      invoker.calls.length = 0;
      await reborn.inject({
        method: 'POST',
        url: `/v1/workflows/executions/${execution.id}/run`,
        headers: headers(SUPPORT),
      });

      // Steps 1 and 2 only: step 0 survived the restart as succeeded.
      expect(invoker.calls.map((c) => c.fn)).toEqual(['transform', 'load']);
    } finally {
      await reborn.close();
    }
  });
});

describe('retries', () => {
  it('retries a failing step up to its maxAttempts, then fails the execution', async () => {
    await declareFunction('flaky', [SUPPORT]);
    await defineWorkflow({
      name: 'retrying',
      purposes: [SUPPORT],
      steps: [{ name: 'flaky', function: 'flaky', maxAttempts: 3 }],
    });

    invoker.behaviour.set('flaky', async () => ({
      status: 'failed',
      output: null,
      error: 'upstream said no',
    }));

    try {
      const execution = (await start('retrying', SUPPORT, {})).json();

      const first = await advance(execution.id, SUPPORT);
      expect(first.json().step).toMatchObject({ status: 'pending', attempts: 1 });
      expect(first.json().reason).toContain('retried');

      await advance(execution.id, SUPPORT);
      const third = await advance(execution.id, SUPPORT);
      expect(third.json().step).toMatchObject({ status: 'failed', attempts: 3 });
      expect(third.json().status).toBe('failed');

      const state = (await inspect(execution.id)).json();
      expect(state.execution.error).toContain('upstream said no');
      expect(state.steps[0].attempts).toBe(3);
    } finally {
      invoker.behaviour.delete('flaky');
    }
  });

  it('succeeds on a retry when the step recovers', async () => {
    await declareFunction('eventually', [SUPPORT]);
    await defineWorkflow({
      name: 'recovering',
      purposes: [SUPPORT],
      steps: [{ name: 'eventually', function: 'eventually', maxAttempts: 3 }],
    });

    let attempt = 0;
    invoker.behaviour.set('eventually', async () => {
      attempt += 1;
      return attempt < 2
        ? { status: 'failed', output: null, error: 'not yet' }
        : { status: 'succeeded', output: { attempt } };
    });

    try {
      const execution = (await start('recovering', SUPPORT, {})).json();
      const settled = await run(execution.id, SUPPORT);

      expect(settled.json().status).toBe('succeeded');
      const state = (await inspect(execution.id)).json();
      expect(state.steps[0].attempts).toBe(2);
      expect(state.execution.output).toEqual({ attempt: 2 });
    } finally {
      invoker.behaviour.delete('eventually');
    }
  });
});

describe('a workflow cannot escalate past its functions', () => {
  /**
   * The chain is only as privileged as its weakest link. A workflow running under
   * support_chat whose step calls a function declaring only analytics would let
   * the chain reach a function that never agreed to run for support_chat.
   */
  it('refuses a step whose function does not declare the workflow purpose', async () => {
    const res = await defineWorkflow({
      name: 'escalating',
      purposes: [SUPPORT],
      steps: [
        { name: 'fine', function: 'extract' },
        { name: 'sneaky', function: 'analytics_only' },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('does not declare every purpose');
  });

  it('refuses a step whose function declares no purposes at all', async () => {
    const res = await defineWorkflow({
      name: 'unpurposed',
      purposes: [SUPPORT],
      steps: [{ name: 'bare', function: 'no_purpose' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a step naming a function that does not exist', async () => {
    const res = await defineWorkflow({
      name: 'missing',
      purposes: [SUPPORT],
      steps: [{ name: 'ghost', function: 'nonexistent' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a workflow purpose the project never registered', async () => {
    const res = await defineWorkflow({
      name: 'unregistered',
      purposes: ['not_a_purpose'],
      steps: [{ name: 'one', function: 'extract' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to start under a purpose the workflow did not declare', async () => {
    expect((await start('etl', ANALYTICS, {})).statusCode).toBe(403);
  });

  it('refuses to start a purpose-bearing workflow with no purpose', async () => {
    expect((await start('etl', undefined, {})).statusCode).toBe(400);
  });
});

describe('definitions and scoping', () => {
  it('refuses a duplicate workflow name', async () => {
    await defineWorkflow({
      name: 'dupe',
      purposes: [SUPPORT],
      steps: [{ name: 'one', function: 'extract' }],
    });
    const again = await defineWorkflow({
      name: 'dupe',
      purposes: [SUPPORT],
      steps: [{ name: 'one', function: 'extract' }],
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses duplicate step names', async () => {
    const res = await defineWorkflow({
      name: 'twins',
      purposes: [SUPPORT],
      steps: [
        { name: 'same', function: 'extract' },
        { name: 'same', function: 'transform' },
      ],
    });
    expect(res.statusCode).toBe(400);
  });

  it('shows a project nothing but its own workflows', async () => {
    const other = await provisionProject('wfother');
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/workflows',
        headers: headers(undefined, other),
      });
      expect(res.json().workflows).toEqual([]);
    } finally {
      await dropProject(other);
    }
  });

  it('will not let one project advance another project execution', async () => {
    const execution = (await start('etl', SUPPORT, {})).json();
    const other = await provisionProject('wfthief');
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/workflows/executions/${execution.id}/advance`,
        headers: headers(SUPPORT, other),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await dropProject(other);
    }
  });

  it('refuses an unsigned request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/workflows' });
    expect(res.statusCode).toBe(401);
  });
});
