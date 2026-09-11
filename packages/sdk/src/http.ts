import { SETU, SetuError } from '@setu/shared';

/**
 * The transport every SDK call goes through.
 *
 * There is exactly one way into the platform — the gateway — and this is the
 * only place that knows it. Nothing here talks to Postgres, holds a signing
 * secret, or sets a platform header other than x-setu-purpose: the gateway
 * strips anything else a client sends under those names, so attempting it would
 * be a silent no-op at best. A caller's entire authority is its API key.
 */

export interface SetuClientConfig {
  /** Base URL of the Setu gateway, e.g. http://localhost:3000 */
  url: string;
  /** Project API key, formatted setu_<prefix>_<secret>. */
  apiKey: string;
  /** Milliseconds before a request is abandoned. */
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * An error the gateway or a service returned.
 *
 * Carries the platform's own error code and the request id, because that id is
 * what ties a failure to its row in the audit chain — quoting it is the only
 * way to ask "what actually happened" about an opaque 404.
 */
export class SetuApiError extends SetuError {
  public readonly requestId?: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    requestId?: string,
    details?: unknown,
  ) {
    super(message, statusCode, code);
    this.name = 'SetuApiError';
    this.requestId = requestId;
    this.details = details;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Bound as x-setu-purpose. Required by the gateway for record and storage routes. */
  purpose?: string;
  body?: unknown;
  /** Appended as a querystring; undefined values are dropped. */
  query?: Record<string, string | number | undefined>;
}

function buildUrl(base: string, path: string, query?: RequestOptions['query']): string {
  const url = new URL(path.replace(/^\/+/, '/'), base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class SetuHttp {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: SetuClientConfig) {
    if (!config.url) throw new TypeError('SetuClient requires a gateway url');
    if (!config.apiKey) throw new TypeError('SetuClient requires an apiKey');

    this.baseUrl = config.url.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const hasBody = method !== 'GET' && options.body !== undefined;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    if (options.purpose) headers[SETU.HEADERS.PURPOSE] = options.purpose;
    if (hasBody) headers['content-type'] = 'application/json';

    /**
     * An unbounded fetch against a hung upstream pins this process forever. The
     * gateway has its own limits, but a client that cannot time out has no way
     * to find out that it should stop waiting.
     */
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(buildUrl(this.baseUrl, path, options.query), {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SetuApiError(
          `Request to ${path} timed out after ${this.timeoutMs}ms`,
          504,
          'TIMEOUT',
        );
      }
      throw new SetuApiError(
        `Could not reach the Setu gateway at ${this.baseUrl}: ${(err as Error).message}`,
        503,
        'UNREACHABLE',
      );
    } finally {
      clearTimeout(timer);
    }

    const requestId = response.headers.get(SETU.HEADERS.REQUEST_ID) ?? undefined;
    const text = await response.text();

    if (!response.ok) {
      let parsed: ErrorBody = {};
      try {
        parsed = text ? (JSON.parse(text) as ErrorBody) : {};
      } catch {
        // A non-JSON error body is still an error; fall through to the status.
      }
      throw new SetuApiError(
        parsed.error?.message ?? `Request failed with status ${response.status}`,
        response.status,
        parsed.error?.code ?? 'UNKNOWN',
        requestId,
        parsed.error?.details,
      );
    }

    // 204 and an empty 200 both mean "done, nothing to say".
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
