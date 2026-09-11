import type { FastifyPluginAsync } from 'fastify';
import collections from './collections.js';
import records from './records.js';

/**
 * M4 — Data Service routes.
 *
 * Collection declaration generates tables, RLS policies and masking views;
 * record routes read exclusively through those views so Postgres, not this
 * service, decides what any caller sees.
 */
const routes: FastifyPluginAsync = async (app) => {
  await app.register(collections);
  await app.register(records);
};

export default routes;
