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
 * How many server connections one pool may hold.
 *
 * This was 20, which does not survive contact with the whole platform: ten
 * services open roughly fourteen pools between them, and 14 x 20 is 280 server
 * connections against a PostgreSQL default max_connections of 100. Starting the
 * stack exhausted the server, and the failure surfaced somewhere unrelated —
 * a test suite failing to connect while the service that took the connections
 * looked healthy.
 *
 * Eight is chosen to fit: fourteen pools at eight is 112, comfortably inside the
 * 200 that docker-compose now configures, with room for psql and the migration
 * runner. A single service handling real traffic wants more than eight, and the
 * answer to that is PgBouncer in front rather than a larger number here —
 * multiplexing many short transactions onto few server connections is what a
 * pooler is for, and every query in this codebase is transaction-scoped.
 */
const DEFAULT_POOL_MAX = 8;

function poolMax(explicit?: number): number {
  if (explicit !== undefined) return explicit;

  const configured = Number(process.env.POSTGRES_POOL_MAX);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POOL_MAX;
}

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
    max: poolMax(config.max),
    /**
     * Return an idle connection to the server rather than holding it forever.
     *
     * Without this a service that saw one burst of traffic keeps its whole pool
     * open for the life of the process, so the connection budget is consumed by
     * peak usage that may never recur.
     */
    idleTimeoutMillis: Number(process.env.POSTGRES_POOL_IDLE_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS ?? 10_000),
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
