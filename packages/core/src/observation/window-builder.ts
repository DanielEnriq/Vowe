import { randomUUID } from 'node:crypto';

import type { NormalizedEvent } from '../types/events.js';
import {
  DEFAULT_WINDOW_POLICY,
  type TraceWindow,
  type WindowCloseReason,
  type WindowPolicy,
} from './trace-window.js';

export interface WindowBuilderOptions {
  sessionId: string;
  policy?: Partial<WindowPolicy>;
  /**
   * Where numbering resumes. After a restart this is the last window index
   * already persisted, so indexes stay unique and ordered for the session's
   * whole life rather than only within one process.
   */
  startIndex?: number;
  /** Injectable for tests; only used for `createdAt` bookkeeping. */
  now?: () => Date;
}

/**
 * Divides a session's normalized event stream into ordered processing windows.
 *
 * Three invariants, in order of importance:
 *
 *  1. **Nothing is skipped.** Every event handed to `push` ends up in exactly
 *     one window. There is no sampling and no filtering here.
 *  2. **Windows are ordered and contiguous.** `windows[n+1].startSeq` is always
 *     `windows[n].endSeq + 1`.
 *  3. **The source range is recoverable.** A window carries both the logical
 *     `seq` range and the physical byte range in the provider's own file.
 *
 * Time-based bounds are measured against *event timestamps*, never the wall
 * clock. That is what makes windowing a pure function of (events, policy):
 * replaying a recorded session tomorrow produces exactly the windows it
 * produced today, which is the whole point of having a replay path.
 */
export class WindowBuilder {
  readonly policy: WindowPolicy;
  private readonly sessionId: string;
  private readonly now: () => Date;
  private open: NormalizedEvent[] = [];
  private openApproxTokens = 0;
  private nextIndex: number;

  constructor(options: WindowBuilderOptions) {
    this.sessionId = options.sessionId;
    this.policy = { ...DEFAULT_WINDOW_POLICY, ...options.policy };
    this.nextIndex = (options.startIndex ?? -1) + 1;
    this.now = options.now ?? (() => new Date());
  }

  /** Events currently held in the unclosed tail. */
  get pendingCount(): number {
    return this.open.length;
  }

  /**
   * The unclosed tail itself.
   *
   * Read-only, and it does not close anything. A live checkpoint needs to see
   * what the worker has done since the last window without cutting a window
   * early — closing one on a clock would make the same trace produce different
   * windows depending on how fast it was read, which is exactly what the
   * `flush` comment above refuses to do.
   */
  get pending(): readonly NormalizedEvent[] {
    return this.open;
  }

  /** Highest sequence the builder has seen, closed or still open. */
  get seenThroughSeq(): number {
    return this.open.length ? this.open[this.open.length - 1]!.seq : this.lastClosedSeq;
  }

  private lastClosedSeq = 0;

  /**
   * Feed events in sequence order. Returns every window that closed as a
   * result; the tail stays open, because a window that is still filling has not
   * finished being a window.
   */
  push(events: NormalizedEvent[]): TraceWindow[] {
    const closed: TraceWindow[] = [];

    for (const event of events) {
      // A developer turn starts a new chapter, and a long silence ends one, so
      // close the previous window rather than straddling the boundary.
      const before = this.open.length ? this.closeReasonBefore(event) : null;
      if (before) closed.push(this.close(before));

      this.open.push(event);
      this.openApproxTokens += approxTokensOf(event);

      const after = this.closeReasonAfter();
      if (after) closed.push(this.close(after));
    }

    return closed;
  }

  /**
   * Close the open tail, if any.
   *
   * Used when a bounded trace has ended — replay, or catching up to the head of
   * a finished session. Not used mid-stream on a live session: closing a window
   * early just because no new event has arrived yet would make the same trace
   * produce different windows depending on how fast it was read.
   */
  flush(): TraceWindow | null {
    if (!this.open.length) return null;
    return this.close('flush');
  }

  // ----------------------------------------------------------------- private

  private closeReasonBefore(event: NormalizedEvent): WindowCloseReason | null {
    const previous = this.open[this.open.length - 1]!;
    const gap = Date.parse(event.at) - Date.parse(previous.at);
    if (Number.isFinite(gap) && gap >= this.policy.idleGapMs) return 'idleGap';
    if (this.policy.closeOnUserTurn && event.kind === 'user_instruction') {
      return 'userTurn';
    }
    return null;
  }

  private closeReasonAfter(): WindowCloseReason | null {
    if (this.open.length >= this.policy.maxEvents) return 'maxEvents';
    if (this.openApproxTokens >= this.policy.maxApproxTokens) return 'maxApproxTokens';

    const first = this.open[0]!;
    const last = this.open[this.open.length - 1]!;
    const elapsed = Date.parse(last.at) - Date.parse(first.at);
    if (Number.isFinite(elapsed) && elapsed >= this.policy.maxElapsedMs) {
      return 'maxElapsedMs';
    }
    return null;
  }

  private close(closedBy: WindowCloseReason): TraceWindow {
    const events = this.open;
    const first = events[0]!;
    const last = events[events.length - 1]!;

    const window: TraceWindow = {
      id: randomUUID(),
      sessionId: this.sessionId,
      index: this.nextIndex++,
      startSeq: first.seq,
      endSeq: last.seq,
      eventCount: events.length,
      eventIds: events.map(event => event.id),
      approxTokens: this.openApproxTokens,
      source: events.every(e => e.rawRef.source === first.rawRef.source) ? first.rawRef.source || null : null,
      startOffset: events.every(e => e.rawRef.source === first.rawRef.source) ? first.rawRef.byteOffset : null,
      endOffset: events.every(e => e.rawRef.source === first.rawRef.source) ? last.rawRef.byteOffset : null,
      startedAt: first.at,
      endedAt: last.at,
      closedBy,
      createdAt: this.now().toISOString(),
    };

    this.lastClosedSeq = last.seq;
    this.open = [];
    this.openApproxTokens = 0;
    return window;
  }
}

/**
 * Size estimate for an event.
 *
 * Four characters per token is crude, but it is deterministic, needs no
 * tokenizer dependency, and is only ever used to decide where to cut. Being
 * exactly right here would buy nothing.
 */
export function approxTokensOf(event: NormalizedEvent): number {
  let characters = event.summary.length + event.kind.length;
  if (event.detail) {
    try {
      characters += JSON.stringify(event.detail).length;
    } catch {
      // A detail object that cannot be serialized still has a size; guessing
      // small is safer than throwing while windowing.
      characters += 64;
    }
  }
  return Math.ceil(characters / 4);
}

/**
 * Rebuild a builder positioned to continue an already-windowed session.
 *
 * Used on startup: numbering picks up after the last persisted window so
 * indexes remain unique and ordered across restarts.
 */
export function resumeWindowBuilder(
  sessionId: string,
  lastWindowIndex: number,
  policy?: Partial<WindowPolicy>,
): WindowBuilder {
  return new WindowBuilder({ sessionId, policy, startIndex: lastWindowIndex });
}
