import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import type { AdapterEvent, NormalizedEvent } from '../types/events.js';
import type { AgentSession, SemanticState } from '../types/session.js';
import type {
  ConversationDelivery,
  ConversationEntry,
  ProjectConversationEntry,
  DeliveryProgress,
} from '../types/conversation.js';
import type {
  CommunicationDecision,
  ObservationState,
  SurfaceUpdate,
  TraceWindow,
  WindowNote,
} from '../observation/trace-window.js';
import type {
  RunCompletion,
  VoweRun,
  VoweTraceItem,
} from '../types/execution.js';
import type { Project } from '../projects/project.js';
import type {
  ConversationChange,
  EventQuery,
  ProjectConversationChange,
  EventStore,
  WindowQuery,
} from './event-store.js';
import { openDatabase } from './sqlite/database.js';
import type { Migration } from './sqlite/migrations.js';
import * as rows from './sqlite/rows.js';

export interface SqliteEventStoreOptions {
  /**
   * Where a listener's failure goes. The store's own writes never depend on a
   * listener, but a subscriber that throws should not vanish either.
   */
  onError?: (scope: string, error: unknown) => void;
  /** Applied instead of the shipped list. Only a test has a reason to pass this. */
  migrations?: readonly Migration[];
}

/**
 * Vowe's local database.
 *
 * SQLite is the canonical source of truth for everything Vowe owns and
 * remembers. There is no second backend and no fallback: one file under the
 * store root, opened in WAL mode, migrated forward on startup.
 *
 * **Reads are real queries, not a cache.** `node:sqlite` is synchronous, which
 * is what lets the `EventStore` contract stay exactly as it was — synchronous
 * reads, async writes — without keeping whole sessions in memory the way the
 * NDJSON implementation had to. Nothing here mirrors a stream into an array.
 *
 * **Writes are synchronous under the hood.** The methods are `async` because
 * the interface says so and because a future implementation may genuinely need
 * to be, but nothing here awaits. That is worth knowing, because it is why the
 * conversation notification is exactly as ordered as it claims to be: `COMMIT`
 * has returned before a listener runs, in the same tick.
 *
 * Vowe is a single writer in the Electron main process. The schema leans on
 * that — `seq` is assigned inside the insert rather than by a counter — and the
 * renderer reaches this only through typed IPC.
 */
export class SqliteEventStore implements EventStore {
  private readonly root: string;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly migrations: readonly Migration[] | undefined;
  private readonly conversationListeners = new Set<
    (change: ConversationChange) => void
  >();
  private readonly projectConversationListeners = new Set<
    (change: ProjectConversationChange) => void
  >();
  private readonly cache = new Map<string, StatementSync>();
  private db: DatabaseSync | null = null;

  constructor(root: string, options: SqliteEventStoreOptions = {}) {
    this.root = root;
    this.onError = options.onError ?? (() => undefined);
    this.migrations = options.migrations;
  }

  async init(): Promise<void> {
    if (this.db) return;
    this.db = openDatabase(this.root, {
      ...(this.migrations ? { migrations: this.migrations } : {}),
    });
  }

  /**
   * Release the file.
   *
   * Not optional housekeeping: an open handle keeps the WAL and shared-memory
   * sidecars alive, so a caller that deletes the directory — or opens a second
   * store over the same file — needs this to have happened first.
   */
  async close(): Promise<void> {
    if (!this.db) return;
    this.cache.clear();
    this.db.close();
    this.db = null;
  }

  // ---------------------------------------------------------------- projects

  async upsertProject(project: Project): Promise<void> {
    // `createdAt` is when Vowe first saw the repository, so the original wins —
    // expressed here as COALESCE over the existing row rather than a read
    // followed by a write.
    this.run(
      `INSERT INTO projects (id, name, repo_root, git_common_dir, remote_url, created_at)
       VALUES (:id, :name, :repoRoot, :gitCommonDir, :remoteUrl, :createdAt)
       ON CONFLICT (id) DO UPDATE SET
         name           = excluded.name,
         repo_root      = excluded.repo_root,
         git_common_dir = excluded.git_common_dir,
         remote_url     = excluded.remote_url,
         created_at     = COALESCE(projects.created_at, excluded.created_at)`,
      {
        id: project.id,
        name: project.name,
        repoRoot: project.repoRoot,
        gitCommonDir: rows.text(project.gitCommonDir),
        remoteUrl: rows.text(project.remoteUrl),
        createdAt: project.createdAt,
      },
    );
  }

