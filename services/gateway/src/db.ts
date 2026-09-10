import type pg from 'pg';
import { createRolePool } from '@setu/db';

/**
 * The gateway sits on the read path only.
 *
 * It resolves a credential, confirms the purpose exists in the project's
 * registry, and forwards. It never writes consent or identity state, so it
 * connects as setu_runtime: NOBYPASSRLS, and denied any write to consent. A
 * compromised gateway can forge context for downstream services — that is what
 * the HMAC secret protects — but it cannot manufacture the consent that would
 * make the forged context yield data.
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
