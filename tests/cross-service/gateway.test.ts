import type { AddressInfo } from 'node:net';
import { hash as argonHash } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETU, contextToHeaders } from '@setu/shared';
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
 * Gateway to Data over a real socket, with a real signature.
 *
 * The suites below this one prove the database enforces consent. This one
 * proves the path a client actually takes reaches that enforcement intact: the
 * gateway resolves a credential, binds a purpose the client asked for, signs
 * it, and the Data service accepts the context only because the signature
 * checks out.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';
const JWT_SECRET = 'test-jwt-secret';

const KEY_PREFIX = 'testkey';
const KEY_SECRET = 'z9WQe4vT1sNb7Lx2Kd6Rp0Ym';
const API_KEY = `setu_${KEY_PREFIX}_${KEY_SECRET}`;

let data: FastifyInstance;
let gateway: FastifyInstance;
let project: TestProject;
let otherProject: TestProject;
let principalId: string;
let recordId: string;

const auth = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${API_KEY}`,
  ...extra,
});

beforeAll(async () => {
  project = await provisionProject('gw');
  otherProject = await provisionProject('gwother');

  const supportId = await createPurpose(project.projectId, SUPPORT);
  const analyticsId = await createPurpose(project.projectId, ANALYTICS);

  principalId = await createPrincipal(project.projectId, { displayName: 'Asha' });
  await grantConsent(principalId, supportId, ['full_name', 'city']);
  await grantConsent(principalId, analyticsId, ['full_name', 'city']);

  await testPool('owner').query(
    `INSERT INTO api_keys (project_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, 'test key')`,
    [project.projectId, await argonHash(KEY_SECRET), KEY_PREFIX],
  );

  // A real listening socket: the gateway proxies with fetch, so app.inject on
  // the Data service would not exercise the hop at all.
  data = await buildData({
    pools: { runtime: testPool('runtime'), owner: testPool('owner') },
    signingSecret: TEST_SECRET,
  });
  await data.listen({ port: 0, host: '127.0.0.1' });
  const { port } = data.server.address() as AddressInfo;

  gateway = await buildGateway({
    pools: { runtime: testPool('runtime') },
    upstreams: { data: `http://127.0.0.1:${port}` },
    signingSecret: TEST_SECRET,
    jwtSecret: JWT_SECRET,
    buckets: new TokenBuckets({ capacity: 500, refillPerSecond: 500 }),
  });
  await gateway.ready();

  const declared = await gateway.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: auth(),
    payload: {
      name: 'patients',
      fields: [
        { name: 'full_name', type: 'text', mask: 'redact', purposes: [SUPPORT] },
        { name: 'city', type: 'text', mask: 'null', purposes: [SUPPORT, ANALYTICS] },
      ],
    },
  });
  if (declared.statusCode !== 201) {
    throw new Error(`declare failed: ${declared.statusCode} ${declared.body}`);
  }

  const created = await gateway.inject({
    method: 'POST',
    url: '/v1/collections/patients/records',
    headers: auth({ [SETU.HEADERS.PURPOSE]: SUPPORT }),
    payload: { principalId, full_name: 'Asha Menon', city: 'Kochi' },
  });
  if (created.statusCode !== 201) {
    throw new Error(`create failed: ${created.statusCode} ${created.body}`);
  }
  recordId = created.json().id;
});

afterAll(async () => {
  await gateway.close();
  await data.close();
  await dropProject(project);
  await dropProject(otherProject);
  await closePools();
});

