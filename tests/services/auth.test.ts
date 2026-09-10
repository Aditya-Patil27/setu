import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../services/auth/src/app.js';
import { MOCK_CODE, createMockProvider } from '../../services/auth/src/otp.js';
import {
  closePools,
  createPrincipal,
  dropProject,
  provisionProject,
  testPool,
  type TestProject,
} from '../helpers/fixtures.js';
import { signedHeaders, TEST_SECRET } from '../helpers/http.js';

/**
 * Auth issues credentials and then leaves the request path. What matters here is
 * that what it issues is what the gateway can verify, and that the things which
 * must be one-shot — an OTP code, a refresh token — really are.
 */

const JWT_SECRET = 'test-jwt-secret';
const PHONE = '+919812300001';

let app: FastifyInstance;
let project: TestProject;

const headers = (extra: { principalId?: string } = {}) =>
  signedHeaders({ tenantId: project.tenantId, projectId: project.projectId, ...extra });

/** Run a full OTP exchange and return the resulting session. */
async function signIn(phone = PHONE) {
  const started = await app.inject({
    method: 'POST',
    url: '/v1/auth/otp/start',
    headers: headers(),
    payload: { phone },
  });
  expect(started.statusCode).toBe(201);

  const verified = await app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    headers: headers(),
    payload: { challengeId: started.json().challengeId, code: MOCK_CODE },
  });
  expect(verified.statusCode).toBe(200);
  return verified.json();
}

beforeAll(async () => {
  project = await provisionProject('auth');

  app = await buildApp({
    pools: { control: testPool('control') },
    otp: createMockProvider({ info: () => undefined } as never),
    signingSecret: TEST_SECRET,
    jwtSecret: JWT_SECRET,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await dropProject(project);
  await closePools();
});

describe('api keys', () => {
  it('returns the plaintext once and never again', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: headers(),
      payload: { name: 'ci key' },
    });

    expect(created.statusCode).toBe(201);
    const key = created.json().key;
    // Shapes must satisfy the gateway's parser, or the key is unusable.
    expect(key).toMatch(/^setu_[a-z0-9]{4,32}_[A-Za-z0-9_-]{16,128}$/);

    const listed = await app.inject({ method: 'GET', url: '/v1/keys', headers: headers() });
    expect(listed.statusCode).toBe(200);
    const row = listed.json().keys.find((k: { id: string }) => k.id === created.json().id);
    expect(row).toBeDefined();
    expect(JSON.stringify(listed.json())).not.toContain(key);
  });

  it('stores a digest rather than the key', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: headers(),
      payload: { name: 'digest check' },
    });
    const key = created.json().key;

    const stored = await testPool('owner').query<{ key_hash: string }>(
      `SELECT key_hash FROM api_keys WHERE id = $1`,
      [created.json().id],
    );
    expect(stored.rows[0].key_hash).toMatch(/^\$argon2id\$/);
    expect(stored.rows[0].key_hash).not.toContain(key.split('_')[2]);
  });

  it('refuses an expiry in the past', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: headers(),
      payload: { name: 'stale', expiresAt: '2020-01-01T00:00:00Z' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('will not revoke a key belonging to another project', async () => {
    const other = await provisionProject('authother');
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/keys',
        headers: headers(),
        payload: { name: 'ours' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/keys/${created.json().id}`,
        headers: signedHeaders({ tenantId: other.tenantId, projectId: other.projectId }),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await dropProject(other);
    }
  });
});

describe('otp sign-in', () => {
  it('issues a token the gateway can verify, with the claims it reads', async () => {
    const session = await signIn();

    const { payload } = await jwtVerify(
      session.accessToken,
      new TextEncoder().encode(JWT_SECRET),
    );
    // The gateway reads exactly these two claims; renaming either breaks it.
    expect(payload.sub).toBe(session.principalId);
    expect(payload.project_id).toBe(project.projectId);
  });

  it('registers the principal on first sign-in and reuses them on the next', async () => {
    const first = await signIn('+919812300777');
    const second = await signIn('+919812300777');
    expect(second.principalId).toBe(first.principalId);
  });

  /** A code that still worked after use would make interception a lasting key. */
  it('refuses to spend a challenge twice', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/start',
      headers: headers(),
      payload: { phone: '+919812300002' },
    });
    const challengeId = started.json().challengeId;

    const body = { challengeId, code: MOCK_CODE };
    expect((await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', headers: headers(), payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', headers: headers(), payload: body })).statusCode).toBe(401);
  });

  it('stops guessing after five wrong codes', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/start',
      headers: headers(),
      payload: { phone: '+919812300003' },
    });
    const challengeId = started.json().challengeId;

    const guess = (code: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        headers: headers(),
        payload: { challengeId, code },
      });

    for (let i = 0; i < 5; i += 1) expect((await guess('999999')).statusCode).toBe(401);

    // The correct code no longer helps: the challenge is spent by the attempts.
    expect((await guess(MOCK_CODE)).statusCode).toBe(401);
  });

  it('refuses a challenge belonging to another project', async () => {
    const other = await provisionProject('authchal');
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/start',
        headers: headers(),
        payload: { phone: '+919812300004' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        headers: signedHeaders({ tenantId: other.tenantId, projectId: other.projectId }),
        payload: { challengeId: started.json().challengeId, code: MOCK_CODE },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await dropProject(other);
    }
  });

  it('requires exactly one of phone or email', async () => {
    const both = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/start',
      headers: headers(),
      payload: { phone: PHONE, email: 'a@b.com' },
    });
    const neither = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/start',
      headers: headers(),
      payload: {},
    });
    expect(both.statusCode).toBe(400);
    expect(neither.statusCode).toBe(400);
  });
});

describe('refresh rotation', () => {
  const refresh = (refreshToken: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: headers(),
      payload: { refreshToken },
    });

  it('exchanges a refresh token for a new session', async () => {
    const session = await signIn('+919812300005');
    const res = await refresh(session.refreshToken);

    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(session.refreshToken);
  });

  /**
   * The load-bearing one. A refresh token presented twice means a copy is
   * circulating, so every live token for that principal is revoked — the thief
   * and the legitimate holder are both signed out rather than riding along
   * together.
   */
  it('treats reuse as theft and revokes the whole chain', async () => {
    const session = await signIn('+919812300006');
    const rotated = await refresh(session.refreshToken);
    expect(rotated.statusCode).toBe(200);

    // The spent token comes back — this is the stolen copy.
    expect((await refresh(session.refreshToken)).statusCode).toBe(401);

    // And the token the legitimate holder is carrying is now dead too.
    expect((await refresh(rotated.json().refreshToken)).statusCode).toBe(401);
  });

  it('refuses a token that was never issued', async () => {
    expect((await refresh('a'.repeat(43))).statusCode).toBe(401);
  });

  it('refuses a token issued to another project', async () => {
    const session = await signIn('+919812300007');
    const other = await provisionProject('authref');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: signedHeaders({ tenantId: other.tenantId, projectId: other.projectId }),
        payload: { refreshToken: session.refreshToken },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await dropProject(other);
    }
  });
});

describe('me', () => {
  it('reports the principal the context names', async () => {
    const principalId = await createPrincipal(project.projectId, {
      phone: '+919812300008',
      displayName: 'Asha',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: headers({ principalId }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: principalId, displayName: 'Asha' });
  });

  it('refuses a request carrying no principal', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: headers() });
    expect(res.statusCode).toBe(401);
  });
});
