export type ServiceName = 'auth' | 'data' | 'consent';

export type Upstreams = Record<ServiceName, string>;

/** Upstream base URLs. Compose supplies the service names; localhost is the dev fallback. */
export function upstreamsFromEnv(): Upstreams {
  return {
    auth: process.env.AUTH_SERVICE_URL ?? `http://localhost:${process.env.AUTH_SERVICE_PORT ?? 3001}`,
    data: process.env.DATA_SERVICE_URL ?? `http://localhost:${process.env.DATA_SERVICE_PORT ?? 3002}`,
    consent:
      process.env.CONSENT_SERVICE_URL ??
      `http://localhost:${process.env.CONSENT_SERVICE_PORT ?? 3005}`,
  };
}

export interface Route {
  match: RegExp;
  service: ServiceName;
  /**
   * Whether a purpose must be bound before the request may proceed.
   *
   * True for anything that reads or writes tenant records — the purpose is the
   * declared intent the database evaluates consent against, and without one
   * there is nothing to evaluate. Declaring a collection is control-plane work
   * that touches no records, so it carries no purpose.
   */
  requiresPurpose: boolean;
}

/**
 * First match wins, so the record routes are listed before the collection
 * routes they sit underneath.
 */
const ROUTES: Route[] = [
  { match: /^\/v1\/collections\/[^/]+\/records(?:\/|$)/, service: 'data', requiresPurpose: true },
  { match: /^\/v1\/collections(?:\/|$)/, service: 'data', requiresPurpose: false },
  { match: /^\/v1\/(?:purposes|consents|me)(?:\/|$)/, service: 'consent', requiresPurpose: false },
  { match: /^\/v1\/(?:auth|keys)(?:\/|$)/, service: 'auth', requiresPurpose: false },
];

export function matchRoute(pathname: string): Route | undefined {
  return ROUTES.find((route) => route.match.test(pathname));
}
