import { afterEach, describe, expect, it } from 'vitest';

import { CompanionService } from '../src/companion/companion-service.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import type { ContextRef } from '../src/context/refs.js';
import { ConservativeMemoryAdmission } from '../src/knowledge/memory-admission.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import { UnknownSessionError } from '../src/types/errors.js';
import type { DelegatedResult } from '../src/delegation/delegated-question-runner.js';
import {
  steadyEvents,
  storeEvents,
  temporaryStore,
  testSession,
  TEST_SESSION,
} from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** An investigator that runs a caller-supplied investigation with the real tools. */
function investigator(
  run: (input: InvestigationInput, tools: ReadOnlyToolset) => Promise<DelegatedAnswer>,
): ObservationLlm {
  return {
    async observeWindow(): Promise<WindowObservation> {
      return { summary: 'not used here' };
    },
    investigate: run,
  };
}

interface Harness {
  companion: CompanionService;
  store: Awaited<ReturnType<typeof temporaryStore>>['store'];
  reopen: Awaited<ReturnType<typeof temporaryStore>>['reopen'];
  answers: DelegatedResult[];
}

async function harness(observer: ObservationLlm): Promise<Harness> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const { store } = fixture;
  await store.upsertSession(testSession());
  await storeEvents(store, steadyEvents(12));

  const answers: DelegatedResult[] = [];
  const delegated = new DelegatedQuestionRunner({
    store,
    navigator: new ContextNavigator({ store }),
    investigator: observer,
    onAnswer: (result) => answers.push(result),
  });

  return {
    companion: new CompanionService({ store, delegated }),
    store,
    reopen: fixture.reopen,
    answers,
  };
}

