/**
 * Stable, machine-readable error codes returned in every error envelope.
 *
 * These are part of the API contract (docs/03-API-CONTRACT.md). Clients may
 * branch on them, so values must not change once released.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_RECORD: 'DUPLICATE_RECORD',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  RELATION_VIOLATION: 'RELATION_VIOLATION',
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  RATE_LIMITED: 'RATE_LIMITED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
