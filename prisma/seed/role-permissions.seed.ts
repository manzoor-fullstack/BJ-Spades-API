import { PrismaClient } from '@prisma/client';
import { PERMISSION_CODES } from '../../src/common/constants/permissions';

/** Role mapping from docs/02-DATA-MODEL.md, "Role mapping". */
const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  SUPER_ADMIN: Object.values(PERMISSION_CODES),

  // Everything except admins.manage, roles.manage and security.manage.
  ADMIN: [
    PERMISSION_CODES.DASHBOARD_VIEW,
    PERMISSION_CODES.USERS_MANAGE,
    PERMISSION_CODES.USERS_VIEW,
    PERMISSION_CODES.TOURNAMENTS_MANAGE,
    PERMISSION_CODES.REWARDS_MANAGE,
    PERMISSION_CODES.PAYOUTS_MANAGE,
    PERMISSION_CODES.PAYOUTS_VIEW,
    PERMISSION_CODES.ACTIVITY_VIEW,
    PERMISSION_CODES.SETTINGS_MANAGE,
    PERMISSION_CODES.SETTINGS_READ,
    PERMISSION_CODES.SECURITY_READ,
  ],

  MODERATOR: [
    PERMISSION_CODES.DASHBOARD_VIEW,
    PERMISSION_CODES.USERS_MANAGE,
    PERMISSION_CODES.TOURNAMENTS_MANAGE,
    PERMISSION_CODES.ACTIVITY_VIEW,
  ],

  // Support reads accounts, it does not delete them: users.view, not
  // users.manage.
  SUPPORT: [
    PERMISSION_CODES.DASHBOARD_VIEW,
    PERMISSION_CODES.USERS_VIEW,
    PERMISSION_CODES.PAYOUTS_VIEW,
    PERMISSION_CODES.ACTIVITY_VIEW,
    PERMISSION_CODES.SETTINGS_READ,
    PERMISSION_CODES.SECURITY_READ,
  ],
};

export async function seedRolePermissions(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Role Permissions...');

  for (const [roleName, permissionCodes] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.findUnique({
      where: {
        name: roleName,
      },
    });

    if (!role) continue;

    const permissions = await prisma.permission.findMany({
      where: { code: { in: [...permissionCodes] } },
      select: { id: true },
    });

    const permissionIds = permissions.map((permission) => permission.id);

    // Reconcile rather than only add. Re-seeding an existing database after a
    // mapping change must revoke what was removed — SUPPORT losing
    // `users.manage` is exactly that case.
    await prisma.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        permissionId: { notIn: permissionIds },
      },
    });

    for (const permissionId of permissionIds) {
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId,
        },
      });
    }

    console.log(`✅ ${roleName} (${permissionIds.length})`);
  }

  console.log('🎉 Role Permissions Seeded Successfully');
}
