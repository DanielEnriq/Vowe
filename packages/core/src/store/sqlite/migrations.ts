import type { DatabaseSync } from 'node:sqlite';

/**
 * Vowe's schema, as an ordered list of migrations.
 *
 * Two rules make this safe to extend:
 *
 *  1. **A shipped migration is frozen.** Its SQL is a literal string and is
 *     never edited afterwards, never regenerated from the current types. The
 *     moment `001` is derived from today's model it stops describing the
 *     database an older Vowe actually wrote, and migrating forward from it
 *     stops being testable.
 *  2. **Versions are contiguous and applied in order**, each inside its own
 *     transaction together with the row recording it. A migration that throws
 *     leaves the database exactly where it was.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

/**
 * The canonical store: everything the application persisted before conversation
 * delivery existed.
 *
 * `STRICT` throughout, so a column typed `INTEGER` cannot quietly accept the
 * string `'3'`. Nullable columns carry a comment saying which of the two things
 * NULL means for them — see `rows.ts`, where that distinction is enforced.
 */
const INITIAL_STORE = `
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  repo_root      TEXT NOT NULL,
  git_common_dir TEXT,                  -- NULL => key ABSENT
  remote_url     TEXT,                  -- NULL => key ABSENT
  created_at     TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,
  ord                 INTEGER NOT NULL, -- first-seen order; listSessions() is insertion-ordered
  provider            TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  attach_mode         TEXT NOT NULL,
  task                TEXT,             -- NULL => null (key PRESENT)
  display_label       TEXT NOT NULL,
  cwd                 TEXT,             -- NULL => null (key PRESENT)
  project_id          TEXT,             -- NULL => null (key PRESENT). No FK: see below.
  worktree            TEXT,             -- NULL => key ABSENT
  branch              TEXT,             -- NULL => key ABSENT
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  last_activity_at    TEXT NOT NULL,
  capabilities_json   TEXT NOT NULL,
  semantic_state_json TEXT              -- NULL => null (key PRESENT)
) STRICT;

CREATE TABLE events (
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  id              TEXT NOT NULL,
  at              TEXT NOT NULL,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  detail_json     TEXT,                 -- NULL => key ABSENT
  raw_json        TEXT,                 -- NULL => the provider record was undefined
  raw_source      TEXT NOT NULL,
  raw_byte_offset INTEGER NOT NULL,
  raw_line        INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE TABLE semantic_states (
  session_id             TEXT NOT NULL,
  ord                    INTEGER NOT NULL,
  task                   TEXT,          -- NULL => null (key PRESENT)
  phase                  TEXT NOT NULL,
  current_activity       TEXT NOT NULL,
  recent_progress_json   TEXT NOT NULL,
  last_meaningful_update TEXT NOT NULL,
  source                 TEXT NOT NULL,
  provenance_json        TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (session_id, ord)
) STRICT;

CREATE TABLE conversation_entries (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  ord                INTEGER NOT NULL, -- insertion order; two entries share a timestamp routinely
  at                 TEXT NOT NULL,
  role               TEXT NOT NULL,
  text               TEXT NOT NULL,    -- the COMPLETE semantic turn, never the audible prefix
  refs_json          TEXT,             -- NULL => key ABSENT
  provenance_json    TEXT,             -- NULL => key ABSENT
  investigation_json TEXT              -- NULL => key ABSENT
) STRICT;

CREATE TABLE windows (
  session_id    TEXT NOT NULL,
  idx           INTEGER NOT NULL,      -- domain \`index\`; INDEX is reserved
  id            TEXT NOT NULL,
  start_seq     INTEGER NOT NULL,
  end_seq       INTEGER NOT NULL,
  event_count   INTEGER NOT NULL,
  approx_tokens INTEGER NOT NULL,
  source        TEXT,                  -- NULL => null (key PRESENT)
  start_offset  INTEGER,               -- NULL => null (key PRESENT)
  end_offset    INTEGER,               -- NULL => null (key PRESENT)
  started_at    TEXT NOT NULL,
  ended_at      TEXT NOT NULL,
  closed_by     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, idx)
) STRICT;

CREATE TABLE window_notes (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  ord              INTEGER NOT NULL,   -- deterministic chronology; the id is a UUID, not an order
  window_id        TEXT NOT NULL,
  window_index     INTEGER NOT NULL,
  summary          TEXT NOT NULL,
  current_activity TEXT,               -- NULL => key ABSENT
  notable_change   TEXT,               -- NULL => key ABSENT
  refs_json        TEXT NOT NULL,
  investigated     INTEGER NOT NULL,   -- 0/1; booleans are not bindable
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE surface_updates (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  ord           INTEGER NOT NULL,      -- tiebreak for equal created_at, preserving insertion order
  window_id     TEXT,                  -- NULL => null (key PRESENT)
  message       TEXT NOT NULL,
  why_now       TEXT NOT NULL,
  refs_json     TEXT NOT NULL,
  urgency       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  decision_json TEXT,                  -- NULL => key ABSENT
  decided_at    TEXT,                  -- NULL => key ABSENT
  delivered_at  TEXT                   -- NULL => key ABSENT
) STRICT;

CREATE TABLE observation_state (
  session_id               TEXT PRIMARY KEY,
  last_closed_window_index INTEGER NOT NULL,
  last_processed_window_id TEXT,       -- NULL => null (key PRESENT)
  processed_through_seq    INTEGER NOT NULL,
  communication_preference TEXT,       -- NULL => null (key PRESENT)
  updated_at               TEXT NOT NULL
) STRICT;

-- appendEvent idempotency, enforced by the database rather than by a Set held
-- in memory. The key matches the old one exactly: source + byte offset, per
-- session, with the line number deliberately excluded.
CREATE UNIQUE INDEX events_raw_ref ON events (session_id, raw_source, raw_byte_offset);

-- getEventsByIds — context-navigator.ts, artifact-resolver.ts. Always a single
-- id, session-scoped so a ref cannot resolve across sessions.
CREATE UNIQUE INDEX events_id ON events (session_id, id);

-- getConversation, including its "last N" form.
CREATE UNIQUE INDEX conversation_entries_session_ord
  ON conversation_entries (session_id, ord);

-- getWindow(sessionId, windowId) — a point lookup.
CREATE UNIQUE INDEX windows_id ON windows (session_id, id);

-- getWindowNotes ordering, and getWindowNoteForWindow as a point lookup.
CREATE UNIQUE INDEX window_notes_session_ord ON window_notes (session_id, ord);
CREATE UNIQUE INDEX window_notes_window ON window_notes (session_id, window_id);

-- getSurfaceUpdates sorts by createdAt, with ord reproducing the stable
-- insertion order the in-memory Map used to give on ties.
CREATE INDEX surface_updates_session ON surface_updates (session_id, created_at, ord);
`;

