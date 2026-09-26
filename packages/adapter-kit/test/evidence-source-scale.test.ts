import { afterEach, expect, it } from 'vitest';
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { jsonlEvidenceSource, type JsonlEvidenceSource } from '../src/evidence-source.js';
import { TranscriptNormalizer } from '@vowe/adapter-claude-code';
import { PiSessionNormalizer } from '@vowe/adapter-pi';
import { CodexRolloutNormalizer } from '@vowe/adapter-codex';
import { SqliteEventStore, type EvidenceBatch } from '@vowe/core';

/**
 * Scale properties of evidence acquisition. Sizes are modest by default;
 * VOWE_SCALE=1 runs them at a gigabyte.
 */
const SCALE = process.env.VOWE_SCALE === '1';
const MB = 1024 * 1024;
const run = promisify(execFile);

let root: string;
const stores: SqliteEventStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), 'vowe-scale-'));
  return root;
}
async function openStore(dir: string) {
  const store = new SqliteEventStore(dir);
  await store.init();
  stores.push(store);
  return store;
}

/** A synthetic history of about `bytes`, with occasional multi-megabyte records. */
async function history(file: string, bytes: number, from = 0) {
  const handle = await open(file, 'a');
  let n = from,
    written = 0;
  try {
    while (written < bytes) {
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++, n++)
        lines.push(JSON.stringify({ id: `r${n}`, n, body: 'x'.repeat(n % 997 === 0 ? 4 * MB : 400 + (n % 1500)) }));
      const chunk = lines.join('\n') + '\n';
      await handle.write(chunk);
      written += Buffer.byteLength(chunk);
    }
  } finally {
    await handle.close();
  }
  return n;
}

const sessionId = 'scale:session';
function source(file: string, continuity: 'append-log' | 'mutable-snapshot' = 'append-log') {
  return jsonlEvidenceSource<Record<string, unknown>>({
    id: 'history',
    file: () => file,
    continuity,
    pollMs: 5,
    recordKey: (r) => (typeof r.id === 'string' ? r.id : undefined),
    normalizer: (at) => ({
      normalize: (line) => [
        {
          sessionId,
          at: '2026-01-01T00:00:00Z',
          kind: 'agent_message',
          summary: String(line.record.n ?? line.record.text),
          raw: line.record,
          rawRef: { source: at, byteOffset: line.byteOffset, line: line.line },
        },
      ],
    }),
  });
}
/** Run a source until it reports having delivered everything it can see. */
function drain(
  store: SqliteEventStore,
  src: JsonlEvidenceSource,
  checkpoint?: string,
  batches: EvidenceBatch[] = [],
) {
  return new Promise<void>((resolve, reject) => {
    const accept = async (batch: EvidenceBatch) => {
      batches.push({ ...batch, records: [] });
      await store.ingestEvidence(sessionId, batch).catch((error) => {
        reject(error);
        throw error;
      });
    };
    const idle = () => {
      stop();
      resolve();
    };
    const stop =
      checkpoint === undefined ? src.subscribe!(accept, { idle }) : src.resumeAfter!(checkpoint, accept, { idle });
  });
}
const checkpointOf = (store: SqliteEventStore) =>
  store.evidenceStatus(sessionId).sources.find((s) => s.sourceId === 'history')!.checkpoint!;
const count = (dir: string, sql: string) => {
  const db = new DatabaseSync(path.join(dir, 'store', 'vowe.sqlite'), { readOnly: true });
  try {
    return Number(db.prepare(sql).get()!.n);
  } finally {
    db.close();
  }
};

it(
  'resumes an append-only history by reading its new bytes, not the history',
  async () => {
    const dir = await setup();
    const file = path.join(dir, 'history.jsonl');
    const records = await history(file, SCALE ? 1024 * MB : 64 * MB);
    const store = await openStore(path.join(dir, 'store'));
    await drain(store, source(file));
    expect(store.lastSeq(sessionId)).toBe(records);
    const blobs = count(dir, 'SELECT COALESCE(SUM(length(body)),0) AS n FROM evidence_blobs');
    const journal = count(dir, 'SELECT COUNT(*) AS n FROM evidence_journal');

    // Restart: a new source resumes from the durable checkpoint.
    const appended = Array.from({ length: 4 }, (_, i) => JSON.stringify({ id: `a${i}`, n: `a${i}`, body: 'y'.repeat(200) }));
    await appendFile(file, appended.join('\n') + '\n');
    const appendedBytes = Buffer.byteLength(appended.join('\n') + '\n');
    const resumed = source(file);
    const batches: EvidenceBatch[] = [];
    await drain(store, resumed, checkpointOf(store), batches);
    expect(store.lastSeq(sessionId)).toBe(records + 4);
    expect(batches.every((b) => b.extends)).toBe(true);
    // New bytes, plus bounded anchors verifying this is still the same file.
    expect(resumed.stats.bytesRead).toBeLessThanOrEqual(appendedBytes + 3 * 64 * 1024);
    expect(count(dir, 'SELECT COUNT(*) AS n FROM evidence_journal') - journal).toBe(4);
    expect(count(dir, 'SELECT COALESCE(SUM(length(body)),0) AS n FROM evidence_blobs') - blobs).toBeLessThan(4 * 1024);

    // Unchanged on the next restart: a stat, no reading at all.
    const idle = source(file);
    await drain(store, idle, checkpointOf(store));
    expect(idle.stats.bytesRead).toBe(0);
  },
  SCALE ? 1_800_000 : 120_000,
);

