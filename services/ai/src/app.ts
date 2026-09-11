import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { SetuError, ValidationError } from '@setu/shared';
import { closePools, createPools, type Pools } from './db.js';
import {
  createEchoCompleter,
  embedderFromEnv,
  type Completer,
  type Embedder,
} from './providers.js';
import routes from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    pools: Pools;
    /** HMAC key the gateway signs request context with. */
    signingSecret: string;
    embedder: Embedder;
    completer: Completer;
  }
}

export interface AppOptions {
  pools?: Pools;
  signingSecret?: string;
  embedder?: Embedder;
  completer?: Completer;
}

/**
 * Build the AI service Fastify application.
 * Separated from index.ts for testability.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors);

  const ownsPools = opts.pools === undefined;
  app.decorate('pools', opts.pools ?? createPools());
  app.decorate('signingSecret', opts.signingSecret ?? process.env.INTERNAL_SIGNING_SECRET ?? '');

  // Both default to deterministic local implementations, so the service runs
  // with no API key and no network. See providers.ts for why that is the
  // default rather than a fallback.
  app.decorate('embedder', opts.embedder ?? embedderFromEnv());
  app.decorate('completer', opts.completer ?? createEchoCompleter());

  if (!app.signingSecret) {
    throw new Error('INTERNAL_SIGNING_SECRET is required — refusing to trust unsigned context');
  }

  if (ownsPools) {
    app.addHook('onClose', async (instance) => {
      await closePools(instance.pools);
    });
  }

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ValidationError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    if (err instanceof SetuError) {
      return reply.status(err.statusCode).send(err.toJSON());
    }

    // Never surface an unrecognised error: it may carry SQL text, a prompt, or
    // connection details.
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'ai' }));

  await app.register(routes, { prefix: '/v1' });

  return app;
}
