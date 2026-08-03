import { PrismaClient } from '@prisma/client';
import { PERMISSION_CODES } from '../../src/common/constants/permissions';

const PERMISSIONS = [
  {
    name: 'Manage Users',
    code: PERMISSION_CODES.USERS_MANAGE,
    description: 'Create, edit, suspend and delete users',
  },
  {
    name: 'Manage Tournaments',
    code: PERMISSION_CODES.TOURNAMENTS_MANAGE,
    description: 'Create and manage tournaments',
  },
  {
    name: 'Manage Roles',
    code: PERMISSION_CODES.ROLES_MANAGE,
    description: 'Create and manage roles',
  },
  {
    name: 'View Activity',
    code: PERMISSION_CODES.ACTIVITY_VIEW,
    description: 'View activity logs',
  },
  {
    name: 'Manage Security',
    code: PERMISSION_CODES.SECURITY_MANAGE,
    description: 'Manage active sessions and security settings',
  },
  {
    name: 'Manage Settings',
    code: PERMISSION_CODES.SETTINGS_MANAGE,
    description: 'Manage application settings',
  },
] as const;

export async function seedPermissions(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Permissions...');

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: {
        code: permission.code,
      },
      update: {
        name: permission.name,
        description: permission.description,
      },
      create: {
        name: permission.name,
        code: permission.code,
        description: permission.description,
      },
    });

    console.log(`✅ ${permission.code}`);
  }

  console.log('🎉 Permissions Seeded Successfully\n');
}
