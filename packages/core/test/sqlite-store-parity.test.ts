import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConversationEntry } from '../src/types/conversation.js';
import type { SemanticState } from '../src/types/session.js';
import type { SurfaceUpdate, TraceWindow } from '../src/observation/trace-window.js';
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

function entry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: randomUUID(),
    sessionId: TEST_SESSION,
    at: '2026-02-11T09:00:00.000Z',
    role: 'companion_answer',
    text: 'the whole answer',
    ...overrides,
  };
}

function semantic(overrides: Partial<SemanticState> = {}): SemanticState {
  return {
    task: 'Fix the reconnect regression',
    phase: 'debugging',
    currentActivity: 'reading the replay path',
    recentProgress: ['found the insertion function'],
    lastMeaningfulUpdate: '2026-02-11T09:05:00.000Z',
    currentUnderstanding: null,
    meaningfulUpdates: [],
    source: 'heuristic',
    provenance: { eventIds: ['a', 'b'], throughSeq: 12 },
    updatedAt: '2026-02-11T09:05:00.000Z',
    ...overrides,
  };
}

describe('SqliteEventStore — what survives the round trip', () => {
  it('keeps an optional field absent rather than present-and-null', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;

    await store.upsertProject({
      id: 'project:repo',
      name: 'repo',
      repoRoot: '/repos/repo',
      gitCommonDir: '/repos/repo/.git',
      createdAt: '2026-02-11T09:00:00.000Z',
    });

    const stored = (await reopen()).listProjects()[0]!;
    // The same assertion `project-service.test.ts` makes, at store level: a
    // project with no remote has no `remoteUrl` key at all. SQL NULL and an
    // absent key are different facts and the mapper has to know which is which.
    expect(Object.keys(stored).sort()).toEqual([
      'createdAt',
      'gitCommonDir',
      'id',
      'name',
      'repoRoot',
    ]);
  });

  it('keeps a required nullable field present and null', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;

    // `task`, `cwd` and `projectId` are `T | null` — the key must stay. The
    // optional `worktree`/`branch` must not appear.
    await store.upsertSession(testSession({ task: null, cwd: null, projectId: null }));

    const restored = (await reopen()).getSession(TEST_SESSION)!;
    expect(restored.task).toBeNull();
    expect(restored.cwd).toBeNull();
    expect(restored.projectId).toBeNull();
    expect('task' in restored).toBe(true);
    expect('worktree' in restored).toBe(false);
    expect('branch' in restored).toBe(false);
    expect(restored.capabilities).toEqual(testSession().capabilities);
  });

  it('gives an answer written without a receipt no receipt on the way back', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    await store.appendConversationEntry(entry({ text: 'An older answer.' }));
    await store.appendConversationEntry(
      entry({
        text: 'A newer one.',
        refs: [{ kind: 'trace', sessionId: TEST_SESSION, startSeq: 1, endSeq: 3 }],
        investigation: {
          durationMs: 1200,
          checks: [{ kind: 'search', label: 'Searched session context', refs: [] }],
        },
      }),
    );

    const [older, newer] = (await reopen()).getConversation(TEST_SESSION);
    expect('investigation' in older!).toBe(false);
    expect('refs' in older!).toBe(false);
    expect('provenance' in older!).toBe(false);
    expect(newer!.investigation!.checks[0]!.label).toBe('Searched session context');
    expect(newer!.refs).toHaveLength(1);
  });

  it('round-trips a raw provider record of any shape', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    const shapes: unknown[] = [
      { nested: { deep: [1, 2, 3] } },
      'a bare string',
      null,
      [{ a: 1 }, { b: 2 }],
      42,
    ];
    let offset = 0;
    for (const raw of shapes) {
      await store.appendEvent(TEST_SESSION, {
        sessionId: TEST_SESSION,
        at: '2026-02-11T09:00:00.000Z',
        kind: 'unknown',
        summary: 'odd record',
        raw,
        rawRef: { source: '/f.jsonl', byteOffset: (offset += 100), line: 1 },
      });
    }

    const stored = (await reopen()).getEvents(TEST_SESSION);
    expect(stored.map((event) => event.raw)).toEqual(shapes);
  });

  it('keeps a window range and a note exactly as written', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    const window: TraceWindow = {
      id: 'w-0',
      sessionId: TEST_SESSION,
      index: 0,
      startSeq: 1,
      endSeq: 10,
      eventCount: 10,
      approxTokens: 500,
      // Required and nullable: all three keys must come back.
      source: null,
      startOffset: null,
      endOffset: null,
      startedAt: '2026-02-11T09:00:00.000Z',
      endedAt: '2026-02-11T09:01:00.000Z',
      closedBy: 'flush',
      createdAt: '2026-02-11T09:01:00.000Z',
    };
    await store.appendWindow(window);
    await store.appendWindowNote({
      id: 'n-0',
      sessionId: TEST_SESSION,
      windowId: 'w-0',
      windowIndex: 0,
      summary: 'it is reading the replay path',
      refs: [{ kind: 'trace', sessionId: TEST_SESSION, startSeq: 1, endSeq: 10 }],
      investigated: true,
      createdAt: '2026-02-11T09:01:00.000Z',
    });

    const restarted = await reopen();
    expect(restarted.getWindow(TEST_SESSION, 'w-0')).toEqual(window);
    const note = restarted.getWindowNoteForWindow(TEST_SESSION, 'w-0')!;
    // A boolean is stored as 0/1 and must come back a boolean, not 1.
    expect(note.investigated).toBe(true);
    expect('currentActivity' in note).toBe(false);
    expect('notableChange' in note).toBe(false);
  });

  it('leaves a candidate with no decision keys until one is taken', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const candidate: SurfaceUpdate = {
      id: 'c-1',
      sessionId: TEST_SESSION,
      windowId: null,
      message: 'the reconnect test is failing',
      whyNow: 'it just started',
      refs: [],
      urgency: 'normal',
      createdAt: '2026-02-11T09:02:00.000Z',
    };
    await store.appendSurfaceUpdate(candidate);

    const [before] = store.getSurfaceUpdates(TEST_SESSION);
    expect('decision' in before!).toBe(false);
    expect('decidedAt' in before!).toBe(false);
    expect('deliveredAt' in before!).toBe(false);
    expect(before!.windowId).toBeNull();
  });

  it('keeps semantic history in order and the session in step with it', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    await store.appendSemanticState(TEST_SESSION, semantic({ phase: 'exploring' }));
    await store.appendSemanticState(TEST_SESSION, semantic({ phase: 'debugging' }));

    const restarted = await reopen();
    expect(restarted.getSemanticHistory(TEST_SESSION).map((s) => s.phase)).toEqual([
      'exploring',
      'debugging',
    ]);
    // The write is one fact in two places; the session carries the latest.
    expect(restarted.getSession(TEST_SESSION)!.semanticState!.phase).toBe('debugging');
  });
});

