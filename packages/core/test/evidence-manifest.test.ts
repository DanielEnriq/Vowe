import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { EvidenceLedger, MAX_RANGES } from '../src/evidence/ledger.js';
import { fingerprint } from '../src/evidence/reconcile.js';
import { EvidenceContinuityError, type EvidenceBatch, type EvidenceRecord } from '../src/evidence/types.js';
import { databasePath } from '../src/store/sqlite/database.js';
import { MIGRATIONS } from '../src/store/sqlite/migrations.js';
import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
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

/** Records laid out as a JSONL file would be: contiguous lines with offsets. */
function file(lines: string[], from = 0) {
  let offset = 0;
  const records: EvidenceRecord[] = [];
  lines.forEach((text, i) => {
    const location = { source: '/fixture/log.jsonl', byteOffset: offset, line: i + 1 };
    offset += Buffer.byteLength(text) + 1;
    if (i < from) return;
    const raw = { text };
    records.push({
      raw,
      text: JSON.stringify(raw),
      location,
      events: [
        {
          slot: '0',
          event: { sessionId: TEST_SESSION, at: '2026-01-01T00:00:00Z', kind: 'agent_message', summary: text, raw, rawRef: location },
        },
      ],
    });
  });
  return { records, through: { byteOffset: offset, line: lines.length + 1 } };
}
let n = 0;
const batch = (lines: string[], extra: Partial<EvidenceBatch> = {}, from = 0): EvidenceBatch => ({
  sourceId: 'log',
  captureId: `capture-${n++}`,
  observedAt: '2026-01-01T00:00:00Z',
  mode: 'snapshot',
  coverage: { scope: 'test', status: 'partial', reason: 'fixture' },
  ...file(lines, from),
  ...extra,
});
const count = (db: DatabaseSync, sql: string, ...params: Array<string | number>) =>
  Number(db.prepare(sql).get(...params)!.n);

