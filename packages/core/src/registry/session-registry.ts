import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { AgentAdapter, InstructionResult, LaunchOptions, Unsubscribe } from '../types/adapter.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession } from '../types/session.js';
import type { ProjectService } from '../projects/project-service.js';
import type { EventStore } from '../store/event-store.js';
import {
  CapabilityUnsupportedError,
  UnknownSessionError,
} from '../types/errors.js';

export interface SessionRegistryOptions {
  store: EventStore;
  /**
   * Optional. When present, each session is assigned to the repository it is
   * working in as it is discovered. Without it sessions simply have no project,
   * which the UI handles.
   */
  projects?: ProjectService;
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
  private readonly projects: ProjectService | undefined;
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
    this.projects = options.projects;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 5000;
    this.onError = options.onError ?? (() => undefined);
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  /** Every provider Vowe is currently attached to, in registration order. */
  providers(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * The providers that can actually start a new session on this machine.
   *
   * Both halves matter and they are different questions: the adapter has to
   * implement launching at all, and its CLI has to be present to do it. A
   * provider that answers no to either is simply not offered, which is why
   * nothing downstream has to name a provider to find one.
   */
  launchCapableProviders(): string[] {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.launchSession && (adapter.canLaunch?.() ?? true))
      .map((adapter) => adapter.provider);
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
   * A session has just been given its durable name.
   *
   * The cached session is refreshed here rather than waiting for the next
   * discovery pass, so the name is on screen when it is written instead of a
   * few seconds later. The database is still where it lives; this only keeps
   * the view of it honest between passes.
   */
  noteGeneratedTitle(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, generatedTitle: title });
  }

  /**
   * A session has just been put away, or brought back.
   *
   * Same bargain as the title above: the column is where this lives, and this
   * only keeps the cached view honest so the panel reacts to the click rather
   * than to the next discovery pass a few seconds later.
   */
  noteArchived(sessionId: string, archivedAt: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const { archivedAt: _was, ...rest } = session;
    this.sessions.set(sessionId, archivedAt ? { ...rest, archivedAt } : rest);
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
    if (adapter.canLaunch?.() === false) {
      throw new CapabilityUnsupportedError(
        provider,
        'launchSession',
        'this provider can start sessions, but its command-line tool was not found on this machine',
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
    // Read once. Reconciliation runs for every session every few seconds, and
    // the stored row answers two questions below.
    const stored = this.store.getSession(discovered.id);
    const previous = this.sessions.get(discovered.id) ?? stored;
    const merged: AgentSession = {
      ...discovered,
      // Semantic state is owned by the interpretation layer, not the adapter.
      semanticState: previous?.semanticState ?? stored?.semanticState ?? null,
      /*
       * The name Vowe gave this session, which no adapter knows about.
       *
       * Taken from the database rather than from the cached session, because
       * the column is where a title durably lives and this map is only a view
       * of it. Without this line the title was written and then dropped from
       * the in-memory session on the very next discovery pass, so
       * `listSessions` served the un-named copy and the sidebar showed the
       * fallback for a session that had been named. The column had the name;
       * nothing ever read it back.
       */
      ...titleOf(stored ?? previous),
      /*
       * Whether the developer has put this session away — the same story as
       * the title above, and for the same reason. No adapter knows about it,
       * the column is where it lives, and a discovery pass that did not read
       * it back would un-archive everything every few seconds.
       */
      ...archiveOf(stored ?? previous),
      createdAt: previous?.createdAt ?? discovered.createdAt,
      // Adapters do not know about projects, so carry the existing assignment
      // forward and only re-derive it when it is actually missing or stale.
      projectId: previous?.projectId ?? null,
      ...(previous?.worktree ? { worktree: previous.worktree } : {}),
      ...(previous?.branch ? { branch: previous.branch } : {}),
    };

    await this.assignProject(merged, previous ?? null);

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

  /**
   * Attach a session to the repository it is working in.
   *
   * Reconciliation runs for every session every few seconds, so the common case
   * — a known session that has not moved — must cost nothing. `needsResolution`
   * answers that with a string comparison; only a new session, or one whose
   * working directory actually changed, reaches the filesystem.
   */
  private async assignProject(
    session: AgentSession,
    previous: AgentSession | null,
  ): Promise<void> {
    if (!this.projects) return;
    if (!this.projects.needsResolution(session, previous)) return;

    try {
      const assignment = await this.projects.resolveForSession(session);
      if (!assignment) return;
      session.projectId = assignment.project.id;
      if (assignment.worktree) session.worktree = assignment.worktree;
      else delete session.worktree;
      if (assignment.branch) session.branch = assignment.branch;
      else delete session.branch;
    } catch (error) {
      // A session Vowe cannot place is still a session worth showing.
      this.onError(`project:${session.id}`, error);
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
    a.capabilities.resume !== b.capabilities.resume ||
    a.projectId !== b.projectId
  );
}

/** The durable name, where there is one. Absent rather than `undefined`. */
function titleOf(session: AgentSession | null | undefined): { generatedTitle?: string } {
  const title = session?.generatedTitle?.trim();
  return title ? { generatedTitle: title } : {};
}

function archiveOf(session: AgentSession | null | undefined): { archivedAt?: string } {
  const at = session?.archivedAt;
  return at ? { archivedAt: at } : {};
}
