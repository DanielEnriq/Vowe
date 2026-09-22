import { describe, expect, it } from 'vitest';

import type { AgentSession, Project } from '@vowe/core';
import {
  activeCount,
  projectOf,
  reconcileRoute,
  sessionsForProject,
} from '../src/renderer/state/navigation.js';

const PROJECT: Project = {
  id: 'git:abc',
  name: 'Vowe',
  repoRoot: '/repo/vowe',
  createdAt: '2026-09-01T00:00:00.000Z',
};

function session(overrides: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    provider: 'claude-code',
    providerSessionId: overrides.id,
    attachMode: 'managed',
    task: null,
    displayLabel: overrides.id,
    cwd: '/repo/vowe',
    projectId: PROJECT.id,
    status: 'working',
    createdAt: '2026-09-22T09:00:00.000Z',
    lastActivityAt: '2026-09-22T09:00:00.000Z',
    capabilities: { observe: true, sendInstruction: true, interrupt: true, resume: true },
    semanticState: null,
    ...overrides,
  };
}

const context = {
  projects: [PROJECT],
  sessions: [
    session({ id: 'a', status: 'finished', lastActivityAt: '2026-09-22T10:00:00.000Z' }),
    session({ id: 'b', status: 'working', lastActivityAt: '2026-09-22T08:00:00.000Z' }),
    session({ id: 'c', status: 'waiting', lastActivityAt: '2026-09-22T09:00:00.000Z' }),
  ],
};

describe('Navigation', () => {
  it('keeps a route that still points at something', () => {
    const route = { kind: 'session', sessionId: 'b' } as const;
    expect(reconcileRoute(route, context)).toBe(route);
  });

  /** A session can finish and vanish while its room is open. */
  it('lets go of a session that no longer exists', () => {
    expect(reconcileRoute({ kind: 'session', sessionId: 'gone' }, context)).toEqual({
      kind: 'none',
    });
  });

  it('lets go of a project that no longer exists', () => {
    expect(reconcileRoute({ kind: 'project', projectId: 'git:gone' }, context)).toEqual({
      kind: 'none',
    });
  });

  it('leaves the studio alone', () => {
    expect(reconcileRoute({ kind: 'studio' }, context)).toEqual({ kind: 'studio' });
  });

  it('knows which project a route is in', () => {
    expect(projectOf({ kind: 'session', sessionId: 'b' }, context)).toBe('git:abc');
    expect(projectOf({ kind: 'project', projectId: 'git:abc' }, context)).toBe('git:abc');
    expect(projectOf({ kind: 'studio' }, context)).toBeNull();
  });

  it('orders live work first, then the rest, each newest first', () => {
    expect(sessionsForProject('git:abc', context.sessions).map((s) => s.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('counts only live work in the badge', () => {
    expect(activeCount('git:abc', context.sessions)).toBe(2);
  });
});
