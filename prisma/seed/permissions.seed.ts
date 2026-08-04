import { PrismaClient } from '@prisma/client';
import { PERMISSION_CODES } from '../../src/common/constants/permissions';

const PERMISSIONS = [
  {
    name: 'View Dashboard',
    code: PERMISSION_CODES.DASHBOARD_VIEW,
    description: 'View the dashboard and platform statistics',
  },
  {
    name: 'Manage Users',
    code: PERMISSION_CODES.USERS_MANAGE,
    description: 'Create, edit, suspend and delete users, and adjust balances',
  },
  {
    name: 'View Users',
    code: PERMISSION_CODES.USERS_VIEW,
    description: 'Read-only access to user accounts',
  },
  {
    name: 'Manage Tournaments',
    code: PERMISSION_CODES.TOURNAMENTS_MANAGE,
    description: 'Create and manage tournaments and registrations',
  },
  {
    name: 'Manage Rewards',
    code: PERMISSION_CODES.REWARDS_MANAGE,
    description: 'Create and manage rewards and merchandise',
  },
  {
    name: 'Manage Payouts',
    code: PERMISSION_CODES.PAYOUTS_MANAGE,
    description: 'Approve and process payouts',
  },
  {
    name: 'View Payouts',
    code: PERMISSION_CODES.PAYOUTS_VIEW,
    description: 'Read-only access to payouts',
  },
  {
    name: 'Manage Admins',
    code: PERMISSION_CODES.ADMINS_MANAGE,
    description: 'Create and edit administrator accounts',
  },
  {
    name: 'Manage Roles',
    code: PERMISSION_CODES.ROLES_MANAGE,
    description: 'Create and manage roles and permission assignment',
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
