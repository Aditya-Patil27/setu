import type { ZodType, ZodTypeDef } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Parse untrusted input at a system boundary.
 *
 * Throws ValidationError rather than zod's own error so that every service
 * surfaces the same 400 shape, and so route handlers never have to branch on
 * a `success` flag they might forget to check.
 *
 * Input is typed `unknown` explicitly: with three type parameters free, TS can
 * infer the input side — where defaults are still optional — and defaults would
 * appear missing to callers. Pinning Input=unknown binds T to the output side.
 */
export function parseInput<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  data: unknown,
  what = "request",
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(`Invalid ${what}`, result.error.flatten());
  }
  return result.data;
}
