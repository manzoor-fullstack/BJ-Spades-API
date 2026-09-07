import type { PrismaClient } from '@prisma/client';

import { seedAdmin } from '../../../prisma/seed/admin.seed';

describe('seedAdmin', () => {
  const role = { id: 'role-1', name: 'SUPER_ADMIN' };
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => log.mockRestore());

  it('preserves credentials and role when the admin already exists', async () => {
    const create = jest.fn();
    const prisma = {
      role: { findUnique: jest.fn().mockResolvedValue(role) },
      admin: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'admin-1',
          email: 'admin@bjspades.com',
          password: 'production-password-hash',
          roleId: 'custom-role',
          isActive: false,
        }),
        create,
      },
    } as unknown as PrismaClient;

    await seedAdmin(prisma);

    expect(create).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('Admin123!'));
  });
});
