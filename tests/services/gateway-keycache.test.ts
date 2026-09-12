import { describe, expect, it } from 'vitest';
import { KeyCache } from '../../services/gateway/src/keycache.js';
import type { Identity } from '../../services/gateway/src/credentials.js';

/**
 * The cache that lets argon2 run once per key instead of once per request.
 *
 * These are unit tests on purpose: what matters is the eviction and staleness
 * behaviour, and driving that through a live gateway would mean either waiting
 * out real TTLs or reaching inside to fake a clock.
 */

const identity = (projectId: string): Identity => ({
  tenantId: 'tenant-1',
  projectId,
  rateKey: `key:${projectId}`,
});

const TOKEN = 'setu_abcd1234_secretsecretsecret';

describe('storing and returning a verdict', () => {
  it('returns nothing for a token it has never seen', () => {
    expect(new KeyCache().get(TOKEN)).toBeUndefined();
  });

  it('returns the identity it was given', () => {
    const cache = new KeyCache();
    cache.set(TOKEN, { identity: identity('p1'), expiresAt: null });

    expect(cache.get(TOKEN)?.identity.projectId).toBe('p1');
  });

  it('does not confuse two tokens sharing a prefix', () => {
    const cache = new KeyCache();
    cache.set('setu_abcd1234_aaaaaaaaaaaaaaaa', { identity: identity('p1'), expiresAt: null });
    cache.set('setu_abcd1234_bbbbbbbbbbbbbbbb', { identity: identity('p2'), expiresAt: null });

    expect(cache.get('setu_abcd1234_aaaaaaaaaaaaaaaa')?.identity.projectId).toBe('p1');
    expect(cache.get('setu_abcd1234_bbbbbbbbbbbbbbbb')?.identity.projectId).toBe('p2');
  });

  it('does not keep the token itself, so a heap dump yields no credentials', () => {
    const cache = new KeyCache();
    cache.set(TOKEN, { identity: identity('p1'), expiresAt: null });

    // The map is keyed by a digest; the secret must appear nowhere in the state.
    expect(
      JSON.stringify([...(cache as unknown as { entries: Map<string, unknown> }).entries]),
    ).not.toContain('secretsecretsecret');
  });
});

describe('staleness', () => {
  it('forgets an entry once its ttl has passed', async () => {
    const cache = new KeyCache({ ttlMs: 20 });
    cache.set(TOKEN, { identity: identity('p1'), expiresAt: null });

    expect(cache.get(TOKEN)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 40));

    // This is the revocation window: a deleted key keeps working until here.
    expect(cache.get(TOKEN)).toBeUndefined();
  });

  it('caches nothing at all when the ttl is zero', () => {
    const cache = new KeyCache({ ttlMs: 0 });
    cache.set(TOKEN, { identity: identity('p1'), expiresAt: null });

    expect(cache.get(TOKEN)).toBeUndefined();
  });

  it('drops an entry explicitly when asked', () => {
    const cache = new KeyCache();
    cache.set(TOKEN, { identity: identity('p1'), expiresAt: null });

    cache.delete(TOKEN);
    expect(cache.get(TOKEN)).toBeUndefined();
  });
});

describe('bounded memory', () => {
  it('evicts the least recently used entry past the ceiling', () => {
    const cache = new KeyCache({ maxEntries: 2 });

    cache.set('setu_aaaa1111_aaaaaaaaaaaaaaaa', { identity: identity('a'), expiresAt: null });
    cache.set('setu_bbbb2222_bbbbbbbbbbbbbbbb', { identity: identity('b'), expiresAt: null });

    // Reading 'a' makes 'b' the oldest, so 'b' is what the next insert displaces.
    cache.get('setu_aaaa1111_aaaaaaaaaaaaaaaa');
    cache.set('setu_cccc3333_cccccccccccccccc', { identity: identity('c'), expiresAt: null });

    expect(cache.size).toBe(2);
    expect(cache.get('setu_aaaa1111_aaaaaaaaaaaaaaaa')).toBeDefined();
    expect(cache.get('setu_cccc3333_cccccccccccccccc')).toBeDefined();
    expect(cache.get('setu_bbbb2222_bbbbbbbbbbbbbbbb')).toBeUndefined();
  });

  it('never grows past the ceiling under a spray of distinct keys', () => {
    const cache = new KeyCache({ maxEntries: 8 });

    for (let i = 0; i < 200; i += 1) {
      cache.set(`setu_key${String(i).padStart(5, '0')}_ssssssssssssssss`, {
        identity: identity(`p${i}`),
        expiresAt: null,
      });
    }

    expect(cache.size).toBe(8);
  });
});

describe('the key row expiry is carried, not swallowed', () => {
  it('hands back the expiry so the caller can re-check it', () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const cache = new KeyCache();
    cache.set(TOKEN, { identity: identity('p1'), expiresAt });

    expect(cache.get(TOKEN)?.expiresAt).toEqual(expiresAt);
  });
});
