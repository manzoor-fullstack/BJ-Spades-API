import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Declares the permission codes a route requires.
 *
 * AND semantics: the admin must hold every listed code. Enforced by
 * PermissionsGuard, which is registered globally — a route with no decorator
 * only needs authentication.
 */
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(PERMISSIONS_KEY, codes);
