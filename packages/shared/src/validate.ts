import type { ZodType } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Parse untrusted input at a system boundary.
 *
 * Throws ValidationError rather than zod's own error so that every service
 * surfaces the same 400 shape, and so route handlers never have to branch on
 * a `success` flag they might forget to check.
 */
export function parseInput<T>(schema: ZodType<T>, data: unknown, what = 'request'): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(`Invalid ${what}`, result.error.flatten());
  }
  return result.data;
}
