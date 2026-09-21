import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { CompanionService } from '../src/companion/companion-service.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import { ProjectService } from '../src/projects/project-service.js';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { ConversationChange } from '../src/store/event-store.js';
import type { AgentAdapter } from '../src/types/adapter.js';
import type { AgentSession } from '../src/types/session.js';
import type { ObservationLlm } from '../src/llm/observation-llm.js';
import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

const OTHER_SESSION = 'claude-code:other';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** An investigator that answers without looking anything up. */
function quiet(): ObservationLlm {
  return {
    async observeWindow() {
      return { summary: 'not used here' };
    },
    async investigate() {
      return { spokenAnswer: 'short', fullAnswer: 'the full answer', refs: [] };
    },
  };
}

function entry(sessionId: string, text: string) {
  return {
    id: randomUUID(),
    sessionId,
    at: new Date().toISOString(),
    role: 'system_note' as const,
    text,
  };
}

describe('onConversationChanged — the renderer is told, not left to poll', () => {
  it('fires for the session that changed, and for no other', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await store.upsertSession(testSession({ id: OTHER_SESSION }));

    const changes: ConversationChange[] = [];
    store.onConversationChanged((change) => changes.push(change));

    await store.appendConversationEntry(entry(TEST_SESSION, 'one'));
    await store.appendConversationEntry(entry(OTHER_SESSION, 'two'));

    expect(changes).toEqual([
      { sessionId: TEST_SESSION },
      { sessionId: OTHER_SESSION },
    ]);
  });

  it('fires late enough that a listener can simply re-read', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const seen: number[] = [];
    store.onConversationChanged((change) => {
      seen.push(store.getConversation(change.sessionId).length);
    });

    await store.appendConversationEntry(entry(TEST_SESSION, 'one'));
    await store.appendConversationEntry(entry(TEST_SESSION, 'two'));

    // The entry it was told about is already there — no ordering to get wrong
    // in the renderer.
    expect(seen).toEqual([1, 2]);
  });

  it('stops when unsubscribed', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const changes: ConversationChange[] = [];
    const off = store.onConversationChanged((change) => changes.push(change));

    await store.appendConversationEntry(entry(TEST_SESSION, 'one'));
    off();
    await store.appendConversationEntry(entry(TEST_SESSION, 'two'));

    expect(changes).toHaveLength(1);
  });

  it('cannot let a listener break the write, and does not hide it either', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const failures: string[] = [];
    // The same directory, with the store's error convention wired up.
    const store = new SqliteEventStore(fixture.root, {
      onError: (scope) => failures.push(scope),
    });
    await store.init();
    await store.upsertSession(testSession());

    const after: string[] = [];
    store.onConversationChanged(() => {
      throw new Error('the renderer went away');
    });
    store.onConversationChanged((change) => after.push(change.sessionId));

    await expect(
      store.appendConversationEntry(entry(TEST_SESSION, 'one')),
    ).resolves.not.toBeNull();

    // The other listener still ran, the entry is durable, and the failure was
    // reported rather than swallowed.
    expect(after).toEqual([TEST_SESSION]);
    expect(failures).toEqual(['conversation-listener']);

    const restarted = new SqliteEventStore(fixture.root);
    await restarted.init();
    expect(restarted.getConversation(TEST_SESSION)).toHaveLength(1);

    // Both handles were opened by hand here, so both are closed by hand.
    await restarted.close();
    await store.close();
  });

  it('says nothing when a restart merely replays what was already there', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());
    await store.appendConversationEntry(entry(TEST_SESSION, 'one'));

    const restarted = await reopen();
    const changes: ConversationChange[] = [];
    restarted.onConversationChanged((change) => changes.push(change));

    expect(restarted.getConversation(TEST_SESSION)).toHaveLength(1);
    expect(changes).toEqual([]);
  });

  it('fires twice for a typed question and its answer', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const changes: ConversationChange[] = [];
    store.onConversationChanged((change) => changes.push(change));

    const delegated = new DelegatedQuestionRunner({
      store,
      navigator: new ContextNavigator({ store }),
      investigator: quiet(),
    });
    await new CompanionService({ store, delegated }).ask(TEST_SESSION, 'What is it doing?');

    expect(changes).toEqual([
      { sessionId: TEST_SESSION },
      { sessionId: TEST_SESSION },
    ]);
  });

  it('fires for an answer delegated from a spoken conversation', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const changes: ConversationChange[] = [];
    store.onConversationChanged((change) => changes.push(change));

    // Exactly the call the live bridge makes: same runner, same persistence.
    const delegated = new DelegatedQuestionRunner({
      store,
      navigator: new ContextNavigator({ store }),
      investigator: quiet(),
    });
    await delegated.answer({
      sessionId: TEST_SESSION,
      question: 'What is it doing?',
      liveConversation: [{ speaker: 'user', text: 'what is it doing?' }],
    });

    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.sessionId === TEST_SESSION)).toBe(true);
  });

  it('fires for an instruction and its result, which notified nothing before', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;

    const controllable: AgentSession = testSession({
      attachMode: 'managed',
      capabilities: {
        observe: true,
        sendInstruction: true,
        interrupt: false,
        resume: false,
      },
    });
    const adapter: AgentAdapter = {
      provider: 'claude-code',
      async discoverSessions() {
        return [{ ...controllable }];
      },
      async getSession() {
        return { ...controllable };
      },
      subscribeToEvents() {
        return () => undefined;
      },
      async sendInstruction() {
        return { delivered: true, via: 'test' };
      },
    };

    const registry = new SessionRegistry({
      store,
      projects: new ProjectService({ store, listSessions: () => store.listSessions() }),
    });
    registry.registerAdapter(adapter);
    await registry.reconcile();

    const changes: ConversationChange[] = [];
    store.onConversationChanged((change) => changes.push(change));

    await registry.sendInstruction(TEST_SESSION, 'run the tests');
    await registry.stop();

    // The choke point is the store, not the investigator: the control channel
    // writes to the same conversation and the renderer hears about it too.
    expect(changes).toEqual([
      { sessionId: TEST_SESSION },
      { sessionId: TEST_SESSION },
    ]);
    expect(store.getConversation(TEST_SESSION).map((row) => row.role)).toEqual([
      'user_instruction',
      'instruction_result',
    ]);
  });
});
