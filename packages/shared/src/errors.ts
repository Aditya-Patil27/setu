/**
 * Custom error classes for the Setu platform.
 * All services should throw these instead of generic Error instances.
 */

export class SetuError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'SetuError';
    this.statusCode = statusCode;
    this.code = code;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

export class NotFoundError extends SetuError {
  constructor(resource: string, id: string) {
    super(`${resource} '${id}' not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends SetuError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends SetuError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class ConsentDeniedError extends SetuError {
  constructor(purpose: string, fields: string[]) {
    super(
      `Consent denied for purpose '${purpose}' on fields: ${fields.join(', ')}`,
      403,
      'CONSENT_DENIED',
    );
    this.name = 'ConsentDeniedError';
  }
}

export class ValidationError extends SetuError {
  public readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class ConflictError extends SetuError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends SetuError {
  constructor() {
    super('Rate limit exceeded', 429, 'RATE_LIMIT_EXCEEDED');
    this.name = 'RateLimitError';
  }
}
