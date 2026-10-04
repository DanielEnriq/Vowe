import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSession, Project, ProjectBrief, ProjectSessionSummary } from '@vowe/core';
import { ProjectHome } from '../src/renderer/project/ProjectHome.js';
import {
  STATUS_TONE,
  briefSessionIds,
  countParts,
  fleetCounts,
  fleetSummary,
  ipcMessage,
  projectLine,
  statusFromBrief,
  statusWord,
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
  it('draws each status in its own token and says it in a word', () => {
    expect(STATUS_TONE).toEqual({ running: 'ask', 'needs-you': 'attention', done: 'good', failed: 'bad', idle: 'idle' });
    expect(statusWord('needs-you')).toBe('needs you');
    expect(statusWord('failed')).toBe('failed');
  });

  it('reads a brief session as a status until the projection answers, needing you first', () => {
    expect(statusFromBrief({ status: 'working', needsAttention: false })).toBe('running');
    expect(statusFromBrief({ status: 'starting', needsAttention: false })).toBe('running');
    expect(statusFromBrief({ status: 'working', needsAttention: true })).toBe('needs-you');
    expect(statusFromBrief({ status: 'finished', needsAttention: false })).toBe('done');
    expect(statusFromBrief({ status: 'waiting', needsAttention: false })).toBe('idle');
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
    expect(fleet.rows.map((row) => [row.sessionId, row.word, row.tone])).toEqual([
      ['a', 'running', 'ask'],
      ['b', 'needs you', 'attention'],
      ['d', 'done', 'good'],
    ]);
  });

  /** The main process's projection is the one vocabulary: it can say failed, and that a captain has a question. */
  it('prefers the projected status over what the brief suggests', () => {
    const fleet = fleetSummary(
      brief([summary({ sessionId: 'a' }), summary({ sessionId: 'b', needsAttention: true })], [summary({ sessionId: 'c', status: 'finished' })]),
      { a: 'failed', b: 'running', c: 'done' },
    );
    expect(fleet.rows.map((row) => [row.sessionId, row.status, row.tone])).toEqual([
      ['a', 'failed', 'bad'],
      ['b', 'running', 'ask'],
      ['c', 'done', 'good'],
    ]);
    expect(fleet).toMatchObject({ running: 1, needsYou: 0, done: 1 });
  });

  it('is empty before the brief arrives', () => {
    expect(fleetSummary(null)).toEqual({ running: 0, needsYou: 0, done: 0, rows: [] });
    expect(briefSessionIds(null)).toEqual([]);
  });

  it('lists a brief’s sessions once each', () => {
    expect(briefSessionIds(brief([summary({ sessionId: 'a' })], [summary({ sessionId: 'a' }), summary({ sessionId: 'b' })]))).toEqual(['a', 'b']);
  });

  it('counts statuses over the sessions asked about, ignoring ones not yet known', () => {
    const statuses = { a: 'running', b: 'needs-you', c: 'done', d: 'failed', e: 'idle', f: 'running' } as const;
    expect(fleetCounts(statuses)).toEqual({ running: 2, needsYou: 1, done: 1, failed: 1 });
    expect(fleetCounts(statuses, ['a', 'a', 'c', 'unknown'])).toEqual({ running: 1, needsYou: 0, done: 1, failed: 0 });
    expect(countParts({ running: 4, needsYou: 1, done: 2, failed: 0 }).map((part) => part.text).join(' · ')).toBe(
      '4 running · 1 needs you · 2 done',
    );
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
