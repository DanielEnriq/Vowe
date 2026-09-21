import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConversationChange } from '../src/store/event-store.js';
import { steadyEvents, temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function entry(text: string) {
  return {
    id: randomUUID(),
    sessionId: TEST_SESSION,
    at: '2026-02-11T09:00:00.000Z',
    role: 'companion_answer' as const,
    text,
  };
}

describe('SqliteEventStore — a write either happened or it did not', () => {
  it('leaves no entry behind when its delivery cannot be written', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    const good = entry('this one is fine');
    await store.appendConversationEntry(good, {
      modality: 'text',
      status: 'completed',
      startedAt: '2026-02-11T09:00:00.000Z',
    });

    // A delivery whose modality violates the schema fails on the second
    // statement, after the entry has already been inserted. Either both land
    // or neither does — a half-written turn is the one outcome that would be
    // silently wrong rather than loudly broken.
    const doomed = entry('this one must not survive');
    await expect(
      store.appendConversationEntry(doomed, {
        modality: 'voice',
        status: 'started',
        startedAt: '2026-02-11T09:00:00.000Z',
        // Not a string: STRICT rejects it, and the transaction unwinds.
        audioEndMs: 'halfway' as unknown as number,
      }),
    ).rejects.toThrow();

    const restarted = await reopen();
    const texts = restarted.getConversation(TEST_SESSION).map((e) => e.text);
    expect(texts).toEqual(['this one is fine']);
    expect(restarted.getDeliveries(doomed.id)).toEqual([]);
    // And the store still works afterwards — the transaction was unwound, not
    // left open.
    await restarted.appendConversationEntry(entry('afterwards'));
    expect(restarted.getConversation(TEST_SESSION)).toHaveLength(2);
  });

  it('keeps semantic history and the session in step, or neither', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    await expect(
      store.appendSemanticState(TEST_SESSION, {
        task: null,
        // A blob where STRICT wants text: the history insert fails, and the
        // session's own copy must not move without it.
        phase: new Uint8Array([1, 2]) as unknown as string,
        currentActivity: 'reading',
        recentProgress: [],
        lastMeaningfulUpdate: '2026-02-11T09:00:00.000Z',
        source: 'heuristic',
        provenance: { eventIds: [], throughSeq: 0 },
        updatedAt: '2026-02-11T09:00:00.000Z',
      }),
    ).rejects.toThrow();

    expect(store.getSemanticHistory(TEST_SESSION)).toEqual([]);
    expect(store.getSession(TEST_SESSION)!.semanticState).toBeNull();
  });

  it('numbers concurrent appends without collision or gap', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    // Every sequence number is assigned inside the insert, so racing appends
    // cannot hand out the same one twice.
    const stored = await Promise.all(
      steadyEvents(50).map((event) => store.appendEvent(TEST_SESSION, event)),
    );

    expect(stored.map((e) => e!.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(store.lastSeq(TEST_SESSION)).toBe(50);
  });

  it('tells a listener only once the entry is committed and readable', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const seen: number[] = [];
    const changes: ConversationChange[] = [];
    store.onConversationChanged((change) => {
      changes.push(change);
      // Re-reading from inside the listener is the whole contract: what it was
      // told about must already be there.
      seen.push(store.getConversation(change.sessionId).length);
    });

    await store.appendConversationEntry(entry('one'), {
      modality: 'text',
      status: 'completed',
      startedAt: '2026-02-11T09:00:00.000Z',
    });
    await store.appendConversationEntry(entry('two'));

    expect(seen).toEqual([1, 2]);
    expect(changes).toEqual([{ sessionId: TEST_SESSION }, { sessionId: TEST_SESSION }]);
  });

  it('says nothing to anyone when the write failed', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    const changes: ConversationChange[] = [];
    store.onConversationChanged((change) => changes.push(change));

    await expect(
      store.appendConversationEntry(entry('doomed'), {
        modality: 'voice',
        status: 'started',
        startedAt: '2026-02-11T09:00:00.000Z',
        audioEndMs: 'halfway' as unknown as number,
      }),
    ).rejects.toThrow();

    // The notification is on the far side of COMMIT, so a rolled-back write
    // cannot tell the renderer to go and read something that is not there.
    expect(changes).toEqual([]);
  });
});