describe('the full path', () => {
  /**
   * The whole spine in one request: API key resolves to a project, the client's
   * purpose is bound and signed, Data verifies the signature, and Postgres
   * decides the fields. Change only the purpose and the answer changes.
   */
  it('carries purpose from client to database and back', async () => {
    const support = await gateway.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: auth({ [SETU.HEADERS.PURPOSE]: SUPPORT }),
    });
    expect(support.statusCode).toBe(200);
    expect(support.json()).toMatchObject({ full_name: 'Asha Menon', city: 'Kochi' });

    const analytics = await gateway.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: auth({ [SETU.HEADERS.PURPOSE]: ANALYTICS }),
    });
    expect(analytics.statusCode).toBe(200);
    expect(analytics.json()).toMatchObject({ full_name: '***', city: 'Kochi' });
  });

  it('returns the request id the context was signed with', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: auth({ [SETU.HEADERS.PURPOSE]: SUPPORT }),
    });
    expect(res.headers[SETU.HEADERS.REQUEST_ID]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('purpose binding', () => {
  it('refuses a record request that names no purpose', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The database would evaluate an unregistered purpose quite happily and match
   * no artifact, returning an empty result that looks like absent data. Catching
   * it here makes a typo a 400 rather than a silent wrong answer.
   */
  it('refuses a purpose the project never registered', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: auth({ [SETU.HEADERS.PURPOSE]: 'not_a_real_purpose' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('still allows control-plane routes with no purpose at all', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/v1/collections', headers: auth() });
    expect(res.statusCode).toBe(200);
  });
});

describe('self-asserted context is worthless', () => {
  /**
   * The load-bearing one. A client who names another project in the platform
   * headers must not reach it — those headers are stripped before routing and
   * regenerated from the credential, so the claim never leaves the gateway.
   */
  it('ignores platform headers supplied by the client', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: auth({
        [SETU.HEADERS.PURPOSE]: ANALYTICS,
        [SETU.HEADERS.PROJECT_ID]: otherProject.projectId,
        [SETU.HEADERS.TENANT_ID]: otherProject.tenantId,
        [SETU.HEADERS.PRINCIPAL_ID]: principalId,
      }),
    });

    // Resolved from the API key, not from the headers: still our project, and
    // still masked, because analytics is what the gateway signed.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ full_name: '***', city: 'Kochi' });
  });

  /**
   * And a forged signature is no better than none. This is the attack the whole
   * signing scheme exists to stop — reaching the Data service directly, on the
   * port compose still publishes, with a purpose of one's choosing.
   */
  it('rejects a forged context sent straight to the Data service', async () => {
    const forged = await data.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: {
        [SETU.HEADERS.REQUEST_ID]: '00000000-0000-4000-8000-000000000000',
        [SETU.HEADERS.TENANT_ID]: project.tenantId,
        [SETU.HEADERS.PROJECT_ID]: project.projectId,
        [SETU.HEADERS.PURPOSE]: SUPPORT,
        [SETU.HEADERS.SIGNATURE]: 'f'.repeat(64),
      },
    });
    expect(forged.statusCode).toBe(401);

    // Unsigned entirely, for good measure.
    const unsigned = await data.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: {
        [SETU.HEADERS.REQUEST_ID]: '00000000-0000-4000-8000-000000000000',
        [SETU.HEADERS.TENANT_ID]: project.tenantId,
        [SETU.HEADERS.PROJECT_ID]: project.projectId,
        [SETU.HEADERS.PURPOSE]: SUPPORT,
      },
    });
    expect(unsigned.statusCode).toBe(401);
  });

  /**
   * The positive control: the identical request, signed with the shared secret,
   * succeeds. Without this the two rejections above would also pass on a service
   * that refused everything.
   */
  it('accepts the same request when the signature is genuine', async () => {
    const signed = await data.inject({
      method: 'GET',
      url: `/v1/collections/patients/records/${recordId}`,
      headers: contextToHeaders(
        {
          requestId: '00000000-0000-4000-8000-000000000000',
          tenantId: project.tenantId,
          projectId: project.projectId,
          purpose: SUPPORT,
        },
        TEST_SECRET,
      ),
    });
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toMatchObject({ full_name: 'Asha Menon' });
  });
});

describe('credentials', () => {
  it('refuses a request with no credential', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/v1/collections' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a key whose secret is wrong', async () => {
    const res = await gateway.inject({
      method: 'GET',
      url: '/v1/collections',
      headers: { authorization: `Bearer setu_${KEY_PREFIX}_wrongwrongwrongwrong` },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * An unknown prefix and a wrong secret must be the same answer, or the error
   * enumerates the key table.
   */
  it('answers a wrong secret and an unknown key identically', async () => {
    const unknown = await gateway.inject({
      method: 'GET',
      url: '/v1/collections',
      headers: { authorization: `Bearer setu_nosuchkey_${KEY_SECRET}` },
    });
    const wrong = await gateway.inject({
      method: 'GET',
      url: '/v1/collections',
      headers: { authorization: `Bearer setu_${KEY_PREFIX}_wrongwrongwrongwrong` },
    });

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json()).toEqual(wrong.json());
  });
});

describe('rate limiting', () => {
  it('refuses once the bucket is empty, per credential', async () => {
    const limited = await buildGateway({
      pools: { runtime: testPool('runtime') },
      upstreams: { data: gateway.upstreams.data },
      signingSecret: TEST_SECRET,
      jwtSecret: JWT_SECRET,
      buckets: new TokenBuckets({ capacity: 2, refillPerSecond: 0 }),
    });
    await limited.ready();

    try {
      const call = () => limited.inject({ method: 'GET', url: '/v1/collections', headers: auth() });
      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
