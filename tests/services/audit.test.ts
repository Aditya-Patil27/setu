import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp as buildAudit } from '../../services/audit/src/app.js';
import { buildApp as buildData } from '../../services/data/src/app.js';
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
import { signedHeaders, TEST_SECRET } from '../helpers/http.js';

/**
 * The audit trail, and the claim that makes it worth having: it is
 * tamper-evident, not merely append-only.
 *
 * The rows under test are written by the Data service's real reads rather than
 * inserted by hand, so this also pins the two together — an access that stopped
 * recording itself would fail here.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';

let audit: FastifyInstance;
let data: FastifyInstance;
let project: TestProject;
let consented: string;
let withheld: string;
let recordId: string;
let withheldRecordId: string;

const headers = (p: TestProject = project, extra: { purpose?: string } = {}) =>
  signedHeaders({ tenantId: p.tenantId, projectId: p.projectId, ...extra });

beforeAll(async () => {
  project = await provisionProject('audit');

  const supportId = await createPurpose(project.projectId, SUPPORT);
  await createPurpose(project.projectId, ANALYTICS);

  consented = await createPrincipal(project.projectId, { displayName: 'Asha' });
  withheld = await createPrincipal(project.projectId, { displayName: 'Chandra' });
  await grantConsent(consented, supportId, ['full_name']);
  await grantConsent(withheld, supportId, ['full_name']);

  data = await buildData({
    pools: { runtime: testPool('runtime'), owner: testPool('owner') },
    signingSecret: TEST_SECRET,
  });
  await data.ready();

  audit = await buildAudit({
    pools: { runtime: testPool('runtime') },
    signingSecret: TEST_SECRET,
  });
  await audit.ready();

  const declared = await data.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: headers(),
    payload: {
      name: 'patients',
      fields: [{ name: 'full_name', type: 'text', mask: 'redact', purposes: [SUPPORT, ANALYTICS] }],
    },
  });
  if (declared.statusCode !== 201) throw new Error(`declare: ${declared.body}`);

  const create = async (principalId: string, name: string) => {
    const res = await data.inject({
      method: 'POST',
      url: '/v1/collections/patients/records',
      headers: headers(project, { purpose: SUPPORT }),
      payload: { principalId, full_name: name },
    });
    if (res.statusCode !== 201) throw new Error(`create: ${res.body}`);
    return res.json().id;
  };

  recordId = await create(consented, 'Asha Menon');
  withheldRecordId = await create(withheld, 'Chandra Iyer');

  // A permitted read, and a read the principal never consented to. The second
  // returns a 404 the caller cannot distinguish from absence — the audit trail
  // is where the difference is kept.
  await data.inject({
    method: 'GET',
    url: `/v1/collections/patients/records/${recordId}`,
    headers: headers(project, { purpose: SUPPORT }),
  });
  await data.inject({
    method: 'GET',
    url: `/v1/collections/patients/records/${withheldRecordId}`,
    headers: headers(project, { purpose: ANALYTICS }),
  });
});

afterAll(async () => {
  await audit.close();
  await data.close();
  await dropProject(project);
  await closePools();
});

const list = (query = '', p: TestProject = project) =>
  audit.inject({ method: 'GET', url: `/v1/audit/records${query}`, headers: headers(p) });

describe('the trail', () => {
  it('records the reads the Data service actually performed', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);

    const records = res.json().records;
    expect(records.length).toBeGreaterThan(0);
    // Ordered by seq, which is the order the chain was built in.
    expect(records.map((r: { seq: number }) => r.seq)).toEqual(
      [...records.map((r: { seq: number }) => r.seq)].sort((a, b) => a - b),
    );
    expect(records.some((r: { action: string }) => r.action === 'read')).toBe(true);
  });

  /**
   * The denial the caller was not told about. They received a 404 identical to
   * an absent record; the tenant's own trail records that a row existed and was
   * withheld, and for which purpose.
   */
  it('keeps the detail of a denial the caller was refused', async () => {
    const res = await list('?outcome=denied');
    expect(res.statusCode).toBe(200);

    const denials = res.json().records;
    expect(denials.length).toBeGreaterThan(0);
    expect(denials.every((r: { outcome: string }) => r.outcome === 'denied')).toBe(true);
    expect(denials.some((r: { principalId: string }) => r.principalId === withheld)).toBe(true);
  });

  it('filters by principal and by purpose', async () => {
    const byPrincipal = await list(`?principalId=${consented}`);
    expect(byPrincipal.statusCode).toBe(200);
    expect(
      byPrincipal.json().records.every((r: { principalId: string }) => r.principalId === consented),
    ).toBe(true);

    const byPurpose = await list(`?purpose=${SUPPORT}`);
    expect(byPurpose.statusCode).toBe(200);
    expect(byPurpose.json().records.every((r: { purpose: string }) => r.purpose === SUPPORT)).toBe(
      true,
    );
  });

  it('pages by seq without repeating a row', async () => {
    const first = await list('?limit=1');
    expect(first.statusCode).toBe(200);
    const cursor = first.json().nextCursor;
    expect(cursor).toBeDefined();

    const second = await list(`?limit=1&after=${cursor}`);
    expect(second.json().records[0].seq).toBeGreaterThan(first.json().records[0].seq);
  });

  it('refuses a since later than its until', async () => {
    const res = await list('?since=2030-01-01&until=2020-01-01');
    expect(res.statusCode).toBe(400);
  });

  it('shows a project nothing but its own trail', async () => {
    const other = await provisionProject('auditother');
    try {
      const res = await list('', other);
      expect(res.statusCode).toBe(200);
      expect(res.json().records).toEqual([]);
    } finally {
      await dropProject(other);
    }
  });
});

