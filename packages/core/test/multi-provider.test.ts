import { describe, expect, it } from 'vitest';

import { SessionRegistry } from '../src/registry/session-registry.js';
import { CapabilityUnsupportedError } from '../src/types/errors.js';
import type { AdapterEvent } from '../src/types/events.js';
import type {
  AgentAdapter,
  InstructionResult,
  LaunchOptions,
  Unsubscribe,
} from '../src/types/adapter.js';
import type { AgentSession, SessionCapabilities } from '../src/types/session.js';
import { temporaryStore } from './helpers.js';

const WORKING = '2026-02-11T09:00:00.000Z';

/**
 * A stand-in for any provider adapter.
 *
 * Nothing here imports a real one, because the claim under test belongs to the
 * seam rather than to any provider: whatever an adapter reports, the registry
 * has to keep it apart from what every other adapter reports.
 */
class FakeAdapter implements AgentAdapter {
  private readonly listeners = new Map<string, Set<(event: AdapterEvent) => void>>();

  constructor(
    readonly provider: string,
    private readonly sessionIds: string[],
    private readonly capabilities: SessionCapabilities,
    private readonly cwd: string,
    private readonly launchable = false,
  ) {
    if (launchable) {
      this.launchSession = async (options: LaunchOptions) =>
        this.session(`launched-${this.sessionIds.length}`, options.cwd);
    }
  }

  launchSession?: (options: LaunchOptions) => Promise<AgentSession>;

  async discoverSessions(): Promise<AgentSession[]> {
    return this.sessionIds.map((id) => this.session(id, this.cwd));
  }

  async getSession(providerSessionId: string): Promise<AgentSession | null> {
    if (!this.sessionIds.includes(providerSessionId)) return null;
    return this.session(providerSessionId, this.cwd);
  }

  subscribeToEvents(
    providerSessionId: string,
    onEvent: (event: AdapterEvent) => void,
  ): Unsubscribe {
    let set = this.listeners.get(providerSessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(providerSessionId, set);
    }
    set.add(onEvent);
    return () => set?.delete(onEvent);
  }

  async sendInstruction(providerSessionId: string): Promise<InstructionResult> {
    if (!this.capabilities.sendInstruction) {
      throw new CapabilityUnsupportedError(
        `${this.provider}:${providerSessionId}`,
        'sendInstruction',
        'this fake provider only watches',
      );
    }
    return { delivered: true, via: 'fake' };
  }

  /** Push one event, as the real adapters do from their file readers. */
  emit(providerSessionId: string, summary: string): void {
    const event: AdapterEvent = {
      sessionId: `${this.provider}:${providerSessionId}`,
      at: WORKING,
      kind: 'agent_message',
      summary,
      detail: { text: summary },
      raw: { provider: this.provider, summary },
      rawRef: { source: `${this.provider}.jsonl`, byteOffset: 0, line: 1 },
    };
    for (const listener of this.listeners.get(providerSessionId) ?? []) listener(event);
  }

  private session(providerSessionId: string, cwd: string): AgentSession {
    return {
      id: `${this.provider}:${providerSessionId}`,
      provider: this.provider,
      providerSessionId,
      attachMode: 'external-idle',
      task: `${this.provider} work`,
      displayLabel: `${this.provider} ${providerSessionId}`,
      cwd,
      projectId: null,
      status: 'working',
      createdAt: WORKING,
      lastActivityAt: WORKING,
      capabilities: this.capabilities,
      semanticState: null,
    };
  }
}

const FULL: SessionCapabilities = {
  observe: true,
  sendInstruction: true,
  interrupt: true,
  resume: true,
  launch: true,
  reasoning: true,
};

const WATCH_ONLY: SessionCapabilities = {
  observe: true,
  sendInstruction: false,
  interrupt: false,
  resume: false,
  launch: false,
  reasoning: false,
};

/** Three providers in one repository, two of them sharing a session id. */
async function registryWithThreeProviders() {
  const fixture = await temporaryStore();
  const registry = new SessionRegistry({ store: fixture.store });

  // The same provider-side id on two providers. Nothing stops a provider
  // choosing an id another provider already used, so the seam has to.
  const claude = new FakeAdapter('claude-code', ['shared-id'], FULL, '/repo');
  const pi = new FakeAdapter('pi', ['shared-id', 'second'], FULL, '/repo', true);
  const codex = new FakeAdapter('codex', ['codex-1'], WATCH_ONLY, '/repo');

  registry.registerAdapter(claude);
  registry.registerAdapter(pi);
  registry.registerAdapter(codex);
  await registry.start();

  return { fixture, registry, claude, pi, codex };
}

describe('sessions from several providers in one repository', () => {
  it('keeps two providers that chose the same session id apart', async () => {
    const { fixture, registry } = await registryWithThreeProviders();

    const ids = registry.list().map((session) => session.id).sort();
    expect(ids).toEqual([
      'claude-code:shared-id',
      'codex:codex-1',
      'pi:second',
      'pi:shared-id',
    ]);

    // Same provider-side id, same repository, two different sessions.
    expect(registry.get('claude-code:shared-id')?.provider).toBe('claude-code');
    expect(registry.get('pi:shared-id')?.provider).toBe('pi');

    await registry.stop();
    await fixture.cleanup();
  });

  it('never lets one provider’s events reach another’s session', async () => {
    const { fixture, registry, claude, pi } = await registryWithThreeProviders();

    claude.emit('shared-id', 'claude said this');
    pi.emit('shared-id', 'pi said this');
    pi.emit('second', 'a different pi session');

    const claudeEvents = fixture.store.getEvents('claude-code:shared-id');
    const piEvents = fixture.store.getEvents('pi:shared-id');
    const otherPi = fixture.store.getEvents('pi:second');

    expect(claudeEvents.map((event) => event.summary)).toEqual(['claude said this']);
    expect(piEvents.map((event) => event.summary)).toEqual(['pi said this']);
    expect(otherPi.map((event) => event.summary)).toEqual(['a different pi session']);

    // Each session numbers its own events from the start.
    expect(claudeEvents[0]?.seq).toBe(1);
    expect(piEvents[0]?.seq).toBe(1);

    await registry.stop();
    await fixture.cleanup();
  });

  it('keeps each event pointing back at its own provider’s record', async () => {
    const { fixture, registry, claude, codex } = await registryWithThreeProviders();

    claude.emit('shared-id', 'from claude');
    codex.emit('codex-1', 'from codex');

    expect(fixture.store.getEvents('claude-code:shared-id')[0]?.rawRef.source).toBe(
      'claude-code.jsonl',
    );
    expect(fixture.store.getEvents('codex:codex-1')[0]?.raw).toMatchObject({
      provider: 'codex',
    });

    await registry.stop();
    await fixture.cleanup();
  });

  /**
   * The honesty requirement, at the seam rather than in the UI: a provider
   * that cannot be written to must refuse rather than quietly do nothing, and
   * a provider that cannot start sessions must not appear where one is chosen.
   */
  it('reports only the providers that can actually do the thing asked', async () => {
    const { fixture, registry } = await registryWithThreeProviders();

    expect(registry.providers()).toEqual(['claude-code', 'pi', 'codex']);
    expect(registry.launchCapableProviders()).toEqual(['pi']);

    await expect(
      registry.sendInstruction('codex:codex-1', 'do something'),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);

    await expect(
      registry.launchSession('codex', { cwd: '/repo', prompt: 'go' }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);

    await registry.stop();
    await fixture.cleanup();
  });
});
