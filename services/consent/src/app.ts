import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { SetuError, ValidationError } from '@setu/shared';
import { createPools, type Pools } from './db.js';
import { createLoggingPublisher, type EventPublisher } from './events.js';
import routes from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    pools: Pools;
    events: EventPublisher;
    /** HMAC key the gateway signs request context with. */
    signingSecret: string;
  }
}

export interface AppOptions {
  pools?: Pools;
  events?: EventPublisher;
  signingSecret?: string;
}

/**
 * Build the consent service Fastify application.
 * Separated from index.ts for testability.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors);

  app.decorate('pools', opts.pools ?? createPools());
  app.decorate('events', opts.events ?? createLoggingPublisher(app.log));
  app.decorate('signingSecret', opts.signingSecret ?? process.env.INTERNAL_SIGNING_SECRET ?? '');

  if (!app.signingSecret) {
    throw new Error('INTERNAL_SIGNING_SECRET is required — refusing to trust unsigned context');
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

    // Never surface an unrecognised error: it may carry SQL text or connection details.
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'consent' }));

  await app.register(routes, { prefix: '/v1' });

  return app;
}
