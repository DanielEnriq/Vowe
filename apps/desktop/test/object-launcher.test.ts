import { describe, expect, it } from 'vitest';

import type {
  NormalizedEvent,
  ProjectMemoryRecord,
  WindowNote,
  WorkerMilestone,
} from '@vowe/core';

import {
  filterEntries,
  groupEntries,
  launcherEntries,
  quickOpen,
  type LauncherEntry,
} from '../src/renderer/state/object-launcher.js';

const SESSION = 'claude-code:s1';

function event(id: string, kind: NormalizedEvent['kind'], summary: string): NormalizedEvent {
  return {
    id,
    sessionId: SESSION,
    seq: 1,
    at: '2026-09-22T09:00:00.000Z',
    kind,
    summary,
    raw: {},
    rawRef: { kind: 'jsonl', path: '/tmp/x.jsonl', line: 1 } as NormalizedEvent['rawRef'],
  };
}

function edits(refs: WorkerMilestone['refs']): WorkerMilestone {
  return {
    id: 'm1',
    sessionId: SESSION,
    at: '2026-09-22T09:00:00.000Z',
    kind: 'edits',
    text: 'Changed files',
    eventIds: ['e1'],
    refs,
  };
}

const note: WindowNote = {
  id: 'n1',
  sessionId: SESSION,
  windowId: 'w7',
  windowIndex: 7,
  summary: 'Reworked the checkpoint ribbon',
  refs: [],
  investigated: true,
  createdAt: '2026-09-22T09:00:00.000Z',
};

function memory(id: string, at: string, question: string): ProjectMemoryRecord {
  return {
    id,
    projectId: 'p1',
    at,
    question,
    answer: 'because',
    refs: [],
    nodeIds: [],
    locations: [],
    outcome: 'useful',
  };
}

const EMPTY = {
  events: [],
  milestones: [],
  notes: [],
  memories: [],
  reasoningAvailable: false,
};

function reasoningEvent(): NormalizedEvent {
  return {
    id: 'e-reason',
    sessionId: SESSION,
    seq: 4,
    at: '2026-09-22T09:00:04.000Z',
    kind: 'agent_reasoning',
    summary: 'Weighing two ways to fix the reconnect',
    detail: { text: 'Weighing two ways to fix the reconnect' },
    raw: {},
    rawRef: { source: 'x.jsonl', byteOffset: 0, line: 4 },
  };
}