/**
 * What happened while a conversation entry was communicated.
 *
 * Separate from `001` because it is genuinely new, and because a migration from
 * the canonical store to this one is the thing worth being able to test.
 */
const CONVERSATION_DELIVERY = `
CREATE TABLE conversation_deliveries (
  id                      TEXT PRIMARY KEY,
  entry_id                TEXT NOT NULL REFERENCES conversation_entries(id) ON DELETE CASCADE,
  session_id              TEXT NOT NULL,
  ord                     INTEGER NOT NULL,
  modality                TEXT NOT NULL,  -- 'text' | 'voice'
  status                  TEXT NOT NULL,  -- 'started' | 'completed' | 'interrupted' | 'cancelled'
  delivered_text          TEXT,           -- NULL => key ABSENT; the whole entry was delivered
  audio_end_ms            INTEGER,        -- NULL => key ABSENT
  interrupted_by_entry_id TEXT,           -- NULL => key ABSENT
  started_at              TEXT NOT NULL,
  completed_at            TEXT            -- NULL => key ABSENT; still in flight
) STRICT;

CREATE INDEX conversation_deliveries_entry ON conversation_deliveries (entry_id, ord);
CREATE UNIQUE INDEX conversation_deliveries_session_ord
  ON conversation_deliveries (session_id, ord);
`;

/**
 * What Vowe itself did, and where a turn came from.
 *
 * Two changes that belong together because they are the same slice of truth:
 * conversation gains a provider identity so a redelivered turn cannot be stored
 * twice, and Vowe's own executions gain a lane of their own rather than being
 * squeezed into worker events or into the conversation they produced.
 *
 * The origin index is partial. Most entries are Vowe's own and have no origin
 * at all; a unique index over three NULLs would be either useless or wrong,
 * depending on the dialect, so it only covers rows that actually carry one.
 */
