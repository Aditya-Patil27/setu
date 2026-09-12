import { createHash } from 'node:crypto';
import type { Identity } from './credentials.js';

/**
 * A short-lived cache of verified credentials.
 *
 * argon2id is deliberately slow — that is the entire point of it for a stored
 * secret — and the gateway was paying that cost on every single request, which
 * capped a single core at roughly the rate argon2 can run. Caching the verdict
 * means the cost is paid once per key per TTL instead of once per request.
 *
 * Three things this deliberately does NOT do:
 *
 *   - It does not cache failures. A key created moments after someone probed
 *     for it must work immediately; and a negative cache is a way to keep a
 *     legitimate key locked out.
 *   - It does not store the presented token. The map is keyed by a sha256 of it,
 *     so a heap dump does not hand over usable credentials.
 *   - It does not remove the expiry check. `expires_at` is re-evaluated on every
 *     hit, because a key that expires mid-TTL must stop working at its expiry
 *     and not at the end of the cache window.
 *
 * The cost is revocation latency: a deleted key keeps working until its entry
 * ages out. That is why the default TTL is seconds rather than minutes — long
 * enough that a client's burst of requests hits the cache, short enough that
 * revoking a leaked key is effectively immediate.
 */

export interface CachedIdentity {
  identity: Identity;
  /** The key row's own expiry, still enforced on every hit. */
  expiresAt: Date | null;
}

interface Entry extends CachedIdentity {
  /** When this entry stops being trusted, independent of the key's own expiry. */
  staleAt: number;
}

export interface KeyCacheOptions {
  /** How long a verdict may be reused. */
  ttlMs?: number;
  /** Hard ceiling on entries, so a spray of distinct keys cannot exhaust memory. */
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1_000;

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/**
 * Least-recently-used, on a plain Map.
 *
 * Map iterates in insertion order, so re-inserting on read moves an entry to the
 * end and the oldest key is always the first one. No dependency needed for a
 * structure this small.
 */
export class KeyCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: KeyCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get(token: string): CachedIdentity | undefined {
    const key = fingerprint(token);
    const hit = this.entries.get(key);
    if (!hit) return undefined;

    if (hit.staleAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Touch, so the hot keys are the ones that survive eviction.
    this.entries.delete(key);
    this.entries.set(key, hit);

    return { identity: hit.identity, expiresAt: hit.expiresAt };
  }

  set(token: string, value: CachedIdentity): void {
    const key = fingerprint(token);
    this.entries.delete(key);
    this.entries.set(key, { ...value, staleAt: Date.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** For tests, and for a future admin path that revokes without waiting for TTL. */
  delete(token: string): void {
    this.entries.delete(fingerprint(token));
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function keyCacheFromEnv(): KeyCache {
  const ttl = Number(process.env.GATEWAY_KEY_CACHE_TTL_MS ?? DEFAULT_TTL_MS);
  const max = Number(process.env.GATEWAY_KEY_CACHE_MAX ?? DEFAULT_MAX_ENTRIES);

  return new KeyCache({
    ttlMs: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_TTL_MS,
    maxEntries: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_ENTRIES,
  });
}
