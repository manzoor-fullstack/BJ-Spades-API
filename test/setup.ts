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

/**
 * Volatile tables that a PRESERVED table holds a foreign key into.
 *
 * These cannot be part of the TRUNCATE batch. `TRUNCATE ... CASCADE` empties
 * every table referencing a truncated one — it cascades on the constraint
 * existing, not on its ON DELETE action — so truncating `MediaAsset` would
 * also empty `Admin`, which this file exists to preserve. `DELETE` does honour
 * `ON DELETE SET NULL`, so `Admin.avatarId` is nulled and the admin survives.
 */
const DELETE_INSTEAD_OF_TRUNCATE = new Set(['MediaAsset']);

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const testPrisma = new PrismaClient({ adapter });

async function truncateVolatileTables(): Promise<void> {
  const rows = await testPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const volatile = rows
    .map((row) => row.tablename)
    .filter((name) => !PRESERVED_TABLES.has(name));

  const targets = volatile
    .filter((name) => !DELETE_INSTEAD_OF_TRUNCATE.has(name))
    .map((name) => `"public"."${name}"`);

  if (targets.length > 0) {
    // One statement so foreign keys never block the wipe. RESTART IDENTITY
    // keeps sequences predictable across tests.
    await testPrisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`,
    );
  }

  // After the truncate: everything that referenced these rows from a volatile
  // table is already gone, so the only inbound references left are from
  // preserved tables, where ON DELETE SET NULL now does its job.
  for (const name of volatile.filter((entry) =>
    DELETE_INSTEAD_OF_TRUNCATE.has(entry),
  )) {
    await testPrisma.$executeRawUnsafe(`DELETE FROM "public"."${name}"`);
  }
}

beforeEach(async () => {
  await truncateVolatileTables();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});
