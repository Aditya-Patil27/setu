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
 * Which database role a pool connects as.
 *
 * - `runtime` — the read path (Data, Gateway). Cannot bypass RLS and cannot write
 *   consent state, so a compromised read-path service cannot grant itself consent.
 * - `control` — the write path for consent and identity (Consent, Auth).
 * - `owner`   — DDL only. Owns the database and therefore ignores RLS, so it must
 *   never be used to read tenant records. The Data service holds one solely for
 *   generating collection tables, policies and views.
 */
export type DbRole = 'runtime' | 'control' | 'owner';

/**
 * Create a connection pool.
 * Uses transaction-mode pooling — all context-setting MUST use set_config(..., true).
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

const CREDENTIALS: Record<DbRole, { userEnv: string; passEnv: string; fallbackUser: string }> = {
  runtime: {
    userEnv: 'POSTGRES_RUNTIME_USER',
    passEnv: 'POSTGRES_RUNTIME_PASSWORD',
    fallbackUser: 'setu_runtime',
  },
  control: {
    userEnv: 'POSTGRES_CONTROL_USER',
    passEnv: 'POSTGRES_CONTROL_PASSWORD',
    fallbackUser: 'setu_control',
  },
  owner: {
    userEnv: 'POSTGRES_USER',
    passEnv: 'POSTGRES_PASSWORD',
    fallbackUser: 'setu',
  },
};

/**
 * Build a pool for a role from the ambient environment.
 *
 * Services should call this rather than createPool directly, so that connecting
 * as the owner role is always a deliberate, visible choice at the call site.
 */
export function createRolePool(role: DbRole, overrides: Partial<PoolConfig> = {}): pg.Pool {
  const creds = CREDENTIALS[role];
  return createPool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env[creds.userEnv] ?? creds.fallbackUser,
    password: process.env[creds.passEnv] ?? `${creds.fallbackUser}_password`,
    database: process.env.POSTGRES_DB ?? 'setu',
    ...overrides,
  });
}
