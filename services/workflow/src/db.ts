import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * Workflow writes definitions, executions and step state, so it connects as
 * setu_control.
 *
 * Migration 006 grants INSERT and UPDATE on the execution tables but no DELETE
 * on step rows: a step's history is the evidence that it ran at most once, and a
 * worker able to delete it could run the step again and leave no trace.
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
