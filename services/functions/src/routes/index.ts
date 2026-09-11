import { randomUUID } from 'node:crypto';
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

/**
 * M6 — Functions routes.
 *
 * The enforcement that matters here is narrow and load-bearing: a function may
 * only be invoked under a purpose it declared, and the purposes it declares must
 * exist in the project's registry. Without that, server-side code becomes a way
 * to launder a read the purpose system would otherwise refuse — the tenant
 * writes a function, invokes it under whatever purpose suits, and the database
 * faithfully evaluates consent for a claim nobody checked.
 */

const FunctionName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'must be lower-kebab or snake case, starting with a letter');

const PurposeName = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/);

const MAX_SOURCE_BYTES = 128 * 1024;

const DefineFunction = z.object({
  name: FunctionName,
  source: z.string().min(1).max(MAX_SOURCE_BYTES),
  entrypoint: z.string().max(200).default('index.js'),
  /** Purposes this function may be invoked under. Empty means none, and is the default. */
  purposes: z.array(PurposeName).max(20).default([]),
  timeoutS: z.number().int().min(1).max(300).default(30),
  memoryMb: z.number().int().min(32).max(1024).default(128),
});

const Invoke = z.object({
  input: z.unknown().optional(),
});

interface FunctionRow {
  id: string;
  name: string;
  runtime: string;
  entrypoint: string;
  purposes: string[];
  source: string | null;
  timeout_s: number;
  memory_mb: number;
  created_at: Date;
}

interface ExecutionRow {
  id: string;
  function_id: string;
  status: string;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

const DEFINITION_COLUMNS = `id, name, runtime, entrypoint, purposes, source,
                            timeout_s, memory_mb, created_at`;
const EXECUTION_COLUMNS = `id, function_id, status, stdout, stderr, exit_code,
                           duration_ms, started_at, completed_at, created_at`;

/** Source is deliberately omitted: a listing should not ship everyone's code. */
const present = (row: FunctionRow) => ({
  id: row.id,
  name: row.name,
  runtime: row.runtime,
  entrypoint: row.entrypoint,
  purposes: row.purposes,
  timeoutS: row.timeout_s,
  memoryMb: row.memory_mb,
  createdAt: row.created_at,
});

const presentExecution = (row: ExecutionRow) => ({
  id: row.id,
  functionId: row.function_id,
  status: row.status,
  stdout: row.stdout,
  stderr: row.stderr,
  exitCode: row.exit_code,
  durationMs: row.duration_ms,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
});

/**
 * Resolve declared purpose names to ids, failing if any is unregistered.
 *
 * The same check the Data service applies to field grants: a purpose that is not
 * in the registry matches no consent artifact, so accepting one here would
 * declare a function runnable under a purpose that can never be satisfied.
 */
async function assertPurposesRegistered(
  client: pg.Pool | pg.PoolClient,
  projectId: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;

  const res = await client.query<{ name: string }>(
    `SELECT name FROM purposes WHERE project_id = $1 AND name = ANY($2::text[])`,
    [projectId, names],
  );
  const known = new Set(res.rows.map((r) => r.name));
  const missing = names.filter((n) => !known.has(n));

  if (missing.length) {
    throw new ValidationError('Unregistered purpose', { purposes: missing });
  }
}

const routes: FastifyPluginAsync = async (app) => {
  /** Define a function. Declaring its purposes is the whole point of this call. */
  app.post('/functions', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(DefineFunction, request.body, 'function');

    const unique = new Set(body.purposes);
    if (unique.size !== body.purposes.length) {
      throw new ValidationError('Duplicate purpose', { purposes: body.purposes });
    }
    await assertPurposesRegistered(app.pools.control, ctx.projectId, body.purposes);

    const res = await app.pools.control
      .query<FunctionRow>(
        `INSERT INTO function_definitions
           (project_id, name, source, entrypoint, purposes, timeout_s, memory_mb)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7)
         RETURNING ${DEFINITION_COLUMNS}`,
        [
          ctx.projectId,
          body.name,
          body.source,
          body.entrypoint,
          body.purposes,
          body.timeoutS,
          body.memoryMb,
        ],
      )
      .catch((err: { code?: string }) => {
        // unique_violation on (project_id, name).
        if (err.code === '23505') {
          throw new ConflictError(`Function '${body.name}' already exists`);
        }
        throw err;
      });

    return reply.status(201).send(present(res.rows[0]));
  });

