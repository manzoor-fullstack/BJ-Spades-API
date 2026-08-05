import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { PermissionsGuard } from '../auth/guards/permissions.guard';

import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UpdateRolePermissionsDto } from './dto/update-role-permissions.dto';
import { RolesRepository } from './repositories/roles.repository';
import {
  toRoleListItem,
  type RoleListItem,
  type RoleWithMeta,
} from './serializers/role.serializer';

@Injectable()
export class RolesService {
  constructor(
    private readonly repository: RolesRepository,
    // The APP_GUARD instance, injected through AuthModule's export. Constructing
    // another would give this service a private cache to invalidate while the
    // one guarding requests kept serving stale permissions.
    private readonly permissionsGuard: PermissionsGuard,
  ) {}

  async create(dto: CreateRoleDto): Promise<RoleListItem> {
    if (await this.repository.findByName(dto.name)) {
      throw new ConflictException('Role already exists');
    }

    return toRoleListItem(await this.repository.create(dto));
  }

  async findAll(): Promise<RoleListItem[]> {
    const roles = await this.repository.findMany();

    return roles.map(toRoleListItem);
  }

  async findById(id: string): Promise<RoleListItem> {
    return toRoleListItem(await this.getOrThrow(id));
  }

  async update(id: string, dto: UpdateRoleDto): Promise<RoleListItem> {
    await this.getOrThrow(id);

    return toRoleListItem(await this.repository.update(id, dto));
  }

  async remove(id: string): Promise<RoleListItem> {
    const role = await this.getOrThrow(id);

    // The four seeded roles are structural: the seed recreates them, the guard
    // rails key off SUPER_ADMIN by name, and deleting one would cascade its
    // RolePermission rows away.
    if (role.isSystem) {
      throw new UnprocessableEntityException(
        `The ${role.displayName} role is a system role and cannot be deleted.`,
      );
    }

    // Admin.roleId is a required foreign key, so deleting a held role either
    // fails with a raw database error or leaves admins pointing at nothing.
    if (role._count.admins > 0) {
      throw new UnprocessableEntityException(
        `The ${role.displayName} role is still assigned to ${role._count.admins} ` +
          `admin${role._count.admins === 1 ? '' : 's'}. Move them to another role first.`,
      );
    }

    return toRoleListItem(await this.repository.delete(id));
  }

  /**
   * Replaces the role's permissions and evicts the permission cache for every
   * admin holding it.
   *
   * Without the eviction a permission revoked for a security reason would keep
   * working for up to PERMISSION_CACHE_TTL_MS (docs/phases/PHASE-3.md, 3.12).
   */
  async replacePermissions(
    id: string,
    dto: UpdateRolePermissionsDto,
  ): Promise<RoleListItem> {
    await this.getOrThrow(id);

    const codes = [...new Set(dto.permissionCodes)];
    const permissions = await this.repository.findPermissionsByCodes(codes);

    // Rejected rather than ignored: silently dropping a misspelled code would
    // report success while granting less than the caller asked for.
    if (permissions.length !== codes.length) {
      const known = new Set(permissions.map((permission) => permission.code));
      const unknown = codes.filter((code) => !known.has(code));

      throw new BadRequestException(
        `Unknown permission code${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`,
      );
    }

    await this.repository.replacePermissions(
      id,
      permissions.map((permission) => permission.id),
    );

    const adminIds = await this.repository.findAdminIdsByRoleId(id);

    for (const adminId of adminIds) {
      this.permissionsGuard.invalidate(adminId);
    }

    return toRoleListItem(await this.getOrThrow(id));
  }

  private async getOrThrow(id: string): Promise<RoleWithMeta> {
    const role = await this.repository.findById(id);

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    return role;
  }
}
