import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { folderLabelFor } from '../src/product/projections.js';
import { ProjectService } from '../src/projects/project-service.js';
import type { Project } from '../src/projects/project.js';
import { databasePath } from '../src/store/sqlite/database.js';
import { MIGRATIONS } from '../src/store/sqlite/migrations.js';
import { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import type { AgentSession } from '../src/types/session.js';
import { GitFixtures } from './git-fixtures.js';
import { temporaryStore, testSession } from './helpers.js';

const git = new GitFixtures();
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
  await git.cleanup();
});

async function fixture() {
  const created = await temporaryStore();
  cleanups.push(created.cleanup);
  return created;
}

const RECORD = {
  id: 'p1',
  name: 'payments-api',
  repoRoot: '/code/payments-api',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('Project folders and names in the store', () => {
  it('gives every project its root as the default folder', async () => {
    const { store } = await fixture();
    await store.upsertProject(RECORD);
    expect(store.getProject('p1')?.folders).toEqual([
      { path: '/code/payments-api', isDefault: true, addedAt: RECORD.createdAt },
    ]);
  });

  it('keeps a name, folders and removal across a restart', async () => {
    const { store, reopen } = await fixture();
    await store.upsertProject(RECORD);
    await store.setProjectName('p1', 'Payments');
    await store.addProjectFolder('p1', '/code/web-console');

    let restarted = await reopen();
    expect(restarted.getProject('p1')).toMatchObject({
      name: 'Payments',
      displayName: 'Payments',
      folders: [
        { path: '/code/payments-api', isDefault: true },
        { path: '/code/web-console', isDefault: false },
      ],
    });

    await restarted.setProjectOpen('p1', true);
    await restarted.setProjectRemoved('p1', true);
    restarted = await reopen();
    const removed = restarted.getProject('p1')!;
    expect(removed.removedAt).toEqual(expect.any(String));
    // Removing closes it too.
    expect(removed.openedAt).toBeUndefined();

    // Opening is a deliberate act, and brings it back.
    await restarted.setProjectOpen('p1', true);
    expect(restarted.getProject('p1')?.removedAt).toBeUndefined();
  });

  it('is not renamed, refoldered or restored by discovery', async () => {
    const { store } = await fixture();
    await store.upsertProject(RECORD);
    await store.setProjectName('p1', 'Payments');
    await store.addProjectFolder('p1', '/code/web-console');
    await store.setProjectRemoved('p1', true);
    await store.upsertProject({ ...RECORD, name: 'payments-api-2' });

    const project = store.getProject('p1')!;
    expect(project.name).toBe('Payments');
    expect(project.folders).toHaveLength(2);
    expect(project.removedAt).toEqual(expect.any(String));
  });

  it('goes back to the derived name when the override is cleared', async () => {
    const { store } = await fixture();
    await store.upsertProject(RECORD);
    await store.setProjectName('p1', 'Payments');
    await store.setProjectName('p1', null);
    const project = store.getProject('p1')!;
    expect(project.name).toBe('payments-api');
    expect(project).not.toHaveProperty('displayName');
  });

  it('never removes the default folder', async () => {
    const { store } = await fixture();
    await store.upsertProject(RECORD);
    await store.addProjectFolder('p1', '/code/web-console');
    expect(await store.removeProjectFolder('p1', '/code/payments-api')).toBe(false);
    expect(await store.removeProjectFolder('p1', '/code/web-console')).toBe(true);
    expect(store.getProject('p1')?.folders.map((folder) => folder.path)).toEqual([
      '/code/payments-api',
    ]);
  });

  it('tells a listener only after the write can be read', async () => {
    const { store } = await fixture();
    await store.upsertProject(RECORD);
    const seen: (Project | null)[] = [];
    const off = store.onProjectsChanged((projectId) => seen.push(store.getProject(projectId)));

    await store.setProjectName('p1', 'Payments');
    await store.addProjectFolder('p1', '/code/web-console');
    await store.setProjectRemoved('p1', true);
    off();
    await store.setProjectRemoved('p1', false);

    expect(seen.map((project) => project?.name)).toEqual(['Payments', 'Payments', 'Payments']);
    expect(seen[1]?.folders).toHaveLength(2);
    expect(seen[2]?.removedAt).toEqual(expect.any(String));
    expect(seen).toHaveLength(3);
  });

  it('migrates a 017 database, giving each project its root as its folder', async () => {
    // A directory of its own: a temporary store is already at the latest version.
    const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-017-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const old = new SqliteEventStore(root, {
      migrations: MIGRATIONS.filter((migration) => migration.version <= 17),
    });
    await old.init();
    await old.close();
    // Written exactly as a 017 store shaped it.
    const db = new DatabaseSync(databasePath(root));
    db.exec(`INSERT INTO projects (id, name, repo_root, created_at, opened_at)
      VALUES ('p1', 'payments-api', '/code/payments-api', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');`);
    db.close();

    const store = new SqliteEventStore(root);
    await store.init();
    cleanups.unshift(() => store.close());
    const project = store.getProject('p1')!;
    expect(project).toMatchObject({ name: 'payments-api', openedAt: '2026-09-02T00:00:00.000Z' });
    expect(project).not.toHaveProperty('displayName');
    expect(project).not.toHaveProperty('removedAt');
    expect(project.folders).toEqual([
      { path: '/code/payments-api', isDefault: true, addedAt: '2026-09-01T00:00:00.000Z' },
    ]);
  });
});

function sessionIn(id: string, cwd: string, overrides: Partial<AgentSession> = {}) {
  return testSession({ id, providerSessionId: id, cwd, ...overrides });
}

async function harness() {
  const created = await fixture();
  const service = new ProjectService({ store: created.store, listSessions: () => [] });
  return { ...created, service };
}

describe('ProjectService — creating, naming and removing projects', () => {
  it('creates a project from a folder and a name, opened', async () => {
    const repo = await git.repo('payments-api');
    const { service } = await harness();

    const project = await service.createProject({ name: 'Payments', folder: repo });
    expect(project).toMatchObject({ name: 'Payments', displayName: 'Payments' });
    expect(project.openedAt).toEqual(expect.any(String));
    expect(project.folders).toEqual([
      expect.objectContaining({ path: project.repoRoot, isDefault: true }),
    ]);
    expect(service.listProjectsForDisplay().map((item) => item.id)).toEqual([project.id]);
  });

  it('keeps the derived name when the given one says nothing new', async () => {
    const repo = await git.repo('payments-api');
    const { service } = await harness();
    const project = await service.createProject({ name: ' payments-api ', folder: repo });
    expect(project.name).toBe('payments-api');
    expect(project).not.toHaveProperty('displayName');
  });

  it('renames, and an empty name goes back to the derived one', async () => {
    const repo = await git.repo('payments-api');
    const { service } = await harness();
    const project = await service.createProject({ name: 'payments-api', folder: repo });

    expect((await service.renameProject(project.id, 'Payments')).name).toBe('Payments');
    expect((await service.renameProject(project.id, '  ')).name).toBe('payments-api');
  });

  it('hides a removed project across a restart, and restores it when created again', async () => {
    const [repo, extra] = await Promise.all([git.repo('payments-api'), git.plainDirectory('docs')]);
    const { service, reopen } = await harness();
    const project = await service.createProject({ name: 'Payments', folder: repo, folders: [extra] });

    await service.removeProject(project.id);
    expect(service.listProjectsForDisplay()).toEqual([]);

    const restarted = new ProjectService({ store: await reopen(), listSessions: () => [] });
    expect(restarted.listProjectsForDisplay()).toEqual([]);
    expect(restarted.getProject(project.id)?.removedAt).toEqual(expect.any(String));

    const again = await restarted.createProject({ name: 'Payments', folder: repo });
    expect(again.id).toBe(project.id);
    expect(again.removedAt).toBeUndefined();
    // It comes back with what it had.
    expect(again.folders).toHaveLength(2);
    expect(restarted.listProjectsForDisplay().map((item) => item.id)).toEqual([project.id]);
  });

  it('adds and removes folders, but never the root', async () => {
    const [repo, extra] = await Promise.all([git.repo('payments-api'), git.plainDirectory('docs')]);
    const { service } = await harness();
    const project = await service.createProject({ name: 'Payments', folder: repo });

    const added = await service.addFolder(project.id, extra);
    expect(added.folders.map((folder) => folder.isDefault)).toEqual([true, false]);
    await expect(service.addFolder(project.id, extra)).rejects.toThrow(/already in this project/);
    await expect(service.removeFolder(project.id, project.repoRoot)).rejects.toThrow(/root folder/);

    const removed = await service.removeFolder(project.id, added.folders[1]!.path);
    expect(removed.folders).toHaveLength(1);
  });

  it('rejects a folder that already belongs to another project', async () => {
    const [one, two, shared] = await Promise.all([
      git.repo('payments-api'),
      git.repo('web-console'),
      git.plainDirectory('shared'),
    ]);
    const { service } = await harness();
    const first = await service.createProject({ name: 'Payments', folder: one });
    const second = await service.createProject({ name: 'Console', folder: two });

    // Another project's root.
    await expect(service.addFolder(first.id, two)).rejects.toThrow(/already in Console/);
    // Another project's added folder, or one inside it.
    await service.addFolder(first.id, shared);
    await expect(service.addFolder(second.id, shared)).rejects.toThrow(/already in Payments/);
    const inside = path.join(shared, 'inner');
    await mkdir(inside);
    await expect(service.addFolder(second.id, inside)).rejects.toThrow(/already in Payments/);
    // Nothing was written for the rejected project.
    expect(service.getProject(second.id)?.folders).toHaveLength(1);

    // Creating with a taken folder writes nothing beyond discovery.
    const three = await git.repo('ledger-core');
    await expect(
      service.createProject({ name: 'Ledger', folder: three, folders: [shared] }),
    ).rejects.toThrow(/already in Payments/);
    const ledger = service.listProjects().find((item) => item.repoRoot.endsWith('ledger-core'));
    expect(ledger?.openedAt).toBeUndefined();
    expect(ledger?.displayName).toBeUndefined();
  });

  it('places a session under an added folder in that project', async () => {
    const [repo, other] = await Promise.all([git.repo('payments-api'), git.plainDirectory('web-console')]);
    const nested = await git.subdirectory(other, 'src');
    const { service } = await harness();
    const project = await service.createProject({ name: 'Payments', folder: repo });

    // Before the folder is added, the session goes to its own repository.
    const session = sessionIn('a', nested);
    const before = await service.resolveForSession(session);
    expect(before?.project.id).not.toBe(project.id);
    const placed = { ...session, projectId: before!.project.id };

    await service.addFolder(project.id, other);
    // Unmoved, but its folder now belongs to a project: resolve again.
    expect(service.needsResolution(placed, placed)).toBe(true);
    const after = await service.resolveForSession(placed);
    expect(after?.project.id).toBe(project.id);
    const moved = { ...placed, projectId: project.id };
    expect(service.needsResolution(moved, moved)).toBe(false);

    // Removing the folder hands the session back to its repository.
    const folder = service.getProject(project.id)!.folders.find((item) => !item.isDefault)!;
    await service.removeFolder(project.id, folder.path);
    expect(service.needsResolution(moved, moved)).toBe(true);
    expect((await service.resolveForSession(moved))?.project.id).toBe(before!.project.id);
  });
});

describe('folderLabelFor', () => {
  const one = {
    folders: [{ path: '/code/payments-api', isDefault: true, addedAt: '' }],
  };
  const two = {
    folders: [
      { path: '/code/payments-api', isDefault: true, addedAt: '' },
      { path: '/code/web-console', isDefault: false, addedAt: '' },
    ],
  };

  it('is a plain relative path when the project has one folder', () => {
    expect(folderLabelFor(one, '/code/payments-api/src/x.ts')).toBe('src/x.ts');
  });

  it('names the folder when the project has more than one', () => {
    expect(folderLabelFor(two, '/code/web-console/src/x.ts')).toBe('web-console:src/x.ts');
    expect(folderLabelFor(two, '/code/payments-api/src/x.ts')).toBe('payments-api:src/x.ts');
  });

  it('does not mistake a sibling with a shared prefix for the folder', () => {
    expect(folderLabelFor(one, '/code/payments-api-old/x.ts')).toBe('/code/payments-api-old/x.ts');
  });

  it('answers for the deepest folder', () => {
    const nested = {
      folders: [
        { path: '/code/mono', isDefault: true, addedAt: '' },
        { path: '/code/mono/web', isDefault: false, addedAt: '' },
      ],
    };
    expect(folderLabelFor(nested, '/code/mono/web/a.ts')).toBe('web:a.ts');
    expect(folderLabelFor(nested, '/code/mono/b.ts')).toBe('mono:b.ts');
  });
});
