import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActivityCategory } from '@prisma/client';

import { ACTIVITY_ACTIONS } from '../../common/constants/activity-actions';
import { PERMISSION_CODES } from '../../common/constants/permissions';
import {
  AuditLog,
  readString,
  type AuditContext,
} from '../../common/decorators/audit-log.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentAdmin } from '../auth/decorators/current-admin.decorator';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';

import { AdminsService } from './admins.service';
import { CreateAdminDto } from './dto/create-admin.dto';
import { QueryAdminsDto } from './dto/query-admins.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { UpdateAdminRoleDto } from './dto/update-admin-role.dto';

/** The audited subject, however much of it the handler gave back. */
function adminLabel(ctx: AuditContext, result: unknown): string {
  return (
    readString(result, 'fullName') ??
    readString(result, 'email') ??
    ctx.params.id ??
    'admin'
  );
}

function adminId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

function roleLabel(result: unknown): string {
  if (result === null || typeof result !== 'object' || !('role' in result)) {
    return 'a new role';
  }

  const role = result.role;

  return (
    readString(role, 'displayName') ?? readString(role, 'name') ?? 'a new role'
  );
}

// PATCH /admins/:id/role requires roles.manage, not admins.manage
// (docs/03-API-CONTRACT.md), so the codes are declared per route rather than
// once on the class.
@ApiTags('admins')
@ApiBearerAuth('access-token')
@Controller('admins')
export class AdminsController {
  constructor(private readonly adminsService: AdminsService) {}

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ADMIN_CREATED.code,
    title: (ctx, result) =>
      `Administrator ${adminLabel(ctx, result)} created with role ${roleLabel(result)}`,
    entityType: 'Admin',
    entityId: adminId,
  })
  @Post()
  @ApiOperation({ summary: 'Create an administrator' })
  create(@Body() dto: CreateAdminDto) {
    return this.adminsService.create(dto);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Get()
  @ApiOperation({
    summary: 'List administrators with pagination, search and a role filter',
  })
  findAll(@Query() query: QueryAdminsDto) {
    return this.adminsService.findAll(query);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @Get(':id')
  @ApiOperation({ summary: 'Fetch one administrator' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminsService.findById(id);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ADMIN_UPDATED.code,
    title: (ctx, result) => `Administrator ${adminLabel(ctx, result)} updated`,
    entityType: 'Admin',
    entityId: adminId,
    // The submitted fields; the sanitizer drops `password` before it is stored.
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Patch(':id')
  @ApiOperation({
    summary: 'Update an administrator; the role moves elsewhere',
  })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdminDto) {
    return this.adminsService.update(id, dto);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ADMIN_DELETED.code,
    title: (ctx, result) => `Administrator ${adminLabel(ctx, result)} deleted`,
    entityType: 'Admin',
    entityId: (ctx) => ctx.params.id,
  })
  @Delete(':id')
  @ApiOperation({
    summary:
      'Delete an administrator; refused for yourself or the last super admin',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminsService.remove(id, admin);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ADMIN_ACTIVATED.code,
    title: (ctx, result) =>
      `Administrator ${adminLabel(ctx, result)} activated`,
    entityType: 'Admin',
    entityId: adminId,
  })
  @Patch(':id/activate')
  @ApiOperation({ summary: 'Re-enable an administrator account' })
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminsService.activate(id);
  }

  @RequirePermissions(PERMISSION_CODES.ADMINS_MANAGE)
  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ADMIN_DEACTIVATED.code,
    title: (ctx, result) =>
      `Administrator ${adminLabel(ctx, result)} deactivated`,
    entityType: 'Admin',
    entityId: adminId,
  })
  @Patch(':id/deactivate')
  @ApiOperation({
    summary:
      'Disable an administrator; refused for yourself or the last super admin',
  })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.adminsService.deactivate(id, admin);
  }

  @RequirePermissions(PERMISSION_CODES.ROLES_MANAGE)
  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ADMIN_ROLE_CHANGED.code,
    title: (ctx, result) =>
      `Administrator ${adminLabel(ctx, result)} moved to role ${roleLabel(result)}`,
    entityType: 'Admin',
    entityId: adminId,
  })
  @Patch(':id/role')
  @ApiOperation({
    summary: 'Move an administrator to another role (requires roles.manage)',
  })
  changeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminRoleDto,
  ) {
    return this.adminsService.changeRole(id, dto.roleId);
  }
}
