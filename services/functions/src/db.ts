import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * Functions writes definitions and execution records, so it connects as
 * setu_control.
 *
 * Migration 005 grants it writes on function_definitions and function_executions
 * and nothing else — not on consent_artifacts, and not on purposes. A function
 * therefore cannot widen what it may run as, either by granting itself consent
 * or by inventing a purpose to be invoked under.
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
