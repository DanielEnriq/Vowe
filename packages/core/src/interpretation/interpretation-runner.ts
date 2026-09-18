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
  onError?: (error: unknown) => void;
}

/**
 * Drives interpretation from the live event stream.
 *
 * Debounced rather than per-event: interpretation is about what a session
 * appears to be doing, which does not change with every tool call, and an LLM
 * pass per event would be wasteful.
 */
export class InterpretationRunner {
  private readonly options: Required<Omit<InterpretationRunnerOptions, 'onError'>> & {
    onError: (error: unknown) => void;
  };
  private readonly pending = new Map<string, { count: number; timer: NodeJS.Timeout }>();
  private readonly inFlight = new Set<string>();
  private stopped = false;

  constructor(options: InterpretationRunnerOptions) {
    this.options = {
      quietMs: 15_000,
      burstEvents: 25,
      windowSize: 60,
      onError: () => undefined,
      ...options,
    };
  }

  start(): void {
    this.options.registry.on('event', (event) => {
      this.schedule(event.sessionId);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** Force an interpretation pass now, e.g. when the user opens a session. */
  async refresh(sessionId: string): Promise<void> {
    await this.run(sessionId);
  }

  private schedule(sessionId: string): void {
    if (this.stopped) return;
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
      const state = await interpreter.interpret({
        session,
        previous: session.semanticState,
        events,
      });
      await registry.applySemanticState(sessionId, state);
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}
