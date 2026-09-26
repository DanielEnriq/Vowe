import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { EvidenceBatch, EvidenceRecord } from '../src/evidence/types.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
});
async function fixture() {
  const f = await temporaryStore();
  cleanup = f.cleanup;
  await f.store.upsertSession(testSession());
  return f;
}
function record(text: string, key?: string): EvidenceRecord {
  const location = { source: '/gone/session.jsonl', byteOffset: 0, line: 1 };
  return {
    ...(key === undefined ? {} : { key }),
    raw: { text },
    location,
    events: [
      {
        slot: 'text',
        event: {
          sessionId: TEST_SESSION,
          at: '2026-01-01T00:00:00Z',
          kind: 'agent_message',
          summary: text,
          raw: { text },
          rawRef: location,
        },
      },
    ],
  };
}
function batch(id: string, records: EvidenceRecord[], sourceId = 'history'): EvidenceBatch {
  return {
    sourceId,
    captureId: id,
    observedAt: '2026-01-01T00:00:00Z',
    mode: 'snapshot',
    records,
    coverage: { scope: 'messages', status: 'partial', reason: 'fixture' },
  };
}
describe('execution evidence', () => {
  it('recovers records inserted before a former physical cursor across restart', async () => {
    const f = await fixture();
    await f.store.ingestEvidence(TEST_SESSION, batch('one', [record('first'), record('old tail')]));
    const ids = f.store.getEvents(TEST_SESSION).map((e) => e.id);
    const store = await f.reopen();
    await store.ingestEvidence(
      TEST_SESSION,
      batch('two', [
        record('first'),
        record('new prompt'),
        record('old tail'),
        record('answer'),
        record('answer'),
      ]),
    );
    expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual([
      'first',
      'old tail',
      'new prompt',
      'answer',
      'answer',
    ]);
    expect(
      store
        .getEvents(TEST_SESSION)
        .slice(0, 2)
        .map((e) => e.id),
    ).toEqual(ids);
    await store.ingestEvidence(
      TEST_SESSION,
      batch('two', [
        record('first'),
        record('new prompt'),
        record('old tail'),
        record('answer'),
        record('answer'),
      ]),
    );
    expect(store.lastSeq(TEST_SESSION)).toBe(5);
  });
  it('joins only explicit cross-source fact identities and preserves both captures', async () => {
    const { store } = await fixture();
    const a = record('edited', 'delivery-1');
    a.events[0]!.factKey = 'operation:edit:123';
    await store.ingestEvidence(TEST_SESSION, batch('hook', [a], 'hooks'));
    const b = record('edited', 'message-1');
    b.events[0]!.factKey = 'operation:edit:123';
    await store.ingestEvidence(TEST_SESSION, batch('snapshot', [b]));
    expect(store.getEvents(TEST_SESSION)).toHaveLength(1);
    expect(
      store.evidenceProvenance(TEST_SESSION, store.getEvents(TEST_SESSION)[0]!.id),
    ).toHaveLength(2);
  });
  it('appends corrections, invalidates support and retains historical raw evidence', async () => {
    const { store } = await fixture();
    await store.ingestEvidence(TEST_SESSION, batch('one', [record('A', 'message')]));
    const old = store.getEvents(TEST_SESSION)[0]!;
    const change = await store.ingestEvidence(
      TEST_SESSION,
      batch('two', [record('not A', 'message')]),
    );
    expect(change.invalidatedFromSeq).toBe(1);
    expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['not A']);
    expect(store.getEvents(TEST_SESSION, { audit: true }).map((e) => e.summary)).toEqual([
      'A',
      'not A',
    ]);
    expect(store.getEventsByIds(TEST_SESSION, [old.id])[0]!.raw).toEqual({ text: 'A' });
  });
  it('exposes conflicts and admits established evidence over reports for the same explicit fact', async () => {
    const { store } = await fixture();
    const a = record('A', 'a');
    a.events[0]!.factKey = 'fact';
    const b = record('not A', 'b');
    b.events[0]!.factKey = 'fact';
    await store.ingestEvidence(TEST_SESSION, batch('a', [a], 'a'));
    await store.ingestEvidence(TEST_SESSION, batch('b', [b], 'b'));
    expect(store.getEvents(TEST_SESSION)[0]!.detail?.conflict).toBe(true);
    b.events[0]!.basis = 'established';
    await store.ingestEvidence(TEST_SESSION, batch('verified', [b], 'b'));
    expect(store.getEvents(TEST_SESSION)[0]!.summary).toBe('not A');
    expect(store.getEvents(TEST_SESSION, { audit: true })).toHaveLength(3);
  });
  it('never turns unverified shell success into passed tests', async () => {
    const { store } = await fixture();
    const a = record('Tests passed', 'a');
    a.events[0]!.event.kind = 'test_finished';
    a.events[0]!.event.detail = { failed: false };
    a.events[0]!.execution = 'unknown';
    await store.ingestEvidence(TEST_SESSION, batch('a', [a]));
    expect(store.getEvents(TEST_SESSION)[0]!.kind).toBe('operation_reported');
    expect(store.getEvents(TEST_SESSION)[0]!.detail?.failed).toBeUndefined();
  });
  it('keeps captures on reconciliation failure and retries after reopening', async () => {
    const f = await fixture();
    const broken = batch('bad', [record('a', 'same'), record('b', 'same')]);
    await expect(f.store.ingestEvidence(TEST_SESSION, broken)).rejects.toThrow('Duplicate record');
    const db = new DatabaseSync(path.join(f.root, 'vowe.sqlite'));
    expect(db.prepare('SELECT processed FROM evidence_captures').get()?.processed).toBe(0);
    db.close();
    const store = await f.reopen();
    expect(store.lastSeq(TEST_SESSION)).toBe(0);
    await store.ingestEvidence(TEST_SESSION, batch('fixed', [record('a', 'a'), record('b', 'b')]));
    expect(store.lastSeq(TEST_SESSION)).toBe(2);
  });
  it('source loss is an explicit gap, not a retraction', async () => {
    const { store } = await fixture();
    await store.ingestEvidence(TEST_SESSION, batch('one', [record('A', 'a')]));
    const lost = batch('lost', []);
    lost.mode = 'delta';
    lost.coverage = { scope: 'messages', status: 'unavailable', reason: 'source deleted' };
    await store.ingestEvidence(TEST_SESSION, lost);
    expect(store.getEvents(TEST_SESSION)).toHaveLength(1);
    expect(store.evidenceStatus(TEST_SESSION).sources[0]!.coverage.status).toBe('unavailable');
  });
});
