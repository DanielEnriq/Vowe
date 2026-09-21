import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { CompanionService } from '../src/companion/companion-service.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import {
  asModelContext,
  recentConversation,
} from '../src/product/conversation-context.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import type { ConversationEntry } from '../src/types/conversation.js';
import type { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

const entry = (
  role: ConversationEntry['role'],
  text: string,
): ConversationEntry => ({
  id: randomUUID(),
  sessionId: TEST_SESSION,
  at: '2026-02-11T10:00:00.000Z',
  role,
  text,
});

async function conversation(): Promise<SqliteEventStore> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  await fixture.store.upsertSession(testSession());
  return fixture.store;
}

describe('the history a model is given', () => {
  it('is the conversation, not the instructions sent to the worker', async () => {
    const store = await conversation();
    await store.appendConversationEntry(entry('user_message', 'Morning.'));
    await store.appendConversationEntry(
      entry('user_instruction', 'Run the full suite.'),
    );
    await store.appendConversationEntry(
      entry('instruction_result', 'Delivered to the agent.'),
    );
    await store.appendConversationEntry(entry('companion_message', 'Morning.'));

    expect(recentConversation(store, TEST_SESSION)).toEqual([
      { speaker: 'user', text: 'Morning.' },
      { speaker: 'vo', text: 'Morning.' },
    ]);
  });

  it('carries the whole answer and the fact that it was cut off', async () => {
    const store = await conversation();
    const answer = entry(
      'companion_answer',
      'The reconnect path is broken because X, Y and Z.',
    );
    await store.appendConversationEntry(answer, {
      modality: 'voice',
      status: 'interrupted',
      audioEndMs: 1840,
      startedAt: '2026-02-11T10:00:00.000Z',
      completedAt: '2026-02-11T10:00:02.000Z',
    });

    const [turn] = asModelContext(recentConversation(store, TEST_SESSION));
    expect(turn!.text).toContain('X, Y and Z');
    expect(turn!.text).toContain('Interrupted after about 1.8s');
    expect(turn!.text).toContain('did not hear all of this');
  });

  it('says nothing extra about an answer that was heard in full', async () => {
    const store = await conversation();
    const answer = entry('companion_answer', 'The suite is green.');
    await store.appendConversationEntry(answer, {
      modality: 'voice',
      status: 'completed',
      startedAt: '2026-02-11T10:00:00.000Z',
      completedAt: '2026-02-11T10:00:01.000Z',
    });

    const [turn] = asModelContext(recentConversation(store, TEST_SESSION));
    expect(turn!.text).toBe('The suite is green.');
  });

  it('describes a delivery that never finished as exactly that', async () => {
    const store = await conversation();
    const answer = entry('companion_answer', 'The suite is green.');
    await store.appendConversationEntry(answer, {
      modality: 'voice',
      status: 'started',
      startedAt: '2026-02-11T10:00:00.000Z',
    });

    const [turn] = asModelContext(recentConversation(store, TEST_SESSION));
    expect(turn!.text).toContain('not known how much the user heard');
  });

  it('reaches the next investigation, interruption and all', async () => {
    const store = await conversation();
    const cutOff = entry(
      'companion_answer',
      'The reconnect path is broken because X, Y and Z.',
    );
    await store.appendConversationEntry(cutOff, {
      modality: 'voice',
      status: 'interrupted',
      audioEndMs: 1840,
      startedAt: '2026-02-11T10:00:00.000Z',
      completedAt: '2026-02-11T10:00:02.000Z',
    });

    let seen: InvestigationInput | null = null;
    const model: ObservationLlm = {
      async observeWindow(): Promise<WindowObservation> {
        return { summary: 'not used here' };
      },
      async investigate(input): Promise<DelegatedAnswer> {
        seen = input;
        return { spokenAnswer: 'Yes.', fullAnswer: 'Yes, and here is why.', refs: [] };
      },
    };

    const companion = new CompanionService({
      store,
      delegated: new DelegatedQuestionRunner({
        store,
        navigator: new ContextNavigator({ store }),
        investigator: model,
      }),
    });
    await companion.ask(TEST_SESSION, 'What was Z again?');

    const history = seen!.liveConversation;
    const previous = history.find((turn) => turn.speaker === 'vo')!;
    // Both facts, together: what Vowe worked out, and that the developer did
    // not hear the end of it. Either alone produces a wrong next turn.
    expect(previous.text).toContain('X, Y and Z');
    expect(previous.text).toContain('Interrupted');
  });
});