it('stores an append or a local rewrite as its change, not as another copy', async () => {
  const { store, db } = await setup();
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`);
  const first = batch(lines);
  await store.ingestEvidence(TEST_SESSION, first);
  const journal = count(db, 'SELECT COUNT(*) AS n FROM evidence_journal');
  const blobs = count(db, 'SELECT COUNT(*) AS n FROM evidence_blobs');
  // Append ten records: an extension of the admitted view.
  const grown = [...lines, ...Array.from({ length: 10 }, (_, i) => `appended ${i}`)];
  const append = batch(grown, { extends: { captureId: first.captureId, records: 5000 } }, 5000);
  await store.ingestEvidence(TEST_SESSION, append);
  expect(count(db, 'SELECT COUNT(*) AS n FROM evidence_journal') - journal).toBe(10);
  expect(count(db, 'SELECT COUNT(*) AS n FROM evidence_blobs') - blobs).toBe(20); // raw + derived, each
  expect(count(db, 'SELECT COUNT(*) AS n FROM evidence_capture_ranges WHERE capture_id=?', append.captureId)).toBe(1);
  // Rewrite one record in the middle: whole-view reconciliation, but the
  // unchanged runs are reused, including the shifted suffix.
  const edited = [...grown];
  edited[2500] = 'rewritten in place, longer than before';
  const rewrite = batch(edited);
  await store.ingestEvidence(TEST_SESSION, rewrite);
  expect(count(db, 'SELECT COUNT(*) AS n FROM evidence_journal') - journal).toBe(11);
  expect(count(db, 'SELECT COUNT(*) AS n FROM evidence_capture_ranges WHERE capture_id=?', rewrite.captureId)).toBe(3);
  // A keyless record rewritten in retained history is a new occurrence; the
  // old one is omitted, not retracted, so it stays current evidence too.
  expect(store.getEvents(TEST_SESSION)).toHaveLength(5011);
  expect(store.getEvents(TEST_SESSION).find((e) => e.summary.startsWith('rewritten'))).toBeDefined();
  const ledger = new EvidenceLedger(db);
  const rebuilt = [...ledger.reconstruct(TEST_SESSION, 'log', rewrite.captureId)];
  expect(rebuilt.map((r) => (r.raw as { text: string }).text)).toEqual(edited);
  expect(rebuilt.map((r) => r.location)).toEqual(rewrite.records.map((r) => r.location));
});

it('reconstructs any of thousands of revisions from a bounded number of ranges', async () => {
  const { store, db } = await setup();
  let seed = 99;
  const random = (k: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % k;
  };
  let lines: string[] = ['start'];
  let current = batch(lines);
  await store.ingestEvidence(TEST_SESSION, current);
  const expected = new Map<string, string[]>();
  for (let revision = 0; revision < 2500; revision++) {
    const roll = random(20);
    if (roll < 17 && lines.length < 400) {
      const added = Array.from({ length: 1 + random(3) }, () => `r${revision} ${random(1000)}`);
      const next = [...lines, ...added];
      current = batch(next, { extends: { captureId: current.captureId, records: lines.length } }, lines.length);
      lines = next;
    } else {
      const next = [...lines];
      if (roll === 17) next.splice(random(next.length), 1, `edit ${revision}`);
      else if (roll === 18) next.splice(random(next.length), 0, `insert ${revision}`);
      else next.splice(1 + random(Math.max(1, next.length - 1)));
      lines = next;
      current = batch(lines);
    }
    await store.ingestEvidence(TEST_SESSION, current);
    if (revision % 250 === 0 || revision === 2499) expected.set(current.captureId, [...lines]);
  }
  expect(count(db, 'SELECT COUNT(DISTINCT capture_id) AS n FROM evidence_capture_ranges')).toBeGreaterThan(2500);
  expect(
    count(db, 'SELECT MAX(c) AS n FROM (SELECT COUNT(*) AS c FROM evidence_capture_ranges GROUP BY capture_id)'),
  ).toBeLessThanOrEqual(MAX_RANGES);
  const ledger = new EvidenceLedger(db);
  for (const [captureId, content] of expected)
    expect([...ledger.reconstruct(TEST_SESSION, 'log', captureId)].map((r) => (r.raw as { text: string }).text)).toEqual(
      content,
    );
}, 120_000);

it('re-anchors a fragmented capture instead of exceeding the range bound', async () => {
  const { store, db } = await setup();
  let lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  let current = batch(lines);
  await store.ingestEvidence(TEST_SESSION, current);
  let most = 0;
  let reanchored = false;
  // Each append starts a new run after the last rewrite; each tail rewrite
  // reuses every earlier run. Left alone, runs would grow without bound.
  for (let i = 0; i < 100; i++) {
    const appended = [...lines, `append ${i}`];
    current = batch(appended, { extends: { captureId: current.captureId, records: lines.length } }, lines.length);
    await store.ingestEvidence(TEST_SESSION, current);
    lines = [...appended.slice(0, -1), `rewritten ${i}`];
    current = batch(lines);
    await store.ingestEvidence(TEST_SESSION, current);
    const ranges = count(db, 'SELECT COUNT(*) AS n FROM evidence_capture_ranges WHERE capture_id=?', current.captureId);
    if (ranges < most) reanchored = true;
    most = Math.max(most, ranges);
  }
  expect(most).toBeGreaterThan(MAX_RANGES / 2);
  expect(most).toBeLessThanOrEqual(MAX_RANGES);
  expect(reanchored).toBe(true);
  expect(
    [...new EvidenceLedger(db).reconstruct(TEST_SESSION, 'log', current.captureId)].map(
      (r) => (r.raw as { text: string }).text,
    ),
  ).toEqual(lines);
});

it('redelivery after admission is a no-op; a stale extension is refused, not merged', async () => {
  const { store } = await setup();
  const first = batch(['a', 'b']);
  await store.ingestEvidence(TEST_SESSION, first);
  const extension = batch(['a', 'b', 'c'], { extends: { captureId: first.captureId, records: 2 } }, 2);
  await store.ingestEvidence(TEST_SESSION, extension);
  const revision = store.evidenceStatus(TEST_SESSION).revision;
  // Crash after admission, before the source recorded it: the same delivery again.
  await store.ingestEvidence(TEST_SESSION, extension);
  expect(store.evidenceStatus(TEST_SESSION).revision).toBe(revision);
  // A source resuming from an older checkpoint cannot append to a view that moved.
  await expect(
    store.ingestEvidence(TEST_SESSION, batch(['a', 'b', 'd'], { extends: { captureId: first.captureId, records: 2 } }, 2)),
  ).rejects.toBeInstanceOf(EvidenceContinuityError);
  expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['a', 'b', 'c']);
});

it('discards a segmented snapshot interrupted by a crash; the re-read converges', async () => {
  const f = await setup();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  await f.store.ingestEvidence(TEST_SESSION, batch(lines));
  const ids = f.store.getEvents(TEST_SESSION).map((e) => e.id);
  const edited = [...lines.slice(0, 29), 'changed tail'];
  const all = file(edited).records;
  const part = (snapshot: string, index: number, records: EvidenceRecord[], final: boolean): EvidenceBatch => ({
    ...batch([]),
    records,
    through: { byteOffset: records.at(-1)!.location.byteOffset + 20, line: records.at(-1)!.location.line + 1 },
    part: { snapshot, index, final },
  });
  await f.store.ingestEvidence(TEST_SESSION, part('interrupted', 0, all.slice(0, 10), false));
  await f.store.ingestEvidence(TEST_SESSION, part('interrupted', 1, all.slice(10, 20), false));
  expect(count(f.db, 'SELECT COUNT(*) AS n FROM evidence_staging')).toBe(20);
  const store = await f.reopen();
  expect(count(f.db, 'SELECT COUNT(*) AS n FROM evidence_staging')).toBe(0);
  await store.ingestEvidence(TEST_SESSION, part('again', 0, all.slice(0, 15), false));
  await store.ingestEvidence(TEST_SESSION, { ...part('again', 1, all.slice(15), true), through: file(edited).through });
  // Nothing from the interrupted read was admitted twice or lost.
  expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual([...lines, 'changed tail']);
  expect(store.getEvents(TEST_SESSION).slice(0, 30).map((e) => e.id)).toEqual(ids);
});

it('admits the parts of a first snapshot as they arrive, identical to admitting it whole', async () => {
  const { store } = await setup();
  const all = file(['a', 'b', 'a', 'c']).records;
  const part = (index: number, records: EvidenceRecord[], final: boolean): EvidenceBatch => ({
    ...batch([]),
    records,
    part: { snapshot: 'first', index, final },
  });
  await store.ingestEvidence(TEST_SESSION, part(0, all.slice(0, 2), false));
  // Nothing was known before: the first part is already admitted.
  expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['a', 'b']);
  await store.ingestEvidence(TEST_SESSION, part(1, all.slice(2), true));
  expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['a', 'b', 'a', 'c']);
  // The checkpointed capture is the snapshot's own id, as the source expects.
  const next = batch(['a', 'b', 'a', 'c', 'd'], { extends: { captureId: 'first', records: 4 } }, 4);
  await store.ingestEvidence(TEST_SESSION, next);
  expect(store.getEvents(TEST_SESSION)).toHaveLength(5);
});

it('migrates development-era JSON state without new identities, keeping old captures readable', async () => {
  const f = await temporaryStore();
  cleanups.push(f.cleanup);
  await f.store.close();
  const root = path.join(f.root, 'legacy');
  const older = new SqliteEventStore(root, { migrations: MIGRATIONS.filter((m) => m.version <= 14) });
  await older.init();
  await older.upsertSession(testSession());
  await older.close();
  const db = new DatabaseSync(databasePath(root));
  // One keyless record, as the previous ledger stored it.
  const legacy = batch(['kept']);
  const record = legacy.records[0]!;
  const digest = fingerprint(record.raw);
  const normalizationDigest = fingerprint(
    record.events.map((c) => ({ slot: c.slot, kind: c.event.kind, summary: c.event.summary, detail: c.event.detail })),
  );
  const fact = JSON.stringify(['log', 'rid-1', '0']);
  db.prepare(
    `INSERT INTO events(session_id,seq,id,at,kind,summary,raw_json,raw_source,raw_byte_offset,raw_line,raw_ordinal,logical_key,evidence_json)
     VALUES(?,1,'event-1','2026-01-01T00:00:00Z','agent_message','kept',?,?,0,1,0,?,?)`,
  ).run(TEST_SESSION, JSON.stringify(record.raw), record.location.source, fact, JSON.stringify({ factKey: fact, captureId: legacy.captureId, sourceId: 'log' }));
  db.prepare("INSERT INTO evidence_heads VALUES(?,?,'event-1',?)").run(
    TEST_SESSION,
    fact,
    fingerprint({ kind: 'agent_message', summary: 'kept', detail: undefined }),
  );
  db.prepare("INSERT INTO evidence_supports VALUES(?,'log','rid-1','0',?,?,?,1)").run(
    TEST_SESSION,
    fact,
    JSON.stringify(record.events[0]),
    legacy.captureId,
  );
  db.prepare("INSERT INTO evidence_event_support VALUES('event-1',?,'log',?,'rid-1','0')").run(TEST_SESSION, legacy.captureId);
  const identity = { id: 'rid-1', digest, normalizationDigest, correspondence: 'new' };
  db.prepare("INSERT INTO evidence_sources VALUES(?,'log',?,?,'2026-01-01T00:00:00Z',NULL)").run(
    TEST_SESSION,
    JSON.stringify({ view: [identity], catalog: [identity] }),
    JSON.stringify(legacy.coverage),
  );
  const { records, ...metadata } = legacy;
  db.prepare("INSERT INTO evidence_captures VALUES(?,'log',?,'d',?,1,?)").run(
    TEST_SESSION,
    legacy.captureId,
    JSON.stringify({ ...metadata, encoding: 'gzip-json', recordCount: 1 }),
    gzipSync(JSON.stringify(legacy)),
  );
  const lost = { ...metadata, captureId: 'lost', coverage: { scope: 'test', status: 'unavailable', reason: 'deleted' } };
  db.prepare("INSERT INTO evidence_captures VALUES(?,'log','lost','d',?,1,?)").run(
    TEST_SESSION,
    JSON.stringify({ ...lost, encoding: 'gzip-json', recordCount: 0 }),
    gzipSync(JSON.stringify({ ...lost, records: [] })),
  );
  db.prepare("INSERT INTO evidence_changes VALUES(?,1,'{}')").run(TEST_SESSION);
  db.close();

  const store = new SqliteEventStore(root);
  await store.init();
  cleanups.push(() => store.close());
  // Same content, re-acquired: the migrated view recognizes it.
  await store.ingestEvidence(TEST_SESSION, batch(['kept', 'new']));
  expect(store.getEvents(TEST_SESSION).map((e) => e.id)[0]).toBe('event-1');
  expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['kept', 'new']);
  const provenance = store.evidenceProvenance(TEST_SESSION, 'event-1') as EvidenceBatch[];
  expect(provenance.map((b) => b.captureId)).toEqual([legacy.captureId]);
  expect(provenance[0]!.records.map((r) => r.raw)).toEqual([{ text: 'kept' }]);
  expect(store.evidenceStatus(TEST_SESSION).sources[0]!.gaps?.[0]?.reason).toContain('deleted');
});
