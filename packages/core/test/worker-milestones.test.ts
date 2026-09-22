import { describe, expect, it } from 'vitest';

import { workerMilestones, type NormalizedEvent } from '../src/index.js';

const SESSION = 'claude-code:abc123';

let seq = 0;
function event(
  kind: NormalizedEvent['kind'],
  summary: string,
  detail: Record<string, unknown> = {},
): NormalizedEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    sessionId: SESSION,
    seq,
    at: new Date(Date.UTC(2026, 8, 22, 12, 0, seq)).toISOString(),
    kind,
    summary,
    detail,
    raw: {},
    rawRef: { source: 'transcript.jsonl', byteOffset: seq * 100, line: seq },
  };
}

function edit(path: string): NormalizedEvent {
  return event('file_changed', `Edited ${path.split('/').pop()}`, {
    tool: 'Edit',
    input: { file_path: path },
  });
}

describe('Worker milestones — what reaches the conversation', () => {
  it('keeps the trace out: reads, greps, tools and ordinary commands are excluded', () => {
    const milestones = workerMilestones([
      event('tool_started', 'Read ask.ts', { tool: 'Read' }),
      event('tool_finished', 'Read finished'),
      event('command_started', 'Ran: ls'),
      event('command_finished', 'Command finished'),
      event('agent_message', 'Let me look at the call sites.'),
      event('unknown', 'Unrecognized record'),
    ]);
    expect(milestones).toEqual([]);
  });

  it('admits the five things that change what the developer understands', () => {
    const milestones = workerMilestones([
      event('session_started', 'Task: fix the reconnect bug'),
      event('test_started', 'Running tests: pnpm test'),
      event('test_finished', 'Tests passed or completed', { failed: false, output: '177 passed' }),
      event('session_waiting', 'Asked the developer a question', { awaitingHuman: true }),
      event('session_finished', 'Session finished'),
    ]);
    expect(milestones.map((m) => m.kind)).toEqual([
      'session_started',
      'tests_started',
      'tests_finished',
      'awaiting_human',
      'session_finished',
    ]);
  });

  /**
   * The contract excludes "every `file_changed`" and it is right — but a
   * developer who looked away should still see that files moved. A run becomes
   * one line, not one line per edit.
   */
  it('collapses a run of edits into a single milestone', () => {
    const milestones = workerMilestones([
      edit('/repo/packages/core/src/companion/ask.ts'),
      event('tool_started', 'Read ask.ts'),
      edit('/repo/packages/core/src/companion/ask.ts'),
      edit('/repo/packages/live/src/message-store.ts'),
    ]);

    expect(milestones).toHaveLength(1);
    expect(milestones[0]!.kind).toBe('edits');
    expect(milestones[0]!.text).toBe('edited 2 files');
    expect(milestones[0]!.eventIds).toHaveLength(3);
  });

  it('names a single edited file and links to its source and its diff', () => {
    const [milestone] = workerMilestones([edit('/repo/packages/core/src/companion/ask.ts')]);

    expect(milestone!.text).toBe('edited ask.ts');
    expect(milestone!.refs).toEqual([
      { kind: 'repo', path: '/repo/packages/core/src/companion/ask.ts' },
      { kind: 'diff', sessionId: SESSION, path: '/repo/packages/core/src/companion/ask.ts' },
    ]);
  });

  it('breaks an edit run where something meaningful happened in between', () => {
    const milestones = workerMilestones([
      edit('/repo/a.ts'),
      event('test_finished', 'Tests passed or completed', { failed: false, output: '3 passed' }),
      edit('/repo/b.ts'),
    ]);
    expect(milestones.map((m) => m.kind)).toEqual(['edits', 'tests_finished', 'edits']);
  });

  it('reports test counts only when the worker printed them', () => {
    const [withCounts] = workerMilestones([
      event('test_finished', 'Tests passed or completed', {
        failed: false,
        output: 'Test Files 38 passed\n Tests  357 passed (357)',
      }),
    ]);
    expect(withCounts!.text).toBe('test suite passed 357 / 357');

    const [without] = workerMilestones([
      event('test_finished', 'Tests passed or completed', { failed: false, output: 'ok' }),
    ]);
    expect(without!.text).toBe('test suite passed');
    expect(without!.failed).toBe(false);
  });

  it('tells a failure honestly, with both numbers when both are known', () => {
    const [both] = workerMilestones([
      event('test_finished', 'Tests failed', {
        failed: true,
        output: 'Tests  176 passed | 1 failed',
      }),
    ]);
    expect(both!.text).toBe('test suite failed · 176 passed, 1 failed');
    expect(both!.failed).toBe(true);

    const [bare] = workerMilestones([
      event('test_finished', 'Tests failed', { failed: true, output: '' }),
    ]);
    expect(bare!.text).toBe('test suite failed');
  });

  /**
   * A worker that stopped for itself is not waiting on a person. Only the
   * adapter can tell the difference, and it says so with `awaitingHuman` — the
   * same flag `Needs You` admits on.
   */
  it('admits a stop only when the worker stopped for a person', () => {
    expect(
      workerMilestones([event('session_waiting', 'Paused', {})]),
    ).toEqual([]);

    const [asked] = workerMilestones([
      event('session_waiting', 'Presented a plan and is waiting for approval', {
        awaitingHuman: true,
      }),
    ]);
    expect(asked!.kind).toBe('awaiting_human');
    expect(asked!.text).toBe('presented a plan and is waiting for approval');
  });

  it('carries an event ref on every milestone, so a line descends to the trace', () => {
    const milestones = workerMilestones([
      event('session_started', 'Task: x'),
      event('test_finished', 'Tests passed or completed', { failed: false }),
    ]);
    for (const milestone of milestones) {
      expect(milestone.refs.length).toBeGreaterThan(0);
      expect(milestone.refs[0]).toEqual({
        kind: 'event',
        sessionId: SESSION,
        eventId: milestone.id,
      });
    }
  });

  it('is order-independent and keeps only the newest when a limit is given', () => {
    const a = event('session_started', 'Task: x');
    const b = event('test_started', 'Running tests: pnpm test');
    const c = event('session_finished', 'Session finished');

    const shuffled = workerMilestones([c, a, b]);
    expect(shuffled.map((m) => m.id)).toEqual([a.id, b.id, c.id]);

    expect(workerMilestones([a, b, c], { limit: 2 }).map((m) => m.id)).toEqual([b.id, c.id]);
  });
});

describe('Worker milestones — reading real runner output', () => {
  it('reports the test count, not the file count, from a vitest summary', () => {
    const [milestone] = workerMilestones([
      event('test_finished', 'Tests passed or completed', {
        failed: false,
        output: ' Test Files  38 passed (38)\n      Tests  357 passed (357)\n',
      }),
    ]);
    expect(milestone!.text).toBe('test suite passed 357 / 357');
  });

  it('reads a jest-style summary', () => {
    const [milestone] = workerMilestones([
      event('test_finished', 'Tests failed', {
        failed: true,
        output: 'Test Suites: 1 failed, 12 passed, 13 total\nTests:       2 failed, 174 passed, 176 total',
      }),
    ]);
    expect(milestone!.text).toBe('test suite failed · 174 passed, 2 failed');
  });
});
