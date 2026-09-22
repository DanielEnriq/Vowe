import { describe, expect, it } from 'vitest';

import type { InvestigationStep } from '@vowe/core';

import {
  liveRows,
  settledRows,
} from '../src/renderer/state/investigation-timeline.js';
import type { LiveInvestigation } from '../src/renderer/state/live-investigation.js';
import { QUIET } from '../src/renderer/state/live-investigation.js';

const live = (steps: LiveInvestigation['steps'], active = true): LiveInvestigation => ({
  ...QUIET,
  active,
  steps,
});

describe('Timeline rows — one shape for both tenses', () => {
  /**
   * A thought's duration is its own lifecycle: it opens at the first reasoning
   * delta and closes when the next thing happens. A span that closed reports
   * what it took; the one still open reports nothing and counts up instead.
   */
  it('measures a closed span and leaves the open one to its own clock', () => {
    const rows = liveRows(
      live([
        { kind: 'thought', id: 't1', at: 1_000, text: 'first', endedAt: 3_400 },
        { kind: 'check', id: 'c1', at: 3_400, check: { kind: 'search', label: 'Searched', refs: [] } },
        { kind: 'thought', id: 't2', at: 3_500, text: 'second', endedAt: null },
      ]),
    );

    expect(rows).toEqual([
      { kind: 'thought', id: 't1', text: 'first', durationMs: 2_400, live: false, startedAt: 1_000 },
      { kind: 'check', id: 'c1', check: { kind: 'search', label: 'Searched', refs: [] } },
      { kind: 'thought', id: 't2', text: 'second', durationMs: 0, live: true, startedAt: 3_500 },
    ]);
  });

  /**
   * The work stopping is what makes a span stop counting. An open thought in
   * an investigation that has finished is not still thinking — it is a span
   * whose end was never recorded, and a label ticking upwards beside a
   * finished answer would be the one untrue thing in the column.
   */
  it('stops counting once the investigation is no longer active', () => {
    const rows = liveRows(
      live([{ kind: 'thought', id: 't1', at: 1_000, text: 'x', endedAt: null }], false),
    );
    expect(rows[0]).toMatchObject({ live: false });
  });

  it('carries a settled chronology through unchanged, and never live', () => {
    const steps: InvestigationStep[] = [
      { kind: 'thought', id: 'th', text: 'considered', durationMs: 2_500 },
      { kind: 'check', id: 'ch', check: { kind: 'open', label: 'Read the exchange', refs: [] } },
    ];

    expect(settledRows(steps)).toEqual([
      { kind: 'thought', id: 'th', text: 'considered', durationMs: 2_500, live: false, startedAt: 0 },
      { kind: 'check', id: 'ch', check: { kind: 'open', label: 'Read the exchange', refs: [] } },
    ]);
  });
});
