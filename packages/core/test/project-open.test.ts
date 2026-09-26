import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProjectService } from '../src/projects/project-service.js';
import { temporaryStore } from './helpers.js';

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

async function fixture() {
  const created = await temporaryStore();
  cleanups.push(created.cleanup);
  return created;
}

const PROJECT = {
  id: 'p1',
  name: 'Vowe',
  repoRoot: '/repo',
  createdAt: '2026-09-01T00:00:00.000Z',
};

describe('A project in the panel', () => {
  it('starts closed, stays open across a restart, and closes again', async () => {
    const { store, reopen } = await fixture();
    await store.upsertProject(PROJECT);
    expect(store.getProject('p1')?.openedAt).toBeUndefined();

    await store.setProjectOpen('p1', true);
    const restarted = await reopen();
    expect(restarted.getProject('p1')?.openedAt).toEqual(expect.any(String));

    await restarted.setProjectOpen('p1', false);
    expect(restarted.getProject('p1')?.openedAt).toBeUndefined();
  });

  it('is not reopened or closed by discovery', async () => {
    const { store } = await fixture();
    await store.upsertProject(PROJECT);
    await store.setProjectOpen('p1', true);
    await store.upsertProject({ ...PROJECT, name: 'Renamed' });
    expect(store.getProject('p1')).toMatchObject({
      name: 'Renamed',
      openedAt: expect.any(String),
    });
  });

  it('can be found from a folder nobody has run a session in', async () => {
    const { store } = await fixture();
    const folder = await mkdtemp(path.join(os.tmpdir(), 'vowe-open-'));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    const projects = new ProjectService({ store, listSessions: () => [] });

    const project = await projects.projectAt(folder);
    expect(project).not.toBeNull();
    expect(store.getProject(project!.id)?.openedAt).toBeUndefined();
    // The same folder is the same project, not a second one.
    expect((await projects.projectAt(folder))?.id).toBe(project!.id);
    expect(store.listProjects()).toHaveLength(1);
  });
});
