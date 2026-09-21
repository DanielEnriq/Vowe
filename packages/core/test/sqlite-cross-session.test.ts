import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { steadyEvents, storeEvents, temporaryStore, testSession, TEST_SESSION } from './helpers.js';

const OTHER_SESSION = 'claude-code:other';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/**
 * One database now holds every session, where there used to be a directory per
 * session. Nothing may leak between them — a `WHERE session_id = ?` that was
 * forgotten somewhere would show one agent's work inside another's room.
 */
describe('SqliteEventStore — one database, still one session at a time', () => {
  it('numbers each session from one, independently', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await store.upsertSession(testSession({ id: OTHER_SESSION }));

    // Interleaved, so a shared counter would show up immediately.
    const a = steadyEvents(3, TEST_SESSION);
    const b = steadyEvents(2, OTHER_SESSION);
    await store.appendEvent(TEST_SESSION, a[0]!);
    await store.appendEvent(OTHER_SESSION, b[0]!);
    await store.appendEvent(TEST_SESSION, a[1]!);
    await store.appendEvent(OTHER_SESSION, b[1]!);
    await store.appendEvent(TEST_SESSION, a[2]!);

    expect(store.getEvents(TEST_SESSION).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.getEvents(OTHER_SESSION).map((e) => e.seq)).toEqual([1, 2]);
    expect(store.lastSeq(TEST_SESSION)).toBe(3);
    expect(store.lastSeq(OTHER_SESSION)).toBe(2);
  });

  it('dedupes a raw reference within a session, never across them', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());
    await store.upsertSession(testSession({ id: OTHER_SESSION }));

    // Two sessions can legitimately be reading the same transcript file. That
    // is not a duplicate; the old in-memory key was per session too.
    const event = steadyEvents(1)[0]!;
    expect(await store.appendEvent(TEST_SESSION, event)).not.toBeNull();
    expect(await store.appendEvent(OTHER_SESSION, event)).not.toBeNull();
    expect(await store.appendEvent(TEST_SESSION, event)).toBeNull();
  });

  it("never answers one session with another session's history", async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());
    await store.upsertSession(testSession({ id: OTHER_SESSION }));

    const mine = await storeEvents(store, steadyEvents(2));
    await storeEvents(store, steadyEvents(2, OTHER_SESSION), OTHER_SESSION);

    await store.appendConversationEntry({
      id: randomUUID(),
      sessionId: TEST_SESSION,
      at: '2026-02-11T09:00:00.000Z',
      role: 'companion_answer',
      text: 'only mine',
    });
    await store.appendWindow({
      id: 'w-0',
      sessionId: TEST_SESSION,
      index: 0,
      startSeq: 1,
      endSeq: 2,
      eventCount: 2,
      approxTokens: 10,
      source: null,
      startOffset: null,
      endOffset: null,
      startedAt: '2026-02-11T09:00:00.000Z',
      endedAt: '2026-02-11T09:00:02.000Z',
      closedBy: 'flush',
      createdAt: '2026-02-11T09:00:02.000Z',
    });
    await store.appendWindowNote({
      id: 'n-0',
      sessionId: TEST_SESSION,
      windowId: 'w-0',
      windowIndex: 0,
      summary: 'only mine',
      refs: [],
      investigated: false,
      createdAt: '2026-02-11T09:00:02.000Z',
    });
    await store.appendSurfaceUpdate({
      id: 'c-1',
      sessionId: TEST_SESSION,
      windowId: 'w-0',
      message: 'only mine',
      whyNow: 'because',
      refs: [],
      urgency: 'low',
      createdAt: '2026-02-11T09:00:03.000Z',
    });
    await store.setObservationState({
      sessionId: TEST_SESSION,
      lastClosedWindowIndex: 0,
      lastProcessedWindowId: 'w-0',
      processedThroughSeq: 2,
      communicationPreference: 'only when it is weird',
      updatedAt: '2026-02-11T09:00:04.000Z',
    });

    const restarted = await reopen();
    expect(restarted.getConversation(OTHER_SESSION)).toEqual([]);
    expect(restarted.getWindows(OTHER_SESSION)).toEqual([]);
    expect(restarted.getWindowNotes(OTHER_SESSION)).toEqual([]);
    expect(restarted.getSurfaceUpdates(OTHER_SESSION)).toEqual([]);
    expect(restarted.getObservationState(OTHER_SESSION)).toBeNull();
    expect(restarted.getSemanticHistory(OTHER_SESSION)).toEqual([]);

    // A window and a note exist, but not for the session asking.
    expect(restarted.getWindow(OTHER_SESSION, 'w-0')).toBeNull();
    expect(restarted.getWindowNoteForWindow(OTHER_SESSION, 'w-0')).toBeNull();
    // Nor can a ref resolve an event across the boundary.
    expect(restarted.getEventsByIds(OTHER_SESSION, [mine[0]!.id])).toEqual([]);
    expect(restarted.getEventsByIds(TEST_SESSION, [mine[0]!.id])).toHaveLength(1);
  });

  it('keeps sessions listed in the order they were first seen', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;

    await store.upsertSession(testSession());
    await store.upsertSession(testSession({ id: OTHER_SESSION }));
    // An update must not reshuffle the list.
    await store.upsertSession(testSession({ status: 'finished' }));

    const restarted = await reopen();
    expect(restarted.listSessions().map((s) => s.id)).toEqual([
      TEST_SESSION,
      OTHER_SESSION,
    ]);
    expect(restarted.getSession(TEST_SESSION)!.status).toBe('finished');
  });
});
