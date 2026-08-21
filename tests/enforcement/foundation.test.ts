import { afterAll, describe, expect, it } from 'vitest';
import { withContext, withTransaction } from '@setu/db';
import { closePools, testPool } from '../helpers/fixtures.js';
import { provisionProject, dropProject, type TestProject } from '../helpers/fixtures.js';

afterAll(closePools);

describe('runtime roles', () => {
  /**
   * Load-bearing. Superusers and BYPASSRLS roles ignore row-level security
   * entirely, so if this ever regresses, every other enforcement test in this
   * repository silently starts passing for the wrong reason.
   */
  it('cannot bypass RLS', async () => {
    const res = await testPool('owner').query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolname IN ('setu_runtime', 'setu_control') ORDER BY rolname`,
    );

    expect(res.rows).toHaveLength(2);
    for (const role of res.rows) {
      expect(role.rolsuper, `${role.rolname} must not be a superuser`).toBe(false);
      expect(role.rolbypassrls, `${role.rolname} must not have BYPASSRLS`).toBe(false);
    }
  });

  it('denies the read-path role any write to consent state', async () => {
    const res = await testPool('runtime').query<{ ok: boolean }>(
      `SELECT has_table_privilege('setu_runtime', 'consent_artifacts', 'INSERT') AS ok`,
    );
    expect(res.rows[0].ok).toBe(false);
  });

  it('allows the control-path role to write consent state', async () => {
    const res = await testPool('runtime').query<{ ok: boolean }>(
      `SELECT has_table_privilege('setu_control', 'consent_artifacts', 'INSERT') AS ok`,
    );
    expect(res.rows[0].ok).toBe(true);
  });
});

describe('withContext', () => {
  let project: TestProject;

  afterAll(async () => {
    if (project) await dropProject(project);
  });

  it('exposes the request context to the transaction', async () => {
    project = await provisionProject('ctx');

    const settings = await withContext(
      testPool('runtime'),
      { projectId: project.projectId, purpose: 'billing', principalId: undefined },
      async (client) => {
        const res = await client.query<{ project_id: string; purpose: string }>(
          `SELECT current_setting('app.project_id', true) AS project_id,
                  current_setting('app.purpose', true)    AS purpose`,
        );
        return res.rows[0];
      },
    );

    expect(settings.project_id).toBe(project.projectId);
    expect(settings.purpose).toBe('billing');
  });

  /**
   * The whole reason for set_config(..., is_local => true). If context survived
   * the transaction it would leak onto the pooled connection and be read by
   * whichever tenant's query ran next.
   */
  it('does not leak context beyond the transaction', async () => {
    const pool = testPool('runtime');

    await withContext(pool, { projectId: project.projectId, purpose: 'analytics' }, async () => {
      // no-op; we only care what survives the COMMIT
    });

    const leaked = await withTransaction(pool, async (client) => {
      const res = await client.query<{ purpose: string | null }>(
        `SELECT current_setting('app.purpose', true) AS purpose`,
      );
      return res.rows[0].purpose;
    });

    expect(leaked === null || leaked === '').toBe(true);
  });
});
