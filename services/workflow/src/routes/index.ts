import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  contextFromHeaders,
  parseInput,
  type SignedContext,
} from '@setu/shared';
import {
  claimStep,
  completeStep,
  failStep,
  nextStepIndex,
  parseSteps,
  stepAt,
  type StepSpec,
} from '../engine.js';

/**
 * M9 — Workflow routes.
 *
 * A workflow is a sequence of function invocations with durable state between
 * them. Two properties carry the weight:
 *
 *   - A step may only run under a purpose its function declared. Checked when the
 *     workflow is defined, so a chain cannot escalate past the declarations of
 *     the functions it is built from.
 *   - A step runs at most once while its lease holds, enforced by a unique
 *     constraint rather than by this file being careful.
 */

const Name = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'must be lower-kebab or snake case, starting with a letter');

const PurposeName = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);

const Step = z.object({
  name: Name,
  function: Name,
  /** 1 means "do not retry", and is the default. */
  maxAttempts: z.number().int().min(1).max(10).default(1),
});

const DefineWorkflow = z.object({
  name: Name,
  steps: z.array(Step).min(1).max(50),
  purposes: z.array(PurposeName).max(20).default([]),
});

const StartExecution = z.object({
  input: z.unknown().optional(),
});

interface WorkflowRow {
  id: string;
  name: string;
  dag: unknown;
  purposes: string[];
  created_at: Date;
}

interface ExecutionRow {
  id: string;
  workflow_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  input: unknown;
  output: unknown;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
}

const WORKFLOW_COLUMNS = `id, name, dag, purposes, created_at`;
const EXECUTION_COLUMNS = `id, workflow_id, status, input, output, error, started_at, completed_at`;

const present = (row: WorkflowRow) => ({
  id: row.id,
  name: row.name,
  steps: parseSteps(row.dag),
  purposes: row.purposes,
  createdAt: row.created_at,
});

