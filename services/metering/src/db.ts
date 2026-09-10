import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * Metering writes usage observations, so it connects as setu_control.
 *
 * Migration 004 grants that role INSERT on usage_records and deliberately not
 * UPDATE or DELETE: a usage record is an observation, and an observation that
 * can be edited after the fact is not one worth billing against. setu_control
 * inherits setu_runtime, so the same pool serves the aggregation reads.
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
