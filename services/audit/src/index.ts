/**
 * M7 — Audit and Lineage: Hash-chained append-only audit log, lineage graph, path queries
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.AUDIT_SERVICE_PORT ?? '3006', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:audit] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:audit] fatal:', err);
  process.exit(1);
});
