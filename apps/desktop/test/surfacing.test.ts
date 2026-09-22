import { describe, expect, it } from 'vitest';

import type { ConversationEntry } from '@vowe/core';
import { planSurfacing } from '../src/renderer/state/artifact-surfacing.js';

const BASE: ConversationEntry = {
  id: 'a1',
  sessionId: 'claude-code:s1',
  at: '2026-09-22T09:00:00.000Z',
  role: 'companion_answer',
  text: 'Because both paths feed one insert.',
};

describe('Artifact surfacing — from what Vowe actually opened', () => {
  it('surfaces nothing when nothing was investigated', () => {
    expect(planSurfacing(BASE)).toEqual({ show: null, suggest: [] });
  });

  it('gives the view to the first thing opened', () => {
    const plan = planSurfacing({
      ...BASE,
      investigation: {
        durationMs: 4000,
        checks: [
          { kind: 'search', label: 'reconnect', refs: [{ kind: 'repo', path: '/a.ts' }] },
          { kind: 'open', label: 'store', refs: [{ kind: 'repo', path: '/b.ts' }] },
          { kind: 'open', label: 'ask', refs: [{ kind: 'repo', path: '/c.ts' }] },
        ],
      },
    });

    expect(plan.show).toEqual({ kind: 'repo', path: '/b.ts' });
    expect(plan.suggest).toContainEqual({ kind: 'repo', path: '/c.ts' });
    expect(plan.suggest).not.toContainEqual({ kind: 'repo', path: '/b.ts' });
  });

  it('falls back to a diff or a search hit when nothing was opened', () => {
    const plan = planSurfacing({
      ...BASE,
      investigation: {
        durationMs: 1000,
        checks: [
          { kind: 'diff', label: 'working diff', refs: [{ kind: 'diff', sessionId: 's' }] },
        ],
      },
    });
    expect(plan.show).toEqual({ kind: 'diff', sessionId: 's' });
  });

  it('never suggests the same address twice', () => {
    const ref = { kind: 'repo', path: '/a.ts' } as const;
    const plan = planSurfacing({
      ...BASE,
      investigation: {
        durationMs: 1000,
        checks: [
          { kind: 'open', label: 'a', refs: [ref] },
          { kind: 'open', label: 'a again', refs: [ref] },
          { kind: 'diff', label: 'a diff', refs: [ref] },
        ],
      },
    });
    expect(plan.show).toEqual(ref);
    expect(plan.suggest).toEqual([]);
  });

  it('bounds how much one answer may put on the desk', () => {
    const plan = planSurfacing({
      ...BASE,
      investigation: {
        durationMs: 1000,
        checks: Array.from({ length: 9 }, (_, i) => ({
          kind: 'open' as const,
          label: `f${i}`,
          refs: [{ kind: 'repo' as const, path: `/f${i}.ts` }],
        })),
      },
    });
    expect(plan.suggest.length).toBeLessThanOrEqual(4);
  });
});
