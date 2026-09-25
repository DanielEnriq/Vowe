import { randomUUID } from 'node:crypto';

import type { ContextNavigator } from '../context/context-navigator.js';
import { dedupeRefs, parseRef, type ContextRef } from '../context/refs.js';
import type { DecisionRouter } from '../decision/decision-router.js';
import type {
  ObservationLlm,
  ObserverToolset,
  ObserveWindowInput,
  ReadOnlyToolset,
} from '../llm/observation-llm.js';
import type { RunHandle, VoweRunRecorder } from '../execution/run-recorder.js';
import { tracedTool } from '../execution/traced-tools.js';
import type { EventStore } from '../store/event-store.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession, MeaningfulUpdate } from '../types/session.js';
import { toObserverEventLine } from './observer-prompt.js';
import {
  emptyObservationState,
  type ObservationState,
  type SurfaceUpdate,
  type SurfaceUrgency,
  type TraceWindow,
  type WindowNote,
  type WindowPolicy,
} from './trace-window.js';
import { WindowBuilder } from './window-builder.js';

export interface ObserverRunnerOptions {
  sessionId: string;
  store: EventStore;
  observer: ObservationLlm;
  navigator: ContextNavigator;
  /** Optional; `HeuristicDecisionRouter` is a valid answer here. */
  router?: DecisionRouter;
  /** Resolves the session for task/cwd. Kept as a function so the runner
   *  holds no registry — and therefore no path to the worker. */
  getSession: (sessionId: string) => AgentSession | null;
  policy?: Partial<WindowPolicy>;
  /** How many recent notes to carry forward. */
  continuityNotes?: number;
  /** How many recent worker/developer messages to carry forward. */
  continuityMessages?: number;
  /** Where each window's model call is recorded, when anywhere. */
  runs?: VoweRunRecorder;
  /**
   * How often a live checkpoint may run, at most.
   *
   * A canonical window closes after forty events, six thousand tokens, two
   * minutes of trace or a three-minute silence. That is right for the durable
   * record and far too slow for someone deciding whether to look at this
   * session now, so understanding is refreshed on this cadence in between. Zero
   * turns checkpoints off.
   */
  checkpointMs?: number;
  /** How long to wait before retrying a transient failure. Injectable for tests. */
  backoff?: (attempt: number) => number;
  onError?: (scope: string, error: unknown) => void;
  onNote?: (note: WindowNote) => void;
  onSurfaceUpdate?: (update: SurfaceUpdate) => void;
  /**
   * The observer's understanding, whenever it moves.
   *
   * Fired by both speeds — a canonical window and a live checkpoint — because
   * what the consumer wants is the current understanding, not which mechanism
   * produced it. `onNote` remains the signal that the durable record changed.
   */
  onUnderstanding?: (understanding: ObserverUnderstanding) => void;
}

/**
 * What the observer currently understands, and anything durable that came with
 * it. The join between observation and a session's live state.
 */
export interface ObserverUnderstanding {
  sessionId: string;
  understanding: string | null;
  /** Absent for ordinary progress, which is most of the time. */
  durableUpdate: MeaningfulUpdate | null;
}

/**
 * What the observer reads as this session's transcript.
 *
 * `agent_reasoning` is deliberately absent. Observation is the one pipeline
 * that has to work identically for every provider, and most providers record
 * no reasoning at all — building windows on it would make Vowe's reading of a
 * pi session structurally better than its reading of a Codex one. The worker's
 * speech and actions are what every provider offers, so those are what this
 * reads. `ContextNavigator` keeps reasoning for questions asked on purpose.
 */
const TRANSCRIPT_KINDS = new Set<NormalizedEvent['kind']>([
  'agent_message',
  'user_instruction',
  'session_started',
]);

/**
 * Follows one session's trace, continuously, one window at a time.
 *
 * The shape is a single serialized loop per session. Windows are interpreted
 * strictly in order, because the observer's whole value is that note N+1 was
 * written by something that had already read note N — process them
 * concurrently and that continuity is gone.
 *
 * The cursor is persisted after every note. That is what makes restarting Vowe
 * cheap rather than destructive: a session with a thousand windows behind it
 * resumes at window 1001, and a crash mid-window costs exactly one window of
 * repeated work.
 *
 * What this class deliberately does not hold: an adapter, a registry, or any
 * transport to the worker. Observation cannot accidentally become control.
 */
