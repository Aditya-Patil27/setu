import { ValidationError } from '@setu/shared';

/**
 * The meter vocabulary.
 *
 * Deliberately a closed list rather than a free-text pair, because metering is
 * the obvious way to smuggle personal data past every gate the platform has:
 * a metric named `read.asha_menon.hiv_status` with a value of 1 records a fact
 * about a person in a table that carries no principal, no purpose and no RLS —
 * and it would survive the subject revoking consent, because nothing here
 * consults consent at all.
 *
 * Usage is counts of things the platform did. Anything that needs a subject
 * belongs in audit_records, which has one.
 */
export const METERS = {
  gateway: ['requests', 'rate_limited'],
  data: ['record_reads', 'record_writes', 'collections'],
  storage: ['objects', 'bytes_stored', 'bytes_served'],
  consent: ['artifacts', 'revocations'],
  auth: ['sessions', 'keys_issued'],
  functions: ['invocations', 'compute_ms'],
} as const;

export type ServiceName = keyof typeof METERS;

export function assertMeter(service: string, metric: string): void {
  const metrics = (METERS as Record<string, readonly string[]>)[service];

  // One answer for an unknown service and an unknown metric, so the rejection
  // does not enumerate which meters a future release might add.
  if (!metrics || !metrics.includes(metric)) {
    throw new ValidationError(`Unknown meter '${service}.${metric}'`, { service, metric });
  }
}

/** Every meter, for callers that would otherwise guess. */
export function listMeters(): Array<{ service: string; metrics: readonly string[] }> {
  return Object.entries(METERS).map(([service, metrics]) => ({ service, metrics }));
}
