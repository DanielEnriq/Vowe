import { afterEach, expect, it } from 'vitest';
import { ObserverRunner } from '../src/observation/observer-runner.js';
import { ContextNavigator } from '../src/context/context-navigator.js';
import { hasCurrentSupport } from '../src/evidence/support.js';
import type {
  ObservationLlm,
  ObserveWindowInput,
  WindowObservation,
} from '../src/llm/observation-llm.js';
import type { EvidenceBatch } from '../src/evidence/types.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());
const input = (captureId: string, text: string): EvidenceBatch => ({
  sourceId: 'snapshot',
  captureId,
  observedAt: '2026-01-01T00:00:00Z',
  mode: 'snapshot',
  coverage: { scope: 'test', status: 'partial', reason: 'test' },
  records: [
    {
      key: 'message',
      raw: { text },
      location: { source: 'snapshot', byteOffset: 0, line: 1 },
      events: [
        {
          slot: 'message',
          event: {
            sessionId: TEST_SESSION,
            at: '2026-01-01T00:00:00Z',
            kind: 'agent_message',
            summary: text,
            raw: { text },
            rawRef: { source: 'snapshot', byteOffset: 0, line: 1 },
          },
        },
      ],
    },
  ],
});

it('incrementally replaces current understanding while preserving the old belief and its exact members', async () => {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  await f.store.upsertSession(testSession());
  const seen: ObserveWindowInput[] = [],
    published: string[] = [];
  const observer: ObservationLlm = {
    async observeWindow(i) {
      seen.push(i);
      return {
        summary: i.window.events.map((e) => e.summary).join(),
        understanding: i.window.events.map((e) => e.summary).join(),
      };
    },
    async investigate() {
      throw new Error('unused');
    },
  };
  const build = () =>
    new ObserverRunner({
      sessionId: TEST_SESSION,
      store: f.store,
      observer,
      navigator: new ContextNavigator({ store: f.store }),
      getSession: () => f.store.getSession(TEST_SESSION),
      checkpointMs: 0,
      policy: { maxEvents: 1 },
      onUnderstanding: (u) => published.push(u.understanding!),
    });
  await f.store.ingestEvidence(TEST_SESSION, input('a', 'A'));
  const first = build();
  await first.catchUp();
  first.stop();
  const oldNote = f.store.getWindowNotes(TEST_SESSION)[0]!,
    oldWindow = f.store.getWindow(TEST_SESSION, oldNote.windowId)!;
  await f.store.ingestEvidence(TEST_SESSION, input('b', 'not A'));
  expect(f.store.getWindowNotes(TEST_SESSION)).toHaveLength(0);
  expect(
    hasCurrentSupport(f.store, {
      kind: 'window',
      sessionId: TEST_SESSION,
      windowId: oldNote.windowId,
    }),
  ).toBe(false);
  const next = build();
  await next.catchUp();
  next.stop();
  expect(published).toEqual(['A', 'not A']);
  expect(seen[1]!.currentUnderstanding).toBeNull();
  expect(f.store.getWindowNoteForWindow(TEST_SESSION, oldNote.windowId)!.understanding).toBe('A');
  expect(f.store.getEventsByIds(TEST_SESSION, oldWindow.eventIds!)[0]!.summary).toBe('A');
  expect(f.store.getWindowNotes(TEST_SESSION)[0]!.understanding).toBe('not A');
});

it('fences an old model response after a correction even before the service stops its runner', async () => {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  await f.store.upsertSession(testSession());
  await f.store.ingestEvidence(TEST_SESSION, input('a', 'A'));
  let resolve!: (value: WindowObservation) => void;
  let entered = false;
  const published: string[] = [];
  const observer: ObservationLlm = {
    async observeWindow() {
      entered = true;
      return new Promise((r) => {
        resolve = r;
      });
    },
    async investigate() {
      throw new Error('unused');
    },
  };
  const runner = new ObserverRunner({
    sessionId: TEST_SESSION,
    store: f.store,
    observer,
    navigator: new ContextNavigator({ store: f.store }),
    getSession: () => f.store.getSession(TEST_SESSION),
    checkpointMs: 0,
    policy: { maxEvents: 1 },
    onUnderstanding: (u) => published.push(u.understanding!),
  });
  const pending = runner.catchUp();
  await expect.poll(() => entered).toBe(true);
  await f.store.ingestEvidence(TEST_SESSION, input('b', 'not A'));
  resolve({ summary: 'A', understanding: 'A' });
  await pending;
  runner.stop();
  expect(published).toEqual([]);
  expect(f.store.getWindowNotes(TEST_SESSION)).toEqual([]);
  expect(f.store.getObservationState(TEST_SESSION)?.processedThroughSeq ?? 0).toBe(0);
});

