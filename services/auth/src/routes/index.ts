import type { FastifyPluginAsync } from 'fastify';
import keys from './keys.js';
import sessions from './sessions.js';

/**
 * M2 — Auth service routes.
 *
 * Issuance only. The gateway verifies JWTs locally and looks up API-key digests
 * itself, so nothing here sits on a per-request path: this service is reached
 * when a credential is created, exchanged or inspected, and never otherwise.
 */
const routes: FastifyPluginAsync = async (app) => {
  await app.register(keys);
  await app.register(sessions);
};

export default routes;
