import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError, contextFromHeaders, parseInput } from '@setu/shared';
import {
  addFields,
  declareCollection,
  listCollections,
  loadCollection,
} from '../ddl/collections.js';
import type { FieldSpec } from '../ddl/generate.js';

/**
 * Collection declaration is control-plane work: it shapes tenant data but reads
 * no records, so no purpose is bound. It still requires signed context — an
 * unsigned caller has no project to declare into.
 */

const PurposeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'must be lower_snake_case starting with a letter');

const FieldInput = z.object({
  name: z.string().min(1).max(63),
  type: z.enum([
    'text',
    'boolean',
    'integer',
    'bigint',
    'numeric',
    'date',
    'timestamptz',
    'uuid',
    'jsonb',
  ]),
  sensitivity: z.enum(['public', 'personal', 'sensitive']).default('personal'),
  mask: z.enum(['null', 'redact', 'partial', 'hash']).default('null'),
  /** Purpose names the tenant grants read access to. Resolved against the registry. */
  purposes: z.array(PurposeName).default([]),
  nullable: z.boolean().default(true),
  indexed: z.boolean().default(false),
  unique: z.boolean().default(false),
});

const CreateCollection = z.object({
  name: z.string().min(1).max(55),
  fields: z.array(FieldInput).min(1),
});

const AddFields = z.object({
  fields: z.array(FieldInput).min(1),
});

/**
 * parseInput's generic infers the schema's input side, where defaults are still
 * optional; the runtime values are always filled, so pin the output type here.
 */
type ParsedField = z.output<typeof FieldInput>;

function presentField(f: {
  name: string;
  type: string;
  sensitivity: string;
  mask: string;
  purposes: string[];
  nullable: boolean;
  indexed: boolean;
  unique: boolean;
}) {
  return {
    name: f.name,
    type: f.type,
    sensitivity: f.sensitivity,
    mask: f.mask,
    purposes: f.purposes,
    nullable: f.nullable,
    indexed: f.indexed,
    unique: f.unique,
  };
}

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Declare a collection. One call generates the table, its RLS policy and its
   * masking view in a single transaction — see the ddl module for why the
   * metadata and the generated objects may never be allowed to drift.
   */
  app.post('/collections', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(CreateCollection, request.body, 'collection');

    const specs: FieldSpec[] = body.fields.map((f: ParsedField) => ({ ...f }));
    const created = await declareCollection(app.pools.owner, ctx.projectId, body.name, specs);

    return reply.status(201).send({
      id: created.id,
      name: created.name,
      fields: created.fields.map(presentField),
    });
  });

  app.get('/collections', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const names = await listCollections(app.pools.runtime, ctx.projectId);
    return { collections: names.map((name) => ({ name })) };
  });

  app.get<{ Params: { name: string } }>('/collections/:name', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const found = await loadCollection(app.pools.runtime, ctx.projectId, request.params.name);
    if (!found) throw new NotFoundError('Collection', request.params.name);

    return {
      id: found.id,
      name: found.name,
      fields: found.fields.map(presentField),
    };
  });

  /** Extend a collection with new fields and rebuild its masking view. */
  app.patch<{ Params: { name: string } }>('/collections/:name', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(AddFields, request.body, 'collection');

    const specs: FieldSpec[] = body.fields.map((f: ParsedField) => ({ ...f }));
    const updated = await addFields(app.pools.owner, ctx.projectId, request.params.name, specs);

    return {
      id: updated.id,
      name: updated.name,
      fields: updated.fields.map(presentField),
    };
  });
};

export default routes;
