#!/usr/bin/env node
/**
 * A local console for the demo.
 *
 * Serves apps/console/index.html and proxies /api/* to the gateway's /v1/*,
 * adding the API key on the way through. Two reasons it proxies rather than
 * letting the page call the gateway directly: the key never reaches the
 * browser, and same-origin means CORS cannot fail in front of an audience.
 *
 * This is a tenant-side tool, not a security boundary. It holds the project's
 * own key and will bind whatever purpose the page asks for — which is exactly
 * what the tenant could do with curl. Every request still passes the gateway's
 * credential check, purpose validation and signing, and the database still
 * decides what comes back. Nothing here is trusted by anything downstream.
 *
 *   node scripts/console.mjs
 *   SETU_KEY=setu_... node scripts/console.mjs --port=4000
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'apps', 'console', 'index.html');

/** Minimal .env reader — matches scripts/seed.mjs rather than adding dotenv. */
async function loadEnv() {
  try {
    const text = await readFile(join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env — rely on the ambient environment.
  }
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

await loadEnv();

const PORT = Number(arg('port') ?? process.env.CONSOLE_PORT ?? 4000);
// 127.0.0.1, not localhost: on a dual-stack host localhost resolves to ::1
// first and the gateway binds 0.0.0.0, so fetch is refused before it connects.
const GATEWAY = arg('gateway') ?? `http://127.0.0.1:${process.env.GATEWAY_PORT ?? 3000}`;
const KEY = arg('key') ?? process.env.SETU_KEY ?? '';

if (!KEY) {
  console.error(
    '[console] No API key. Run `node scripts/seed.mjs` and then:\n' +
      '\n    SETU_KEY=setu_... node scripts/console.mjs\n',
  );
  process.exit(78); // EX_CONFIG
}

/**
 * Forward one request to the gateway.
 *
 * The purpose header is passed through from the page unchanged — the gateway
 * validates it against the project's registry and re-emits it under its own
 * signature, so a purpose invented here gets a 400 rather than a read.
 */
async function proxy(req, res, url) {
  const target = new URL(`/v1${url.pathname.slice('/api'.length)}${url.search}`, GATEWAY);

  const headers = { authorization: `Bearer ${KEY}` };
  const purpose = req.headers['x-setu-purpose'];
  if (purpose) headers['x-setu-purpose'] = purpose;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
    if (body.length) headers['content-type'] = 'application/json';
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body });
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'GATEWAY_UNREACHABLE',
          message: `Could not reach the gateway at ${GATEWAY}. Is it running?`,
          detail: err.message,
        },
      }),
    );
    return;
  }

  const text = await upstream.text();
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
  });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    await proxy(req, res, url);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(PAGE);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`Could not read ${PAGE}`);
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[console] http://localhost:${PORT}  →  ${GATEWAY}`);
});