describe('Object launcher — only what is really there', () => {
  /**
   * Two absences that look identical and are not. The row is gated on the
   * provider's capability rather than on the events alone, so a provider that
   * can never expose reasoning never offers a row that would not open.
   */
  it('offers the worker’s reasoning only where the provider exposes it', () => {
    const withCapability = launcherEntries({
      sessionId: SESSION,
      projectId: null,
      ...EMPTY,
      reasoningAvailable: true,
      events: [reasoningEvent()],
    });
    expect(
      withCapability.find((entry) => entry.id === 'latest-reasoning')?.label,
    ).toBe('Latest worker reasoning');

    // The same events, from a provider whose reasoning Vowe cannot read.
    const withoutCapability = launcherEntries({
      sessionId: SESSION,
      projectId: null,
      ...EMPTY,
      reasoningAvailable: false,
      events: [reasoningEvent()],
    });
    expect(
      withoutCapability.some((entry) => entry.id === 'latest-reasoning'),
    ).toBe(false);
  });

  it('always offers the session diff, because the resolver answers honestly', () => {
    const entries = launcherEntries({ sessionId: SESSION, projectId: null, ...EMPTY });
    expect(entries).toEqual([
      {
        id: 'current-diff',
        section: 'current',
        label: 'Current diff',
        ref: { kind: 'diff', sessionId: SESSION },
      },
    ]);
  });

  /**
   * A `WindowNote` is Vowe's reading of a stretch of work, not a message the
   * worker wrote, and the label says the thing it actually opens.
   */
  it('names an observation an observation', () => {
    const entries = launcherEntries({
      sessionId: SESSION,
      projectId: null,
      ...EMPTY,
      notes: [note],
    });
    const found = entries.find((entry) => entry.id === 'latest-observed-work');
    expect(found?.label).toBe('Latest observed work');
    expect(found?.ref).toEqual({ kind: 'window', sessionId: SESSION, windowId: 'w7' });
  });

  it('offers the newest instruction, not the oldest one in the window', () => {
    const entries = launcherEntries({
      sessionId: SESSION,
      projectId: null,
      ...EMPTY,
      events: [
        event('e1', 'user_instruction', 'first'),
        event('e2', 'agent_message', 'chatter'),
        event('e3', 'user_instruction', 'latest'),
      ],
    });
    const found = entries.find((entry) => entry.id === 'latest-instruction');
    expect(found?.ref).toEqual({ kind: 'transcript', sessionId: SESSION, eventId: 'e3' });
  });

  it('offers the last changed file when one edit run named exactly one', () => {
    const entries = launcherEntries({
      sessionId: SESSION,
      projectId: null,
      ...EMPTY,
      milestones: [edits([{ kind: 'repo', path: 'src/live.ts' }])],
    });
    const found = entries.find((entry) => entry.id === 'changed:src/live.ts');
    // Role first, file second — a long path must not fade out the reason.
    expect(found?.label).toBe('Last changed file');
    expect(found?.detail).toBe('live.ts');
  });

  /**
   * A run that touched several files records only the session's diff. There is
   * no single file to open, so the entry is omitted rather than quietly
   * becoming a second "Current diff" under a name that promises one file.
   */
  it('omits it when the edit run touched several files', () => {
    const entries = launcherEntries({
      sessionId: SESSION,
      projectId: null,
      ...EMPTY,
      milestones: [edits([{ kind: 'diff', sessionId: SESSION }])],
    });
    expect(entries.some((entry) => entry.id.startsWith('changed:'))).toBe(false);
  });

  it('offers the newest lessons, and none at all without a project', () => {
    const memories = [
      memory('r1', '2026-09-01T00:00:00.000Z', 'old'),
      memory('r2', '2026-09-20T00:00:00.000Z', 'new'),
    ];
    const withProject = launcherEntries({
      sessionId: SESSION,
      projectId: 'p1',
      ...EMPTY,
      memories,
    });
    expect(withProject.filter((entry) => entry.section === 'vowe').map((e) => e.label)).toEqual([
      'new',
      'old',
    ]);

    const without = launcherEntries({ sessionId: SESSION, projectId: null, ...EMPTY, memories });
    expect(without.some((entry) => entry.section === 'vowe')).toBe(false);
  });
});

describe('Object launcher — the menu itself', () => {
  const entries: LauncherEntry[] = [
    { id: '1', section: 'current', label: 'Current diff', ref: { kind: 'diff', sessionId: SESSION } },
    { id: '2', section: 'repository', label: 'live.ts', detail: 'src', ref: { kind: 'repo', path: 'src/live.ts' } },
    { id: '3', section: 'vowe', label: 'Why two inserts?', ref: { kind: 'lesson', projectId: 'p', recordId: 'r' } },
    { id: '4', section: 'current', label: 'Latest instruction', ref: { kind: 'transcript', sessionId: SESSION, eventId: 'e' } },
  ];

  it('groups in a fixed order and draws no empty section', () => {
    expect(groupEntries(entries).map((group) => group.section)).toEqual([
      'current',
      'repository',
      'vowe',
    ]);
    expect(groupEntries([entries[2]!]).map((group) => group.label)).toEqual(['Vowe']);
  });

  it('matches on the label and on the quiet line', () => {
    expect(filterEntries(entries, 'live').map((entry) => entry.id)).toEqual(['2']);
    expect(filterEntries(entries, 'SRC').map((entry) => entry.id)).toEqual(['2']);
    expect(filterEntries(entries, '  ')).toHaveLength(entries.length);
  });

  /** One from each section before a fourth of anything. */
  it('spreads the empty state across the sections it has', () => {
    const picked = quickOpen(entries, 4).map((entry) => entry.id);
    expect(picked.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(picked).toHaveLength(4);
  });
});