const VOWE_EXECUTION_HISTORY = `
ALTER TABLE conversation_entries ADD COLUMN origin_provider TEXT;  -- NULL => Vowe wrote it
ALTER TABLE conversation_entries ADD COLUMN origin_kind     TEXT;  -- NULL => Vowe wrote it
ALTER TABLE conversation_entries ADD COLUMN origin_id       TEXT;  -- NULL => Vowe wrote it

-- Exactly-once for anything a provider delivers. A retry, a reconnect or a
-- replayed stream carries the same origin id and conflicts here, which is what
-- makes duplicate delivery a no-op rather than a second copy of the turn.
CREATE UNIQUE INDEX conversation_entries_origin
  ON conversation_entries (session_id, origin_provider, origin_kind, origin_id)
  WHERE origin_provider IS NOT NULL;

CREATE TABLE vowe_runs (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,                -- NULL => key ABSENT; not every run has one
  project_id       TEXT,                -- NULL => key ABSENT
  kind             TEXT NOT NULL,
  provider         TEXT,                -- NULL => key ABSENT
  model            TEXT,                -- NULL => key ABSENT
  status           TEXT NOT NULL,       -- 'started' | 'completed' | 'cancelled' | 'error'
  trigger_entry_id TEXT,                -- NULL => key ABSENT
  output_entry_id  TEXT,                -- NULL => key ABSENT
  started_at       TEXT NOT NULL,
  completed_at     TEXT,                -- NULL => key ABSENT; still in flight
  usage_json       TEXT,                -- NULL => key ABSENT; the provider reported none
  metadata_json    TEXT                 -- NULL => key ABSENT
) STRICT;

-- run_id + ord is the execution order. The id is a UUID, not a position, and
-- timestamps tie routinely inside one fast loop.
CREATE TABLE vowe_trace_items (
  run_id           TEXT NOT NULL REFERENCES vowe_runs(id) ON DELETE CASCADE,
  ord              INTEGER NOT NULL,
  id               TEXT NOT NULL,
  kind             TEXT NOT NULL,
  text             TEXT,                -- NULL => key ABSENT
  payload_json     TEXT,                -- NULL => key ABSENT
  provider_item_id TEXT,                -- NULL => key ABSENT
  at               TEXT NOT NULL,
  PRIMARY KEY (run_id, ord)
) STRICT;

-- getRuns(sessionId), newest last.
CREATE INDEX vowe_runs_session ON vowe_runs (session_id, started_at);
-- "which execution produced this answer?"
CREATE INDEX vowe_runs_output_entry ON vowe_runs (output_entry_id);
`;

/**
 * A conversation that belongs to a project rather than to a session.
 *
 * A separate table, deliberately, rather than making `session_id` nullable on
 * `conversation_entries`. Three reasons, in order of weight:
 *
 *  1. Existing session history is left exactly where it is. Widening the
 *     session table would mean rebuilding it — it is referenced by
 *     `conversation_deliveries` — to gain nullability that every session row
 *     would then have to be trusted not to use.
 *  2. The two really are different things. A session conversation is about one
 *     worker's run and can be interrupted mid-sentence by voice; a project
 *     conversation is about a repository, is typed, and has no delivery.
 *  3. Nothing here can be mistaken for the other by a query that forgot to
 *     filter.
 *
 * No deliveries table and no delivery column: project answers are read, not
 * spoken, because project-level voice does not exist. When it does, it brings
 * its own migration rather than having been guessed at here.
 */
const PROJECT_CONVERSATION = `
CREATE TABLE project_conversation_entries (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  ord                INTEGER NOT NULL, -- insertion order; two entries share a timestamp routinely
  at                 TEXT NOT NULL,
  role               TEXT NOT NULL,
  text               TEXT NOT NULL,
  refs_json          TEXT,             -- NULL => key ABSENT
  provenance_json    TEXT,             -- NULL => key ABSENT
  investigation_json TEXT,             -- NULL => key ABSENT
  origin_provider    TEXT,             -- NULL => Vowe wrote it
  origin_kind        TEXT,             -- NULL => Vowe wrote it
  origin_id          TEXT              -- NULL => Vowe wrote it
) STRICT;

-- getProjectConversation, including its "last N" form.
CREATE UNIQUE INDEX project_conversation_entries_project_ord
  ON project_conversation_entries (project_id, ord);

-- The same exactly-once guarantee the session table has, for the same reason.
CREATE UNIQUE INDEX project_conversation_entries_origin
  ON project_conversation_entries (project_id, origin_provider, origin_kind, origin_id)
  WHERE origin_provider IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial_store',
    up: (db) => db.exec(INITIAL_STORE),
  },
  {
    version: 2,
    name: '002_conversation_delivery',
    up: (db) => db.exec(CONVERSATION_DELIVERY),
  },
  {
    version: 3,
    name: '003_vowe_execution_history',
    up: (db) => db.exec(VOWE_EXECUTION_HISTORY),
  },
  {
    version: 4,
    name: '004_project_conversation',
    up: (db) => db.exec(PROJECT_CONVERSATION),
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

export class SchemaMigrationError extends Error {
  readonly version: number;
  readonly migration: string;

  constructor(migration: Migration, cause: unknown) {
    super(
      `vowe: migration ${migration.name} (v${migration.version}) failed, ` +
        `the store is unchanged — ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'SchemaMigrationError';
    this.version = migration.version;
    this.migration = migration.name;
  }
}

/** Which migrations this database has already had applied. */
export function appliedVersions(db: DatabaseSync): number[] {
  db.exec(MIGRATIONS_TABLE);
  return db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => Number((row as { version: number }).version));
}

/**
 * Bring a database up to `LATEST_VERSION`.
 *
 * Each pending migration runs inside its own transaction together with the row
 * that records it, so the schema and the recorded version can never disagree —
 * and a failure leaves both untouched rather than half-applied. Failure throws:
 * writing to a database on an unknown schema is worse than not starting.
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const applied = new Set(appliedVersions(db));
  const pending = [...migrations]
    .filter((migration) => !applied.has(migration.version))
    .sort((a, b) => a.version - b.version);

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw new SchemaMigrationError(migration, cause);
    }
  }
}
