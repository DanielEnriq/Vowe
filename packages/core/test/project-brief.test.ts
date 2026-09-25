import { afterEach, describe, expect, it } from 'vitest';

import type { RepoIndexState } from '../src/knowledge/project-knowledge.js';
import type { SurfaceUpdate, WindowNote } from '../src/observation/trace-window.js';
import {
  ProjectBriefService,
  type ProjectBriefKnowledge,
} from '../src/product/project-brief.js';
import { sessionTitle } from '../src/product/session-display.js';
import type { SqliteEventStore } from '../src/store/sqlite-event-store.js';
import type { AgentSession } from '../src/types/session.js';
import { makeEvents, storeEvents, temporaryStore, testSession } from './helpers.js';

const PROJECT = 'project:repo';

let cleanup: (() => Promise<void>) | null = null;

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function harness(
  sessions: AgentSession[] = [],
  knowledge?: ProjectBriefKnowledge,
): Promise<{ store: SqliteEventStore; service: ProjectBriefService }> {
  const fixture = await temporaryStore();
  cleanup = fixture.cleanup;
  const service = new ProjectBriefService({
    store: fixture.store,
    sessionsFor: () => sessions,
    ...(knowledge ? { knowledge } : {}),
  });
  return { store: fixture.store, service };
}

function sessionAt(
  id: string,
  lastActivityAt: string,
  overrides: Partial<AgentSession> = {},
): AgentSession {
  return testSession({
    id,
    providerSessionId: id,
    projectId: PROJECT,
    lastActivityAt,
    displayLabel: id,
    task: id,
    ...overrides,
  });
}

function surfaceUpdate(
  sessionId: string,
  message: string,
  createdAt: string,
  overrides: Partial<SurfaceUpdate> = {},
): SurfaceUpdate {
  return {
    id: `${sessionId}:${createdAt}`,
    sessionId,
    windowId: null,
    message,
    whyNow: 'because',
    refs: [],
    urgency: 'normal',
    createdAt,
    ...overrides,
  };
}

function windowNote(
  sessionId: string,
  notableChange: string,
  createdAt: string,
): WindowNote {
  return {
    id: `${sessionId}:note:${createdAt}`,
    sessionId,
    windowId: 'w1',
    windowIndex: 0,
    summary: 'a window',
    notableChange,
    refs: [],
    investigated: false,
    createdAt,
  };
}

describe('ProjectBrief — active and recent', () => {
  it('splits live work from everything else, newest first', async () => {
    const { service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
      sessionAt('b', '2026-02-11T11:00:00.000Z', { status: 'finished' }),
      sessionAt('c', '2026-02-11T10:00:00.000Z', { status: 'waiting' }),
      sessionAt('d', '2026-02-11T08:00:00.000Z', { status: 'idle' }),
    ]);

    const brief = await service.get(PROJECT);

    expect(brief.active.map((s) => s.sessionId)).toEqual(['a']);
    expect(brief.recent.map((s) => s.sessionId)).toEqual(['b', 'c', 'd']);
  });

  it('caps the recent list', async () => {
    const fixture = await temporaryStore();
    cleanup = fixture.cleanup;
    const sessions = Array.from({ length: 8 }, (_, index) =>
      sessionAt(`s${index}`, `2026-02-11T0${index}:00:00.000Z`, { status: 'finished' }),
    );
    const service = new ProjectBriefService({
      store: fixture.store,
      sessionsFor: () => sessions,
      recentLimit: 3,
    });

    const brief = await service.get(PROJECT);

    expect(brief.active).toEqual([]);
    expect(brief.recent).toHaveLength(3);
    expect(brief.recent[0]!.sessionId).toBe('s7');
  });

  it('carries provider, branch and interpreted activity onto the summary', async () => {
    const { service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', {
        status: 'working',
        branch: 'feature/reconnect',
        semanticState: {
          task: 'Fix the reconnect regression',
          phase: 'debugging',
          currentActivity: 'Reading the retry backoff',
          recentProgress: [],
          lastMeaningfulUpdate: '2026-02-11T09:00:00.000Z',
          currentUnderstanding: null,
          meaningfulUpdates: [],
          source: 'heuristic',
          provenance: { eventIds: [], throughSeq: 0 },
          updatedAt: '2026-02-11T09:00:00.000Z',
        },
      }),
    ]);

    const [summary] = (await service.get(PROJECT)).active;

    expect(summary!.title).toBe('Fix the reconnect regression');
    expect(summary!.currentActivity).toBe('Reading the retry backoff');
    expect(summary!.provider).toBe('claude-code');
    expect(summary!.branch).toBe('feature/reconnect');
  });
});

