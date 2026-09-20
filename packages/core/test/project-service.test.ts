import { afterEach, describe, expect, it } from 'vitest';

import { ProjectService } from '../src/projects/project-service.js';
import { activityOf } from '../src/projects/project.js';
import { SessionRegistry } from '../src/registry/session-registry.js';
import type { AgentSession } from '../src/types/session.js';
import type { AgentAdapter } from '../src/types/adapter.js';
import { GitFixtures } from './git-fixtures.js';
import { temporaryStore, testSession } from './helpers.js';

const git = new GitFixtures();
let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  await git.cleanup();
});

function sessionIn(id: string, cwd: string | null, overrides: Partial<AgentSession> = {}) {
  return testSession({ id, providerSessionId: id, cwd, ...overrides });
}

async function harness(sessions: AgentSession[] = []) {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const live = [...sessions];
  const service = new ProjectService({
    store: fixture.store,
    listSessions: () => live,
  });
  return { ...fixture, service, live };
}

describe('ProjectService — acceptance 1 and 3: grouping', () => {
  it('puts three sessions in one repository under one project', async () => {
    const repo = await git.repo('Vowe');
    const nested = await git.subdirectory(repo, 'packages/core');
    const { service, live } = await harness();

    live.push(
      sessionIn('a', repo),
      sessionIn('b', nested),
      sessionIn('c', repo),
    );

    for (const session of live) {
      const assignment = await service.resolveForSession(session);
      session.projectId = assignment!.project.id;
    }

    expect(service.listProjects()).toHaveLength(1);
    const [project] = service.listProjects();
    expect(project!.name).toBe('Vowe');
    expect(service.getSessions(project!.id)).toHaveLength(3);
  });

  it('keeps two repositories apart', async () => {
    const [vowe, other] = await Promise.all([git.repo('Vowe'), git.repo('OtherRepo')]);
    const { service, live } = await harness();

    live.push(sessionIn('a', vowe), sessionIn('b', vowe), sessionIn('c', other));
    for (const session of live) {
      session.projectId = (await service.resolveForSession(session))!.project.id;
    }

    const projects = service.listProjects();
    expect(projects).toHaveLength(2);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(['OtherRepo', 'Vowe']);

    const vowes = projects.find((p) => p.name === 'Vowe')!;
    expect(service.getSessions(vowes.id)).toHaveLength(2);
  });

  it('groups worktree sessions with the repository, keeping branch as session metadata', async () => {
    const repo = await git.repo('Vowe');
    const worktree = await git.worktree(repo, 'feature');
    const { service } = await harness();

    const main = await service.resolveForSession(sessionIn('a', repo));
    const linked = await service.resolveForSession(sessionIn('b', worktree));

    expect(linked!.project.id).toBe(main!.project.id);
    expect(service.listProjects()).toHaveLength(1);

    // The worktree is recorded on the session, not on the project.
    expect(main!.worktree).toBeUndefined();
    expect(linked!.worktree).toContain('feature');
    expect(main!.branch).toBe('main');
    expect(linked!.branch).toBe('feature');
  });

  it('disambiguates colliding names only when they collide', async () => {
    const [a, b, c] = await Promise.all([
      git.repo('api'),
      git.repo('api'),
      git.repo('unique'),
    ]);
    const { service } = await harness();
    for (const cwd of [a, b, c]) await service.resolveForSession(sessionIn(cwd, cwd));

    const names = service.listProjectsForDisplay().map((p) => p.name);
    expect(names.filter((n) => n === 'api')).toHaveLength(0);
    expect(names.filter((n) => n.endsWith('/api'))).toHaveLength(2);
    // A name with no collision is left alone.
    expect(names).toContain('unique');
  });
});

describe('ProjectService — acceptance 8: sessions with nowhere to go', () => {
  it('leaves a session with no working directory unassigned, but still listed', async () => {
    const { service, live } = await harness();
    const session = sessionIn('a', null);
    live.push(session);

    expect(await service.resolveForSession(session)).toBeNull();
    expect(session.projectId).toBeNull();
    // Still present — a session Vowe cannot place is not a session it drops.
    expect(live).toHaveLength(1);
  });

  it('gives a non-Git session a path-based project', async () => {
    const plain = await git.plainDirectory('scratch');
    const { service } = await harness();

    const assignment = await service.resolveForSession(sessionIn('a', plain));
    expect(assignment!.project.name).toBe('scratch');
    expect(assignment!.project.id.startsWith('path:')).toBe(true);
    expect(assignment!.project.gitCommonDir).toBeUndefined();
  });
});

describe('ProjectService — acceptance 6: activity is derived', () => {
  it('counts active and recent from the sessions themselves', async () => {
    const repo = await git.repo('Vowe');
    const { service, live } = await harness();

    const working = sessionIn('a', repo, { status: 'working' });
    const waiting = sessionIn('b', repo, { status: 'waiting' });
    const done = sessionIn('c', repo, { status: 'finished' });
    live.push(working, waiting, done);
    for (const session of live) {
      session.projectId = (await service.resolveForSession(session))!.project.id;
    }

    const [project] = service.listProjects();
    expect(service.activityFor(project!.id)).toMatchObject({
      activeSessions: 2,
      recentSessions: 1,
    });

    // Finishing a session moves it without touching any stored project state.
    working.status = 'finished';
    expect(service.activityFor(project!.id)).toMatchObject({
      activeSessions: 1,
      recentSessions: 2,
    });
    expect(service.getSessions(project!.id)).toHaveLength(3);
  });

  it('reports nothing for a project with no sessions', () => {
    expect(activityOf([])).toEqual({
      activeSessions: 0,
      recentSessions: 0,
      lastActivityAt: null,
    });
  });
});

