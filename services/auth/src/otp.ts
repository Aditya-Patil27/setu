import { randomInt } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

export type Channel = 'phone' | 'email';

/**
 * Delivers a one-time code. The mock provider logs it instead of sending.
 *
 * Real providers land in M8; keeping this an interface means the routes never
 * learn which one they are talking to.
 */
export interface OtpProvider {
  /** The code to challenge with. Returning it, rather than sending and forgetting,
   *  is what lets the mock provider be deterministic. */
  issue(destination: string, channel: Channel): Promise<string>;
}

/** Six digits, uniformly drawn. Short enough to type, so it is rate limited by attempts. */
function randomCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * The development provider.
 *
 * The code is fixed so a demo or a test can predict it. That is precisely why
 * `createOtpProvider` refuses to hand this out in production.
 */
export const MOCK_CODE = '000000';

export function createMockProvider(log: FastifyBaseLogger): OtpProvider {
  return {
    async issue(destination, channel) {
      log.info({ destination, channel, code: MOCK_CODE }, 'otp issued (mock provider)');
      return MOCK_CODE;
    },
  };
}

/** A provider that generates a real code but has nowhere to send it. */
export function createLoggingProvider(log: FastifyBaseLogger): OtpProvider {
  return {
    async issue(destination, channel) {
      const code = randomCode();
      log.info({ destination, channel }, 'otp issued (not delivered: no provider configured)');
      return code;
    },
  };
}

/**
 * Resolve the provider named by OTP_PROVIDER.
 *
 * A fixed-code provider reachable in production would be an authentication
 * bypass, not a convenience, so it is refused rather than warned about.
 */
export function createOtpProvider(log: FastifyBaseLogger): OtpProvider {
  const name = process.env.OTP_PROVIDER ?? 'mock';

  if (name === 'mock') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('OTP_PROVIDER=mock issues a fixed code and must not run in production');
    }
    return createMockProvider(log);
  }

  return createLoggingProvider(log);
}
