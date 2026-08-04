import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config({ path: resolve(__dirname, '..', '.env.test'), override: true });

/**
 * Reference data seeded once by global-setup and preserved between tests.
 * Everything else is truncated so each test starts from a known state.
 */
const PRESERVED_TABLES = new Set([
  '_prisma_migrations',
  'Role',
  'Permission',
  'RolePermission',
  'Admin',
]);

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const testPrisma = new PrismaClient({ adapter });

async function truncateVolatileTables(): Promise<void> {
  const rows = await testPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const targets = rows
    .map((row) => row.tablename)
    .filter((name) => !PRESERVED_TABLES.has(name))
    .map((name) => `"public"."${name}"`);

  if (targets.length === 0) return;

  // One statement so foreign keys never block the wipe. RESTART IDENTITY keeps
  // sequences predictable across tests.
  await testPrisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`,
  );
}

beforeEach(async () => {
  await truncateVolatileTables();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});
