import type pg from 'pg';
import { withContext, type DbContext } from '@setu/db';
import { purposeId } from './collections.js';

/**
 * Audit writes for inference.
 *
 * Inference gets its own action rather than reusing 'read', because the
 * question an auditor asks about it is different: not "who looked at this
 * person's record" but "when did a model see it". Collapsing the two would make
 * that question unanswerable from the trail.
 */

export interface InferenceRecord {
  /** Every data subject whose row reached the prompt. One audit row each. */
  principalIds: string[];
  resource: string;
  fields: string[];
}

export const INFER_ACTION = 'infer';

/**
 * Append one entry per principal whose data reached the prompt.
 *
 * Runs in its own transaction after the answer is produced. A retrieval that
 * returned nothing writes nothing — there is no subject to attribute the access
 * to, and a row asserting that someone's data was used when it was not would be
 * worse than silence.
 */
export async function appendAudit(
  pool: pg.Pool,
  ctx: DbContext,
  rec: InferenceRecord,
): Promise<void> {
  if (rec.principalIds.length === 0) return;

  await withContext(pool, ctx, async (client) => {
    const pid = await purposeId(client, ctx.projectId, ctx.purpose);
    if (!pid) return;

    for (const principalId of rec.principalIds) {
      await client.query(`SELECT public.setu_append_audit($1, $2, $3, $4, $5, $6::text[], $7)`, [
        ctx.projectId,
        principalId,
        pid,
        INFER_ACTION,
        rec.resource,
        rec.fields,
        'permitted',
      ]);
    }
  });
}
