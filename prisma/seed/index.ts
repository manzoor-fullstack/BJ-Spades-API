// import 'dotenv/config';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { seedPermissions } from './permissions.seed';
import { seedRolePermissions } from './role-permissions.seed';

import { seedRoles } from './roles.seed';
import { seedAdmin } from './admin.seed';
import { seedUsers } from './users.seed';

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
  // Must run after seedAdmin: admin-created users reference its id.
  await seedUsers(prisma);

  console.log('🎉 Database Seed Completed');
}

main()
  .catch((error) => {
    // Exiting non-zero matters: the integration harness runs this via
    // execSync and would otherwise treat a failed seed as success.
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
