/**
 * M7 — Metering Service: Usage counters per tenant, SLA metrics
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.METERING_SERVICE_PORT ?? '3008', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:metering] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:metering] fatal:', err);
  process.exit(1);
});
