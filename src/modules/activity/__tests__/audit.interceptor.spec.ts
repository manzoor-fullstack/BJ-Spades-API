import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ActivityCategory } from '@prisma/client';
import { firstValueFrom, of, throwError } from 'rxjs';

import { ACTIVITY_ACTIONS } from '../../../common/constants/activity-actions';
import type { AuditLogOptions } from '../../../common/decorators/audit-log.decorator';
import { AuditInterceptor } from '../../../common/interceptors/audit.interceptor';
import type {
  ActivityLogService,
  RecordActivityInput,
} from '../activity.service';

interface RequestStub {
  user?: { id: string; email: string };
  params: Record<string, string>;
  body: unknown;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  ip: string;
  socket: { remoteAddress?: string };
}

function requestStub(overrides: Partial<RequestStub> = {}): RequestStub {
  return {
    user: { id: 'admin-1', email: 'admin@bjspades.com' },
    params: { id: 'user-1' },
    body: {},
    query: {},
    headers: { 'user-agent': 'jest/1.0' },
    ip: '203.0.113.7',
    socket: {},
    ...overrides,
  };
}

function executionContext(request: RequestStub): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const OPTIONS: AuditLogOptions = {
  category: ActivityCategory.USER,
  action: ACTIVITY_ACTIONS.USER_CREATED.code,
  title: (_ctx, result) =>
    `New user ${(result as { fullName: string }).fullName} created`,
  entityType: 'User',
  entityId: (_ctx, result) => (result as { id: string }).id,
};

const RESULT = { id: 'user-9', fullName: 'Ada Lovelace' };

