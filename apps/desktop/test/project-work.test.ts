import { describe, expect, it } from 'vitest';

import type { ProjectBrief, ProjectSessionSummary } from '@vowe/core';

import { settledAs, workItemFor, workersLine } from '../src/renderer/state/project-work.js';

function summary(overrides: Partial<ProjectSessionSummary> = {}): ProjectSessionSummary {
  return {
    sessionId: 'claude-code:s1',
    title: 'Observer intelligence',
    status: 'working',
    currentActivity: 'Mapping the live observation pipeline',
    currentUnderstanding: null,
    latestDevelopment: null,
    attention: null,
    provider: 'claude-code',
    branch: 'main',
    lastActivityAt: '2026-09-24T10:00:00.000Z',
    needsAttention: false,
    ...overrides,
  };
}

function brief(active: number, recent: number): ProjectBrief {
  return {
    projectId: 'p1',
    headline: '',
    detailLines: [],
    active: Array.from({ length: active }, (_, i) => summary({ sessionId: `a${i}` })),
    recent: Array.from({ length: recent }, (_, i) =>
      summary({ sessionId: `r${i}`, status: 'finished' }),
    ),
    needsAttention: [],
    latestSignal: null,
    knowledge: { status: 'unavailable' },
    updatedAt: '2026-09-24T10:00:00.000Z',
  };
}

describe('Project Room work lines', () => {
  it("reads the interpreter's activity when there is one", () => {
    const item = workItemFor(summary());
    expect(item.line).toBe('Mapping the live observation pipeline');
    expect(item.interpreted).toBe(true);
    expect(item.presence).toBe('observing');
  });

  /*
   * Before anything has read a session, the line is its status in words —
   * never "No interpretation yet", which describes Vowe's plumbing rather
   * than the work.
   */
  it('says only the status when nothing has interpreted the work', () => {
    expect(workItemFor(summary({ currentActivity: null })).line).toBe('Working');
    expect(workItemFor(summary({ currentActivity: null, status: 'starting' })).line).toBe(
      'Starting up',
    );
    const between = workItemFor(summary({ currentActivity: null, status: 'waiting' }));
    expect(between.line).toBe('Waiting for its next turn');
    expect(between.interpreted).toBe(false);
  });

  it('keeps a worker between turns still, and one that needs you asking', () => {
    expect(workItemFor(summary({ status: 'waiting' })).presence).toBe('idle');
    const waiting = workItemFor(summary({ status: 'waiting', needsAttention: true }));
    expect(waiting.presence).toBe('attention');
    expect(waiting.line).toBe('Needs you');
    expect(waiting.needsYou).toBe(true);
  });

  it('draws every provider as the same kind of row', () => {
    const shapes = ['claude-code', 'pi', 'codex', 'some-future-agent'].map((provider) =>
      workItemFor(summary({ provider })),
    );
    for (const item of shapes) expect(item).toEqual(shapes[0]);
  });

  it('replaces activity independently of settled understanding', () => {
    const understanding = 'Joining the semantic and window-observation pipelines.';
    const first = workItemFor(summary({ currentUnderstanding: understanding }));
    const next = workItemFor(summary({ currentUnderstanding: understanding, currentActivity: 'Checking types' }));
    expect(first.understanding).toBe(understanding);
    expect(next.understanding).toBe(understanding);
    expect(next.line).toBe('Checking types');
    expect(workItemFor(summary()).understanding).toBeNull();
  });

  it('only calls finished work finished', () => {
    expect(settledAs(summary({ status: 'finished' }))).toBe('finished');
    expect(settledAs(summary({ status: 'idle' }))).toBe('idle');
    expect(settledAs(summary({ status: 'waiting' }))).toBe('idle');
    expect(settledAs(summary({ status: 'unknown' }))).toBe('recent');
  });

  it('counts workers, not sessions', () => {
    expect(workersLine(brief(0, 0))).toBe('No workers active');
    expect(workersLine(brief(1, 0))).toBe('1 worker active');
    expect(workersLine(brief(2, 3))).toBe('2 workers active · 3 recent');
  });
});
