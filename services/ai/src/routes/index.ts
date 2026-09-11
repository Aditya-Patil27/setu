import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ValidationError, contextFromHeaders, parseInput } from '@setu/shared';
import type { SignedContext } from '@setu/shared';
import { ask, buildEmbeddings, retrieve, type EmbeddingContext } from '../embeddings.js';
import { appendAudit } from '../audit.js';

/**
 * Every route here binds a purpose, without exception.
 *
 * Unlike functions or workflows there is no case where inference over tenant
 * data is purpose-free: an embedding is derived from a person's record, and a
 * derivation with no declared intent is exactly what the platform exists to
 * refuse.
 */
function aiContext(ctx: SignedContext): EmbeddingContext {
  if (!ctx.purpose) {
    // Unreachable: contextFromHeaders ran with requirePurpose.
    throw new ValidationError('A purpose is required for this request');
  }
  return {
    projectId: ctx.projectId,
    purpose: ctx.purpose,
    principalId: ctx.principalId,
  };
}

const BuildBody = z.object({
  collection: z.string().min(1).max(55),
});

const AskBody = z.object({
  collection: z.string().min(1).max(55),
  question: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional(),
});

const SearchBody = AskBody.omit({ question: true }).extend({
  query: z.string().min(1).max(2000),
});

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Build or refresh vectors for a collection under the bound purpose.
   *
   * Re-running is cheap and safe: a row whose masked text is unchanged keeps
   * its vector, so this doubles as the repair path after a purge.
   */
  app.post('/ai/embeddings', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, {
      requirePurpose: true,
    });
    const body = parseInput(BuildBody, request.body, 'embeddings');

    const result = await buildEmbeddings(
      app.pools.runtime,
      aiContext(ctx),
      body.collection,
      app.embedder,
    );

    return reply.status(201).send(result);
  });

  /** Nearest neighbours, already masked for the bound purpose. */
  app.post('/ai/search', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, {
      requirePurpose: true,
    });
    const body = parseInput(SearchBody, request.body, 'search');

    const results = await retrieve(
      app.pools.runtime,
      aiContext(ctx),
      body.collection,
      body.query,
      app.embedder,
      body.topK ?? 5,
    );

    return { results };
  });

  /**
   * Answer a question from retrieved context.
   *
   * The response carries the context verbatim alongside the answer. That is the
   * point rather than a convenience: it lets a caller — or an auditor — see
   * exactly what the model was given, and confirm that a withheld value was
   * never among it.
   */
  app.post('/ai/ask', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, {
      requirePurpose: true,
    });
    const body = parseInput(AskBody, request.body, 'ask');

    const result = await ask(
      app.pools.runtime,
      aiContext(ctx),
      body.collection,
      body.question,
      app.embedder,
      app.completer,
      body.topK ?? 5,
    );

    /**
     * One audit record per principal whose data reached the prompt. Inference
     * is an access like any other, and a trail that recorded the question but
     * not whose data answered it would be useless exactly when it mattered.
     */
    await appendAudit(app.pools.runtime, aiContext(ctx), {
      principalIds: [...new Set(result.context.map((row) => row.fields.principal_id as string))],
      resource: `ai/${body.collection}`,
      fields: result.fields,
    });

    return result;
  });
};

export default routes;
