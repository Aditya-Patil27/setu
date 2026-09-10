import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * Auth is the write path for identity, so it connects as setu_control — the only
 * role granted INSERT/UPDATE/DELETE on principals, api_keys, otp_challenges and
 * refresh_tokens.
 *
 * It holds no owner pool: nothing it does needs DDL, and an owner connection
 * would silently ignore row-level security.
 */
export interface Pools {
  control: pg.Pool;
}

export function createPools(): Pools {
  return { control: createRolePool('control') };
}

export async function closePools(pools: Pools): Promise<void> {
  await pools.control.end();
}
