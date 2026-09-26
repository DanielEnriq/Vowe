import { describe, expect, it } from 'vitest';

import type { AgentSession, Project } from '@vowe/core';

import {
  closedProjects,
  looksLikePath,
  panelProjects,
} from '../src/renderer/state/project-visibility.js';

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, repoRoot: `/code/${id}`, createdAt: '2026-09-01T00:00:00.000Z', ...extra };
}

function session(projectId: string, lastActivityAt: string): AgentSession {
  return { id: `${projectId}:${lastActivityAt}`, projectId, lastActivityAt } as AgentSession;
}

const OPEN = '2026-09-20T00:00:00.000Z';

describe('Which projects the panel shows', () => {
  it('shows only the open ones', () => {
    const projects = [project('a', { openedAt: OPEN }), project('b')];
    expect(panelProjects(projects, null).map((p) => p.id)).toEqual(['a']);
  });

  it('keeps a closed project listed while you are in it', () => {
    const projects = [project('a', { openedAt: OPEN }), project('b')];
    expect(panelProjects(projects, 'b').map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('What the + offers', () => {
  const projects = [
    project('api', { repoRoot: '/work/services/api' }),
    project('web'),
    project('vowe', { openedAt: OPEN }),
  ];
  const sessions = [
    session('api', '2026-09-10T00:00:00.000Z'),
    session('web', '2026-09-22T00:00:00.000Z'),
  ];

  it('lists closed projects, most recently active first', () => {
    expect(closedProjects(projects, sessions).map((p) => p.id)).toEqual(['web', 'api']);
  });

  it('matches the name or where it lives', () => {
    expect(closedProjects(projects, sessions, 'services').map((p) => p.id)).toEqual(['api']);
    expect(closedProjects(projects, sessions, 'WEB').map((p) => p.id)).toEqual(['web']);
  });

  it('treats absolute and home paths as folders, anything else as a search', () => {
    expect(looksLikePath('/Users/me/code')).toBe(true);
    expect(looksLikePath('  ~/code ')).toBe(true);
    expect(looksLikePath('~')).toBe(true);
    expect(looksLikePath('api')).toBe(false);
    expect(looksLikePath('~api')).toBe(false);
  });
});
