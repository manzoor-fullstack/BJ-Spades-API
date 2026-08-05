import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';

import { SUPER_ADMIN_ROLE } from '../../../common/constants/roles';
import { PasswordService } from '../../../common/password/password.service';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import type { AuthenticatedAdmin } from '../../auth/interfaces/authenticated-admin.interface';
import { RolesService } from '../../roles/roles.service';
import type { RoleListItem } from '../../roles/serializers/role.serializer';
import { AdminsService } from '../admins.service';
import { CreateAdminDto } from '../dto/create-admin.dto';
import { QueryAdminsDto } from '../dto/query-admins.dto';
import { UpdateAdminDto } from '../dto/update-admin.dto';
import { AdminsRepository } from '../repositories/admins.repository';
import type { AdminWithRole } from '../serializers/admin.serializer';

type MockedRepository = { [K in keyof AdminsRepository]: jest.Mock };

const SUPER_ADMIN_ROLE_ID = 'role-super';
const ADMIN_ROLE_ID = 'role-admin';

const CURRENT_ADMIN: AuthenticatedAdmin = {
  id: 'admin-current',
  email: 'current@bjspades.com',
  role: SUPER_ADMIN_ROLE,
  roleId: SUPER_ADMIN_ROLE_ID,
  sessionId: 'session-1',
};

