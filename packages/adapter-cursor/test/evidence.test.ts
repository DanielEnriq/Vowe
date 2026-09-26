import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SqliteEventStore, SessionRegistry } from '@vowe/core';
import { CursorAdapter } from '../src/adapter.js';
import { captureHook } from '../src/collector.js';
import { hookRecord } from '../src/normalize.js';

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
let root: string, store: SqliteEventStore, registry: SessionRegistry | undefined;
afterEach(async () => {
  await registry?.stop();
  registry = undefined;
  await store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), 'vowe-cursor-'));
  store = new SqliteEventStore(path.join(root, 'store'));
  await store.init();
  const captureDir = path.join(root, 'hooks'),
    transcript = path.join(root, 'transcript.jsonl');
  const raw = (await fixture('hooks.sanitized.jsonl'))
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x) as { receivedAt: string; payload: Record<string, unknown> });
  const parent = String(
    raw.find((r) => r.payload.hook_event_name === 'sessionStart')!.payload.conversation_id,
  );
  for (const r of raw)
    captureHook(
      JSON.stringify({
        ...r.payload,
        transcript_path: r.payload.conversation_id === parent ? transcript : null,
      }),
      captureDir,
    );
  await writeFile(transcript, await fixture('transcript-before.sanitized.jsonl'));
  const adapter = new CursorAdapter({ captureDir, pollMs: 10 });
  const sessions = await adapter.discoverSessions();
  for (const session of sessions) await store.upsertSession(session);
  return { adapter, sessions, transcript, id: `cursor:${parent}`, raw };
}
describe('real captured Cursor evidence', () => {
  it('recovers the rewritten prompt after restart without duplicating historical text or edits', async () => {
    const { adapter, id, transcript } = await setup();
    for (const source of adapter.evidenceSources(id.slice(7)))
      await store.ingestEvidence(id, await source.read!());
    const before = store.getEvents(id),
      edits = before.filter((e) => e.kind === 'file_changed');
    expect(edits).toHaveLength(1);
    await store.close();
    store = new SqliteEventStore(path.join(root, 'store'));
    await store.init();
    await writeFile(transcript, await fixture('transcript-after.sanitized.jsonl'));
    for (const source of adapter.evidenceSources(id.slice(7)))
      await store.ingestEvidence(id, await source.read!());
    const after = store.getEvents(id);
    expect(after.filter((e) => e.kind === 'user_instruction')).toHaveLength(
      before.filter((e) => e.kind === 'user_instruction').length + 1,
    );
    expect(after.filter((e) => e.kind === 'file_changed')).toHaveLength(1);
    for (const event of before) expect(after.some((e) => e.id === event.id)).toBe(true);
    expect(
      after.filter((e) => e.kind === 'test_finished' || e.kind === 'command_finished'),
    ).toHaveLength(0);
    expect(store.evidenceStatus(id).sources).toHaveLength(2);
  });
  it('keeps capabilities truthful and unlinked child identity out of the session list', async () => {
    const { sessions, raw } = await setup();
    expect(new Set(raw.map((r) => r.payload.conversation_id)).size).toBe(2);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.capabilities).toEqual({
      observe: true,
      reasoning: true,
      sendInstruction: false,
      interrupt: false,
      resume: false,
      launch: false,
    });
  });
  it('the captured rejected-shell successes remain unverified reports', async () => {
    const { raw } = await setup();
    const successes = raw.filter(
      (r) =>
        r.payload.hook_event_name === 'postToolUse' &&
        r.payload.tool_name === 'Shell' &&
        String(r.payload.tool_output).includes('exitCode'),
    );
    expect(successes.length).toBeGreaterThan(0);
    for (const r of successes) {
      const record = hookRecord(r.payload, 'receipt', 'capture', r.receivedAt, 'cursor:parent');
      expect(record.events[0]!.event.kind).toBe('operation_reported');
      expect(record.events[0]!.execution).toBe('unknown');
    }
  });
  it('feeds the same registry path during concurrent hook and snapshot catch-up', async () => {
    const { adapter, id } = await setup();
    registry = new SessionRegistry({ store, reconcileIntervalMs: 10000 });
    registry.registerAdapter(adapter);
    await registry.start();
    await expect.poll(() => store.evidenceStatus(id).sources.length).toBe(2);
    expect(store.getEvents(id).some((e) => e.kind === 'agent_reasoning')).toBe(true);
    expect(store.getEvents(id).some((e) => e.kind === 'user_instruction')).toBe(true);
  });
});

it('retains explicitly linked child work as actor evidence in the parent execution', async () => {
  const { adapter, id } = await setup();
  const parentCwd=(await adapter.getSession(id.slice(7)))!.cwd;
  captureHook(
    JSON.stringify({
      conversation_id: 'linked-child',
      parent_conversation_id: id.slice(7),
      hook_event_name: 'sessionStart',
    }),
    path.join(root, 'hooks'),
  );
  captureHook(
    JSON.stringify({
      conversation_id: 'linked-child',
      parent_conversation_id: id.slice(7),
      hook_event_name: 'afterAgentThought',
      text: 'Child investigation',
    }),
    path.join(root, 'hooks'),
  );
  expect(await adapter.discoverSessions()).toHaveLength(1);
  expect((await adapter.getSession(id.slice(7)))!.cwd).toBe(parentCwd);
  const batch = await adapter.evidenceSources(id.slice(7))[0]!.read!();
  await store.ingestEvidence(id, batch);
  expect(
    store
      .getEvents(id)
      .some((e) => e.detail?.actorId === 'linked-child' && e.kind === 'agent_reasoning'),
  ).toBe(true);
});
