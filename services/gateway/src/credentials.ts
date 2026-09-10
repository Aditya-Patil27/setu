import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { jwtVerify } from 'jose';
import type pg from 'pg';
import { UnauthorizedError } from '@setu/shared';

/**
 * Who the caller is, resolved from a credential and never from a header.
 *
 * Everything downstream — the signed context, the audit trail, the rate limit —
 * derives from this. Inbound `x-setu-*` headers are discarded before routing:
 * were they honoured, a caller could simply name the project they wanted.
 */
export interface Identity {
  tenantId: string;
  projectId: string;
  principalId?: string;
  /** Stable handle the rate limiter counts against. */
  rateKey: string;
}

/**
 * `setu_<prefix>_<secret>`: the prefix is the lookup handle, the secret is what
 * gets verified. Splitting them is what makes the lookup possible at all — an
 * argon2id digest is salted, so the key itself is not searchable.
 */
const API_KEY = /^setu_([a-z0-9]{4,32})_([A-Za-z0-9_-]{16,128})$/;

/**
 * A real digest to verify against when the prefix is unknown.
 *
 * Without it an unknown prefix returns immediately while a known one spends
 * ~50ms in argon2, and that difference tells an attacker which prefixes exist.
 * Computed once, lazily, because argon2 is deliberately slow.
 */
let decoyHash: Promise<string> | undefined;
function decoy(): Promise<string> {
  decoyHash ??= argonHash('setu-timing-equaliser');
  return decoyHash;
}

/**
 * Every failure below raises this same error.
 *
 * Distinguishing "no such key" from "wrong secret" from "expired" would let a
 * caller probe the key table; the audit trail records which it was.
 */
function reject(): never {
  throw new UnauthorizedError('Invalid credential');
}

interface KeyRow {
  key_hash: string;
  expires_at: Date | null;
  project_id: string;
  tenant_id: string;
  key_id: string;
}

async function resolveApiKey(pool: pg.Pool, token: string): Promise<Identity> {
  const parsed = API_KEY.exec(token);
  if (!parsed) reject();
  const [, prefix, secret] = parsed;

  const res = await pool.query<KeyRow>(
    `SELECT k.id AS key_id, k.key_hash, k.expires_at, k.project_id, p.tenant_id
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
      WHERE k.key_prefix = $1`,
    [prefix],
  );

  if (!res.rowCount) {
    // Burn the same time a real verification would, then fail identically.
    await argonVerify(await decoy(), secret).catch(() => false);
    reject();
  }

  const row = res.rows[0];
  const ok = await argonVerify(row.key_hash, secret).catch(() => false);
  if (!ok) reject();
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) reject();

  return {
    tenantId: row.tenant_id,
    projectId: row.project_id,
    rateKey: `key:${row.key_id}`,
  };
}

interface ProjectRow {
  tenant_id: string;
}

async function resolveJwt(pool: pg.Pool, token: string, secret: string): Promise<Identity> {
  let principalId: string;
  let projectId: string;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    if (typeof payload.sub !== 'string' || typeof payload.project_id !== 'string') reject();
    principalId = payload.sub;
    projectId = payload.project_id;
  } catch {
    reject();
  }

  // The token asserts a project; that it exists, and which tenant owns it, is
  // ours to establish. A signed token for a deleted project resolves to nothing.
  const res = await pool.query<ProjectRow>(`SELECT tenant_id FROM projects WHERE id = $1`, [
    projectId,
  ]);
  if (!res.rowCount) reject();

  return {
    tenantId: res.rows[0].tenant_id,
    projectId,
    principalId,
    rateKey: `principal:${principalId}`,
  };
}

/**
 * Resolve `Authorization: Bearer <credential>` into an identity.
 *
 * Project API keys and principal sessions are told apart by shape: a key always
 * carries the `setu_` prefix, and a JWT never can.
 */
export async function resolveCredential(
  pool: pg.Pool,
  authorization: string | undefined,
  jwtSecret: string,
): Promise<Identity> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : undefined;
  if (!token) reject();

  return token.startsWith('setu_')
    ? resolveApiKey(pool, token)
    : resolveJwt(pool, token, jwtSecret);
}
