import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { PERMISSION_CODES } from '../../../common/constants/permissions';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesRepository } from '../repositories/roles.repository';
import { RolesService } from '../roles.service';
import type { RoleWithMeta } from '../serializers/role.serializer';

type MockedRepository = { [K in keyof RolesRepository]: jest.Mock };

const ROLE_ID = 'role-1';

function makeRole(overrides: Partial<RoleWithMeta> = {}): RoleWithMeta {
  return {
    id: ROLE_ID,
    name: 'ADMIN',
    displayName: 'Administrator',
    description: null,
    isSystem: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    permissions: [],
    _count: { admins: 0 },
    ...overrides,
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('RolesService', () => {
  let repository: MockedRepository;
  let permissionsGuard: { invalidate: jest.Mock };
  let service: RolesService;

  beforeEach(() => {
    repository = {
      findMany: jest.fn(),
      findById: jest.fn(),
      findByName: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findPermissionsByCodes: jest.fn(),
      findAdminIdsByRoleId: jest.fn().mockResolvedValue([]),
      replacePermissions: jest.fn().mockResolvedValue(undefined),
    };

    permissionsGuard = { invalidate: jest.fn() };

    service = new RolesService(
      repository as unknown as RolesRepository,
      permissionsGuard as unknown as PermissionsGuard,
    );
  });

  describe('create', () => {
    it('throws ConflictException for a duplicate name', async () => {
      repository.findByName.mockResolvedValue(makeRole());

      await expect(
        service.create({ name: 'ADMIN', displayName: 'Administrator' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException for an unknown role', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses to delete a system role, saying why', async () => {
      repository.findById.mockResolvedValue(makeRole({ isSystem: true }));

      const error = await caught(service.remove(ROLE_ID));

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(messageOf(error)).toContain('system role');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('refuses to delete a role still held by an admin, naming the count', async () => {
      repository.findById.mockResolvedValue(
        makeRole({ _count: { admins: 3 } }),
      );

      const error = await caught(service.remove(ROLE_ID));

      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(messageOf(error)).toContain('3 admins');
      expect(repository.delete).not.toHaveBeenCalled();
    });

    it('deletes an unheld custom role', async () => {
      const role = makeRole();
      repository.findById.mockResolvedValue(role);
      repository.delete.mockResolvedValue(role);

      await expect(service.remove(ROLE_ID)).resolves.toEqual(
        expect.objectContaining({ id: ROLE_ID, adminCount: 0 }),
      );
    });
  });

  describe('replacePermissions', () => {
    const codes = [
      PERMISSION_CODES.USERS_MANAGE,
      PERMISSION_CODES.ACTIVITY_VIEW,
    ];

    beforeEach(() => {
      repository.findById.mockResolvedValue(makeRole());
      repository.findPermissionsByCodes.mockResolvedValue([
        { id: 'permission-1', code: PERMISSION_CODES.USERS_MANAGE },
        { id: 'permission-2', code: PERMISSION_CODES.ACTIVITY_VIEW },
      ]);
    });

    it('rejects an unknown permission code with 400, naming it', async () => {
      repository.findPermissionsByCodes.mockResolvedValue([
        { id: 'permission-1', code: PERMISSION_CODES.USERS_MANAGE },
      ]);

      const error = await caught(
        service.replacePermissions(ROLE_ID, {
          permissionCodes: [PERMISSION_CODES.USERS_MANAGE, 'users.destroy'],
        }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(messageOf(error)).toContain('users.destroy');
      expect(repository.replacePermissions).not.toHaveBeenCalled();
    });

    it('replaces the whole set in a single repository call', async () => {
      await service.replacePermissions(ROLE_ID, { permissionCodes: codes });

      // One call, not a delete followed by an insert: the transaction boundary
      // lives inside the repository, so the service cannot half-apply a change.
      expect(repository.replacePermissions).toHaveBeenCalledTimes(1);
      expect(repository.replacePermissions).toHaveBeenCalledWith(ROLE_ID, [
        'permission-1',
        'permission-2',
      ]);
    });

    it('accepts an empty set, which revokes everything', async () => {
      repository.findPermissionsByCodes.mockResolvedValue([]);

      await service.replacePermissions(ROLE_ID, { permissionCodes: [] });

      expect(repository.replacePermissions).toHaveBeenCalledWith(ROLE_ID, []);
    });

    it('de-duplicates codes before resolving them', async () => {
      await service.replacePermissions(ROLE_ID, {
        permissionCodes: [
          PERMISSION_CODES.USERS_MANAGE,
          PERMISSION_CODES.USERS_MANAGE,
          PERMISSION_CODES.ACTIVITY_VIEW,
        ],
      });

      expect(repository.findPermissionsByCodes).toHaveBeenCalledWith(codes);
    });

    it('evicts the permission cache for every admin holding the role', async () => {
      repository.findAdminIdsByRoleId.mockResolvedValue([
        'admin-1',
        'admin-2',
        'admin-3',
      ]);

      await service.replacePermissions(ROLE_ID, { permissionCodes: codes });

      expect(permissionsGuard.invalidate).toHaveBeenCalledTimes(3);
      expect(permissionsGuard.invalidate).toHaveBeenCalledWith('admin-1');
      expect(permissionsGuard.invalidate).toHaveBeenCalledWith('admin-2');
      expect(permissionsGuard.invalidate).toHaveBeenCalledWith('admin-3');
    });

    it('throws NotFoundException for an unknown role before touching anything', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.replacePermissions('nope', { permissionCodes: codes }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.replacePermissions).not.toHaveBeenCalled();
    });
  });
});

/**
 * Atomicity is a property of the repository, not the service: proving it means
 * proving both writes run against the transaction client rather than the base
 * one, which is what makes a crash between them impossible to observe.
 */
describe('RolesRepository.replacePermissions', () => {
  it('runs the delete and the insert inside one transaction', async () => {
    const tx = {
      rolePermission: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const prisma = {
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
      rolePermission: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
    };

    const repository = new RolesRepository(prisma as unknown as PrismaService);

    await repository.replacePermissions(ROLE_ID, ['p1', 'p2']);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.rolePermission.deleteMany).toHaveBeenCalledWith({
      where: { roleId: ROLE_ID },
    });
    expect(tx.rolePermission.createMany).toHaveBeenCalledWith({
      data: [
        { roleId: ROLE_ID, permissionId: 'p1' },
        { roleId: ROLE_ID, permissionId: 'p2' },
      ],
    });
    // Nothing escaped the transaction onto the base client.
    expect(prisma.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(prisma.rolePermission.createMany).not.toHaveBeenCalled();
  });

  it('skips the insert when the new set is empty', async () => {
    const tx = {
      rolePermission: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };

    const repository = new RolesRepository(prisma as unknown as PrismaService);

    await repository.replacePermissions(ROLE_ID, []);

    expect(tx.rolePermission.deleteMany).toHaveBeenCalled();
    expect(tx.rolePermission.createMany).not.toHaveBeenCalled();
  });
});
