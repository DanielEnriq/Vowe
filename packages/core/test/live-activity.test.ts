import { afterEach, describe, expect, it } from 'vitest';

import { HeuristicInterpreter } from '../src/interpretation/heuristic-interpreter.js';
import { InterpretationRunner } from '../src/interpretation/interpretation-runner.js';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { AdapterEvent } from '../src/types/events.js';
import type {
  AgentAdapter,
  InstructionResult,
  Unsubscribe,
} from '../src/types/adapter.js';
import type { AgentSession } from '../src/types/session.js';
import { temporaryStore } from './helpers.js';

const AT = '2026-02-11T09:00:00.000Z';
const SESSION = 'fake:one';

/**
 * A provider that emits whatever a test hands it.
 *
 * Each event gets its own byte offset because the store dedupes on the
 * physical address — two events at offset zero are the same record read twice,
 * which is a property worth keeping rather than working around.
 */
class FakeAdapter implements AgentAdapter {
  readonly provider = 'fake';
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private offset = 0;

  async discoverSessions(): Promise<AgentSession[]> {
    return [this.session()];
  }

  async getSession(): Promise<AgentSession | null> {
    return this.session();
  }

  subscribeToEvents(
    _providerSessionId: string,
    onEvent: (event: AdapterEvent) => void,
  ): Unsubscribe {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  async sendInstruction(): Promise<InstructionResult> {
    throw new Error('not used here');
  }

  emit(event: Omit<AdapterEvent, 'sessionId' | 'at' | 'raw' | 'rawRef'>): void {
    const byteOffset = this.offset;
    this.offset += 120;
    const full: AdapterEvent = {
      ...event,
      sessionId: SESSION,
      at: AT,
      raw: event,
      rawRef: { source: 'fake.jsonl', byteOffset, line: byteOffset / 120 + 1 },
    };
    for (const listener of this.listeners) listener(full);
  }

  private session(): AgentSession {
    return {
      id: SESSION,
      provider: 'fake',
      providerSessionId: 'one',
      attachMode: 'external-live',
      task: 'make pi ingestion work',
      displayLabel: 'fake one',
      cwd: '/repo',
      projectId: null,
      status: 'working',
      createdAt: AT,
      lastActivityAt: AT,
      capabilities: {
        observe: true,
        sendInstruction: false,
        interrupt: false,
        resume: false,
        launch: false,
        reasoning: false,
      },
      semanticState: null,
    };
  }
}

/**
 * One event, and the ingest it triggers, settled.
 *
 * Ingestion is asynchronous — an event is appended before it is announced — so
 * a test that fired three in one tick would be asserting on a burst rather than
 * on three transitions. A worker emits as it works; this waits the same way.
 */
async function emit(
  adapter: FakeAdapter,
  event: Omit<AdapterEvent, 'sessionId' | 'at' | 'raw' | 'rawRef'>,
): Promise<void> {
  adapter.emit(event);
  await new Promise((resolve) => setImmediate(resolve));
}

let teardown: (() => Promise<void>) | null = null;
afterEach(async () => {
  await teardown?.();
  teardown = null;
});

async function harness() {
  const fixture = await temporaryStore();
  const registry = new SessionRegistry({ store: fixture.store });
  const adapter = new FakeAdapter();
  registry.registerAdapter(adapter);
  await registry.start();

  const runner = new InterpretationRunner({
    registry,
    store: fixture.store,
    interpreter: new HeuristicInterpreter(),
    // Long enough that the debounced pass never fires during a test: what is
    // under test here is the fast lane in front of it.
    quietMs: 600_000,
    burstEvents: 10_000,
  });
  runner.start();

  const labels: string[] = [];
  registry.on('session:updated', (session) => {
    const activity = session.semanticState?.currentActivity;
    if (activity && labels[labels.length - 1] !== activity) labels.push(activity);
  });

  teardown = async () => {
    runner.stop();
    await registry.stop();
    await fixture.cleanup();
  };

  return { ...fixture, registry, adapter, labels };
}

describe('live activity — the fast lane', () => {
  it('publishes a specific label as each event arrives', async () => {
    const { adapter, labels, registry } = await harness();

    await emit(adapter, { kind: 'tool_started', summary: 'Read session-registry.ts' });
    await emit(adapter, {
      kind: 'file_changed',
      summary: 'Edited normalize.ts',
      detail: { input: { file_path: 'packages/adapter-pi/src/normalize.ts' } },
    });
    await emit(adapter, {
      kind: 'test_started',
      summary: 'Running tests: pnpm exec vitest run packages/adapter-pi/test/normalize.test.ts',
      detail: {
        input: { command: 'pnpm exec vitest run packages/adapter-pi/test/normalize.test.ts' },
      },
    });

    // Three events, three transitions, no model and no waiting for a debounce.
    expect(labels).toEqual([
      'Reading session-registry.ts',
      'Updating normalize.ts in adapter-pi',
      'Running normalize tests',
    ]);
    expect(registry.get(SESSION)?.semanticState?.phase).toBe('testing');
  });

  it('says nothing rather than something generic', async () => {
    const { adapter, labels } = await harness();

    await emit(adapter, { kind: 'tool_started', summary: 'Read session-registry.ts' });
    await emit(adapter, { kind: 'tool_started', summary: 'Used WebFetch' });
    await emit(adapter, { kind: 'tool_finished', summary: 'WebFetch finished' });

    // The line held rather than degrading to a placeholder.
    expect(labels).toEqual(['Reading session-registry.ts']);
  });

  it('writes no semantic history, because nobody reads an activity log', async () => {
    const { adapter, store } = await harness();

    for (let i = 0; i < 12; i++) {
      adapter.emit({
        kind: 'file_changed',
        summary: `Edited file-${i}.ts`,
        detail: { input: { file_path: `packages/core/src/file-${i}.ts` } },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));

    // A row per tool call would be a great many writes to record something
    // nothing ever reads back.
    expect(store.getSemanticHistory(SESSION)).toEqual([]);
    expect(store.getEvents(SESSION)).toHaveLength(12);
  });

  it('seeds a state for a session that has never been interpreted', async () => {
    const { adapter, registry } = await harness();
    expect(registry.get(SESSION)?.semanticState).toBeNull();

    await emit(adapter, { kind: 'tool_started', summary: 'Searched for applySemanticState' });

    const state = registry.get(SESSION)!.semanticState!;
    expect(state.currentActivity).toBe('Searching for applySemanticState');
    // Seeded, not invented: nothing claims an understanding it does not have.
    expect(state.currentUnderstanding).toBeNull();
    expect(state.meaningfulUpdates).toEqual([]);
  });

  it('does not let a delayed semantic pass erase newer activity or observer understanding', async () => {
    const { adapter, registry, store } = await harness();
    await emit(adapter, { kind: 'tool_started', summary: 'Read session-registry.ts' });
    const stale = { ...registry.get(SESSION)!.semanticState!, provenance: { eventIds: [], throughSeq: 1 } };
    await emit(adapter, { kind: 'file_changed', summary: 'Edited observer-state.ts', detail: { input: { file_path: 'packages/core/src/product/observer-state.ts' } } });
    const update = { id: 'observer-update', text: 'The pipelines now share settled understanding.', at: '2026-09-24T12:00:00Z', refs: [] };
    await registry.applyObserverState(SESSION, { understanding: 'Both pipelines publish into session state.', durableUpdate: update });
    await registry.applySemanticState(SESSION, stale);
    const state = registry.get(SESSION)!.semanticState!;
    expect(state.currentActivity).toBe('Updating observer-state.ts in core');
    expect(state.currentUnderstanding).toBe('Both pipelines publish into session state.');
    expect(state.meaningfulUpdates).toEqual([update]);
    expect(state.lastMeaningfulUpdate).toBe(update.at);
    expect(store.getSession(SESSION)!.semanticState).toEqual(state);
  });
});
