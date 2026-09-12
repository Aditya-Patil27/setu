import type { AddressInfo } from 'node:net';
import { hash as argonHash } from '@node-rs/argon2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTools } from '../../packages/mcp/src/tools.js';
import { createServer } from '../../packages/mcp/src/server.js';
import type { McpConfig } from '../../packages/mcp/src/config.js';
import { buildApp as buildAudit } from '../../services/audit/src/app.js';
import { buildApp as buildConsent } from '../../services/consent/src/app.js';
import { buildApp as buildData } from '../../services/data/src/app.js';
import { buildApp as buildGateway } from '../../services/gateway/src/app.js';
import { TokenBuckets } from '../../services/gateway/src/ratelimit.js';
import {
  closePools,
  createPrincipal,
  createPurpose,
  dropProject,
  grantConsent,
  provisionProject,
  testPool,
  type TestProject,
} from '../helpers/fixtures.js';
import { TEST_SECRET } from '../helpers/http.js';

/**
 * The MCP server against the real platform.
 *
 * An agent's tool call goes through the same gateway a curl does, so what this
 * suite proves is that giving a model tools changes nothing about enforcement:
 * it binds a purpose from a closed set, it sees what that purpose is permitted
 * to see, and the attempt is recorded whether or not it succeeded.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';
const JWT_SECRET = 'test-jwt-secret';

const KEY_PREFIX = 'mcpkey';
const KEY_SECRET = 'Mn4bVc7xZa2sQw9eRt5y';
const API_KEY = `setu_${KEY_PREFIX}_${KEY_SECRET}`;

let data: FastifyInstance;
let consent: FastifyInstance;
let audit: FastifyInstance;
let gateway: FastifyInstance;
let project: TestProject;
let principalId: string;
let recordId: string;
let gatewayUrl: string;
let client: Client;

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function config(overrides: Partial<McpConfig> = {}): McpConfig {
  return {
    url: gatewayUrl,
    apiKey: API_KEY,
    purposes: [SUPPORT, ANALYTICS],
    allowWrites: true,
    timeoutMs: 10_000,
    ...overrides,
  };
}

/** Connect an MCP client to a server built with the given config. */
async function connect(cfg: McpConfig): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test-agent', version: '0.0.0' });
  await Promise.all([createServer(cfg).connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

/** Tool results arrive as text content; every handler returns JSON. */
function payload(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

beforeAll(async () => {
  project = await provisionProject('mcp');

  const supportId = await createPurpose(project.projectId, SUPPORT);
  const analyticsId = await createPurpose(project.projectId, ANALYTICS);

  principalId = await createPrincipal(project.projectId, { displayName: 'Meera' });
  await grantConsent(principalId, supportId, ['full_name', 'city']);
  await grantConsent(principalId, analyticsId, ['city']);

  // key_prefix carries a unique index and these suites use fixed prefixes, so a
  // run that aborted before its afterAll would otherwise poison every run after
  // it. Clearing first makes the fixture idempotent rather than order-dependent.
  await testPool('owner').query(`DELETE FROM api_keys WHERE key_prefix = $1`, [KEY_PREFIX]);

  await testPool('owner').query(
    `INSERT INTO api_keys (project_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'mcp test key')`,
    [project.projectId, await argonHash(KEY_SECRET), KEY_PREFIX],
  );

  data = await buildData({
    pools: { runtime: testPool('runtime'), owner: testPool('owner') },
    signingSecret: TEST_SECRET,
  });
  consent = await buildConsent({
    pools: { control: testPool('control') },
    signingSecret: TEST_SECRET,
  });
  audit = await buildAudit({
    pools: { runtime: testPool('runtime') },
    signingSecret: TEST_SECRET,
  });

  gateway = await buildGateway({
    pools: { runtime: testPool('runtime') },
    upstreams: {
      data: await listen(data),
      consent: await listen(consent),
      audit: await listen(audit),
    },
    signingSecret: TEST_SECRET,
    jwtSecret: JWT_SECRET,
    buckets: new TokenBuckets({ capacity: 500, refillPerSecond: 500 }),
  });
  gatewayUrl = await listen(gateway);

  client = await connect(config());

  await client.callTool({
    name: 'setu_create_collection',
    arguments: {
      name: 'patients',
      fields: [
        { name: 'full_name', type: 'text', mask: 'redact', purposes: [SUPPORT] },
        { name: 'city', type: 'text', mask: 'null', purposes: [SUPPORT, ANALYTICS] },
      ],
    },
  });

  const created = await client.callTool({
    name: 'setu_create_record',
    arguments: {
      collection: 'patients',
      purpose: SUPPORT,
      principalId,
      fields: { full_name: 'Meera Nair', city: 'Pune' },
    },
  });
  recordId = payload(created).id as string;
});

afterAll(async () => {
  await client.close();
  await gateway.close();
  await audit.close();
  await consent.close();
  await data.close();
  await dropProject(project);
  await closePools();
});

describe('the tool surface', () => {
  it('exposes the documented tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('setu_describe_collection');
    expect(names).toContain('setu_list_records');
    expect(names).toContain('setu_audit_records');
    expect(names).toContain('setu_verify_chain');
  });

  it('offers the project schema as a resource', async () => {
    const { contents } = await client.readResource({ uri: 'setu://schema' });
    const schema = JSON.parse(contents[0].text as string) as {
      collections: Array<{ name: string; fields: Array<{ name: string; purposes: string[] }> }>;
      bindablePurposes: string[];
    };

    const patients = schema.collections.find((c) => c.name === 'patients');
    expect(patients?.fields.find((f) => f.name === 'full_name')?.purposes).toEqual([SUPPORT]);
    expect(schema.bindablePurposes).toEqual([SUPPORT, ANALYTICS]);
  });
});

describe('purpose is a closed vocabulary', () => {
  it('declares purpose as an enum over the configured allowlist', async () => {
    const { tools } = await client.listTools();
    const get = tools.find((t) => t.name === 'setu_get_record');
    const purpose = (get?.inputSchema.properties as Record<string, { enum?: string[] }>).purpose;

    expect(purpose.enum).toEqual([SUPPORT, ANALYTICS]);
  });

  it('refuses a purpose outside the allowlist', async () => {
    const result = await client.callTool({
      name: 'setu_get_record',
      arguments: { collection: 'patients', purpose: 'marketing', id: recordId },
    });

    expect(result.isError).toBe(true);
  });

  it('cannot bind a purpose the server was not configured with, even if registered', async () => {
    // analytics is registered in the project, but this server may only bind support.
    const narrow = await connect(config({ purposes: [SUPPORT] }));
    try {
      const result = await narrow.callTool({
        name: 'setu_get_record',
        arguments: { collection: 'patients', purpose: ANALYTICS, id: recordId },
      });
      expect(result.isError).toBe(true);
    } finally {
      await narrow.close();
    }
  });
});

describe('an agent sees only what its purpose is granted', () => {
  it('returns the name under support_chat and a redaction under analytics', async () => {
    const asSupport = payload(
      await client.callTool({
        name: 'setu_get_record',
        arguments: { collection: 'patients', purpose: SUPPORT, id: recordId },
      }),
    );
    const asAnalytics = payload(
      await client.callTool({
        name: 'setu_get_record',
        arguments: { collection: 'patients', purpose: ANALYTICS, id: recordId },
      }),
    );

    expect(asSupport.full_name).toBe('Meera Nair');
    expect(asAnalytics.full_name).toBe('***');
  });

  it('has no tool argument that widens what a purpose may read', async () => {
    const { tools } = await client.listTools();
    const get = tools.find((t) => t.name === 'setu_get_record');
    const params = Object.keys(get?.inputSchema.properties ?? {});

    // collection, purpose, id — and nothing resembling a bypass.
    expect(params.sort()).toEqual(['collection', 'id', 'purpose']);
  });

  it('refuses to filter on a field the purpose cannot read, and says why', async () => {
    const result = await client.callTool({
      name: 'setu_list_records',
      arguments: {
        collection: 'patients',
        purpose: ANALYTICS,
        filters: { full_name: 'Meera Nair' },
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/describe_collection/i);
  });
});

describe('every tool call lands in the audit trail', () => {
  it('records the reads this suite performed, attributed to a purpose', async () => {
    const trail = payload(
      await client.callTool({
        name: 'setu_audit_records',
        arguments: { principalId, limit: 200 },
      }),
    ) as unknown as { records: Array<{ purpose: string | null; action: string }> };

    const purposes = new Set(trail.records.map((r) => r.purpose));
    expect(purposes.has(SUPPORT)).toBe(true);
    expect(purposes.has(ANALYTICS)).toBe(true);
  });

  it('verifies intact after an agent session', async () => {
    const verification = payload(
      await client.callTool({ name: 'setu_verify_chain', arguments: {} }),
    );

    expect(verification.intact).toBe(true);
    expect(verification.breaks).toEqual([]);
  });
});

describe('write gating', () => {
  it('omits the mutating tools entirely when writes are disabled', () => {
    const readOnly = buildTools(config({ allowWrites: false })).map((t) => t.name);

    expect(readOnly).toContain('setu_get_record');
    expect(readOnly).not.toContain('setu_create_record');
    expect(readOnly).not.toContain('setu_revoke_consent');
    expect(readOnly).not.toContain('setu_create_collection');
  });

  it('a read-only server does not advertise them over the protocol either', async () => {
    const readOnly = await connect(config({ allowWrites: false }));
    try {
      const { tools } = await readOnly.listTools();
      expect(tools.map((t) => t.name)).not.toContain('setu_create_record');
    } finally {
      await readOnly.close();
    }
  });
});
