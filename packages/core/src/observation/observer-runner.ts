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
import type { AgentSession } from '../types/session.js';
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
  onError?: (scope: string, error: unknown) => void;
  onNote?: (note: WindowNote) => void;
  onSurfaceUpdate?: (update: SurfaceUpdate) => void;
}

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
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly onNote: ((note: WindowNote) => void) | undefined;
  private readonly onSurfaceUpdate: ((update: SurfaceUpdate) => void) | undefined;

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
    this.onError = options.onError ?? (() => undefined);
    this.onNote = options.onNote;
    this.onSurfaceUpdate = options.onSurfaceUpdate;

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
    this.ingest(false);
    if (this.draining) {
      this.moreArrived = true;
      return;
    }
    void this.drain().catch((error) => this.onError('drain', error));
  }

  stop(): void {
    this.stopped = true;
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
          } catch (error) {
            // A window that cannot be interpreted still advances the cursor:
            // retrying it forever would stall observation permanently, and the
            // trace itself is not lost — it stays addressable in L0.
            this.onError(`window:${window.index}`, error);
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
    if (observation.currentActivity) note.currentActivity = observation.currentActivity;
    if (observation.notableChange) note.notableChange = observation.notableChange;

    await this.store.appendWindowNote(note);
    await this.advanceCursor(window);
    this.onNote?.(note);
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