describe('SqliteEventStore — ordering and query bounds', () => {
  it('assigns gap-free sequence numbers and refuses to re-store a record', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const events = steadyEvents(3);
    await storeEvents(store, events);
    // The same transcript record again — restart-and-replay must not duplicate.
    const again = await store.appendEvent(TEST_SESSION, events[0]!);
    // A genuinely new record, at an offset nothing has claimed.
    const next = await store.appendEvent(TEST_SESSION, {
      ...events[0]!,
      rawRef: { source: '/fixtures/test.jsonl', byteOffset: 9_000, line: 99 },
    });

    expect(again).toBeNull();
    // The rejected append consumed no sequence number.
    expect(next!.seq).toBe(4);
    expect(store.getEvents(TEST_SESSION).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('treats every limit as the last N, not the first N', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(5));

    // The most recent two, still in ascending order. Reading this backwards
    // would silently serve the oldest history everywhere at once.
    expect(store.getEvents(TEST_SESSION, { limit: 2 }).map((e) => e.seq)).toEqual([4, 5]);
    expect(store.getEvents(TEST_SESSION, { limit: 99 })).toHaveLength(5);
    expect(store.getEvents(TEST_SESSION, { limit: 0 })).toEqual([]);
    expect(store.getEvents(TEST_SESSION, { sinceSeq: 3 }).map((e) => e.seq)).toEqual([4, 5]);
    expect(store.getEvents(TEST_SESSION, { sinceSeq: 99 })).toEqual([]);
  });

  it('orders a conversation by when it was written, not by its timestamp', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    // A question and its answer routinely land in the same millisecond. The
    // order they were written in is the only order that is true.
    const at = '2026-02-11T09:00:00.000Z';
    await store.appendConversationEntry(entry({ at, role: 'user_question', text: 'one' }));
    await store.appendConversationEntry(entry({ at, role: 'companion_answer', text: 'two' }));
    await store.appendConversationEntry(entry({ at, role: 'system_note', text: 'three' }));

    const restarted = await reopen();
    expect(restarted.getConversation(TEST_SESSION).map((e) => e.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(restarted.getConversation(TEST_SESSION, 2).map((e) => e.text)).toEqual([
      'two',
      'three',
    ]);
  });

  it('returns nothing rather than failing for ids and sessions it has never seen', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;

    expect(store.getEventsByIds(TEST_SESSION, [])).toEqual([]);
    expect(store.getEventsByIds(TEST_SESSION, ['nope'])).toEqual([]);
    expect(store.lastSeq('claude-code:never-seen')).toBe(0);
    expect(store.getConversation('claude-code:never-seen')).toEqual([]);
    expect(store.getSession('claude-code:never-seen')).toBeNull();
    expect(store.getProject('project:never-seen')).toBeNull();
    expect(store.getWindow(TEST_SESSION, 'w-nope')).toBeNull();
    expect(store.getWindowNoteForWindow(TEST_SESSION, 'w-nope')).toBeNull();
  });

  it('re-noting a window replaces the note instead of contradicting itself', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const note = {
      id: 'n-0',
      sessionId: TEST_SESSION,
      windowId: 'w-0',
      windowIndex: 0,
      refs: [],
      investigated: false,
      createdAt: '2026-02-11T09:01:00.000Z',
    };
    await store.appendWindowNote({ ...note, summary: 'first reading' });
    await store.appendWindowNote({ ...note, id: 'n-1', summary: 'second reading' });

    // The list and the per-window lookup cannot disagree about one window.
    expect(store.getWindowNotes(TEST_SESSION)).toHaveLength(1);
    expect(store.getWindowNoteForWindow(TEST_SESSION, 'w-0')!.summary).toBe('second reading');
  });
});
