import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../services/data/src/app.js';
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
 * The platform's central claim, exercised end to end through the Data service:
 * Postgres decides what a caller sees, and it decides per purpose.
 *
 * Nothing here asserts on service logic. Every expectation below is a statement
 * about what the database returned through the masking view — which is the only
 * thing that would still hold if this service were compromised.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';

let app: FastifyInstance;
let project: TestProject;

/** Consents to both purposes, and to every field of each. */
let asha: string;
/** Consents to support, but withholds his name from it. */
let biju: string;
/** Consents to support only — analytics was never agreed to at all. */
let chandra: string;

const recordIds: Record<string, string> = {};

const headers = (extra: { purpose?: string; principalId?: string } = {}) =>
  signedHeaders({ tenantId: project.tenantId, projectId: project.projectId, ...extra });

async function insert(principalId: string, fields: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/collections/patients/records',
    headers: headers({ purpose: SUPPORT }),
    payload: { principalId, ...fields },
  });
  if (res.statusCode !== 201) {
    throw new Error(`insert failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().id;
}

/** Read one record under a purpose, returning the raw response. */
function readRaw(recordId: string, purpose: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/collections/patients/records/${recordId}`,
    headers: headers({ purpose }),
  });
}

async function read(recordId: string, purpose: string): Promise<Record<string, unknown>> {
  const res = await readRaw(recordId, purpose);
  expect(res.statusCode).toBe(200);
  return res.json();
}

/**
 * Add or remove the tenant's half of the gate for one field, directly.
 *
 * There is no route for this yet — `field_purpose_grants` is written only at
 * declaration time — so the test writes it as owner, the same way the DDL
 * generator would.
 */
async function setFieldGrant(field: string, purpose: string, granted: boolean): Promise<void> {
  const owner = testPool('owner');
  const ids = {
    field: `(SELECT f.id FROM field_definitions f
             JOIN collection_definitions c ON c.id = f.collection_id
             WHERE c.project_id = $1 AND c.name = 'patients' AND f.name = $2)`,
    purpose: `(SELECT id FROM purposes WHERE project_id = $1 AND name = $3)`,
  };

  await owner.query(
    granted
      ? `INSERT INTO field_purpose_grants (field_id, purpose_id)
         VALUES (${ids.field}, ${ids.purpose}) ON CONFLICT DO NOTHING`
      : `DELETE FROM field_purpose_grants
         WHERE field_id = ${ids.field} AND purpose_id = ${ids.purpose}`,
    [project.projectId, field, purpose],
  );
}

beforeAll(async () => {
  project = await provisionProject('data');

  const supportId = await createPurpose(project.projectId, SUPPORT);
  const analyticsId = await createPurpose(project.projectId, ANALYTICS);

  asha = await createPrincipal(project.projectId, { displayName: 'Asha' });
  biju = await createPrincipal(project.projectId, { displayName: 'Biju' });
  chandra = await createPrincipal(project.projectId, { displayName: 'Chandra' });

  // The principal's half of the two-gate check. The tenant's half is declared
  // below, as the `purposes` on each field.
  await grantConsent(asha, supportId, ['full_name', 'phone', 'city']);
  await grantConsent(asha, analyticsId, ['full_name', 'phone', 'city']);
  await grantConsent(biju, supportId, ['phone', 'city']);
  await grantConsent(chandra, supportId, ['full_name', 'phone', 'city']);

  app = await buildApp({
    pools: { runtime: testPool('runtime'), owner: testPool('owner') },
    signingSecret: TEST_SECRET,
  });
  await app.ready();

  const declared = await app.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: headers(),
    payload: {
      name: 'patients',
      fields: [
        {
          name: 'full_name',
          type: 'text',
          sensitivity: 'sensitive',
          mask: 'redact',
          purposes: [SUPPORT],
        },
        {
          name: 'phone',
          type: 'text',
          sensitivity: 'personal',
          mask: 'partial',
          purposes: [SUPPORT],
        },
        {
          // Indexed and non-nullable, so it is the one field this collection
          // can legitimately sort on — keyset pagination needs a total order.
          name: 'city',
          type: 'text',
          sensitivity: 'public',
          mask: 'null',
          purposes: [SUPPORT, ANALYTICS],
          indexed: true,
          nullable: false,
        },
      ],
    },
  });
  if (declared.statusCode !== 201) {
    throw new Error(`declare failed: ${declared.statusCode} ${declared.body}`);
  }

  recordIds.asha = await insert(asha, {
    full_name: 'Asha Menon',
    phone: '+919812345678',
    city: 'Kochi',
  });
  recordIds.biju = await insert(biju, {
    full_name: 'Biju Thomas',
    phone: '+919812340000',
    city: 'Thrissur',
  });
  recordIds.chandra = await insert(chandra, {
    full_name: 'Chandra Iyer',
    phone: '+919812341111',
    city: 'Kollam',
  });
});

