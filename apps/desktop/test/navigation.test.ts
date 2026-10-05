import { describe, expect, it } from 'vitest';

import type { AgentSession, Project } from '@vowe/core';
import {
  activeCount,
  fleetAgentRoute,
  fleetHandlers,
  fleetRoute,
  fleetTabOf,
  projectOf,
  reconcileRoute,
  sessionsForProject,
  type Route,
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
  it('keeps a project conversation and its history anchor inside the project', () => {
    const route = { kind: 'project', projectId: PROJECT.id, view: 'conversation', entryId: 'question-1' } as const;
    expect(reconcileRoute(route, context)).toBe(route);
    expect(projectOf(route, context)).toBe(PROJECT.id);
    expect(reconcileRoute({ kind: 'project', projectId: PROJECT.id }, context)).toEqual({ kind: 'project', projectId: PROJECT.id });
  });
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

  it('keeps a fleet inside its project, and falls back to Fleet\'s landing without it', () => {
    const route = { kind: 'fleet', projectId: PROJECT.id } as const;
    expect(reconcileRoute(route, context)).toBe(route);
    expect(projectOf(route, context)).toBe(PROJECT.id);
    expect(reconcileRoute({ ...route, projectId: 'git:gone' }, context)).toEqual({ kind: 'fleet-home' });
  });

  it('keeps the fleet tab it was asked for, and reads no tab as the canvas', () => {
    const panes = { kind: 'fleet', projectId: PROJECT.id, tab: 'panes' } as const;
    expect(reconcileRoute(panes, context)).toBe(panes);
    expect(fleetTabOf(panes)).toBe('panes');
    expect(fleetTabOf({ kind: 'fleet', projectId: PROJECT.id, tab: 'overview' })).toBe('overview');
    expect(fleetTabOf({ kind: 'fleet', projectId: PROJECT.id })).toBe('canvas');
    expect(fleetTabOf({ kind: 'project', projectId: PROJECT.id })).toBe('canvas');
    expect(reconcileRoute({ ...panes, projectId: 'git:gone' }, context)).toEqual({ kind: 'fleet-home' });
  });

  it('turns a tab that is not the fleet’s into the canvas', () => {
    const odd = { kind: 'fleet', projectId: PROJECT.id, tab: 'nonsense' } as unknown as Parameters<typeof reconcileRoute>[0];
    expect(reconcileRoute(odd, context)).toEqual({ kind: 'fleet', projectId: PROJECT.id });
    expect(fleetTabOf(odd)).toBe('canvas');
  });

  it('keeps a fleet agent while its session is in the project, and otherwise returns to the fleet', () => {
    const agent = { kind: 'fleet-agent', projectId: PROJECT.id, sessionId: 'b' } as const;
    expect(reconcileRoute(agent, context)).toBe(agent);
    expect(projectOf(agent, context)).toBe(PROJECT.id);
    expect(reconcileRoute({ ...agent, sessionId: 'gone' }, context)).toEqual({ kind: 'fleet', projectId: PROJECT.id });
    const elsewhere = { ...context, sessions: [session({ id: 'x', projectId: 'git:other' })] };
    expect(reconcileRoute({ ...agent, sessionId: 'x' }, elsewhere)).toEqual({ kind: 'fleet', projectId: PROJECT.id });
    expect(reconcileRoute({ ...agent, projectId: 'git:gone' }, context)).toEqual({ kind: 'fleet-home' });
  });

  it('opens every fleet screen\'s agents and tabs inside Fleet, never in a Vowe room', () => {
    const routes: Route[] = [];
    const handlers = fleetHandlers(PROJECT.id, (route) => routes.push(route));
    handlers.onOpenSession('a');
    handlers.onOpenAgent('b');
    expect(routes).toEqual([
      { kind: 'fleet-agent', projectId: PROJECT.id, sessionId: 'a' },
      { kind: 'fleet-agent', projectId: PROJECT.id, sessionId: 'b' },
    ]);
    handlers.onTab('canvas');
    handlers.onTab('questions');
    handlers.onCompare('cluster-1');
    handlers.onBack();
    expect(routes.slice(2)).toEqual([
      { kind: 'fleet', projectId: PROJECT.id },
      { kind: 'fleet', projectId: PROJECT.id, tab: 'questions' },
      { kind: 'fleet', projectId: PROJECT.id, tab: 'compare' },
      { kind: 'fleet', projectId: PROJECT.id },
    ]);
    expect(routes.every((route) => route.kind === 'fleet' || route.kind === 'fleet-agent')).toBe(true);
    expect(fleetAgentRoute(PROJECT.id, 'c')).toEqual({ kind: 'fleet-agent', projectId: PROJECT.id, sessionId: 'c' });
    expect(fleetRoute(PROJECT.id, 'overview')).toEqual({ kind: 'fleet', projectId: PROJECT.id, tab: 'overview' });
  });

  it('leaves the studio alone', () => {
    expect(reconcileRoute({ kind: 'presence' }, context)).toEqual({ kind: 'presence' });
  });

  it('knows which project a route is in', () => {
    expect(projectOf({ kind: 'session', sessionId: 'b' }, context)).toBe('git:abc');
    expect(projectOf({ kind: 'project', projectId: 'git:abc' }, context)).toBe('git:abc');
    expect(projectOf({ kind: 'presence' }, context)).toBeNull();
  });

  it('orders live work first, then the rest, each newest first', () => {
    expect(sessionsForProject('git:abc', context.sessions).map((s) => s.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('counts only live work in the badge', () => {
    expect(activeCount('git:abc', context.sessions)).toBe(1);
  });
});