export class ObserverRunner {
  readonly sessionId: string;
  private readonly store: EventStore;
  private readonly observer: ObservationLlm;
  private readonly navigator: ContextNavigator;
  private readonly router: DecisionRouter | undefined;
  private readonly getSession: (sessionId: string) => AgentSession | null;
  private readonly policy: Partial<WindowPolicy> | undefined;
  private readonly continuityNotes: number;
  private readonly continuityMessages: number;
  private readonly runs: VoweRunRecorder | null;
  private readonly checkpointMs: number;
  private readonly backoff: (attempt: number) => number;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly onNote: ((note: WindowNote) => void) | undefined;
  private readonly onSurfaceUpdate: ((update: SurfaceUpdate) => void) | undefined;
  private readonly onUnderstanding:
    | ((understanding: ObserverUnderstanding) => void)
    | undefined;

  private builder: WindowBuilder | null = null;
  private state: ObservationState;
  /**
   * How far the *builder* has consumed, which runs ahead of the interpretation
   * cursor whenever a window is in flight.
   *
   * These are two different high-water marks and conflating them re-windows
   * trace that arrives mid-observation: the persisted cursor deliberately does
   * not advance until a note is written, so it cannot also be what decides
   * which events have already been read.
   */
  private ingestedThroughSeq: number;
  /** Windows closed but not yet interpreted, in order. */
  private readonly queue: TraceWindow[] = [];
  private draining = false;
  /** Set while draining if more trace arrived; drives one more pass. */
  private moreArrived = false;
  private stopped = false;

  /**
   * The understanding carried between passes.
   *
   * Held in memory and seeded from the store on first use, so a restart resumes
   * with what was understood rather than starting the session over.
   */
  private understanding: string | null = null;
  private understandingLoaded = false;
  /** The last durable update given, for suppressing the same one said again. */
  private lastDurableUpdate: string | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private checkpointing = false;
  /** Consecutive transient failures per window, so a retry is bounded. */
  private readonly attempts = new Map<string, number>();
  /** Highest tail sequence a checkpoint has already read. */
  private checkpointedThroughSeq = 0;

  constructor(options: ObserverRunnerOptions) {
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.observer = options.observer;
    this.navigator = options.navigator;
    this.router = options.router;
    this.getSession = options.getSession;
    this.policy = options.policy;
    this.continuityNotes = options.continuityNotes ?? 4;
    this.continuityMessages = options.continuityMessages ?? 8;
    this.runs = options.runs ?? null;
    this.checkpointMs = options.checkpointMs ?? 20_000;
    this.backoff = options.backoff ?? backoffMs;
    this.onError = options.onError ?? (() => undefined);
    this.onNote = options.onNote;
    this.onSurfaceUpdate = options.onSurfaceUpdate;
    this.onUnderstanding = options.onUnderstanding;

    this.state =
      this.store.getObservationState(options.sessionId) ??
      emptyObservationState(options.sessionId);
    this.ingestedThroughSeq = this.state.processedThroughSeq;
  }

  get observationState(): ObservationState {
    return this.state;
  }

  /** True while there is recorded trace that has not been interpreted yet. */
  get catchingUp(): boolean {
    return (
      this.queue.length > 0 ||
      this.draining ||
      this.state.processedThroughSeq < this.store.lastSeq(this.sessionId)
    );
  }

  /** Highest sequence folded into a window, interpreted or not. */
  get ingestedThrough(): number {
    return this.ingestedThroughSeq;
  }

  /** The developer's stated terms for being interrupted. */
  get communicationPreference(): string | null {
    return this.state.communicationPreference;
  }

  async setCommunicationPreference(preference: string | null): Promise<void> {
    this.state = {
      ...this.state,
      communicationPreference: preference,
      updatedAt: new Date().toISOString(),
    };
    await this.store.setObservationState(this.state);
  }

