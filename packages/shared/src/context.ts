import { createHmac, timingSafeEqual } from 'node:crypto';
import { SETU } from './constants.js';
import { UnauthorizedError, ValidationError } from './errors.js';

/**
 * The request context the gateway resolves and downstream services act on.
 *
 * `purpose` is absent on control-plane calls (issuing a key, registering a
 * purpose) and mandatory on anything touching tenant records.
 */
export interface SignedContext {
  requestId: string;
  tenantId: string;
  projectId: string;
  principalId?: string;
  purpose?: string;
}

/**
 * Canonical string the signature covers.
 *
 * Field order is fixed and every field is present — an empty slot rather than an
 * omitted one — so that two different contexts cannot serialise identically.
 */
function canonicalise(ctx: SignedContext): string {
  return [
    ctx.requestId,
    ctx.tenantId,
    ctx.projectId,
    ctx.principalId ?? '',
    ctx.purpose ?? '',
  ].join('|');
}

export function signContext(ctx: SignedContext, secret: string): string {
  return createHmac('sha256', secret).update(canonicalise(ctx)).digest('hex');
}

/**
 * Verify a signature in constant time.
 *
 * Without this, the `x-setu-*` headers are self-asserted: because the services
 * listen on their own ports, anyone who can reach one could name their own
 * purpose and the database would faithfully evaluate consent for whatever was
 * claimed. The gateway binds purpose; this is what makes that binding stick.
 */
export function verifyContext(ctx: SignedContext, signature: string, secret: string): boolean {
  const expected = Buffer.from(signContext(ctx, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : undefined;
}

export interface ContextRequirements {
  /** Reject the request unless a purpose is present. Required on any record access. */
  requirePurpose?: boolean;
  /** Reject the request unless a principal is present. Required on /me routes. */
  requirePrincipal?: boolean;
}

/**
 * Extract and verify request context from inbound headers.
 *
 * Throws rather than returning a result object, so a route that forgets to check
 * cannot proceed with an unverified context.
 */
export function contextFromHeaders(
  headers: HeaderBag,
  secret: string,
  requirements: ContextRequirements = {},
): SignedContext {
  const tenantId = header(headers, SETU.HEADERS.TENANT_ID);
  const projectId = header(headers, SETU.HEADERS.PROJECT_ID);
  const requestId = header(headers, SETU.HEADERS.REQUEST_ID);
  const signature = header(headers, SETU.HEADERS.SIGNATURE);

  if (!tenantId || !projectId || !requestId) {
    throw new UnauthorizedError('Request context headers are missing');
  }
  if (!signature) {
    throw new UnauthorizedError('Request context is not signed');
  }

  const ctx: SignedContext = {
    requestId,
    tenantId,
    projectId,
    principalId: header(headers, SETU.HEADERS.PRINCIPAL_ID),
    purpose: header(headers, SETU.HEADERS.PURPOSE),
  };

  if (!verifyContext(ctx, signature, secret)) {
    throw new UnauthorizedError('Request context signature is invalid');
  }

  // Checked only after the signature, so an unsigned caller learns nothing about
  // which fields a route expects.
  if (requirements.requirePurpose && !ctx.purpose) {
    throw new ValidationError('A purpose is required for this request', {
      header: SETU.HEADERS.PURPOSE,
    });
  }
  if (requirements.requirePrincipal && !ctx.principalId) {
    throw new UnauthorizedError('This request must be made by a principal');
  }

  return ctx;
}

/** Render a context as outbound headers, signed. For the gateway and for tests. */
export function contextToHeaders(ctx: SignedContext, secret: string): Record<string, string> {
  const headers: Record<string, string> = {
    [SETU.HEADERS.REQUEST_ID]: ctx.requestId,
    [SETU.HEADERS.TENANT_ID]: ctx.tenantId,
    [SETU.HEADERS.PROJECT_ID]: ctx.projectId,
    [SETU.HEADERS.SIGNATURE]: signContext(ctx, secret),
  };
  if (ctx.principalId) headers[SETU.HEADERS.PRINCIPAL_ID] = ctx.principalId;
  if (ctx.purpose) headers[SETU.HEADERS.PURPOSE] = ctx.purpose;
  return headers;
}
