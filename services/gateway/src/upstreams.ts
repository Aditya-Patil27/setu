export type ServiceName =
  'auth' | 'data' | 'consent' | 'audit' | 'storage' | 'metering' | 'functions' | 'workflow' | 'ai';

export type Upstreams = Record<ServiceName, string>;

/** Upstream base URLs. Compose supplies the service names; localhost is the dev fallback. */
export function upstreamsFromEnv(): Upstreams {
  return {
    auth:
      process.env.AUTH_SERVICE_URL ?? `http://localhost:${process.env.AUTH_SERVICE_PORT ?? 3001}`,
    data:
      process.env.DATA_SERVICE_URL ?? `http://localhost:${process.env.DATA_SERVICE_PORT ?? 3002}`,
    consent:
      process.env.CONSENT_SERVICE_URL ??
      `http://localhost:${process.env.CONSENT_SERVICE_PORT ?? 3005}`,
    audit:
      process.env.AUDIT_SERVICE_URL ?? `http://localhost:${process.env.AUDIT_SERVICE_PORT ?? 3006}`,
    storage:
      process.env.STORAGE_SERVICE_URL ??
      `http://localhost:${process.env.STORAGE_SERVICE_PORT ?? 3003}`,
    metering:
      process.env.METERING_SERVICE_URL ??
      `http://localhost:${process.env.METERING_SERVICE_PORT ?? 3008}`,
    functions:
      process.env.FUNCTIONS_SERVICE_URL ??
      `http://localhost:${process.env.FUNCTIONS_SERVICE_PORT ?? 3004}`,
    workflow:
      process.env.WORKFLOW_SERVICE_URL ??
      `http://localhost:${process.env.WORKFLOW_SERVICE_PORT ?? 3007}`,
    ai: process.env.AI_SERVICE_URL ?? `http://localhost:${process.env.AI_SERVICE_PORT ?? 3009}`,
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
  /**
   * Storage binds a purpose on every route, including the list: an object about
   * a person is personal data in exactly the way a row is, and the policy that
   * governs it evaluates the same current_setting('app.purpose').
   */
  { match: /^\/v1\/storage(?:\/|$)/, service: 'storage', requiresPurpose: true },
  { match: /^\/v1\/(?:purposes|consents|me)(?:\/|$)/, service: 'consent', requiresPurpose: false },
  { match: /^\/v1\/(?:auth|keys)(?:\/|$)/, service: 'auth', requiresPurpose: false },
  /**
   * Usage is counts of what the platform did, not a fact about anyone, so it
   * binds no purpose. The closed meter vocabulary is what keeps that true.
   */
  { match: /^\/v1\/metering(?:\/|$)/, service: 'metering', requiresPurpose: false },
  /**
   * Functions binds no purpose at the gateway, deliberately. Whether one is
   * required depends on what the function declared, which only the service
   * knows — so it decides, and refuses a mismatch in either direction.
   */
  { match: /^\/v1\/functions(?:\/|$)/, service: 'functions', requiresPurpose: false },
  /**
   * As with functions, whether a purpose is required depends on what the
   * workflow declared, so the service decides rather than the gateway.
   */
  { match: /^\/v1\/workflows(?:\/|$)/, service: 'workflow', requiresPurpose: false },
  /**
   * Reading the trail is the tenant inspecting their own compliance record, not
   * an access to a data subject's data, so it binds no purpose — auditing an
   * access must not itself need consent, or the log becomes unreadable exactly
   * when it matters.
   */
  { match: /^\/v1\/audit(?:\/|$)/, service: 'audit', requiresPurpose: false },
  /**
   * Inference always binds a purpose, with no exception for any route under it.
   * Unlike functions and workflows there is no case where reading tenant data
   * into a model is purpose-free: an embedding is derived from a person's
   * record, and a derivation with no declared intent is the thing the platform
   * exists to refuse.
   */
  { match: /^\/v1\/ai(?:\/|$)/, service: 'ai', requiresPurpose: true },
];

export function matchRoute(pathname: string): Route | undefined {
  return ROUTES.find((route) => route.match.test(pathname));
}
