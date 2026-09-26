import { EventEmitter } from 'node:events';

import type { CommunicationPolicy } from '../communication/communication-policy.js';
import {
  effectivePreference,
  type TemperamentProfile,
} from '../product/temperament.js';
import type { ContextNavigator } from '../context/context-navigator.js';
import type { DecisionRouter } from '../decision/decision-router.js';
import type { VoweRunRecorder } from '../execution/run-recorder.js';
import type { ObservationLlm } from '../llm/observation-llm.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { EventStore } from '../store/event-store.js';
import { ObserverRunner } from './observer-runner.js';
import type {
  CommunicationDecision,
  ObservationState,
  SurfaceUpdate,
  WindowNote,
  WindowPolicy,
} from './trace-window.js';

export interface ObservationServiceOptions {
  store: EventStore;
  registry: SessionRegistry;
  observer: ObservationLlm;
  navigator: ContextNavigator;
  policy: CommunicationPolicy;
  router?: DecisionRouter;
  windowPolicy?: Partial<WindowPolicy>;
  /** How often a live checkpoint may refresh understanding. 0 disables it. */
  checkpointMs?: number;
  /** Passed straight through to every runner this service owns. */
  runs?: VoweRunRecorder;
  /**
   * The developer's temperament, read at each decision.
   *
   * Read per candidate rather than held, because someone who moves the
   * interruption dial means it about the next thing Vowe considers saying, not
   * the next time the app starts.
   */
  temperament?: () => TemperamentProfile | undefined;
  onError?: (scope: string, error: unknown) => void;
}

export type ObservationEvents = {
  note: [WindowNote];
  /** A candidate plus the decision made about it. Emitting is not speaking. */
  surface: [SurfaceUpdate, CommunicationDecision];
  status: [string];
};

export interface ObservationStatus {
  sessionId: string;
  observing: boolean;
  /** True while recorded trace is still being worked through. */
  catchingUp: boolean;
  windowsProcessed: number;
  communicationPreference: string | null;
}

/**
 * Owns one `ObserverRunner` per session under observation.
 *
 * Observation is explicit for now: a session is followed because someone asked
 * for it to be, not because it exists. That keeps the cost of having many
 * discovered sessions at zero and makes "what is Vowe currently watching?" a
 * question with an answer.
 *
 * This service is also where a raised candidate meets the communication policy.
 * The observer produces candidates and knows nothing about preferences; the
 * bridge speaks and knows nothing about why; this is the join.
 */
export class ObservationService extends EventEmitter<ObservationEvents> {
  private readonly options: ObservationServiceOptions;
  private readonly runners = new Map<string, ObserverRunner>();
  private readonly onError: (scope: string, error: unknown) => void;
  private listening = false;
  /** Sessions followed while paused: they resume with observation. */
  private readonly held = new Set<string>();
  private paused: (sessionId: string) => boolean = () => false;

  constructor(options: ObservationServiceOptions) {
    super();
    this.options = options;
    this.onError = options.onError ?? (() => undefined);
  }

  observedSessionIds(): string[] {
    return [...this.runners.keys()];
  }

  isObserving(sessionId: string): boolean {
    return this.runners.has(sessionId);
  }

  /**
   * Begin following a session.
   *
   * Historical trace is processed from the stored cursor — from the beginning
   * the first time, from wherever observation got to on every subsequent run.
   * Reaching the head is not a separate mode; it is just the point at which
   * there is nothing left in the queue.
   */
  async start(sessionId: string): Promise<ObservationStatus> {
    if (this.paused(sessionId)) {
      this.held.add(sessionId);
      return this.status(sessionId);
    }
    this.ensureListening();

    let runner = this.runners.get(sessionId);
    if (!runner) {
      runner = new ObserverRunner({
        sessionId,
        store: this.options.store,
        observer: this.options.observer,
        navigator: this.options.navigator,
        getSession: (id) => this.options.registry.get(id),
        onError: (scope, error) => this.onError(`observer:${sessionId}:${scope}`, error),
        onNote: (note) => this.emit('note', note),
        /*
         * The join between the two pipelines.
         *
         * Observation produces notes and holds no session; the registry holds
         * sessions and knows nothing about windows. This service already has
         * both, so this is where a note becomes something the product can
         * show, and it is the only place that wiring exists.
         */
        onUnderstanding: (understanding) => {
          void this.options.registry
            .applyObserverState(understanding.sessionId, {
              understanding: understanding.understanding,
              durableUpdate: understanding.durableUpdate,
            })
            .catch((error) => this.onError(`understanding:${sessionId}`, error));
        },
        onSurfaceUpdate: (update) => {
          void this.decide(update).catch((error) =>
            this.onError(`policy:${sessionId}`, error),
          );
        },
        ...(this.options.router ? { router: this.options.router } : {}),
        ...(this.options.windowPolicy ? { policy: this.options.windowPolicy } : {}),
        ...(this.options.checkpointMs !== undefined
          ? { checkpointMs: this.options.checkpointMs }
          : {}),
        ...(this.options.runs ? { runs: this.options.runs } : {}),
      });
      this.runners.set(sessionId, runner);
    }

    // Deliberately not awaited: catching up on a long session can take a while,
    // and the caller wants to know observation started, not that it finished.
    void runner
      .catchUp()
      .catch((error) => this.onError(`catchUp:${sessionId}`, error));

    return this.status(sessionId);
  }

