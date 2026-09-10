import { createHash, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import type pg from 'pg';
import { UnauthorizedError } from '@setu/shared';

/**
 * Access tokens are verified by the gateway, never by this service — Auth issues
 * credentials and then leaves the request path entirely. The claim names must
 * therefore match what the gateway reads: `sub` and `project_id`.
 */
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const DEFAULT_ACCESS_TTL = '1h';
const DEFAULT_REFRESH_TTL = '7d';

/** Parse the `1h` / `7d` / `30m` forms used in .env into milliseconds. */
export function durationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported duration '${value}'`);
  const scale = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!;
  return Number(match[1]) * scale;
}

/**
 * Refresh tokens are 32 random bytes, so a plain sha256 is enough and keeps them
 * directly searchable. Argon2 is reserved for low-entropy secrets — OTP codes
 * and the API key secret — where the work factor is what buys the security.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenConfig {
  jwtSecret: string;
  accessTtl: string;
  refreshTtl: string;
}

export function tokenConfigFromEnv(jwtSecret: string): TokenConfig {
  return {
    jwtSecret,
    accessTtl: process.env.JWT_EXPIRES_IN ?? DEFAULT_ACCESS_TTL,
    refreshTtl: process.env.JWT_REFRESH_EXPIRES_IN ?? DEFAULT_REFRESH_TTL,
  };
}

async function signAccessToken(
  config: TokenConfig,
  principalId: string,
  projectId: string,
): Promise<string> {
  return new SignJWT({ project_id: projectId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(principalId)
    .setIssuedAt()
    .setIssuer('setu')
    .setExpirationTime(config.accessTtl)
    .sign(new TextEncoder().encode(config.jwtSecret));
}

/** Mint an access token and a fresh refresh token, recording the latter's digest. */
export async function issueSession(
  client: pg.PoolClient | pg.Pool,
  config: TokenConfig,
  principalId: string,
  projectId: string,
): Promise<Session> {
  const refreshToken = randomBytes(32).toString('base64url');
  const refreshMs = durationMs(config.refreshTtl);

  await client.query(
    `INSERT INTO refresh_tokens (principal_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [principalId, hashToken(refreshToken), refreshMs / 1000],
  );

  return {
    accessToken: await signAccessToken(config, principalId, projectId),
    refreshToken,
    expiresIn: Math.floor(durationMs(config.accessTtl) / 1000),
  };
}

interface RefreshRow {
  id: string;
  principal_id: string;
  project_id: string;
  revoked_at: Date | null;
  expired: boolean;
}

/**
 * Exchange a refresh token for a new session, rotating it.
 *
 * Presenting a token that was already spent is the signature of a stolen one:
 * the legitimate holder rotated it, so whoever holds this copy should not. Every
 * live token for that principal is revoked, which ends both sessions and forces
 * a fresh sign-in — noisy by design, because the alternative is letting a thief
 * ride alongside the real user indefinitely.
 */
export async function rotateSession(
  client: pg.PoolClient,
  config: TokenConfig,
  projectId: string,
  presented: string,
): Promise<Session> {
  const res = await client.query<RefreshRow>(
    `SELECT t.id, t.principal_id, p.project_id, t.revoked_at,
            (t.expires_at <= now()) AS expired
       FROM refresh_tokens t
       JOIN principals p ON p.id = t.principal_id
      WHERE t.token_hash = $1`,
    [hashToken(presented)],
  );

  // One answer for absent, expired, revoked and wrong-project alike.
  if (!res.rowCount) throw new UnauthorizedError('Invalid refresh token');
  const row = res.rows[0];

  if (row.revoked_at) {
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE principal_id = $1 AND revoked_at IS NULL`,
      [row.principal_id],
    );
    // Committed before the throw, deliberately. The caller rolls back on error,
    // which would undo the very revocation this branch exists to perform —
    // leaving the stolen token detected and the chain still live.
    await client.query('COMMIT');
    throw new UnauthorizedError('Invalid refresh token');
  }

  if (row.expired || row.project_id !== projectId) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [row.id]);
  return issueSession(client, config, row.principal_id, projectId);
}