  listProjects(): Project[] {
    return this.all('SELECT * FROM projects ORDER BY rowid').map(rows.toProject);
  }

  getProject(projectId: string): Project | null {
    const row = this.get('SELECT * FROM projects WHERE id = ?', projectId);
    return row ? rows.toProject(row) : null;
  }

  /**
   * `<root>/projects/<safeId>/`.
   *
   * Still a directory, and deliberately so. What lives there is a code graph,
   * an index state file and Vowe's own project memory — material an external
   * tool writes and reads, which has no business in this database. The store
   * hands out the path and stops there.
   */
  projectDataDir(projectId: string): string {
    return path.join(this.root, 'projects', safeName(projectId));
  }

  // ---------------------------------------------------------------- sessions

  async upsertSession(session: AgentSession): Promise<void> {
    this.run(
      `INSERT INTO sessions (
         id, ord, provider, provider_session_id, attach_mode, task, display_label,
         cwd, project_id, worktree, branch, status, created_at, last_activity_at,
         capabilities_json, semantic_state_json)
       SELECT :id,
              COALESCE((SELECT ord FROM sessions WHERE id = :id),
                       (SELECT COALESCE(MAX(ord), 0) + 1 FROM sessions)),
              :provider, :providerSessionId, :attachMode, :task, :displayLabel,
              :cwd, :projectId, :worktree, :branch, :status, :createdAt,
              :lastActivityAt, :capabilities, :semanticState
       WHERE true
       ON CONFLICT (id) DO UPDATE SET
         provider            = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         attach_mode         = excluded.attach_mode,
         task                = excluded.task,
         display_label       = excluded.display_label,
         cwd                 = excluded.cwd,
         project_id          = excluded.project_id,
         worktree            = excluded.worktree,
         branch              = excluded.branch,
         status              = excluded.status,
         created_at          = excluded.created_at,
         last_activity_at    = excluded.last_activity_at,
         capabilities_json   = excluded.capabilities_json,
         semantic_state_json = excluded.semantic_state_json`,
      {
        id: session.id,
        provider: session.provider,
        providerSessionId: session.providerSessionId,
        attachMode: session.attachMode,
        task: rows.text(session.task),
        displayLabel: session.displayLabel,
        cwd: rows.text(session.cwd),
        projectId: rows.text(session.projectId),
        worktree: rows.text(session.worktree),
        branch: rows.text(session.branch),
        status: session.status,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        capabilities: JSON.stringify(session.capabilities),
        semanticState: rows.json(session.semanticState),
      },
    );
  }

  listSessions(): AgentSession[] {
    return this.all('SELECT * FROM sessions ORDER BY ord').map(rows.toSession);
  }

  getSession(sessionId: string): AgentSession | null {
    const row = this.get('SELECT * FROM sessions WHERE id = ?', sessionId);
    return row ? rows.toSession(row) : null;
  }

  // ------------------------------------------------------------------ events

  /**
   * Assign identity and ordering, then persist — in one statement.
   *
   * `MAX(seq) + 1` is evaluated inside the insert, under SQLite's write lock,
   * so no in-memory counter can drift from the file and there is no
   * read-then-write race. The unique index on the raw reference is what makes
   * this idempotent: a record already stored conflicts, `DO NOTHING` consumes
   * no sequence number, and `RETURNING` yields nothing — which is exactly the
   * `null` this method promises, and what makes restart-and-replay safe.
   */
  async appendEvent(
    sessionId: string,
    event: AdapterEvent,
  ): Promise<NormalizedEvent | null> {
    const id = randomUUID();
    const row = this.get(
      `INSERT INTO events (
         session_id, seq, id, at, kind, summary, detail_json, raw_json,
         raw_source, raw_byte_offset, raw_line)
       SELECT :sessionId,
              COALESCE((SELECT MAX(seq) FROM events WHERE session_id = :sessionId), 0) + 1,
              :id, :at, :kind, :summary, :detail, :raw, :source, :byteOffset, :line
       -- Required: SQLite cannot parse ON CONFLICT after a bare SELECT.
       WHERE true
       ON CONFLICT (session_id, raw_source, raw_byte_offset) DO NOTHING
       RETURNING seq`,
      {
        sessionId,
        id,
        at: event.at,
        kind: event.kind,
        summary: event.summary,
        detail: rows.json(event.detail),
        raw: rows.json(event.raw),
        source: event.rawRef.source,
        byteOffset: event.rawRef.byteOffset,
        line: event.rawRef.line,
      },
    );
    if (!row) return null;

    return { ...event, id, sessionId, seq: Number(row['seq']) };
  }

