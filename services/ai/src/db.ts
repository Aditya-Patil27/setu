import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * The AI service is on the read path, so it connects as setu_runtime.
 *
 * Migration 007 grants that role DML on record_embeddings and puts the same
 * consent policy on it that governs collection tables. The grant is not what
 * constrains it — row-level security is — which is exactly why this service
 * must never hold an owner pool.
 */
export interface Pools {
  runtime: pg.Pool;
}

export function createPools(): Pools {
  return { runtime: createRolePool('runtime') };
}

export async function closePools(pools: Pools): Promise<void> {
  await pools.runtime.end();
}
