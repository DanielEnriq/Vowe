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
  | 'user_instruction'
  | 'tool_started'
  | 'tool_finished'
  | 'command_started'
  | 'command_finished'
  | 'file_changed'
  | 'test_started'
  | 'test_finished'
  | 'permission_requested'
  | 'session_waiting'
  | 'session_finished'
  | 'unknown';

/** Where the raw record physically lives, so it can be re-read on demand. */
export interface RawEventRef {
  /** Provider-specific source, e.g. a transcript file path. */
  source: string;
  byteOffset: number;
  line: number;
}

export interface NormalizedEvent {
  id: string;
  /** Vowe session id (`${provider}:${providerSessionId}`). */
  sessionId: string;
  /** Monotonic per-session ordering. */
  seq: number;
  at: string;
  kind: NormalizedEventKind;
  /** Deterministic one-line description. No LLM involved. */
  summary: string;
  detail?: Record<string, unknown>;
  /** The provider's record, verbatim. */
  raw: unknown;
  rawRef: RawEventRef;
}

/** Everything an adapter knows about an event except its Vowe-side identity. */
export type AdapterEvent = Omit<NormalizedEvent, 'id' | 'seq'>;
