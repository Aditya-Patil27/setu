import type pg from 'pg';

/**
 * The durable core.
 *
 * An execution advances one step per call, and each call is two short
 * transactions with the step's actual work happening between them — never inside
 * one. Holding a transaction open across a function invocation would pin a
 * connection for the length of tenant code and turn a slow step into an outage.
 *
 * What that buys, and what it costs, stated plainly:
 *
 *   - A step runs at most once while its lease holds. The claim is an upsert
 *     against UNIQUE (execution_id, step_index), so two workers racing both
 *     attempt the same pair and the database lets exactly one win.
 *   - A worker that dies mid-step leaves the row `running`. Without a lease that
 *     execution would wedge forever, so the claim also reclaims a step whose
 *     lease has expired. That makes a crashed step at-least-once: if it died
 *     after causing an external effect, the retry repeats that effect. Steps are
 *     therefore expected to be idempotent, and the lease is set comfortably
 *     longer than a step's own timeout so a live worker is never overtaken.
 */

export interface StepSpec {
  name: string;
  function: string;
  maxAttempts: number;
}

export interface StepRow {
  id: string;
  step_index: number;
  step_name: string;
  function_name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  output: unknown;
  error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

/** Generous by design: longer than any step's own timeout ceiling (300s). */
export const DEFAULT_LEASE_SECONDS = 600;

/**
 * The index of the next step to run: one past the last that succeeded.
 *
 * Steps are sequential, so a step awaiting retry is always at exactly this index
 * too — there is no earlier gap to go back and fill.
 */
export async function nextStepIndex(
  client: pg.PoolClient | pg.Pool,
  executionId: string,
): Promise<number> {
  const res = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(step_index) + 1, 0) AS next
       FROM workflow_step_executions
      WHERE execution_id = $1 AND status = 'succeeded'`,
    [executionId],
  );
  return Number(res.rows[0].next);
}

export async function stepAt(
  client: pg.PoolClient | pg.Pool,
  executionId: string,
  index: number,
): Promise<StepRow | undefined> {
  const res = await client.query<StepRow>(
    `SELECT id, step_index, step_name, function_name, status, attempts, output, error,
            started_at, completed_at
       FROM workflow_step_executions
      WHERE execution_id = $1 AND step_index = $2`,
    [executionId, index],
  );
  return res.rows[0];
}

/**
 * Take ownership of one step, or return undefined having taken nothing.
 *
 * A single statement does both the first claim and a retry claim. The conflict
 * target is the uniqueness that makes the step singular; the WHERE on DO UPDATE
 * is what refuses to steal a step that is already succeeded, already terminally
 * failed, or currently held by a live worker.
 */
export async function claimStep(
  client: pg.PoolClient,
  executionId: string,
  index: number,
  spec: StepSpec,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<StepRow | undefined> {
  const res = await client.query<StepRow>(
    `INSERT INTO workflow_step_executions
       (execution_id, step_index, step_name, function_name, status, attempts, started_at)
     VALUES ($1, $2, $3, $4, 'running', 1, now())
     ON CONFLICT (execution_id, step_index) DO UPDATE
        SET status     = 'running',
            attempts   = workflow_step_executions.attempts + 1,
            started_at = now(),
            error      = NULL
      WHERE workflow_step_executions.status = 'pending'
         OR (workflow_step_executions.status = 'running'
             AND workflow_step_executions.started_at
                 < now() - make_interval(secs => $5))
     RETURNING id, step_index, step_name, function_name, status, attempts, output, error,
               started_at, completed_at`,
    [executionId, index, spec.name, spec.function, leaseSeconds],
  );
  return res.rows[0];
}

/** Record a step's success. Terminal: nothing re-runs a succeeded step. */
export async function completeStep(
  client: pg.PoolClient,
  stepId: string,
  output: unknown,
): Promise<void> {
  await client.query(
    `UPDATE workflow_step_executions
        SET status = 'succeeded', output = $2::jsonb, error = NULL, completed_at = now()
      WHERE id = $1`,
    [stepId, JSON.stringify(output ?? null)],
  );
}

/**
 * Record a step's failure.
 *
 * Returns whether the step may be tried again. A retryable failure goes back to
 * `pending` rather than staying `running`, so the next advance can claim it
 * without waiting out a lease it does not need to wait for.
 */
export async function failStep(
  client: pg.PoolClient,
  step: StepRow,
  spec: StepSpec,
  error: string,
): Promise<boolean> {
  const retryable = step.attempts < spec.maxAttempts;

  await client.query(
    `UPDATE workflow_step_executions
        SET status = $2, error = $3, completed_at = CASE WHEN $2 = 'failed' THEN now() END
      WHERE id = $1`,
    [step.id, retryable ? 'pending' : 'failed', error],
  );

  return retryable;
}

/** Parse and validate the declared step list out of the definition's JSONB. */
export function parseSteps(dag: unknown): StepSpec[] {
  if (!Array.isArray(dag)) return [];
  return dag.map((raw) => {
    const step = raw as Record<string, unknown>;
    return {
      name: String(step.name),
      function: String(step.function),
      maxAttempts: Number(step.maxAttempts ?? 1),
    };
  });
}
