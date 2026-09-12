/**
 * M9 — Workflow Engine: Durable multi-step DAG execution with purpose propagation across steps
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.WORKFLOW_SERVICE_PORT ?? '3007', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:workflow] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:workflow] fatal:', err);
  process.exit(1);
});
