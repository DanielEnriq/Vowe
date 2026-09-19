import type { ContextRef } from '../context/refs.js';

/**
 * The two-level memory model.
 *
 * L0 is the coding agent's own trace. Vowe does not own it, does not re-encode
 * it, and does not replace it: `NormalizedEvent.raw` carries each provider
 * record verbatim and `NormalizedEvent.rawRef` gives its physical address.
 *
 * L1 is this file. A window is a bounded slice of L0 that an observer model can
 * process in one pass, and a note is what the observer understood from it. L1
 * is an orientation layer — an index with pointers down — never a substitute
 * for the trace itself.
 */

/**
 * A bounded, ordered slice of one session's trace.
 *
 * Deliberately small: a window stores the *range*, not the material. The
 * `seq` pair is the logical handle (stable, gap-free, what the store indexes
 * on); `source` plus the byte offsets are the physical address, so the original
 * transcript can be re-read directly without going through Vowe's store at all.
 */
export interface TraceWindow {
  id: string;
  sessionId: string;
  /** 0-based position in the session. The ordering invariant. */
  index: number;
  /** First normalized event sequence in the window, inclusive. */
  startSeq: number;
  /** Last normalized event sequence in the window, inclusive. */
  endSeq: number;
  eventCount: number;
  /** Cheap deterministic size estimate; see `approxTokensOf`. */
  approxTokens: number;
  /** Provider source of the underlying records, e.g. a transcript path. */
  source: string | null;
  /** Byte offset of the first underlying record in `source`. */
  startOffset: number | null;
  /** Byte offset of the last underlying record in `source`. */
  endOffset: number | null;
  /** Timestamp of the first event, from the trace, not the clock. */
  startedAt: string;
  /** Timestamp of the last event, from the trace, not the clock. */
  endedAt: string;
  closedBy: WindowCloseReason;
  createdAt: string;
}

export type WindowCloseReason =
  | 'maxEvents'
  | 'maxApproxTokens'
  | 'maxElapsedMs'
  | 'idleGap'
  | 'userTurn'
  | 'flush';

/**
 * Window sizing.
 *
 * Kept in one object, threaded in from the application wiring, so tuning it
 * later is a configuration change rather than a code change. Nothing
 * downstream of the builder depends on how windows were sized.
 */
export interface WindowPolicy {
  /** Close once the window holds this many events. */
  maxEvents: number;
  /** Close once the estimated size reaches this. */
  maxApproxTokens: number;
  /** Close once this much trace time has elapsed inside the window. */
  maxElapsedMs: number;
  /** Close when the trace goes quiet for this long — a natural boundary. */
  idleGapMs: number;
  /** Close before a new developer turn — also a natural boundary. */
  closeOnUserTurn: boolean;
}

export const DEFAULT_WINDOW_POLICY: WindowPolicy = {
  maxEvents: 40,
  maxApproxTokens: 6000,
  maxElapsedMs: 120_000,
  idleGapMs: 180_000,
  closeOnUserTurn: true,
};

/**
 * What the observer understood from one window.
 *
 * `summary` is prose and is the point of the record. The structured fields are
 * there because two questions get asked constantly ("what is it doing now?",
 * "did anything change?") and answering them from prose is wasteful. They are
 * not the beginning of an ontology.
 */
export interface WindowNote {
  id: string;
  sessionId: string;
  windowId: string;
  windowIndex: number;
  summary: string;
  currentActivity?: string;
  notableChange?: string;
  /** Always includes the window's own trace range. */
  refs: ContextRef[];
  /** True when the observer was given the navigator tools and used them. */
  investigated: boolean;
  createdAt: string;
}

export type SurfaceUrgency = 'low' | 'normal' | 'high';

/**
 * A candidate for interrupting the human.
 *
 * Producing one of these is not speaking. The observer decides that something
 * *might* be worth saying; `CommunicationPolicy` decides whether it is; the
 * `LiveBridge` decides how it is delivered. Keeping those three apart is why
 * "only tell me when something is weird" can be honoured at all.
 */
export interface SurfaceUpdate {
  id: string;
  sessionId: string;
  /** The window whose observation produced this candidate. */
  windowId: string | null;
  message: string;
  whyNow: string;
  refs: ContextRef[];
  urgency: SurfaceUrgency;
  createdAt: string;
  decision?: CommunicationDecision;
  decidedAt?: string;
  /** Set once the update actually reached the user. */
  deliveredAt?: string;
}

export type CommunicationAction =
  | 'ignore'
  | 'quiet_context'
  | 'speak_now'
  | 'queue';

export interface CommunicationDecision {
  action: CommunicationAction;
  reason: string;
  source: 'jev' | 'llm' | 'default';
  /**
   * Recorded for tuning only. Nothing in the system branches on these — if a
   * confidence threshold ever earns its place, this is the evidence that will
   * justify it.
   */
  metadata?: {
    confidence?: number;
    probabilities?: Record<string, number>;
  };
}

/**
 * Where observation of a session has got to.
 *
 * This is what makes restarting Vowe cheap: observation resumes from
 * `processedThroughSeq` instead of re-interpreting a session from zero.
 */
export interface ObservationState {
  sessionId: string;
  lastClosedWindowIndex: number;
  lastProcessedWindowId: string | null;
  /** Every event at or below this sequence has been folded into a window. */
  processedThroughSeq: number;
  /** The developer's own words about when they want to be told things. */
  communicationPreference: string | null;
  updatedAt: string;
}

export function emptyObservationState(sessionId: string): ObservationState {
  return {
    sessionId,
    lastClosedWindowIndex: -1,
    lastProcessedWindowId: null,
    processedThroughSeq: 0,
    communicationPreference: null,
    updatedAt: new Date(0).toISOString(),
  };
}
