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
    await client.query('SELECT set_config($1, $2, true)', ['app.project_id', ctx.projectId]);
    await client.query('SELECT set_config($1, $2, true)', ['app.purpose', ctx.purpose]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.principal_id',
      ctx.principalId ?? '',
    ]);

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
