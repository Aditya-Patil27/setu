import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What a function is told about the request that invoked it.
 *
 * Facts, not capabilities. In particular no database credentials and no signing
 * secret: a function that could sign its own context could name its own purpose,
 * which is the whole thing the purpose system exists to prevent.
 */
export interface InvocationContext {
  requestId: string;
  projectId: string;
  purpose?: string;
  principalId?: string;
}

export interface InvocationRequest {
  source: string;
  input: unknown;
  timeoutMs: number;
  memoryMb: number;
  context: InvocationContext;
}

export interface InvocationResult {
  status: 'succeeded' | 'failed';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  output: unknown;
  timedOut: boolean;
}

export interface FunctionRuntime {
  invoke(req: InvocationRequest): Promise<InvocationResult>;
}

const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Installed inside the isolate before tenant code loads. It is the only bridge
 * out: text to stdout or stderr. The host write function is captured in a
 * closure and its global removed, so tenant code cannot call it directly.
 */
const CONSOLE_SHIM = `(() => {
  const write = globalThis.__setu_write;
  delete globalThis.__setu_write;
  const format = (args) => args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack ?? String(a);
    try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
  }).join(' ');
  const out = (...a) => write(1, format(a));
  const err = (...a) => write(2, format(a));
  globalThis.console = Object.freeze({ log: out, info: out, debug: out, warn: err, error: err });
})();`;

/**
 * The harness the child actually runs. The child is plain Node; tenant code is
 * not. It runs in a V8 isolate inside the child, which has the language and the
 * console above, and nothing else: no process, no require, no fetch, no timers,
 * and an import resolver that refuses every specifier.
 *
 * The handler's result is serialised inside the isolate, so a toJSON or getter
 * the tenant wrote runs there and never in the host.
 *
 * The sentinel is random per invocation: a function that printed a fixed one on
 * purpose would otherwise be able to forge its own return value.
 */
function harness(sentinel: string, isolatedVmPath: string): string {
  return `
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const ivm = createRequire(import.meta.url)(${JSON.stringify(isolatedVmPath)});
const payload = JSON.parse(readFileSync(process.argv[2], 'utf8'));

function fail(prefix, err) {
  process.stderr.write(prefix + ((err && err.stack) || String(err)) + '\\n');
  process.exit(1);
}

const isolate = new ivm.Isolate({ memoryLimit: payload.memoryMb });
const context = await isolate.createContext();

// Synchronous, so every log line is written before the handler can return and
// none can land after the sentinel the parent parses the result from.
await context.global.set(
  '__setu_write',
  new ivm.Callback((fd, text) => (fd === 2 ? process.stderr : process.stdout).write(text + '\\n'), { sync: true }),
);
await context.eval(${JSON.stringify(CONSOLE_SHIM)});

let handler;
try {
  const mod = await isolate.compileModule(payload.source, { filename: 'function.mjs' });
  await mod.instantiate(context, (specifier) => {
    throw new Error('cannot import "' + specifier + '": functions run without modules or Node APIs');
  });
  await mod.evaluate();
  handler = await mod.namespace.get('default', { reference: true });
  if (handler.typeof !== 'function') handler = await mod.namespace.get('handler', { reference: true });
} catch (err) {
  fail('failed to load function: ', err);
}

if (handler.typeof !== 'function') {
  process.stderr.write('function must export a default or named "handler" function\\n');
  process.exit(1);
}

try {
  const run = await context.eval(
    '(async (handler, input, context) => { const out = await handler(input, context); return JSON.stringify(out === undefined ? null : out); })',
    { reference: true },
  );
  const json = await run.apply(undefined, [handler.derefInto(), payload.input, payload.context], {
    arguments: { copy: true },
    result: { promise: true, copy: true },
  });
  process.stdout.write('\\n${sentinel}' + json);
} catch (err) {
  fail('', err);
}
`;
}

