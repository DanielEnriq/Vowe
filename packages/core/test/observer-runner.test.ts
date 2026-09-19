import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import { ObserverRunner } from '../src/observation/observer-runner.js';
import type {
  ObservationLlm,
  ObserverToolset,
  ObserveWindowInput,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import type { NdjsonEventStore } from '../src/store/ndjson-event-store.js';
import {
  steadyEvents,
  storeEvents,
  temporaryStore,
  testSession,
  TEST_SESSION,
} from './helpers.js';

/** Records what it was asked to interpret, and in what order. */
class RecordingObserver implements ObservationLlm {
  readonly seen: ObserveWindowInput[] = [];

  async observeWindow(
    input: ObserveWindowInput,
    _tools: ObserverToolset,
  ): Promise<WindowObservation> {
    this.seen.push(input);
    return { summary: `window ${input.window.windowIndex}` };
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

async function harness(policy = { maxEvents: 10 }) {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  await fixture.store.upsertSession(testSession());

  const build = (store: NdjsonEventStore, observer: ObservationLlm) =>
    new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator: new ContextNavigator({ store }),
      getSession: () => store.getSession(TEST_SESSION),
      policy,
    });

  return { ...fixture, build };
}

describe('ObserverRunner — acceptance 2: sequential observation', () => {
  it('processes a session with history in order, and persists a note per window', async () => {
    const { store, build } = await harness();
    await storeEvents(store, steadyEvents(50));

    const observer = new RecordingObserver();
    await build(store, observer).catchUp();

    // Strictly increasing: note N+1 must be written by something that read
    // note N, which is the entire value of a sequential observer.
    expect(observer.seen.map((input) => input.window.windowIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);

    const notes = store.getWindowNotes(TEST_SESSION);
    expect(notes).toHaveLength(5);
    expect(notes.map((note) => note.windowIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('processes only new windows when more activity arrives', async () => {
    const { store, build } = await harness();
    await storeEvents(store, steadyEvents(30));

    const observer = new RecordingObserver();
    const runner = build(store, observer);
    await runner.catchUp();
    expect(observer.seen).toHaveLength(3);

    // Append more trace, as a live worker would.
    const more = steadyEvents(50).slice(30);
    await storeEvents(store, more);
    await runner.catchUp();

    // Two further windows, and nothing re-interpreted.
    expect(observer.seen.map((input) => input.window.windowIndex)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it('resumes from the stored cursor after a restart, rather than from zero', async () => {
    const { store, reopen, build } = await harness();
    await storeEvents(store, steadyEvents(30));

    const before = new RecordingObserver();
    await build(store, before).catchUp();
    expect(before.seen).toHaveLength(3);

    // Restart Vowe: a brand-new store over the same directory, and a brand-new
    // runner that has never seen this session in memory.
    const restarted = await reopen();
    expect(restarted.getObservationState(TEST_SESSION)?.processedThroughSeq).toBe(30);
    expect(restarted.getWindowNotes(TEST_SESSION)).toHaveLength(3);

    const after = new RecordingObserver();
    const resumed = build(restarted, after);
    await resumed.catchUp();

    // Nothing to redo.
    expect(after.seen).toHaveLength(0);

    // New activity after the restart continues the numbering rather than
    // colliding with the windows already on disk.
    await storeEvents(restarted, steadyEvents(50).slice(30));
    await resumed.catchUp();
    expect(after.seen.map((input) => input.window.windowIndex)).toEqual([3, 4]);
    expect(restarted.getWindowNotes(TEST_SESSION)).toHaveLength(5);
  });

  it('carries bounded continuity forward, not the whole history', async () => {
    const { store, build } = await harness();
    await storeEvents(store, steadyEvents(100));

    const observer = new RecordingObserver();
    await build(store, observer).catchUp();

    const last = observer.seen[observer.seen.length - 1]!;
    // Nine windows precede the last one; only the configured few come with it.
    expect(last.recentNotes.length).toBeLessThanOrEqual(4);
    expect(last.recentNotes.length).toBeGreaterThan(0);
  });

  it('keeps a note traceable to the exact L0 range that produced it', async () => {
    const { store, build } = await harness();
    await storeEvents(store, steadyEvents(20));
    await build(store, new RecordingObserver()).catchUp();

    const windows = store.getWindows(TEST_SESSION);
    const note = store.getWindowNoteForWindow(TEST_SESSION, windows[0]!.id);
    expect(note).not.toBeNull();

    const traceRef = note!.refs.find((ref) => ref.kind === 'trace');
    expect(traceRef).toMatchObject({
      kind: 'trace',
      startSeq: windows[0]!.startSeq,
      endSeq: windows[0]!.endSeq,
    });
  });

  it('advances past a window the observer could not interpret', async () => {
    const { store, build } = await harness();
    await storeEvents(store, steadyEvents(30));

    let calls = 0;
    const flaky: ObservationLlm = {
      async observeWindow(input) {
        calls += 1;
        if (input.window.windowIndex === 1) throw new Error('model unavailable');
        return { summary: 'ok' };
      },
      async investigate() {
        throw new Error('not used here');
      },
    };

    const errors: string[] = [];
    const runner = new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer: flaky,
      navigator: new ContextNavigator({ store }),
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 10 },
      onError: (scope) => errors.push(scope),
    });
    await runner.catchUp();

    // All three attempted, the failure reported, and observation not stalled —
    // a window that cannot be interpreted is still addressable in L0.
    expect(calls).toBe(3);
    expect(errors).toContain('window:1');
    expect(store.getObservationState(TEST_SESSION)?.processedThroughSeq).toBe(30);
    void build;
  });
});
