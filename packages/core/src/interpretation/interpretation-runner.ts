import { workerActivity } from '../product/worker-activity.js';
import type { EventStore } from '../store/event-store.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { SemanticInterpreter } from './semantic-interpreter.js';

export interface InterpretationRunnerOptions {
  registry: SessionRegistry;
  store: EventStore;
  interpreter: SemanticInterpreter;
  /** Re-interpret once a session has been quiet this long. */
  quietMs?: number;
  /** ...or immediately once this many events have arrived unprocessed. */
  burstEvents?: number;
  /** Size of the evidence window handed to the interpreter. */
  windowSize?: number;
  /**
   * How many trailing events the fast activity pass reads.
   *
   * Long enough to see a burst whole, and no longer.
   *
   * A run of edits and a command's start and finish are both pairs of events,
   * so the tail has to hold roughly twice as many events as the burst it must
   * recognise. Twelve was too tight: six edits filled it, and the label fell
   * back from "Updating 6 files in adapter-pi" to "Making 6 file changes"
   * because the paths had already scrolled out of view. Reading sixty to
   * decide one label would be the opposite mistake, on a lane that runs for
   * every single event.
   */
  activityWindow?: number;
  onError?: (error: unknown) => void;
}

/**
 * Drives interpretation from the live event stream, at two speeds.
 *
 * The slow one is what this class always did: a debounced pass that may call a
 * model. It stays debounced because reaching an interpretation is expensive and
 * does not get better for being done per tool call.
 *
 * The fast one runs on every event, synchronously, and calls no model at all.
 * It exists because the slow pass leaves a fifteen-second hole in which the
 * product can say nothing about a worker that is plainly doing something — and
 * the trace already contains the answer. `workerActivity` derives it; this
 * publishes it. Nothing here blocks ingestion, and nothing here writes to the
 * store.
 */
export class InterpretationRunner {
  private readonly options: Required<Omit<InterpretationRunnerOptions, 'onError'>> & {
    onError: (error: unknown) => void;
  };
  private readonly pending = new Map<string, { count: number; timer: NodeJS.Timeout }>();
  private readonly inFlight = new Set<string>();
  private stopped = false;
  /** Paused sessions keep the fast, model-free lane; nothing reaches a model. */
  private paused: (sessionId: string) => boolean = () => false;

  constructor(options: InterpretationRunnerOptions) {
    this.options = {
      quietMs: 15_000,
      burstEvents: 25,
      windowSize: 60,
      activityWindow: 32,
      onError: () => undefined,
      ...options,
    };
  }

  start(): void {
    this.options.registry.on('evidence:changed', change => {
      if (change.invalidatedFromSeq !== undefined) void this.refresh(change.sessionId);
    });
    this.options.registry.on('event', (event) => {
      // Fast first, and never awaited: the event lane is ingestion, and a
      // developer watching a worker move should see it move.
      this.publishActivity(event.sessionId);
      this.schedule(event.sessionId);
    });
  }

  /**
   * Derive and publish what the worker is doing, from the trace alone.
   *
   * Deliberately total: any failure here is a label, not a session, and losing
   * ingestion over one would be absurd.
   */
  private publishActivity(sessionId: string): void {
    if (this.stopped) return;
    try {
      const { registry, store, activityWindow } = this.options;
      const events = store.getEvents(sessionId, { limit: activityWindow });
      const activity = workerActivity(events);
      if (activity && activity.id === events.at(-1)?.id) {
        registry.applyActivitySignal(sessionId, activity);
      }
    } catch (error) {
      this.options.onError(error);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /**
   * Which sessions get no model-backed interpretation. Pausing drops what was
   * scheduled for them; resuming waits for their next event rather than
   * replaying every session at once.
   */
  setPaused(paused: (sessionId: string) => boolean): void {
    this.paused = paused;
    for (const [sessionId, { timer }] of this.pending)
      if (paused(sessionId)) {
        clearTimeout(timer);
        this.pending.delete(sessionId);
      }
  }

  /** Force an interpretation pass now, e.g. when the user opens a session. */
  async refresh(sessionId: string): Promise<void> {
    await this.run(sessionId);
  }

  private schedule(sessionId: string): void {
    if (this.stopped || this.paused(sessionId)) return;
    const existing = this.pending.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const count = (existing?.count ?? 0) + 1;

    if (count >= this.options.burstEvents) {
      this.pending.delete(sessionId);
      void this.run(sessionId);
      return;
    }

    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      void this.run(sessionId);
    }, this.options.quietMs);
    timer.unref?.();
    this.pending.set(sessionId, { count, timer });
  }

  private async run(sessionId: string): Promise<void> {
    if (this.paused(sessionId)) return;
    if (this.inFlight.has(sessionId)) {
      // Coalesce: whatever arrived during the in-flight pass is picked up next.
      this.schedule(sessionId);
      return;
    }
    this.inFlight.add(sessionId);
    try {
      const { registry, store, interpreter, windowSize } = this.options;
      const session = registry.get(sessionId);
      if (!session) return;
      const events = store.getEvents(sessionId, { limit: windowSize });
      const revision = store.evidenceStatus?.(sessionId).revision ?? 0;
      const state = await interpreter.interpret({
        session,
        previous: session.semanticState,
        events,
      });
      if (revision !== (store.evidenceStatus?.(sessionId).revision ?? 0)) { this.schedule(sessionId); return; }
      await registry.applySemanticState(sessionId, state);
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}
