import { releaseTestDbLock } from './db-lock';

/** Releases the advisory lock so a queued integration run can proceed. */
export default async function globalTeardown(): Promise<void> {
  await releaseTestDbLock();
}
