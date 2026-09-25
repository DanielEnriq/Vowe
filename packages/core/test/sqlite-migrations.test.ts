import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { databasePath, openDatabase } from '../src/store/sqlite/database.js';
import {
  LATEST_VERSION,
  MIGRATIONS,
  SchemaMigrationError,
  appliedVersions,
  migrate,
  type Migration,
} from '../src/store/sqlite/migrations.js';
import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import { testSession, TEST_SESSION } from './helpers.js';

const roots: string[] = [];
const stores: SqliteEventStore[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-migrate-'));
  roots.push(root);
  return root;
}

async function openStore(root: string): Promise<SqliteEventStore> {
  const store = new SqliteEventStore(root);
  await store.init();
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Apply only the migrations up to `version` — i.e. build an older Vowe. */
function buildDatabaseAt(root: string, version: number): void {
  const db = new DatabaseSync(databasePath(root));
  db.exec('PRAGMA journal_mode = WAL');
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version <= version),
  );
  seedInitialStore(db);
  // Closing checkpoints the write-ahead log. Without it the seeded rows sit in
  // the -wal and the "old database" is not actually on disk yet.
  db.close();
}

/** Rows written the way `001` shaped them, with no delivery table in sight. */
function seedInitialStore(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO projects (id, name, repo_root, git_common_dir, remote_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('project:repo', 'repo', '/repos/repo', null, null, '2026-02-11T09:00:00.000Z');

  const session = testSession();
  db.prepare(
    `INSERT INTO sessions (
       id, ord, provider, provider_session_id, attach_mode, task, display_label,
       cwd, project_id, worktree, branch, status, created_at, last_activity_at,
       capabilities_json, semantic_state_json)
     VALUES (?, 1, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL)`,
  ).run(
    session.id,
    session.provider,
    session.providerSessionId,
    session.attachMode,
    session.task,
    session.displayLabel,
    session.status,
    session.createdAt,
    session.lastActivityAt,
    JSON.stringify(session.capabilities),
  );

  db.prepare(
    `INSERT INTO conversation_entries (
       id, session_id, ord, at, role, text, refs_json, provenance_json,
       investigation_json)
     VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    'entry-from-v1',
    TEST_SESSION,
    '2026-02-11T09:00:00.000Z',
    'companion_answer',
    'an answer from before deliveries existed',
  );
}

describe('schema migrations', () => {
  it('brings an empty directory straight to the latest schema', async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);

    const db = new DatabaseSync(databasePath(root));
    expect(appliedVersions(db)).toEqual(
      MIGRATIONS.map((migration) => migration.version),
    );
    db.close();

    expect(store.listSessions()).toEqual([]);
    expect(store.listProjects()).toEqual([]);
  });

  it('migrates a database built at 001 forward, keeping what was already there', async () => {
    const root = await temporaryRoot();
    buildDatabaseAt(root, 1);

    // What an older Vowe left behind: no delivery table at all.
    const before = new DatabaseSync(databasePath(root));
    expect(appliedVersions(before)).toEqual([1]);
    expect(
      before
        .prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_deliveries'")
        .get(),
    ).toBeUndefined();
    before.close();

    // Opening it with this build is the upgrade.
    const store = await openStore(root);

    const after = new DatabaseSync(databasePath(root));
    expect(appliedVersions(after)).toEqual(
      MIGRATIONS.map((migration) => migration.version),
    );
    after.close();

    // The existing state came through untouched.
    expect(store.listProjects().map((p) => p.id)).toEqual(['project:repo']);
    expect(store.getSession(TEST_SESSION)!.task).toBe('Fix the reconnect regression');
    const [entry] = store.getConversation(TEST_SESSION);
    expect(entry!.text).toBe('an answer from before deliveries existed');
    expect('investigation' in entry!).toBe(false);

    // And the new capability works on top of the old row.
    await store.recordDelivery({
      id: randomUUID(),
      entryId: 'entry-from-v1',
      sessionId: TEST_SESSION,
      modality: 'voice',
      status: 'completed',
      startedAt: '2026-02-11T10:00:00.000Z',
    });
    expect(store.getDeliveries('entry-from-v1')).toHaveLength(1);

    // So does the one after it: a run recorded against a session that predates
    // the execution lane entirely.
    await store.appendRun({
      id: 'run-after-upgrade',
      sessionId: TEST_SESSION,
      kind: 'investigation',
      status: 'started',
      startedAt: '2026-02-11T10:05:00.000Z',
    });
    await store.appendTraceItems('run-after-upgrade', [
      {
        id: randomUUID(),
        kind: 'model_output',
        text: 'an answer',
        at: '2026-02-11T10:05:01.000Z',
      },
    ]);
    expect(store.getTraceItems('run-after-upgrade')).toHaveLength(1);

    // The row written before origins existed has none, rather than an empty
    // one — the same promise every other optional column makes.
    expect('origin' in entry!).toBe(false);
  });

  it('reads a semantic state written before the observer understood anything', async () => {
    const root = await temporaryRoot();
    buildDatabaseAt(root, 7);

    // A v7 Vowe: semantic states exist, understanding does not.
    const before = new DatabaseSync(databasePath(root));
    before
      .prepare(
        `INSERT INTO semantic_states (
           session_id, ord, task, phase, current_activity, recent_progress_json,
           last_meaningful_update, source, provenance_json, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        TEST_SESSION,
        'Fix the reconnect regression',
        'testing',
        'Running the test suite',
        JSON.stringify(['ran the suite']),
        '2026-02-11T09:05:00.000Z',
        'heuristic',
        JSON.stringify({ eventIds: [], throughSeq: 4 }),
        '2026-02-11T09:05:00.000Z',
      );
    before.close();

    const store = await openStore(root);
    const [state] = store.getSemanticHistory(TEST_SESSION);

    // The honest reading of a row that predates the field: nothing was
    // understood, and nothing durable was said. Not a throw, and not a guess.
    expect(state!.currentActivity).toBe('Running the test suite');
    expect(state!.currentUnderstanding).toBeNull();
    expect(state!.meaningfulUpdates).toEqual([]);

    // And the new capability writes on top of the old row.
    await store.appendSemanticState(TEST_SESSION, {
      ...state!,
      currentUnderstanding: 'The suite passes; liveness is unresolved.',
      meaningfulUpdates: [
        {
          id: 'note-1',
          text: 'The focused normalization tests pass.',
          at: '2026-02-11T09:06:00.000Z',
          refs: [{ kind: 'trace', sessionId: TEST_SESSION, startSeq: 1, endSeq: 4 }],
        },
      ],
    });

    const reloaded = store.getSession(TEST_SESSION)!.semanticState!;
    expect(reloaded.currentUnderstanding).toBe('The suite passes; liveness is unresolved.');
    expect(reloaded.meaningfulUpdates[0]!.refs).toHaveLength(1);
  });

  it('is a no-op the second time it runs', async () => {
    const root = await temporaryRoot();
    const first = await openStore(root);
    await first.upsertSession(testSession());
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = await openStore(root);
    expect(second.getSession(TEST_SESSION)).not.toBeNull();

    const db = new DatabaseSync(databasePath(root));
    expect(appliedVersions(db)).toHaveLength(MIGRATIONS.length);
    db.close();
  });

  it('leaves the database untouched when a migration fails, and names it', async () => {
    const root = await temporaryRoot();
    const broken: Migration = {
      version: LATEST_VERSION + 1,
      name: `${String(LATEST_VERSION + 1).padStart(3, '0')}_broken`,
      up: (db) => {
        db.exec('CREATE TABLE half_applied (id TEXT PRIMARY KEY) STRICT');
        db.exec('THIS IS NOT SQL');
      },
    };

    expect(() =>
      openDatabase(root, { migrations: [...MIGRATIONS, broken] }),
    ).toThrow(SchemaMigrationError);

    // The table the failed migration got halfway through creating is gone, and
    // the recorded version never moved — a half-migrated store is the one
    // outcome that would be dangerous to write to.
    const db = new DatabaseSync(databasePath(root));
    expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_applied'").get(),
    ).toBeUndefined();
    db.close();
  });

  it('reports which migration failed rather than just what SQLite said', async () => {
    const root = await temporaryRoot();
    const broken: Migration = {
      version: LATEST_VERSION + 1,
      name: 'oh_dear',
      up: () => {
        throw new Error('the disk caught fire');
      },
    };

    try {
      openDatabase(root, { migrations: [...MIGRATIONS, broken] });
      expect.unreachable('the migration should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaMigrationError);
      expect((error as SchemaMigrationError).migration).toBe('oh_dear');
      expect((error as Error).message).toContain('the disk caught fire');
      expect((error as Error).message).toContain('unchanged');
    }
  });
});

