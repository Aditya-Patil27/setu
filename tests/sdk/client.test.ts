import type { AddressInfo } from 'node:net';
import { hash as argonHash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SetuApiError, SetuClient } from '../../packages/sdk/src/index.js';
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
 * The SDK against the real platform.
 *
 * Nothing is stubbed: the client makes genuine HTTP requests to a listening
 * gateway, which signs context and proxies to listening services, which read
 * through the masking views. What this suite proves is that the SDK is a
 * faithful client — it reaches the same enforcement a curl would, and it
 * surfaces the platform's own error codes rather than inventing its own.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';
const JWT_SECRET = 'test-jwt-secret';

const KEY_PREFIX = 'sdkkey';
const KEY_SECRET = 'Qw3rTy7uIo1pAs2dFg5h';
const API_KEY = `setu_${KEY_PREFIX}_${KEY_SECRET}`;

let data: FastifyInstance;
let consent: FastifyInstance;
let audit: FastifyInstance;
let gateway: FastifyInstance;
let project: TestProject;
let principalId: string;
let recordId: string;
let client: SetuClient;

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  project = await provisionProject('sdk');

  const supportId = await createPurpose(project.projectId, SUPPORT);
  const analyticsId = await createPurpose(project.projectId, ANALYTICS);

  principalId = await createPrincipal(project.projectId, { displayName: 'Ravi' });
  await grantConsent(principalId, supportId, ['full_name', 'city']);
  await grantConsent(principalId, analyticsId, ['city']);

  // key_prefix carries a unique index and these suites use fixed prefixes, so a
  // run that aborted before its afterAll would otherwise poison every run after
  // it. Clearing first makes the fixture idempotent rather than order-dependent.
  await testPool('owner').query(`DELETE FROM api_keys WHERE key_prefix = $1`, [KEY_PREFIX]);

  await testPool('owner').query(
    `INSERT INTO api_keys (project_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'sdk test key')`,
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

  const upstreams = {
    data: await listen(data),
    consent: await listen(consent),
    audit: await listen(audit),
  };

  gateway = await buildGateway({
    pools: { runtime: testPool('runtime') },
    upstreams,
    signingSecret: TEST_SECRET,
    jwtSecret: JWT_SECRET,
    buckets: new TokenBuckets({ capacity: 500, refillPerSecond: 500 }),
  });

  // The SDK uses fetch, so the gateway needs a real socket too.
  client = new SetuClient({ url: await listen(gateway), apiKey: API_KEY });

  await client.createCollection('patients', [
    { name: 'full_name', type: 'text', mask: 'redact', purposes: [SUPPORT] },
    { name: 'city', type: 'text', mask: 'null', purposes: [SUPPORT, ANALYTICS] },
  ]);

  const created = await client.createRecord('patients', SUPPORT, principalId, {
    full_name: 'Ravi Kumar',
    city: 'Pune',
  });
  recordId = created.id;
});

afterAll(async () => {
  await gateway.close();
  await audit.close();
  await consent.close();
  await data.close();
  await dropProject(project);
  await closePools();
});

describe('collections', () => {
  it('reports the declared shape, including who may read each field', async () => {
    const collection = await client.getCollection('patients');

    expect(collection.name).toBe('patients');
    const fullName = collection.fields.find((f) => f.name === 'full_name');
    expect(fullName?.mask).toBe('redact');
    expect(fullName?.purposes).toEqual([SUPPORT]);
  });

  it('lists collections without binding any purpose', async () => {
    const { collections } = await client.listCollections();
    expect(collections.map((c) => c.name)).toContain('patients');
  });
});

describe('records through the masking views', () => {
  it('shows one row differently to two purposes', async () => {
    const asSupport = await client.getRecord('patients', SUPPORT, recordId);
    const asAnalytics = await client.getRecord('patients', ANALYTICS, recordId);

    expect(asSupport.full_name).toBe('Ravi Kumar');
    expect(asAnalytics.full_name).toBe('***');

    // The field both purposes were granted reads identically through each.
    expect(asSupport.city).toBe('Pune');
    expect(asAnalytics.city).toBe('Pune');
  });

  it('keeps masked fields present, so the response shape is stable', async () => {
    const asAnalytics = await client.getRecord('patients', ANALYTICS, recordId);
    expect(Object.keys(asAnalytics)).toContain('full_name');
  });

  it('lists records under a purpose', async () => {
    const page = await client.listRecords('patients', SUPPORT, { limit: 10 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].id).toBe(recordId);
  });

  it('refuses to filter on a column the purpose cannot read', async () => {
    await expect(
      client.listRecords('patients', ANALYTICS, { full_name: 'Ravi Kumar' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('allows the identical filter under a purpose that may read it', async () => {
    const page = await client.listRecords('patients', SUPPORT, {
      full_name: 'Ravi Kumar',
    });
    expect(page.records).toHaveLength(1);
  });
});

describe('errors carry the platform code, not an SDK invention', () => {
  it('surfaces a missing purpose as a validation error', async () => {
    // Reaching past the typed method: the gateway is what rejects this.
    await expect(client.listRecords('patients', '' as string, {})).rejects.toBeInstanceOf(
      SetuApiError,
    );
  });

  it('reports an unknown record as an opaque not-found', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const err = await client
      .getRecord('patients', SUPPORT, missing)
      .catch((e: unknown) => e as SetuApiError);

    expect(err).toBeInstanceOf(SetuApiError);
    expect((err as SetuApiError).statusCode).toBe(404);
  });

  it('carries the request id, so a failure can be matched to the audit chain', async () => {
    const err = await client
      .getRecord('patients', SUPPORT, '00000000-0000-4000-8000-000000000000')
      .catch((e: unknown) => e as SetuApiError);

    expect((err as SetuApiError).requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('refuses a bad credential without reaching a service', async () => {
    const impostor = new SetuClient({
      url: (client as unknown as { http: { baseUrl: string } }).http.baseUrl,
      apiKey: `setu_${KEY_PREFIX}_wrongwrongwrongwrong`,
    });

    await expect(impostor.listCollections()).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe('consent and audit', () => {
  it('lists the purposes the project registered', async () => {
    const { purposes } = await client.listPurposes();
    expect(purposes.map((p) => p.name).sort()).toEqual([ANALYTICS, SUPPORT]);
  });

  it('reports what a principal agreed to', async () => {
    const { consents } = await client.listConsents(principalId);
    const support = consents.find((c) => c.purpose === SUPPORT);
    expect(support?.fields).toEqual(['full_name', 'city']);
  });

  it('reads back the trail its own calls just wrote', async () => {
    const { records } = await client.listAuditRecords({ principalId, limit: 50 });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.principalId === principalId)).toBe(true);
  });

  it('verifies the chain the reads above extended', async () => {
    const verification = await client.verifyChain();

    expect(verification.intact).toBe(true);
    expect(verification.breaks).toEqual([]);
    // The reads in this suite each appended a row, so there is a head to name.
    expect(verification.checked).toBeGreaterThan(0);
    expect(verification.headHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