  getEvents(sessionId: string, query: EventQuery = {}): NormalizedEvent[] {
    // `limit` means the last N, so the query takes them from the end and the
    // result is flipped back into ascending order.
    return this.tail(
      `SELECT * FROM events
        WHERE session_id = :sessionId
          AND (:sinceSeq IS NULL OR seq > :sinceSeq)`,
      'seq',
      { sessionId, sinceSeq: rows.num(query.sinceSeq) },
      query.limit,
    ).map(rows.toEvent);
  }

  getEventsByIds(sessionId: string, ids: string[]): NormalizedEvent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.all(
      `SELECT * FROM events
        WHERE session_id = ? AND id IN (${placeholders})
        ORDER BY seq`,
      sessionId,
      ...ids,
    ).map(rows.toEvent);
  }

  lastSeq(sessionId: string): number {
    const row = this.get(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = ?',
      sessionId,
    );
    return row ? Number(row['seq']) : 0;
  }

  // ---------------------------------------------------------------- semantic

  async appendSemanticState(
    sessionId: string,
    state: SemanticState,
  ): Promise<void> {
    // Two writes: the history row, and the session's current state. They are
    // one fact and commit together.
    this.transaction(() => {
      this.run(
        `INSERT INTO semantic_states (
           session_id, ord, task, phase, current_activity, recent_progress_json,
           last_meaningful_update, source, provenance_json, updated_at)
         SELECT :sessionId,
                COALESCE((SELECT MAX(ord) FROM semantic_states WHERE session_id = :sessionId), 0) + 1,
                :task, :phase, :currentActivity, :recentProgress,
                :lastMeaningfulUpdate, :source, :provenance, :updatedAt`,
        {
          sessionId,
          task: rows.text(state.task),
          phase: state.phase,
          currentActivity: state.currentActivity,
          recentProgress: JSON.stringify(state.recentProgress),
          lastMeaningfulUpdate: state.lastMeaningfulUpdate,
          source: state.source,
          provenance: JSON.stringify(state.provenance),
          updatedAt: state.updatedAt,
        },
      );
      this.run(
        'UPDATE sessions SET semantic_state_json = :state WHERE id = :sessionId',
        { sessionId, state: JSON.stringify(state) },
      );
    });
  }

  getSemanticHistory(sessionId: string, limit?: number): SemanticState[] {
    return this.tail(
      'SELECT * FROM semantic_states WHERE session_id = :sessionId',
      'ord',
      { sessionId },
      limit,
    ).map(rows.toSemanticState);
  }

  // ------------------------------------------------------------ conversation

  /**
   * Persist a conversational turn, and optionally the record of delivering it.
   *
   * Both in one transaction: an answer that was spoken and an answer that was
   * merely recorded must not become distinguishable by a crash landing between
   * two writes.
   */
  async appendConversationEntry(
    entry: ConversationEntry,
    delivery?: Omit<ConversationDelivery, 'id' | 'entryId' | 'sessionId'>,
  ): Promise<ConversationEntry | null> {
    const stored = this.transaction(() => {
      const inserted = this.get(
        `INSERT INTO conversation_entries (
           id, session_id, ord, at, role, text, refs_json, provenance_json,
           investigation_json, origin_provider, origin_kind, origin_id)
         SELECT :id, :sessionId,
                COALESCE((SELECT MAX(ord) FROM conversation_entries
                           WHERE session_id = :sessionId), 0) + 1,
                :at, :role, :text, :refs, :provenance, :investigation,
                :originProvider, :originKind, :originId
         -- Required: SQLite cannot parse ON CONFLICT after a bare SELECT.
         WHERE true
         -- The turn has already been stored, so this delivery of it consumes
         -- no ordinal and writes nothing. The unique index is partial, so an
         -- entry with no origin never reaches this branch.
         -- The index is partial, so its predicate belongs in the conflict
         -- target too; SQLite will not match it otherwise.
         ON CONFLICT (session_id, origin_provider, origin_kind, origin_id)
           WHERE origin_provider IS NOT NULL
           DO NOTHING
         RETURNING *`,
        {
          id: entry.id,
          sessionId: entry.sessionId,
          at: entry.at,
          role: entry.role,
          text: entry.text,
          refs: rows.json(entry.refs),
          provenance: rows.json(entry.provenance),
          investigation: rows.json(entry.investigation),
          originProvider: rows.text(entry.origin?.provider),
          originKind: rows.text(entry.origin?.kind),
          originId: rows.text(entry.origin?.id),
        },
      );
      if (!inserted) return null;
      if (delivery) {
        this.insertDelivery({
          ...delivery,
          id: randomUUID(),
          entryId: entry.id,
          sessionId: entry.sessionId,
        });
      }
      return rows.toConversationEntry(inserted);
    });

    // A turn that was already stored is not a change to the conversation, and
    // a UI that re-read on every duplicate provider event would be reacting to
    // the network rather than to the person.
    if (!stored) return null;

    // After COMMIT, and after the entry is readable: a listener that turns
    // around and calls `getConversation` must see what it was told about.
    this.notifyConversation({ sessionId: entry.sessionId });
    return stored;
  }

  /**
   * Subscribing is not a write, so nothing here is queued or persisted, and
   * opening an existing database deliberately notifies nobody: a restart is not
   * a change to the conversation.
   */
  onConversationChanged(
    listener: (change: ConversationChange) => void,
  ): () => void {
    this.conversationListeners.add(listener);
    return () => {
      this.conversationListeners.delete(listener);
    };
  }

  private notifyConversation(change: ConversationChange): void {
    for (const listener of this.conversationListeners) {
      try {
        listener(change);
      } catch (error) {
        // A UI subscriber must never be able to fail a durable write — and must
        // not disappear silently either. The write has already committed, so
        // there is nothing here that could roll it back even in principle.
        this.onError('conversation-listener', error);
      }
    }
  }

  getConversation(sessionId: string, limit?: number): ConversationEntry[] {
    return this.tail(
      'SELECT * FROM conversation_entries WHERE session_id = :sessionId',
      'ord',
      { sessionId },
      limit,
    ).map(rows.toConversationEntry);
  }

  // ----------------------------------------------------- project conversation

  async appendProjectConversationEntry(
    entry: ProjectConversationEntry,
  ): Promise<ProjectConversationEntry | null> {
    const stored = this.transaction(() => {
      const inserted = this.get(
        `INSERT INTO project_conversation_entries (
           id, project_id, ord, at, role, text, refs_json, provenance_json,
           investigation_json, origin_provider, origin_kind, origin_id)
         SELECT :id, :projectId,
                COALESCE((SELECT MAX(ord) FROM project_conversation_entries
                           WHERE project_id = :projectId), 0) + 1,
                :at, :role, :text, :refs, :provenance, :investigation,
                :originProvider, :originKind, :originId
         -- Required: SQLite cannot parse ON CONFLICT after a bare SELECT.
         WHERE true
         -- Partial index, so its predicate belongs in the conflict target too.
         ON CONFLICT (project_id, origin_provider, origin_kind, origin_id)
           WHERE origin_provider IS NOT NULL
           DO NOTHING
         RETURNING *`,
        {
          id: entry.id,
          projectId: entry.projectId,
          at: entry.at,
          role: entry.role,
          text: entry.text,
          refs: rows.json(entry.refs),
          provenance: rows.json(entry.provenance),
          investigation: rows.json(entry.investigation),
          originProvider: rows.text(entry.origin?.provider),
          originKind: rows.text(entry.origin?.kind),
          originId: rows.text(entry.origin?.id),
        },
      );
      return inserted ? rows.toProjectConversationEntry(inserted) : null;
    });

    if (!stored) return null;
    this.notifyProjectConversation({ projectId: entry.projectId });
    return stored;
  }

  getProjectConversation(projectId: string, limit?: number): ProjectConversationEntry[] {
    return this.tail(
      'SELECT * FROM project_conversation_entries WHERE project_id = :projectId',
      'ord',
      { projectId },
      limit,
    ).map(rows.toProjectConversationEntry);
  }

  onProjectConversationChanged(
    listener: (change: ProjectConversationChange) => void,
  ): () => void {
    this.projectConversationListeners.add(listener);
    return () => {
      this.projectConversationListeners.delete(listener);
    };
  }

  private notifyProjectConversation(change: ProjectConversationChange): void {
    for (const listener of this.projectConversationListeners) {
      try {
        listener(change);
      } catch (error) {
        this.onError('project-conversation-listener', error);
      }
    }
  }

  // --------------------------------------------------------------- delivery

  /**
   * Attach a delivery to an entry that already exists.
   *
   * Used when communication begins on a surface that did not write the entry —
   * the entry is the one semantic turn, and this records an attempt to convey
   * it. There is deliberately nowhere here to put a second copy of the answer.
   */
  async recordDelivery(delivery: ConversationDelivery): Promise<void> {
    this.insertDelivery(delivery);
  }

  /**
   * Advance a delivery that is already in flight.
   *
   * Only delivery state moves. `id`, `entryId`, `sessionId` and `modality` are
   * fixed when the row is created and are not accepted here: a record of
   * speaking one answer cannot later become a record of showing another.
   * Returns `null` when there is no such delivery.
   */
  async updateDelivery(
    deliveryId: string,
    progress: DeliveryProgress,
  ): Promise<ConversationDelivery | null> {
    const row = this.get(
      `UPDATE conversation_deliveries SET
         status                  = COALESCE(:status, status),
         delivered_text          = COALESCE(:deliveredText, delivered_text),
         audio_end_ms            = COALESCE(:audioEndMs, audio_end_ms),
         interrupted_by_entry_id = COALESCE(:interruptedBy, interrupted_by_entry_id),
         completed_at            = COALESCE(:completedAt, completed_at)
       WHERE id = :id
       RETURNING *`,
      {
        id: deliveryId,
        status: rows.text(progress.status),
        deliveredText: rows.text(progress.deliveredText),
        audioEndMs: rows.num(progress.audioEndMs),
        interruptedBy: rows.text(progress.interruptedByEntryId),
        completedAt: rows.text(progress.completedAt),
      },
    );
    return row ? rows.toDelivery(row) : null;
  }

  /** Every delivery of one entry, oldest first. */
  getDeliveries(entryId: string): ConversationDelivery[] {
    return this.all(
      'SELECT * FROM conversation_deliveries WHERE entry_id = ? ORDER BY ord',
      entryId,
    ).map(rows.toDelivery);
  }

  getDeliveriesForSession(
    sessionId: string,
    limit?: number,
  ): ConversationDelivery[] {
    return this.tail(
      'SELECT * FROM conversation_deliveries WHERE session_id = :sessionId',
      'ord',
      { sessionId },
      limit,
    ).map(rows.toDelivery);
  }

  private insertDelivery(delivery: ConversationDelivery): void {
    this.run(
      `INSERT INTO conversation_deliveries (
         id, entry_id, session_id, ord, modality, status, delivered_text,
         audio_end_ms, interrupted_by_entry_id, started_at, completed_at)
       SELECT :id, :entryId, :sessionId,
              COALESCE((SELECT MAX(ord) FROM conversation_deliveries
                         WHERE session_id = :sessionId), 0) + 1,
              :modality, :status, :deliveredText, :audioEndMs, :interruptedBy,
              :startedAt, :completedAt`,
      {
        id: delivery.id,
        entryId: delivery.entryId,
        sessionId: delivery.sessionId,
        modality: delivery.modality,
        status: delivery.status,
        deliveredText: rows.text(delivery.deliveredText),
        audioEndMs: rows.num(delivery.audioEndMs),
        interruptedBy: rows.text(delivery.interruptedByEntryId),
        startedAt: delivery.startedAt,
        completedAt: rows.text(delivery.completedAt),
      },
    );
  }

  // ------------------------------------------------- Vowe execution history

  async appendRun(run: VoweRun): Promise<void> {
    this.run(
      `INSERT INTO vowe_runs (
         id, session_id, project_id, kind, provider, model, status,
         trigger_entry_id, output_entry_id, started_at, completed_at,
         usage_json, metadata_json)
       VALUES (:id, :sessionId, :projectId, :kind, :provider, :model, :status,
               :triggerEntryId, :outputEntryId, :startedAt, :completedAt,
               :usage, :metadata)`,
      {
        id: run.id,
        sessionId: rows.text(run.sessionId),
        projectId: rows.text(run.projectId),
        kind: run.kind,
        provider: rows.text(run.provider),
        model: rows.text(run.model),
        status: run.status,
        triggerEntryId: rows.text(run.triggerEntryId),
        outputEntryId: rows.text(run.outputEntryId),
        startedAt: run.startedAt,
        completedAt: rows.text(run.completedAt),
        usage: rows.json(run.usage),
        metadata: rows.json(run.metadata),
      },
    );
  }

  /**
   * How a run ended.
   *
   * `status` is assigned rather than coalesced — a run that ends in error must
   * be able to say so after saying `started`, which a COALESCE would refuse.
   * The rest keep whatever is already there when nothing new is offered.
   */
  async finishRun(
    runId: string,
    completion: RunCompletion,
  ): Promise<VoweRun | null> {
    const row = this.get(
      `UPDATE vowe_runs SET
         status          = :status,
         completed_at    = :completedAt,
         provider        = COALESCE(:provider, provider),
         model           = COALESCE(:model, model),
         usage_json      = COALESCE(:usage, usage_json),
         output_entry_id = COALESCE(:outputEntryId, output_entry_id),
         metadata_json   = COALESCE(:metadata, metadata_json)
       WHERE id = :id
       RETURNING *`,
      {
        id: runId,
        status: completion.status,
        completedAt: completion.completedAt,
        provider: rows.text(completion.provider),
        model: rows.text(completion.model),
        usage: rows.json(completion.usage),
        outputEntryId: rows.text(completion.outputEntryId),
        metadata: rows.json(completion.metadata),
      },
    );
    return row ? rows.toRun(row) : null;
  }

  async appendTraceItems(
    runId: string,
    items: Omit<VoweTraceItem, 'runId' | 'ord'>[],
  ): Promise<void> {
    if (!items.length) return;
    this.transaction(() => {
      for (const item of items) {
        this.run(
          `INSERT INTO vowe_trace_items (
             run_id, ord, id, kind, text, payload_json, provider_item_id, at)
           SELECT :runId,
                  COALESCE((SELECT MAX(ord) FROM vowe_trace_items
                             WHERE run_id = :runId), 0) + 1,
                  :id, :kind, :text, :payload, :providerItemId, :at`,
          {
            runId,
            id: item.id,
            kind: item.kind,
            text: rows.text(item.text),
            payload: rows.json(item.payload),
            providerItemId: rows.text(item.providerItemId),
            at: item.at,
          },
        );
      }
    });
  }

  getRun(runId: string): VoweRun | null {
    const row = this.get('SELECT * FROM vowe_runs WHERE id = ?', runId);
    return row ? rows.toRun(row) : null;
  }

  getRuns(sessionId: string, limit?: number): VoweRun[] {
    return this.tail(
      'SELECT * FROM vowe_runs WHERE session_id = :sessionId',
      'started_at',
      { sessionId },
      limit,
    ).map(rows.toRun);
  }

  getRunForEntry(entryId: string): VoweRun | null {
    const row = this.get(
      'SELECT * FROM vowe_runs WHERE output_entry_id = ? ORDER BY started_at LIMIT 1',
      entryId,
    );
    return row ? rows.toRun(row) : null;
  }

  getTraceItems(runId: string): VoweTraceItem[] {
    return this.all(
      'SELECT * FROM vowe_trace_items WHERE run_id = ? ORDER BY ord',
      runId,
    ).map(rows.toTraceItem);
  }

  // ------------------------------------------------------------ observation

  async appendWindow(window: TraceWindow): Promise<void> {
    this.run(
      `INSERT INTO windows (
         session_id, idx, id, start_seq, end_seq, event_count, approx_tokens,
         source, start_offset, end_offset, started_at, ended_at, closed_by,
         created_at)
       VALUES (:sessionId, :idx, :id, :startSeq, :endSeq, :eventCount,
               :approxTokens, :source, :startOffset, :endOffset, :startedAt,
               :endedAt, :closedBy, :createdAt)
       -- Appending the same window twice is a no-op, not a duplicate.
       ON CONFLICT (session_id, idx) DO NOTHING`,
      {
        sessionId: window.sessionId,
        idx: window.index,
        id: window.id,
        startSeq: window.startSeq,
        endSeq: window.endSeq,
        eventCount: window.eventCount,
        approxTokens: window.approxTokens,
        source: rows.text(window.source),
        startOffset: rows.num(window.startOffset),
        endOffset: rows.num(window.endOffset),
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        closedBy: window.closedBy,
        createdAt: window.createdAt,
      },
    );
  }

  getWindows(sessionId: string, query: WindowQuery = {}): TraceWindow[] {
    return this.tail(
      `SELECT * FROM windows
        WHERE session_id = :sessionId
          AND (:sinceIndex IS NULL OR idx > :sinceIndex)`,
      'idx',
      { sessionId, sinceIndex: rows.num(query.sinceIndex) },
      query.limit,
    ).map(rows.toWindow);
  }

  getWindow(sessionId: string, windowId: string): TraceWindow | null {
    const row = this.get(
      'SELECT * FROM windows WHERE session_id = ? AND id = ?',
      sessionId,
      windowId,
    );
    return row ? rows.toWindow(row) : null;
  }

  async appendWindowNote(note: WindowNote): Promise<void> {
    this.run(
      `INSERT INTO window_notes (
         id, session_id, ord, window_id, window_index, summary,
         current_activity, notable_change, refs_json, investigated, created_at)
       SELECT :id, :sessionId,
              COALESCE((SELECT MAX(ord) FROM window_notes
                         WHERE session_id = :sessionId), 0) + 1,
              :windowId, :windowIndex, :summary, :currentActivity,
              :notableChange, :refs, :investigated, :createdAt
       WHERE true
       -- One note per window. Re-noting a window replaces its note rather than
       -- leaving the list and the per-window lookup disagreeing.
       ON CONFLICT (session_id, window_id) DO UPDATE SET
         id               = excluded.id,
         window_index     = excluded.window_index,
         summary          = excluded.summary,
         current_activity = excluded.current_activity,
         notable_change   = excluded.notable_change,
         refs_json        = excluded.refs_json,
         investigated     = excluded.investigated,
         created_at       = excluded.created_at`,
      {
        id: note.id,
        sessionId: note.sessionId,
        windowId: note.windowId,
        windowIndex: note.windowIndex,
        summary: note.summary,
        currentActivity: rows.text(note.currentActivity),
        notableChange: rows.text(note.notableChange),
        refs: JSON.stringify(note.refs),
        investigated: rows.bool(note.investigated),
        createdAt: note.createdAt,
      },
    );
  }

  getWindowNotes(sessionId: string, limit?: number): WindowNote[] {
    return this.tail(
      'SELECT * FROM window_notes WHERE session_id = :sessionId',
      'ord',
      { sessionId },
      limit,
    ).map(rows.toWindowNote);
  }

  getWindowNoteForWindow(
    sessionId: string,
    windowId: string,
  ): WindowNote | null {
    const row = this.get(
      'SELECT * FROM window_notes WHERE session_id = ? AND window_id = ?',
      sessionId,
      windowId,
    );
    return row ? rows.toWindowNote(row) : null;
  }

  async appendSurfaceUpdate(update: SurfaceUpdate): Promise<void> {
    this.run(
      `INSERT INTO surface_updates (
         id, session_id, ord, window_id, message, why_now, refs_json, urgency,
         created_at, decision_json, decided_at, delivered_at)
       SELECT :id, :sessionId,
              COALESCE((SELECT MAX(ord) FROM surface_updates
                         WHERE session_id = :sessionId), 0) + 1,
              :windowId, :message, :whyNow, :refs, :urgency, :createdAt,
              :decision, :decidedAt, :deliveredAt
       WHERE true
       ON CONFLICT (id) DO UPDATE SET
         window_id     = excluded.window_id,
         message       = excluded.message,
         why_now       = excluded.why_now,
         refs_json     = excluded.refs_json,
         urgency       = excluded.urgency,
         created_at    = excluded.created_at,
         decision_json = excluded.decision_json,
         decided_at    = excluded.decided_at,
         delivered_at  = excluded.delivered_at`,
      {
        id: update.id,
        sessionId: update.sessionId,
        windowId: rows.text(update.windowId),
        message: update.message,
        whyNow: update.whyNow,
        refs: JSON.stringify(update.refs),
        urgency: update.urgency,
        createdAt: update.createdAt,
        decision: rows.json(update.decision),
        decidedAt: rows.text(update.decidedAt),
        deliveredAt: rows.text(update.deliveredAt),
      },
    );
  }

  /**
   * A decision attaches to a candidate in place.
   *
   * The NDJSON store appended a superseding record because a line cannot be
   * rewritten; nothing ever read the superseded versions. Here it is one row
   * and one UPDATE, and the merged record comes straight back out of it.
   */
  async recordCommunicationDecision(
    sessionId: string,
    surfaceUpdateId: string,
    decision: CommunicationDecision,
  ): Promise<SurfaceUpdate | null> {
    const row = this.get(
      `UPDATE surface_updates
          SET decision_json = :decision, decided_at = :decidedAt
        WHERE session_id = :sessionId AND id = :id
        RETURNING *`,
      {
        sessionId,
        id: surfaceUpdateId,
        decision: JSON.stringify(decision),
        decidedAt: new Date().toISOString(),
      },
    );
    return row ? rows.toSurfaceUpdate(row) : null;
  }

  async markSurfaceUpdateDelivered(
    sessionId: string,
    surfaceUpdateId: string,
  ): Promise<SurfaceUpdate | null> {
    const row = this.get(
      `UPDATE surface_updates
          SET delivered_at = :deliveredAt
        WHERE session_id = :sessionId AND id = :id
        RETURNING *`,
      { sessionId, id: surfaceUpdateId, deliveredAt: new Date().toISOString() },
    );
    return row ? rows.toSurfaceUpdate(row) : null;
  }

  getSurfaceUpdates(sessionId: string, limit?: number): SurfaceUpdate[] {
    // Ordered by createdAt with `ord` as the tiebreak, which reproduces the
    // stable insertion order the in-memory Map gave on equal timestamps.
    return this.tail(
      'SELECT * FROM surface_updates WHERE session_id = :sessionId',
      'created_at, ord',
      { sessionId },
      limit,
    ).map(rows.toSurfaceUpdate);
  }

  getObservationState(sessionId: string): ObservationState | null {
    const row = this.get(
      'SELECT * FROM observation_state WHERE session_id = ?',
      sessionId,
    );
    return row ? rows.toObservationState(row) : null;
  }

  async setObservationState(state: ObservationState): Promise<void> {
    this.run(
      `INSERT INTO observation_state (
         session_id, last_closed_window_index, last_processed_window_id,
         processed_through_seq, communication_preference, updated_at)
       VALUES (:sessionId, :lastClosedWindowIndex, :lastProcessedWindowId,
               :processedThroughSeq, :communicationPreference, :updatedAt)
       ON CONFLICT (session_id) DO UPDATE SET
         last_closed_window_index = excluded.last_closed_window_index,
         last_processed_window_id = excluded.last_processed_window_id,
         processed_through_seq    = excluded.processed_through_seq,
         communication_preference = excluded.communication_preference,
         updated_at               = excluded.updated_at`,
      {
        sessionId: state.sessionId,
        lastClosedWindowIndex: state.lastClosedWindowIndex,
        lastProcessedWindowId: rows.text(state.lastProcessedWindowId),
        processedThroughSeq: state.processedThroughSeq,
        communicationPreference: rows.text(state.communicationPreference),
        updatedAt: state.updatedAt,
      },
    );
  }

  // ----------------------------------------------------------------- private

  private connection(): DatabaseSync {
    if (!this.db) {
      throw new Error('vowe: the store was used before init() or after close()');
    }
    return this.db;
  }

  /** Prepared once and reused; the 18 ms/12k-row figure assumes this. */
  private statement(sql: string): StatementSync {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.connection().prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...params: unknown[]): void {
    this.statement(sql).run(...(params as never[]));
  }

  private get(sql: string, ...params: unknown[]): rows.Row | null {
    return (this.statement(sql).get(...(params as never[])) as rows.Row) ?? null;
  }

  private all(sql: string, ...params: unknown[]): rows.Row[] {
    return this.statement(sql).all(...(params as never[])) as rows.Row[];
  }

  /**
   * The last N rows, in ascending order.
   *
   * Every `limit` in the `EventStore` contract means the most recent N, not the
   * first N — so the rows are taken from the end and flipped back. Getting this
   * backwards would silently serve the oldest history everywhere at once.
   */
  private tail(
    select: string,
    order: string,
    params: Record<string, unknown>,
    limit?: number,
  ): rows.Row[] {
    if (limit === undefined) {
      return this.all(`${select} ORDER BY ${order}`, params);
    }
    if (limit <= 0) return [];
    return this.all(
      `${select} ORDER BY ${order} DESC LIMIT ${Math.floor(limit)}`,
      params,
    ).reverse();
  }

  /**
   * Run several statements as one commit.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front: a deferred transaction
   * that discovers it needs to write can fail partway, which is the one
   * failure mode a transaction exists to prevent.
   */
  private transaction<T>(work: () => T): T {
    const db = this.connection();
    if (db.isTransaction) return work();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
