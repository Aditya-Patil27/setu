import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error — the seed runner is plain JS with no type declarations.
import { COLLECTION_FIELDS, PRINCIPALS, PURPOSES } from '../../scripts/seed.mjs';
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
import { TEST_SECRET, signedHeaders } from '../helpers/http.js';

/**
 * The demo says what it will do; this checks it does it.
 *
 * scripts/seed.mjs prints a walkthrough claiming that delivery_partner sees the
 * address but never the amount, that analytics sees neither name nor phone, and
 * so on. Those sentences are the first thing anyone reads about this platform,
 * and nothing else would catch them going stale — the seed would keep printing
 * them long after a changed grant made them false.
 *
 * So the constants are imported from the seed itself rather than restated here.
 * A field grant edited in one place and not the other fails this suite.
 */

interface Field {
  name: string;
  type: string;
  sensitivity?: string;
  mask?: string;
  purposes?: string[];
}

interface PrincipalSpec {
  displayName: string;
  phone: string;
  consents: Record<string, string[]>;
}

const fields = COLLECTION_FIELDS as Field[];
const principals = PRINCIPALS as PrincipalSpec[];
const purposeNames = (PURPOSES as Array<[string, string, string]>).map(([n]) => n);

const ORDERS: Record<string, Record<string, string>> = {
  'Asha Menon': {
    customer_name: 'Asha Menon',
    phone: '+919812345678',
    address: '12 MG Road, Pune',
    city: 'Pune',
    item: 'Masala Dosa',
    amount: '240.00',
  },
  'Biju Thomas': {
    customer_name: 'Biju Thomas',
    phone: '+919812340000',
    address: '7 Marine Drive, Kochi',
    city: 'Kochi',
    item: 'Appam',
    amount: '180.00',
  },
  'Priya Nair': {
    customer_name: 'Priya Nair',
    phone: '+919812341111',
    address: '44 Residency Road, Bengaluru',
    city: 'Bengaluru',
    item: 'Filter Coffee',
    amount: '90.00',
  },
};

let data: FastifyInstance;
let project: TestProject;
const principalIds: Record<string, string> = {};

const headers = (purpose?: string) =>
  signedHeaders({ tenantId: project.tenantId, projectId: project.projectId, purpose });

async function read(purpose: string): Promise<Array<Record<string, unknown>>> {
  const res = await data.inject({
    method: 'GET',
    url: '/v1/collections/orders/records',
    headers: headers(purpose),
  });
  if (res.statusCode !== 200) throw new Error(`${purpose}: ${res.statusCode} ${res.body}`);
  return (res.json() as { records: Array<Record<string, unknown>> }).records;
}

/** The row belonging to one customer, as this purpose may see it. */
function rowFor(rows: Array<Record<string, unknown>>, name: string) {
  return rows.find((r) => r.principalId === principalIds[name]);
}

beforeAll(async () => {
  project = await provisionProject('demo');

  const purposeIds: Record<string, string> = {};
  for (const name of purposeNames) {
    purposeIds[name] = await createPurpose(project.projectId, name);
  }

  for (const spec of principals) {
    const id = await createPrincipal(project.projectId, { displayName: spec.displayName });
    principalIds[spec.displayName] = id;

    for (const [purpose, granted] of Object.entries(spec.consents)) {
      await grantConsent(id, purposeIds[purpose], granted);
    }
  }

  data = await buildData({
    pools: { runtime: testPool('runtime'), owner: testPool('owner') },
    signingSecret: TEST_SECRET,
  });

  const declared = await data.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: headers(),
    payload: { name: 'orders', fields },
  });
  if (declared.statusCode !== 201) {
    throw new Error(`declare failed: ${declared.statusCode} ${declared.body}`);
  }

  for (const [name, order] of Object.entries(ORDERS)) {
    const created = await data.inject({
      method: 'POST',
      url: '/v1/collections/orders/records',
      // delivery_partner is the one purpose every customer consented to.
      headers: headers('delivery_partner'),
      payload: { principalId: principalIds[name], ...order },
    });
    if (created.statusCode !== 201) {
      throw new Error(`create ${name} failed: ${created.statusCode} ${created.body}`);
    }
  }
});

