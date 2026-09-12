/**
 * M4 — Data Service: Auto-generated REST over tenant schemas, RLS policy and masking-view generation
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.DATA_SERVICE_PORT ?? '3002', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:data] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:data] fatal:', err);
  process.exit(1);
});
