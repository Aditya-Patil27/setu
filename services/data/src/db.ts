import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * The Data service is the only service that holds two roles.
 *
 * - `runtime` — every record read and write. NOBYPASSRLS, so Postgres, not this
 *   process, decides what any request may see.
 * - `owner`   — DDL generation only. It owns the database and would ignore RLS,
 *   so it must never touch tenant records; its use is confined to the ddl module.
 *
 * Keeping them as separate named fields makes misuse visible at the call site:
 * a record route that reached for `pools.owner` would be a review-blocking bug.
 */
export interface Pools {
  runtime: pg.Pool;
  owner: pg.Pool;
}

export function createPools(): Pools {
  return {
    runtime: createRolePool('runtime'),
    owner: createRolePool('owner'),
  };
}

export async function closePools(pools: Pools): Promise<void> {
  await Promise.all([pools.runtime.end(), pools.owner.end()]);
}
