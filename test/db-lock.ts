import { Client } from 'pg';

/**
 * Arbitrary but fixed key. Any process using the same key contends for the
 * same lock; nothing else in this system takes advisory locks.
 */
const LOCK_KEY = 0x424a5300;

interface LockHolder {
  __bjspadesTestDbLock?: Client;
}

/**
 * Serialises integration runs against the shared test database.
 *
 * `setup.ts` truncates every volatile table before each test, so two jest
 * processes pointed at the same database delete each other's fixtures
 * mid-test. The failures look like real defects — rows vanishing between two
 * requests inside a single test, or a login returning a foreign-key error
 * because the Admin row disappeared — and they are maddening to diagnose.
 *
 * A session-level advisory lock makes the second run wait instead. Cheap,
 * requires no extra database, and removes the whole class of phantom failure.
 */
export async function acquireTestDbLock(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  // Blocks until the other run finishes and releases.
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

  // Held on globalThis because jest's globalSetup and globalTeardown run in
  // the same process but share no other state. The lock lives as long as this
  // connection does, so the client must stay open for the whole run.
  (globalThis as LockHolder).__bjspadesTestDbLock = client;
}

export async function releaseTestDbLock(): Promise<void> {
  const holder = globalThis as LockHolder;
  const client = holder.__bjspadesTestDbLock;

  if (!client) return;

  try {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  } finally {
    // Ending the connection releases the lock regardless, so a failed unlock
    // is not worth failing the run over.
    await client.end();
    delete holder.__bjspadesTestDbLock;
  }
}
