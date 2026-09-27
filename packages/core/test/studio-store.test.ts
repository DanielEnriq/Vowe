import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseSync } from 'node:sqlite';

import { databasePath } from '../src/store/sqlite/database.js';
import { MIGRATIONS } from '../src/store/sqlite/migrations.js';
import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import type { DesignEntry, DesignRevision } from '../src/studio/types.js';
import { temporaryStore } from './helpers.js';

const PROJECT = 'git:studio';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function fixture() {
  const opened = await temporaryStore();
  cleanup = opened.cleanup;
  await opened.store.upsertProject({
    id: PROJECT,
    name: 'Vowe',
    repoRoot: '/repo/vowe',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  const design = await opened.store.createDesign({
    id: 'design-1',
    projectId: PROJECT,
    createdAt: '2026-09-26T10:00:00.000Z',
  });
  return { ...opened, design };
}

function entry(overrides: Partial<DesignEntry> = {}): DesignEntry {
  return {
    id: randomUUID(),
    designId: 'design-1',
    at: '2026-09-26T10:01:00.000Z',
    role: 'user_message',
    text: 'I think Project Understanding should sit above the observer.',
    ...overrides,
  };
}

function revision(entryId: string, overrides: Partial<Omit<DesignRevision, 'ord'>> = {}) {
  return {
    id: randomUUID(),
    designId: 'design-1',
    at: '2026-09-26T10:02:00.000Z',
    document: '# Project Understanding\n\nAbove the observer.',
    summary: 'Placed Project Understanding above the per-session observer.',
    entryId,
    ...overrides,
  };
}

describe('Studio persistence', () => {
  it('keeps a Studio 0 design readable as a document when the model columns arrive', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    await opened.store.close();
    const old = new SqliteEventStore(opened.root, { migrations: MIGRATIONS.filter((m) => m.version <= 16) });
    await old.init();
    await old.close();
    // Rows written exactly as Studio 0 shaped them.
    const db = new DatabaseSync(databasePath(opened.root));
    db.exec(`INSERT INTO designs (id, project_id, created_at) VALUES ('d0', '${PROJECT}', '2026-09-25T00:00:00.000Z');
      INSERT INTO design_entries (id, design_id, ord, at, role, text) VALUES ('e0', 'd0', 1, '2026-09-25T00:00:01.000Z', 'companion_message', 'Drafted.');
      INSERT INTO design_revisions (id, design_id, ord, at, document, summary, entry_id) VALUES ('r0', 'd0', 1, '2026-09-25T00:00:01.000Z', '# Old design', 'why', 'e0');`);
    db.close();

    const store = await opened.reopen();
    const [revision] = store.getDesignRevisions('d0');
    expect(revision).toEqual({ id: 'r0', designId: 'd0', ord: 1, at: '2026-09-25T00:00:01.000Z', document: '# Old design', summary: 'why', entryId: 'e0' });
    expect(store.getDesignEntries('d0')[0]).not.toHaveProperty('anchor');
    expect(store.getDesignLayout('d0')).toEqual({});
  });

  it('keeps the model, move and layout of a revision across a restart', async () => {
    const { store, reopen } = await fixture();
    const reply = entry({ role: 'companion_message', text: 'Drew it.' });
    const model = { title: 'T', intent: '', parts: [{ id: 'a', name: 'A', role: '', today: null }], links: [], duties: [] };
    const move = { id: 'mv-00000001', ops: [{ op: 'part' as const, id: 'a', name: 'A' }], summary: 's', author: 'vowe' as const, via: 'conversation' as const };
    await store.commitDesignTurn(reply, revision(reply.id, { model, move }), { a: { row: 0, col: 0 } });
    await store.commitDesignTurn(entry({ role: 'companion_note', text: 'n', anchor: { moveId: move.id, on: 'a' } }));
    const again = await reopen();
    expect(again.getDesignRevisions('design-1')[0]).toMatchObject({ model, move });
    expect(again.getDesignLayout('design-1')).toEqual({ a: { row: 0, col: 0 } });
    expect(again.getDesignEntries('design-1').at(-1)!.anchor).toEqual({ moveId: move.id, on: 'a' });
  });

  it('migrates a 015 database forward without touching what it held', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    await opened.store.close();

    const old = new SqliteEventStore(opened.root, { migrations: MIGRATIONS.filter((m) => m.version <= 15) });
    await old.init();
    await old.upsertProject({ id: PROJECT, name: 'Vowe', repoRoot: '/repo/vowe', createdAt: '2026-09-01T00:00:00.000Z' });
    await old.appendProjectConversationEntry({
      id: 'asked', projectId: PROJECT, at: '2026-09-01T00:00:00.000Z', role: 'user_question', text: 'status?',
    });
    await old.close();

    const store = await opened.reopen();
    expect(store.getProjectConversation(PROJECT).map((row) => row.id)).toEqual(['asked']);
    const design = await store.createDesign({ id: 'd', projectId: PROJECT, createdAt: '2026-09-26T00:00:00.000Z' });
    expect(store.getDesign('d')).toEqual(design);
  });

  it('keeps entries and revisions in order, gap-free, across a restart', async () => {
    const { store, reopen } = await fixture();
    const first = await store.appendDesignEntry(entry());
    const reply = entry({ role: 'companion_message', text: 'That fits conceptually.' });
    const one = await store.commitDesignTurn(reply, revision(reply.id));
    await store.appendDesignEntry(entry({ text: 'And persistence?' }));
    const second = entry({ role: 'companion_message', text: 'Checked it.' });
    const two = await store.commitDesignTurn(second, revision(second.id, { document: '# v2' }));
    await Promise.all([1, 2, 3].map((n) => store.appendDesignEntry(entry({ text: `burst ${n}` }))));

    expect(one.revision?.ord).toBe(1);
    expect(two.revision?.ord).toBe(2);

    const again = await reopen();
    expect(again.getDesign('design-1')?.projectId).toBe(PROJECT);
    expect(again.listDesigns(PROJECT).map((design) => design.id)).toEqual(['design-1']);
    const entries = again.getDesignEntries('design-1');
    expect(entries[0]).toEqual(first);
    expect(entries).toHaveLength(7);
    expect(again.getDesignEntries('design-1', 2).map((row) => row.text)).toEqual(['burst 2', 'burst 3']);
    const revisions = again.getDesignRevisions('design-1');
    expect(revisions.map((row) => [row.ord, row.document, row.entryId])).toEqual([
      [1, '# Project Understanding\n\nAbove the observer.', reply.id],
      [2, '# v2', second.id],
    ]);
  });

  it('commits a reply and its revision together, or neither', async () => {
    const { store } = await fixture();
    const reply = entry({ role: 'companion_message', text: 'First.' });
    const kept = await store.commitDesignTurn(reply, revision(reply.id));

    const doomed = entry({ role: 'companion_message', text: 'This reply must not survive.' });
    // A revision id that already exists: the insert fails inside the transaction.
    await expect(
      store.commitDesignTurn(doomed, revision(doomed.id, { id: kept.revision!.id })),
    ).rejects.toThrow();

    expect(store.getDesignEntries('design-1').map((row) => row.text)).toEqual(['First.']);
    expect(store.getDesignRevisions('design-1')).toHaveLength(1);
  });

  it('refuses a revision that does not belong to the reply it is committed with', async () => {
    const { store } = await fixture();
    const reply = entry({ role: 'companion_message' });
    await expect(store.commitDesignTurn(reply, revision('someone-else'))).rejects.toThrow(/belong/);
    expect(store.getDesignEntries('design-1')).toEqual([]);
  });

  it('never shows a design turn to Project Ask', async () => {
    const { store } = await fixture();
    await store.appendDesignEntry(entry({ text: 'Maybe we should replace SQLite.' }));
    const reply = entry({ role: 'companion_message', text: 'Let us think about it.' });
    await store.commitDesignTurn(reply, revision(reply.id));
    expect(store.getProjectConversation(PROJECT)).toEqual([]);
  });

  it('notifies only after the write is readable', async () => {
    const { store } = await fixture();
    const seen: string[][] = [];
    store.onDesignChanged((change) => {
      expect(change.projectId).toBe(PROJECT);
      seen.push(store.getDesignEntries(change.designId).map((row) => row.text));
    });
    await store.appendDesignEntry(entry({ text: 'hello' }));
    expect(seen).toEqual([['hello']]);
  });

  it('has no way to change or remove a revision', async () => {
    const source = await readFile(new URL('../src/store/sqlite-event-store.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/UPDATE\s+design_revisions|DELETE\s+FROM\s+design_revisions/i);
    const methods = Object.getOwnPropertyNames(SqliteEventStore.prototype).filter((name) => /revision/i.test(name));
    expect(methods).toEqual(['getDesignRevisions']);
  });
});
