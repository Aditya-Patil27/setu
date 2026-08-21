import { randomUUID } from 'node:crypto';

/**
 * Generate a new UUID v4.
 */
export function newId(): string {
  return randomUUID();
}

/**
 * Sleep for the given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an ISO 8601 timestamp string for the current moment.
 */
export function now(): string {
  return new Date().toISOString();
}
