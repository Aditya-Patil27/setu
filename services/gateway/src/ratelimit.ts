/**
 * Per-credential token bucket.
 *
 * Deliberately in-process and therefore per-instance: with N gateways a caller
 * gets N buckets. Correct enforcement needs shared state (Redis, or Postgres
 * advisory counters) and belongs with M7's metering work — this exists to stop
 * a single client hammering the read path, not to bill anyone.
 */
export interface RateLimitOptions {
  /** Maximum burst. */
  capacity: number;
  /** Sustained rate, in tokens per second. */
  refillPerSecond: number;
  /** Buckets idle longer than this are forgotten, so the map cannot grow forever. */
  idleMs?: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly idleMs: number;

  constructor(private readonly opts: RateLimitOptions) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  }

  /** Spend one token. False means the caller is over its limit. */
  take(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.opts.capacity, updatedAt: now };

    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + elapsed * this.opts.refillPerSecond);
    bucket.updatedAt = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    this.buckets.set(key, bucket);
    this.sweep(now);
    return allowed;
  }

  /**
   * Drop buckets nobody has touched recently.
   *
   * A full bucket carries no state worth keeping — recreating it yields the same
   * answer — so eviction cannot be used to reset a limit that is being enforced.
   */
  private sweep(now: number): void {
    if (this.buckets.size < 1024) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > this.idleMs) this.buckets.delete(key);
    }
  }
}
