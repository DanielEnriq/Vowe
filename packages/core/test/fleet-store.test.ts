import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseSync } from 'node:sqlite';

import { addCaptain, addNode, addWire, createCluster, emptyFleetLayout, type FleetLayout } from '../src/fleet/fleet-model.js';
import { databasePath } from '../src/store/sqlite/database.js';
import { MIGRATIONS, appliedVersions } from '../src/store/sqlite/migrations.js';
import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import { temporaryStore } from './helpers.js';

const PROJECT = 'git:fleet';

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function fixture() {
  const opened = await temporaryStore();
  cleanup = opened.cleanup;
  await opened.store.upsertProject({ id: PROJECT, name: 'payments-api', repoRoot: '/repo/payments', createdAt: '2026-10-01T00:00:00.000Z' });
  return opened;
}

function sample(): FleetLayout {
  let layout = addCaptain(emptyFleetLayout(), { id: 'cap', sessionId: 'claude-code:cap', x: 300, y: 60 }).layout;
  layout = addNode(layout, { id: 'a', sessionId: 'claude-code:a', x: 104, y: 254 }).layout;
  layout = addNode(layout, { id: 'b', sessionId: 'claude-code:b', x: 300, y: 254 }).layout;
  layout = addNode(layout, { id: 'todo', sessionId: null, label: 'Audit log index', x: 1060, y: 254 }).layout;
  layout = createCluster(layout, ['a', 'b'], 'Split the retry policy', 'Parallel · 2', 'k').layout;
  return addWire(layout, 'cap', 'a', 'w');
}

describe('fleet layout persistence', () => {
  it('reads an empty layout for a project that never saved one', async () => {
    const { store } = await fixture();
    expect(store.getFleetLayout(PROJECT)).toEqual(emptyFleetLayout());
    expect(store.getFleetLayout('git:unknown')).toEqual(emptyFleetLayout());
  });

  it('keeps positions, clusters and wires across a restart', async () => {
    const { store, reopen } = await fixture();
    const layout = sample();
    expect(await store.saveFleetLayout(PROJECT, layout)).toEqual(layout);
    const again = await reopen();
    expect(again.getFleetLayout(PROJECT)).toEqual(layout);
  });

  it('replaces the layout whole, the last save winning, and keeps projects apart', async () => {
    const { store, reopen } = await fixture();
    await store.upsertProject({ id: 'git:other', name: 'other', repoRoot: '/repo/other', createdAt: '2026-10-01T00:00:00.000Z' });
    const first = sample();
    const second = { ...first, nodes: first.nodes.map((node) => (node.id === 'a' ? { ...node, x: 9, y: 9 } : node)) };
    const third = { ...second, wires: [] };
    await Promise.all([store.saveFleetLayout(PROJECT, first), store.saveFleetLayout(PROJECT, second), store.saveFleetLayout(PROJECT, third)]);
    await store.saveFleetLayout('git:other', emptyFleetLayout());
    const again = await reopen();
    expect(again.getFleetLayout(PROJECT)).toEqual(third);
    expect(again.getFleetLayout('git:other')).toEqual(emptyFleetLayout());
  });

  it('announces a save only once a re-read sees it', async () => {
    const { store } = await fixture();
    const seen: FleetLayout[] = [];
    const off = store.onFleetLayoutChanged((change) => {
      expect(change).toEqual({ projectId: PROJECT });
      seen.push(store.getFleetLayout(change.projectId));
    });
    const layout = sample();
    await store.saveFleetLayout(PROJECT, layout);
    off();
    await store.saveFleetLayout(PROJECT, emptyFleetLayout());
    expect(seen).toEqual([layout]);
  });

  it('survives a throwing listener and reports it', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    await opened.store.close();
    const errors: string[] = [];
    const store = new SqliteEventStore(opened.root, { onError: (scope) => errors.push(scope) });
    await store.init();
    await store.upsertProject({ id: PROJECT, name: 'p', repoRoot: '/repo/p', createdAt: '2026-10-01T00:00:00.000Z' });
    store.onFleetLayoutChanged(() => {
      throw new Error('boom');
    });
    await store.saveFleetLayout(PROJECT, sample());
    expect(errors).toEqual(['fleet-layout-listener']);
    expect(store.getFleetLayout(PROJECT)).toEqual(sample());
    await store.close();
  });

  it('normalises what it stores and what it reads, and never throws on bad JSON', async () => {
    const { store, root, reopen } = await fixture();
    const broken = { ...sample(), wires: [...sample().wires, { id: 'x', captainId: 'a', agentId: 'cap' }] };
    const stored = await store.saveFleetLayout(PROJECT, broken);
    expect(stored).toEqual(sample());
    await store.close();
    const db = new DatabaseSync(databasePath(root));
    db.prepare('UPDATE fleet_layouts SET layout_json = ? WHERE project_id = ?').run('{not json', PROJECT);
    db.close();
    const again = await reopen();
    expect(again.getFleetLayout(PROJECT)).toEqual(emptyFleetLayout());
  });

  it('refuses a layout for a project that does not exist, and announces nothing', async () => {
    const { store } = await fixture();
    let heard = 0;
    store.onFleetLayoutChanged(() => {
      heard += 1;
    });
    await expect(store.saveFleetLayout('git:nowhere', sample())).rejects.toThrow();
    expect(heard).toBe(0);
    expect(store.getFleetLayout('git:nowhere')).toEqual(emptyFleetLayout());
  });

  it('migrates an older database forward without touching what it held', async () => {
    const opened = await temporaryStore();
    cleanup = opened.cleanup;
    await opened.store.close();
    const old = new SqliteEventStore(opened.root, { migrations: MIGRATIONS.filter((m) => m.version <= 17) });
    await old.init();
    await old.upsertProject({ id: PROJECT, name: 'payments-api', repoRoot: '/repo/payments', createdAt: '2026-10-01T00:00:00.000Z' });
    await old.close();

    const store = await opened.reopen();
    expect((await store.listProjects()).map((project) => project.id)).toEqual([PROJECT]);
    expect(store.getFleetLayout(PROJECT)).toEqual(emptyFleetLayout());
    await store.saveFleetLayout(PROJECT, sample());
    expect(store.getFleetLayout(PROJECT)).toEqual(sample());

    const db = new DatabaseSync(databasePath(opened.root));
    expect(appliedVersions(db)).toContain(19);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'fleet_layouts'").get() as { sql: string };
    expect(table.sql).toMatch(/STRICT/);
    db.close();
  });
});
