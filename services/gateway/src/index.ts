/**
 * M1 — API Gateway: TLS termination, auth, rate limiting, tenant resolution, purpose propagation, routing
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.GATEWAY_PORT ?? '3000', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:gateway] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:gateway] fatal:', err);
  process.exit(1);
});
