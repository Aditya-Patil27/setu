/**
 * M10 — AI Service: consent-bound retrieval and inference.
 *
 * Retrieval reads through the same masking views the Data service does, so a
 * value this purpose may not see never enters the process — and therefore never
 * reaches a prompt.
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.AI_SERVICE_PORT ?? '3009', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:ai] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:ai] fatal:', err);
  process.exit(1);
});