describe('tamper evidence', () => {
  /**
   * A separate project, because these tests deliberately corrupt a chain and a
   * corrupted chain would fail every assertion made after it.
   */
  let scratch: TestProject;
  let purposeId: string;
  let principalId: string;

  const append = async (resource: string) => {
    const res = await testPool('owner').query<{ setu_append_audit: string }>(
      `SELECT setu_append_audit($1, $2, $3, 'read', $4, ARRAY['full_name'], 'permitted')`,
      [scratch.projectId, principalId, purposeId, resource],
    );
    return res.rows[0].setu_append_audit;
  };

  const verify = () =>
    audit.inject({ method: 'GET', url: '/v1/audit/verify', headers: headers(scratch) });

  beforeAll(async () => {
    scratch = await provisionProject('audittamper');
    purposeId = await createPurpose(scratch.projectId, SUPPORT);
    principalId = await createPrincipal(scratch.projectId, { displayName: 'Subject' });
    for (const n of ['a', 'b', 'c', 'd']) await append(`patients/${n}`);
  });

  afterAll(async () => {
    await dropProject(scratch);
  });

  it('reports an untouched chain as intact', async () => {
    const res = await verify();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ intact: true, breaks: [] });
    expect(res.json().checked).toBe(4);
  });

  /**
   * Editing a row in place is the attack the digest exists to catch: the stored
   * hash no longer describes the row sitting next to it.
   */
  it('detects a row edited in place', async () => {
    const target = await testPool('owner').query<{ id: string; resource: string }>(
      `SELECT id, resource FROM audit_records WHERE project_id = $1 ORDER BY seq LIMIT 1 OFFSET 1`,
      [scratch.projectId],
    );
    const { id, resource } = target.rows[0];

    await testPool('owner').query(`UPDATE audit_records SET resource = $2 WHERE id = $1`, [
      id,
      'patients/somebody-else',
    ]);

    try {
      const res = await verify();
      expect(res.json().intact).toBe(false);
      expect(res.json().breaks).toContainEqual(
        expect.objectContaining({ recordId: id, reason: 'hash-mismatch' }),
      );
    } finally {
      await testPool('owner').query(`UPDATE audit_records SET resource = $2 WHERE id = $1`, [
        id,
        resource,
      ]);
    }
  });

  it('is intact again once the edit is reverted', async () => {
    expect((await verify()).json().intact).toBe(true);
  });

  /**
   * Deleting a row leaves no row to fail its own digest — the evidence is in the
   * successor, which still carries the vanished row's hash as its prev_hash.
   */
  it('detects a row removed from the middle', async () => {
    const rows = await testPool('owner').query<{ id: string }>(
      `SELECT id FROM audit_records WHERE project_id = $1 ORDER BY seq`,
      [scratch.projectId],
    );
    const victim = rows.rows[1].id;
    const successor = rows.rows[2].id;

    const saved = await testPool('owner').query(`SELECT * FROM audit_records WHERE id = $1`, [
      victim,
    ]);
    await testPool('owner').query(`DELETE FROM audit_records WHERE id = $1`, [victim]);

    try {
      const res = await verify();
      expect(res.json().intact).toBe(false);
      expect(res.json().breaks).toContainEqual(
        expect.objectContaining({ recordId: successor, reason: 'broken-link' }),
      );
    } finally {
      const r = saved.rows[0];
      await testPool('owner').query(
        `INSERT INTO audit_records
           (id, seq, project_id, principal_id, purpose_id, action, resource, fields,
            outcome, prev_hash, hash, created_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          r.id,
          r.seq,
          r.project_id,
          r.principal_id,
          r.purpose_id,
          r.action,
          r.resource,
          r.fields,
          r.outcome,
          r.prev_hash,
          r.hash,
          r.created_at,
        ],
      );
    }
  });

  it('is intact again once the row is restored', async () => {
    expect((await verify()).json().intact).toBe(true);
  });
});
