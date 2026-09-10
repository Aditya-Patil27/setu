import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NotFoundError, UnauthorizedError, contextFromHeaders, parseInput } from '@setu/shared';
import { durationMs, issueSession, rotateSession } from '../tokens.js';

/**
 * Principal sessions.
 *
 * These routes are reached with the project's API key rather than a session —
 * they are how a session comes to exist. The gateway resolves that key and
 * signs the project into the context, so a challenge can never be started
 * against a project the caller does not hold a key for.
 */

const OTP_TTL = '10m';
/** A six-digit code is guessable given enough tries; this is what stops them. */
const MAX_ATTEMPTS = 5;

const StartOtp = z
  .object({
    phone: z.string().min(4).max(20).optional(),
    email: z.string().email().max(254).optional(),
  })
  .refine((v) => Boolean(v.phone) !== Boolean(v.email), {
    message: 'Provide exactly one of phone or email',
  });

const VerifyOtp = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{4,8}$/, 'must be a numeric code'),
});

const Refresh = z.object({
  refreshToken: z.string().min(16).max(200),
});

interface ChallengeRow {
  id: string;
  destination: string;
  channel: 'phone' | 'email';
  code_hash: string;
  attempts: number;
  expired: boolean;
  consumed_at: Date | null;
}

const routes: FastifyPluginAsync = async (app) => {
  /**
   * Begin a challenge. The response never reveals whether the destination is
   * already a principal — that would turn this into a membership oracle for
   * anyone holding a publishable key.
   */
  app.post('/auth/otp/start', async (request, reply) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(StartOtp, request.body, 'otp request');

    const channel = body.phone ? 'phone' : 'email';
    const destination = (body.phone ?? body.email)!;
    const code = await app.otp.issue(destination, channel);

    const res = await app.pools.control.query<{ id: string }>(
      `INSERT INTO otp_challenges (project_id, destination, channel, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
       RETURNING id`,
      [ctx.projectId, destination, channel, await argonHash(code), durationMs(OTP_TTL) / 1000],
    );

    return reply.status(201).send({
      challengeId: res.rows[0].id,
      channel,
      expiresIn: Math.floor(durationMs(OTP_TTL) / 1000),
    });
  });

  /**
   * Verify a challenge and issue a session, registering the principal if this is
   * their first sign-in.
   */
  app.post('/auth/otp/verify', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(VerifyOtp, request.body, 'otp verification');

    const client = await app.pools.control.connect();
    try {
      await client.query('BEGIN');

      // Locked for the duration: two concurrent guesses must not each see
      // attempts = 4 and both be allowed through.
      const found = await client.query<ChallengeRow>(
        `SELECT id, destination, channel, code_hash, attempts, consumed_at,
                (expires_at <= now()) AS expired
           FROM otp_challenges
          WHERE id = $1 AND project_id = $2
          FOR UPDATE`,
        [body.challengeId, ctx.projectId],
      );

      // Absent, expired, already used and out of attempts are one answer.
      if (!found.rowCount) throw new UnauthorizedError('Invalid or expired challenge');
      const challenge = found.rows[0];
      if (challenge.consumed_at || challenge.expired || challenge.attempts >= MAX_ATTEMPTS) {
        throw new UnauthorizedError('Invalid or expired challenge');
      }

      const ok = await argonVerify(challenge.code_hash, body.code).catch(() => false);
      if (!ok) {
        await client.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [
          challenge.id,
        ]);
        await client.query('COMMIT');
        throw new UnauthorizedError('Invalid or expired challenge');
      }

      await client.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [
        challenge.id,
      ]);

      const column = challenge.channel === 'phone' ? 'phone' : 'email';
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM principals WHERE project_id = $1 AND ${column} = $2`,
        [ctx.projectId, challenge.destination],
      );

      const principalId = existing.rowCount
        ? existing.rows[0].id
        : (
            await client.query<{ id: string }>(
              `INSERT INTO principals (project_id, ${column}) VALUES ($1, $2) RETURNING id`,
              [ctx.projectId, challenge.destination],
            )
          ).rows[0].id;

      const session = await issueSession(client, app.tokens, principalId, ctx.projectId);
      await client.query('COMMIT');

      return { principalId, ...session };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  /** Exchange a refresh token for a new session. The old one is spent. */
  app.post('/auth/refresh', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret);
    const body = parseInput(Refresh, request.body, 'refresh request');

    const client = await app.pools.control.connect();
    try {
      await client.query('BEGIN');
      const session = await rotateSession(client, app.tokens, ctx.projectId, body.refreshToken);
      await client.query('COMMIT');
      return session;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  /**
   * Who the caller is, as the gateway resolved them.
   *
   * The principal comes from the signed context rather than from the token, so
   * this service never verifies a JWT — that is the gateway's job, done once.
   */
  app.get('/auth/me', async (request) => {
    const ctx = contextFromHeaders(request.headers, app.signingSecret, { requirePrincipal: true });

    const res = await app.pools.control.query(
      `SELECT id, phone, email, display_name, created_at
         FROM principals WHERE id = $1 AND project_id = $2`,
      [ctx.principalId, ctx.projectId],
    );
    if (!res.rowCount) throw new NotFoundError('Principal', ctx.principalId!);

    const row = res.rows[0];
    return {
      id: row.id,
      phone: row.phone,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
    };
  });
};

export default routes;