describe('ProjectBrief — deterministic synthesis', () => {
  it('is quiet with no sessions at all', async () => {
    const { service } = await harness([]);
    const brief = await service.get(PROJECT);

    expect(brief.headline).toBe("Everything's quiet.");
    expect(brief.detailLines).toEqual([]);
  });

  it('says work is moving when something is live and nothing needs a person', async () => {
    const { service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
    ]);

    expect((await service.get(PROJECT)).headline).toBe('Everything is moving.');
  });

  it('says work is complete once every session has finished', async () => {
    const { service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'finished' }),
      sessionAt('b', '2026-02-11T10:00:00.000Z', { status: 'finished' }),
    ]);

    expect((await service.get(PROJECT)).headline).toBe('Work is complete.');
  });

  it('leads on attention, singular and plural', async () => {
    const one = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
    ]);
    await storeEvents(
      one.store,
      makeEvents(
        [
          {
            kind: 'session_waiting',
            summary: 'Asked the developer a question',
            detail: { toolUseId: 'tu-1', awaitingHuman: true },
          },
        ],
        'a',
      ),
      'a',
    );
    expect((await one.service.get(PROJECT)).headline).toBe('One thing needs you.');
    await cleanup?.();
    cleanup = null;

    const many = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
    ]);
    await storeEvents(
      many.store,
      makeEvents(
        [
          {
            kind: 'session_waiting',
            summary: 'Asked the developer a question',
            detail: { toolUseId: 'tu-1', awaitingHuman: true },
          },
          {
            kind: 'permission_requested',
            summary: 'Wants to run a command',
          },
        ],
        'a',
      ),
      'a',
    );
    expect((await many.service.get(PROJECT)).headline).toBe('2 things need you.');
  });

  it('keeps detail lines factual and capped at three', async () => {
    const { service } = await harness(
      Array.from({ length: 5 }, (_, index) =>
        sessionAt(`s${index}`, `2026-02-11T0${index}:00:00.000Z`, {
          status: 'working',
          task: `Task ${index}`,
        }),
      ),
    );

    const brief = await service.get(PROJECT);

    expect(brief.detailLines).toHaveLength(3);
    expect(brief.detailLines[0]).toBe('Task 4 — working');
  });

  it('reports the newest underlying state, not the time it was asked', async () => {
    const { service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'finished' }),
      sessionAt('b', '2026-02-11T11:30:00.000Z', { status: 'finished' }),
    ]);

    expect((await service.get(PROJECT)).updatedAt).toBe('2026-02-11T11:30:00.000Z');
  });
});

describe('ProjectBrief — Needs You wiring', () => {
  it('flags the session that is waiting, and only that one', async () => {
    const { store, service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
      sessionAt('b', '2026-02-11T10:00:00.000Z', { status: 'working' }),
    ]);
    await storeEvents(
      store,
      makeEvents(
        [
          {
            kind: 'session_waiting',
            summary: 'Presented a plan and is waiting for approval',
            detail: { toolUseId: 'tu-1', awaitingHuman: true },
          },
        ],
        'a',
      ),
      'a',
    );
    await storeEvents(
      store,
      makeEvents([{ kind: 'file_changed', summary: 'Edited api.ts' }], 'b'),
      'b',
    );

    const brief = await service.get(PROJECT);

    expect(brief.needsAttention).toHaveLength(1);
    expect(brief.needsAttention[0]!.sessionId).toBe('a');
    expect(brief.needsAttention[0]!.projectId).toBe(PROJECT);
    expect(
      brief.active.find((s) => s.sessionId === 'a')!.needsAttention,
    ).toBe(true);
    expect(
      brief.active.find((s) => s.sessionId === 'b')!.needsAttention,
    ).toBe(false);
  });

  it('does not raise attention from an ordinary waiting session', async () => {
    const { store, service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'waiting' }),
    ]);
    await storeEvents(
      store,
      makeEvents(
        [
          { kind: 'tool_started', summary: 'Read api.ts' },
          { kind: 'agent_message', summary: 'Looks right to me' },
        ],
        'a',
      ),
      'a',
    );

    const brief = await service.get(PROJECT);

    expect(brief.needsAttention).toEqual([]);
    expect(brief.headline).toBe("Everything's quiet.");
  });
});