/**
 * Run each invocation in a fresh Node process, with the tenant's code inside a
 * V8 isolate in that process.
 *
 * The isolate is the sandbox: tenant code can compute and log, and cannot touch
 * the filesystem, the network, the environment or any module. The process
 * around it is the backstop: its own heap, a timeout enforced by SIGKILL that
 * holds even if the isolate wedges, and an environment stripped of every
 * platform secret in case the isolate is ever escaped.
 *
 * Isolation is V8's, not the kernel's. A V8 escape lands in a process with no
 * secrets but the service user's filesystem view, so a deployment that admits
 * untrusted tenants should still run this service under gVisor or in a microVM.
 * Nothing above this interface changes when it does.
 */
export function createSubprocessRuntime(): FunctionRuntime {
  // Resolved here, because the harness runs from a temp directory where a bare
  // 'isolated-vm' specifier would not find the service's node_modules.
  const isolatedVmPath = require.resolve('isolated-vm');

  return {
    async invoke(req) {
      const sentinel = `__SETU_OUT_${randomBytes(12).toString('hex')}__`;
      const dir = await mkdtemp(join(tmpdir(), `setu-fn-${randomUUID()}-`));
      const started = Date.now();

      try {
        await writeFile(join(dir, 'run.mjs'), harness(sentinel, isolatedVmPath), 'utf8');
        await writeFile(
          join(dir, 'payload.json'),
          JSON.stringify({
            source: req.source,
            input: req.input,
            context: req.context,
            memoryMb: req.memoryMb,
          }),
          'utf8',
        );

        const result = await new Promise<{
          code: number | null;
          stdout: string;
          stderr: string;
          killed: boolean;
        }>((resolve) => {
          const child = execFile(
            process.execPath,
            [
              // Required by isolated-vm on Node 20 and later (see its README).
              '--no-node-snapshot',
              `--max-old-space-size=${req.memoryMb}`,
              join(dir, 'run.mjs'),
              join(dir, 'payload.json'),
            ],
            {
              cwd: dir,
              timeout: req.timeoutMs,
              killSignal: 'SIGKILL',
              maxBuffer: MAX_OUTPUT_BYTES,
              // A deliberately bare environment. Inheriting process.env would
              // hand tenant code POSTGRES_PASSWORD, JWT_SECRET and
              // INTERNAL_SIGNING_SECRET, and the last of those is enough to
              // forge any context it likes.
              env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
            },
            (err, stdout, stderr) => {
              const killed =
                Boolean(err && ('killed' in err ? err.killed : false) === true) ||
                (err as { signal?: string } | null)?.signal === 'SIGKILL';
              resolve({
                code: (err as { code?: number } | null)?.code ?? (err ? 1 : 0),
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? ''),
                killed,
              });
            },
          );
          child.on('error', () =>
            resolve({ code: null, stdout: '', stderr: 'failed to start runtime', killed: false }),
          );
        });

        const durationMs = Date.now() - started;
        const marker = result.stdout.lastIndexOf(sentinel);
        let output: unknown = null;
        let stdout = result.stdout;

        if (marker !== -1) {
          stdout = result.stdout.slice(0, marker).replace(/\n$/, '');
          try {
            output = JSON.parse(result.stdout.slice(marker + sentinel.length));
          } catch {
            // A handler returning something JSON cannot represent is a failure of
            // the function, not of the runtime — report it rather than guessing.
            return {
              status: 'failed',
              stdout,
              stderr: `${result.stderr}function returned a value that is not JSON-serialisable\n`,
              exitCode: result.code,
              durationMs,
              output: null,
              timedOut: false,
            };
          }
        }

        // The sentinel is the only evidence the handler actually returned. A
        // zero exit without it means the function exited on its own terms
        // mid-flight, which is not success.
        const succeeded = result.code === 0 && !result.killed && marker !== -1;

        return {
          status: succeeded ? 'succeeded' : 'failed',
          stdout,
          stderr: result.killed
            ? `${result.stderr}killed after exceeding its ${req.timeoutMs}ms timeout\n`
            : result.stderr,
          exitCode: result.code,
          durationMs,
          output: succeeded ? output : null,
          timedOut: result.killed,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
