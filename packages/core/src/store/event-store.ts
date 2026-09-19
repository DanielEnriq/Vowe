import type { AdapterEvent, NormalizedEvent } from '../types/events.js';
import type { AgentSession, SemanticState } from '../types/session.js';
import type { ConversationEntry } from '../types/conversation.js';
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

export interface EventQuery {
  /** Return at most this many events, taken from the end of the stream. */
  limit?: number;
  /** Only events with `seq` strictly greater than this. */
  sinceSeq?: number;
}

/**
 * Local persistence boundary.
 *
 * Deliberately narrow so the NDJSON implementation can be swapped for SQLite
 * (or anything else) without touching callers. Reads are synchronous because
 * the implementation keeps its working set in memory; writes are async because
 * they hit disk.
 */
export interface EventStore {
  init(): Promise<void>;

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

  appendConversationEntry(entry: ConversationEntry): Promise<void>;
  getConversation(sessionId: string, limit?: number): ConversationEntry[];

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

  /**
   * Opaque per-adapter scratch state (tail offsets, launch tables, ...).
   * Core never interprets the contents.
   */
  getAdapterState(provider: string): unknown;
  setAdapterState(provider: string, state: unknown): Promise<void>;
}
