import type { AdapterEvent, NormalizedEvent } from '../types/events.js';
import type { AgentSession, SemanticState } from '../types/session.js';
import type {
  ConversationDelivery,
  ConversationEntry,
  DeliveryProgress,
  ProjectConversationEntry,
} from '../types/conversation.js';
import type {
  RunCompletion,
  VoweRun,
  VoweTraceItem,
} from '../types/execution.js';
import type { Project } from '../projects/project.js';
import type {
  CommunicationDecision,
  ObservationState,
  SurfaceUpdate,
  TraceWindow,
  WindowNote,
} from '../observation/trace-window.js';

export interface WindowQuery {
  /** Return at most this many windows, taken from the end. */
  limit?: number;
  /** Only windows with `index` strictly greater than this. */
  sinceIndex?: number;
}

/**
 * An object rather than a bare session id, so this can gain a field — which
 * entry, which role — without breaking every listener.
 */
export interface ProjectConversationChange {
  projectId: string;
}

export interface ConversationChange {
  sessionId: string;
}

export interface EventQuery {
  /** Return at most this many events, taken from the end of the stream. */
  limit?: number;
  /** Only events with `seq` strictly greater than this. */
  sinceSeq?: number;
}

/**
 * Local persistence boundary.
 *
 * Deliberately narrow, so what is behind it can change without touching
 * callers — which is exactly what happened: this interface outlived the NDJSON
 * implementation it was first written for. Reads are synchronous and writes are
 * async, and that stays true of SQLite.
 */
export interface EventStore {
  init(): Promise<void>;

  /**
   * Release the underlying resources.
   *
   * A file-backed store holds a handle; a caller that deletes the store
   * directory, or opens a second store over the same one, needs this to have
   * happened first.
   */
  close(): Promise<void>;

  upsertSession(session: AgentSession): Promise<void>;
  listSessions(): AgentSession[];
  getSession(sessionId: string): AgentSession | null;

  /**
   * Assigns identity and ordering, then persists. Returns `null` when the
   * event was already stored (matched by its raw reference), which makes
   * restart-and-replay safe.
   */
  appendEvent(
    sessionId: string,
    event: AdapterEvent,
  ): Promise<NormalizedEvent | null>;
  getEvents(sessionId: string, query?: EventQuery): NormalizedEvent[];
  getEventsByIds(sessionId: string, ids: string[]): NormalizedEvent[];
  lastSeq(sessionId: string): number;

  appendSemanticState(sessionId: string, state: SemanticState): Promise<void>;
  getSemanticHistory(sessionId: string, limit?: number): SemanticState[];

  /**
   * Persist a conversational turn, and optionally how it was delivered.
   *
   * The delivery is an argument rather than a second call because the two are
   * one fact: an answer that was spoken and an answer that was merely recorded
   * must not become distinguishable by a crash landing between two writes.
   *
   * Returns the stored entry, or `null` when this turn was **already** stored —
   * the same promise `appendEvent` makes about a replayed trace record, for the
   * same reason. An entry carrying a `ConversationOrigin` is matched on that
   * identity, so a provider that redelivers a turn writes nothing the second
   * time and no delivery is attached twice either. An entry without an origin
   * is Vowe's own and is always inserted.
   */
  appendConversationEntry(
    entry: ConversationEntry,
    delivery?: Omit<ConversationDelivery, 'id' | 'entryId' | 'sessionId'>,
  ): Promise<ConversationEntry | null>;
  getConversation(sessionId: string, limit?: number): ConversationEntry[];

  // ------------------------------------------------- project conversation

  /**
   * The durable thread for a project, kept apart from every session's.
   *
   * A project conversation is about the repository and the work across it; a
   * session conversation is about one worker's run. Separate storage because
   * they are separate threads, and because nothing that reads one should have
   * to remember to exclude the other.
   *
   * `null` on a duplicate origin, exactly as the session form does.
   */
  appendProjectConversationEntry(
    entry: ProjectConversationEntry,
  ): Promise<ProjectConversationEntry | null>;
  getProjectConversation(projectId: string, limit?: number): ProjectConversationEntry[];

  /**
   * Its own subscription, for the same reason it is its own table: a Project
   * Room re-reading because some session's conversation moved would be
   * reacting to work it is not showing.
   */
  onProjectConversationChanged(
    listener: (change: ProjectConversationChange) => void,
  ): () => void;

  // ------------------------------------------------- conversation delivery

  /**
   * What happened while a turn was communicated.
   *
   * The split is the point. A `ConversationEntry` holds the complete semantic
   * turn; a `ConversationDelivery` records an attempt to convey it. An answer
   * interrupted halfway through being spoken is one entry with the full text
   * and one delivery saying how far the audio got — never a truncated entry,
   * and never a second copy of the answer.
   *
   * That is also what keeps a turn persisted exactly once as voice grows up:
   * a surface that did not write the entry attaches a delivery to it, because
   * there is nowhere here to put another copy of the text.
   */
  recordDelivery(delivery: ConversationDelivery): Promise<void>;

