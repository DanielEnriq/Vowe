import type { AdapterEvent, NormalizedEvent } from '../types/events.js';
import type { AgentSession, SemanticState } from '../types/session.js';
import type { ConversationEntry } from '../types/conversation.js';

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

  /**
   * Opaque per-adapter scratch state (tail offsets, launch tables, ...).
   * Core never interprets the contents.
   */
  getAdapterState(provider: string): unknown;
  setAdapterState(provider: string, state: unknown): Promise<void>;
}
