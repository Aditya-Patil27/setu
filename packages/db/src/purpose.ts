import type pg from 'pg';

/**
 * Execute a callback within a transaction that has `app.purpose` set.
 *
 * ⚠️  CRITICAL: Uses SET LOCAL, which is transaction-scoped.
 * Never use plain SET — it persists on pooled connections and would
 * leak purpose context to the next tenant's query.
 *
 * This is the core enforcement mechanism of the platform.
 */
export async function withPurpose<T>(
  pool: pg.Pool,
  purpose: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL is transaction-scoped — safe with connection pooling
    await client.query('SET LOCAL app.purpose = $1', [purpose]);
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
