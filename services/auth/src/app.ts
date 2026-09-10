import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { SetuError, ValidationError } from '@setu/shared';
import { closePools, createPools, type Pools } from './db.js';
import { createOtpProvider, type OtpProvider } from './otp.js';
import { tokenConfigFromEnv, type TokenConfig } from './tokens.js';
import routes from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    pools: Pools;
    otp: OtpProvider;
    tokens: TokenConfig;
    /** HMAC key the gateway signs request context with. */
    signingSecret: string;
  }
}

export interface AppOptions {
  pools?: Pools;
  otp?: OtpProvider;
  signingSecret?: string;
  jwtSecret?: string;
}

/**
 * Build the auth service Fastify application.
 * Separated from index.ts for testability.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors);

  const ownsPools = opts.pools === undefined;
  app.decorate('pools', opts.pools ?? createPools());
  app.decorate('otp', opts.otp ?? createOtpProvider(app.log));
  app.decorate('signingSecret', opts.signingSecret ?? process.env.INTERNAL_SIGNING_SECRET ?? '');

  const jwtSecret = opts.jwtSecret ?? process.env.JWT_SECRET ?? '';
  app.decorate('tokens', tokenConfigFromEnv(jwtSecret));

  if (!app.signingSecret) {
    throw new Error('INTERNAL_SIGNING_SECRET is required — refusing to trust unsigned context');
  }
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required — the gateway could not verify what we issue');
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

    // Never surface an unrecognised error: it may carry SQL text, a digest, or
    // connection details.
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'auth' }));

  await app.register(routes, { prefix: '/v1' });

  return app;
}
