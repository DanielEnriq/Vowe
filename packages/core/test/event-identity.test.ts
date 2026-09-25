import { afterEach, describe, expect, it } from 'vitest';

import { withOrdinals } from '../../adapter-kit/src/ordinals.js';
import type { AdapterEvent } from '../src/types/events.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/**
 * One raw record's worth of events, all at the same physical address.
 *
 * This is the ordinary shape of an assistant record: the worker says
 * something, thinks, and calls two tools, and the provider writes all of it as
 * a single line of JSON.
 */
function oneRecord(): AdapterEvent[] {
  const at = '2026-02-11T09:00:00.000Z';
  const rawRef = { source: '/fixtures/session.jsonl', byteOffset: 4096, line: 12 };
  return withOrdinals([
    { sessionId: TEST_SESSION, at, kind: 'agent_message', summary: 'Reworking the pi adapter.', raw: {}, rawRef },
    { sessionId: TEST_SESSION, at, kind: 'agent_reasoning', summary: 'Considering the parent id chain', raw: {}, rawRef },
    {
      sessionId: TEST_SESSION, at, kind: 'file_changed',
      summary: 'Wrote forecast.ts',
      detail: { input: { path: 'lib/finance/forecast.ts' } },
      raw: {}, rawRef,
    },
    {
      sessionId: TEST_SESSION, at, kind: 'command_started',
      summary: 'Ran: pnpm typecheck',
      detail: { input: { command: 'pnpm typecheck' } },
      raw: {}, rawRef,
    },
  ]);
}

describe('an event’s identity', () => {
  it('keeps every event a single record produced', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());

    for (const event of oneRecord()) {
      await fixture.store.appendEvent(TEST_SESSION, event);
    }

    // Four events from one line, not one event and three silently dropped.
    const stored = fixture.store.getEvents(TEST_SESSION);
    expect(stored).toHaveLength(4);
    expect(stored.map((event) => event.kind)).toEqual([
      'agent_message', 'agent_reasoning', 'file_changed', 'command_started',
    ]);
    // The detail that survives is what names a file on screen.
    expect(stored[2]!.detail?.['input']).toEqual({ path: 'lib/finance/forecast.ts' });
  });

  it('still treats the same record read twice as one record', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());

    for (const event of oneRecord()) {
      await fixture.store.appendEvent(TEST_SESSION, event);
    }
    // Restarting Vowe re-reads the transcript from the top. Nothing about
    // that is new trace, and the ordinals are stable, so nothing is appended.
    const second = [];
    for (const event of oneRecord()) {
      second.push(await fixture.store.appendEvent(TEST_SESSION, event));
    }

    expect(second.every((result) => result === null)).toBe(true);
    expect(fixture.store.getEvents(TEST_SESSION)).toHaveLength(4);
  });

  it('survives a restart with the record intact', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    await fixture.store.upsertSession(testSession());
    for (const event of oneRecord()) {
      await fixture.store.appendEvent(TEST_SESSION, event);
    }

    const restarted = await fixture.reopen();
    expect(restarted.getEvents(TEST_SESSION)).toHaveLength(4);
    expect(restarted.getEvents(TEST_SESSION)[3]!.rawRef.ordinal).toBe(3);
  });

  it('leaves a single-event record exactly as it was', async () => {
    const [only] = withOrdinals([
      {
        sessionId: TEST_SESSION, at: '2026-02-11T09:00:00.000Z',
        kind: 'session_finished', summary: 'Session ended', raw: {},
        rawRef: { source: '/fixtures/session.jsonl', byteOffset: 8192, line: 40 },
      },
    ]);
    // No ordinal written where there is nothing to tell apart.
    expect(only!.rawRef.ordinal).toBeUndefined();
  });
});