const presentExecution = (row: ExecutionRow) => ({
  id: row.id,
  workflowId: row.workflow_id,
  status: row.status,
  input: row.input,
  output: row.output,
  error: row.error,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Define a workflow.
   *
   * Every step's function must exist and must declare every purpose the workflow
   * declares. Checking here rather than at invocation means a workflow that
   * could escalate cannot be written down in the first place, and the tenant
   * finds out while they are editing it.
   */
  app.post('/workflows', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(DefineWorkflow, request.body, 'workflow');

    const names = body.steps.map((s) => s.name);
    if (new Set(names).size !== names.length) {
      throw new ValidationError('Duplicate step name', { steps: names });
    }

    await assertPurposesRegistered(ctx.projectId, body.purposes);
    await assertStepsRunnable(ctx.projectId, body.steps, body.purposes);

    const res = await app.pools.control
      .query<WorkflowRow>(
        `INSERT INTO workflow_definitions (project_id, name, dag, purposes)
         VALUES ($1, $2, $3::jsonb, $4::text[])
         RETURNING ${WORKFLOW_COLUMNS}`,
        [ctx.projectId, body.name, JSON.stringify(body.steps), body.purposes],
      )
      .catch((err: { code?: string }) => {
        if (err.code === '23505') {
          throw new ConflictError(`Workflow '${body.name}' already exists`);
        }
        throw err;
      });

    return reply.status(201).send(present(res.rows[0]));
  });

  app.get('/workflows', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const res = await app.pools.control.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM workflow_definitions WHERE project_id = $1 ORDER BY name`,
      [ctx.projectId],
    );
    return { workflows: res.rows.map(present) };
  });

  app.get<{ Params: { name: string } }>('/workflows/:name', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    return present(await loadWorkflow(ctx, request.params.name));
  });

  /** Create an execution. Nothing runs yet — advancing is a separate, resumable act. */
  app.post<{ Params: { name: string } }>('/workflows/:name/start', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(StartExecution, request.body ?? {}, 'execution');
    const workflow = await loadWorkflow(ctx, request.params.name);

    assertPurposeAllowed(workflow, ctx.purpose);
    const purposeId = ctx.purpose ? await resolvePurposeId(ctx.projectId, ctx.purpose) : null;

    const res = await app.pools.control.query<ExecutionRow>(
      `INSERT INTO workflow_executions
         (workflow_id, project_id, purpose_id, principal_id, status, input)
       VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)
       RETURNING ${EXECUTION_COLUMNS}`,
      [
        workflow.id,
        ctx.projectId,
        purposeId,
        ctx.principalId ?? null,
        JSON.stringify(body.input ?? null),
      ],
    );

    return reply.status(201).send(presentExecution(res.rows[0]));
  });

  /**
   * Advance one step.
   *
   * Idempotent in the way that matters: calling it on an execution whose next
   * step is already held, or which has already finished, changes nothing and
   * says so. A crashed worker is recovered by the lease inside claimStep, so
   * calling this repeatedly is the whole recovery mechanism — there is no
   * separate repair path to get wrong.
   */
  app.post<{ Params: { id: string } }>('/workflows/executions/:id/advance', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    return advance(ctx, request.params.id);
  });

  /**
   * Advance until the execution settles or a step is busy.
   *
   * A convenience over advance, bounded by the step count so a caller cannot be
   * held indefinitely. It is not a scheduler: nothing here runs in the
   * background, and an execution left mid-flight is resumed by the next call
   * rather than by a timer this service owns.
   */
  app.post<{ Params: { id: string } }>('/workflows/executions/:id/run', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);

    let last = await advance(ctx, request.params.id);
    for (let guard = 0; guard < 100 && last.advanced; guard += 1) {
      if (last.status === 'succeeded' || last.status === 'failed') break;
      last = await advance(ctx, request.params.id);
    }
    return last;
  });

  app.get<{ Params: { id: string } }>('/workflows/executions/:id', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const execution = await loadExecution(ctx, request.params.id);

    const steps = await app.pools.control.query(
      `SELECT step_index, step_name, function_name, status, attempts, output, error,
              started_at, completed_at
         FROM workflow_step_executions
        WHERE execution_id = $1
        ORDER BY step_index`,
      [execution.id],
    );

    return {
      execution: presentExecution(execution),
      steps: steps.rows.map((row) => ({
        index: row.step_index,
        name: row.step_name,
        function: row.function_name,
        status: row.status,
        attempts: row.attempts,
        output: row.output,
        error: row.error,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      })),
    };
  });

  // ── internals ───────────────────────────────────────────

  interface AdvanceResult {
    executionId: string;
    status: ExecutionRow['status'];
    advanced: boolean;
    step?: { index: number; name: string; status: string; attempts: number };
    reason?: string;
  }

  async function advance(ctx: SignedContext, executionId: string): Promise<AdvanceResult> {
    const execution = await loadExecution(ctx, executionId);

    if (execution.status === 'succeeded' || execution.status === 'failed') {
      return { executionId, status: execution.status, advanced: false, reason: 'already settled' };
    }

    const workflow = await loadWorkflowById(execution.workflow_id);
    const specs = parseSteps(workflow.dag);
    const purpose = await purposeNameFor(executionId);

    const index = await nextStepIndex(app.pools.control, executionId);

    // Every step has succeeded: the execution is done, carrying the last output.
    if (index >= specs.length) {
      const last = specs.length ? await stepAt(app.pools.control, executionId, specs.length - 1) : undefined;
      const settled = await settle(executionId, 'succeeded', last?.output ?? null, null);
      return { executionId, status: settled, advanced: false, reason: 'complete' };
    }

    const existing = await stepAt(app.pools.control, executionId, index);
    if (existing?.status === 'failed') {
      const settled = await settle(executionId, 'failed', null, existing.error);
      return { executionId, status: settled, advanced: false, reason: 'step failed' };
    }

    const spec = specs[index];
    const client = await app.pools.control.connect();
    let claimed;
    try {
      await client.query('BEGIN');
      claimed = await claimStep(client, executionId, index, spec, app.leaseSeconds);
      if (claimed) {
        await client.query(
          `UPDATE workflow_executions SET status = 'running' WHERE id = $1 AND status = 'pending'`,
          [executionId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (!claimed) {
      return {
        executionId,
        status: execution.status,
        advanced: false,
        reason: 'step is already being worked on',
      };
    }

    // Outside any transaction, deliberately: tenant code must not hold a
    // connection for the length of its own timeout.
    const input = index === 0 ? execution.input : (await stepAt(app.pools.control, executionId, index - 1))?.output ?? null;

    const result = await app.invoker.invoke(spec.function, input, {
      requestId: ctx.requestId,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      principalId: ctx.principalId,
      purpose: purpose ?? undefined,
    });

    const completion = await app.pools.control.connect();
    try {
      await completion.query('BEGIN');

      if (result.status === 'succeeded') {
        await completeStep(completion, claimed.id, result.output);
        await completion.query('COMMIT');

        const done = index === specs.length - 1;
        const status = done ? await settle(executionId, 'succeeded', result.output, null) : 'running';
        return {
          executionId,
          status,
          advanced: true,
          step: { index, name: spec.name, status: 'succeeded', attempts: claimed.attempts },
        };
      }

      const retryable = await failStep(completion, claimed, spec, result.error ?? 'step failed');
      await completion.query('COMMIT');

      const status = retryable
        ? execution.status
        : await settle(executionId, 'failed', null, result.error ?? 'step failed');

      return {
        executionId,
        status,
        advanced: true,
        step: {
          index,
          name: spec.name,
          status: retryable ? 'pending' : 'failed',
          attempts: claimed.attempts,
        },
        reason: retryable ? 'step failed and will be retried' : 'step failed',
      };
    } catch (err) {
      await completion.query('ROLLBACK');
      throw err;
    } finally {
      completion.release();
    }
  }

  async function settle(
    executionId: string,
    status: 'succeeded' | 'failed',
    output: unknown,
    error: string | null,
  ): Promise<ExecutionRow['status']> {
    const res = await app.pools.control.query<{ status: ExecutionRow['status'] }>(
      `UPDATE workflow_executions
          SET status = $2, output = $3::jsonb, error = $4, completed_at = now()
        WHERE id = $1 AND status IN ('pending', 'running')
        RETURNING status`,
      [executionId, status, JSON.stringify(output ?? null), error],
    );
    // Already settled by a concurrent advance: its verdict stands.
    return res.rows[0]?.status ?? status;
  }

  async function purposeNameFor(executionId: string): Promise<string | null> {
    const res = await app.pools.control.query<{ name: string | null }>(
      `SELECT p.name FROM workflow_executions e
         LEFT JOIN purposes p ON p.id = e.purpose_id
        WHERE e.id = $1`,
      [executionId],
    );
    return res.rows[0]?.name ?? null;
  }

  function assertPurposeAllowed(workflow: WorkflowRow, purpose: string | undefined): void {
    if (workflow.purposes.length === 0) {
      if (purpose) {
        throw new ForbiddenError(
          `Workflow '${workflow.name}' declares no purposes and may not bind one`,
        );
      }
      return;
    }
    if (!purpose) {
      throw new ValidationError(`Workflow '${workflow.name}' must be started with a purpose`, {
        purposes: workflow.purposes,
      });
    }
    if (!workflow.purposes.includes(purpose)) {
      throw new ForbiddenError(`Workflow '${workflow.name}' may not run for this purpose`);
    }
  }

  async function assertPurposesRegistered(projectId: string, names: string[]): Promise<void> {
    if (!names.length) return;
    const res = await app.pools.control.query<{ name: string }>(
      `SELECT name FROM purposes WHERE project_id = $1 AND name = ANY($2::text[])`,
      [projectId, names],
    );
    const known = new Set(res.rows.map((r) => r.name));
    const missing = names.filter((n) => !known.has(n));
    if (missing.length) throw new ValidationError('Unregistered purpose', { purposes: missing });
  }

  /**
   * Every step's function must exist and must declare every purpose the workflow
   * does. The second half is what stops a chain reaching a function that never
   * agreed to run for this purpose.
   */
  async function assertStepsRunnable(
    projectId: string,
    steps: StepSpec[],
    purposes: string[],
  ): Promise<void> {
    const wanted = [...new Set(steps.map((s) => s.function))];
    const res = await app.pools.control.query<{ name: string; purposes: string[] }>(
      `SELECT name, purposes FROM function_definitions
        WHERE project_id = $1 AND name = ANY($2::text[])`,
      [projectId, wanted],
    );

    const found = new Map(res.rows.map((r) => [r.name, r.purposes]));
    const missing = wanted.filter((n) => !found.has(n));
    if (missing.length) throw new ValidationError('Unknown function', { functions: missing });

    for (const step of steps) {
      const declared = found.get(step.function) ?? [];
      const ungranted = purposes.filter((p) => !declared.includes(p));
      if (ungranted.length) {
        throw new ValidationError(
          `Function '${step.function}' does not declare every purpose this workflow runs under`,
          { step: step.name, function: step.function, purposes: ungranted },
        );
      }
    }
  }

  async function resolvePurposeId(projectId: string, purpose: string): Promise<string> {
    const res = await app.pools.control.query<{ id: string }>(
      `SELECT id FROM purposes WHERE project_id = $1 AND name = $2`,
      [projectId, purpose],
    );
    if (!res.rowCount) throw new NotFoundError('Purpose', purpose);
    return res.rows[0].id;
  }

  async function loadWorkflow(ctx: SignedContext, name: string): Promise<WorkflowRow> {
    const res = await app.pools.control.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM workflow_definitions WHERE project_id = $1 AND name = $2`,
      [ctx.projectId, name],
    );
    if (!res.rowCount) throw new NotFoundError('Workflow', name);
    return res.rows[0];
  }

  async function loadWorkflowById(id: string): Promise<WorkflowRow> {
    const res = await app.pools.control.query<WorkflowRow>(
      `SELECT ${WORKFLOW_COLUMNS} FROM workflow_definitions WHERE id = $1`,
      [id],
    );
    if (!res.rowCount) throw new NotFoundError('Workflow', id);
    return res.rows[0];
  }

  async function loadExecution(ctx: SignedContext, id: string): Promise<ExecutionRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError('Invalid execution id', { id });

    const res = await app.pools.control.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM workflow_executions WHERE id = $1 AND project_id = $2`,
      [id, ctx.projectId],
    );
    if (!res.rowCount) throw new NotFoundError('Execution', id);
    return res.rows[0];
  }
};

export default routes;
