import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../services/functions/src/app.js';
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

/**
 * Server-side code is where "the database decides" could quietly stop being
 * true. A function is a caller the tenant wrote, so if an invocation may name
 * any purpose it likes, the function becomes a way to launder a read the purpose
 * system would otherwise refuse. Most of what follows is about that one claim.
 */

const SUPPORT = 'support_chat';
const ANALYTICS = 'analytics';

let app: FastifyInstance;
let project: TestProject;
let principalId: string;

const headers = (purpose?: string, p: TestProject = project) =>
  signedHeaders({ tenantId: p.tenantId, projectId: p.projectId, purpose });

const define = (body: Record<string, unknown>, purpose?: string) =>
  app.inject({ method: 'POST', url: '/v1/functions', headers: headers(purpose), payload: body });

const invoke = (name: string, purpose?: string, input?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/v1/functions/${name}/invoke`,
    headers: headers(purpose),
    payload: { input },
  });

beforeAll(async () => {
  project = await provisionProject('fn');
  await createPurpose(project.projectId, SUPPORT);
  await createPurpose(project.projectId, ANALYTICS);
  principalId = await createPrincipal(project.projectId, { displayName: 'Asha' });

  app = await buildApp({ pools: { control: testPool('control') }, signingSecret: TEST_SECRET });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await dropProject(project);
  await closePools();
});

describe('a function may only run as something it declared', () => {
  beforeAll(async () => {
    const res = await define({
      name: 'summarise',
      purposes: [SUPPORT],
      source: 'export default async (input, context) => ({ seen: context.purpose, input });',
    });
    expect(res.statusCode).toBe(201);
  });

  it('runs under a purpose it declared, and is told which', async () => {
    const res = await invoke('summarise', SUPPORT, { id: 7 });

    expect(res.statusCode).toBe(200);
    expect(res.json().execution.status).toBe('succeeded');
    expect(res.json().output).toEqual({ seen: SUPPORT, input: { id: 7 } });
  });

  /**
   * The laundering attempt. The function declares support_chat; the caller asks
   * for analytics. No code runs — the function never gets to decide for itself.
   */
  it('refuses a purpose it did not declare, without running', async () => {
    const res = await invoke('summarise', ANALYTICS, { id: 7 });

    expect(res.statusCode).toBe(403);

    const executions = await app.inject({
      method: 'GET',
      url: '/v1/functions/summarise/executions',
      headers: headers(SUPPORT),
    });
    // Only the successful invocation above was ever recorded.
    expect(executions.json().executions).toHaveLength(1);
  });

  /**
   * The same hole from the other side: invoked with no purpose, the function
   * would run, read nothing, and return an empty result that looks like absent
   * data rather than a refused request.
   */
  it('refuses to run a purpose-bearing function with no purpose at all', async () => {
    const res = await invoke('summarise', undefined, { id: 7 });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to let a function with no declared purposes bind one', async () => {
    await define({ name: 'formatter', source: 'export default async () => "ok";' });

    expect((await invoke('formatter', undefined)).statusCode).toBe(200);
    expect((await invoke('formatter', SUPPORT)).statusCode).toBe(403);
  });

  it('refuses to define a function against an unregistered purpose', async () => {
    const res = await define({
      name: 'bogus',
      purposes: ['not_registered'],
      source: 'export default async () => 1;',
    });
    expect(res.statusCode).toBe(400);
  });

  it('records the purpose each execution ran under', async () => {
    await invoke('summarise', SUPPORT, {});

    const rows = await testPool('owner').query<{ name: string | null }>(
      `SELECT p.name
         FROM function_executions e
         LEFT JOIN purposes p ON p.id = e.purpose_id
        WHERE e.project_id = $1 AND p.name IS NOT NULL`,
      [project.projectId],
    );
    expect(rows.rows.every((r) => r.name === SUPPORT)).toBe(true);
  });
});

describe('what tenant code is handed', () => {
  /**
   * The load-bearing one for isolation. A function that could read
   * INTERNAL_SIGNING_SECRET could forge any context it liked, which would end
   * the purpose system entirely. Stripping the environment is not enough on its
   * own: with the filesystem it could read /proc or the service's .env, and with
   * a socket it could reach the services directly. So it gets neither, and no
   * process object to look in.
   */
  it('has no process, module loader or network to reach the platform with', async () => {
    await define({
      name: 'peek',
      purposes: [SUPPORT],
      source: `export default async () => ({
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        WebSocket: typeof WebSocket,
        Buffer: typeof Buffer,
      });`,
    });

    const res = await invoke('peek', SUPPORT);

    expect(res.json().execution.status).toBe('succeeded');
    expect(res.json().output).toEqual({
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      WebSocket: 'undefined',
      Buffer: 'undefined',
    });
  });

  it('cannot import a Node built-in', async () => {
    await define({
      name: 'lister',
      purposes: [SUPPORT],
      source: `import { readdirSync } from 'node:fs';
        export default async () => readdirSync('.');`,
    });

    const res = await invoke('lister', SUPPORT);

    expect(res.json().execution.status).toBe('failed');
    expect(res.json().execution.stderr).toContain('failed to load function');
    expect(res.json().output).toBeNull();
  });

  it('cannot import one dynamically either', async () => {
    await define({
      name: 'dialer',
      purposes: [SUPPORT],
      source: `export default async () => {
        const net = await import('node:net');
        return typeof net.createConnection;
      };`,
    });

    const res = await invoke('dialer', SUPPORT);

    expect(res.json().execution.status).toBe('failed');
    expect(res.json().output).toBeNull();
  });

  it('is given the request context as facts, with no credentials among them', async () => {
    await define({
      name: 'context',
      purposes: [SUPPORT],
      source: 'export default async (_input, context) => Object.keys(context).sort();',
    });

    // An absent principal is omitted rather than sent as null, so the assertion
    // is that nothing beyond these four facts is ever present — not that all
    // four always are.
    const allowed = ['principalId', 'projectId', 'purpose', 'requestId'];

    const anonymous = await invoke('context', SUPPORT);
    expect(anonymous.json().output).toEqual(['projectId', 'purpose', 'requestId']);
    expect(anonymous.json().output.every((k: string) => allowed.includes(k))).toBe(true);

    // With a principal, it arrives — and still nothing else does.
    const asPrincipal = await app.inject({
      method: 'POST',
      url: '/v1/functions/context/invoke',
      headers: signedHeaders({
        tenantId: project.tenantId,
        projectId: project.projectId,
        purpose: SUPPORT,
        principalId,
      }),
      payload: {},
    });
    expect(asPrincipal.json().output).toEqual(allowed);
  });
});

describe('a function that misbehaves', () => {
  it('is killed when it exceeds its timeout', async () => {
    await define({
      name: 'spinner',
      purposes: [SUPPORT],
      timeoutS: 1,
      source: 'export default async () => { while (true) {} };',
    });

    const res = await invoke('spinner', SUPPORT);

    expect(res.statusCode).toBe(200);
    expect(res.json().timedOut).toBe(true);
    expect(res.json().execution.status).toBe('failed');
    expect(res.json().execution.stderr).toContain('timeout');
  }, 30_000);

  it('is stopped when it exceeds its memory limit', async () => {
    await define({
      name: 'hoarder',
      purposes: [SUPPORT],
      memoryMb: 32,
      source: `export default async () => {
        const hoard = [];
        for (;;) hoard.push(new Array(1e6).fill(hoard.length));
      };`,
    });

    const res = await invoke('hoarder', SUPPORT);

    expect(res.statusCode).toBe(200);
    expect(res.json().execution.status).toBe('failed');
    expect(res.json().output).toBeNull();
  }, 30_000);

  /** A throwing function is a failed execution, not a broken platform. */
  it('records a thrown error as a failure rather than a 500', async () => {
    await define({
      name: 'thrower',
      purposes: [SUPPORT],
      source: 'export default async () => { throw new Error("deliberate"); };',
    });

    const res = await invoke('thrower', SUPPORT);

    expect(res.statusCode).toBe(200);
    expect(res.json().execution.status).toBe('failed');
    expect(res.json().execution.stderr).toContain('deliberate');
    expect(res.json().output).toBeNull();
  });

  it('reports a syntax error in tenant source as a load failure', async () => {
    await define({ name: 'broken', purposes: [SUPPORT], source: 'export default async ( => {' });

    const res = await invoke('broken', SUPPORT);
    expect(res.json().execution.status).toBe('failed');
    expect(res.json().execution.stderr).toContain('failed to load function');
  });

  it('reports source that exports no handler', async () => {
    await define({ name: 'nohandler', purposes: [SUPPORT], source: 'export const x = 1;' });

    const res = await invoke('nohandler', SUPPORT);
    expect(res.json().execution.status).toBe('failed');
    expect(res.json().execution.stderr).toContain('handler');
  });

  /**
   * The sentinel the harness uses to carry a return value is random per
   * invocation, so a function printing a guessed one cannot forge its own output.
   */
  it('cannot forge a return value by printing a sentinel', async () => {
    await define({
      name: 'forger',
      purposes: [SUPPORT],
      source: `export default async () => {
        console.log('__SETU_OUT_deadbeefdeadbeefdeadbeef__{"admin":true}');
        return { admin: false };
      };`,
    });

    const res = await invoke('forger', SUPPORT);
    expect(res.json().output).toEqual({ admin: false });
  });

  it('captures stdout without letting it become the result', async () => {
    await define({
      name: 'chatty',
      purposes: [SUPPORT],
      source: 'export default async () => { console.log("working"); return 42; };',
    });

    const res = await invoke('chatty', SUPPORT);
    expect(res.json().execution.stdout).toContain('working');
    expect(res.json().output).toBe(42);
  });
});

describe('definitions', () => {
  it('refuses a duplicate name', async () => {
    await define({ name: 'dupe', source: 'export default async () => 1;' });
    const again = await define({ name: 'dupe', source: 'export default async () => 2;' });
    expect(again.statusCode).toBe(409);
  });

  it('refuses limits outside what a shared host will give', async () => {
    expect(
      (await define({ name: 'greedy', source: 'export default async()=>1;', timeoutS: 86_400 }))
        .statusCode,
    ).toBe(400);
    expect(
      (await define({ name: 'greedy2', source: 'export default async()=>1;', memoryMb: 8192 }))
        .statusCode,
    ).toBe(400);
  });

  it('never returns source in a listing', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/functions', headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain('export default');
  });

  it('shows a project nothing but its own functions', async () => {
    const other = await provisionProject('fnother');
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/functions',
        headers: headers(undefined, other),
      });
      expect(res.json().functions).toEqual([]);
    } finally {
      await dropProject(other);
    }
  });

  it('refuses an unsigned request', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/functions' });
    expect(res.statusCode).toBe(401);
  });

  it('deletes a function and its executions with it', async () => {
    await define({ name: 'transient', purposes: [SUPPORT], source: 'export default async()=>1;' });
    await invoke('transient', SUPPORT);

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/functions/transient',
      headers: headers(),
    });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: '/v1/functions/transient',
      headers: headers(),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('attributes an execution to the invoking principal', async () => {
    await define({ name: 'attributed', purposes: [SUPPORT], source: 'export default async()=>1;' });
    await app.inject({
      method: 'POST',
      url: '/v1/functions/attributed/invoke',
      headers: signedHeaders({
        tenantId: project.tenantId,
        projectId: project.projectId,
        purpose: SUPPORT,
        principalId,
      }),
      payload: {},
    });

    const rows = await testPool('owner').query<{ principal_id: string }>(
      `SELECT e.principal_id FROM function_executions e
         JOIN function_definitions f ON f.id = e.function_id
        WHERE f.name = 'attributed'`,
    );
    expect(rows.rows[0].principal_id).toBe(principalId);
  });
});
