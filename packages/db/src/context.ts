import type pg from 'pg';

/**
 * The request context Postgres evaluates policy against.
 *
 * These three values are what the generated RLS policies and masking views read.
 * Nothing else about the caller reaches the database.
 */
export interface DbContext {
  /** Scopes the purpose lookup — purpose names are unique per project, not globally. */
  projectId: string;
  /** The declared purpose of this access, e.g. 'billing'. */
  purpose: string;
  /** The acting principal, used for audit attribution. */
  principalId?: string;
}

/**
 * Execute a callback inside a transaction carrying the request context.
 *
 * The context is set with `set_config(..., is_local => true)`, which is
 * transaction-scoped and therefore safe under transaction-mode pooling. Plain
 * `SET` would persist on the pooled connection and leak this tenant's purpose
 * into the next tenant's query.
 *
 * Note `SET LOCAL app.purpose = $1` cannot be used here: Postgres `SET` does not
 * accept bind parameters, so it fails with a syntax error under the extended
 * query protocol. `set_config` is the parameterizable equivalent.
 *
 * This is the core enforcement mechanism of the platform.
 */
export async function withContext<T>(
  pool: pg.Pool,
  ctx: DbContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /**
     * All three settings in one statement.
     *
     * These were three separate queries, and a round trip to Postgres costs
     * about as much as the masked read it is setting up for — measured at
     * ~0.9ms against a local container, against ~11.8ms for a whole point read.
     * Three statements to say three things meant the context cost more than a
     * third of the request before any row was touched.
     *
     * set_config returns the value it set, so evaluating three of them in one
     * SELECT list applies all three. They are independent, so the order the
     * planner evaluates them in does not matter.
     */
    await client.query(
      `SELECT set_config('app.project_id', $1, true),
              set_config('app.purpose', $2, true),
              set_config('app.principal_id', $3, true)`,
      [ctx.projectId, ctx.purpose, ctx.principalId ?? ''],
    );

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a callback in a transaction with no request context.
 *
 * For work that is genuinely not on behalf of a principal — migrations, DDL
 * generation, key issuance. Any query touching a collection table through this
 * helper sees zero rows, because the RLS policy compares against an unset
 * `app.purpose`. That is intentional: it fails closed.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
