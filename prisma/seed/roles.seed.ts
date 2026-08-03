import { PrismaClient } from '@prisma/client';
import { ROLES } from '../../src/common/constants/roles';

export async function seedRoles(prisma: PrismaClient) {
  console.log('\n🌱 Seeding Roles...');

  for (const role of ROLES) {
    await prisma.role.upsert({
      where: {
        name: role.name,
      },
      update: {
        displayName: role.displayName,
        description: role.description,
        isSystem: role.isSystem,
      },
      create: {
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        isSystem: role.isSystem,
      },
    });

    console.log(`✅ ${role.name}`);
  }

  console.log('🎉 Roles Seeded Successfully\n');
}