  app.get('/functions', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const res = await app.pools.control.query<FunctionRow>(
      `SELECT ${DEFINITION_COLUMNS} FROM function_definitions
        WHERE project_id = $1 ORDER BY name`,
      [ctx.projectId],
    );
    return { functions: res.rows.map(present) };
  });

  app.get<{ Params: { name: string } }>('/functions/:name', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    return present(await load(ctx, request.params.name));
  });

  app.delete<{ Params: { name: string } }>('/functions/:name', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const res = await app.pools.control.query(
      `DELETE FROM function_definitions WHERE project_id = $1 AND name = $2`,
      [ctx.projectId, request.params.name],
    );
    if (!res.rowCount) throw new NotFoundError('Function', request.params.name);
    return reply.status(204).send();
  });

  /**
   * Invoke a function.
   *
   * The purpose comes from the signed context — the caller's claim, already
   * verified as having been issued by the gateway — and is then checked against
   * what the function declared. A mismatch is a 403 and no code runs: the
   * function does not get the chance to decide for itself.
   */
  app.post<{ Params: { name: string } }>('/functions/:name/invoke', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(Invoke, request.body ?? {}, 'invocation');
    const fn = await load(ctx, request.params.name);

    assertPurposeAllowed(fn, ctx.purpose);

    if (!fn.source) {
      throw new ValidationError('Function has no source to run', { function: fn.name });
    }

    const purposeId = ctx.purpose
      ? await resolvePurposeId(ctx.projectId, ctx.purpose)
      : null;

    const execution = await app.pools.control.query<ExecutionRow>(
      `INSERT INTO function_executions
         (function_id, project_id, purpose_id, principal_id, status, started_at)
       VALUES ($1, $2, $3, $4, 'running', now())
       RETURNING ${EXECUTION_COLUMNS}`,
      [fn.id, ctx.projectId, purposeId, ctx.principalId ?? null],
    );
    const executionId = execution.rows[0].id;

    const result = await app.runtime.invoke({
      source: fn.source,
      input: body.input ?? null,
      timeoutMs: fn.timeout_s * 1000,
      memoryMb: fn.memory_mb,
      // Facts only. No credentials, and in particular no signing secret.
      context: {
        requestId: ctx.requestId ?? randomUUID(),
        projectId: ctx.projectId,
        purpose: ctx.purpose,
        principalId: ctx.principalId,
      },
    });

    const finished = await app.pools.control.query<ExecutionRow>(
      `UPDATE function_executions
          SET status = $2, stdout = $3, stderr = $4, exit_code = $5,
              duration_ms = $6, completed_at = now()
        WHERE id = $1
        RETURNING ${EXECUTION_COLUMNS}`,
      [
        executionId,
        result.status,
        result.stdout,
        result.stderr,
        result.exitCode,
        result.durationMs,
      ],
    );

    // 200 even for a failed function: the invocation itself succeeded, and the
    // execution record carries the verdict. A 500 here would conflate "your code
    // threw" with "the platform broke".
    return reply.status(200).send({
      execution: presentExecution(finished.rows[0]),
      output: result.output,
      timedOut: result.timedOut,
    });
  });

  app.get<{ Params: { name: string } }>('/functions/:name/executions', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const fn = await load(ctx, request.params.name);

    const res = await app.pools.control.query<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM function_executions
        WHERE function_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 50`,
      [fn.id, ctx.projectId],
    );
    return { executions: res.rows.map(presentExecution) };
  });

  /**
   * A function may run only as something it declared.
   *
   * Both directions are errors. Invoking with an undeclared purpose is the
   * laundering attempt this check exists for. Invoking a purpose-bearing
   * function with no purpose at all is the same hole from the other side: the
   * function would run, read nothing, and quietly return an empty result that
   * looks like absent data rather than a refused request.
   */
  function assertPurposeAllowed(fn: FunctionRow, purpose: string | undefined): void {
    if (fn.purposes.length === 0) {
      if (purpose) {
        throw new ForbiddenError(`Function '${fn.name}' declares no purposes and may not bind one`);
      }
      return;
    }

    if (!purpose) {
      throw new ValidationError(`Function '${fn.name}' must be invoked with a purpose`, {
        purposes: fn.purposes,
      });
    }
    if (!fn.purposes.includes(purpose)) {
      throw new ForbiddenError(`Function '${fn.name}' may not be invoked for this purpose`);
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

  async function load(ctx: SignedContext, name: string): Promise<FunctionRow> {
    const res = await app.pools.control.query<FunctionRow>(
      `SELECT ${DEFINITION_COLUMNS} FROM function_definitions
        WHERE project_id = $1 AND name = $2`,
      [ctx.projectId, name],
    );
    if (!res.rowCount) throw new NotFoundError('Function', name);
    return res.rows[0];
  }
};

export default routes;
