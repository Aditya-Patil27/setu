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
 * The harness the child actually runs.
 *
 * The tenant's source is imported rather than concatenated, so a syntax error in
 * it cannot corrupt the harness, and its thrown errors arrive as rejections we
 * can report instead of as a parse failure in a file the tenant never wrote.
 *
 * The sentinel is random per invocation: a function that printed a fixed one on
 * purpose would otherwise be able to forge its own return value.
 */
function harness(sentinel: string): string {
  return `
const { readFileSync } = await import('node:fs');
const payload = JSON.parse(readFileSync(process.argv[2], 'utf8'));

let handler;
try {
  const mod = await import('./fn.mjs');
  handler = mod.default ?? mod.handler;
} catch (err) {
  process.stderr.write('failed to load function: ' + (err && err.stack || err) + '\\n');
  process.exit(1);
}

if (typeof handler !== 'function') {
  process.stderr.write('function must export a default or named "handler" function\\n');
  process.exit(1);
}

try {
  const output = await handler(payload.input, payload.context);
  process.stdout.write('\\n${sentinel}' + JSON.stringify(output === undefined ? null : output));
} catch (err) {
  process.stderr.write((err && err.stack || String(err)) + '\\n');
  process.exit(1);
}
`;
}

/**
 * Run each invocation in a fresh Node process.
 *
 * What this genuinely provides: a separate process with its own heap, a hard
 * memory ceiling, a timeout enforced by killing it, and an environment stripped
 * of every platform secret. A function cannot read the database password, cannot
 * reach the signing key, and cannot outlive its timeout.
 *
 * What it is NOT is a security sandbox. There is no syscall filtering, no
 * filesystem jail and no network restriction, so tenant code can still read
 * files the service user can read and open outbound sockets. Multi-tenant
 * isolation needs a container or a microVM — which is what deploy/docker exists
 * for — and this runtime is the seam that will be replaced by one, not a
 * substitute for it. Nothing above this interface changes when it is.
 */
export function createSubprocessRuntime(): FunctionRuntime {
  return {
    async invoke(req) {
      const sentinel = `__SETU_OUT_${randomBytes(12).toString('hex')}__`;
      const dir = await mkdtemp(join(tmpdir(), `setu-fn-${randomUUID()}-`));
      const started = Date.now();

      try {
        await writeFile(join(dir, 'fn.mjs'), req.source, 'utf8');
        await writeFile(join(dir, 'run.mjs'), harness(sentinel), 'utf8');
        await writeFile(
          join(dir, 'payload.json'),
          JSON.stringify({ input: req.input, context: req.context }),
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