  /**
   * Which sessions are paused. Their observers stop, remembered as followed;
   * observation resumes from each session's stored cursor, so nothing
   * recorded meanwhile is skipped, only understood later.
   */
  async setPaused(paused: (sessionId: string) => boolean): Promise<void> {
    this.paused = paused;
    for (const [sessionId, runner] of this.runners)
      if (paused(sessionId)) {
        runner.stop();
        this.runners.delete(sessionId);
        this.held.add(sessionId);
      }
    for (const sessionId of [...this.held])
      if (!paused(sessionId)) {
        this.held.delete(sessionId);
        await this.start(sessionId);
      }
  }

  stop(sessionId: string): void {
    this.held.delete(sessionId);
    this.runners.get(sessionId)?.stop();
    this.runners.delete(sessionId);
  }

  stopAll(): void {
    for (const runner of this.runners.values()) runner.stop();
    this.runners.clear();
  }

  status(sessionId: string): ObservationStatus {
    const runner = this.runners.get(sessionId);
    const state: ObservationState | null =
      runner?.observationState ?? this.options.store.getObservationState(sessionId);
    return {
      sessionId,
      observing: runner !== undefined,
      catchingUp: runner?.catchingUp ?? false,
      windowsProcessed: (state?.lastClosedWindowIndex ?? -1) + 1,
      communicationPreference: state?.communicationPreference ?? null,
    };
  }

  async setCommunicationPreference(
    sessionId: string,
    preference: string | null,
  ): Promise<void> {
    const runner = this.runners.get(sessionId);
    if (runner) {
      await runner.setCommunicationPreference(preference);
      return;
    }
    // A preference can be set before observation starts; keep it anyway.
    const existing =
      this.options.store.getObservationState(sessionId) ??
      ({
        sessionId,
        lastClosedWindowIndex: -1,
        lastProcessedWindowId: null,
        processedThroughSeq: 0,
        communicationPreference: null,
        updatedAt: new Date(0).toISOString(),
      } satisfies ObservationState);
    await this.options.store.setObservationState({
      ...existing,
      communicationPreference: preference,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Record that an approved candidate actually reached the developer.
   *
   * Separate from the decision: a decision to speak is not the same as having
   * spoken, and only the delivery side knows which actually happened.
   */
  async markSurfaceDelivered(
    sessionId: string,
    surfaceUpdateId: string,
  ): Promise<void> {
    await this.options.store.markSurfaceUpdateDelivered(sessionId, surfaceUpdateId);
  }

  /** Process everything recorded so far, including the open tail. For replay. */
  async catchUpNow(sessionId: string): Promise<void> {
    await this.runners.get(sessionId)?.catchUp({ closeTail: true });
  }

  /**
   * Refresh understanding from the open tail now, without closing a window.
   *
   * The timer inside the runner is what drives this in production. This is for
   * the caller that wants the answer immediately — a test, a replay, or a
   * developer opening a session that has been quiet since its last window.
   */
  async checkpointNow(sessionId: string): Promise<void> {
    await this.runners.get(sessionId)?.checkpointNow();
  }

  // ----------------------------------------------------------------- private

  private ensureListening(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.registry.on('evidence:changed', change => {
      if (change.invalidatedFromSeq === undefined || !this.runners.has(change.sessionId)) return;
      this.stop(change.sessionId);
      void this.start(change.sessionId).catch(error => this.onError('recompute',error));
    });
    this.options.registry.on('event', (event) => {
      // Cheap and synchronous: nudge the runner, never block ingestion.
      this.runners.get(event.sessionId)?.notifyTrace();
    });
  }

  private async decide(update: SurfaceUpdate): Promise<void> {
    const temperament = this.options.temperament?.();
    /**
     * One preference, from two places. What the developer said about *this*
     * session wins; the global personal instruction is what applies when they
     * have not said anything about it.
     */
    const sessionPreference =
      this.runners.get(update.sessionId)?.communicationPreference ?? null;
    const preference = temperament
      ? effectivePreference(temperament, sessionPreference)
      : sessionPreference;
    const decision = await this.options.policy.evaluate(update, preference, temperament);
    // A correction can arrive while policy is deciding. Historical candidates
    // remain stored, but cannot become a fresh notification.
    if(!this.options.store.getSurfaceUpdates(update.sessionId).some(candidate=>candidate.id===update.id)) return;
    const stored = await this.options.store.recordCommunicationDecision(
      update.sessionId,
      update.id,
      decision,
    );
    this.emit('surface', stored ?? { ...update, decision }, decision);
  }
}