const fixtures = [
  { name: 'claude-code', fixture: '../../replay/fixtures/vowe-session.sanitized.jsonl', Normalizer: TranscriptNormalizer, key: 'uuid' },
  { name: 'pi', fixture: '../../adapter-pi/test/fixtures/session.jsonl', Normalizer: PiSessionNormalizer, key: 'id' },
  {
    name: 'codex',
    fixture: '../../adapter-codex/test/fixtures/rollout-2026-09-24T12-54-21-01a0d456-eb96-7642-88e2-3308d95a1849.jsonl',
    Normalizer: CodexRolloutNormalizer,
    key: undefined,
  },
];
for (const { name, fixture, Normalizer, key } of fixtures)
  it(`${name} resumed mid-history normalizes exactly as a read from the start`, async () => {
    const dir = await setup();
    const text = await readFile(new URL(fixture, import.meta.url), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const file = path.join(dir, 'log.jsonl');
    const make = () =>
      jsonlEvidenceSource<Record<string, unknown>>({
        id: 'history',
        file: () => file,
        continuity: 'append-log',
        pollMs: 5,
        segment: { records: 7, bytes: 64 * 1024 },
        recordKey: key ? (r) => (typeof r[key] === 'string' ? (r[key] as string) : undefined) : undefined,
        normalizer: (source) => new Normalizer({ sessionId, source }),
      });
    await writeFile(file, lines.join('\n') + '\n');
    const whole = await openStore(path.join(dir, 'whole'));
    await drain(whole, make());
    const expected = whole.getEvents(sessionId).map((e) => [e.kind, e.summary, e.detail, e.rawRef]);

    const prefix = lines.slice(0, Math.floor(lines.length * 0.6)).join('\n') + '\n';
    await writeFile(file, prefix);
    const split = await openStore(path.join(dir, 'split'));
    await drain(split, make());
    await appendFile(file, lines.slice(Math.floor(lines.length * 0.6)).join('\n') + '\n');
    const resumed = make();
    await drain(split, resumed, checkpointOf(split));
    expect(split.getEvents(sessionId).map((e) => [e.kind, e.summary, e.detail, e.rawRef])).toEqual(expected);
    // The new bytes, plus anchors bounded by the smaller of 64 KiB and the prefix.
    const rest = Buffer.byteLength(lines.join('\n') + '\n') - Buffer.byteLength(prefix);
    expect(resumed.stats.bytesRead).toBeLessThanOrEqual(
      rest + 2 * Math.min(64 * 1024, Buffer.byteLength(prefix)) + 64 * 1024,
    );
  });

it('detects an append-only history rewritten in place and reconciles it whole', async () => {
  const dir = await setup();
  const file = path.join(dir, 'history.jsonl');
  const line = (id: string, text: string) => JSON.stringify({ id, text });
  await writeFile(file, [line('a', 'first'), line('b', 'second')].join('\n') + '\n');
  const store = await openStore(path.join(dir, 'store'));
  await drain(store, source(file));
  // Same length, different bytes at the head, then an append.
  await writeFile(file, [line('a', 'FIRST'), line('b', 'second'), line('c', 'third')].join('\n') + '\n');
  const batches: EvidenceBatch[] = [];
  await drain(store, source(file), checkpointOf(store), batches);
  expect(batches.some((b) => b.extends)).toBe(false);
  expect(store.evidenceStatus(sessionId).sources[0]!.coverage.reason).toContain('rewritten in place');
  expect(store.getEvents(sessionId).map((e) => e.summary)).toEqual(['second', 'FIRST', 'third']);
  expect(store.getEvents(sessionId, { audit: true }).find((e) => e.summary === 'first')?.supportStatus).toBe('superseded');
});

it(
  'ingests a history several times larger than the process heap, as a log and as a rewritten snapshot',
  async () => {
    const dir = await setup();
    const file = path.join(dir, 'history.jsonl');
    const records = await history(file, SCALE ? 1024 * MB : 160 * MB);
    const child = (continuity: string) =>
      run(
        process.execPath,
        [
          '--max-old-space-size=64',
          '--experimental-transform-types',
          '--no-warnings',
          '--import',
          new URL('./fixtures/ts-register.mjs', import.meta.url).pathname,
          new URL('./fixtures/ingest-child.mjs', import.meta.url).pathname,
          file,
          path.join(dir, 'store'),
          continuity,
        ],
        { maxBuffer: MB },
      ).then(({ stdout }) => JSON.parse(stdout) as { events: number; peakHeap: number });
    const first = await child('append-log');
    expect(first.events).toBe(records);
    expect(first.peakHeap).toBeLessThan(64 * MB);
    // Rewrite a record in the middle: a whole-snapshot reconciliation against
    // everything admitted, still within the same heap.
    const handle = await open(file, 'r+');
    try {
      const head = Buffer.alloc(4 * MB);
      await handle.read(head, 0, head.length, 0);
      const body = head.indexOf('"body":"', head.indexOf('"id":"r500"')) + '"body":"'.length;
      await handle.write('Y', body);
    } finally {
      await handle.close();
    }
    const second = await child('mutable-snapshot');
    expect(second.events).toBe(records + 1);
  },
  SCALE ? 1_800_000 : 180_000,
);
