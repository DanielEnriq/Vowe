import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { temporaryStore, testSession, TEST_SESSION } from './helpers.js';
import type { EvidenceBatch, EvidenceRecord } from '../src/evidence/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup() {
  const f = await temporaryStore();
  cleanups.push(f.cleanup);
  await f.store.upsertSession(testSession());
  return f;
}
function row(text: string, key?: string): EvidenceRecord {
  const location = { source: 'snapshot', byteOffset: 0, line: 1 };
  return {
    key,
    raw: { text },
    location,
    events: [
      {
        slot: '0',
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
function batch(captureId: string, records: EvidenceRecord[], sourceId = 'snapshot'): EvidenceBatch {
  return {
    sourceId,
    captureId,
    observedAt: '2026-01-01T00:00:00Z',
    mode: 'snapshot',
    records,
    coverage: { scope: 'test', status: 'partial', reason: 'fixture' },
  };
}

it('pins historical citations to supporting captures rather than the latest fact revision', async () => {
  const { store } = await setup();
  await store.ingestEvidence(TEST_SESSION, batch('a', [row('A', 'id')]));
  const old = store.getEvents(TEST_SESSION)[0]!;
  await store.ingestEvidence(TEST_SESSION, batch('b', [row('not A', 'id')]));
  expect(
    (store.evidenceProvenance(TEST_SESSION, old.id) as EvidenceBatch[]).map((b) => b.captureId),
  ).toEqual(['a']);
  expect(
    (
      store.evidenceProvenance(
        TEST_SESSION,
        store.getEvents(TEST_SESSION)[0]!.id,
      ) as EvidenceBatch[]
    ).map((b) => b.captureId),
  ).toEqual(['b']);
});

it('does not turn a truncate/restore cycle into new occurrences', async () => {
  const f = await setup();
  await f.store.ingestEvidence(TEST_SESSION, batch('all', [row('one'), row('two'), row('three')]));
  const ids = f.store.getEvents(TEST_SESSION).map((e) => e.id);
  await f.store.ingestEvidence(TEST_SESSION, batch('truncated', [row('one')]));
  const store = await f.reopen();
  await store.ingestEvidence(
    TEST_SESSION,
    batch('restored', [row('one'), row('two'), row('three')]),
  );
  expect(store.getEvents(TEST_SESSION).map((e) => e.id)).toEqual(ids);
});

it('preserves repeated suffix occurrences when new work is inserted ahead of them', async () => {
  const { store } = await setup();
  await store.ingestEvidence(
    TEST_SESSION,
    batch('one', [row('start'), row('repeat'), row('repeat'), row('tail')]),
  );
  const old = store.getEvents(TEST_SESSION).map((e) => e.id);
  await store.ingestEvidence(
    TEST_SESSION,
    batch('two', [row('start'), row('inserted'), row('repeat'), row('repeat'), row('tail')]),
  );
  expect(
    store
      .getEvents(TEST_SESSION)
      .map((e) => e.id)
      .slice(0, 4),
  ).toEqual(old);
  expect(store.lastSeq(TEST_SESSION)).toBe(5);
});

it('labels ambiguous repeated observations instead of inventing two further semantic edits', async () => {
  const { store } = await setup();
  await store.ingestEvidence(
    TEST_SESSION,
    batch('one', [row('start'), row('repeat'), row('repeat'), row('tail')]),
  );
  await store.ingestEvidence(
    TEST_SESSION,
    batch('two', [row('tail'), row('repeat'), row('repeat'), row('start')]),
  );
  expect(store.getEvents(TEST_SESSION).filter((e) => e.kind === 'agent_message')).toHaveLength(4);
  expect(store.getEvents(TEST_SESSION).filter((e) => e.detail?.identityUncertain)).toHaveLength(2);
  expect(store.evidenceStatus(TEST_SESSION).sources[0]!.coverage.reason).toContain('uncertain');
});

it('withdraws support only for a declared complete current view, preserving the audit', async () => {
  const { store } = await setup();
  const a = batch('a', [row('present', 'id')]);
  a.membership = 'current-view';
  await expect(store.ingestEvidence(TEST_SESSION, a)).rejects.toThrow('complete snapshot');
  a.captureId = 'complete-a';
  a.coverage.status = 'complete';
  await store.ingestEvidence(TEST_SESSION, a);
  const b = { ...a, captureId: 'empty', records: [] };
  const change = await store.ingestEvidence(TEST_SESSION, b);
  expect(change.invalidatedFromSeq).toBe(1);
  expect(store.getEvents(TEST_SESSION)).toHaveLength(0);
  expect(store.getEvents(TEST_SESSION, { audit: true })).toHaveLength(1);
  await store.ingestEvidence(TEST_SESSION, { ...a, captureId: 'present-again' });
  expect(store.getEvents(TEST_SESSION)).toHaveLength(1);
  expect(store.getEvents(TEST_SESSION, { audit: true })).toHaveLength(2);
});

it('keeps opaque record identities across arbitrary reorder/duplicate/restart histories', async () => {
  const f = await setup();
  let store = f.store;
  const all = Array.from({ length: 12 }, (_, i) => row(`fact ${i}`, `opaque\n${i}`));
  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  await store.ingestEvidence(TEST_SESSION, batch('initial', all));
  const ids = new Set(store.getEvents(TEST_SESSION).map((e) => e.id));
  for (let n = 0; n < 30; n++) {
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = random() % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const b = batch(`step-${n}`, shuffled.slice(0, 1 + (random() % 12)));
    await store.ingestEvidence(TEST_SESSION, b);
    await store.ingestEvidence(TEST_SESSION, b);
    if (n % 7 === 0) store = await f.reopen();
  }
  expect(new Set(store.getEvents(TEST_SESSION).map((e) => e.id))).toEqual(ids);
  expect(store.lastSeq(TEST_SESSION)).toBe(12);
  expect(store.evidenceStatus(TEST_SESSION).generation).toBeGreaterThan(0);
});

it('recovers a durable unadmitted capture after a process is killed during its transaction', async () => {
  const f = await setup();
  await f.store.close();
  const input = batch('crash', [row('durable', 'message')]);
  // The child commits acquisition, then dies with normalization writes still
  // inside a transaction. This is an actual process boundary and WAL recovery.
  const script = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');const b=JSON.parse(process.argv[2]);db.prepare('INSERT INTO evidence_captures(session_id,source_id,capture_id,digest,payload,processed) VALUES(?,?,?,?,?,0)').run(process.argv[3],b.sourceId,b.captureId,process.argv[4],JSON.stringify(b));db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO evidence_sources(session_id,source_id,state,coverage,observed_at,checkpoint) VALUES(?,?,?,?,?,?)').run(process.argv[3],b.sourceId,'[]',JSON.stringify(b.coverage),b.observedAt,null);process.stdout.write('kill-me');setInterval(()=>{},1000);`;
  const { fingerprint } = await import('../src/evidence/reconcile.js');
  const digest = fingerprint({
    sourceId: input.sourceId,
    mode: input.mode,
    records: input.records.map((r) => ({ key: r.key, raw: r.raw, location: r.location })),
    coverage: input.coverage,
  });
  const child = spawn(
    process.execPath,
    ['-e', script, path.join(f.root, 'vowe.sqlite'), JSON.stringify(input), TEST_SESSION, digest],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => {
      child.kill('SIGKILL');
    });
    child.once('exit', (_code, signal) =>
      signal === 'SIGKILL' ? resolve() : reject(new Error('child did not reach crash point')),
    );
  });
  const store = await f.reopen();
  expect(store.getEvents(TEST_SESSION).map((e) => e.summary)).toEqual(['durable']);
  const db = new DatabaseSync(path.join(f.root, 'vowe.sqlite'));
  expect(db.prepare('SELECT processed FROM evidence_captures').get()?.processed).toBe(1);
  db.close();
});
