import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PERMISSIONS_KEY } from '../../../common/decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedRequest } from '../interfaces/authenticated-request.interface';
import { AuthRepository } from '../repositories/auth.repository';

interface CacheEntry {
  codes: Set<string>;
  /** Epoch ms after which the entry is stale and must be re-read. */
  expiresAt: number;
}

/**
 * Long enough to remove the join from every request, short enough that a
 * permission change nobody bothered to invalidate still lands within a minute.
 */
export const PERMISSION_CACHE_TTL_MS = 60_000;

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly reflector: Reflector,
    private readonly authRepository: AuthRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No declaration means the route only needs authentication, which
    // JwtAuthGuard has already established.
    if (!required || required.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<Partial<AuthenticatedRequest>>();

    const admin = request.user;

    if (!admin) {
      throw new ForbiddenException(
        'You do not have permission to perform this action.',
      );
    }

    const granted = await this.resolvePermissions(admin.id);

    const missing = required.filter((code) => !granted.has(code));

    if (missing.length > 0) {
      throw new ForbiddenException(
        `You do not have permission to perform this action. Missing: ${missing.join(', ')}.`,
      );
    }

    return true;
  }

  /**
   * Drops cached permissions so the next request re-reads them.
   *
   * Called when a role's permissions or an admin's role changes (Phase 3);
   * without it a revoked permission would keep working for up to a minute.
   */
  invalidate(adminId?: string): void {
    if (adminId === undefined) {
      this.cache.clear();
      return;
    }

    this.cache.delete(adminId);
  }

  private async resolvePermissions(adminId: string): Promise<Set<string>> {
    const cached = this.cache.get(adminId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.codes;
    }

    const codes = new Set(
      await this.authRepository.findPermissionCodesForAdmin(adminId),
    );

    this.cache.set(adminId, {
      codes,
      expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS,
    });

    return codes;
  }
}
