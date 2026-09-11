import { describe, expect, it } from 'vitest';
import { ConfigError, configFromEnv } from '../../packages/mcp/src/config.js';

/**
 * Configuration is where the purpose allowlist is fixed, so it fails loudly.
 *
 * A server that starts misconfigured hands the agent tools that fail on every
 * call, which the model reads as a broken platform rather than a broken setup.
 */

const KEY = 'setu_abc123_defghijklmnop';

describe('credentials', () => {
  it('requires an API key', () => {
    expect(() => configFromEnv({})).toThrow(ConfigError);
  });

  it('names the registration command when the key is missing', () => {
    expect(() => configFromEnv({})).toThrow(/claude mcp add/);
  });

  it('rejects something that is not a Setu key', () => {
    expect(() => configFromEnv({ SETU_API_KEY: 'sk-not-a-setu-key' })).toThrow(/not a Setu key/);
  });

  it('defaults to the local gateway', () => {
    expect(configFromEnv({ SETU_API_KEY: KEY }).url).toBe('http://localhost:3000');
  });
});

describe('the purpose allowlist', () => {
  it('is empty unless configured', () => {
    expect(configFromEnv({ SETU_API_KEY: KEY }).purposes).toEqual([]);
  });

  it('parses a comma-separated list, trimming and de-duplicating', () => {
    const config = configFromEnv({
      SETU_API_KEY: KEY,
      SETU_PURPOSES: ' support_chat , analytics ,support_chat ',
    });

    expect(config.purposes).toEqual(['support_chat', 'analytics']);
  });

  it('rejects a name the database could never match', () => {
    expect(() => configFromEnv({ SETU_API_KEY: KEY, SETU_PURPOSES: 'Support-Chat' })).toThrow(
      /not a valid purpose name/,
    );
  });
});

describe('writes', () => {
  it('are off unless explicitly enabled', () => {
    expect(configFromEnv({ SETU_API_KEY: KEY }).allowWrites).toBe(false);
    expect(configFromEnv({ SETU_API_KEY: KEY, SETU_ALLOW_WRITES: 'yes' }).allowWrites).toBe(false);
  });

  it('are on only for the exact opt-in', () => {
    expect(configFromEnv({ SETU_API_KEY: KEY, SETU_ALLOW_WRITES: 'true' }).allowWrites).toBe(true);
  });
});

describe('timeout', () => {
  it('rejects a non-numeric value rather than silently falling back', () => {
    expect(() => configFromEnv({ SETU_API_KEY: KEY, SETU_TIMEOUT_MS: 'soon' })).toThrow(
      ConfigError,
    );
  });
});
