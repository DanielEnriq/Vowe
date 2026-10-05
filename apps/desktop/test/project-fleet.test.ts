import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentSession, Project, ProjectBrief, ProjectSessionSummary } from '@vowe/core';
import { FleetOverview } from '../src/renderer/fleet/FleetOverview.js';
import {
  STATUS_TONE,
  briefSessionIds,
  countParts,
  fleetCounts,
  fleetSummary,
  ipcMessage,
  panelMembers,
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

describe('A project in Fleet\'s panel', () => {
  it('counts agents and folders', () => {
    expect(projectLine(2, 1)).toBe('2 agents · 1 folder');
    expect(projectLine(1, 2)).toBe('1 agent · 2 folders');
    expect(projectLine(0, 0)).toBe('0 agents · 1 folder');
  });

  it('lists captains first, then agents, each in canvas order, leaving out what was never started', () => {
    const layout = {
      version: 1 as const,
      clusters: [],
      wires: [],
      nodes: [
        { id: 'n1', sessionId: 'a', role: 'agent' as const, x: 0, y: 0 },
        { id: 'n2', sessionId: 'cap', role: 'captain' as const, x: 300, y: 0, label: 'Lead' },
        { id: 'n3', sessionId: null, role: 'agent' as const, x: 0, y: 200 },
        { id: 'n4', sessionId: 'b', role: 'agent' as const, x: 0, y: 400, label: 'Retry policy' },
      ],
    };
    const members = panelMembers(layout, [session({ id: 'a', displayLabel: 'Split the parser' })]);
    expect(members.map((member) => [member.sessionId, member.role])).toEqual([
      ['cap', 'captain'],
      ['a', 'agent'],
      ['b', 'agent'],
    ]);
    expect(members.map((member) => member.label)).toEqual(['Lead', 'Split the parser', 'Retry policy']);
  });
});

describe('A fleet overview', () => {
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
      createElement(FleetOverview, {
        project,
        brief: brief([summary({ sessionId: 'a', title: 'Split the retry policy' })]),
        onOpenTab() {},
        onOpenSession() {},
      }),
    );
    expect(html).toContain('/code/payments-api');
    expect(html).toContain('/code/web-console');
    expect(html.match(/>Root</g)).toHaveLength(1);
    expect(html.match(/aria-label="Remove /g)).toHaveLength(1);
    expect(html).toContain('Split the retry policy');
    expect(html).toContain('Open canvas');
    // Fleet's overview leads nowhere in Vowe.
    expect(html).not.toContain('Conversation');
    expect(html).not.toContain('Studio');
  });
});

describe('ipcMessage', () => {
  it('keeps only the part of a rejection worth reading', () => {
    expect(
      ipcMessage("Error invoking remote method 'vowe:project:add-folder': Error: That folder is already in Console."),
    ).toBe('That folder is already in Console.');
  });
});