it('reuses a window left durable before a crash instead of producing an orphan note', async () => {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  await f.store.upsertSession(testSession());
  await f.store.ingestEvidence(TEST_SESSION, input('a', 'A'));
  const { WindowBuilder } = await import('../src/observation/window-builder.js');
  const window = new WindowBuilder({ sessionId: TEST_SESSION, policy: { maxEvents: 1 } }).push(
    f.store.getEvents(TEST_SESSION),
  )[0]!;
  await f.store.appendWindow(window);
  const store = await f.reopen();
  let calls = 0;
  const observer: ObservationLlm = {
    async observeWindow() {
      calls++;
      return { summary: 'A', understanding: 'A' };
    },
    async investigate() {
      throw new Error('unused');
    },
  };
  const runner = new ObserverRunner({
    sessionId: TEST_SESSION,
    store,
    observer,
    navigator: new ContextNavigator({ store }),
    getSession: () => store.getSession(TEST_SESSION),
    checkpointMs: 0,
    policy: { maxEvents: 2 },
  });
  await runner.catchUp();
  runner.stop();
  expect(calls).toBe(1);
  expect(store.getWindows(TEST_SESSION).map((w) => w.id)).toEqual([window.id]);
  expect(store.getWindowNotes(TEST_SESSION)[0]!.windowId).toBe(window.id);
  expect(store.getObservationState(TEST_SESSION)!.processedThroughSeq).toBe(1);
});

it('invalidates dependent memories and checkpoint updates without erasing their historical records', async () => {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  await f.store.upsertSession(testSession());
  await f.store.ingestEvidence(TEST_SESSION, input('a', 'A'));
  const { ProjectMemoryStore } = await import('../src/knowledge/project-memory-store.js');
  const memory = new ProjectMemoryStore({
    dataDirFor: (id) => f.store.projectDataDir(id),
    hasCurrentSupport: (ref) => hasCurrentSupport(f.store, ref),
  });
  const old = f.store.getEvents(TEST_SESSION)[0]!;
  const ref = { kind: 'event' as const, sessionId: TEST_SESSION, eventId: old.id };
  const first = await memory.remember({
    projectId: 'p',
    question: 'result',
    answer: 'A',
    refs: [ref],
  });
  const next = await memory.remember({
    projectId: 'p',
    question: 'result consequence',
    answer: 'therefore A',
    refs: [{ kind: 'lesson', projectId: 'p', recordId: first.id }],
  });
  await f.store.appendSurfaceUpdate({
    id: 'checkpoint',
    sessionId: TEST_SESSION,
    windowId: null,
    message: 'A',
    whyNow: 'result',
    refs: [ref],
    urgency: 'normal',
    createdAt: '2026-01-01T00:00:00Z',
  });
  await f.store.ingestEvidence(TEST_SESSION, input('b', 'not A'));
  expect(await memory.search({ projectId: 'p', query: 'result' })).toEqual([]);
  expect((await memory.get('p', next.id))!.supportStatus).toBe('invalidated');
  expect((await memory.get('p', first.id))!.answer).toBe('A');
  expect(f.store.getSurfaceUpdates(TEST_SESSION)).toEqual([]);
});

it('pins recomputed sparse windows without reciting invalidated members through a range', async () => {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  await f.store.upsertSession(testSession());
  const a = input('a', 'A');
  a.records.push(
    { ...input('middle', 'middle').records[0]!, key: 'middle' },
    { ...input('end', 'end').records[0]!, key: 'end' },
  );
  await f.store.ingestEvidence(TEST_SESSION, a);
  const corrected = input('b', 'new middle');
  corrected.records[0]!.key = 'middle';
  await f.store.ingestEvidence(TEST_SESSION, corrected);
  const runner = new ObserverRunner({
    sessionId: TEST_SESSION,
    store: f.store,
    observer: {
      async observeWindow() {
        return { summary: 'current', understanding: 'current' };
      },
      async investigate() {
        throw new Error('unused');
      },
    },
    navigator: new ContextNavigator({ store: f.store }),
    getSession: () => f.store.getSession(TEST_SESSION),
    checkpointMs: 0,
    policy: { maxEvents: 10 },
  });
  await runner.catchUp({ closeTail: true });
  runner.stop();
  const note = f.store.getWindowNotes(TEST_SESSION)[0]!;
  expect(note.refs[0]!.kind).toBe('window');
  expect(note.refs.every((ref) => hasCurrentSupport(f.store, ref))).toBe(true);
  const events = f.store.getEventsByIds(
    TEST_SESSION,
    f.store.getWindow(TEST_SESSION, note.windowId)!.eventIds!,
  );
  expect(events.map((e) => e.summary)).toEqual(['A', 'end', 'new middle']);
});
