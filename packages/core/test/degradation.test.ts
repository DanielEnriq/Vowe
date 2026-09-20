import { afterEach, describe, expect, it } from 'vitest';

import { CommunicationPolicy } from '../src/communication/communication-policy.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { HeuristicDecisionRouter } from '../src/decision/decision-router.js';
import { ProjectKnowledgeService } from '../src/knowledge/project-knowledge-service.js';
import { UnavailableProjectKnowledge } from '../src/knowledge/project-knowledge.js';
import { UnavailableLiveTransport } from '../src/live/live-transport.js';
import { ObserverRunner, looksUncertain } from '../src/observation/observer-runner.js';
import type { ObservationLlm } from '../src/llm/observation-llm.js';
import {
  makeEvents,
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

describe('acceptance 7: no decision model configured', () => {
  it('answers nothing, so every call site decides for itself', async () => {
    const router = new HeuristicDecisionRouter();
    expect(router.available).toBe(false);
    // `null` is the contract, not an error: it means "decide this yourself".
    expect(await router.choose({ state: {}, instructions: 'x', criteria: { a: 'a' } })).toBeNull();
    expect(await router.score({ state: {}, instructions: 'x', levels: ['a'] })).toBeNull();
    expect(
      await router.noul({ state: {}, instructions: 'x', criteria: { true: 'y', false: 'n' } }),
    ).toBeNull();
  });

  it('observes a whole session normally without one', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(30));

    const observer: ObservationLlm = {
      async observeWindow(input) {
        return { summary: `window ${input.window.windowIndex}` };
      },
      async investigate() {
        throw new Error('not used here');
      },
    };

    await new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator: new ContextNavigator({ store }),
      router: new HeuristicDecisionRouter(),
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 10 },
    }).catchUp();

    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(3);
  });

  it('still surfaces and still decides, deterministically', async () => {
    const policy = new CommunicationPolicy({ router: new HeuristicDecisionRouter() });
    const decision = await policy.evaluate(
      {
        id: 'c1',
        sessionId: TEST_SESSION,
        windowId: null,
        message: 'Stuck on the same assertion.',
        whyNow: 'Four identical failures.',
        refs: [],
        urgency: 'high',
        createdAt: new Date().toISOString(),
      },
      'Only tell me if something looks weird.',
    );
    expect(decision.action).toBe('speak_now');
    expect(decision.source).toBe('default');
  });

  it('falls back to an honest signal for whether a window needs exploring', () => {
    // Failure and repetition are the two signals that reliably mean a person
    // would look closer, and both are visible without any model.
    const failing = makeEvents([
      { kind: 'test_finished', summary: 'Tests failed', detail: { failed: true } },
    ]).map((event, index) => ({ ...event, id: `e${index}`, seq: index + 1 }));
    expect(looksUncertain(failing)).toBe(true);

    const repeated = makeEvents([
      { kind: 'command_started', summary: 'Ran: pnpm test', detail: { input: 'pnpm test' } },
      { kind: 'command_started', summary: 'Ran: pnpm test', detail: { input: 'pnpm test' } },
    ]).map((event, index) => ({ ...event, id: `e${index}`, seq: index + 1 }));
    expect(looksUncertain(repeated)).toBe(true);

    const routine = steadyEvents(5).map((event, index) => ({
      ...event,
      id: `e${index}`,
      seq: index + 1,
    }));
    expect(looksUncertain(routine)).toBe(false);
  });
});

describe('acceptance 8: no voice credential configured', () => {
  it('explains itself rather than failing', async () => {
    const transport = new UnavailableLiveTransport();
    expect(transport.available).toBe(false);
    expect(transport.unavailableReason).toBeTruthy();
    // Attaching is not an error — there is simply nothing to attach to.
    expect(await transport.attachSideband()).toBeNull();
    await expect(transport.createSession()).rejects.toThrow();
  });

  it('leaves observation entirely unaffected', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(20));

    // No transport anywhere in the object graph — observation does not depend
    // on voice, and this is what that claim means.
    const observer: ObservationLlm = {
      async observeWindow(input) {
        return { summary: `window ${input.window.windowIndex}` };
      },
      async investigate() {
        throw new Error('not used here');
      },
    };
    await new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator: new ContextNavigator({ store }),
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 10 },
    }).catchUp();

    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(2);
    // And the text view everything degrades to remains available.
    expect(store.getWindows(TEST_SESSION)).toHaveLength(2);
    expect(store.getObservationState(TEST_SESSION)?.processedThroughSeq).toBe(20);
  });
});

describe('acceptance 8: no repository knowledge provider', () => {
  it('observes a whole session normally without one', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(20));

    const observer: ObservationLlm = {
      async observeWindow(input) {
        return { summary: `window ${input.window.windowIndex}` };
      },
      async investigate() {
        throw new Error('not used here');
      },
    };

    // A navigator built the way it was before any of this existed.
    await new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator: new ContextNavigator({ store }),
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 10 },
    }).catchUp();

    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(2);
  });

  it('answers every knowledge question without anyone checking first', async () => {
    const service = new ProjectKnowledgeService({
      provider: new UnavailableProjectKnowledge('graphify is not installed'),
    });

    // The same contract `HeuristicDecisionRouter` and `UnavailableLiveTransport`
    // keep: the floor is a usable object, not an absence to be guarded against.
    expect(service.available).toBe(false);
    expect(service.unavailableReason).toBe('graphify is not installed');
    expect(await service.search({ projectId: 'git:x', query: 'anything' })).toEqual([]);
    expect(await service.open('git:x', 'n1')).toBeNull();
    expect((await service.describe('git:x')).status).toBe('unindexed');
    service.stop();
  });

  it('falls back to the search it had before, over a real working tree', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    // Vowe's own repository is a working tree, so this exercises the real
    // `git grep` path rather than a stand-in for it.
    await fixture.store.upsertSession(testSession({ cwd: process.cwd() }));

    const navigator = new ContextNavigator({
      store: fixture.store,
      knowledge: new ProjectKnowledgeService({
        provider: new UnavailableProjectKnowledge(),
      }),
    });

    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'ProjectKnowledgeService',
      sources: ['repo'],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.ref.kind === 'repo')).toBe(true);
  });
});
