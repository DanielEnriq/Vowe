import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrate, type Migration } from './migrations.js';

/** The one database file, inside the existing Vowe store root. */
export function databasePath(root: string): string {
  return path.join(root, 'vowe.sqlite');
}

export interface OpenDatabaseOptions {
  /** Applied instead of the shipped list. Only a test has a reason to pass this. */
  migrations?: readonly Migration[];
}

/**
 * Open the application database, ready to use.
 *
 * Durability is deliberate and not negotiable without evidence: WAL for
 * concurrent readers, `synchronous = FULL` because `onConversationChanged`
 * promises in writing that an entry is durable before a listener hears about
 * it, and a busy timeout because the default is to fail instantly rather than
 * wait. A commit measures ~0.15 ms here, so there is nothing to buy by
 * weakening any of it.
 *
 * Pragmas come before `migrate()`: `foreign_keys` is a no-op inside a
 * transaction, and every migration runs in one.
 */
export function openDatabase(
  root: string,
  options: OpenDatabaseOptions = {},
): DatabaseSync {
  // DatabaseSync will not create the directory, and says so only by failing.
  mkdirSync(root, { recursive: true });

  const db = new DatabaseSync(databasePath(root), {
    enableForeignKeyConstraints: true,
    // Without this the default is 0 — an immediate SQLITE_BUSY the moment a
    // second handle exists, which is exactly what a reopen looks like.
    timeout: 5_000,
  });

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');

  migrate(db, options.migrations);
  return db;
}

/**
 * Delete the database and start over. **Explicitly, never on startup.**
 *
 * This exists because there is no production data to protect yet and a
 * developer needs one obvious way to get a clean store. It is deliberately not
 * wired into initialization: a store that can wipe itself as a side effect of
 * being opened is a store that eventually will.
 *
 * It removes the WAL and shared-memory sidecars too — deleting only the main
 * file leaves committed transactions behind in `-wal` to be recovered on the
 * next open, which looks exactly like the reset not having worked.
 */
export function resetDatabase(root: string): void {
  const file = databasePath(root);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${file}${suffix}`, { force: true });
  }
}