describe('ProjectBrief — Latest from Vowe', () => {
  it('picks the newest meaningful surface update across sessions', async () => {
    const { store, service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
      sessionAt('b', '2026-02-11T10:00:00.000Z', { status: 'working' }),
    ]);
    await store.appendSurfaceUpdate(
      surfaceUpdate('a', 'The retry loop never backs off', '2026-02-11T09:10:00.000Z'),
    );
    await store.appendSurfaceUpdate(
      surfaceUpdate('b', 'Tests are green again', '2026-02-11T10:10:00.000Z'),
    );

    const signal = (await service.get(PROJECT)).latestSignal;

    expect(signal).not.toBeNull();
    expect(signal!.sessionId).toBe('b');
    expect(signal!.text).toBe('Tests are green again');
    expect(signal!.at).toBe('2026-02-11T10:10:00.000Z');
  });

  it('skips a candidate the policy already decided to ignore', async () => {
    const { store, service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
    ]);
    await store.appendSurfaceUpdate(
      surfaceUpdate('a', 'Worth saying', '2026-02-11T09:10:00.000Z'),
    );
    await store.appendSurfaceUpdate(
      surfaceUpdate('a', 'Noise', '2026-02-11T09:20:00.000Z', {
        decision: { action: 'ignore', reason: 'routine', source: 'default' },
      }),
    );

    expect((await service.get(PROJECT)).latestSignal!.text).toBe('Worth saying');
  });

  it('falls back to a notable change when no candidate was raised', async () => {
    const { store, service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
    ]);
    await store.appendWindowNote(
      windowNote('a', 'The migration changed the primary key', '2026-02-11T09:05:00.000Z'),
    );

    const signal = (await service.get(PROJECT)).latestSignal;

    expect(signal!.text).toBe('The migration changed the primary key');
  });

  it('returns null when nothing meaningful exists', async () => {
    const { store, service } = await harness([
      sessionAt('a', '2026-02-11T09:00:00.000Z', { status: 'working' }),
    ]);
    await store.appendWindowNote({
      ...windowNote('a', '', '2026-02-11T09:05:00.000Z'),
      notableChange: '   ',
    });

    expect((await service.get(PROJECT)).latestSignal).toBeNull();
  });
});

describe('ProjectBrief — knowledge status', () => {
  it('reads unavailable when no structural provider exists', async () => {
    const { service } = await harness([]);

    expect((await service.get(PROJECT)).knowledge).toEqual({ status: 'unavailable' });
  });

  it('reports the index state without starting a build', async () => {
    let builds = 0;
    const knowledge: ProjectBriefKnowledge = {
      structureAvailable: true,
      describe: async (projectId): Promise<RepoIndexState> => {
        builds += 1;
        return {
          projectId,
          status: 'ready',
          indexedAt: '2026-02-11T08:00:00.000Z',
        };
      },
    };
    const { service } = await harness([], knowledge);

    expect((await service.get(PROJECT)).knowledge).toEqual({
      status: 'ready',
      updatedAt: '2026-02-11T08:00:00.000Z',
    });
    expect(builds).toBe(1);
  });
});

describe('session titles', () => {
  it('strips wrappers the CLI injects around the developer’s words', () => {
    const title = sessionTitle(
      testSession({
        task: '<system-reminder>ignore this</system-reminder>\nFix the reconnect regression',
      }),
    );

    expect(title).toBe('Fix the reconnect regression');
  });

  it('never shows a provider’s id-shaped fallback label', () => {
    const title = sessionTitle(
      testSession({
        task: null,
        displayLabel: 'claude-code session 1a2b3c4d',
        cwd: '/Users/dev/projects/Vowe',
        semanticState: null,
      }),
    );

    expect(title).toBe('Vowe');
  });

  it('has an honest last resort', () => {
    expect(
      sessionTitle(
        testSession({ task: null, displayLabel: '', cwd: null, semanticState: null }),
      ),
    ).toBe('Untitled session');
  });
});
