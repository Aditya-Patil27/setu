import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../services/gateway/src/upstreams.js';

/**
 * The gateway's view of the AI service.
 *
 * These assertions are cheap and worth keeping because the property they guard
 * is easy to lose silently: a route added later under /v1/ai that forgets
 * requiresPurpose would accept inference over tenant data with no declared
 * intent, and nothing downstream would object — the service would simply
 * receive a context with no purpose and fail in a less obvious way.
 */

describe('routing /v1/ai', () => {
  it('routes to the ai service', () => {
    expect(matchRoute('/v1/ai/ask')?.service).toBe('ai');
    expect(matchRoute('/v1/ai/search')?.service).toBe('ai');
    expect(matchRoute('/v1/ai/embeddings')?.service).toBe('ai');
  });

  it('requires a purpose on every route beneath it', () => {
    for (const path of ['/v1/ai/ask', '/v1/ai/search', '/v1/ai/embeddings', '/v1/ai']) {
      expect(matchRoute(path)?.requiresPurpose).toBe(true);
    }
  });

  it('does not swallow another service prefix', () => {
    // /v1/audit starts with the same three characters as /v1/ai.
    expect(matchRoute('/v1/audit/records')?.service).toBe('audit');
    expect(matchRoute('/v1/audit/records')?.requiresPurpose).toBe(false);
  });
});
