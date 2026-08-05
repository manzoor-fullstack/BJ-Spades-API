import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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

import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UpdateRolePermissionsDto } from './dto/update-role-permissions.dto';

/** The audited subject, however much of it the handler gave back. */
function roleLabel(ctx: AuditContext, result: unknown): string {
  return (
    readString(result, 'displayName') ??
    readString(result, 'name') ??
    ctx.params.id ??
    'role'
  );
}

function roleId(ctx: AuditContext, result: unknown): string | undefined {
  return readString(result, 'id') ?? ctx.params.id;
}

// Every route needs the same code, so it is declared once on the class.
@ApiTags('roles')
@ApiBearerAuth('access-token')
@RequirePermissions(PERMISSION_CODES.ROLES_MANAGE)
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ROLE_CREATED.code,
    title: (ctx, result) => `Role ${roleLabel(ctx, result)} created`,
    entityType: 'Role',
    entityId: roleId,
  })
  @Post()
  @ApiOperation({ summary: 'Create a role' })
  create(@Body() dto: CreateRoleDto) {
    return this.rolesService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List roles with their admin headcount and permission codes',
  })
  findAll() {
    return this.rolesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one role' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.findById(id);
  }

  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ROLE_UPDATED.code,
    title: (ctx, result) => `Role ${roleLabel(ctx, result)} updated`,
    entityType: 'Role',
    entityId: roleId,
    metadata: (ctx) => ({ submitted: ctx.body }),
  })
  @Patch(':id')
  @ApiOperation({ summary: 'Update a role' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.rolesService.update(id, dto);
  }

  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ROLE_DELETED.code,
    title: (ctx, result) => `Role ${roleLabel(ctx, result)} deleted`,
    entityType: 'Role',
    entityId: (ctx) => ctx.params.id,
  })
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a role; refused for system roles and roles still held',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.rolesService.remove(id);
  }

  @AuditLog({
    category: ActivityCategory.ADMIN,
    action: ACTIVITY_ACTIONS.ROLE_PERMISSIONS_CHANGED.code,
    title: (ctx, result) =>
      `Permissions replaced for role ${roleLabel(ctx, result)}`,
    entityType: 'Role',
    entityId: roleId,
    // The resulting set, not the submitted one: after a full replace they are
    // the same list, and reading it off the result proves what was stored.
    metadata: (_ctx, result) => ({
      permissions:
        result !== null && typeof result === 'object' && 'permissions' in result
          ? result.permissions
          : [],
    }),
  })
  @Put(':id/permissions')
  @ApiOperation({
    summary: 'Replace a role permission set wholesale',
  })
  replacePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRolePermissionsDto,
  ) {
    return this.rolesService.replacePermissions(id, dto);
  }
}
