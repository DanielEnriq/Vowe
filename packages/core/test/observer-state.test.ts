import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import type {
  ObservationLlm,
  ObserverToolset,
  ObserveWindowInput,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import {
  ObserverRunner,
  type ObserverUnderstanding,
} from '../src/observation/observer-runner.js';
import { liveObserverState } from '../src/product/observer-state.js';
import type { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import type { AgentSession, SemanticState } from '../src/types/session.js';
import {
  makeEvents,
  storeEvents,
  temporaryStore,
  testSession,
  TEST_SESSION,
  type EventSpec,
} from './helpers.js';

/**
 * An observer whose answers are supplied per window.
 *
 * The point of these tests is the machinery around the model — continuity in,
 * suppression out — so the model's side is scripted and every assertion fails
 * for a real reason rather than because a model phrased something differently.
 */
class ScriptedObserver implements ObservationLlm {
  readonly seen: ObserveWindowInput[] = [];
  constructor(private readonly answers: WindowObservation[]) {}

  async observeWindow(
    input: ObserveWindowInput,
    _tools: ObserverToolset,
  ): Promise<WindowObservation> {
    this.seen.push(input);
    return (
      this.answers[this.seen.length - 1] ?? {
        summary: `window ${input.window.windowIndex}`,
      }
    );
  }

  async investigate(): Promise<never> {
    throw new Error('not used here');
  }
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

const EDIT: EventSpec = {
  kind: 'file_changed',
  summary: 'Edited normalize.ts',
  detail: { input: { file_path: 'packages/adapter-pi/src/normalize.ts' } },
};

/** Two windows' worth of trace, at four events per window. */
function trace(): EventSpec[] {
  return [
    { kind: 'session_started', summary: 'Task: make pi ingestion work' },
    EDIT,
    { kind: 'tool_started', summary: 'Read session-file.ts' },
    EDIT,
    { kind: 'tool_started', summary: 'Searched for parentId' },
    EDIT,
    {
      kind: 'test_started',
      summary: 'Running tests: pnpm exec vitest run packages/adapter-pi/test/normalize.test.ts',
      detail: {
        input: { command: 'pnpm exec vitest run packages/adapter-pi/test/normalize.test.ts' },
      },
    },
    {
      kind: 'test_finished',
      summary: 'Tests passed or completed',
      detail: { output: 'Tests 8 passed (8)' },
    },
  ];
}

async function harness(answers: WindowObservation[], specs = trace()) {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  await fixture.store.upsertSession(testSession());
  await storeEvents(fixture.store, makeEvents(specs));

  const observer = new ScriptedObserver(answers);
  const published: ObserverUnderstanding[] = [];

  const runner = new ObserverRunner({
    sessionId: TEST_SESSION,
    store: fixture.store,
    observer,
    navigator: new ContextNavigator({ store: fixture.store }),
    getSession: () => fixture.store.getSession(TEST_SESSION),
    policy: { maxEvents: 4 },
    // The timer is production's driver; these tests call `checkpointNow`.
    checkpointMs: 0,
    onUnderstanding: (understanding) => published.push(understanding),
  });

  return { ...fixture, observer, runner, published };
}

/** A session carrying whatever the observer published, as the registry would. */
function sessionWith(
  published: ObserverUnderstanding[],
  overrides: Partial<AgentSession> = {},
): AgentSession {
  const latest = [...published].reverse().find((item) => item.understanding);
  const state: SemanticState = {
    task: 'make pi ingestion work',
    phase: 'testing',
    currentActivity: 'Running normalize tests',
    recentProgress: [],
    lastMeaningfulUpdate: '2026-02-11T09:00:08.000Z',
    currentUnderstanding: latest?.understanding ?? null,
    meaningfulUpdates: published
      .map((item) => item.durableUpdate)
      .filter((update) => update !== null),
    source: 'llm',
    provenance: { eventIds: [], throughSeq: 8 },
    updatedAt: '2026-02-11T09:00:08.000Z',
  };
  return testSession({ semanticState: state, ...overrides });
}

describe('live observer state', () => {
  it('carries the previous understanding into the next window', async () => {
    const { runner, observer } = await harness([
      { summary: 'w0', understanding: 'Pi ingestion is partly implemented.' },
      { summary: 'w1', understanding: 'Pi ingestion works; liveness is unresolved.' },
    ]);

    await runner.catchUp();

    // The first window had nothing to continue from; the second was handed
    // what the first concluded. That is the whole difference between observing
    // and summarizing.
    expect(observer.seen[0]?.currentUnderstanding).toBeNull();
    expect(observer.seen[1]?.currentUnderstanding).toBe(
      'Pi ingestion is partly implemented.',
    );
  });

  it('resumes from what was understood before a restart', async () => {
    const { store, runner, reopen } = await harness([
      { summary: 'w0', understanding: 'Pi ingestion is partly implemented.' },
      { summary: 'w1', understanding: 'Pi ingestion works; liveness is unresolved.' },
    ]);
    await runner.catchUp();
    expect(store.getWindowNotes(TEST_SESSION)[1]?.understanding).toBe(
      'Pi ingestion works; liveness is unresolved.',
    );

    const restarted = await reopen();
    const observer = new ScriptedObserver([{ summary: 'w2' }]);
    const resumed = new ObserverRunner({
      sessionId: TEST_SESSION,
      store: restarted,
      observer,
      navigator: new ContextNavigator({ store: restarted }),
      getSession: () => restarted.getSession(TEST_SESSION),
      policy: { maxEvents: 4 },
      checkpointMs: 0,
    });
    // A distinct source: the store dedupes on (session, source, byte offset),
    // so reusing the fixture's addresses would append nothing at all.
    await storeEvents(
      restarted,
      makeEvents([EDIT, EDIT, EDIT, EDIT], TEST_SESSION, '/fixtures/more.jsonl'),
    );
    await resumed.catchUp();

    expect(observer.seen[0]?.currentUnderstanding).toBe(
      'Pi ingestion works; liveness is unresolved.',
    );
  });

  it('records a durable update with the evidence behind it', async () => {
    const { runner, published, store } = await harness([
      {
        summary: 'w0',
        understanding: 'Pi ingestion is partly implemented.',
        notableChange:
          'The worker found that pi session histories branch through parent ids and is preserving that structure in provenance.',
      },
      { summary: 'w1', understanding: 'Focused normalization tests now pass.' },
    ]);

    await runner.catchUp();

    const updates = published
      .map((item) => item.durableUpdate)
      .filter((update) => update !== null);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.text).toContain('branch through parent ids');
    // A claim is only worth making if it can be descended into.
    expect(updates[0]!.refs).toContainEqual({
      kind: 'trace',
      sessionId: TEST_SESSION,
      startSeq: 1,
      endSeq: 4,
    });
    expect(store.getWindowNotes(TEST_SESSION)[0]?.notableChange).toBeDefined();
  });

  it('suppresses a durable update that only restates the last one', async () => {
    const { runner, published, store } = await harness([
      {
        summary: 'w0',
        understanding: 'Branching history is preserved.',
        notableChange: 'Pi normalization now preserves branching history.',
      },
      {
        summary: 'w1',
        understanding: 'Branching history is preserved.',
        // The same claim, said again at greater length. This is the failure a
        // model actually has, and it is what turns a short list into noise.
        notableChange:
          'Pi normalization now preserves branching history, which it did not before.',
      },
    ]);

    await runner.catchUp();

    const updates = published
      .map((item) => item.durableUpdate)
      .filter((update) => update !== null);
    expect(updates).toHaveLength(1);
    expect(store.getWindowNotes(TEST_SESSION)[1]?.notableChange).toBeUndefined();
  });

  it('treats "nothing meaningfully changed" as an ordinary outcome', async () => {
    const { runner, published, store } = await harness([
      { summary: 'w0', understanding: 'Reading the pi adapter.' },
      { summary: 'w1', understanding: 'Reading the pi adapter.' },
    ]);

    await runner.catchUp();

    // Two windows, two notes, no durable updates, and no error anywhere.
    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(2);
    expect(published.every((item) => item.durableUpdate === null)).toBe(true);
    expect(liveObserverState(sessionWith(published), []).recentMeaningfulUpdates)
      .toEqual([]);
  });

  it('refreshes understanding from the open tail without closing a window', async () => {
    // One window's worth closes; the rest stays open, as it would on a live
    // session that has not yet reached a boundary.
    const { runner, observer, published, store } = await harness(
      [
        { summary: 'w0', understanding: 'Editing the pi adapter.' },
        { summary: 'checkpoint', understanding: 'Focused normalization tests now pass.' },
      ],
      trace().slice(0, 6),
    );

    await runner.catchUp();
    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(1);

    await runner.checkpointNow();

    // The checkpoint saw the two events past the closed window, was handed the
    // understanding so far, and published a new one.
    const checkpoint = observer.seen[1]!;
    expect(checkpoint.window.startSeq).toBe(5);
    expect(checkpoint.currentUnderstanding).toBe('Editing the pi adapter.');
    expect(published.at(-1)?.understanding).toBe('Focused normalization tests now pass.');

    // And left the durable record exactly as it was: no window, no note, no
    // cursor movement.
    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(1);
    expect(store.getWindows(TEST_SESSION)).toHaveLength(1);
    expect(store.getObservationState(TEST_SESSION)?.processedThroughSeq).toBe(4);
  });

  it('declines a checkpoint when the tail holds nothing new', async () => {
    const { runner, observer } = await harness(
      [{ summary: 'w0', understanding: 'Editing the pi adapter.' }],
      trace().slice(0, 6),
    );
    await runner.catchUp();

    await runner.checkpointNow();
    await runner.checkpointNow();

    // One window and one checkpoint. The second checkpoint had nothing to read
    // and cost nothing, which is what makes a 20-second timer affordable.
    expect(observer.seen).toHaveLength(2);
  });

  it('retries a rate-limited window instead of burning it', async () => {
    let attempts = 0;
    const observer: ObservationLlm = {
      async observeWindow() {
        attempts += 1;
        // Refused twice, the way a per-minute limit refuses.
        if (attempts <= 2) {
          throw Object.assign(new Error('429 rate_limit_error'), { status: 429 });
        }
        return { summary: 'w0', understanding: 'The pi adapter is being reworked.' };
      },
      async investigate() { throw new Error('not used here'); },
    };

    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());
    await storeEvents(fixture.store, makeEvents(trace().slice(0, 4)));

    const published: ObserverUnderstanding[] = [];
    await new ObserverRunner({
      sessionId: TEST_SESSION,
      store: fixture.store,
      observer,
      navigator: new ContextNavigator({ store: fixture.store }),
      getSession: () => fixture.store.getSession(TEST_SESSION),
      policy: { maxEvents: 4 },
      checkpointMs: 0,
      backoff: () => 0,
      onUnderstanding: (u) => published.push(u),
    }).catchUp();

    // The window survived the refusals rather than being skipped, so the
    // developer's understanding has no hole where it was.
    expect(attempts).toBe(3);
    expect(fixture.store.getWindowNotes(TEST_SESSION)).toHaveLength(1);
    expect(published.at(-1)?.understanding).toBe('The pi adapter is being reworked.');
  });

  it('gives up on a window that fails for its own reasons', async () => {
    let attempts = 0;
    const observer: ObservationLlm = {
      async observeWindow() {
        attempts += 1;
        throw new Error('the window could not be interpreted');
      },
      async investigate() { throw new Error('not used here'); },
    };

    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());
    await storeEvents(fixture.store, makeEvents(trace().slice(0, 4)));

    await new ObserverRunner({
      sessionId: TEST_SESSION,
      store: fixture.store,
      observer,
      navigator: new ContextNavigator({ store: fixture.store }),
      getSession: () => fixture.store.getSession(TEST_SESSION),
      policy: { maxEvents: 4 },
      checkpointMs: 0,
      backoff: () => 0,
    }).catchUp();

    // Tried once, not four times: this failure will repeat identically, and
    // retrying it only delays every window behind it.
    expect(attempts).toBe(1);
    expect(fixture.store.getObservationState(TEST_SESSION)?.processedThroughSeq).toBe(4);
  });

  it('reads the same for a provider with no readable reasoning', async () => {
    const withReasoning = trace().flatMap((spec) => [
      { kind: 'agent_reasoning' as const, summary: 'Considering the parent id chain…' },
      spec,
    ]);

    const a = await harness([{ summary: 'w0' }], trace());
    await a.runner.catchUp();
    const plain = liveObserverState(sessionWith(a.published), a.store.getEvents(TEST_SESSION));
    await cleanup?.();
    cleanup = null;

    const b = await harness([{ summary: 'w0' }], withReasoning);
    await b.runner.catchUp();
    const talkative = liveObserverState(
      sessionWith(b.published),
      b.store.getEvents(TEST_SESSION),
    );

    // Same work, same reading. A provider that records its thinking must not
    // be understood better than one that does not.
    expect(talkative.currentActivity).toBe(plain.currentActivity);
    expect(talkative.recentMeaningfulUpdates.map((update) => update.text)).toEqual(
      plain.recentMeaningfulUpdates.map((update) => update.text),
    );
  });

  it('falls back to milestones when no observation model has run', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());
    const events = await storeEvents(fixture.store, makeEvents(trace()));

    const state = liveObserverState(testSession(), events);

    // No understanding, because there is no honest deterministic prose for it.
    expect(state.currentUnderstanding).toBeNull();
    // But plenty that is deterministically true, each carrying its evidence.
    expect(state.recentMeaningfulUpdates.map((update) => update.text)).toEqual([
      'started work',
      // One path, touched three times: a run of edits is one line, and it is
      // named by what it actually touched.
      'edited normalize.ts',
      'test suite passed 8 / 8',
    ]);
    expect(state.recentMeaningfulUpdates[0]!.refs.length).toBeGreaterThan(0);
  });

  it('settles when the session finishes', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());
    const events = await storeEvents(
      fixture.store,
      makeEvents([
        ...trace(),
        { kind: 'session_waiting', summary: 'Asked the developer a question', detail: { awaitingHuman: true, toolUseId: 'q1' } },
      ]),
    );

    const working = liveObserverState(
      sessionWith([{ sessionId: TEST_SESSION, understanding: 'Tests pass; liveness is unresolved.', durableUpdate: null }]),
      events,
    );
    expect(working.attention?.summary).toBe('Asked the developer a question');

    const done = liveObserverState(
      sessionWith(
        [{ sessionId: TEST_SESSION, understanding: 'Tests pass; liveness is unresolved.', durableUpdate: null }],
        { status: 'finished' },
      ),
      events,
    );

    // What was understood survives; what could still be answered does not,
    // because a dead session cannot receive an answer.
    expect(done.currentUnderstanding).toBe('Tests pass; liveness is unresolved.');
    expect(done.currentActivity).toBe('Running normalize tests');
    expect(done.attention).toBeNull();
  });
});
