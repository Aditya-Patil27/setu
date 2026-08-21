import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * The Consent service is the write path for consent and identity state, so it
 * connects as setu_control.
 *
 * It deliberately holds no owner-role pool: nothing it does requires DDL, and an
 * owner connection would silently ignore row-level security.
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
