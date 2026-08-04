import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PERMISSION_CODES } from '../../../common/constants/permissions';
import { RequirePermissions } from '../../../common/decorators/require-permissions.decorator';
import { Public } from '../decorators/public.decorator';
import {
  PERMISSION_CACHE_TTL_MS,
  PermissionsGuard,
} from '../guards/permissions.guard';
import { AuthenticatedAdmin } from '../interfaces/authenticated-admin.interface';
import { AuthRepository } from '../repositories/auth.repository';

// A stand-in controller carrying real decorator metadata, so the guard is
// exercised against the same reflection path Nest uses at runtime. The handlers
// are only ever passed around as metadata keys, hence `this: void`.
class TestController {
  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  manageUsers(this: void): string {
    return 'ok';
  }

  @RequirePermissions(
    PERMISSION_CODES.USERS_MANAGE,
    PERMISSION_CODES.ROLES_MANAGE,
  )
  manageBoth(this: void): string {
    return 'ok';
  }

  undecorated(this: void): string {
    return 'ok';
  }

  @Public()
  @RequirePermissions(PERMISSION_CODES.USERS_MANAGE)
  publicRoute(this: void): string {
    return 'ok';
  }
}

const ADMIN: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@bjspades.com',
  role: 'SUPER_ADMIN',
  roleId: 'role-1',
  sessionId: 'session-1',
};

/** `null` means no authenticated admin was attached to the request. */
function contextFor(
  handler: keyof TestController,
  admin: AuthenticatedAdmin | null = ADMIN,
): ExecutionContext {
  return {
    getHandler: () => TestController.prototype[handler],
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({ user: admin ?? undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let findPermissionCodesForAdmin: jest.Mock<Promise<string[]>, [string]>;

  beforeEach(() => {
    findPermissionCodesForAdmin = jest
      .fn<Promise<string[]>, [string]>()
      .mockResolvedValue([PERMISSION_CODES.USERS_MANAGE]);

    const repository = {
      findPermissionCodesForAdmin,
    } as unknown as AuthRepository;

    guard = new PermissionsGuard(new Reflector(), repository);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('grants access when the admin holds the required permission', async () => {
    await expect(guard.canActivate(contextFor('manageUsers'))).resolves.toBe(
      true,
    );
  });

  it('denies access and names the missing permission', async () => {
    const promise = guard.canActivate(contextFor('manageBoth'));

    await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
    await expect(promise).rejects.toThrow(PERMISSION_CODES.ROLES_MANAGE);
    // The one the admin does hold must not be reported as missing.
    await expect(promise).rejects.not.toThrow(
      new RegExp(`Missing:.*${PERMISSION_CODES.USERS_MANAGE}`),
    );
  });

  it('allows routes with no permission metadata', async () => {
    await expect(guard.canActivate(contextFor('undecorated'))).resolves.toBe(
      true,
    );
    expect(findPermissionCodesForAdmin).not.toHaveBeenCalled();
  });

  it('skips public routes even when they declare permissions', async () => {
    await expect(
      guard.canActivate(contextFor('publicRoute', null)),
    ).resolves.toBe(true);
    expect(findPermissionCodesForAdmin).not.toHaveBeenCalled();
  });

  it('denies an authenticated-looking request with no admin attached', async () => {
    await expect(
      guard.canActivate(contextFor('manageUsers', null)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reads the database once for repeated requests inside the TTL', async () => {
    await guard.canActivate(contextFor('manageUsers'));
    await guard.canActivate(contextFor('manageUsers'));
    await guard.canActivate(contextFor('manageUsers'));

    expect(findPermissionCodesForAdmin).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the cache entry has expired', async () => {
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);

    await guard.canActivate(contextFor('manageUsers'));

    now.mockReturnValue(start + PERMISSION_CACHE_TTL_MS + 1);

    await guard.canActivate(contextFor('manageUsers'));

    expect(findPermissionCodesForAdmin).toHaveBeenCalledTimes(2);
  });

  it('picks up a revoked permission after invalidate()', async () => {
    await expect(guard.canActivate(contextFor('manageUsers'))).resolves.toBe(
      true,
    );

    findPermissionCodesForAdmin.mockResolvedValue([]);

    // Still cached, so the stale grant stands.
    await expect(guard.canActivate(contextFor('manageUsers'))).resolves.toBe(
      true,
    );

    guard.invalidate(ADMIN.id);

    await expect(
      guard.canActivate(contextFor('manageUsers')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('invalidate() with no argument clears every admin', async () => {
    await guard.canActivate(contextFor('manageUsers'));

    guard.invalidate();

    await guard.canActivate(contextFor('manageUsers'));

    expect(findPermissionCodesForAdmin).toHaveBeenCalledTimes(2);
  });
});
