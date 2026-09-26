import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { reconcileRecords, type RecordIdentity } from '../src/evidence/reconcile.js';
import type { EvidenceBatch, EvidenceRecord } from '../src/evidence/types.js';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const f = await temporaryStore();
  cleanups.push(f.cleanup);
  await f.store.upsertSession(testSession());
  const db = new DatabaseSync(path.join(f.root, 'vowe.sqlite'));
  cleanups.push(async () => db.close());
  return { ...f, db };
}
function record(text: string, key?: string): EvidenceRecord {
  const raw = key === undefined ? { text } : { id: key, text };
  const location = { source: 'log', byteOffset: 0, line: 1 };
  return {
    ...(key === undefined ? {} : { key }),
    raw,
    location,
    events: [
      {
        slot: '0',
        event: {
          sessionId: TEST_SESSION,
          at: '2026-01-01T00:00:00Z',
          kind: 'agent_message',
          summary: text,
          raw,
          rawRef: location,
        },
      },
    ],
  };
}
let captures = 0;
const snapshot = (records: EvidenceRecord[]): EvidenceBatch => ({
  sourceId: 'log',
  captureId: `c${captures++}`,
  observedAt: '2026-01-01T00:00:00Z',
  mode: 'snapshot',
  records,
  coverage: { scope: 'test', status: 'partial', reason: 'fixture' },
});
const view = (db: DatabaseSync) =>
  db
    .prepare("SELECT record_id FROM evidence_view WHERE session_id=? AND source_id='log' ORDER BY pos")
    .all(TEST_SESSION)
    .map((r) => String(r.record_id));
const texts = (s: string) => s.split(' ').map((t) => record(t));

describe('content identity is not occurrence identity', () => {
  it('keeps identical records as distinct occurrences that share one stored body', async () => {
    const { store, db } = await setup();
    await store.ingestEvidence(TEST_SESSION, snapshot(texts('A B B C')));
    const ids = view(db);
    expect(new Set(ids).size).toBe(4);
    expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['A', 'B', 'B', 'C']);
    const b = db
      .prepare('SELECT raw_hash FROM evidence_journal WHERE session_id=? ORDER BY obs')
      .all(TEST_SESSION)
      .map((r) => String(r.raw_hash));
    expect(b[1]).toBe(b[2]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_blobs WHERE hash=?').get(b[1]!)!.n).toBe(1);
  });

  it('A B C → A B B C adds one new occurrence and keeps the rest', async () => {
    const { store, db } = await setup();
    await store.ingestEvidence(TEST_SESSION, snapshot(texts('A B C')));
    const [a, b, c] = view(db);
    await store.ingestEvidence(TEST_SESSION, snapshot(texts('A B B C')));
    const after = view(db);
    expect([after[0], after[1], after[3]]).toEqual([a, b, c]);
    expect([a, b, c]).not.toContain(after[2]);
    expect(store.getEvents(TEST_SESSION).some((e) => e.detail?.identityUncertain)).toBe(false);
    expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['A', 'B', 'C', 'B']);
  });

  it('A B C B → A B B C keeps every occurrence identity', async () => {
    const { store, db } = await setup();
    await store.ingestEvidence(TEST_SESSION, snapshot(texts('A B C B')));
    const [a, b1, c, b2] = view(db);
    await store.ingestEvidence(TEST_SESSION, snapshot(texts('A B B C')));
    expect(view(db)).toEqual([a, b1, b2, c]);
    expect(store.getEvents(TEST_SESSION)).toHaveLength(4);
    expect(store.getEvents(TEST_SESSION).some((e) => e.detail?.identityUncertain)).toBe(false);
  });

  for (const initial of [7, 11, 23, 101, 4242])
  it(`SQL reconciliation matches the array reference over randomized histories (seed ${initial})`, async () => {
    const { store, db } = await setup();
    let seed = initial;
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const alphabet = ['A', 'B', 'C', 'D'];
    let keys = 0;
    let content: EvidenceRecord[] = [];
    let previous: RecordIdentity[] = [];
    let catalog: RecordIdentity[] = [];
    const reference = new Map<string, string>();
    for (let step = 0; step < 120; step++) {
      const next = [...content];
      const mutations = 1 + random(3);
      for (let m = 0; m < mutations; m++) {
        const at = random(next.length + 1);
        const op = random(7);
        if (op === 0 || !next.length)
          next.splice(at, 0, random(4) ? record(alphabet[random(4)]!) : record('keyed', `k${keys++}`));
        else if (op === 1) next.splice(Math.min(at, next.length - 1), 1);
        else if (op === 2) next.splice(at, 0, next[random(next.length)]!.key ? record('x') : next[random(next.length)]!);
        else if (op === 3) next.reverse();
        else if (op === 4) next.length = random(next.length + 1);
        else if (op === 5 && content.length) next.push(...content.slice(random(content.length)).filter((r) => !r.key));
        else next.push(record(alphabet[random(4)]!));
      }
      const unique = new Set<string>();
      const records = next.filter((r) => !r.key || (!unique.has(r.key) && unique.add(r.key)));
      const expected = reconcileRecords(previous, records, catalog);
      await store.ingestEvidence(TEST_SESSION, snapshot(records));
      const actual = view(db);
      expect(actual).toHaveLength(expected.length);
      // Same identity structure: a consistent bijection between the two id spaces.
      expected.forEach((identity, i) => {
        const known = reference.get(identity.id);
        if (known === undefined) {
          expect([...reference.values()]).not.toContain(actual[i]);
          reference.set(identity.id, actual[i]!);
        } else expect(actual[i]).toBe(known);
      });
      const ids = new Set(expected.map((r) => r.id));
      previous = expected;
      catalog = [...catalog.filter((r) => !ids.has(r.id)), ...expected];
      content = records;
    }
  });
});
