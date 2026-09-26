import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jsonlEvidenceSource } from '../src/evidence-source.js';
import { TranscriptNormalizer } from '@vowe/adapter-claude-code';
import { PiSessionNormalizer } from '@vowe/adapter-pi';
import { CodexRolloutNormalizer } from '@vowe/adapter-codex';
import { SqliteEventStore } from '@vowe/core';

let root: string, store: SqliteEventStore;
afterEach(async () => {
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), 'vowe-source-'));
  store = new SqliteEventStore(path.join(root, 'store'));
  await store.init();
  return path.join(root, 'source.jsonl');
}
const fixtures = [
  {
    provider: 'claude-code',
    fixture: '../../replay/fixtures/vowe-session.sanitized.jsonl',
    Normalizer: TranscriptNormalizer,
    key: 'uuid',
  },
  {
    provider: 'pi',
    fixture: '../../adapter-pi/test/fixtures/session.jsonl',
    Normalizer: PiSessionNormalizer,
    key: 'id',
  },
  {
    provider: 'codex',
    fixture:
      '../../adapter-codex/test/fixtures/rollout-2026-09-24T12-54-21-01a0d456-eb96-7642-88e2-3308d95a1849.jsonl',
    Normalizer: CodexRolloutNormalizer,
    key: undefined,
  },
];
for (const { provider, fixture, Normalizer, key } of fixtures)
  it(`${provider} retains legacy normalization, sibling ordinals and citation IDs across adoption/restart`, async () => {
    const file = await setup();
    await writeFile(file, await readFile(new URL(fixture, import.meta.url), 'utf8'));
    const sessionId = `${provider}:fixture`;
    const source = jsonlEvidenceSource({
      id: 'log',
      file: () => file,
      interpret: (event) =>
        ['command_finished', 'test_finished'].includes(event.kind) ? { execution: 'executed' } : {},
      recordKey: key
        ? (r) => (typeof r[key] === 'string' ? (r[key] as string) : undefined)
        : undefined,
      normalizer: (source) => new Normalizer({ sessionId, source }),
    });
    const capture = await source.read!();
    const candidates = capture.records.flatMap((r) => r.events.map((c) => c.event));
    expect(candidates.length).toBeGreaterThan(10);
    const legacy = [];
    for (const e of candidates) {
      const saved = await store.appendEvent(sessionId, e);
      if (saved) legacy.push(saved);
    }
    expect(legacy).toHaveLength(candidates.length);
    await store.ingestEvidence(sessionId, capture);
    expect(store.getEvents(sessionId).map((e) => e.id)).toEqual(legacy.map((e) => e.id));
    await store.close();
    store = new SqliteEventStore(path.join(root, 'store'));
    await store.init();
    await store.ingestEvidence(sessionId, { ...capture, captureId: 'fresh-acquisition' });
    expect(store.getEvents(sessionId).map((e) => [e.kind, e.summary, e.rawRef])).toEqual(
      legacy.map((e) => [e.kind, e.summary, { ...e.rawRef, ordinal: e.rawRef.ordinal ?? 0 }]),
    );
    expect(
      store.getEvents(sessionId).every((e) => store.evidenceProvenance(sessionId, e.id).length > 0),
    ).toBe(true);
  });

it('handles same-size replacement, growing rewrite, truncate, loss and A→B→A without byte cursors', async () => {
  const file = await setup(),
    sessionId = 'source:test';
  const source = jsonlEvidenceSource({
    id: 'history',
    file: () => file,
    recordKey: (r) => String(r.id),
    normalizer: (source) => ({
      normalize: (line) => [
        {
          sessionId,
          at: '2026-01-01T00:00:00Z',
          kind: 'agent_message',
          summary: String(line.record.text),
          raw: line.record,
          rawRef: { source, byteOffset: line.byteOffset, line: line.line },
        },
      ],
    }),
  });
  const write = async (records: unknown[]) => {
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await store.ingestEvidence(sessionId, await source.read!());
  };
  await write([{ id: '1', text: 'A' }]);
  await write([{ id: '1', text: 'B' }]);
  await write([{ id: '1', text: 'A' }]);
  expect(store.getEvents(sessionId).map((e) => e.summary)).toEqual(['A']);
  expect(store.getEvents(sessionId, { audit: true })).toHaveLength(3);
  await write([
    { id: 'new', text: 'new prompt' },
    { id: '1', text: 'A' },
    { id: 'end', text: 'end' },
  ]);
  expect(store.getEvents(sessionId)).toHaveLength(3);
  await rm(file);
  await store.ingestEvidence(sessionId, await source.read!());
  expect(store.evidenceStatus(sessionId).sources[0]!.coverage.status).toBe('unavailable');
  await write([{ id: '1', text: 'A' }]);
  expect(store.getEvents(sessionId)).toHaveLength(3);
  expect(store.evidenceStatus(sessionId).sources[0]!.coverage.status).toBe('partial');
});

it('retains malformed bytes and names an incomplete tail while admitting only completed records', async () => {
  const file = await setup();
  const source = jsonlEvidenceSource({
    id: 'log',
    file: () => file,
    normalizer: () => ({ normalize: () => [] }),
  });
  await writeFile(file, '{"ok":1}\nnot json\n{"pending":');
  const b = await source.read!();
  expect(b.records).toHaveLength(2);
  expect(b.records[1]!.raw).toBe('not json');
  expect(b.coverage.reason).toContain('could not be decoded');
  // The incomplete tail is named in coverage and captured once it completes.
  expect(b.coverage.reason).toContain('Incomplete trailing record');
  expect(b.through?.byteOffset).toBe('{"ok":1}\nnot json\n'.length);
});
