import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * Storage writes object metadata, so it connects as setu_control.
 *
 * Migration 003 grants that role INSERT/UPDATE/DELETE on storage_objects and
 * nothing else new — in particular not on consent_artifacts. A compromised
 * storage service therefore cannot make an object readable by agreeing on the
 * subject's behalf. setu_control inherits setu_runtime, so the same pool reads,
 * and NOBYPASSRLS means the policy applies to both.
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
