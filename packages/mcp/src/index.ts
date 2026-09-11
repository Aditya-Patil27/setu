#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, configFromEnv } from './config.js';
import { createServer } from './server.js';

/**
 * stdio entrypoint.
 *
 * Registered with an agent runtime as, for example:
 *
 *   claude mcp add setu \
 *     --env SETU_API_KEY=setu_... \
 *     --env SETU_PURPOSES=support_chat,analytics \
 *     -- npx -y @setu/mcp
 *
 * Nothing may be written to stdout but protocol frames — a stray console.log
 * corrupts the stream — so diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const config = configFromEnv();
  const server = createServer(config);

  await server.connect(new StdioServerTransport());

  const bindable = config.purposes.length ? config.purposes.join(', ') : 'any registered purpose';
  process.stderr.write(
    `[setu-mcp] connected to ${config.url} | purposes: ${bindable} | ` +
      `writes: ${config.allowWrites ? 'enabled' : 'disabled'}\n`,
  );
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`[setu-mcp] ${err.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`[setu-mcp] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

export { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export { configFromEnv, ConfigError, type McpConfig } from './config.js';
export { buildTools, type ToolDefinition } from './tools.js';
