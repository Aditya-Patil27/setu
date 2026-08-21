import { randomUUID } from 'node:crypto';
import { contextToHeaders, signContext, type SignedContext } from '@setu/shared';

/** Fixed so suites can assert on signature behaviour without reading config. */
export const TEST_SECRET = 'test-signing-secret';

export interface HeaderOptions {
  tenantId: string;
  projectId: string;
  principalId?: string;
  purpose?: string;
  requestId?: string;
  /** Sign with the wrong key, to prove verification actually rejects. */
  secret?: string;
}

/** Build the signed `x-setu-*` header set the gateway would normally produce. */
export function signedHeaders(opts: HeaderOptions): Record<string, string> {
  const ctx: SignedContext = {
    requestId: opts.requestId ?? randomUUID(),
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    principalId: opts.principalId,
    purpose: opts.purpose,
  };
  return contextToHeaders(ctx, opts.secret ?? TEST_SECRET);
}

/**
 * Headers whose signature covers a different purpose than the one sent.
 *
 * Models the attack the signing exists to stop: a caller who reaches a service
 * directly and rewrites the purpose to one the principal has consented to.
 */
export function tamperedPurposeHeaders(
  opts: HeaderOptions & { signedPurpose: string; sentPurpose: string },
): Record<string, string> {
  const ctx: SignedContext = {
    requestId: opts.requestId ?? randomUUID(),
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    principalId: opts.principalId,
    purpose: opts.signedPurpose,
  };
  const headers = contextToHeaders(ctx, opts.secret ?? TEST_SECRET);
  headers['x-setu-purpose'] = opts.sentPurpose;
  // Signature deliberately left covering signedPurpose.
  headers['x-setu-sig'] = signContext(ctx, opts.secret ?? TEST_SECRET);
  return headers;
}
