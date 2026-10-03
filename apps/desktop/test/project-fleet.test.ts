import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSession, Project, ProjectBrief, ProjectSessionSummary } from '@vowe/core';
import { ProjectHome } from '../src/renderer/project/ProjectHome.js';
import {
  fleetStatusOf,
  fleetSummary,
  ipcMessage,
  projectLine,
} from '../src/renderer/state/project-fleet.js';

function summary(overrides: Partial<ProjectSessionSummary> & { sessionId: string }): ProjectSessionSummary {
  return {
    title: overrides.sessionId,
    status: 'working',
    currentActivity: null,
    currentUnderstanding: null,
    latestDevelopment: null,
    attention: null,
    provider: 'claude-code',
    branch: null,
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    needsAttention: false,
    ...overrides,
  };
}

function brief(active: ProjectSessionSummary[], recent: ProjectSessionSummary[] = []): ProjectBrief {
  return {
    projectId: 'p',
    headline: '',
    detailLines: [],
    active,
    recent,
    needsAttention: [],
    latestSignal: null,
    knowledge: { status: 'unavailable' },
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function session(overrides: Partial<AgentSession> & { id: string }): AgentSession {
  return {
    provider: 'claude-code',
    providerSessionId: overrides.id,
    attachMode: 'managed',
    task: null,
    displayLabel: overrides.id,
    cwd: '/code/p',
    projectId: 'p',
    status: 'working',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    capabilities: { observe: true, sendInstruction: true, interrupt: true, resume: true },
    semanticState: null,
    ...overrides,
  };
}

describe('Fleet status', () => {
  it('says each status as a tone and a word, needing you first', () => {
    expect(fleetStatusOf({ status: 'working', needsAttention: false })).toEqual({ tone: 'ask', word: 'running' });
    expect(fleetStatusOf({ status: 'starting', needsAttention: false }).word).toBe('running');
    expect(fleetStatusOf({ status: 'working', needsAttention: true })).toEqual({ tone: 'attention', word: 'needs you' });
    expect(fleetStatusOf({ status: 'finished', needsAttention: false })).toEqual({ tone: 'good', word: 'done' });
    expect(fleetStatusOf({ status: 'waiting', needsAttention: false })).toEqual({ tone: 'idle', word: 'idle' });
  });

  it('counts the fleet and lists what is not idle', () => {
    const fleet = fleetSummary(
      brief(
        [
          summary({ sessionId: 'a' }),
          summary({ sessionId: 'b', needsAttention: true, status: 'waiting' }),
          summary({ sessionId: 'c', status: 'waiting' }),
        ],
        [summary({ sessionId: 'd', status: 'finished' })],
      ),
    );
    expect(fleet).toMatchObject({ running: 1, needsYou: 1, done: 1 });
    expect(fleet.rows.map((row) => [row.sessionId, row.word])).toEqual([
      ['a', 'running'],
      ['b', 'needs you'],
      ['d', 'done'],
    ]);
  });

  it('is empty before the brief arrives', () => {
    expect(fleetSummary(null)).toEqual({ running: 0, needsYou: 0, done: 0, rows: [] });
  });
});

describe('The line under a project in the panel', () => {
  const one = { id: 'p', folders: [{ path: '/code/p', isDefault: true, addedAt: '' }] };
  const two = { id: 'p', folders: [...one.folders, { path: '/code/q', isDefault: false, addedAt: '' }] };

  it('counts live agents and folders', () => {
    const sessions = [
      session({ id: 'a' }),
      session({ id: 'b', status: 'waiting' }),
      session({ id: 'c', status: 'finished' }),
      session({ id: 'd', projectId: 'other' }),
      session({ id: 'e', archivedAt: '2026-10-01T00:00:00.000Z' }),
    ];
    expect(projectLine(one, sessions)).toBe('2 agents · 1 folder');
    expect(projectLine(two, [session({ id: 'a' })])).toBe('1 agent · 2 folders');
  });

  it('says idle when nothing is running', () => {
    expect(projectLine(two, [])).toBe('idle · 2 folders');
  });
});

describe('A project home', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows each folder, marks the root, and offers removal only for the others', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const project: Project = {
      id: 'p',
      name: 'payments-api',
      repoRoot: '/code/payments-api',
      createdAt: '2026-10-01T00:00:00.000Z',
      folders: [
        { path: '/code/payments-api', isDefault: true, addedAt: '' },
        { path: '/code/web-console', isDefault: false, addedAt: '' },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(ProjectHome, {
        project,
        brief: brief([summary({ sessionId: 'a', title: 'Split the retry policy' })]),
        onOpenFleet() {},
        onOpenSession() {},
        onOpenConversation() {},
        onOpenStudio() {},
      }),
    );
    expect(html).toContain('/code/payments-api');
    expect(html).toContain('/code/web-console');
    expect(html.match(/>Root</g)).toHaveLength(1);
    expect(html.match(/aria-label="Remove /g)).toHaveLength(1);
    expect(html).toContain('Split the retry policy');
    expect(html).toContain('Open Fleet');
  });
});

describe('ipcMessage', () => {
  it('keeps only the part of a rejection worth reading', () => {
    expect(
      ipcMessage("Error invoking remote method 'vowe:project:add-folder': Error: That folder is already in Console."),
    ).toBe('That folder is already in Console.');
  });
});
