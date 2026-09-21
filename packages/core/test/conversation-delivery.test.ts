import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { ConversationEntry } from '../src/types/conversation.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** The complete answer, as Vowe worked it out. */
const FULL_ANSWER =
  'The reconnect test is failing because both paths now reach the same ' +
  'insertion function. Claude is changing the replay path next.';

/**
 * What the developer actually heard before cutting it off.
 *
 * The trailing dash is transcription convention for "cut off here", so the
 * audible text is a prefix of the answer plus that marker — which is why the
 * test below strips it before checking the prefix relationship.
 */
const HEARD = 'The reconnect test is failing because both paths—';

function answer(text = FULL_ANSWER): ConversationEntry {
  return {
    id: randomUUID(),
    sessionId: TEST_SESSION,
    at: '2026-02-11T09:00:00.000Z',
    role: 'companion_answer',
    text,
  };
}

describe('conversation delivery — what was said, beside what was meant', () => {
  it('records a completed text delivery alongside its entry, in one commit', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    const entry = answer();
    await store.appendConversationEntry(entry, {
      modality: 'text',
      status: 'completed',
      startedAt: '2026-02-11T09:00:00.000Z',
      completedAt: '2026-02-11T09:00:00.100Z',
    });

    const restarted = await reopen();
    const [delivery] = restarted.getDeliveries(entry.id);
    expect(restarted.getConversation(TEST_SESSION)).toHaveLength(1);
    expect(delivery!.modality).toBe('text');
    expect(delivery!.status).toBe('completed');
    expect(delivery!.entryId).toBe(entry.id);
    // Nothing was cut off, so there is no partial transcript to record.
    expect('deliveredText' in delivery!).toBe(false);
    expect('audioEndMs' in delivery!).toBe(false);
  });

  it('keeps the whole answer when the developer interrupts halfway through it', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    // Slice 4 will write this pair. The point of the shape is that it can.
    const entry = answer();
    await store.appendConversationEntry(entry, {
      modality: 'voice',
      status: 'started',
      startedAt: '2026-02-11T09:00:00.000Z',
    });
    const [started] = store.getDeliveries(entry.id);

    const interrupting = answer('never mind');
    interrupting.role = 'user_question';
    await store.appendConversationEntry(interrupting);

    await store.updateDelivery(started!.id, {
      status: 'interrupted',
      deliveredText: HEARD,
      audioEndMs: 3_400,
      interruptedByEntryId: interrupting.id,
      completedAt: '2026-02-11T09:00:03.400Z',
    });

    const restarted = await reopen();
    const [delivery] = restarted.getDeliveries(entry.id);
    const [stored] = restarted.getConversation(TEST_SESSION);

    // Both truths survive, and they are different truths.
    expect(stored!.text).toBe(FULL_ANSWER);
    expect(delivery!.deliveredText).toBe(HEARD);
    expect(FULL_ANSWER.startsWith(delivery!.deliveredText!.replace(/—$/, ''))).toBe(
      true,
    );
    expect(delivery!.status).toBe('interrupted');
    expect(delivery!.audioEndMs).toBe(3_400);
    expect(delivery!.interruptedByEntryId).toBe(interrupting.id);
  });

  it('finalizes the row it started rather than writing a second one', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    const entry = answer();
    await store.appendConversationEntry(entry, {
      modality: 'voice',
      status: 'started',
      startedAt: '2026-02-11T09:00:00.000Z',
    });
    const [started] = store.getDeliveries(entry.id);
    expect(started!.status).toBe('started');
    expect('completedAt' in started!).toBe(false);

    const finished = await store.updateDelivery(started!.id, {
      status: 'completed',
      completedAt: '2026-02-11T09:00:06.000Z',
    });

    expect(finished!.id).toBe(started!.id);
    // Identity did not move when the state did.
    expect(finished!.entryId).toBe(entry.id);
    expect(finished!.modality).toBe('voice');
    expect((await reopen()).getDeliveries(entry.id)).toHaveLength(1);
  });

  it('records a cancelled delivery as a thing that happened', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    const entry = answer();
    await store.appendConversationEntry(entry, {
      modality: 'voice',
      status: 'cancelled',
      startedAt: '2026-02-11T09:00:00.000Z',
      completedAt: '2026-02-11T09:00:00.050Z',
    });

    const [delivery] = (await reopen()).getDeliveries(entry.id);
    expect(delivery!.status).toBe('cancelled');
    // Cancelled before anything was audible — which is not the same as
    // interrupted, and the absence of a transcript is how you tell.
    expect('deliveredText' in delivery!).toBe(false);
  });

  it('lets one answer be delivered twice without duplicating the answer', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    // Spoken, cut off, then read on screen. One semantic turn throughout: this
    // is the shape that keeps Live and the investigator from each persisting
    // their own copy of the same answer.
    const entry = answer();
    await store.appendConversationEntry(entry, {
      modality: 'voice',
      status: 'interrupted',
      deliveredText: HEARD,
      audioEndMs: 3_400,
      startedAt: '2026-02-11T09:00:00.000Z',
      completedAt: '2026-02-11T09:00:03.400Z',
    });
    await store.recordDelivery({
      id: randomUUID(),
      entryId: entry.id,
      sessionId: TEST_SESSION,
      modality: 'text',
      status: 'completed',
      startedAt: '2026-02-11T09:00:10.000Z',
      completedAt: '2026-02-11T09:00:10.000Z',
    });

    const restarted = await reopen();
    expect(restarted.getConversation(TEST_SESSION)).toHaveLength(1);
    expect(restarted.getDeliveries(entry.id).map((d) => d.modality)).toEqual([
      'voice',
      'text',
    ]);
    expect(restarted.getDeliveriesForSession(TEST_SESSION)).toHaveLength(2);
  });

  it('persists a filler turn like any other', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store, reopen } = fixture;
    await store.upsertSession(testSession());

    // Storage policy is not UI policy. Deciding "On it." is not worth showing
    // is a later, separate decision — it cannot be made by throwing it away.
    for (const text of ['On it.', 'Checking.', 'One second.']) {
      await store.appendConversationEntry(answer(text), {
        modality: 'voice',
        status: 'completed',
        startedAt: '2026-02-11T09:00:00.000Z',
      });
    }

    expect((await reopen()).getConversation(TEST_SESSION).map((e) => e.text)).toEqual([
      'On it.',
      'Checking.',
      'One second.',
    ]);
  });

  it('says nothing about a delivery that does not exist', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const { store } = fixture;

    expect(await store.updateDelivery('no-such-delivery', { status: 'completed' })).toBeNull();
    expect(store.getDeliveries('no-such-entry')).toEqual([]);
    expect(store.getDeliveriesForSession('claude-code:never-seen')).toEqual([]);
  });
});
