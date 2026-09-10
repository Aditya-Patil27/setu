import { randomBytes } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError, contextFromHeaders, parseInput } from '@setu/shared';

/**
 * Project API keys.
 *
 * The plaintext is returned exactly once, at creation. Everything stored is an
 * argon2id digest, which is salted and therefore not searchable — hence the
 * separate `key_prefix`, which is what the gateway looks the key up by.
 */

const CreateKey = z.object({
  name: z.string().min(1).max(100),
  /** Absent means the key does not expire. */
  expiresAt: z.coerce.date().optional(),
});

interface KeyRow {
  id: string;
  name: string;
  key_prefix: string;
  expires_at: Date | null;
  created_at: Date;
}

const present = (row: KeyRow) => ({
  id: row.id,
  name: row.name,
  prefix: row.key_prefix,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

/** Shapes must satisfy the gateway's parser: `setu_<prefix>_<secret>`. */
function generateKey() {
  const prefix = randomBytes(8).toString('hex').slice(0, 8);
  const secret = randomBytes(24).toString('base64url');
  return { prefix, secret, plaintext: `setu_${prefix}_${secret}` };
}

const routes: FastifyPluginAsync = async (app) => {
  app.post('/keys', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(CreateKey, request.body, 'api key');

    if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('expiresAt must be in the future', {
        expiresAt: body.expiresAt,
      });
    }

    const key = generateKey();
    const res = await app.pools.control.query<KeyRow>(
      `INSERT INTO api_keys (project_id, key_hash, key_prefix, name, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, key_prefix, expires_at, created_at`,
      [ctx.projectId, await argonHash(key.secret), key.prefix, body.name, body.expiresAt ?? null],
    );

    // The only response that will ever carry the plaintext.
    return reply.status(201).send({ ...present(res.rows[0]), key: key.plaintext });
  });

  app.get('/keys', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const res = await app.pools.control.query<KeyRow>(
      `SELECT id, name, key_prefix, expires_at, created_at
         FROM api_keys WHERE project_id = $1 ORDER BY created_at DESC`,
      [ctx.projectId],
    );
    return { keys: res.rows.map(present) };
  });

  app.delete<{ Params: { id: string } }>('/keys/:id', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);

    // Scoped by project as well as id, so a key id learned elsewhere cannot be
    // revoked from a project that does not own it.
    const res = await app.pools.control.query(
      `DELETE FROM api_keys WHERE id = $1 AND project_id = $2`,
      [request.params.id, ctx.projectId],
    );
    if (!res.rowCount) throw new NotFoundError('API key', request.params.id);

    return reply.status(204).send();
  });
};

export default routes;
