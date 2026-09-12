/**
 * M2 — Auth Service: Phone-OTP and email identity, JWT issuance, API keys, role management
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.AUTH_SERVICE_PORT ?? '3001', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:auth] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:auth] fatal:', err);
  process.exit(1);
});