afterAll(async () => {
  await app.close();
  await dropProject(project);
  await closePools();
});

describe('field visibility across purposes', () => {
  /**
   * The demonstration the whole design exists for. One row, one database, two
   * callers differing only in declared purpose — and the rows come back
   * different. No service code chose this; the masking view did.
   */
  it('shows one row differently to two purposes', async () => {
    const support = await read(recordIds.asha, SUPPORT);
    expect(support).toMatchObject({
      full_name: 'Asha Menon',
      phone: '+919812345678',
      city: 'Kochi',
    });

    const analytics = await read(recordIds.asha, ANALYTICS);
    expect(analytics).toMatchObject({
      full_name: '***', // redact — analytics holds no grant on this field
      phone: '****5678', // partial — the last four survive, the rest does not
      city: 'Kochi', // granted to both purposes, so identical
    });
  });

  /**
   * Proves the mask above is policy, not a constant.
   *
   * Without this, every masked assertion in this file would still pass if the
   * view had been generated to redact unconditionally — the suite would be
   * measuring nothing. Granting the tenant's half of the gate and re-reading the
   * same row through the same view is the cheapest way to show the `***` moves.
   */
  it('unmasks a field as soon as the tenant grants that purpose access', async () => {
    expect((await read(recordIds.asha, ANALYTICS)).full_name).toBe('***');

    await setFieldGrant('full_name', ANALYTICS, true);
    try {
      expect((await read(recordIds.asha, ANALYTICS)).full_name).toBe('Asha Menon');
    } finally {
      await setFieldGrant('full_name', ANALYTICS, false);
    }

    expect((await read(recordIds.asha, ANALYTICS)).full_name).toBe('***');
  });

  /**
   * A caller must not be able to infer which fields were withheld by noticing a
   * key is missing — the shape is part of the contract, so masked keys stay.
   */
  it('keeps masked fields present, so the response shape is stable', async () => {
    const support = await read(recordIds.asha, SUPPORT);
    const analytics = await read(recordIds.asha, ANALYTICS);

    expect(Object.keys(analytics).sort()).toEqual(Object.keys(support).sort());
  });

  /**
   * The tenant's grant is necessary but not sufficient. Biju consented to
   * support_chat while withholding his name from it, so support — which the
   * tenant does allow to read full_name — still cannot see his.
   */
  it('honours the principal half of the gate even when the tenant grants the field', async () => {
    const asAsha = await read(recordIds.asha, SUPPORT);
    const asBiju = await read(recordIds.biju, SUPPORT);

    expect(asAsha.full_name).toBe('Asha Menon');
    expect(asBiju.full_name).toBe('***');
    // The fields he did agree to are unaffected.
    expect(asBiju).toMatchObject({ phone: '+919812340000', city: 'Thrissur' });
  });
});

describe('row visibility', () => {
  /**
   * Chandra never agreed to analytics, so under that purpose the row is not
   * merely masked — it does not exist. A 404 rather than a 403: telling the
   * caller the row is there but forbidden is itself the leak.
   */
  it('hides a row entirely from a purpose the principal never agreed to', async () => {
    expect((await readRaw(recordIds.chandra, SUPPORT)).statusCode).toBe(200);
    expect((await readRaw(recordIds.chandra, ANALYTICS)).statusCode).toBe(404);
  });

  it('lists only the rows the purpose may see', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/collections/patients/records',
      headers: headers({ purpose: ANALYTICS }),
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json().records.map((r: { id: string }) => r.id);
    // Only Asha consented to analytics; Biju and Chandra are invisible here.
    expect(ids).toEqual([recordIds.asha]);
  });
});

