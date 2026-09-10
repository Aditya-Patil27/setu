import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ConsentDeniedError,
  NotFoundError,
  ValidationError,
  contextFromHeaders,
  parseInput,
  type SignedContext,
} from '@setu/shared';
import { withContext, type DbContext } from '@setu/db';
import { newStorageKey } from '../store.js';

/**
 * M5 — Storage routes.
 *
 * Every route binds a purpose and runs inside withContext, so the policy added
 * by migration 003 is what decides which objects exist as far as this service is
 * concerned. An object the caller may not read does not come back as forbidden;
 * it does not come back at all, and the 404 is indistinguishable from one for a
 * key that was never written.
 */

const MAX_BYTES = 10 * 1024 * 1024;

/** Bucket and key are tenant-chosen, so they are constrained rather than trusted. */
const Name = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'may not begin with a separator')
  .refine((v) => !v.includes('..'), { message: 'may not contain ".."' });

const CreateObject = z.object({
  bucket: Name,
  key: Name,
  /** Absent means the object is about nobody — a tenant asset, not personal data. */
  principalId: z.string().uuid().optional(),
  purposeTags: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/).max(64))
    .max(20)
    .default([]),
  contentType: z.string().max(200).default('application/octet-stream'),
  /** Base64. Multipart streaming is a later concern; the enforcement is not. */
  content: z.string().max(Math.ceil(MAX_BYTES / 3) * 4),
});

interface ObjectRow {
  id: string;
  bucket: string;
  key: string;
  principal_id: string | null;
  purpose_tags: string[];
  content_type: string;
  size_bytes: string;
  storage_key: string | null;
  created_at: Date;
}

const present = (row: ObjectRow) => ({
  id: row.id,
  bucket: row.bucket,
  key: row.key,
  principalId: row.principal_id,
  purposeTags: row.purpose_tags,
  contentType: row.content_type,
  sizeBytes: Number(row.size_bytes),
  createdAt: row.created_at,
});

const COLUMNS = `id, bucket, key, principal_id, purpose_tags, content_type,
                 size_bytes, storage_key, created_at`;

/** A purpose is mandatory here: it is what the policy evaluates. */
function storageContext(ctx: SignedContext): DbContext {
  if (!ctx.purpose) throw new ValidationError('A purpose is required for this request');
  return { projectId: ctx.projectId, purpose: ctx.purpose, principalId: ctx.principalId };
}

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Store an object.
   *
   * The row is written first and the bytes second. If the policy rejects the
   * row — an object claimed for a purpose its subject never agreed to — the
   * write fails before anything reaches the object store, so there is never a
   * file on disk that no row accounts for.
   */
  app.post('/storage/objects', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, { requirePurpose: true });
    const body = parseInput(CreateObject, request.body, 'object');

    let content: Buffer;
    try {
      content = Buffer.from(body.content, 'base64');
    } catch {
      throw new ValidationError('content must be base64', { field: 'content' });
    }
    if (content.byteLength > MAX_BYTES) {
      throw new ValidationError(`content exceeds ${MAX_BYTES} bytes`, { field: 'content' });
    }

    const storageKey = newStorageKey(ctx.projectId);

    const row = await withContext(app.pools.control, storageContext(ctx), async (client) => {
      const res = await client
        .query<ObjectRow>(
          `INSERT INTO storage_objects
             (project_id, bucket, key, principal_id, purpose_tags, content_type,
              size_bytes, storage_key)
           VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8)
           ON CONFLICT (project_id, bucket, key) DO UPDATE
             SET content_type = EXCLUDED.content_type,
                 size_bytes   = EXCLUDED.size_bytes,
                 storage_key  = EXCLUDED.storage_key,
                 purpose_tags = EXCLUDED.purpose_tags
           RETURNING ${COLUMNS}`,
          [
            ctx.projectId,
            body.bucket,
            body.key,
            body.principalId ?? null,
            body.purposeTags,
            body.contentType,
            content.byteLength,
            storageKey,
          ],
        )
        .catch((err: { code?: string }) => {
          // A WITH CHECK violation means the policy refused the row.
          if (err.code === '42501') {
            throw new ConsentDeniedError(ctx.purpose!, body.purposeTags);
          }
          throw err;
        });

      // RLS can accept the write and still return no row to a caller who could
      // not read it back. Treat that as a refusal rather than a silent success.
      if (!res.rowCount) throw new ConsentDeniedError(ctx.purpose!, body.purposeTags);
      return res.rows[0];
    });

    await app.store.put(storageKey, content);

    return reply.status(201).send(present(row));
  });

  app.get('/storage/objects', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, { requirePurpose: true });

    const rows = await withContext(app.pools.control, storageContext(ctx), async (client) => {
      const res = await client.query<ObjectRow>(
        `SELECT ${COLUMNS} FROM storage_objects ORDER BY created_at DESC, id DESC LIMIT 100`,
      );
      return res.rows;
    });

    return { objects: rows.map(present) };
  });

  app.get<{ Params: { id: string } }>('/storage/objects/:id', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, { requirePurpose: true });
    const row = await load(request.params.id, ctx);
    return present(row);
  });

  /**
   * The bytes.
   *
   * The metadata row is fetched under the policy first; reaching the object
   * store at all is conditional on the database having returned that row.
   */
  app.get<{ Params: { id: string } }>('/storage/objects/:id/content', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, { requirePurpose: true });
    const row = await load(request.params.id, ctx);

    const bytes = row.storage_key ? await app.store.get(row.storage_key) : undefined;
    // A row without bytes is a torn write, not a permissions problem — but the
    // caller learns the same thing either way.
    if (!bytes) throw new NotFoundError('Object', request.params.id);

    reply.header('content-type', row.content_type);
    reply.header('content-length', String(bytes.byteLength));
    return reply.send(bytes);
  });

  app.delete<{ Params: { id: string } }>('/storage/objects/:id', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, { requirePurpose: true });

    const row = await load(request.params.id, ctx);
    await withContext(app.pools.control, storageContext(ctx), async (client) => {
      await client.query(`DELETE FROM storage_objects WHERE id = $1`, [row.id]);
    });
    if (row.storage_key) await app.store.delete(row.storage_key);

    return reply.status(204).send();
  });

  /** Fetch one row under the policy, or 404 without saying which kind of absent. */
  async function load(id: string, ctx: SignedContext): Promise<ObjectRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError('Invalid object id', { id });

    const row = await withContext(app.pools.control, storageContext(ctx), async (client) => {
      const res = await client.query<ObjectRow>(
        `SELECT ${COLUMNS} FROM storage_objects WHERE id = $1`,
        [id],
      );
      return res.rows[0];
    });

    if (!row) throw new NotFoundError('Object', id);
    return row;
  }
};

export default routes;
