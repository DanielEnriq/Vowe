// Ingest one JSONL history into a fresh store under whatever heap limit the
// parent set, then report. Succeeds only if acquisition streams.
const [file, root, continuity] = process.argv.slice(2);
const { SqliteEventStore } = await import('@vowe/core');
const { jsonlEvidenceSource } = await import('@vowe/adapter-kit');
const store = new SqliteEventStore(root);
await store.init();
const sessionId = 'scale:child';
const now = new Date().toISOString();
await store.upsertSession({
  id: sessionId, provider: 'scale', providerSessionId: 'child', attachMode: 'external-idle', task: null,
  displayLabel: 'scale', cwd: null, projectId: null, status: 'unknown', createdAt: now, lastActivityAt: now,
  semanticState: null,
  capabilities: { observe: true, reasoning: false, sendInstruction: false, interrupt: false, resume: false, launch: false },
});
const source = jsonlEvidenceSource({
  id: 'history',
  file: () => file,
  continuity,
  normalizer: (source) => ({
    normalize: (line) => [{
      sessionId, at: now, kind: 'agent_message', summary: String(line.record.n),
      raw: line.record, rawRef: { source, byteOffset: line.byteOffset, line: line.line },
    }],
  }),
});
let peak = 0;
const sample = () => (peak = Math.max(peak, process.memoryUsage().heapUsed));
const timer = setInterval(sample, 10);
await new Promise((resolve) => {
  const stop = source.subscribe(async (batch) => {
    await store.ingestEvidence(sessionId, batch);
    sample();
  }, { idle: () => { stop(); resolve(); } });
});
clearInterval(timer);
process.stdout.write(JSON.stringify({ events: store.lastSeq(sessionId), bytesRead: source.stats.bytesRead, peakHeap: peak }));
await store.close();