function makeRole(
  name: string,
  id: string,
  codes: string[] = [],
): AdminWithRole['role'] {
  return {
    id,
    name,
    displayName: name === SUPER_ADMIN_ROLE ? 'Super Administrator' : name,
    description: null,
    isSystem: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    permissions: codes.map((code) => ({
      roleId: id,
      permissionId: `permission-${code}`,
      permission: {
        id: `permission-${code}`,
        name: code,
        code,
        description: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    })),
  };
}

function makeAdmin(overrides: Partial<AdminWithRole> = {}): AdminWithRole {
  return {
    id: 'admin-1',
    firstName: 'Sarah',
    lastName: 'Johnson',
    email: 'sarah.johnson@bjspades.com',
    // Present on the row, and the assertions below prove it never leaves it.
    password: '$2b$12$hashedhashedhashedhashedhashedhashedhashedhashedhash',
    isActive: true,
    lastLogin: null,
    roleId: ADMIN_ROLE_ID,
    role: makeRole('ADMIN', ADMIN_ROLE_ID, ['users.manage']),
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeSuperAdmin(overrides: Partial<AdminWithRole> = {}): AdminWithRole {
  return makeAdmin({
    id: 'admin-super',
    firstName: 'Super',
    lastName: 'Admin',
    email: 'admin@bjspades.com',
    roleId: SUPER_ADMIN_ROLE_ID,
    role: makeRole(SUPER_ADMIN_ROLE, SUPER_ADMIN_ROLE_ID, ['admins.manage']),
    ...overrides,
  });
}

function roleItem(name: string, id: string): RoleListItem {
  return {
    id,
    name,
    displayName: name,
    description: null,
    isSystem: true,
    adminCount: 1,
    permissions: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function createDto(overrides: Partial<CreateAdminDto> = {}): CreateAdminDto {
  return plainToInstance(CreateAdminDto, {
    firstName: 'Sarah',
    lastName: 'Johnson',
    email: 'sarah.johnson@bjspades.com',
    password: 'Str0ngPassword!',
    roleId: ADMIN_ROLE_ID,
    ...overrides,
  });
}

/** Resolves with the rejection, so one promise can be asserted on twice. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function query(raw: Record<string, unknown> = {}): QueryAdminsDto {
  return plainToInstance(QueryAdminsDto, raw, {
    enableImplicitConversion: true,
  });
}

describe('AdminsService', () => {
  let repository: MockedRepository;
  let passwordService: { hash: jest.Mock; compare: jest.Mock };
  let rolesService: { findById: jest.Mock };
  let permissionsGuard: { invalidate: jest.Mock };
  let service: AdminsService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn(),
      count: jest.fn(),
      findById: jest.fn(),
      findByEmail: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      countActiveByRoleName: jest.fn(),
    };

    passwordService = {
      hash: jest.fn().mockResolvedValue('hashed-password'),
      compare: jest.fn(),
    };

    rolesService = {
      findById: jest.fn().mockResolvedValue(roleItem('ADMIN', ADMIN_ROLE_ID)),
    };

    permissionsGuard = { invalidate: jest.fn() };

    service = new AdminsService(
      repository as unknown as AdminsRepository,
      passwordService as unknown as PasswordService,
      rolesService as unknown as RolesService,
      permissionsGuard as unknown as PermissionsGuard,
    );
  });

  describe('create', () => {
    it('throws ConflictException when the email is taken', async () => {
      repository.findByEmail.mockResolvedValue(makeAdmin());

      await expect(service.create(createDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the roleId is unknown', async () => {
      repository.findByEmail.mockResolvedValue(null);
      rolesService.findById.mockRejectedValue(
        new NotFoundException('Role not found'),
      );

      await expect(
        service.create(createDto({ roleId: 'role-missing' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('stores a hash, never the submitted password', async () => {
      repository.findByEmail.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeAdmin());

      await service.create(createDto({ password: 'Str0ngPassword!' }));

      const [data] = repository.create.mock.calls[0] as [
        { password: string; email: string },
      ];

      expect(passwordService.hash).toHaveBeenCalledWith('Str0ngPassword!');
      expect(data.password).toBe('hashed-password');
      expect(data.password).not.toBe('Str0ngPassword!');
    });

    it('normalises the email before storing it', async () => {
      repository.findByEmail.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeAdmin());

      await service.create(createDto({ email: '  Sarah.J@BJSpades.com ' }));

      const [data] = repository.create.mock.calls[0] as [{ email: string }];

      expect(data.email).toBe('sarah.j@bjspades.com');
    });
  });

  describe('update', () => {
    it('hashes a submitted password rather than passing it through', async () => {
      repository.findById.mockResolvedValue(makeAdmin());
      repository.update.mockResolvedValue(makeAdmin());

      await service.update(
        'admin-1',
        plainToInstance(UpdateAdminDto, { password: 'NewPassw0rd!' }),
      );

      const [, data] = repository.update.mock.calls[0] as [
        string,
        { password?: string },
      ];

      expect(data.password).toBe('hashed-password');
    });

    it('throws ConflictException when moving to a taken email', async () => {
      repository.findById.mockResolvedValue(makeAdmin());
      repository.findByEmail.mockResolvedValue(makeAdmin({ id: 'admin-2' }));

      await expect(
        service.update(
          'admin-1',
          plainToInstance(UpdateAdminDto, { email: 'taken@bjspades.com' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException for an unknown admin', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.update('nobody', plainToInstance(UpdateAdminDto, {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('self-lockout guard rails', () => {
    it('refuses to delete your own account', async () => {
      repository.findById.mockResolvedValue(
        makeAdmin({ id: CURRENT_ADMIN.id }),
      );

      const error = await caught(
        service.remove(CURRENT_ADMIN.id, CURRENT_ADMIN),
      );

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      // The message has to say why, not just refuse.
      expect(messageOf(error)).toContain('your own account');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('refuses to deactivate your own account', async () => {
      repository.findById.mockResolvedValue(
        makeAdmin({ id: CURRENT_ADMIN.id }),
      );

      await expect(
        service.deactivate(CURRENT_ADMIN.id, CURRENT_ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('deletes another admin normally', async () => {
      const target = makeAdmin({ id: 'admin-other' });
      repository.findById.mockResolvedValue(target);
      repository.delete.mockResolvedValue(target);

      await expect(
        service.remove('admin-other', CURRENT_ADMIN),
      ).resolves.toEqual(expect.objectContaining({ id: 'admin-other' }));
      expect(repository.delete).toHaveBeenCalledWith('admin-other');
    });
  });

  describe('last active SUPER_ADMIN guard rails', () => {
    it('refuses to delete the last active super admin', async () => {
      repository.findById.mockResolvedValue(makeSuperAdmin());
      repository.countActiveByRoleName.mockResolvedValue(1);

      const error = await caught(service.remove('admin-super', CURRENT_ADMIN));

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(messageOf(error)).toContain('last active SUPER_ADMIN');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('refuses to deactivate the last active super admin', async () => {
      repository.findById.mockResolvedValue(makeSuperAdmin());
      repository.countActiveByRoleName.mockResolvedValue(1);

      await expect(
        service.deactivate('admin-super', CURRENT_ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('refuses to demote the last active super admin', async () => {
      repository.findById.mockResolvedValue(makeSuperAdmin());
      repository.countActiveByRoleName.mockResolvedValue(1);
      rolesService.findById.mockResolvedValue(roleItem('ADMIN', ADMIN_ROLE_ID));

      await expect(
        service.changeRole('admin-super', ADMIN_ROLE_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    /**
     * The trap the guard exists for: two super admins in the table, only one of
     * them active. Counting rows rather than active rows would let this through
     * and leave the platform with nobody able to sign in and administer it.
     */
    it('still refuses when an INACTIVE super admin exists', async () => {
      repository.findById.mockResolvedValue(makeSuperAdmin());
      // Two SUPER_ADMIN rows exist; countActiveByRoleName counts only the one
      // that is active — the admin being deleted.
      repository.countActiveByRoleName.mockResolvedValue(1);

      await expect(
        service.remove('admin-super', CURRENT_ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.countActiveByRoleName).toHaveBeenCalledWith(
        SUPER_ADMIN_ROLE,
      );
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('allows deleting a super admin while another active one remains', async () => {
      const target = makeSuperAdmin();
      repository.findById.mockResolvedValue(target);
      repository.countActiveByRoleName.mockResolvedValue(2);
      repository.delete.mockResolvedValue(target);

      await expect(
        service.remove('admin-super', CURRENT_ADMIN),
      ).resolves.toEqual(expect.objectContaining({ id: 'admin-super' }));
    });

    it('allows deleting an inactive super admin', async () => {
      const target = makeSuperAdmin({ isActive: false });
      repository.findById.mockResolvedValue(target);
      repository.delete.mockResolvedValue(target);

      await service.remove('admin-super', CURRENT_ADMIN);

      // Never even counted: an inactive super admin cannot sign in, so removing
      // it cannot be what locks the system.
      expect(repository.countActiveByRoleName).not.toHaveBeenCalled();
      expect(repository.delete).toHaveBeenCalled();
    });

    it('allows promoting someone else to SUPER_ADMIN', async () => {
      const target = makeAdmin();
      repository.findById.mockResolvedValue(target);
      rolesService.findById.mockResolvedValue(
        roleItem(SUPER_ADMIN_ROLE, SUPER_ADMIN_ROLE_ID),
      );
      repository.update.mockResolvedValue(
        makeAdmin({
          roleId: SUPER_ADMIN_ROLE_ID,
          role: makeRole(SUPER_ADMIN_ROLE, SUPER_ADMIN_ROLE_ID),
        }),
      );

      await service.changeRole('admin-1', SUPER_ADMIN_ROLE_ID);

      expect(repository.update).toHaveBeenCalledWith('admin-1', {
        roleId: SUPER_ADMIN_ROLE_ID,
      });
    });
  });

  describe('permission cache invalidation', () => {
    it('evicts the cache for the admin whose role changed', async () => {
      repository.findById.mockResolvedValue(makeAdmin());
      repository.update.mockResolvedValue(makeAdmin());

      await service.changeRole('admin-1', ADMIN_ROLE_ID);

      expect(permissionsGuard.invalidate).toHaveBeenCalledWith('admin-1');
    });

    it('evicts the cache for a deleted admin', async () => {
      const target = makeAdmin();
      repository.findById.mockResolvedValue(target);
      repository.delete.mockResolvedValue(target);

      await service.remove('admin-1', CURRENT_ADMIN);

      expect(permissionsGuard.invalidate).toHaveBeenCalledWith('admin-1');
    });
  });

  describe('password is never returned', () => {
    const hasPassword = (value: unknown): boolean =>
      JSON.stringify(value)?.includes('password') ?? false;

    it('is absent from create, findById, findAll, update and remove', async () => {
      const admin = makeAdmin();

      repository.findByEmail.mockResolvedValue(null);
      repository.create.mockResolvedValue(admin);
      repository.findById.mockResolvedValue(admin);
      repository.update.mockResolvedValue(admin);
      repository.delete.mockResolvedValue(admin);
      repository.findMany.mockResolvedValue([admin]);
      repository.count.mockResolvedValue(1);

      const results: unknown[] = [
        await service.create(createDto()),
        await service.findById('admin-1'),
        await service.findAll(query()),
        await service.update('admin-1', plainToInstance(UpdateAdminDto, {})),
        await service.activate('admin-1'),
        await service.deactivate('admin-1', CURRENT_ADMIN),
        await service.changeRole('admin-1', ADMIN_ROLE_ID),
        await service.remove('admin-1', CURRENT_ADMIN),
      ];

      for (const result of results) {
        expect(hasPassword(result)).toBe(false);
      }
    });
  });

  describe('findAll', () => {
    it('paginates, trims the search term and passes both role filters', async () => {
      repository.findMany.mockResolvedValue([makeAdmin()]);
      repository.count.mockResolvedValue(1);

      const result = await service.findAll(
        query({
          page: 2,
          limit: 10,
          search: '  sarah ',
          roleId: ADMIN_ROLE_ID,
          role: 'ADMIN',
          sortBy: 'email',
          sortOrder: 'asc',
        }),
      );

      expect(repository.findMany).toHaveBeenCalledWith({
        filter: { search: 'sarah', roleId: ADMIN_ROLE_ID, roleName: 'ADMIN' },
        sortBy: 'email',
        sortOrder: 'asc',
        skip: 10,
        take: 10,
      });
      expect(result.meta).toEqual({
        page: 2,
        limit: 10,
        total: 1,
        totalPages: 1,
      });
    });

    it('falls back to createdAt for an unknown sort column', async () => {
      repository.findMany.mockResolvedValue([]);
      repository.count.mockResolvedValue(0);

      await service.findAll(query({ sortBy: 'password' }));

      const [args] = repository.findMany.mock.calls[0] as [{ sortBy: string }];

      expect(args.sortBy).toBe('createdAt');
    });

    it('computes fullName, initials and the role summary', async () => {
      repository.findMany.mockResolvedValue([makeAdmin()]);
      repository.count.mockResolvedValue(1);

      const result = await service.findAll(query());

      expect(result.data[0]).toEqual(
        expect.objectContaining({
          fullName: 'Sarah Johnson',
          initials: 'SJ',
          role: {
            id: ADMIN_ROLE_ID,
            name: 'ADMIN',
            displayName: 'ADMIN',
          },
          permissions: ['users.manage'],
        }),
      );
    });
  });
});
