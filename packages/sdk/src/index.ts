/**
 * @setu/sdk — TypeScript client for the Setu gateway.
 *
 * The client is a client: it holds an API key and talks HTTP to the gateway,
 * exactly as curl would. It has no database access and no signing secret, so
 * nothing it can do bypasses the enforcement the gateway and Postgres apply.
 */

export { SetuClient } from './client.js';
export { SetuHttp, SetuApiError, type SetuClientConfig, type RequestOptions } from './http.js';
export * from './types.js';
