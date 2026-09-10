import { createHash } from 'node:crypto';
import type pg from 'pg';

/**
 * Independent verification of the audit hash chain.
 *
 * The digest below is recomputed here in Node rather than in SQL, and that
 * duplication is the point: verifying with the same database function that
 * wrote the row would prove only that the function is self-consistent. An
 * independent implementation catches a tampered row *and* a tampered function.
 * The cost is that this formula and setu_append_audit must agree — if they ever
 * drift, verification fails loudly rather than passing quietly.
 */
export interface ChainRow {
  id: string;
  seq: string;
  project_id: string;
  principal_id: string;
  purpose_id: string;
  action: string;
  resource: string;
  fields: string[];
  outcome: string;
  prev_hash: string;
  hash: string;
}

/** Mirrors setu_append_audit exactly: no separator, no created_at, no seq. */
export function computeHash(row: ChainRow): string {
  return createHash('sha256')
    .update(
      row.prev_hash +
        row.project_id +
        row.principal_id +
        row.purpose_id +
        row.action +
        row.resource +
        row.fields.join(',') +
        row.outcome,
      'utf8',
    )
    .digest('hex');
}

export type BreakReason =
  /** The row's own contents no longer hash to the digest stored beside them. */
  | 'hash-mismatch'
  /** The row's contents are intact, but it no longer follows the row before it. */
  | 'broken-link';

export interface ChainBreak {
  seq: string;
  recordId: string;
  reason: BreakReason;
  expected: string;
  found: string;
}

export interface VerifyResult {
  intact: boolean;
  checked: number;
  /** Every break, not just the first: one tampered row in the middle would
   *  otherwise hide everything after it. */
  breaks: ChainBreak[];
  headHash: string | null;
}

const BATCH = 1000;

/**
 * Walk a project's chain in order, recomputing every digest.
 *
 * Streamed in batches by seq so a long-lived project does not have to fit its
 * entire history in memory to be verified.
 */
export async function verifyChain(pool: pg.Pool, projectId: string): Promise<VerifyResult> {
  const breaks: ChainBreak[] = [];
  let checked = 0;
  let previousHash = '';
  let headHash: string | null = null;
  let after = '0';

  for (;;) {
    const page = await pool.query<ChainRow>(
      `SELECT id, seq, project_id, principal_id, purpose_id, action, resource,
              fields, outcome, prev_hash, hash
         FROM audit_records
        WHERE project_id = $1 AND seq > $2
        ORDER BY seq
        LIMIT ${BATCH}`,
      [projectId, after],
    );
    if (!page.rowCount) break;

    for (const row of page.rows) {
      // Two independent failures. A row whose contents were edited fails the
      // first; a row that was deleted from the middle leaves its successor
      // failing the second.
      if (row.prev_hash !== previousHash) {
        breaks.push({
          seq: row.seq,
          recordId: row.id,
          reason: 'broken-link',
          expected: previousHash,
          found: row.prev_hash,
        });
      }

      const recomputed = computeHash(row);
      if (recomputed !== row.hash) {
        breaks.push({
          seq: row.seq,
          recordId: row.id,
          reason: 'hash-mismatch',
          expected: recomputed,
          found: row.hash,
        });
      }

      // Continue from what the row claims, so one break does not cascade into a
      // false report against every row after it.
      previousHash = row.hash;
      headHash = row.hash;
      checked += 1;
      after = row.seq;
    }

    if (page.rowCount < BATCH) break;
  }

  return { intact: breaks.length === 0, checked, breaks, headHash };
}
