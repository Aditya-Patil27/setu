import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ConflictError, contextFromHeaders, parseInput } from '@setu/shared';

/**
 * Purpose names are compared against `current_setting('app.purpose')` inside every
 * generated RLS policy, so the character set is kept deliberately narrow — no
 * quoting surprises, no case ambiguity.
 */
const PurposeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'must be lower_snake_case starting with a letter');

const CreatePurpose = z.object({
  name: PurposeName,
  description: z.string().max(500).default(''),
  legalBasis: z.string().max(200).default('consent'),
});

interface PurposeRow {
  id: string;
  name: string;
  description: string;
  legal_basis: string;
  created_at: Date;
}

const present = (row: PurposeRow) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  legalBasis: row.legal_basis,
  createdAt: row.created_at,
});

const routes: FastifyPluginAsync = async (app) => {
  /** Register a purpose. This is the vocabulary every later consent decision uses. */
  app.post('/purposes', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(CreatePurpose, request.body, 'purpose');

    const existing = await app.pools.control.query(
      `SELECT 1 FROM purposes WHERE project_id = $1 AND name = $2`,
      [ctx.projectId, body.name],
    );
    if (existing.rowCount) {
      throw new ConflictError(`Purpose '${body.name}' already exists in this project`);
    }

    const res = await app.pools.control.query<PurposeRow>(
      `INSERT INTO purposes (project_id, name, description, legal_basis)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, description, legal_basis, created_at`,
      [ctx.projectId, body.name, body.description, body.legalBasis],
    );

    return reply.status(201).send(present(res.rows[0]));
  });

  app.get('/purposes', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);

    const res = await app.pools.control.query<PurposeRow>(
      `SELECT id, name, description, legal_basis, created_at
         FROM purposes WHERE project_id = $1 ORDER BY name`,
      [ctx.projectId],
    );

    return { purposes: res.rows.map(present) };
  });
};

export default routes;
