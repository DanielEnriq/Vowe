import { afterEach, describe, expect, it } from 'vitest';

import type {
  SurfaceUpdate,
  TraceWindow,
  WindowNote,
} from '../src/observation/trace-window.js';
import { steadyEvents, storeEvents, temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

function window(index: number, overrides: Partial<TraceWindow> = {}): TraceWindow {
  return {
    id: `w-${index}`,
    sessionId: TEST_SESSION,
    index,
    startSeq: index * 10 + 1,
    endSeq: index * 10 + 10,
    eventCount: 10,
    approxTokens: 500,
    source: '/fixtures/test.jsonl',
    startOffset: index * 1200,
    endOffset: index * 1200 + 1080,
    startedAt: '2026-02-11T09:00:00.000Z',
    endedAt: '2026-02-11T09:01:00.000Z',
    closedBy: 'maxEvents',
    createdAt: '2026-02-11T09:01:00.000Z',
    ...overrides,
  };
}

function note(index: number): WindowNote {
  return {
    id: `n-${index}`,
    sessionId: TEST_SESSION,
    windowId: `w-${index}`,
    windowIndex: index,
    summary: `summary ${index}`,
    refs: [{ kind: 'trace', sessionId: TEST_SESSION, startSeq: 1, endSeq: 10 }],
    investigated: false,
    createdAt: '2026-02-11T09:01:00.000Z',
  };
}

function candidate(id: string): SurfaceUpdate {
  return {
    id,
    sessionId: TEST_SESSION,
    windowId: 'w-0',
    message: 'something weird',
    whyNow: 'because',
    refs: [],
    urgency: 'high',
    createdAt: '2026-02-11T09:02:00.000Z',
  };
}

describe('SqliteEventStore — observation persistence', () => {
  it('rebuilds windows, notes, candidates and the cursor after a restart', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());
    await storeEvents(store, steadyEvents(20));

    await store.appendWindow(window(0));
    await store.appendWindow(window(1));
    await store.appendWindowNote(note(0));
    await store.appendSurfaceUpdate(candidate('c-1'));
    await store.setObservationState({
      sessionId: TEST_SESSION,
      lastClosedWindowIndex: 1,
      lastProcessedWindowId: 'w-1',
      processedThroughSeq: 20,
      communicationPreference: 'Only tell me if something looks weird.',
      updatedAt: '2026-02-11T09:03:00.000Z',
    });

    const restarted = await reopen();

    expect(restarted.getWindows(TEST_SESSION)).toHaveLength(2);
    expect(restarted.getWindow(TEST_SESSION, 'w-1')?.index).toBe(1);
    expect(restarted.getWindowNotes(TEST_SESSION)).toHaveLength(1);
    expect(restarted.getWindowNoteForWindow(TEST_SESSION, 'w-0')?.summary).toBe('summary 0');
    expect(restarted.getSurfaceUpdates(TEST_SESSION)).toHaveLength(1);

    const state = restarted.getObservationState(TEST_SESSION);
    expect(state?.processedThroughSeq).toBe(20);
    expect(state?.communicationPreference).toBe('Only tell me if something looks weird.');
  });

  it('attaches a decision to a candidate without duplicating it', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());
    await store.appendSurfaceUpdate(candidate('c-1'));

    await store.recordCommunicationDecision(TEST_SESSION, 'c-1', {
      action: 'speak_now',
      reason: 'matches the stated preference',
      source: 'default',
    });
    await store.markSurfaceUpdateDelivered(TEST_SESSION, 'c-1');

    // Append-only on disk, last-write-wins on read: one candidate, not three.
    const restarted = await reopen();
    const updates = restarted.getSurfaceUpdates(TEST_SESSION);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.decision?.action).toBe('speak_now');
    expect(updates[0]!.deliveredAt).toBeTruthy();
  });

  it('does not duplicate a window when the same one is appended twice', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;
    await store.upsertSession(testSession());

    await store.appendWindow(window(0));
    await store.appendWindow(window(0));
    expect(store.getWindows(TEST_SESSION)).toHaveLength(1);
  });

  it('returns null for a session that has never been observed', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    expect(fixture.store.getObservationState('claude-code:never-seen')).toBeNull();
    expect(fixture.store.getWindows('claude-code:never-seen')).toEqual([]);
  });
});

describe('SqliteEventStore — a session is named once', () => {
  /**
   * `generated_title` is the delimiter that says a session has been named, so
   * the check is the write. Anything else — read, decide, write — has a gap in
   * it, and the gap is where a second name comes from.
   */
  it('writes a name only where there is not one already', async () => {
    const { store, cleanup: done } = await temporaryStore();
    cleanup = done;
    await store.upsertSession(testSession());

    expect(await store.setGeneratedTitle(TEST_SESSION, 'Port the Vowe UI')).toBe(true);
    expect(store.getSession(TEST_SESSION)?.generatedTitle).toBe('Port the Vowe UI');

    expect(await store.setGeneratedTitle(TEST_SESSION, 'Something else entirely')).toBe(false);
    expect(store.getSession(TEST_SESSION)?.generatedTitle).toBe('Port the Vowe UI');
  });

  /** Discovery reports sessions constantly and knows nothing about names. */
  it('keeps the name across the discovery upserts that follow it', async () => {
    const { store, reopen, cleanup: done } = await temporaryStore();
    cleanup = done;
    await store.upsertSession(testSession());
    await store.setGeneratedTitle(TEST_SESSION, 'Port the Vowe UI');

    await store.upsertSession(testSession({ task: 'the adapter reports something new' }));
    expect(store.getSession(TEST_SESSION)?.generatedTitle).toBe('Port the Vowe UI');

    const reopened = await reopen();
    expect(reopened.getSession(TEST_SESSION)?.generatedTitle).toBe('Port the Vowe UI');
  });

  it('says nothing was written for a session that does not exist', async () => {
    const { store, cleanup: done } = await temporaryStore();
    cleanup = done;
    expect(await store.setGeneratedTitle('claude-code:gone', 'Port the Vowe UI')).toBe(false);
  });
});
