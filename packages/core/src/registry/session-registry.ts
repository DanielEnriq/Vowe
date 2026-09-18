import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { AgentAdapter, InstructionResult, LaunchOptions, Unsubscribe } from '../types/adapter.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession } from '../types/session.js';
import type { EventStore } from '../store/event-store.js';
import {
  CapabilityUnsupportedError,
  UnknownSessionError,
} from '../types/errors.js';

export interface SessionRegistryOptions {
  store: EventStore;
  /** How often to reconcile the adapter view with ours. */
  reconcileIntervalMs?: number;
  onError?: (scope: string, error: unknown) => void;
}

export type SessionRegistryEvents = {
  'session:added': [AgentSession];
  'session:updated': [AgentSession];
  'session:removed': [AgentSession];
  event: [NormalizedEvent];
};

/**
 * The runtime view of every session Vowe currently knows about.
 *
 * Sessions enter and leave dynamically. The registry assumes nothing about how
 * many exist, which providers they come from, or whether they were started by
 * us. It is the only place adapters are held, which is what keeps the
 * companion layer structurally unable to reach a worker.
 */
export class SessionRegistry extends EventEmitter<SessionRegistryEvents> {
  private readonly store: EventStore;
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly subscriptions = new Map<string, Unsubscribe>();
  private readonly reconcileIntervalMs: number;
  private readonly onError: (scope: string, error: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;

  constructor(options: SessionRegistryOptions) {
    super();
    this.store = options.store;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5000;
    this.onError = options.onError ?? (() => undefined);
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  /** Rehydrate previously known sessions, then begin discovering. */
  async start(): Promise<void> {
    for (const stored of this.store.listSessions()) {
      // Nothing is live until an adapter says so.
      this.sessions.set(stored.id, { ...stored, status: 'unknown' });
    }
    await this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile();
    }, this.reconcileIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.dispose?.();
      } catch (error) {
        this.onError(`dispose:${adapter.provider}`, error);
      }
    }
  }

  list(): AgentSession[] {
    return [...this.sessions.values()].sort(
      (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
    );
  }

  get(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Ask every adapter what it can see and fold the answer in. Sessions that
   * disappear are marked finished rather than deleted: their observed history
   * stays meaningful after the worker is gone.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const seen = new Set<string>();
      for (const adapter of this.adapters.values()) {
        let discovered: AgentSession[];
        try {
          discovered = await adapter.discoverSessions();
        } catch (error) {
          this.onError(`discover:${adapter.provider}`, error);
          continue;
        }
        for (const session of discovered) {
          seen.add(session.id);
          await this.absorb(session);
        }
      }

      for (const session of this.sessions.values()) {
        if (seen.has(session.id)) continue;
        if (!this.adapters.has(session.provider)) continue;
        if (session.status === 'finished') continue;
        const next: AgentSession = {
          ...session,
          status: 'finished',
          capabilities: { ...session.capabilities, sendInstruction: false, interrupt: false },
        };
        this.sessions.set(next.id, next);
        await this.store.upsertSession(next);
        this.emit('session:updated', next);
      }
    } finally {
      this.reconciling = false;
    }
  }

  // --------------------------------------------------------- control channel

  /**
   * Deliver an instruction to the real worker.
   *
   * Capabilities are re-checked here rather than trusted from the last
   * discovery pass, because a session can change attach mode at any moment.
   */
  async sendInstruction(
    sessionId: string,
    text: string,
  ): Promise<InstructionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSessionError(sessionId);
    const adapter = this.requireAdapter(session.provider);

    const fresh = await adapter.getSession(session.providerSessionId);
    if (fresh) await this.absorb(fresh);
    const current = this.sessions.get(sessionId) ?? session;

    if (!current.capabilities.sendInstruction) {
      throw new CapabilityUnsupportedError(
        sessionId,
        'sendInstruction',
        describeWhyNoControl(current),
      );
    }

    await this.store.appendConversationEntry({
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      role: 'user_instruction',
      text,
    });

    const result = await adapter.sendInstruction(
      current.providerSessionId,
      text,
    );

    await this.store.appendConversationEntry({
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      role: 'instruction_result',
      text: result.delivered
        ? `Delivered to the agent via ${result.via}.${result.note ? ` ${result.note}` : ''}`
        : `Not delivered.${result.note ? ` ${result.note}` : ''}`,
    });

    return result;
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new UnknownSessionError(sessionId);
    const adapter = this.requireAdapter(session.provider);
    if (!session.capabilities.interrupt || !adapter.interrupt) {
      throw new CapabilityUnsupportedError(
        sessionId,
        'interrupt',
        describeWhyNoControl(session),
      );
    }
    await adapter.interrupt(session.providerSessionId);
  }

  async launchSession(
    provider: string,
    options: LaunchOptions,
  ): Promise<AgentSession> {
    const adapter = this.requireAdapter(provider);
    if (!adapter.launchSession) {
      throw new CapabilityUnsupportedError(
        provider,
        'launchSession',
        'this provider cannot start sessions',
      );
    }
    const session = await adapter.launchSession(options);
    await this.absorb(session);
    return this.sessions.get(session.id) ?? session;
  }

  // ----------------------------------------------------------------- private

  private requireAdapter(provider: string): AgentAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new UnknownSessionError(`provider:${provider}`);
    return adapter;
  }

  /** Merge one discovered session into our view and keep watching it. */
  private async absorb(discovered: AgentSession): Promise<void> {
    const previous = this.sessions.get(discovered.id);
    const merged: AgentSession = {
      ...discovered,
      // Semantic state is owned by the interpretation layer, not the adapter.
      semanticState:
        previous?.semanticState ??
        this.store.getSession(discovered.id)?.semanticState ??
        null,
      createdAt: previous?.createdAt ?? discovered.createdAt,
    };

    this.sessions.set(merged.id, merged);
    await this.store.upsertSession(merged);

    if (!previous) {
      this.subscribe(merged);
      this.emit('session:added', merged);
      return;
    }
    if (!this.subscriptions.has(merged.id) && merged.capabilities.observe) {
      this.subscribe(merged);
    }
    if (hasVisibleChange(previous, merged)) {
      this.emit('session:updated', merged);
    }
  }

  private subscribe(session: AgentSession): void {
    if (!session.capabilities.observe) return;
    const adapter = this.adapters.get(session.provider);
    if (!adapter) return;

    const unsubscribe = adapter.subscribeToEvents(
      session.providerSessionId,
      (event) => {
        void this.ingest(session.id, event).catch((error) =>
          this.onError(`ingest:${session.id}`, error),
        );
      },
    );
    this.subscriptions.set(session.id, unsubscribe);
  }

  private async ingest(
    sessionId: string,
    event: Parameters<Parameters<AgentAdapter['subscribeToEvents']>[1]>[0],
  ): Promise<void> {
    const stored = await this.store.appendEvent(sessionId, event);
    if (!stored) return; // Already recorded; restart replay is safe.

    const session = this.sessions.get(sessionId);
    if (session && Date.parse(event.at) > Date.parse(session.lastActivityAt)) {
      const next = { ...session, lastActivityAt: event.at };
      this.sessions.set(sessionId, next);
    }
    this.emit('event', stored);
  }

  /** Update a session's semantic state from outside the adapter path. */
  async applySemanticState(
    sessionId: string,
    state: AgentSession['semanticState'],
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !state) return;
    const next: AgentSession = { ...session, semanticState: state };
    this.sessions.set(sessionId, next);
    await this.store.appendSemanticState(sessionId, state);
    this.emit('session:updated', next);
  }
}

function describeWhyNoControl(session: AgentSession): string {
  switch (session.attachMode) {
    case 'external-live':
      return 'it is running in a process Vowe does not own, and this provider offers no public way to message a live foreign session';
    case 'external-idle':
      return 'the provider reported no way to resume this session';
    default:
      return 'the session is no longer controllable';
  }
}

function hasVisibleChange(a: AgentSession, b: AgentSession): boolean {
  return (
    a.status !== b.status ||
    a.task !== b.task ||
    a.displayLabel !== b.displayLabel ||
    a.attachMode !== b.attachMode ||
    a.lastActivityAt !== b.lastActivityAt ||
    a.capabilities.sendInstruction !== b.capabilities.sendInstruction ||
    a.capabilities.interrupt !== b.capabilities.interrupt ||
    a.capabilities.observe !== b.capabilities.observe ||
    a.capabilities.resume !== b.capabilities.resume
  );
}
