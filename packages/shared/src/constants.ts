/**
 * Platform-wide constants.
 */

export const SETU = {
  /** Service names used for inter-service routing and NATS subjects. */
  SERVICES: {
    GATEWAY: 'gateway',
    AUTH: 'auth',
    DATA: 'data',
    STORAGE: 'storage',
    FUNCTIONS: 'functions',
    CONSENT: 'consent',
    AUDIT: 'audit',
    WORKFLOW: 'workflow',
    METERING: 'metering',
  },

  /** NATS subjects for event-driven communication. */
  EVENTS: {
    AUDIT_WRITE: 'setu.audit.write',
    CONSENT_CHANGED: 'setu.consent.changed',
    METERING_RECORD: 'setu.metering.record',
    FUNCTION_STATUS: 'setu.function.status',
    WORKFLOW_STATUS: 'setu.workflow.status',
  },

  /** HTTP headers used by the gateway for request context propagation. */
  HEADERS: {
    TENANT_ID: 'x-setu-tenant-id',
    PROJECT_ID: 'x-setu-project-id',
    PRINCIPAL_ID: 'x-setu-principal-id',
    PURPOSE: 'x-setu-purpose',
    REQUEST_ID: 'x-setu-request-id',
  },

  /** Default resource limits for function containers. */
  FUNCTION_DEFAULTS: {
    TIMEOUT_SECONDS: 30,
    MEMORY_MB: 128,
    CPU_MILLICORES: 250,
  },
} as const;
