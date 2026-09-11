import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp as buildAi } from '../../services/ai/src/app.js';
import { buildApp as buildData } from '../../services/data/src/app.js';
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
import { TEST_SECRET, signedHeaders } from '../helpers/http.js';

/**
 * Consent-bound inference.
 *
 * The claim under test is narrow and checkable: the text handed to a model is
 * the masked projection of a row, so a value this purpose was not granted is
 * not merely filtered from the answer — it never enters the process. And an
 * embedding, being derived from that projection, carries the same consent as
 * the data it came from.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';

let ai: FastifyInstance;
let data: FastifyInstance;
let project: TestProject;
let principalId: string;
let otherPrincipalId: string;
let supportConsentId: string;

const pools = () => ({ runtime: testPool('runtime') });

async function embed(purpose: string) {
  return ai.inject({
    method: 'POST',
    url: '/v1/ai/embeddings',
    headers: signedHeaders({ tenantId: project.tenantId, projectId: project.projectId, purpose }),
    payload: { collection: 'patients' },
  });
}

async function ask(purpose: string, question: string) {
  return ai.inject({
    method: 'POST',
    url: '/v1/ai/ask',
    headers: signedHeaders({ tenantId: project.tenantId, projectId: project.projectId, purpose }),
    payload: { collection: 'patients', question },
  });
}

async function countVectors(): Promise<number> {
  // As owner, so this counts what is actually stored rather than what policy
  // would show — the distinction the erasure tests below depend on.
  const res = await testPool('owner').query<{ n: string }>(
    `SELECT count(*) AS n FROM record_embeddings WHERE project_id = $1`,
    [project.projectId],
  );
  return Number(res.rows[0].n);
}

beforeAll(async () => {
  project = await provisionProject('ai');

  const supportId = await createPurpose(project.projectId, SUPPORT);
  const analyticsId = await createPurpose(project.projectId, ANALYTICS);

  principalId = await createPrincipal(project.projectId, { displayName: 'Asha' });
  otherPrincipalId = await createPrincipal(project.projectId, { displayName: 'Vikram' });

  supportConsentId = await grantConsent(principalId, supportId, ['full_name', 'city']);
  await grantConsent(principalId, analyticsId, ['city']);
  await grantConsent(otherPrincipalId, supportId, ['full_name', 'city']);

  data = await buildData({
    pools: { runtime: testPool('runtime'), owner: testPool('owner') },
    signingSecret: TEST_SECRET,
  });
  ai = await buildAi({ pools: pools(), signingSecret: TEST_SECRET });

  const declared = await data.inject({
    method: 'POST',
    url: '/v1/collections',
    headers: signedHeaders({ tenantId: project.tenantId, projectId: project.projectId }),
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

  for (const [pid, name, city] of [
    [principalId, 'Asha Menon', 'Pune'],
    [otherPrincipalId, 'Vikram Rao', 'Kochi'],
  ] as const) {
    const created = await data.inject({
      method: 'POST',
      url: '/v1/collections/patients/records',
      headers: signedHeaders({
        tenantId: project.tenantId,
        projectId: project.projectId,
        purpose: SUPPORT,
      }),
      payload: { principalId: pid, full_name: name, city },
    });
    if (created.statusCode !== 201) {
      throw new Error(`create failed: ${created.statusCode} ${created.body}`);
    }
  }
});

afterAll(async () => {
  await ai.close();
  await data.close();
  await dropProject(project);
  await closePools();
});

describe('an embedding is scoped to the purpose it was built under', () => {
  it('builds a vector per row for the purpose that asked', async () => {
    const res = await embed(SUPPORT);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ collection: 'patients', purpose: SUPPORT, embedded: 2 });
  });

  it('embeds only the rows the purpose can see at all', async () => {
    // Vikram consented to support_chat and not to analytics, so row-level
    // security hides his record from this purpose entirely — before any text is
    // rendered and before the embedder is reached. Row visibility gates what can
    // be derived, not only what can be read.
    const res = await embed(ANALYTICS);
    expect(res.json()).toMatchObject({ purpose: ANALYTICS, embedded: 1 });

    // Two vectors for Asha (one per purpose), one for Vikram under support.
    expect(await countVectors()).toBe(3);
  });

  it('gives the same row different vectors under different purposes', async () => {
    const res = await testPool('owner').query<{ purpose_id: string; content_hash: string }>(
      `SELECT e.purpose_id, e.content_hash
         FROM record_embeddings e
         JOIN principals pr ON pr.id = e.principal_id
        WHERE pr.id = $1`,
      [principalId],
    );

    const hashes = new Set(res.rows.map((r) => r.content_hash));
    // The masked text differs (full name vs ***), so the derived vector must too.
    expect(hashes.size).toBe(2);
  });

  it('re-running embeds nothing when the masked text has not changed', async () => {
    const res = await embed(SUPPORT);
    expect(res.json()).toMatchObject({ embedded: 0, unchanged: 2 });
  });
});

describe('what reaches the prompt', () => {
  it('includes the name for a purpose granted it', async () => {
    const res = await ask(SUPPORT, 'who lives in Pune?');
    const body = res.json() as { answer: string; fields: string[] };

    expect(res.statusCode).toBe(200);
    expect(body.answer).toContain('Asha Menon');
    expect(body.fields).toContain('full_name');
  });

  it('cannot contain the name for a purpose that was not', async () => {
    const res = await ask(ANALYTICS, 'who lives in Pune?');
    const body = res.json() as {
      answer: string;
      context: Array<{ fields: Record<string, unknown> }>;
    };

    // Not merely absent from the answer — absent from everything the model saw.
    expect(body.answer).not.toContain('Asha Menon');
    expect(JSON.stringify(body.context)).not.toContain('Asha Menon');

    // The field is present and redacted, so the shape stays stable.
    expect(body.context[0].fields.full_name).toBe('***');
  });

  it('returns the context alongside the answer, as the receipt for it', async () => {
    const res = await ask(SUPPORT, 'anyone in Kochi?');
    const body = res.json() as { context: Array<{ id: string; distance: number }> };

    expect(body.context.length).toBeGreaterThan(0);
    expect(typeof body.context[0].distance).toBe('number');
  });
});

describe('revocation', () => {
  it('makes a principal vanish from retrieval', async () => {
    const before = await ask(SUPPORT, 'who lives in Pune?');
    expect(JSON.stringify(before.json())).toContain('Asha Menon');

    await revokeConsent(supportConsentId);

    const after = await ask(SUPPORT, 'who lives in Pune?');
    const body = after.json() as { context: Array<{ fields: Record<string, unknown> }> };

    expect(JSON.stringify(body)).not.toContain('Asha Menon');
    // The other principal is untouched: revocation is per person, not per project.
    expect(JSON.stringify(body)).toContain('Vikram Rao');
  });

  it('deletes the derived vectors, rather than only hiding them', async () => {
    // Counted as owner, past every policy. Hiding and erasing are different
    // obligations, and this is the one RLS cannot discharge.
    const remaining = await testPool('owner').query<{ n: string }>(
      `SELECT count(*) AS n FROM record_embeddings e
         JOIN purposes p ON p.id = e.purpose_id
        WHERE e.principal_id = $1 AND p.name = $2`,
      [principalId, SUPPORT],
    );

    expect(Number(remaining.rows[0].n)).toBe(0);
  });

  it('leaves vectors built under a purpose that was not revoked', async () => {
    const other = await testPool('owner').query<{ n: string }>(
      `SELECT count(*) AS n FROM record_embeddings e
         JOIN purposes p ON p.id = e.purpose_id
        WHERE e.principal_id = $1 AND p.name = $2`,
      [principalId, ANALYTICS],
    );

    expect(Number(other.rows[0].n)).toBe(1);
  });
});

describe('the trail', () => {
  it('records an inference against every principal whose data reached the prompt', async () => {
    const res = await testPool('owner').query<{ action: string; fields: string[] }>(
      `SELECT action, fields FROM audit_records
        WHERE project_id = $1 AND action = 'infer' AND principal_id = $2`,
      [project.projectId, otherPrincipalId],
    );

    expect(res.rowCount).toBeGreaterThan(0);
    expect(res.rows[0].fields).toContain('city');
  });
});

describe('purpose is required, with no exception', () => {
  it('refuses to embed without one', async () => {
    const res = await ai.inject({
      method: 'POST',
      url: '/v1/ai/embeddings',
      headers: signedHeaders({ tenantId: project.tenantId, projectId: project.projectId }),
      payload: { collection: 'patients' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses to answer without one', async () => {
    const res = await ai.inject({
      method: 'POST',
      url: '/v1/ai/ask',
      headers: signedHeaders({ tenantId: project.tenantId, projectId: project.projectId }),
      payload: { collection: 'patients', question: 'who?' },
    });

    expect(res.statusCode).toBe(400);
  });
});
