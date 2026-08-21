import pg from 'pg';

export interface PoolConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max?: number;
}

/**
 * Create a connection pool.
 * Uses transaction-mode pooling — all purpose-setting MUST use SET LOCAL.
 */
export function createPool(config: PoolConfig): pg.Pool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.max ?? 20,
  });
}
