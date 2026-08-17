import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';

import {
  AUDIT_LOG_KEY,
  resolveAuditValue,
  type AuditContext,
  type AuditLogOptions,
} from '../decorators/audit-log.decorator';
import { extractRequestContext } from '../http/request-context.util';
import {
  ActivityLogService,
  type RecordActivityInput,
} from '../../modules/activity/activity.service';

/** The shape JwtStrategy attaches; typed structurally to keep common/ decoupled. */
interface RequestWithAdmin extends Request {
  user?: { id: string; email: string };
}

/**
 * Writes the ActivityLog entry declared by `@AuditLog()` once the handler has
 * resolved, so both the request context and the result are in hand.
 *
 * Two rules, both from docs/phases/PHASE-2.md:
 *
 *  - Fire-and-forget. The write is never awaited on the response path, so an
 *    audit insert cannot add latency to every mutation.
 *  - A failed audit write never fails the request. Losing an entry is bad;
 *    failing a successful user creation because the entry could not be stored
 *    is worse. Errors are swallowed here and reported to the Nest logger.
 *
 * Only successful calls are logged. A handler that throws writes nothing —
 * failed logins are recorded explicitly by AuthService, which is the only place
 * that knows a failure happened at all.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly activityLog: ActivityLogService,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<
      AuditLogOptions | undefined
    >(AUDIT_LOG_KEY, [context.getHandler(), context.getClass()]);

    if (!options || context.getType() !== 'http') {
      return next.handle();
    }

    // Snapshotted before the handler runs: a handler is free to mutate the
    // body it was handed, and the audit entry must describe what was asked for.
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    const auditContext = this.buildContext(context);

    // `tap`'s next callback fires only on a successful emission.
    return next
      .handle()
      .pipe(
        tap((result) => this.write(options, auditContext, result, request)),
      );
  }

  private buildContext(context: ExecutionContext): AuditContext {
    const request = context.switchToHttp().getRequest<RequestWithAdmin>();
    const { ipAddress, userAgent } = extractRequestContext(request);

    return {
      admin: request.user,
      params: (request.params ?? {}) as Record<string, string>,
      body: request.body,
      query: request.query ?? {},
      ipAddress,
      userAgent,
    };
  }

  private write(
    options: AuditLogOptions,
    ctx: AuditContext,
    result: unknown,
    request: RequestWithAdmin,
  ): void {
    try {
      // See resolveAuditBody: a multipart route's eager snapshot is always
      // empty, never a value the handler could have mutated, so this is the
      // only place the live body can safely stand in for it.
      const resolvedCtx: AuditContext = {
        ...ctx,
        body: this.resolveAuditBody(ctx.body, request),
      };

      const input = this.buildEntry(options, resolvedCtx, result);

      // Deliberately not awaited. `record()` already swallows its own failures;
      // the catch here guards against a future change to that contract.
      void this.activityLog
        .record(input)
        .catch((error: unknown) => this.reportFailure(options.action, error));
    } catch (error) {
      // A throwing title or entityId resolver lands here.
      this.reportFailure(options.action, error);
    }
  }

  /**
   * `ctx.body` is deliberately snapshotted in `buildContext`, before the
   * handler runs, so a handler cannot scrub its own audit trail by mutating
   * the body it was given. That protection is aimed at JSON/urlencoded
   * routes, where Express's body parser has already populated `request.body`
   * by the time this (global) interceptor runs, so the snapshot is already
   * the real submitted body.
   *
   * Multipart routes break that assumption a different way: multer is wired
   * in as a *route-level* interceptor (`ImageUploadInterceptor`), which — per
   * Nest's `[...global, ...class, ...method]` interceptor ordering
   * (`ContextCreator.createContext`) — runs after this global interceptor's
   * synchronous setup, and it replaces `req.body` wholesale
   * (`Object.create(null)`, see multer's `make-middleware.js`) rather than
   * mutating whatever was there. The eager snapshot for those routes is
   * therefore always empty, never a value a handler mutated, so falling back
   * to the live body here cannot reintroduce the mutation risk the snapshot
   * exists to prevent — the fallback only ever fires when the snapshot could
   * not possibly have been meaningful in the first place.
   */
  private resolveAuditBody(
    snapshot: unknown,
    request: RequestWithAdmin,
  ): unknown {
    return this.isEmptyBody(snapshot) ? request.body : snapshot;
  }

  private isEmptyBody(body: unknown): boolean {
    if (body === undefined || body === null) {
      return true;
    }

    if (typeof body === 'object') {
      return Object.keys(body as Record<string, unknown>).length === 0;
    }

    return false;
  }

  private buildEntry(
    options: AuditLogOptions,
    ctx: AuditContext,
    result: unknown,
  ): RecordActivityInput {
    return {
      category: options.category,
      action: options.action,
      title: resolveAuditValue(options.title, ctx, result),
      description: resolveAuditValue(options.description, ctx, result) ?? null,
      adminId: ctx.admin?.id ?? null,
      entityType: options.entityType ?? null,
      entityId: resolveAuditValue(options.entityId, ctx, result) ?? null,
      // Defaults to the request body, which is why the denylist matters: a
      // create-admin body carries a plaintext password.
      metadata:
        options.metadata === undefined
          ? ctx.body
          : options.metadata(ctx, result),
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      isHighPriority: options.isHighPriority,
    };
  }

  private reportFailure(action: string, error: unknown): void {
    this.logger.error(
      `Audit log write for "${action}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
