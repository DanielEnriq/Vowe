/**
 * Normalized event model.
 *
 * Two invariants:
 *  1. Raw evidence is never discarded. Every normalized event carries the
 *     provider's original record verbatim, plus a reference to where it came
 *     from, so higher-level state can always be traced back.
 *  2. Failing to classify an event is not a reason to drop it. Unrecognized
 *     records become `unknown` and are stored like any other.
 */

export type NormalizedEventKind =
  | 'session_started'
  | 'agent_message'
  /**
   * The worker's own reasoning, as the provider recorded it.
   *
   * Supporting evidence, never a source of truth about what a session is
   * doing. Most providers expose nothing here, and the ones that do expose it
   * unevenly, so observation, interpretation and milestones all ignore this
   * kind on purpose. It is carried so a person can read it and so an
   * investigation can cite it — nothing further depends on it.
   *
   * Its absence says nothing. `capabilities.reasoning` is what distinguishes
   * "did not think" from "we cannot see it".
   */
  | 'agent_reasoning'
  | 'user_instruction'
  | 'tool_started'
  | 'tool_finished'
  | 'command_started'
  | 'command_finished'
  | 'file_changed'
  | 'test_started'
  | 'test_finished'
  /** The worker cannot proceed without an approval. Always human attention. */
  | 'permission_requested'
  /**
   * The worker stopped and is waiting.
   *
   * This is *evidence*, unlike the `waiting` session status, which is only
   * ordinary between-turn idleness. But the kind alone still does not say
   * whether the stop was a question for a person or a pause of the worker's
   * own: only the adapter that produced it knows. An adapter that knows it
   * was a question sets `detail.awaitingHuman === true`, and the `Needs You`
   * projection admits nothing without that flag.
   */
  | 'session_waiting'
  | 'session_finished'
  | 'operation_reported'
  | 'unknown';

/** Where this record was captured. Historical reads use immutable Vowe evidence. */
export interface RawEventRef {
  /** Provider-specific source, e.g. a transcript file path. */
  source: string;
  byteOffset: number;
  line: number;
  /**
   * Which event this is among those produced by the same raw record.
   *
   * One record routinely becomes several events — a worker's message carrying
   * its reasoning and three tool calls is one line of JSON — and the physical
   * address is the same for all of them. Without this they are indistinguish-
   * able, and the store's idempotency index treats them as one record read
   * repeatedly: the first is kept and the rest are silently dropped.
   *
   * It is the index within that record's own output, so it is stable across
   * re-reads, which is what keeps restart-replay idempotent. Absent means `0`,
   * which is exactly right for the single-event records that are the majority.
   */
  ordinal?: number;
}

export interface NormalizedEvent {
  id: string;
  /** Vowe session id (`${provider}:${providerSessionId}`). */
  sessionId: string;
  /** Monotonic admission order; not a claim of total execution chronology. */
  seq: number;
  at: string;
  kind: NormalizedEventKind;
  /** Deterministic one-line description. No LLM involved. */
  summary: string;
  detail?: Record<string, unknown>;
  /** The provider's record, verbatim. */
  raw: unknown;
  rawRef: RawEventRef;
  /** Immutable admission metadata; additional physical supports live in the evidence ledger. */
  supportStatus?: 'superseded';
  evidence?: { factKey: string; basis: string; sourceId: string; captureId: string; supersedes?: string; execution?: string; conflict?: boolean };
}

/** Everything an adapter knows about an event except its Vowe-side identity. */
export type AdapterEvent = Omit<NormalizedEvent, 'id' | 'seq'>;
