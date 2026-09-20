import { afterEach, describe, expect, it } from 'vitest';

import { ContextNavigator } from '../src/context/context-navigator.js';
import { formatRef, parseRef, type ContextRef } from '../src/context/refs.js';
import { ObserverRunner } from '../src/observation/observer-runner.js';
import type { ObservationLlm } from '../src/llm/observation-llm.js';
import {
  makeEvents,
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

describe('ContextRef', () => {
  it('round-trips every kind through its string form', () => {
    const refs: ContextRef[] = [
      { kind: 'window', sessionId: TEST_SESSION, windowId: 'w-1' },
      { kind: 'trace', sessionId: TEST_SESSION, startSeq: 10, endSeq: 42 },
      { kind: 'event', sessionId: TEST_SESSION, eventId: 'e-1' },
      { kind: 'transcript', sessionId: TEST_SESSION, eventId: 'e-2' },
      { kind: 'repo', path: 'src/a.ts', line: 12 },
      { kind: 'repo', path: 'src/b.ts' },
      { kind: 'diff', sessionId: TEST_SESSION, path: 'src/c.ts' },
      { kind: 'diff', sessionId: TEST_SESSION },
      // A project id contains a colon too, and a graph node id is the
      // provider's own opaque string — so this one splits on `#` twice over.
      { kind: 'symbol', projectId: 'git:abc123', nodeId: 'src/a.ts::Thing#init' },
    ];
    for (const ref of refs) {
      // Session ids contain a colon themselves, which is the case a naive
      // split would get wrong.
      expect(parseRef(formatRef(ref))).toEqual(ref);
    }
  });

  it('returns null for nonsense rather than throwing', () => {
    // A model will produce these, and a thrown error mid-observation would
    // cost a window.
    expect(parseRef('not a ref')).toBeNull();
    expect(parseRef('window:')).toBeNull();
    expect(parseRef('trace:session:notarange')).toBeNull();
    expect(parseRef('')).toBeNull();
  });
});

describe('ContextNavigator — acceptance 3: investigation', () => {
  async function seeded() {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());
    await storeEvents(
      fixture.store,
      makeEvents([
        { kind: 'session_started', summary: 'Task: fix the reconnect test', atSeconds: 0 },
        { kind: 'agent_message', summary: 'I will dedupe by message id', atSeconds: 1 },
        {
          kind: 'command_started',
          summary: 'Ran: pnpm vitest run test/reconnect.test.ts',
          atSeconds: 2,
          detail: { command: 'pnpm vitest run test/reconnect.test.ts' },
        },
        {
          kind: 'test_finished',
          summary: 'Tests failed',
          atSeconds: 3,
          detail: {
            failed: true,
            output: 'AssertionError: expected 2 to be 1 at test/reconnect.test.ts:48',
          },
        },
        { kind: 'user_instruction', summary: 'try a different approach', atSeconds: 4 },
      ]),
    );
    return { ...fixture, navigator: new ContextNavigator({ store: fixture.store }) };
  }

  it('searches the trace and returns references with bounded snippets', async () => {
    const { navigator } = await seeded();
    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'AssertionError reconnect',
      sources: ['trace'],
    });

    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0]!;
    // References, not dumps — the caller decides what to descend into.
    expect(parseRef(hit.refId)).not.toBeNull();
    expect(hit.snippet.length).toBeLessThanOrEqual(601);
    expect(hits.some((h) => h.snippet.includes('expected 2 to be 1'))).toBe(true);
  });

  it('restricts the transcript source to what was actually said', async () => {
    const { navigator } = await seeded();
    const hits = await navigator.searchContext({
      sessionId: TEST_SESSION,
      query: 'dedupe approach reconnect',
      sources: ['transcript'],
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.source === 'transcript')).toBe(true);
  });

  it('descends from a window to its L1 note and then to the underlying trace', async () => {
    const { store, navigator } = await seeded();

    const observer: ObservationLlm = {
      async observeWindow(input) {
        return { summary: `saw window ${input.window.windowIndex}` };
      },
      async investigate() {
        throw new Error('not used here');
      },
    };
    await new ObserverRunner({
      sessionId: TEST_SESSION,
      store,
      observer,
      navigator,
      getSession: () => store.getSession(TEST_SESSION),
      policy: { maxEvents: 5 },
    }).catchUp({ closeTail: true });

    const window = store.getWindows(TEST_SESSION)[0]!;
    const opened = await navigator.openContext({
      ref: formatRef({ kind: 'window', sessionId: TEST_SESSION, windowId: window.id }),
    });

    expect(opened.notFound).toBeUndefined();
    expect(opened.content).toContain('saw window 0');
    // The window hands back the trace range beneath it — the next step down.
    const traceRef = opened.related.find((ref) => ref.kind === 'trace');
    expect(traceRef).toBeDefined();

    const trace = await navigator.openContext({ ref: formatRef(traceRef!) });
    expect(trace.content).toContain('Tests failed');
  });

  it('reaches the provider’s own record at raw depth', async () => {
    const { store, navigator } = await seeded();
    const event = store.getEvents(TEST_SESSION)[3]!;

    const opened = await navigator.openContext({
      ref: formatRef({ kind: 'event', sessionId: TEST_SESSION, eventId: event.id }),
      depth: 'raw',
    });

    // The fixture source path does not exist on disk, so the honest answer is
    // that it could not be re-read — but the address is still reported, which
    // is what makes the descent checkable.
    expect(opened.content).toContain('Raw record');
    expect(opened.content).toContain(String(event.rawRef.byteOffset));
  });

  it('surrounds a transcript hit with its exchange', async () => {
    const { store, navigator } = await seeded();
    const message = store
      .getEvents(TEST_SESSION)
      .find((event) => event.kind === 'agent_message')!;

    const opened = await navigator.openContext({
      ref: formatRef({
        kind: 'transcript',
        sessionId: TEST_SESSION,
        eventId: message.id,
      }),
    });
    expect(opened.content).toContain('Surrounding exchange');
    expect(opened.content).toContain('try a different approach');
  });

  it('reports plainly when a session has no working tree to diff', async () => {
    const { navigator } = await seeded();
    const diff = await navigator.getDiff({ sessionId: TEST_SESSION });
    expect(diff.unavailable).toBeTruthy();
    expect(diff.patch).toBe('');
  });

  it('takes a real diff when the session has a working tree', async () => {
    const { store } = await seeded();
    // Vowe's own repository is a working tree, and a real git invocation is
    // the only way to know the shell-out actually works.
    const navigator = new ContextNavigator({
      store,
      resolveCwd: () => process.cwd(),
    });
    const diff = await navigator.getDiff({ sessionId: TEST_SESSION });
    expect(diff.unavailable).toBeUndefined();
    expect(typeof diff.patch).toBe('string');
  });

  it('says so, rather than throwing, when a reference does not resolve', async () => {
    const { navigator } = await seeded();
    expect((await navigator.openContext({ ref: 'window:x:nope' })).notFound).toBeTruthy();
    expect((await navigator.openContext({ ref: 'total nonsense' })).notFound).toBeTruthy();
  });
});
