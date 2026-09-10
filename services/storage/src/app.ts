import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { SetuError, ValidationError } from '@setu/shared';
import { closePools, createPools, type Pools } from './db.js';
import { createStoreFromEnv, type ObjectStore } from './store.js';
import routes from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    pools: Pools;
    /** Where the bytes live. The database decides who reaches them. */
    store: ObjectStore;
    /** HMAC key the gateway signs request context with. */
    signingSecret: string;
  }
}

export interface AppOptions {
  pools?: Pools;
  store?: ObjectStore;
  signingSecret?: string;
}

/**
 * Build the storage service Fastify application.
 * Separated from index.ts for testability.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Object payloads are base64 inside JSON, so the body limit has to clear the
    // 10 MB object cap plus its encoding overhead.
    bodyLimit: 16 * 1024 * 1024,
  });

  await app.register(cors);

  const ownsPools = opts.pools === undefined;
  app.decorate('pools', opts.pools ?? createPools());
  app.decorate('store', opts.store ?? createStoreFromEnv());
  app.decorate('signingSecret', opts.signingSecret ?? process.env.INTERNAL_SIGNING_SECRET ?? '');

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

    // Never surface an unrecognised error: it may carry SQL text, a storage key,
    // or connection details.
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'storage' }));

  await app.register(routes, { prefix: '/v1' });

  return app;
}
