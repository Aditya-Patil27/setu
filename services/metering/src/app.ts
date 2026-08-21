import Fastify from 'fastify';
import cors from '@fastify/cors';

/**
 * Build the metering service Fastify application.
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
  app.get('/health', async () => ({ status: 'ok', service: 'metering' }));

  // TODO: Register metering routes
  // await app.register(import('./routes/index.js'), { prefix: '/' });

  return app;
}
