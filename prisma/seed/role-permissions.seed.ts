import { PrismaClient } from '@prisma/client';
import { PERMISSION_CODES } from '../../src/common/constants/permissions';

const ROLE_PERMISSIONS = {
  SUPER_ADMIN: [
    PERMISSION_CODES.USERS_MANAGE,
    PERMISSION_CODES.TOURNAMENTS_MANAGE,
    PERMISSION_CODES.ROLES_MANAGE,
    PERMISSION_CODES.ACTIVITY_VIEW,
    PERMISSION_CODES.SECURITY_MANAGE,
    PERMISSION_CODES.SETTINGS_MANAGE,
  ],

  ADMIN: [
    PERMISSION_CODES.USERS_MANAGE,
    PERMISSION_CODES.TOURNAMENTS_MANAGE,
    PERMISSION_CODES.ACTIVITY_VIEW,
    PERMISSION_CODES.SETTINGS_MANAGE,
  ],

  MODERATOR: [
    PERMISSION_CODES.USERS_MANAGE,
    PERMISSION_CODES.TOURNAMENTS_MANAGE,
  ],

  SUPPORT: [PERMISSION_CODES.USERS_MANAGE, PERMISSION_CODES.ACTIVITY_VIEW],
} as const;

export async function seedRolePermissions(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Role Permissions...');

  for (const [roleName, permissionCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({
      where: {
        name: roleName,
      },
    });

    if (!role) continue;

    for (const code of permissionCodes) {
      const permission = await prisma.permission.findUnique({
        where: {
          code,
        },
      });

      if (!permission) continue;

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
        },
      });
    }

    console.log(`✅ ${roleName}`);
  }

  console.log('🎉 Role Permissions Seeded Successfully');
}
