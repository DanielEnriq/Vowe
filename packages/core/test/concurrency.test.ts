import { afterEach, describe, expect, it } from 'vitest';

import { CompanionService } from '../src/companion/companion-service.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { DelegatedQuestionRunner } from '../src/delegation/delegated-question-runner.js';
import { ObserverRunner } from '../src/observation/observer-runner.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ObserveWindowInput,
  ReadOnlyToolset,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import {
  deferred,
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

describe('concurrency — observation and conversation are independent loops', () => {
  it('answers a delegated question while an observation is held open', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(30));

    // Pin the first observation open. Until this resolves, Loop A cannot
    // advance — which is precisely the condition under which Loop B must still
    // work, or a slow window would make Vo unresponsive.
    const held = deferred<void>();
    const order: string[] = [];
    let observed = 0;

    const observer: ObservationLlm = {
      async observeWindow(input: ObserveWindowInput): Promise<WindowObservation> {
        observed += 1;
        if (input.window.windowIndex === 0) {
          order.push('observation:blocked');
          await held.promise;
          order.push('observation:released');
        }
        return { summary: `window ${input.window.windowIndex}` };
      },
      async investigate(
        _input: InvestigationInput,
        tools: ReadOnlyToolset,
      ): Promise<DelegatedAnswer> {
        // A real investigation reads context; do that here too, so the test
        // exercises the shared navigator rather than a stub.
        const hits = await tools.searchContext({ query: 'step', limit: 3 });
        order.push('question:answered');
        return {
          spokenAnswer: `Found ${hits.length}.`,
          fullAnswer: 'Grounded answer.',
          refs: hits.map((hit) => hit.ref),
        };
      },
    };

    const navigator = new ContextNavigator({ store });
    const runner = new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator,
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 10 },
    });
    const delegated = new DelegatedQuestionRunner({
      store,
      navigator,
      investigator: observer,
    });

    // Start observation but do not await it — it cannot finish yet.
    const observing = runner.catchUp();
    await Promise.resolve();

    // The conversation continues regardless.
    const answer = await delegated.answer({
      sessionId: TEST_SESSION,
      question: 'What is it doing?',
    });
    expect(answer.spokenAnswer).toContain('Found');
    expect(order).toEqual(['observation:blocked', 'question:answered']);

    // Observation was genuinely still blocked, not merely slow.
    expect(observed).toBe(1);

    held.resolve();
    await observing;

    expect(order).toEqual([
      'observation:blocked',
      'question:answered',
      'observation:released',
    ]);
    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(3);
  });

  // The same guarantee, for the other way of asking. Typing a question must not
  // pause observation any more than speaking one does — which is the whole
  // reason the typed path was routed through this runner rather than given a
  // loop of its own.
  it('answers a typed question while an observation is held open', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(30));

    const held = deferred<void>();
    const order: string[] = [];

    const observer: ObservationLlm = {
      async observeWindow(input: ObserveWindowInput): Promise<WindowObservation> {
        if (input.window.windowIndex === 0) {
          order.push('observation:blocked');
          await held.promise;
          order.push('observation:released');
        }
        return { summary: `window ${input.window.windowIndex}` };
      },
      async investigate(
        _input: InvestigationInput,
        tools: ReadOnlyToolset,
      ): Promise<DelegatedAnswer> {
        const hits = await tools.searchContext({ query: 'step', limit: 3 });
        order.push('question:answered');
        return {
          spokenAnswer: `Found ${hits.length}.`,
          fullAnswer: 'Grounded answer.',
          refs: hits.map((hit) => hit.ref),
        };
      },
    };

    const navigator = new ContextNavigator({ store });
    const runner = new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator,
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 10 },
    });
    const companion = new CompanionService({
      store,
      delegated: new DelegatedQuestionRunner({
        store,
        navigator,
        investigator: observer,
      }),
    });

    const observing = runner.catchUp();
    await Promise.resolve();

    const result = await companion.ask(TEST_SESSION, 'What is it doing?');
    expect(result.entry.text).toBe('Grounded answer.');
    expect(order).toEqual(['observation:blocked', 'question:answered']);

    held.resolve();
    await observing;

    expect(order).toEqual([
      'observation:blocked',
      'question:answered',
      'observation:released',
    ]);
    // Nothing lost and nothing repeated: the windows that closed during the
    // investigation are there, once each, in order.
    expect(store.getWindowNotes(TEST_SESSION).map((note) => note.windowIndex)).toEqual([
      0, 1, 2,
    ]);
  });

  it('keeps ingesting trace while a window is being interpreted', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(10));

    const held = deferred<void>();
    let firstCall = true;

    const observer: ObservationLlm = {
      async observeWindow(input): Promise<WindowObservation> {
        if (firstCall) {
          firstCall = false;
          await held.promise;
        }
        return { summary: `window ${input.window.windowIndex}` };
      },
      async investigate(): Promise<DelegatedAnswer> {
        throw new Error('not used here');
      },
    };

    const runner = new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator: new ContextNavigator({ store }),
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 10 },
    });

    const observing = runner.catchUp();
    await Promise.resolve();

    // Trace arriving mid-window must be accepted immediately, not queued behind
    // a model call. notifyTrace is the live ingestion path and must not block.
    await storeEvents(store, steadyEvents(30).slice(10));
    runner.notifyTrace();
    expect(store.lastSeq(TEST_SESSION)).toBe(30);

    held.resolve();
    await observing;
    // Give the coalesced re-drain a turn to finish.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The windows that closed during the conversation became available
    // naturally, without anything being re-run.
    expect(store.getWindowNotes(TEST_SESSION).map((n) => n.windowIndex)).toEqual([
      0, 1, 2,
    ]);
  });

  it('never lets a delegated question reach the worker', () => {
    // Structural, not behavioural: the runner is constructed from a store, a
    // navigator and a model. There is no adapter and no registry in the object
    // graph, so there is nothing to reach a coding agent with.
    const runner = new DelegatedQuestionRunner({
      store: {} as never,
      navigator: {} as never,
      investigator: {} as never,
    });
    const reachable = Object.values(runner as unknown as Record<string, unknown>);
    for (const value of reachable) {
      expect(value).not.toHaveProperty('sendInstruction');
      expect(value).not.toHaveProperty('registerAdapter');
    }
  });

  it('never lets a typed question reach the worker either', () => {
    // The typed path inherits that property rather than re-earning it: the
    // facade holds a store and the same runner, and nothing else.
    const companion = new CompanionService({
      store: {} as never,
      delegated: new DelegatedQuestionRunner({
        store: {} as never,
        navigator: {} as never,
        investigator: {} as never,
      }),
    });
    const reachable = Object.values(companion as unknown as Record<string, unknown>);
    for (const value of reachable) {
      expect(value).not.toHaveProperty('sendInstruction');
      expect(value).not.toHaveProperty('registerAdapter');
      expect(value).not.toHaveProperty('surfaceUpdate');
    }
  });
});
