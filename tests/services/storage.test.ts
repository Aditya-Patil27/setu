import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../services/storage/src/app.js';
import { createMemoryStore, type ObjectStore } from '../../services/storage/src/store.js';
import {
  closePools,
  createPrincipal,
  createPurpose,
  dropProject,
  grantConsent,
  provisionProject,
  revokeConsent,
  testPool,
  type TestProject,
} from '../helpers/fixtures.js';
import { signedHeaders, TEST_SECRET } from '../helpers/http.js';

/**
 * A file about a person is personal data in exactly the way a row is, and is
 * gated the same way: the policy from migration 003 decides which objects exist
 * as far as the service is concerned, and the bytes are only ever fetched for a
 * row the database already returned.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';
const CONTENT = Buffer.from('a scan of something private').toString('base64');

let app: FastifyInstance;
let store: ObjectStore;
let project: TestProject;
let asha: string;
let supportConsent: string;

const headers = (purpose: string, p: TestProject = project) =>
  signedHeaders({ tenantId: p.tenantId, projectId: p.projectId, purpose });

async function upload(
  purpose: string,
  body: Record<string, unknown>,
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: '/v1/storage/objects',
    headers: headers(purpose),
    payload: { contentType: 'image/png', content: CONTENT, ...body },
  });
}

beforeAll(async () => {
  project = await provisionProject('storage');

  const supportId = await createPurpose(project.projectId, SUPPORT);
  await createPurpose(project.projectId, ANALYTICS);

  asha = await createPrincipal(project.projectId, { displayName: 'Asha' });
  supportConsent = await grantConsent(asha, supportId, ['scan']);

  store = createMemoryStore();
  app = await buildApp({
    pools: { control: testPool('control') },
    store,
    signingSecret: TEST_SECRET,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await dropProject(project);
  await closePools();
});

describe('objects about a person', () => {
  let objectId: string;
  let storageKey: string;

  it('stores an object for a purpose the subject agreed to', async () => {
    const res = await upload(SUPPORT, {
      bucket: 'medical',
      key: 'asha/scan.png',
      principalId: asha,
      purposeTags: [SUPPORT],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ bucket: 'medical', principalId: asha, sizeBytes: 27 });
    objectId = res.json().id;

    const row = await testPool('owner').query<{ storage_key: string }>(
      `SELECT storage_key FROM storage_objects WHERE id = $1`,
      [objectId],
    );
    storageKey = row.rows[0].storage_key;
  });

  /**
   * The demonstration. One object, one database, two callers differing only in
   * declared purpose — and for one of them the object does not exist.
   */
  it('hides it entirely from a purpose the subject never agreed to', async () => {
    const visible = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${objectId}`,
      headers: headers(SUPPORT),
    });
    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${objectId}`,
      headers: headers(ANALYTICS),
    });

    expect(visible.statusCode).toBe(200);
    expect(hidden.statusCode).toBe(404);
  });

  it('serves the bytes only to the purpose that may see the row', async () => {
    const allowed = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${objectId}/content`,
      headers: headers(SUPPORT),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.rawPayload.toString('base64')).toBe(CONTENT);

    const refused = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${objectId}/content`,
      headers: headers(ANALYTICS),
    });
    expect(refused.statusCode).toBe(404);
  });

  /**
   * The bytes are reached only through a row the database returned, so an object
   * store that is perfectly readable on its own terms still yields nothing.
   */
  it('leaves the bytes unreachable without the row, even though they exist', async () => {
    expect(await store.get(storageKey)).toBeDefined();

    const refused = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${objectId}/content`,
      headers: headers(ANALYTICS),
    });
    expect(refused.statusCode).toBe(404);
  });

  it('lists only what the purpose may see', async () => {
    const asSupport = await app.inject({
      method: 'GET',
      url: '/v1/storage/objects',
      headers: headers(SUPPORT),
    });
    const asAnalytics = await app.inject({
      method: 'GET',
      url: '/v1/storage/objects',
      headers: headers(ANALYTICS),
    });

    expect(asSupport.json().objects.map((o: { id: string }) => o.id)).toContain(objectId);
    expect(asAnalytics.json().objects.map((o: { id: string }) => o.id)).not.toContain(objectId);
  });

  /** Consent is not a one-time check: withdrawing it takes the object away. */
  it('disappears when the subject revokes consent', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${objectId}`,
      headers: headers(SUPPORT),
    });
    expect(before.statusCode).toBe(200);

    await revokeConsent(supportConsent);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${objectId}`,
      headers: headers(SUPPORT),
    });
    expect(after.statusCode).toBe(404);
  });
});

describe('writes carry the same predicate as reads', () => {
  /**
   * Refused, then granted, then accepted — the same request throughout.
   *
   * Without the second half, every refusal in this file would still pass on a
   * service that refused all writes, and the suite would be measuring nothing.
   */
  it('refuses an object its subject never agreed to, and accepts it once they do', async () => {
    const subject = await createPrincipal(project.projectId, { displayName: 'Biju' });
    const body = {
      bucket: 'medical',
      key: 'biju/scan.png',
      principalId: subject,
      purposeTags: [ANALYTICS],
    };

    expect((await upload(ANALYTICS, body)).statusCode).toBe(403);

    const analyticsId = await testPool('owner').query<{ id: string }>(
      `SELECT id FROM purposes WHERE project_id = $1 AND name = $2`,
      [project.projectId, ANALYTICS],
    );
    await grantConsent(subject, analyticsId.rows[0].id, ['scan']);

    expect((await upload(ANALYTICS, body)).statusCode).toBe(201);
  });

  /**
   * The tenant's half of the gate, independent of the principal's: an object
   * whose tags omit the purpose is unreadable even where consent exists.
   */
  it('refuses an object whose tags omit the purpose being claimed', async () => {
    const subject = await createPrincipal(project.projectId, { displayName: 'Chandra' });
    const purposeId = await createPurpose(project.projectId, 'billing');
    await grantConsent(subject, purposeId, ['scan']);

    const res = await upload('billing', {
      bucket: 'medical',
      key: 'chandra/scan.png',
      principalId: subject,
      purposeTags: [SUPPORT], // not 'billing'
    });

    expect(res.statusCode).toBe(403);
  });

  it('writes nothing to the object store when the row is refused', async () => {
    const subject = await createPrincipal(project.projectId, { displayName: 'Devi' });
    const before = await testPool('owner').query(`SELECT count(*)::int AS n FROM storage_objects`);

    const res = await upload(ANALYTICS, {
      bucket: 'medical',
      key: 'devi/scan.png',
      principalId: subject,
      purposeTags: [ANALYTICS],
    });
    expect(res.statusCode).toBe(403);

    const after = await testPool('owner').query(`SELECT count(*)::int AS n FROM storage_objects`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('objects about nobody', () => {
  /** A tenant asset has no subject, so there is no consent to evaluate. */
  it('is readable under any purpose', async () => {
    const created = await upload(SUPPORT, { bucket: 'assets', key: 'logo.png' });
    expect(created.statusCode).toBe(201);

    const other = await app.inject({
      method: 'GET',
      url: `/v1/storage/objects/${created.json().id}`,
      headers: headers(ANALYTICS),
    });
    expect(other.statusCode).toBe(200);
  });

  it('is still invisible to another project', async () => {
    const created = await upload(SUPPORT, { bucket: 'assets', key: 'internal.png' });
    const other = await provisionProject('storageother');
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/storage/objects/${created.json().id}`,
        headers: headers(SUPPORT, other),
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await dropProject(other);
    }
  });
});

describe('input handling', () => {
  it('rejects a key that tries to traverse', async () => {
    const res = await upload(SUPPORT, { bucket: 'assets', key: '../../etc/passwd' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request with no purpose bound', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/storage/objects',
      headers: signedHeaders({ tenantId: project.tenantId, projectId: project.projectId }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unsigned request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/storage/objects' });
    expect(res.statusCode).toBe(401);
  });
});
