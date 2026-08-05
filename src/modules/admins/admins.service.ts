import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  buildPaginationMeta,
  resolveSortField,
  SortOrder,
} from '../../common/dto/pagination.dto';
import type { Paginated } from '../../common/interceptors/transform.interceptor';
import { SUPER_ADMIN_ROLE } from '../../common/constants/roles';
import { PasswordService } from '../../common/password/password.service';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { AuthenticatedAdmin } from '../auth/interfaces/authenticated-admin.interface';
import { RolesService } from '../roles/roles.service';

import { CreateAdminDto } from './dto/create-admin.dto';
import { QueryAdminsDto } from './dto/query-admins.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { AdminsRepository } from './repositories/admins.repository';
import type {
  AdminFilter,
  ListAdminsArgs,
  UpdateAdminData,
} from './repositories/admins.repository';
import {
  toAdminListItem,
  type AdminListItem,
  type AdminWithRole,
} from './serializers/admin.serializer';

/**
 * Columns a client may sort by. `sortBy` reaches Prisma as an object key, so an
 * unfiltered value is both an injection surface and a way to order by columns
 * that were never meant to be exposed — `password` among them.
 */
const SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'firstName',
  'lastName',
  'email',
  'lastLogin',
  'isActive',
] as const;

const DEFAULT_SORT_FIELD = 'createdAt';

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class AdminsService {
  constructor(
    private readonly repository: AdminsRepository,
    private readonly passwordService: PasswordService,
    private readonly rolesService: RolesService,
    // The APP_GUARD instance, injected through AuthModule's export — see the
    // note in RolesService.
    private readonly permissionsGuard: PermissionsGuard,
  ) {}

  async create(dto: CreateAdminDto): Promise<AdminListItem> {
    const email = normaliseEmail(dto.email);

    if (await this.repository.findByEmail(email)) {
      throw new ConflictException('Admin email already exists');
    }

    // Throws NotFoundException when the role does not exist.
    await this.rolesService.findById(dto.roleId);

    return toAdminListItem(
      await this.repository.create({
        firstName: dto.firstName,
        lastName: dto.lastName,
        email,
        password: await this.passwordService.hash(dto.password),
        roleId: dto.roleId,
      }),
    );
  }

  /** Used by the auth flow; returns the raw row because it needs the hash. */
  async findByEmail(email: string): Promise<AdminWithRole | null> {
    return this.repository.findByEmail(normaliseEmail(email));
  }

  async findById(id: string): Promise<AdminListItem> {
    return toAdminListItem(await this.getOrThrow(id));
  }

  async findAll(query: QueryAdminsDto): Promise<Paginated<AdminListItem[]>> {
    const args = this.buildListArgs(query);

    const [admins, total] = await Promise.all([
      this.repository.findMany(args),
      this.repository.count(args.filter),
    ]);

    return {
      data: admins.map(toAdminListItem),
      meta: buildPaginationMeta(total, query.page, query.limit),
    };
  }

  async update(id: string, dto: UpdateAdminDto): Promise<AdminListItem> {
    const existing = await this.getOrThrow(id);

    const data: UpdateAdminData = {};

    if (dto.firstName !== undefined) {
      data.firstName = dto.firstName;
    }

    if (dto.lastName !== undefined) {
      data.lastName = dto.lastName;
    }

    if (dto.email !== undefined) {
      const email = normaliseEmail(dto.email);

      if (email !== existing.email) {
        if (await this.repository.findByEmail(email)) {
          throw new ConflictException('Admin email already exists');
        }

        data.email = email;
      }
    }

    // Hashed here, never stored as submitted. The previous implementation
    // passed the DTO straight through, which would have written plaintext.
    if (dto.password !== undefined) {
      data.password = await this.passwordService.hash(dto.password);
    }

    return toAdminListItem(await this.repository.update(id, data));
  }

  async remove(
    id: string,
    currentAdmin: AuthenticatedAdmin,
  ): Promise<AdminListItem> {
    const admin = await this.getOrThrow(id);

    this.assertNotSelf(id, currentAdmin, 'delete');
    await this.assertNotLastActiveSuperAdmin(admin, 'Deleting');

    const deleted = await this.repository.delete(id);

    // The row is gone, but a cache entry keyed by its id would outlive it and
    // could authorise a request if the id were ever reused.
    this.permissionsGuard.invalidate(id);

    return toAdminListItem(deleted);
  }

  async activate(id: string): Promise<AdminListItem> {
    await this.getOrThrow(id);

    return toAdminListItem(
      await this.repository.update(id, { isActive: true }),
    );
  }

  async deactivate(
    id: string,
    currentAdmin: AuthenticatedAdmin,
  ): Promise<AdminListItem> {
    const admin = await this.getOrThrow(id);

    this.assertNotSelf(id, currentAdmin, 'deactivate');
    await this.assertNotLastActiveSuperAdmin(admin, 'Deactivating');

    return toAdminListItem(
      await this.repository.update(id, { isActive: false }),
    );
  }

  /**
   * Moves an admin to another role.
   *
   * Requires `roles.manage` rather than `admins.manage`
   * (docs/03-API-CONTRACT.md): changing a role changes what someone can do, so
   * it belongs with permission management, not with editing a name.
   *
   * There is deliberately no self-check here. Demoting yourself is legitimate
   * while another active super admin remains, and the case that would lock
   * everyone out is already refused below.
   */
  async changeRole(id: string, roleId: string): Promise<AdminListItem> {
    const admin = await this.getOrThrow(id);
    const role = await this.rolesService.findById(roleId);

    if (role.name !== SUPER_ADMIN_ROLE) {
      await this.assertNotLastActiveSuperAdmin(admin, 'Changing the role of');
    }

    const updated = await this.repository.update(id, { roleId });

    // Immediately, not on the next cache expiry: the point of a demotion is
    // that the permissions stop working now.
    this.permissionsGuard.invalidate(id);

    return toAdminListItem(updated);
  }

  async updateLastLogin(id: string): Promise<AdminListItem> {
    return toAdminListItem(
      await this.repository.update(id, { lastLogin: new Date() }),
    );
  }

  private buildListArgs(query: QueryAdminsDto): ListAdminsArgs {
    const search = query.search?.trim();

    const filter: AdminFilter = {
      search: search ? search : undefined,
      roleId: query.roleId,
      roleName: query.role?.trim() ? query.role.trim() : undefined,
    };

    return {
      filter,
      sortBy: resolveSortField(
        query.sortBy,
        SORTABLE_FIELDS,
        DEFAULT_SORT_FIELD,
      ),
      sortOrder: query.sortOrder === SortOrder.ASC ? 'asc' : 'desc',
      skip: query.skip,
      take: query.take,
    };
  }

  private async getOrThrow(id: string): Promise<AdminWithRole> {
    const admin = await this.repository.findById(id);

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    return admin;
  }

  private assertNotSelf(
    id: string,
    currentAdmin: AuthenticatedAdmin,
    action: string,
  ): void {
    if (id === currentAdmin.id) {
      throw new UnprocessableEntityException(
        `You cannot ${action} your own account. Ask another administrator to do it.`,
      );
    }
  }

  /**
   * Refuses anything that would leave the platform with no active super admin.
   *
   * Only active holders are counted. An inactive super admin cannot sign in, so
   * deactivating the second-to-last one while an inactive one exists still
   * locks the system — the exact case this check exists for
   * (docs/phases/PHASE-3.md, task 3.6).
   */
  private async assertNotLastActiveSuperAdmin(
    admin: AdminWithRole,
    action: string,
  ): Promise<void> {
    if (admin.role.name !== SUPER_ADMIN_ROLE || !admin.isActive) {
      return;
    }

    const activeSuperAdmins =
      await this.repository.countActiveByRoleName(SUPER_ADMIN_ROLE);

    if (activeSuperAdmins <= 1) {
      throw new UnprocessableEntityException(
        `${action} ${admin.email} is not allowed: they are the last active ` +
          `${SUPER_ADMIN_ROLE}, and nobody would be left able to manage admins, ` +
          `roles or permissions. Promote another admin to ${SUPER_ADMIN_ROLE} first.`,
      );
    }
  }
}
