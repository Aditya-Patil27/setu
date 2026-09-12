import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  NotFoundError,
  RateLimitError,
  SETU,
  SetuError,
  ValidationError,
  contextToHeaders,
  type SignedContext,
} from '@setu/shared';
import { resolveCredential } from '../credentials.js';
import { matchRoute } from '../upstreams.js';

/**
 * Headers the gateway alone may set.
 *
 * Anything a client sends under these names is dropped before routing. They are
 * trustworthy downstream precisely because they cannot survive the hop — the
 * signature proves the gateway wrote them, and stripping proves nobody else did.
 * The one exception is x-setu-purpose, which the client *does* supply: it is
 * read here, validated against the registry, and then re-emitted under the
 * signature rather than forwarded as received.
 */
const PLATFORM_HEADERS = new Set<string>(Object.values(SETU.HEADERS));

/** Hop-by-hop headers, plus the ones fetch must compute for itself. */
const NEVER_FORWARD = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'content-length',
  'authorization',
]);

function forwardableHeaders(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (PLATFORM_HEADERS.has(key) || NEVER_FORWARD.has(key)) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * A purpose must exist in the project's own registry before it is bound.
 *
 * The database would evaluate consent for any string, and a purpose nobody
 * registered simply matches no artifact — a silent empty result rather than an
 * error. Failing here turns a typo into a 400 instead of a mystery.
 */
async function assertPurposeRegistered(
  request: FastifyRequest,
  projectId: string,
  purpose: string,
): Promise<void> {
  const res = await request.server.pools.runtime.query(
    `SELECT 1 FROM purposes WHERE project_id = $1 AND name = $2`,
    [projectId, purpose],
  );
  if (!res.rowCount) {
    throw new ValidationError(`Purpose '${purpose}' is not registered for this project`, {
      purpose,
    });
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

const routes: FastifyPluginAsync = async (app) => {
  app.all('/v1/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(request.url, 'http://gateway.internal');

    const identity = await resolveCredential(
      app.pools.runtime,
      request.headers.authorization,
      app.jwtSecret,
      app.keyCache,
    );

    if (!app.buckets.take(identity.rateKey)) throw new RateLimitError();

    const route = matchRoute(url.pathname);
    if (!route) throw new NotFoundError('Route', url.pathname);

    // Read from the request, never forwarded as received.
    const purpose = headerValue(request, SETU.HEADERS.PURPOSE);
    if (route.requiresPurpose && !purpose) {
      throw new ValidationError('A purpose is required for this request', {
        header: SETU.HEADERS.PURPOSE,
      });
    }
    if (purpose) await assertPurposeRegistered(request, identity.projectId, purpose);

    const ctx: SignedContext = {
      requestId: randomUUID(),
      tenantId: identity.tenantId,
      projectId: identity.projectId,
      principalId: identity.principalId,
      purpose,
    };

    const upstream = new URL(url.pathname + url.search, app.upstreams[route.service]);
    /**
     * A bodyless POST must not be announced as JSON.
     *
     * Fastify rejects `content-type: application/json` with an empty body, so
     * declaring it on every non-GET made routes that legitimately take no body
     * — /v1/consents/:id/revoke among them — fail at the upstream with an error
     * the client could not act on. The header and the body are now decided by
     * the same condition, so they cannot disagree.
     */
    const hasBody =
      request.method !== 'GET' && request.method !== 'HEAD' && request.body !== undefined;

    /**
     * Bounded, because an unbounded proxy is how one slow service becomes an
     * outage everywhere.
     *
     * Without a deadline a hung upstream holds this request, its socket and its
     * slot in the event loop for as long as the client is willing to wait, and
     * the gateway stops answering for everyone. 504 says plainly that the
     * upstream did not answer in time, which is a different fact from the
     * upstream having refused — and the caller can act on the difference.
     */
    let response: Response;
    try {
      response = await fetch(upstream, {
        method: request.method,
        headers: {
          ...forwardableHeaders(request),
          ...contextToHeaders(ctx, app.signingSecret),
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(app.upstreamTimeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      request.log.error({ err, service: route.service, timedOut }, 'upstream request failed');

      // Never surface the upstream's address or the underlying cause: it names
      // internal topology the caller has no business learning.
      throw new SetuError(
        timedOut
          ? `The ${route.service} service did not respond in time`
          : `The ${route.service} service is unavailable`,
        timedOut ? 504 : 502,
        timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      );
    }

    const text = await response.text();
    reply.status(response.status);
    reply.header('content-type', response.headers.get('content-type') ?? 'application/json');
    // Echo the id the context was signed with, so a caller can quote it in a
    // support request and it will match the audit chain.
    reply.header(SETU.HEADERS.REQUEST_ID, ctx.requestId);
    return reply.send(text);
  });
};

export default routes;