describe('ProjectService — acceptance 7: persistence', () => {
  it('keeps project identity and membership across a restart', async () => {
    const repo = await git.repo('Vowe');
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;

    const live: AgentSession[] = [sessionIn('a', repo), sessionIn('b', repo)];
    const service = new ProjectService({
      store: fixture.store,
      listSessions: () => live,
    });
    for (const session of live) {
      session.projectId = (await service.resolveForSession(session))!.project.id;
      await fixture.store.upsertSession(session);
    }
    const before = service.listProjects()[0]!;

    // Restart: a fresh store over the same directory, and a fresh service.
    const restarted = await fixture.reopen();
    const after = new ProjectService({
      store: restarted,
      listSessions: () => restarted.listSessions(),
    });

    const projects = after.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe(before.id);
    expect(projects[0]!.name).toBe(before.name);
    expect(projects[0]!.createdAt).toBe(before.createdAt);
    // Membership restored from the sessions, not from stored project state.
    expect(after.getSessions(before.id)).toHaveLength(2);
  });

  it('stores identity only — no membership, counts or activity', async () => {
    const repo = await git.repo('Vowe');
    const { store, service } = await harness();
    await service.resolveForSession(sessionIn('a', repo));

    const stored = store.listProjects()[0]!;
    const keys = Object.keys(stored).sort();
    expect(keys).toEqual(['createdAt', 'gitCommonDir', 'id', 'name', 'repoRoot']);
    // Nothing derivable is persisted.
    for (const forbidden of ['sessions', 'sessionIds', 'activeSessions', 'lastActivityAt']) {
      expect(stored).not.toHaveProperty(forbidden);
    }
  });
});

describe('ProjectService — resolution runs on change, not on every pass', () => {
  it('does not touch git when a known session reconciles unchanged', async () => {
    const repo = await git.repo('Vowe');
    const { service } = await harness();

    const assigned = sessionIn('a', repo, { projectId: 'git:already' });
    // Same session, same cwd, already placed: nothing to do.
    expect(service.needsResolution(assigned, assigned)).toBe(false);
  });

  it('resolves a session it has never seen', async () => {
    const repo = await git.repo('Vowe');
    const { service } = await harness();
    expect(service.needsResolution(sessionIn('a', repo), null)).toBe(true);
  });

  it('re-resolves when the working directory changes', async () => {
    const [a, b] = await Promise.all([git.repo('a'), git.repo('b')]);
    const { service } = await harness();

    const before = sessionIn('s', a, { projectId: 'git:whatever' });
    const after = sessionIn('s', b, { projectId: 'git:whatever' });
    expect(service.needsResolution(after, before)).toBe(true);
  });

  it('re-resolves a known session that was never placed', async () => {
    const repo = await git.repo('Vowe');
    const { service } = await harness();

    const previous = sessionIn('s', repo, { projectId: null });
    expect(service.needsResolution(sessionIn('s', repo), previous)).toBe(true);
  });

  it('invokes git once per directory however many sessions share it', async () => {
    const repo = await git.repo('Vowe');
    const { store } = await harness();

    let resolutions = 0;
    const service = new ProjectService({
      store,
      listSessions: () => [],
    });
    // Count actual filesystem work by watching the memo fill.
    const original = Reflect.get(service, 'resolveCwd') as unknown;
    Reflect.set(service, 'resolveCwd', function (this: unknown, cwd: string) {
      resolutions += 1;
      return (original as (c: string) => unknown).call(this, cwd);
    });

    await Promise.all([
      service.resolveForSession(sessionIn('a', repo)),
      service.resolveForSession(sessionIn('b', repo)),
      service.resolveForSession(sessionIn('c', repo)),
    ]);

    // Three sessions, one directory: three calls into the memo, one project.
    expect(resolutions).toBe(3);
    expect(service.listProjects()).toHaveLength(1);
  });
});

describe('SessionRegistry — assignment happens as sessions are discovered', () => {
  it('stamps projectId, and leaves it alone on later passes', async () => {
    const repo = await git.repo('Vowe');
    const worktree = await git.worktree(repo, 'feature');
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;

    const discovered: AgentSession[] = [
      sessionIn('claude-code:a', repo),
      sessionIn('claude-code:b', worktree),
    ];

    const adapter: AgentAdapter = {
      provider: 'claude-code',
      async discoverSessions() {
        // Fresh objects each pass, as a real adapter returns.
        return discovered.map((session) => ({ ...session }));
      },
      async getSession() {
        return null;
      },
      subscribeToEvents() {
        return () => undefined;
      },
      async sendInstruction() {
        return { delivered: false, via: 'test' };
      },
    };

    const projects = new ProjectService({
      store: fixture.store,
      listSessions: () => fixture.store.listSessions(),
    });
    const registry = new SessionRegistry({ store: fixture.store, projects });
    registry.registerAdapter(adapter);

    await registry.reconcile();

    const listed = registry.list();
    expect(listed).toHaveLength(2);
    // Both worktrees of one repository, so one project.
    const ids = new Set(listed.map((s) => s.projectId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBeNull();

    // The linked worktree keeps its own location as session metadata.
    const linked = listed.find((s) => s.id === 'claude-code:b')!;
    expect(linked.branch).toBe('feature');
    expect(linked.worktree).toContain('feature');

    const primary = listed.find((s) => s.id === 'claude-code:a')!;
    expect(primary.worktree).toBeUndefined();

    // A second pass must not lose or churn the assignment.
    await registry.reconcile();
    expect(registry.list().map((s) => s.projectId)).toEqual(listed.map((s) => s.projectId));

    await registry.stop();
  });
});
