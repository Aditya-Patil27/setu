import { SETU } from '@setu/shared';

/**
 * Event publishing, behind an interface.
 *
 * NATS is not a dependency yet — M7 Audit is the service that will consume these
 * subjects, and it is out of scope for this pass. Keeping the seam here means
 * wiring NATS in later touches this file and nothing else.
 */
export interface EventPublisher {
  publish(subject: string, payload: unknown): Promise<void>;
}

/** Records nothing but the log line. The default until M7 exists. */
export function createLoggingPublisher(log: {
  debug: (obj: unknown, msg: string) => void;
}): EventPublisher {
  return {
    async publish(subject, payload) {
      log.debug({ subject, payload }, 'event published');
    },
  };
}

/** Captures published events. For assertions in tests. */
export function createRecordingPublisher(): EventPublisher & {
  events: Array<{ subject: string; payload: unknown }>;
} {
  const events: Array<{ subject: string; payload: unknown }> = [];
  return {
    events,
    async publish(subject, payload) {
      events.push({ subject, payload });
    },
  };
}

export const CONSENT_CHANGED = SETU.EVENTS.CONSENT_CHANGED;
