/**
 * M6 — Functions Runtime: tenant JS run in a V8 isolate, one child process per invocation
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.FUNCTIONS_SERVICE_PORT ?? '3004', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:functions] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:functions] fatal:', err);
  process.exit(1);
});
