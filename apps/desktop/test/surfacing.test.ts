import { describe, expect, it } from 'vitest';

import type { ConversationEntry, InvestigationCheck } from '@vowe/core';
import { planSurfacing } from '../src/renderer/state/artifact-surfacing.js';

const BASE: ConversationEntry = {
  id: 'a1',
  sessionId: 'claude-code:s1',
  at: '2026-09-22T09:00:00.000Z',
  role: 'companion_answer',
  text: 'Because both paths feed one insert.',
};

const withChecks = (checks: InvestigationCheck[]): ConversationEntry => ({
  ...BASE,
  investigation: { durationMs: 4000, checks },
});

describe('Artifact surfacing — the desk is not a log', () => {
  it('surfaces nothing when nothing was investigated', () => {
    expect(planSurfacing(BASE)).toBeNull();
  });

  /**
   * The regression this policy exists for: an investigation that searched five
   * times used to put five sets of search hits on the desk.
   */
  it('never surfaces search results, however many there are', () => {
    const plan = planSurfacing(
      withChecks([
        {
          kind: 'search',
          label: 'Searched the repository',
          refs: [
            { kind: 'repo', path: '/a.ts' },
            { kind: 'repo', path: '/b.ts' },
            { kind: 'repo', path: '/c.ts' },
          ],
        },
        { kind: 'search', label: 'Searched session context', refs: [{ kind: 'repo', path: '/d.ts' }] },
      ]),
    );
    expect(plan).toBeNull();
  });

  it('gives the preview to the first thing Vowe actually descended into', () => {
    const plan = planSurfacing(
      withChecks([
        { kind: 'search', label: 'Searched the repository', refs: [{ kind: 'repo', path: '/noise.ts' }] },
        { kind: 'open', label: 'Read message-store.ts', refs: [{ kind: 'repo', path: '/b.ts' }] },
        { kind: 'open', label: 'Read ask.ts', refs: [{ kind: 'repo', path: '/c.ts' }] },
      ]),
    );
    // One, not three. Everything else the answer touched stays in the trace,
    // and becomes a tab only if somebody goes and opens it.
    expect(plan).toEqual({ kind: 'repo', path: '/b.ts' });
  });

  it('counts a diff as something worth looking at', () => {
    const plan = planSurfacing(
      withChecks([
        { kind: 'diff', label: 'Inspected the current diff', refs: [{ kind: 'diff', sessionId: 's' }] },
      ]),
    );
    expect(plan).toEqual({ kind: 'diff', sessionId: 's' });
  });

  it('surfaces a remembered lesson and a symbol, which render as documents', () => {
    expect(
      planSurfacing(
        withChecks([
          { kind: 'open', label: 'Consulted project knowledge', refs: [{ kind: 'lesson', projectId: 'p', recordId: 'r' }] },
        ]),
      ),
    ).toEqual({ kind: 'lesson', projectId: 'p', recordId: 'r' });

    expect(
      planSurfacing(
        withChecks([
          { kind: 'open', label: 'Checked repository structure', refs: [{ kind: 'symbol', projectId: 'p', nodeId: 'n' }] },
        ]),
      ),
    ).toEqual({ kind: 'symbol', projectId: 'p', nodeId: 'n' });
  });

  /**
   * Worker activity and transcript points are real evidence, reachable from
   * the receipt — but they are narrative, not something to put on the desk on
   * an answer's behalf.
   */
  it('does not put narrative evidence on the desk automatically', () => {
    const plan = planSurfacing(
      withChecks([
        { kind: 'open', label: 'Reviewed worker activity', refs: [{ kind: 'window', sessionId: 's', windowId: 'w' }] },
        { kind: 'open', label: 'Read the exchange', refs: [{ kind: 'transcript', sessionId: 's', eventId: 'e' }] },
      ]),
    );
    expect(plan).toBeNull();
  });

  /**
   * The bound is the whole policy now: one automatic tab per answer, however
   * long the investigation was. A background investigation cannot build a
   * strip of fifteen tabs, because it only ever has one slot to put them in.
   */
  it('surfaces one thing however long the investigation', () => {
    const plan = planSurfacing(
      withChecks(
        Array.from({ length: 9 }, (_, i) => ({
          kind: 'open' as const,
          label: `Read f${i}.ts`,
          refs: [{ kind: 'repo' as const, path: `/f${i}.ts` }],
        })),
      ),
    );
    expect(plan).toEqual({ kind: 'repo', path: '/f0.ts' });
  });
});
