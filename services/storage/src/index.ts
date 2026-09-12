/**
 * M5 — Storage Service: Object upload/download via MinIO, signed URLs, purpose tags, encryption at rest
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.STORAGE_SERVICE_PORT ?? '3003', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:storage] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:storage] fatal:', err);
  process.exit(1);
});
