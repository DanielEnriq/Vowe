// Evidence acquisition budget, for comparing changes to the evidence layer.
//
//   pnpm run build:packages
//   node --max-old-space-size=64 packages/adapter-kit/bench/evidence-bench.mjs [megabytes]
//
// Reports fixture size, first-acquisition time and throughput, peak heap and
// RSS, bytes read and persisted by a resumed 1 KiB append, and restart cost.
import { mkdtemp, open, appendFile, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { SqliteEventStore } from '@vowe/core';
import { jsonlEvidenceSource } from '../dist/index.js';

const MB = 1024 * 1024;
const size = Number(process.argv[2] ?? 256) * MB;
const dir = await mkdtemp(path.join(os.tmpdir(), 'vowe-bench-'));
const file = path.join(dir, 'history.jsonl');
const sessionId = 'bench:session';

let n = 0;
const handle = await open(file, 'w');
for (let written = 0; written < size; ) {
  const lines = [];
  for (let i = 0; i < 1000; i++, n++)
    lines.push(JSON.stringify({ id: `r${n}`, n, body: 'x'.repeat(n % 997 === 0 ? 4 * MB : 400 + (n % 1500)) }));
  const chunk = lines.join('\n') + '\n';
  await handle.write(chunk);
  written += Buffer.byteLength(chunk);
}
await handle.close();

const peak = { rss: 0, heapUsed: 0 };
const sample = () => {
  const m = process.memoryUsage();
  peak.rss = Math.max(peak.rss, m.rss);
  peak.heapUsed = Math.max(peak.heapUsed, m.heapUsed);
};
const timer = setInterval(sample, 10);
const store = new SqliteEventStore(path.join(dir, 'store'));
await store.init();
const source = () =>
  jsonlEvidenceSource({
    id: 'history',
    file: () => file,
    continuity: 'append-log',
    recordKey: (r) => r.id,
    normalizer: (at) => ({
      normalize: (line) => [
        {
          sessionId,
          at: '2026-01-01T00:00:00Z',
          kind: 'agent_message',
          summary: String(line.record.n),
          raw: line.record,
          rawRef: { source: at, byteOffset: line.byteOffset, line: line.line },
        },
      ],
    }),
  });
const drain = (src, checkpoint) =>
  new Promise((resolve, reject) => {
    const accept = (batch) => store.ingestEvidence(sessionId, batch).then(sample, (e) => (reject(e), Promise.reject(e)));
    const idle = () => (stop(), resolve());
    const stop = checkpoint ? src.resumeAfter(checkpoint, accept, { idle }) : src.subscribe(accept, { idle });
  });
const checkpoint = () => store.evidenceStatus(sessionId).sources[0].checkpoint;
const persisted = () => {
  const db = new DatabaseSync(path.join(dir, 'store', 'vowe.sqlite'), { readOnly: true });
  try {
    return Number(db.prepare('SELECT COALESCE(SUM(length(body)),0) AS n FROM evidence_blobs').get().n);
  } finally {
    db.close();
  }
};

let t = performance.now();
await drain(source());
const firstMs = performance.now() - t;
const before = persisted();
await appendFile(file, JSON.stringify({ id: 'appended', n: 'appended', body: 'y'.repeat(1000) }) + '\n');
const resumed = source();
t = performance.now();
await drain(resumed, checkpoint());
const appendMs = performance.now() - t;
const idle = source();
t = performance.now();
await drain(idle, checkpoint());
const restartMs = performance.now() - t;
clearInterval(timer);

console.table({
  'fixture MB': ((await stat(file)).size / MB).toFixed(0),
  records: n + 1,
  'first acquisition s': (firstMs / 1000).toFixed(1),
  'records/s': Math.round(n / (firstMs / 1000)),
  'peak heap MB': (peak.heapUsed / MB).toFixed(0),
  'peak RSS MB': (peak.rss / MB).toFixed(0),
  'append: bytes read': resumed.stats.bytesRead,
  'append: bytes persisted': persisted() - before,
  'append ms': appendMs.toFixed(0),
  'restart: bytes read': idle.stats.bytesRead,
  'restart ms': restartMs.toFixed(0),
  events: store.lastSeq(sessionId),
});
await store.close();
await rm(dir, { recursive: true, force: true });
