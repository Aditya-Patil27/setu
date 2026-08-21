import type { FastifyPluginAsync } from 'fastify';
import purposes from './purposes.js';
import consents from './consents.js';
import me from './me.js';

/**
 * M3 — Consent & Policy Engine routes.
 *
 * This service writes consent state; it never evaluates it on a read path. The
 * evaluation lives in the RLS policies and masking views the Data service
 * generates, which read these tables directly.
 */
const routes: FastifyPluginAsync = async (app) => {
  await app.register(purposes);
  await app.register(consents);
  await app.register(me);
};

export default routes;