/**
 * A masked column that can still be filtered is not masked. The filter becomes an
 * oracle: `?full_name=Asha Menon` returning a row confirms the value the mask was
 * hiding, and a range filter on a partial mask walks it out character by
 * character. The rejection is a 400 decided before any SQL is built.
 */
describe('masked columns cannot be used as an oracle', () => {
  const list = (purpose: string, query: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/v1/collections/patients/records',
      headers: headers({ purpose }),
      query,
    });

  it('rejects an equality filter on a column the purpose cannot read', async () => {
    const res = await list(ANALYTICS, { full_name: 'Asha Menon' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a range filter on it, which would walk a partial mask out', async () => {
    const res = await list(ANALYTICS, { 'phone.gte': '+91981234' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects sorting by it, which orders rows by a value it will not show', async () => {
    const res = await list(ANALYTICS, { sort: 'full_name:asc' });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The same query under a purpose that may read the column has to work —
   * otherwise the tests above would pass on a service that rejects every filter.
   */
  it('allows the identical filter under a purpose that may read the column', async () => {
    const res = await list(SUPPORT, { full_name: 'Asha Menon' });
    expect(res.statusCode).toBe(200);
    expect(res.json().records.map((r: { id: string }) => r.id)).toEqual([recordIds.asha]);
  });

  it('allows sorting on a column both purposes may read', async () => {
    const res = await list(ANALYTICS, { sort: 'city:asc' });
    expect(res.statusCode).toBe(200);
  });

  /**
   * Refusing a readable-but-ungranted field differently from a field that does
   * not exist turns the error itself into the oracle: a caller could enumerate
   * the collection's shape, and the tenant's purpose grants, from the messages
   * alone. Which fields exist is tenant data too.
   */
  it('answers identically for an ungranted field and one that does not exist', async () => {
    const ungranted = await list(ANALYTICS, { full_name: 'Asha Menon' });
    const absent = await list(ANALYTICS, { no_such_field: 'x' });

    expect(ungranted.statusCode).toBe(absent.statusCode);

    // The two answers differ only where they echo the caller's own input, which
    // tells them nothing they did not just send. Neither reveals that
    // full_name exists on this collection and no_such_field does not.
    expect(ungranted.json().error.message).toBe(
      "Field 'full_name' cannot be used in this query",
    );
    expect(absent.json().error.message).toBe(
      "Field 'no_such_field' cannot be used in this query",
    );
  });
});

/**
 * The DDL generator is the only place a caller-supplied string reaches a CREATE
 * statement, so it is the entire injection surface of the platform.
 */
describe('the DDL generator refuses hostile identifiers', () => {
  const field = { name: 'note', type: 'text', purposes: [SUPPORT] };

  const hostile: Array<[label: string, name: string]> = [
    ['a quoted statement break', 'x"; DROP TABLE patients; --'],
    ['a bare statement break', 'x; DROP TABLE patients'],
    ['a comment terminator', 'x --'],
    ['uppercase, which quoting would preserve as a distinct name', 'Patients'],
    ['a reserved SQL word', 'select'],
    ['a name not starting with a letter', '_notes'],
  ];

  for (const [label, name] of hostile) {
    it(`rejects ${label}`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/collections',
        headers: headers(),
        payload: { name, fields: [field] },
      });

      expect(res.statusCode).toBe(400);
    });
  }

  it('rejects a hostile field name just as firmly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/collections',
      headers: headers(),
      payload: {
        name: 'notes',
        fields: [{ name: 'x"; DROP TABLE patients; --', type: 'text', purposes: [SUPPORT] }],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  /**
   * The assertions above only prove a 400 was returned. This proves the attempts
   * were inert: the table they targeted is still there, still readable.
   */
  it('leaves the targeted table intact', async () => {
    const res = await readRaw(recordIds.asha, SUPPORT);
    expect(res.statusCode).toBe(200);
    expect(res.json().full_name).toBe('Asha Menon');
  });
});
