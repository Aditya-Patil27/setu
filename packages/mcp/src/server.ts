import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SetuApiError, SetuClient } from '@setu/sdk';
import type { McpConfig } from './config.js';
import { buildTools } from './tools.js';

/**
 * The Setu MCP server.
 *
 * It is a client of the platform, not a component of it: it holds an API key
 * and speaks HTTP to the gateway exactly as any other caller would. It has no
 * database pool and no signing secret, so there is no path by which a tool call
 * reaches tenant data without passing the gateway's credential check, the
 * purpose binding, and the policies Postgres evaluates.
 */

export const SERVER_NAME = 'setu';
export const SERVER_VERSION = '0.1.0';

/**
 * Render a failure for a model rather than for a log.
 *
 * The platform's error codes are meaningful — CONSENT_DENIED is a different
 * instruction to the agent than VALIDATION_ERROR — so they are surfaced rather
 * than flattened into a message. The request id is included because it is what
 * ties an opaque 404 to its row in the audit chain.
 */
function describeError(err: unknown): string {
  if (err instanceof SetuApiError) {
    const parts = [`${err.code}: ${err.message}`];

    if (err.code === 'NOT_FOUND') {
      parts.push(
        'Note: a record that exists but is not visible under this purpose is ' +
          'reported as not-found. Check consent before assuming it is absent.',
      );
    }
    /**
     * The service answers identically for a field that does not exist and one
     * this purpose holds no grant on — naming the difference would let the
     * collection's shape be enumerated from error messages. So the hint has to
     * cover both readings rather than assert which one happened.
     */
    if (err.statusCode === 400 && /cannot be used in this query|indexed/i.test(err.message)) {
      parts.push(
        'That field is either undeclared or not readable under this purpose — ' +
          'the platform answers the same way for both. A field this purpose ' +
          'cannot read cannot be filtered or sorted on either, since that would ' +
          'let its value be inferred. Use setu_describe_collection to see which ' +
          'fields this purpose is granted.',
      );
    }
    if (err.requestId) parts.push(`request id: ${err.requestId}`);

    return parts.join('\n');
  }

  return err instanceof Error ? err.message : String(err);
}

export function createServer(config: McpConfig): McpServer {
  const client = new SetuClient({
    url: config.url,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of buildTools(config)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args ?? {}, client);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          // isError rather than a thrown exception: the model should see what
          // was refused and why, and be able to choose differently.
          return {
            isError: true,
            content: [{ type: 'text' as const, text: describeError(err) }],
          };
        }
      },
    );
  }

  /**
   * The whole project shape in one read.
   *
   * An agent that can see every collection, mask and purpose grant up front
   * does not have to discover them by querying and interpreting what came back
   * masked — which is both slower and a worse audit trail.
   */
  server.registerResource(
    'schema',
    'setu://schema',
    {
      title: 'Project schema',
      description:
        'Every collection with its fields, mask strategies and purpose grants, ' +
        'plus the registered purposes and the purposes this server may bind.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const [{ collections }, { purposes }] = await Promise.all([
        client.listCollections(),
        client.listPurposes(),
      ]);

      const detailed = await Promise.all(
        collections.map((c) => client.getCollection(c.name).catch(() => c)),
      );

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                collections: detailed,
                purposes,
                bindablePurposes:
                  config.purposes.length > 0 ? config.purposes : '(unrestricted by config)',
                writesEnabled: config.allowWrites,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
