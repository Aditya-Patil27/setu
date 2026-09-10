import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * Audit reads and never writes.
 *
 * Records are appended by setu_append_audit inside the transaction of whichever
 * service performed the access, so that an access and its audit row commit
 * together or not at all. This service only reads them back, so setu_runtime —
 * which holds SELECT and nothing else — is the whole of what it needs. A
 * compromised audit service therefore cannot rewrite history.
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
