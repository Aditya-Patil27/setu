/**
 * M6 — Functions Runtime: User JS packaged into containers, executed as K8s Jobs with resource limits
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env._SERVICE_PORT ?? '3004', 10);

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log('[setu:functions] listening on port %d', PORT);
}

main().catch((err) => {
  console.error('[setu:functions] fatal:', err);
  process.exit(1);
});
