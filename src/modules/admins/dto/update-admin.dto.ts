import { OmitType, PartialType } from '@nestjs/mapped-types';

import { CreateAdminDto } from './create-admin.dto';

/**
 * `roleId` is deliberately not updatable here.
 *
 * A role change requires `roles.manage` while this route only requires
 * `admins.manage` (docs/03-API-CONTRACT.md) — accepting roleId would let anyone
 * able to edit an admin's name promote them to SUPER_ADMIN. It moves through
 * `PATCH /admins/:id/role` instead, and because the global ValidationPipe runs
 * with `forbidNonWhitelisted`, sending it here is a 400 rather than a silent
 * no-op.
 */
export class UpdateAdminDto extends PartialType(
  OmitType(CreateAdminDto, ['roleId'] as const),
) {}
