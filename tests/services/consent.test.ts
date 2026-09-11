import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../services/consent/src/app.js';
import { createRecordingPublisher } from '../../services/consent/src/events.js';
import {
  closePools,
  createPrincipal,
  createPurpose,
  dropProject,
  provisionProject,
  testPool,
  type TestProject,
} from '../helpers/fixtures.js';
import { signedHeaders, TEST_SECRET } from '../helpers/http.js';

let app: FastifyInstance;
let project: TestProject;
let principalId: string;
const events = createRecordingPublisher();

beforeAll(async () => {
  project = await provisionProject('consent');
  principalId = await createPrincipal(project.projectId, { phone: '+919900000001' });

  app = await buildApp({
    pools: { control: testPool('control') },
    events,
    signingSecret: TEST_SECRET,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await dropProject(project);
  await closePools();
});

const headers = (extra: { principalId?: string } = {}) =>
  signedHeaders({ tenantId: project.tenantId, projectId: project.projectId, ...extra });

describe('request context', () => {
  it('rejects an unsigned request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/purposes',
      headers: {
        'x-setu-tenant-id': project.tenantId,
        'x-setu-project-id': project.projectId,
        'x-setu-request-id': 'req-1',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a signature made with the wrong key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/purposes',
      headers: signedHeaders({
        tenantId: project.tenantId,
        projectId: project.projectId,
        secret: 'not-the-real-secret',
      }),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('purpose registry', () => {
  it('registers and lists purposes', async () => {
    for (const name of ['billing', 'analytics']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/purposes',
        headers: headers(),
        payload: { name, description: `${name} processing` },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe(name);
    }

    const list = await app.inject({ method: 'GET', url: '/v1/purposes', headers: headers() });
    expect(list.json().purposes.map((p: { name: string }) => p.name)).toEqual([
      'analytics',
      'billing',
    ]);
  });

  it('rejects a name the RLS policy could not match cleanly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/purposes',
      headers: headers(),
      payload: { name: 'Billing; DROP TABLE' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a duplicate purpose', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/purposes',
      headers: headers(),
      payload: { name: 'billing' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('consent artifacts', () => {
  it('grants consent for specific fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: { principalId, purpose: 'billing', fields: ['phone', 'email'] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      principalId,
      purpose: 'billing',
      fields: ['phone', 'email'],
      status: 'active',
    });
    expect(events.events.at(-1)).toMatchObject({ payload: { action: 'granted' } });
  });

  /**
   * Two active artifacts for one (principal, purpose) would make "what did they
   * agree to" ambiguous, and the RLS policy would honour whichever matched first.
   */
  it('supersedes the previous active grant rather than stacking', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: { principalId, purpose: 'billing', fields: ['phone'] },
    });

    const active = await testPool('owner').query(
      `SELECT 1 FROM consent_artifacts ca JOIN purposes p ON p.id = ca.purpose_id
        WHERE ca.principal_id = $1 AND p.name = 'billing' AND ca.status = 'active'`,
      [principalId],
    );
    expect(active.rowCount).toBe(1);
  });

  it('refuses a purpose that is not registered', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: { principalId, purpose: 'not_registered', fields: ['phone'] },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an expiry in the past', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: {
        principalId,
        purpose: 'analytics',
        fields: ['phone'],
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a principal belonging to another project', async () => {
    const other = await provisionProject('other');
    const foreign = await createPrincipal(other.projectId, { phone: '+919900000009' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: { principalId: foreign, purpose: 'billing', fields: ['phone'] },
    });

    expect(res.statusCode).toBe(404);
    await dropProject(other);
  });

  it('revokes an artifact', async () => {
    const granted = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: { principalId, purpose: 'analytics', fields: ['phone'] },
    });
    const id = granted.json().id;

    const revoked = await app.inject({
      method: 'POST',
      url: `/v1/consents/${id}/revoke`,
      headers: headers(),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe('revoked');

    // Revoking twice is a 404: there is no longer an active artifact by that id.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/consents/${id}/revoke`,
      headers: headers(),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('the advisory check endpoint', () => {
  it('marks its own answer as advisory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/consents/check?principalId=${principalId}&purpose=billing`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().advisory).toBe(true);
    expect(res.json().permitted).toBe(true);
  });
});

describe('principal-facing routes', () => {
  it('refuses a request with no principal', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/consents', headers: headers() });
    expect(res.statusCode).toBe(401);
  });

  it("lists only the calling principal's consents", async () => {
    const otherPrincipal = await createPrincipal(project.projectId, { phone: '+919900000002' });
    await createPurpose(project.projectId, 'support');
    await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: { principalId: otherPrincipal, purpose: 'support', fields: ['phone'] },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/consents',
      headers: headers({ principalId }),
    });

    expect(res.statusCode).toBe(200);
    const returned = res.json().consents as Array<{ principalId: string }>;
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.every((c) => c.principalId === principalId)).toBe(true);
  });

  it("will not let a principal revoke somebody else's consent", async () => {
    const victim = await createPrincipal(project.projectId, { phone: '+919900000003' });
    const granted = await app.inject({
      method: 'POST',
      url: '/v1/consents',
      headers: headers(),
      payload: { principalId: victim, purpose: 'support', fields: ['phone'] },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/me/consents/${granted.json().id}/revoke`,
      headers: headers({ principalId }),
    });

    expect(res.statusCode).toBe(404);
  });
});
