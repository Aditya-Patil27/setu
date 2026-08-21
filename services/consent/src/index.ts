/**
 * M3 — Consent and Policy Engine: Consent artifact lifecycle, purpose evaluation, RLS generation, rights APIs
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.CONSENT_SERVICE_PORT ?? '3005', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:consent] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:consent] fatal:', err);
  process.exit(1);
});
