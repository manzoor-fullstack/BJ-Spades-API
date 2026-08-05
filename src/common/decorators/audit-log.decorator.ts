import { SetMetadata } from '@nestjs/common';
import type { ActivityCategory } from '@prisma/client';

import type { ActivityActionCode } from '../constants/activity-actions';

export const AUDIT_LOG_KEY = 'audit-log';

/** Just enough of the authenticated admin for an audit entry. */
export interface AuditActor {
  id: string;
  email: string;
}

/**
 * What a resolver sees. Captured before the handler runs, because a handler is
 * free to mutate the body it was given.
 */
export interface AuditContext {
  admin?: AuditActor;
  params: Record<string, string>;
  body: unknown;
  query: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * A literal, or a function evaluated once the handler has resolved.
 *
 * The function form is what makes `New user ${result.fullName} created` work:
 * the interceptor runs after the handler, so the created row is in hand.
 */
export type AuditResolver<T> = (ctx: AuditContext, result: unknown) => T;

export type AuditValue<T> = T | AuditResolver<T>;

export interface AuditLogOptions {
  category: ActivityCategory;
  action: ActivityActionCode;
  title: AuditValue<string>;
  description?: AuditValue<string | undefined>;
  entityType?: string;
  entityId?: AuditValue<string | undefined>;
  /**
   * Defaults to the sanitized request body.
   *
   * Resolver-only: `AuditValue<unknown>` would collapse to plain `unknown`,
   * which strips the contextual typing an inline arrow function needs.
   */
  metadata?: AuditResolver<unknown>;
  /** Defaults to the action catalogue's flag. */
  isHighPriority?: boolean;
}

/**
 * Declares that a successful call to this route writes an ActivityLog entry.
 *
 * Read by AuditInterceptor, which is registered globally — adding logging to a
 * new endpoint is this one decorator and nothing else.
 */
export const AuditLog = (options: AuditLogOptions) =>
  SetMetadata(AUDIT_LOG_KEY, options);

export function resolveAuditValue<T>(
  value: AuditValue<T> | undefined,
  ctx: AuditContext,
  result: unknown,
): T | undefined {
  if (typeof value === 'function') {
    return (value as (ctx: AuditContext, result: unknown) => T)(ctx, result);
  }

  return value;
}

/**
 * Narrows a field off an `unknown` handler result.
 *
 * Resolvers receive `unknown` rather than the DTO type: metadata is erased at
 * runtime, and a decorator cannot see the handler's return type without an
 * `any` somewhere. Reading fields through this keeps that honest.
 */
export function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[key];

  return typeof value === 'string' ? value : undefined;
}