  /**
   * Fold all recorded trace up to the current head into windows and interpret
   * them. Safe to call repeatedly; already-processed trace is skipped because
   * the cursor says where to resume.
   */
  async catchUp(options: { closeTail?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    this.startCheckpoints();
    this.ingest(options.closeTail ?? false);
    await this.drain();
  }

  /**
   * Notify the runner that new trace has arrived.
   *
   * Fire-and-forget on purpose. The caller is the event stream and must not be
   * made to wait on a model call.
   */
  notifyTrace(): void {
    if (this.stopped) return;
    this.startCheckpoints();
    this.ingest(false);
    if (this.draining) {
      this.moreArrived = true;
      return;
    }
    void this.drain().catch((error) => this.onError('drain', error));
  }

  stop(): void {
    this.stopped = true;
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  // ----------------------------------------------------------------- private

  /** Pull new events out of the store and window them. Synchronous and cheap. */
  private ingest(closeTail: boolean): void {
    const events = this.store.getEvents(this.sessionId, {
      sinceSeq: this.ingestedThroughSeq,
    });
    if (!this.builder) {
      this.builder = new WindowBuilder({
        sessionId: this.sessionId,
        startIndex: this.state.lastClosedWindowIndex,
        ...(this.policy ? { policy: this.policy } : {}),
      });
    }
    if (events.length) {
      this.ingestedThroughSeq = events[events.length - 1]!.seq;
      this.queue.push(...this.builder.push(events));
    }
    if (closeTail) {
      const tail = this.builder.flush();
      if (tail) this.queue.push(tail);
    }
  }

  /**
   * Interpret queued windows, one at a time, persisting after each.
   *
   * Reentrancy is handled by coalescing rather than locking: a second caller
   * sets `moreArrived` and returns immediately, so trace ingestion is never
   * blocked behind a model call.
   */
  private async drain(): Promise<void> {
    if (this.draining) {
      this.moreArrived = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.moreArrived = false;
        while (this.queue.length && !this.stopped) {
          const window = this.queue.shift()!;
          try {
            await this.processWindow(window);
            this.attempts.delete(window.id);
          } catch (error) {
            this.onError(`window:${window.index}`, error);

            /*
             * Being told to slow down is not the same as being unable to
             * interpret.
             *
             * A window that cannot be understood still advances the cursor,
             * because retrying it forever would stall observation permanently
             * and the trace stays addressable in L0 regardless. But a rate
             * limit says nothing about the window — it says the previous one
             * was a moment ago — and treating it the same way silently burned
             * the window. On a live session that is a hole in the developer's
             * understanding that never fills, and running several workers at
             * once is exactly when it happens.
             *
             * So a transient refusal is retried, a bounded number of times,
             * and only then given up on.
             */
            const attempt = (this.attempts.get(window.id) ?? 0) + 1;
            if (isTransient(error) && attempt <= MAX_TRANSIENT_ATTEMPTS) {
              this.attempts.set(window.id, attempt);
              this.queue.unshift(window);
              await this.pause(this.backoff(attempt));
              continue;
            }

            this.attempts.delete(window.id);
            await this.advanceCursor(window);
          }
        }
      } while (this.moreArrived && !this.stopped);
    } finally {
      this.draining = false;
    }
  }

  private async processWindow(window: TraceWindow): Promise<void> {
    await this.store.appendWindow(window);

    const session = this.getSession(this.sessionId);
    const events = this.eventsInRange(window.startSeq, window.endSeq);

    const input: ObserveWindowInput = {
      sessionId: this.sessionId,
      task: session?.task ?? null,
      cwd: session?.cwd ?? null,
      window: {
        windowId: window.id,
        windowIndex: window.index,
        startSeq: window.startSeq,
        endSeq: window.endSeq,
        startedAt: window.startedAt,
        endedAt: window.endedAt,
        events: events.map(toObserverEventLine),
      },
      currentUnderstanding: this.currentUnderstanding(),
      recentNotes: this.store.getWindowNotes(this.sessionId, this.continuityNotes),
      relevantOlderNotes: await this.pickRelevantOlderNotes(window),
      recentMessages: this.recentMessages(window.startSeq),
      communicationPreference: this.state.communicationPreference,
    };

    const collectedRefs: ContextRef[] = [];
    const explore = await this.shouldExplore(window, events);

    const run = this.runs?.begin({
      kind: 'observation',
      sessionId: this.sessionId,
      ...(session?.projectId ? { projectId: session.projectId } : {}),
      metadata: { windowId: window.id, windowIndex: window.index, explored: explore },
    });
    const toolset = this.buildToolset(window, collectedRefs, explore, run);

    let observation;
    try {
      observation = await this.observer.observeWindow(input, toolset, run);
    } catch (error) {
      await run?.failed(error);
      throw error;
    }
    await run?.complete();

    const refs: ContextRef[] = [
      {
        kind: 'trace',
        sessionId: this.sessionId,
        startSeq: window.startSeq,
        endSeq: window.endSeq,
      },
      ...collectedRefs,
      ...(observation.refs ?? [])
        .map((value) => parseRef(value))
        .filter((ref): ref is ContextRef => ref !== null),
    ];

    const durable = this.admitDurableUpdate(observation.notableChange);

    const note: WindowNote = {
      id: randomUUID(),
      sessionId: this.sessionId,
      windowId: window.id,
      windowIndex: window.index,
      summary: observation.summary,
      refs: dedupeRefs(refs),
      investigated: explore && collectedRefs.length > 0,
      createdAt: new Date().toISOString(),
    };
    if (observation.understanding) note.understanding = observation.understanding;
    if (observation.currentActivity) note.currentActivity = observation.currentActivity;
    if (durable) note.notableChange = durable;

    await this.store.appendWindowNote(note);
    await this.advanceCursor(window);
    this.onNote?.(note);
    this.publishUnderstanding(
      observation.understanding ?? null,
      durable
        ? { id: note.id, text: durable, at: note.createdAt, refs: note.refs }
        : null,
    );
  }

  // ------------------------------------------------------------- continuity

  /** The carried understanding, seeded from the store on first use. */
  private currentUnderstanding(): string | null {
    if (!this.understandingLoaded) {
      this.understandingLoaded = true;
      // Walk back from the newest note: a window whose model answered in prose
      // rather than by calling the terminal tool records no understanding, and
      // that should not read as "nothing is understood about this session".
      for (const note of [...this.store.getWindowNotes(this.sessionId)].reverse()) {
        if (note.understanding && this.understanding === null) {
          this.understanding = note.understanding;
        }
        if (note.notableChange && this.lastDurableUpdate === null) {
          this.lastDurableUpdate = note.notableChange;
        }
        if (this.understanding !== null && this.lastDurableUpdate !== null) break;
      }
    }
    return this.understanding;
  }

  /**
   * Whether a proposed durable update is actually new.
   *
   * The prompt asks for silence on ordinary progress, and a model mostly obliges
   * — but the failure it does have is restating the last update in slightly
   * different words, which turns a short readable list into the same sentence
   * five times. Containment in either direction catches that without a second
   * model call to judge the first one's output.
   *
   * Returns the update to record, or `undefined` for "nothing changed", which
   * is a normal outcome rather than a failure.
   */
  private admitDurableUpdate(proposed: string | undefined): string | undefined {
    const text = proposed?.trim();
    if (!text) return undefined;
    this.currentUnderstanding(); // seeds `lastDurableUpdate` on a fresh runner.

    const previous = this.lastDurableUpdate;
    if (previous) {
      const a = normalizeUpdate(text);
      const b = normalizeUpdate(previous);
      if (a === b || a.includes(b) || b.includes(a)) return undefined;
    }

    this.lastDurableUpdate = text;
    return text;
  }

  private publishUnderstanding(
    understanding: string | null,
    durableUpdate: MeaningfulUpdate | null,
  ): void {
    if (understanding) this.understanding = understanding;
    if (!understanding && !durableUpdate) return;
    this.onUnderstanding?.({
      sessionId: this.sessionId,
      understanding: this.understanding,
      durableUpdate,
    });
  }

  // ------------------------------------------------------------- checkpoint

  /**
   * Refresh the understanding from the open tail, without closing anything.
   *
   * This is the second speed of observation. It reads the events that have
   * arrived since the last window closed and asks the observer the same
   * question it always asks — what changed in your understanding? — but it
   * appends no window, writes no note and does not move the cursor. The
   * canonical record is produced by `processWindow` exactly as before, on
   * exactly the same boundaries; this only stops the product from having
   * nothing to say for two minutes at a time.
   *
   * Safe to call at any time. It declines whenever a canonical window is in
   * flight or the tail holds nothing new, so the quiet case costs nothing.
   */
  async checkpointNow(): Promise<void> {
    if (this.stopped || this.checkpointing) return;
    if (this.draining || this.queue.length) return;

    const tail = this.builder?.pending ?? [];
    if (!tail.length) return;
    const endSeq = tail[tail.length - 1]!.seq;
    if (endSeq <= this.checkpointedThroughSeq) return;

    this.checkpointing = true;
    try {
      await this.observeTail([...tail], endSeq);
      this.checkpointedThroughSeq = endSeq;
    } catch (error) {
      // A checkpoint is an optimisation. Losing one costs the developer a few
      // seconds of staleness and nothing else, so it never reaches the caller.
      this.onError('checkpoint', error);
    } finally {
      this.checkpointing = false;
    }
  }

  private async observeTail(events: NormalizedEvent[], endSeq: number): Promise<void> {
    const session = this.getSession(this.sessionId);
    const startSeq = events[0]!.seq;
    const nextIndex = this.state.lastClosedWindowIndex + 1;

    const input: ObserveWindowInput = {
      sessionId: this.sessionId,
      task: session?.task ?? null,
      cwd: session?.cwd ?? null,
      window: {
        // The window this trace will eventually belong to, named as such. No
        // row exists for it yet and none is written here.
        windowId: `pending:${this.sessionId}:${nextIndex}`,
        windowIndex: nextIndex,
        startSeq,
        endSeq,
        startedAt: events[0]!.at,
        endedAt: events[events.length - 1]!.at,
        events: events.map(toObserverEventLine),
      },
      currentUnderstanding: this.currentUnderstanding(),
      recentNotes: this.store.getWindowNotes(this.sessionId, this.continuityNotes),
      // Deliberately none: choosing one costs a decision-router call, and a
      // checkpoint is meant to be the cheap pass.
      relevantOlderNotes: [],
      recentMessages: this.recentMessages(startSeq),
      communicationPreference: this.state.communicationPreference,
    };

    const run = this.runs?.begin({
      kind: 'observation',
      sessionId: this.sessionId,
      ...(session?.projectId ? { projectId: session.projectId } : {}),
      metadata: { windowIndex: nextIndex, checkpoint: true, throughSeq: endSeq },
    });

    /*
     * No read tools, and `surface_update` kept.
     *
     * The cheap path is the point of a checkpoint, so it never investigates.
     * But a checkpoint that notices the suite failing for the third time should
     * reach the developer now rather than when the window happens to close, and
     * raising a candidate is not speaking — the policy still decides.
     */
    const collected: ContextRef[] = [];
    const pseudoWindow: TraceWindow = {
      id: input.window.windowId,
      sessionId: this.sessionId,
      index: nextIndex,
      startSeq,
      endSeq,
      eventCount: events.length,
      approxTokens: 0,
      source: events[0]!.rawRef.source || null,
      startOffset: events[0]!.rawRef.byteOffset,
      endOffset: events[events.length - 1]!.rawRef.byteOffset,
      startedAt: input.window.startedAt,
      endedAt: input.window.endedAt,
      closedBy: 'flush',
      createdAt: new Date().toISOString(),
    };

    let observation;
    try {
      observation = await this.observer.observeWindow(
        input,
        this.buildToolset(pseudoWindow, collected, false, run),
        run,
      );
    } catch (error) {
      await run?.failed(error);
      throw error;
    }
    await run?.complete();

    const durable = this.admitDurableUpdate(observation.notableChange);
    this.publishUnderstanding(
      observation.understanding ?? null,
      durable
        ? {
            // Deterministic, so re-checkpointing the same tail replaces its
            // update rather than adding a second copy of it.
            id: `checkpoint:${this.sessionId}:${endSeq}`,
            text: durable,
            at: new Date().toISOString(),
            refs: dedupeRefs([
              { kind: 'trace', sessionId: this.sessionId, startSeq, endSeq },
              ...collected,
            ]),
          }
        : null,
    );
  }

  /** Interruptible, so `stop()` is not held up by a backoff. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  private startCheckpoints(): void {
    if (this.checkpointTimer || this.checkpointMs <= 0 || this.stopped) return;
    const timer = setInterval(() => {
      void this.checkpointNow();
    }, this.checkpointMs);
    timer.unref?.();
    this.checkpointTimer = timer;
  }

  private async advanceCursor(window: TraceWindow): Promise<void> {
    this.state = {
      ...this.state,
      lastClosedWindowIndex: window.index,
      lastProcessedWindowId: window.id,
      processedThroughSeq: window.endSeq,
      updatedAt: new Date().toISOString(),
    };
    await this.store.setObservationState(this.state);
  }

  /**
   * Whether this window justifies the read tools.
   *
   * This gate is about cost, not permission: `surface_update` is available
   * either way. When no decision router is configured, the deterministic
   * fallback is the honest signal — something failed, or something is being
   * retried — which is also exactly when a human would go and look.
   */
  private async shouldExplore(
    window: TraceWindow,
    events: NormalizedEvent[],
  ): Promise<boolean> {
    const heuristic = looksUncertain(events);

    if (!this.router?.available) return heuristic;
    const run = this.beginDecisionRun('explore', window);
    try {
      const result = await this.router.noul(
        {
          instructions:
            'Does this portion of a coding agent trace contain enough novelty or unresolved uncertainty to justify looking at additional context — earlier windows, source files, command output or diffs — before describing it?',
          criteria: {
            true: 'Something is unexplained, failing, surprising, or refers to work not visible in this portion. Looking further would change the description.',
            false: 'This portion is self-explanatory routine progress. Looking further would add nothing.',
          },
          state: {
            windowIndex: window.index,
            closedBy: window.closedBy,
            heuristicSuggestsUncertainty: heuristic,
            events: events.map((event) => ({
              kind: event.kind,
              summary: event.summary,
            })),
          },
        },
        run,
      );
      await run?.complete();
      if (!result) return heuristic;
      return result.noul >= 0.5;
    } catch (error) {
      this.onError('router:noul', error);
      await run?.failed(error);
      return heuristic;
    }
  }

  /**
   * Which older windows, if any, to put back in front of the observer.
   *
   * The fallback is to supply none: the recent notes are already in context, and
   * guessing at relevance with a keyword match would be worse than admitting we
   * do not know.
   */
  private async pickRelevantOlderNotes(window: TraceWindow): Promise<WindowNote[]> {
    if (!this.router?.available) return [];

    const all = this.store.getWindowNotes(this.sessionId);
    const candidates = all.slice(0, Math.max(0, all.length - this.continuityNotes));
    if (candidates.length < 2) return [];

    // Keep the question small: the most recent handful of older windows.
    const shortlist = candidates.slice(-6);
    const criteria: Record<string, string> = { none: 'None of these is relevant.' };
    for (const note of shortlist) {
      criteria[`w${note.windowIndex}`] = truncate(note.summary, 240);
    }

    const run = this.beginDecisionRun('relevant_older_note', window);
    try {
      const result = await this.router.choose(
        {
          instructions:
            'An observer is about to interpret a new portion of a coding session. Which earlier window, if any, is most likely to be needed to understand it?',
          criteria,
          state: {
            newWindow: { index: window.index, closedBy: window.closedBy },
            recentNotes: this.store
              .getWindowNotes(this.sessionId, this.continuityNotes)
              .map((note) => truncate(note.summary, 240)),
          },
        },
        run,
      );
      await run?.complete();
      if (!result || result.choice === 'none') return [];
      const chosen = shortlist.find(
        (note) => `w${note.windowIndex}` === result.choice,
      );
      return chosen ? [chosen] : [];
    } catch (error) {
      this.onError('router:choose', error);
      await run?.failed(error);
      return [];
    }
  }

  /**
   * A decision is its own run, not part of the window's.
   *
   * These are calls to a different provider with a different question, made
   * before the observation model is asked anything. Folding them into the
   * observation run would put two providers' requests in one trace and lose
   * which of them actually answered.
   */
  private beginDecisionRun(
    purpose: string,
    window: TraceWindow,
  ): RunHandle | undefined {
    return this.runs?.begin({
      kind: 'decision',
      sessionId: this.sessionId,
      ...(this.router?.name ? { provider: this.router.name } : {}),
      metadata: { purpose, windowIndex: window.index },
    });
  }

  /**
   * Bind the tools for one window.
   *
   * `surfaceUpdate` is present unconditionally. `read` is present only when the
   * window earned it. Everything the observer looks at is recorded as a ref on
   * the resulting note, so the note can always be checked against the material
   * that produced it.
   */
  private buildToolset(
    window: TraceWindow,
    collected: ContextRef[],
    explore: boolean,
    run?: RunHandle,
  ): ObserverToolset {
    const toolset: ObserverToolset = {
      surfaceUpdate: async (input) => {
        const refs = dedupeRefs([
          {
            kind: 'trace',
            sessionId: this.sessionId,
            startSeq: window.startSeq,
            endSeq: window.endSeq,
          },
          ...(input.refs ?? [])
            .map((value) => parseRef(value))
            .filter((ref): ref is ContextRef => ref !== null),
          ...collected,
        ]);

        const update: SurfaceUpdate = {
          id: randomUUID(),
          sessionId: this.sessionId,
          windowId: window.id,
          message: input.message,
          whyNow: input.whyNow,
          refs,
          urgency: (input.urgency ?? 'normal') as SurfaceUrgency,
          createdAt: new Date().toISOString(),
        };
        await this.store.appendSurfaceUpdate(update);
        run?.toolCall({
          name: 'surface_update',
          arguments: { message: input.message, whyNow: input.whyNow },
        });
        // Notify, but do not speak. What happens next is the policy's call.
        this.onSurfaceUpdate?.(update);
        return update;
      },
    };

    if (explore) toolset.read = this.readTools(collected, run);
    return toolset;
  }

  /** The three read tools, with every ref that is touched recorded. */
  private readTools(collected: ContextRef[], run?: RunHandle): ReadOnlyToolset {
    return {
      searchContext: async (input) =>
        tracedTool(run, 'search_context', input, async () => {
          const hits = await this.navigator.searchContext({
            sessionId: this.sessionId,
            query: input.query,
            ...(input.sources ? { sources: input.sources } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          for (const hit of hits) collected.push(hit.ref);
          return hits;
        }),
      openContext: async (input) =>
        tracedTool(run, 'open_context', input, async () => {
          const result = await this.navigator.openContext({
            ref: input.ref,
            ...(input.depth ? { depth: input.depth } : {}),
          });
          if (!result.notFound) collected.push(result.ref);
          return result;
        }),
      getDiff: async (input) =>
        tracedTool(run, 'get_diff', input, async () => {
          const diff = await this.navigator.getDiff({
            sessionId: this.sessionId,
            ...(input.path ? { path: input.path } : {}),
            ...(input.around ? { around: input.around } : {}),
          });
          collected.push({
            kind: 'diff',
            sessionId: this.sessionId,
            ...(input.path ? { path: input.path } : {}),
          });
          return diff;
        }),
    };
  }

  private eventsInRange(startSeq: number, endSeq: number): NormalizedEvent[] {
    return this.store
      .getEvents(this.sessionId, { sinceSeq: startSeq - 1 })
      .filter((event) => event.seq <= endSeq);
  }

  private recentMessages(beforeSeq: number) {
    return this.store
      .getEvents(this.sessionId)
      .filter((event) => event.seq < beforeSeq && TRANSCRIPT_KINDS.has(event.kind))
      .slice(-this.continuityMessages)
      .map(toObserverEventLine);
  }
}

/**
 * The deterministic stand-in for "is anything unresolved here?".
 *
 * Failure and repetition are the two signals that reliably mean a human would
 * want to look closer, and both are visible without a model.
 */
export function looksUncertain(events: NormalizedEvent[]): boolean {
  const commands = new Map<string, number>();
  for (const event of events) {
    if (event.detail?.['failed'] === true) return true;
    if (event.kind === 'test_finished' && /fail/i.test(event.summary)) return true;
    if (event.kind === 'permission_requested' || event.kind === 'session_waiting') {
      return true;
    }
    if (event.kind === 'command_started' || event.kind === 'test_started') {
      const command = String(event.detail?.['input'] ?? event.summary);
      const seen = (commands.get(command) ?? 0) + 1;
      if (seen >= 2) return true;
      commands.set(command, seen);
    }
  }
  return false;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** How many times a window is retried before its trace is given up on. */
const MAX_TRANSIENT_ATTEMPTS = 3;

/**
 * Whether a failure was about this request rather than about this window.
 *
 * Rate limits and server faults are the two the observer actually meets, and
 * both mean "ask again shortly". Everything else — a malformed window, a
 * rejected schema, a missing credential — will fail identically on every
 * retry, so retrying it only delays the session's observation behind it.
 */
function isTransient(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return /\b(429|rate[ _-]?limit|overloaded|timeout|ETIMEDOUT|ECONNRESET)\b/i.test(
    String((error as { message?: unknown })?.message ?? error),
  );
}

/** Widening waits, so a per-minute limit is actually waited out. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** (attempt - 1));
}

/**
 * Two durable updates compared as claims rather than as strings.
 *
 * Case and punctuation carry no meaning here, and a trailing period is the
 * commonest difference between "the same thing" and "the same thing again".
 */
function normalizeUpdate(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