afterAll(async () => {
  await data.close();
  await dropProject(project);
  await closePools();
});

describe('the collection the seed declares', () => {
  it('is accepted by the DDL generator exactly as printed', () => {
    // Proven by beforeAll having declared it; this states the intent.
    expect(fields.map((f) => f.name)).toEqual([
      'customer_name',
      'phone',
      'address',
      'city',
      'item',
      'amount',
    ]);
  });

  it('masks the phone partially, which is what a delivery app actually shows', () => {
    expect(fields.find((f) => f.name === 'phone')?.mask).toBe('partial');
  });
});

describe('no purpose is a superset of another', () => {
  const grantsFor = (purpose: string) =>
    new Set(fields.filter((f) => f.purposes?.includes(purpose)).map((f) => f.name));

  it('gives each purpose a slice no other purpose contains', () => {
    const delivery = grantsFor('delivery_partner');
    const analytics = grantsFor('analytics');

    // The claim the whole demo rests on: this cannot be expressed as a role
    // hierarchy, because neither side dominates the other.
    expect(delivery.has('address')).toBe(true);
    expect(analytics.has('address')).toBe(false);

    expect(analytics.has('amount')).toBe(true);
    expect(delivery.has('amount')).toBe(false);
  });
});

describe('what each purpose actually sees', () => {
  it('delivery_partner sees the address and never the amount', async () => {
    const row = rowFor(await read('delivery_partner'), 'Asha Menon');

    expect(row?.address).toBe('12 MG Road, Pune');
    expect(row?.customer_name).toBe('Asha Menon');
    // Not granted to this purpose, so masked to null — the only strategy a
    // numeric column can use.
    expect(row?.amount).toBeNull();
  });

  it('support_chat sees the amount and never the address', async () => {
    const row = rowFor(await read('support_chat'), 'Asha Menon');

    expect(row?.amount).toBe('240.00');
    expect(row?.item).toBe('Masala Dosa');
    expect(row?.address).toBe('***');
  });

  it('analytics sees neither the name nor the address', async () => {
    const row = rowFor(await read('analytics'), 'Asha Menon');

    expect(row?.customer_name).toBe('***');
    expect(row?.address).toBe('***');

    /**
     * The phone is masked, but to '****5678' rather than '***', because the
     * mask strategy belongs to the field and not to the purpose reading it.
     * Asserted explicitly because it is a real disclosure decision: a partial
     * mask hands every ungranted purpose the last four digits, and a tenant who
     * finds that too much must declare the field 'redact' or 'hash' instead.
     */
    expect(row?.phone).toBe('****5678');

    // What the purpose actually exists for still reads through.
    expect(row?.city).toBe('Pune');
    expect(row?.amount).toBe('240.00');
  });
});

describe('the two gates are independent', () => {
  it('hides Biju from analytics entirely, because he never consented to it', async () => {
    const rows = await read('analytics');

    expect(rowFor(rows, 'Biju Thomas')).toBeUndefined();
    // Row visibility, not field masking: the others are still there.
    expect(rowFor(rows, 'Asha Menon')).toBeDefined();
    expect(rowFor(rows, 'Priya Nair')).toBeDefined();
  });

  it('masks the phone for delivery_partner, though every customer consented to it', async () => {
    // The mirror image of the test below: here the principal agreed and the
    // tenant did not grant the field to this purpose, so it is masked anyway.
    const row = rowFor(await read('delivery_partner'), 'Asha Menon');

    expect(row?.phone).toBe('****5678');
    // And the fields the tenant did grant are unaffected.
    expect(row?.address).toBe('12 MG Road, Pune');
  });

  it("masks Priya's phone under support, though the tenant granted that field", async () => {
    const rows = await read('support_chat');

    // The tenant grants phone to support_chat for the whole collection; Priya
    // withheld it. Her consent alone is what makes these two rows differ.
    expect(rowFor(rows, 'Asha Menon')?.phone).toBe('+919812345678');
    expect(rowFor(rows, 'Priya Nair')?.phone).toBe('****1111');
  });
});