describe('AuditInterceptor', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let activityLog: { record: jest.Mock };
  let interceptor: AuditInterceptor;

  const handler = (value: unknown = RESULT): CallHandler => ({
    handle: () => of(value),
  });

  /** The single entry the interceptor tried to write. */
  const recorded = (): RecordActivityInput =>
    (activityLog.record.mock.calls as [RecordActivityInput][])[0]![0];

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(OPTIONS) };
    activityLog = { record: jest.fn().mockResolvedValue(undefined) };

    interceptor = new AuditInterceptor(
      reflector as unknown as Reflector,
      activityLog as unknown as ActivityLogService,
    );

    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does nothing on a route with no @AuditLog', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(activityLog.record).not.toHaveBeenCalled();
  });

  it('resolves title and entityId from the handler result', async () => {
    await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(recorded()).toMatchObject({
      category: ActivityCategory.USER,
      action: 'user.created',
      title: 'New user Ada Lovelace created',
      entityType: 'User',
      entityId: 'user-9',
      adminId: 'admin-1',
    });
  });

  it('accepts literal values as well as resolvers', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      category: ActivityCategory.AUTH,
      action: ACTIVITY_ACTIONS.AUTH_LOGOUT.code,
      title: 'Admin signed out',
    } satisfies AuditLogOptions);

    await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(recorded().title).toBe('Admin signed out');
  });

  it('captures the client IP and user agent', async () => {
    await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(recorded()).toMatchObject({
      ipAddress: '203.0.113.7',
      userAgent: 'jest/1.0',
    });
  });

  it('prefers the left-most X-Forwarded-For entry', async () => {
    const request = requestStub({
      headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' },
    });

    await firstValueFrom(
      interceptor.intercept(executionContext(request), handler()),
    );

    expect(recorded().ipAddress).toBe('198.51.100.4');
  });

  it('leaves adminId null on a route with no authenticated admin', async () => {
    const request = requestStub({ user: undefined });

    await firstValueFrom(
      interceptor.intercept(executionContext(request), handler()),
    );

    expect(recorded().adminId).toBeNull();
  });

  it('falls back to the request body for metadata', async () => {
    const request = requestStub({
      body: { fullName: 'Ada Lovelace', password: 'Hunter2!' },
    });

    await firstValueFrom(
      interceptor.intercept(executionContext(request), handler()),
    );

    // Passed through untouched here; ActivityLogService applies the denylist
    // once, so every writer gets it and not just this one.
    expect(recorded().metadata).toEqual({
      fullName: 'Ada Lovelace',
      password: 'Hunter2!',
    });
  });

  it('uses a metadata resolver when one is declared', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      ...OPTIONS,
      metadata: (_ctx, result) => ({
        createdId: (result as { id: string }).id,
      }),
    } satisfies AuditLogOptions);

    await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(recorded().metadata).toEqual({ createdId: 'user-9' });
  });

  it('captures the body the handler was given, not a later replacement', async () => {
    const request = requestStub({ body: { fullName: 'Ada Lovelace' } });

    const replacing: CallHandler = {
      handle: () => {
        request.body = { fullName: 'something else entirely' };
        return of(RESULT);
      },
    };

    await firstValueFrom(
      interceptor.intercept(executionContext(request), replacing),
    );

    expect(recorded().metadata).toEqual({ fullName: 'Ada Lovelace' });
  });

  // Multer (wired in as a route-level interceptor, e.g. ImageUploadInterceptor)
  // runs after this global interceptor's synchronous snapshot, and replaces
  // `req.body` wholesale rather than mutating it — so a multipart route's
  // eager snapshot is always empty, never a value a handler could have
  // mutated. These two tests simulate that with a handler that populates
  // `request.body` only once it runs, the same shape multer's timing produces.
  it('falls back to the live request body when the snapshot is undefined', async () => {
    const request = requestStub({ body: undefined });

    const parsing: CallHandler = {
      handle: () => {
        request.body = { firstName: 'Audited' };
        return of(RESULT);
      },
    };

    await firstValueFrom(
      interceptor.intercept(executionContext(request), parsing),
    );

    expect(recorded().metadata).toEqual({ firstName: 'Audited' });
  });

  it('falls back to the live request body when the snapshot is an empty object', async () => {
    const request = requestStub({ body: {} });

    const parsing: CallHandler = {
      handle: () => {
        request.body = { firstName: 'Audited' };
        return of(RESULT);
      },
    };

    await firstValueFrom(
      interceptor.intercept(executionContext(request), parsing),
    );

    expect(recorded().metadata).toEqual({ firstName: 'Audited' });
  });

  it('writes nothing when the handler throws', async () => {
    const failing: CallHandler = {
      handle: () => throwError(() => new Error('handler exploded')),
    };

    await expect(
      firstValueFrom(
        interceptor.intercept(executionContext(requestStub()), failing),
      ),
    ).rejects.toThrow('handler exploded');

    expect(activityLog.record).not.toHaveBeenCalled();
  });

  it('passes the handler result through untouched', async () => {
    const emitted = await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(emitted).toBe(RESULT);
  });

  // The rule from PHASE-2: failing a successful user creation because the audit
  // write failed is worse than losing the audit row.
  it('does not fail the request when the log write rejects', async () => {
    activityLog.record.mockRejectedValue(new Error('database is on fire'));

    const emitted = await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(emitted).toBe(RESULT);
  });

  it('reports a rejected log write to the application logger', async () => {
    const error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    activityLog.record.mockRejectedValue(new Error('database is on fire'));

    await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    // The rejection is handled a microtask after the response is emitted.
    await Promise.resolve();
    await Promise.resolve();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('database is on fire'),
    );
  });

  it('does not fail the request when the log write throws synchronously', async () => {
    activityLog.record.mockImplementation(() => {
      throw new Error('synchronous explosion');
    });

    const emitted = await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(emitted).toBe(RESULT);
  });

  it('does not fail the request when a resolver throws', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      ...OPTIONS,
      title: () => {
        throw new Error('bad resolver');
      },
    } satisfies AuditLogOptions);

    const emitted = await firstValueFrom(
      interceptor.intercept(executionContext(requestStub()), handler()),
    );

    expect(emitted).toBe(RESULT);
    expect(activityLog.record).not.toHaveBeenCalled();
  });

  it('ignores non-HTTP execution contexts', async () => {
    const context = {
      ...executionContext(requestStub()),
      getType: () => 'rpc',
    } as unknown as ExecutionContext;

    await firstValueFrom(interceptor.intercept(context, handler()));

    expect(activityLog.record).not.toHaveBeenCalled();
  });
});
