import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import * as dotenv from 'dotenv';

import { acquireTestDbLock } from './db-lock';

/**
 * Runs once before the whole integration suite.
 *
 * Takes an advisory lock on the test database, then applies migrations and
 * seeds reference data (roles, permissions, the super admin). Per-test
 * isolation is handled by truncation in setup.ts, not by re-running this.
 */
export default async function globalSetup(): Promise<void> {
  const envPath = resolve(__dirname, '..', '.env.test');

  if (!existsSync(envPath)) {
    throw new Error(
      '.env.test not found. It is committed to the repo — restore it before running integration tests.',
    );
  }

  dotenv.config({ path: envPath, override: true });

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL missing from .env.test');
  }

  // Refuse to run against anything that is not obviously the test database.
  // Wiping a development or production database because of a stray env var is
  // a mistake worth making structurally impossible.
  if (!databaseUrl.includes('bjspades_test')) {
    throw new Error(
      `Refusing to run integration tests: DATABASE_URL does not target bjspades_test.\n` +
        `Got: ${databaseUrl.replace(/:\/\/.*@/, '://***@')}`,
    );
  }

  // Before migrating: two concurrent runs must not migrate, seed, or truncate
  // against each other. Blocks until any other run releases.
  await acquireTestDbLock(databaseUrl);

  const env = { ...process.env, DATABASE_URL: databaseUrl };
  const cwd = resolve(__dirname, '..');

  try {
    execSync('npx prisma migrate deploy', { cwd, env, stdio: 'pipe' });
    execSync('npx prisma db seed', { cwd, env, stdio: 'pipe' });
  } catch (error) {
    const detail =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: Buffer }).stderr ?? error.message)
        : String(error);

    throw new Error(
      'Failed to prepare the test database. Is it running?\n' +
        '  pnpm run db:up\n\n' +
        detail,
    );
  }
}
