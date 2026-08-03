// import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { seedPermissions } from './permissions.seed';
import { seedRolePermissions } from './role-permissions.seed';

import { seedRoles } from './roles.seed';
import { seedAdmin } from './admin.seed';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  console.log('🌱 Starting Database Seed...');

  await seedPermissions(prisma);
  await seedRoles(prisma);
  await seedRolePermissions(prisma);
  await seedAdmin(prisma);

  console.log('🎉 Database Seed Completed');
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