describe('a fresh start', () => {
  it('initializes correctly against a directory that has nothing in it', async () => {
    const root = await temporaryRoot();
    const store = await openStore(root);

    await store.upsertSession(testSession());
    expect(store.listSessions()).toHaveLength(1);
    expect(await readdir(root)).toContain('vowe.sqlite');
  });

  it('ignores a legacy NDJSON tree, and does not delete it', async () => {
    const root = await temporaryRoot();
    // Exactly what the previous implementation left on disk.
    await mkdir(path.join(root, 'sessions', 'claude-code_old'), { recursive: true });
    await writeFile(path.join(root, 'sessions.json'), '[{"id":"claude-code:old"}]');
    await writeFile(path.join(root, 'projects.json'), '[{"id":"project:old"}]');
    await writeFile(
      path.join(root, 'sessions', 'claude-code_old', 'conversation.ndjson'),
      '{"id":"old","text":"from the old world"}\n',
    );

    const store = await openStore(root);

    // A new store, not an importer: nothing from the old files is visible.
    expect(store.listSessions()).toEqual([]);
    expect(store.listProjects()).toEqual([]);
    expect(store.getConversation('claude-code:old')).toEqual([]);

    // And nothing was destroyed on the way. Startup does not delete data —
    // the reset helper is explicit and separate for exactly this reason.
    const entries = await readdir(root);
    expect(entries).toContain('sessions.json');
    expect(entries).toContain('projects.json');
    expect(entries).toContain('vowe.sqlite');
  });

  it('starts over when a developer explicitly asks it to', async () => {
    const root = await temporaryRoot();
    const first = await openStore(root);
    await first.upsertSession(testSession());
    await first.close();
    stores.splice(stores.indexOf(first), 1);

    const { resetDatabase } = await import('../src/store/sqlite/database.js');
    resetDatabase(root);

    const second = await openStore(root);
    expect(second.listSessions()).toEqual([]);
  });
});
