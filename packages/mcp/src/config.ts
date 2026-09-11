/**
 * What the server is allowed to do, fixed before any agent connects.
 *
 * The purpose allowlist is the point of this file. An agent that can name any
 * purpose will name whichever one returns the most data, so the set it may
 * choose from is closed at configuration time by whoever ran the server — not
 * by the model, and not by anything the model can say.
 *
 * This is the early, friendly half of the check. The gateway still validates
 * every purpose against the project registry, and Postgres still evaluates
 * consent regardless of what arrives. Nothing here is load-bearing for safety;
 * it exists so a mistake becomes a schema violation instead of a silent read
 * under the wrong intent.
 */

export interface McpConfig {
  /** Gateway base URL. */
  url: string;
  /** Project API key. The server's entire authority. */
  apiKey: string;
  /** The closed set of purposes an agent may bind. Empty means none. */
  purposes: string[];
  /** When false, the mutating tools are not registered at all. */
  allowWrites: boolean;
  timeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PURPOSE_PATTERN = /^[a-z][a-z0-9_]*$/;

function parsePurposes(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];

  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const name of names) {
    if (!PURPOSE_PATTERN.test(name)) {
      throw new ConfigError(
        `SETU_PURPOSES contains '${name}', which is not a valid purpose name ` +
          '(lower_snake_case, starting with a letter)',
      );
    }
  }

  return [...new Set(names)];
}

/**
 * Read configuration from the environment.
 *
 * Fails loudly and early: a server that starts without a key would hand the
 * agent a set of tools that every call fails on, which reads to the model as a
 * broken platform rather than a misconfigured one.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const url = env.SETU_URL?.trim() || 'http://localhost:3000';
  const apiKey = env.SETU_API_KEY?.trim();

  if (!apiKey) {
    throw new ConfigError(
      'SETU_API_KEY is required. Pass it when registering the server, e.g. ' +
        'claude mcp add setu --env SETU_API_KEY=setu_... -- npx -y @setu/mcp',
    );
  }

  if (!/^setu_[A-Za-z0-9]+_[A-Za-z0-9]+$/.test(apiKey)) {
    throw new ConfigError('SETU_API_KEY is not a Setu key (expected setu_<prefix>_<secret>)');
  }

  const timeoutRaw = env.SETU_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`SETU_TIMEOUT_MS must be a positive number, got '${timeoutRaw}'`);
  }

  return {
    url,
    apiKey,
    purposes: parsePurposes(env.SETU_PURPOSES),
    // Writes are opt-in. An agent exploring a production project should not be
    // able to mutate it because nobody thought to say otherwise.
    allowWrites: env.SETU_ALLOW_WRITES === 'true',
    timeoutMs,
  };
}
