import Fastify from 'fastify';
import cors from '@fastify/cors';

/**
 * Build the auth service Fastify application.
 * Separated from index.ts for testability.
 */
export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors);

  // Health check
  app.get('/health', async () => ({ status: 'ok', service: 'auth' }));

  // TODO: Register auth routes
  // await app.register(import('./routes/index.js'), { prefix: '/' });

  return app;
}
