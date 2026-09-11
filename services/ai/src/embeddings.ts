import { createHash } from 'node:crypto';
import type pg from 'pg';
import { withContext } from '@setu/db';
import { NotFoundError, ValidationError } from '@setu/shared';
import { loadCollection, purposeId, type AiCollection } from './collections.js';
import type { Completer, Embedder } from './providers.js';

/**
 * Build and search vectors without ever holding data the purpose may not read.
 *
 * Every statement here runs inside withContext, so app.purpose is set and the
 * masking view is projecting for that purpose specifically. The service never
 * reads the base table. There is no code path in this file by which an
 * ungranted value enters the process, which is a stronger claim than filtering
 * one out after the fact — a value that was never selected cannot be leaked by
 * a later bug.
 */

export interface EmbeddingContext {
  projectId: string;
  purpose: string;
  principalId?: string;
}

/** Columns the platform generates. Not part of what a row *says*. */
const SYSTEM_COLUMNS = new Set(['id', 'principal_id', 'created_at', 'updated_at']);

function maskedName(table: string): string {
  return `${table}_masked`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualify(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Render a row as the text that gets embedded.
 *
 * Reads whatever the view returned, which is already masked. A redacted field
 * arrives as '***' and is included as such — dropping it would make the vector
 * for a redacted row identical to one where the field was genuinely empty, and
 * those are different facts.
 */
export function renderRow(row: Record<string, unknown>): string {
  return Object.entries(row)
    .filter(([key]) => !SYSTEM_COLUMNS.has(key))
    .map(([key, value]) => `${key}: ${value === null ? '' : String(value)}`)
    .sort()
    .join('\n');
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

export interface BuildResult {
  collection: string;
  purpose: string;
  model: string;
  embedded: number;
  /** Rows whose content hash already matched, so no vector was recomputed. */
  unchanged: number;
}

/**
 * Build or refresh the vectors for one collection under one purpose.
 *
 * Reads through the masking view, so what gets embedded is what this purpose is
 * permitted to see — and nothing else. Rows this purpose cannot see at all are
 * filtered by row-level security before this code runs, so they are never
 * counted, never embedded, and never revealed by a count.
 */
export async function buildEmbeddings(
  pool: pg.Pool,
  ctx: EmbeddingContext,
  collectionName: string,
  embedder: Embedder,
): Promise<BuildResult> {
  const collection = await loadCollection(pool, ctx.projectId, collectionName);
  if (!collection) throw new NotFoundError('Collection', collectionName);

  return withContext(pool, ctx, async (client) => {
    const pid = await purposeId(client, ctx.projectId, ctx.purpose);
    if (!pid) throw new NotFoundError('Purpose', ctx.purpose);

    const rows = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${qualify(collection.schemaName, maskedName(collection.tableName))}`,
    );

    const existing = await client.query<{ record_id: string; content_hash: string }>(
      `SELECT record_id, content_hash
         FROM record_embeddings
        WHERE collection_id = $1 AND purpose_id = $2 AND model = $3`,
      [collection.id, pid, embedder.model],
    );
    const seen = new Map(existing.rows.map((r) => [r.record_id, r.content_hash]));

    const stale: Array<{ id: string; principalId: string; text: string; hash: string }> = [];
    let unchanged = 0;

    for (const row of rows.rows) {
      const text = renderRow(row);
      const hash = hashContent(text);

      if (seen.get(row.id as string) === hash) {
        unchanged += 1;
        continue;
      }
      stale.push({
        id: row.id as string,
        principalId: row.principal_id as string,
        text,
        hash,
      });
    }

    if (stale.length > 0) {
      const vectors = await embedder.embed(stale.map((s) => s.text));
      if (vectors.length !== stale.length) {
        throw new Error(`Embedder returned ${vectors.length} vectors for ${stale.length} rows`);
      }

      for (const [i, item] of stale.entries()) {
        await client.query(
          `INSERT INTO record_embeddings
             (project_id, collection_id, record_id, principal_id, purpose_id,
              embedding, content_hash, model)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
           ON CONFLICT (record_id, purpose_id, model)
           DO UPDATE SET embedding = EXCLUDED.embedding,
                         content_hash = EXCLUDED.content_hash,
                         created_at = now()`,
          [
            ctx.projectId,
            collection.id,
            item.id,
            item.principalId,
            pid,
            toVectorLiteral(vectors[i]),
            item.hash,
            embedder.model,
          ],
        );
      }
    }

    return {
      collection: collection.name,
      purpose: ctx.purpose,
      model: embedder.model,
      embedded: stale.length,
      unchanged,
    };
  });
}

export interface RetrievedRow {
  id: string;
  distance: number;
  /** The row as this purpose may see it. Masked fields are present and redacted. */
  fields: Record<string, unknown>;
}

const MAX_TOP_K = 20;

/**
 * Nearest neighbours, joined back to the masking view.
 *
 * Both halves are gated. The vector table's own policy requires an active
 * consent artifact for this exact purpose, and the join to the masked view
 * re-applies row-level security to the row itself — so a vector that outlived
 * its row, or a row whose consent was revoked between the two, yields nothing.
 */
export async function retrieve(
  pool: pg.Pool,
  ctx: EmbeddingContext,
  collectionName: string,
  query: string,
  embedder: Embedder,
  topK = 5,
): Promise<RetrievedRow[]> {
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new ValidationError(`topK must be an integer between 1 and ${MAX_TOP_K}`, { topK });
  }

  const collection = await loadCollection(pool, ctx.projectId, collectionName);
  if (!collection) throw new NotFoundError('Collection', collectionName);

  const [queryVector] = await embedder.embed([query]);

  return withContext(pool, ctx, async (client) => {
    const pid = await purposeId(client, ctx.projectId, ctx.purpose);
    if (!pid) throw new NotFoundError('Purpose', ctx.purpose);

    const view = qualify(collection.schemaName, maskedName(collection.tableName));

    const res = await client.query<{ id: string; distance: string } & Record<string, unknown>>(
      // v.* supplies id and the masked columns; the distance is the only thing
      // the vector table contributes to the projection.
      `SELECT (e.embedding <=> $1::vector) AS distance, v.*
         FROM record_embeddings e
         JOIN ${view} v ON v.id = e.record_id
        WHERE e.collection_id = $2
          AND e.purpose_id    = $3
          AND e.model         = $4
        ORDER BY e.embedding <=> $1::vector
        LIMIT $5`,
      [toVectorLiteral(queryVector), collection.id, pid, embedder.model, topK],
    );

    return res.rows.map((row) => {
      const { distance, ...rest } = row;
      return {
        id: row.id,
        distance: Number(distance),
        fields: rest as Record<string, unknown>,
      };
    });
  });
}

export interface AskResult {
  answer: string;
  /** Exactly what reached the prompt. The receipt for the answer. */
  context: RetrievedRow[];
  /** Field names present in the prompt, for the audit record. */
  fields: string[];
  model: string;
}

/**
 * Answer a question from retrieved context.
 *
 * The prompt is assembled from `retrieve` and nothing else, so the model is
 * physically unable to cite a value this purpose was not granted — not because
 * it was instructed not to, but because the value is not in the process.
 */
export async function ask(
  pool: pg.Pool,
  ctx: EmbeddingContext,
  collectionName: string,
  question: string,
  embedder: Embedder,
  completer: Completer,
  topK = 5,
): Promise<AskResult> {
  const context = await retrieve(pool, ctx, collectionName, question, embedder, topK);

  const rendered = context.map((row, i) => `[${i + 1}] ${renderRow(row.fields)}`).join('\n\n');

  const prompt = [
    `Question: ${question}`,
    '',
    'Context (all you may use; values shown as *** or empty are withheld by policy):',
    rendered || '(no records are visible under this purpose)',
  ].join('\n');

  const answer = await completer.complete(prompt);

  const fields = [
    ...new Set(
      context.flatMap((row) => Object.keys(row.fields).filter((k) => !SYSTEM_COLUMNS.has(k))),
    ),
  ].sort();

  return { answer, context, fields, model: completer.model };
}

export type { AiCollection };