  /**
   * Advance a delivery already in flight — typically from `started` to how it
   * ended. Only delivery state moves; identity and modality are fixed at
   * creation. `null` when there is no such delivery.
   */
  updateDelivery(
    deliveryId: string,
    progress: DeliveryProgress,
  ): Promise<ConversationDelivery | null>;

  /** Every delivery of one entry, oldest first. */
  getDeliveries(entryId: string): ConversationDelivery[];
  getDeliveriesForSession(
    sessionId: string,
    limit?: number,
  ): ConversationDelivery[];

  /**
   * A conversation has changed, and is already readable.
   *
   * Here rather than on the writers because every conversation write converges
   * on `appendConversationEntry` — a grounded answer typed or spoken, and an
   * instruction and its result — while the writers themselves do not converge
   * anywhere. A notification a future writer could forget to send is one the UI
   * would be wrong to rely on.
   *
   * Fires after the entry is durable and after `getConversation` would return
   * it, so a listener may re-read straight away. Returns its own unsubscribe.
   */
  onConversationChanged(listener: (change: ConversationChange) => void): () => void;

  // ------------------------------------------------- Vowe execution history

  /**
   * What Vowe itself did — which model, with what, and how it ended.
   *
   * A lane of its own rather than more worker events or more conversation,
   * because it answers a different question from either. See `VoweRun`.
   *
   * A run is written when it starts, so a row still reading `started` after a
   * restart is the honest record of an execution that was in flight when Vowe
   * stopped — exactly as a `ConversationDelivery` in the same state is.
   */
  appendRun(run: VoweRun): Promise<void>;
  finishRun(runId: string, completion: RunCompletion): Promise<VoweRun | null>;

  /**
   * The trace of one run, in execution order.
   *
   * Written in one transaction rather than item by item: the trace is only
   * meaningful whole, and `ord` is assigned here so the order is the store's
   * rather than a caller's counter.
   */
  appendTraceItems(
    runId: string,
    items: Omit<VoweTraceItem, 'runId' | 'ord'>[],
  ): Promise<void>;

  getRun(runId: string): VoweRun | null;
  getRuns(sessionId: string, limit?: number): VoweRun[];
  /** Which execution produced this answer. */
  getRunForEntry(entryId: string): VoweRun | null;
  getTraceItems(runId: string): VoweTraceItem[];

  // ------------------------------------------------------ observation (L1)

  /**
   * Window definitions. These are ranges, not content: the trace they point at
   * stays where the provider wrote it.
   */
  appendWindow(window: TraceWindow): Promise<void>;
  getWindows(sessionId: string, query?: WindowQuery): TraceWindow[];
  getWindow(sessionId: string, windowId: string): TraceWindow | null;

  appendWindowNote(note: WindowNote): Promise<void>;
  getWindowNotes(sessionId: string, limit?: number): WindowNote[];
  getWindowNoteForWindow(sessionId: string, windowId: string): WindowNote | null;

  /** Communication candidates produced by `surface_update`. */
  appendSurfaceUpdate(update: SurfaceUpdate): Promise<void>;
  recordCommunicationDecision(
    sessionId: string,
    surfaceUpdateId: string,
    decision: CommunicationDecision,
  ): Promise<SurfaceUpdate | null>;
  markSurfaceUpdateDelivered(
    sessionId: string,
    surfaceUpdateId: string,
  ): Promise<SurfaceUpdate | null>;
  getSurfaceUpdates(sessionId: string, limit?: number): SurfaceUpdate[];

  /**
   * The observation cursor and the session's communication preference.
   * Returning `null` means this session has never been observed.
   */
  getObservationState(sessionId: string): ObservationState | null;
  setObservationState(state: ObservationState): Promise<void>;

  // --------------------------------------------------------------- projects

  /**
   * Durable project identity.
   *
   * Identity only: which sessions belong to a project is recorded on the
   * sessions themselves, and everything else about a project is derived. There
   * is deliberately nothing here to keep in sync.
   */
  upsertProject(project: Project): Promise<void>;
  listProjects(): Project[];
  getProject(projectId: string): Project | null;

  /**
   * Where a project's *derived* knowledge belongs — a code graph, what Vowe has
   * learned, anything else that is expensive to rebuild and belongs to the
   * project rather than to a session.
   *
   * The store hands out the path and stops there. It does not read or write
   * inside, because it does not know what a code graph is and should not have
   * to. What it does guarantee is that the directory is Vowe's, outside the
   * user's repository, and stable across restarts.
   */
  projectDataDir(projectId: string): string;
}
