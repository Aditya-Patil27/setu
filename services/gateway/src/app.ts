import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { SetuError, ValidationError } from '@setu/shared';
import { closePools, createPools, type Pools } from './db.js';
import { keyCacheFromEnv, type KeyCache } from './keycache.js';
import { TokenBuckets } from './ratelimit.js';
import { upstreamsFromEnv, type Upstreams } from './upstreams.js';
import routes from './routes/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    pools: Pools;
    buckets: TokenBuckets;
    upstreams: Upstreams;
    /** Short-lived cache of verified API keys, so argon2 runs once per key, not per request. */
    keyCache: KeyCache;
    /** HMAC key the gateway signs outbound request context with. */
    signingSecret: string;
    /** Verifies principal session tokens locally, so Auth is never a per-request hop. */
    jwtSecret: string;
    /** How long an upstream has to answer before the gateway gives up on it. */
    upstreamTimeoutMs: number;
  }
}

export interface AppOptions {
  pools?: Pools;
  upstreams?: Partial<Upstreams>;
  buckets?: TokenBuckets;
  keyCache?: KeyCache;
  signingSecret?: string;
  jwtSecret?: string;
  upstreamTimeoutMs?: number;
}

/**
 * Long enough for a cold query behind a busy pool, short enough that a wedged
 * service is noticed rather than absorbed.
 */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5_000;
const DEFAULT_CAPACITY = 60;
const DEFAULT_REFILL_PER_SECOND = 10;

/**
 * Build the gateway Fastify application.
 * Separated from index.ts for testability.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors);

  const ownsPools = opts.pools === undefined;
  app.decorate('pools', opts.pools ?? createPools());
  app.decorate('upstreams', { ...upstreamsFromEnv(), ...opts.upstreams });
  app.decorate(
    'buckets',
    opts.buckets ??
      new TokenBuckets({
        capacity: Number(process.env.RATE_LIMIT_BURST ?? DEFAULT_CAPACITY),
        refillPerSecond: Number(process.env.RATE_LIMIT_PER_SECOND ?? DEFAULT_REFILL_PER_SECOND),
      }),
  );
  app.decorate('keyCache', opts.keyCache ?? keyCacheFromEnv());
  app.decorate('signingSecret', opts.signingSecret ?? process.env.INTERNAL_SIGNING_SECRET ?? '');
  app.decorate('jwtSecret', opts.jwtSecret ?? process.env.JWT_SECRET ?? '');
  app.decorate(
    'upstreamTimeoutMs',
    opts.upstreamTimeoutMs ??
      Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS ?? DEFAULT_UPSTREAM_TIMEOUT_MS),
  );

  if (!app.signingSecret) {
    throw new Error('INTERNAL_SIGNING_SECRET is required — downstream services will not trust us');
  }
  if (!app.jwtSecret) {
    throw new Error('JWT_SECRET is required — principal sessions cannot be verified without it');
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

    // Never surface an unrecognised error: it may carry SQL text, an upstream
    // URL, or connection details.
    request.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'gateway' }));

  await app.register(routes);

  return app;
}