describe('unified ask — typed questions use the grounded investigator', () => {
  // Acceptance A. The point of the slice: a typed question can look things up.
  it('investigates with the read tools and returns the full answer', async () => {
    const used: string[] = [];
    const { companion, store } = await harness(
      investigator(async (input, tools) => {
        // The typed path gets the observer's own context, not a bare question.
        expect(input.sessionId).toBe(TEST_SESSION);
        expect(input.task).toBe('Fix the reconnect regression');
        // Nothing was said out loud, so there is no spoken history to carry.
        expect(input.liveConversation).toEqual([]);

        const hits = await tools.searchContext({ query: 'step', limit: 3 });
        used.push('searchContext');
        expect(hits.length).toBeGreaterThan(0);

        const opened = await tools.openContext({ ref: hits[0]!.refId });
        used.push('openContext');
        expect(opened.notFound).toBeUndefined();

        await tools.getDiff({});
        used.push('getDiff');

        return {
          spokenAnswer: 'It is on step three.',
          fullAnswer: 'The worker is on step three, per the trace.',
          refs: hits.map((hit) => hit.ref),
        };
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'What is it doing?');

    expect(used).toEqual(['searchContext', 'openContext', 'getDiff']);
    expect(result.failed).toBe(false);
    expect(result.entry.text).toBe('The worker is on step three, per the trace.');
    expect(result.entry.role).toBe('companion_answer');

    // One conversation, and the question is in it — not a modality-specific store.
    const conversation = store.getConversation(TEST_SESSION);
    expect(conversation.map((entry) => entry.role)).toEqual([
      'user_question',
      'companion_answer',
    ]);
    expect(conversation[0]!.text).toBe('What is it doing?');
  });

  // Acceptance E, the admitting half. Text reaches the same memory hook.
  it('offers a typed answer to the same onAnswer hook, with its refs intact', async () => {
    const repoRef: ContextRef = { kind: 'repo', path: 'src/registry.ts', line: 12 };
    const { companion, answers } = await harness(
      investigator(async () => ({
        spokenAnswer: 'Sessions are absorbed by the registry.',
        fullAnswer: 'SessionRegistry.absorb assigns the project.',
        refs: [repoRef],
      })),
    );

    await companion.ask(TEST_SESSION, 'Where does a session get its project?');

    expect(answers).toHaveLength(1);
    expect(answers[0]!.question).toBe('Where does a session get its project?');
    expect(answers[0]!.fullAnswer).toBe('SessionRegistry.absorb assigns the project.');
    // The repository ref survives, which is the gate admission tests first.
    expect(answers[0]!.refs).toContainEqual(repoRef);

    const admission = new ConservativeMemoryAdmission({
      router: {
        name: 'stub',
        available: true,
        async noul() {
          return { noul: 0.9 };
        },
        async choose() {
          return null;
        },
        async score() {
          return null;
        },
      },
    });
    await expect(
      admission.shouldRemember({
        question: answers[0]!.question,
        answer: answers[0]!.fullAnswer,
        refs: answers[0]!.refs,
      }),
    ).resolves.toBe(true);
  });

  // Acceptance E, the rejecting half, through the text path specifically.
  it('cannot admit an ephemeral typed question, because it has no repository refs', async () => {
    const { companion, answers } = await harness(
      investigator(async (_input, tools) => {
        const hits = await tools.searchContext({ query: 'step', limit: 2 });
        return {
          spokenAnswer: 'It is running the suite.',
          fullAnswer: 'The worker is running the test suite right now.',
          refs: hits.map((hit) => hit.ref),
        };
      }),
    );

    await companion.ask(TEST_SESSION, 'What command is it running right now?');

    const refs = answers[0]!.refs;
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.some((ref) => ref.kind === 'repo' || ref.kind === 'symbol')).toBe(false);

    // A router that would say yes to anything, to show the structural gate wins.
    const admission = new ConservativeMemoryAdmission({
      router: {
        name: 'stub',
        available: true,
        async noul() {
          return { noul: 1 };
        },
        async choose() {
          return null;
        },
        async score() {
          return null;
        },
      },
    });
    await expect(
      admission.shouldRemember({
        question: 'What command is it running right now?',
        answer: answers[0]!.fullAnswer,
        refs,
      }),
    ).resolves.toBe(false);
  });

  // Acceptance F. Refs are what make "show me why" answerable after a restart.
  it('persists refs of every kind across a restart', async () => {
    const refs: ContextRef[] = [
      { kind: 'repo', path: 'packages/core/src/context/context-navigator.ts', line: 161 },
      { kind: 'symbol', projectId: 'git:abc', nodeId: 'contextnavigator_opensymbol' },
      { kind: 'lesson', projectId: 'git:abc', recordId: 'r-7' },
      { kind: 'diff', sessionId: TEST_SESSION },
    ];
    const { companion, reopen } = await harness(
      investigator(async () => ({
        spokenAnswer: 'It reads the file, not just the graph.',
        fullAnswer: 'openContext on a symbol ref reads the file, because the file is true now.',
        refs,
      })),
    );

    await companion.ask(TEST_SESSION, 'How does a symbol ref resolve?');

    const restarted = await reopen();
    const conversation = restarted.getConversation(TEST_SESSION);
    const answer = conversation.find((entry) => entry.role === 'companion_answer');
    expect(answer).toBeDefined();
    for (const ref of refs) expect(answer!.refs).toContainEqual(ref);
    // The narrowing the evidence inspector reads is still there alongside them.
    expect(answer!.provenance?.eventIds).toEqual([]);
  });

  // Requirement 9. A failed investigation is an ordinary conversation entry.
  it('records a failure as an ordinary answer rather than crashing or guessing', async () => {
    const { companion, store, answers } = await harness(
      investigator(async () => {
        throw new Error('the model is unreachable');
      }),
    );

    const result = await companion.ask(TEST_SESSION, 'Why is it stuck?');

    expect(result.failed).toBe(true);
    expect(result.entry.role).toBe('companion_answer');
    expect(result.entry.text).toContain('the model is unreachable');
    expect(store.getConversation(TEST_SESSION).map((entry) => entry.role)).toEqual([
      'user_question',
      'companion_answer',
    ]);
    // Nothing to remember: no refs, so admission's first gate rejects it.
    expect(answers[0]!.refs).toEqual([]);
  });

  it('refuses a question about a session it has never seen', async () => {
    const { companion } = await harness(
      investigator(async () => {
        throw new Error('should not be reached');
      }),
    );

    await expect(companion.ask('claude-code:gone', 'anything?')).rejects.toBeInstanceOf(
      UnknownSessionError,
    );
  });

  it('reads the conversation back without owning it', async () => {
    const { companion, store } = await harness(
      investigator(async () => ({ spokenAnswer: 'a', fullAnswer: 'b', refs: [] })),
    );

    await companion.ask(TEST_SESSION, 'first?');
    await companion.ask(TEST_SESSION, 'second?');

    // Same entries the store holds — the facade transforms nothing.
    expect(companion.getConversation(TEST_SESSION)).toEqual(
      store.getConversation(TEST_SESSION),
    );
    expect(companion.getConversation(TEST_SESSION, 2)).toHaveLength(2);
  });
});
