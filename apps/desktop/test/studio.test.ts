import { describe, expect, it } from 'vitest';

import type { DesignEntry, DesignRevision, InvestigationCheck, StudioProgress } from '@vowe/core';

import { receiptSummary } from '../src/renderer/state/investigation-timeline.js';
import {
  STUDIO_QUIET,
  asLiveProgress,
  designPaneView,
  openableLink,
  revisionLanded,
  studioTurnReducer,
  unanswered,
} from '../src/renderer/state/studio.js';

const AT = '2026-09-26T10:00:00.000Z';
const at = { designId: 'd', at: AT };

function revision(ord: number, overrides: Partial<DesignRevision> = {}): DesignRevision {
  return { id: `r${ord}`, designId: 'd', ord, at: AT, document: `# v${ord}`, summary: `why ${ord}`, entryId: `e${ord}`, ...overrides };
}

const CONSULT: InvestigationCheck = {
  kind: 'consult',
  label: 'Checked the repository: Is it durable?',
  refs: [{ kind: 'repo', path: '/r/a.ts' }],
  finding: 'No.',
  via: 'Claude Code',
};

function fold(events: StudioProgress[]) {
  return events.reduce((state, event) => studioTurnReducer(state, event, 1000), STUDIO_QUIET);
}

describe('Studio turn state', () => {
  it('shows a repository check while it runs, with what the harness is doing, then settles it as a row', () => {
    const consulting = fold([
      { ...at, phase: 'started', entryId: 'q' },
      { ...at, phase: 'consulting', question: 'Is it durable?' },
      { ...at, phase: 'consulting', question: 'Is it durable?', activity: 'Reading a.ts' },
    ]);
    expect(consulting.consulting).toEqual({ question: 'Is it durable?', activity: 'Reading a.ts', since: 1000 });
    expect(consulting.live.active).toBe(true);

    const checked = studioTurnReducer(consulting, { ...at, phase: 'check', check: CONSULT }, 2000);
    expect(checked.consulting).toBeNull();
    expect(checked.live.steps).toEqual([expect.objectContaining({ kind: 'check', check: CONSULT })]);
  });

  it('keeps a streamed design until its revision lands, and drops it when the turn did not revise', () => {
    const revising = fold([
      { ...at, phase: 'started', entryId: 'q' },
      { ...at, phase: 'design', document: '# New' },
      { ...at, phase: 'finished', entryId: 'e2', revisionId: 'r2', failed: false, cancelled: false },
    ]);
    expect(revising.design).toBe('# New');
    expect(revisionLanded(revising, [revision(1)])).toBe(false);
    expect(revisionLanded(revising, [revision(1), revision(2)])).toBe(true);

    const unchanged = fold([
      { ...at, phase: 'started', entryId: 'q' },
      { ...at, phase: 'design', document: '# Half' },
      { ...at, phase: 'finished', entryId: 'e2', revisionId: null, failed: true, cancelled: false },
    ]);
    expect(unchanged.design).toBeNull();
    expect(unchanged.live.settledEntryId).toBe('e2');
  });

  it('clears everything when the turn is cancelled, because nothing was kept', () => {
    const cancelled = fold([
      { ...at, phase: 'started', entryId: 'q' },
      { ...at, phase: 'consulting', question: 'q?' },
      { ...at, phase: 'finished', entryId: null, revisionId: null, failed: false, cancelled: true },
    ]);
    expect(cancelled).toEqual(STUDIO_QUIET);
  });

  it('feeds the conversational half to the live reducer as an investigation would', () => {
    expect(asLiveProgress({ ...at, phase: 'message', delta: 'Hi' })).toEqual({ phase: 'answer', delta: 'Hi' });
    expect(asLiveProgress({ ...at, phase: 'reasoning', delta: 'hm' })).toEqual({ phase: 'reasoning', delta: 'hm' });
    expect(asLiveProgress({ ...at, phase: 'design', document: '#' })).toBeNull();
  });
});

describe('design pane', () => {
  it('is empty before the first revision', () => {
    expect(designPaneView([], null, null)).toEqual({ mode: 'empty' });
  });

  it('shows the design being rewritten while it streams, over any chosen history', () => {
    const view = designPaneView([revision(1), revision(2)], '# Rewriting', 1);
    expect(view).toEqual({ mode: 'streaming', document: '# Rewriting', basedOn: revision(2) });
  });

  it('shows the current revision, or an earlier one when chosen', () => {
    const revisions = [revision(1), revision(2), revision(3)];
    expect(designPaneView(revisions, null, null)).toMatchObject({ mode: 'current', revision: revision(3), total: 3 });
    expect(designPaneView(revisions, null, 1)).toMatchObject({ mode: 'historical', revision: revision(1), current: revision(3) });
    // Choosing the current one, or one that is gone, is just the current design.
    expect(designPaneView(revisions, null, 3)).toMatchObject({ mode: 'current' });
    expect(designPaneView(revisions, null, 9)).toMatchObject({ mode: 'current' });
  });
});

describe('citations in the design and replies', () => {
  it('opens only committed, well-formed ref: links', () => {
    expect(openableLink('ref:repo:/r/a.ts#12', true)).toEqual({ kind: 'repo', path: '/r/a.ts', line: 12 });
    expect(openableLink('ref:repo:/r/a.ts#12', false)).toBeNull();
    expect(openableLink('ref:nonsense', true)).toBeNull();
    expect(openableLink('https://example.com', true)).toBeNull();
    expect(openableLink('javascript:alert(1)', true)).toBeNull();
    expect(openableLink(undefined, true)).toBeNull();
  });
});

describe('receipt summary', () => {
  it('says a turn checked the repository rather than counting it', () => {
    expect(receiptSummary({ durationMs: 41_200, checks: [CONSULT] })).toBe('Checked the repository · 41s');
    expect(receiptSummary({ durationMs: 3_000, checks: [CONSULT, CONSULT] })).toBe('Checked the repository · 2 questions · 3.0s');
    expect(receiptSummary({ durationMs: 900, checks: [{ ...CONSULT, finding: undefined, label: 'Could not check the repository: x' }] }))
      .toBe('Could not check the repository · 0.9s');
    expect(receiptSummary({ durationMs: 4000, checks: [{ kind: 'search', label: 's', refs: [] }] })).toBe('Checked 1 thing · 4.0s');
  });
});

describe('unanswered turns', () => {
  const user: DesignEntry = { id: 'u', designId: 'd', at: AT, role: 'user_message', text: 'hi' };
  const vowe: DesignEntry = { ...user, id: 'v', role: 'companion_message' };
  it('is derived from the thread and whether anything is working', () => {
    expect(unanswered([user], false)).toBe(true);
    expect(unanswered([user], true)).toBe(false);
    expect(unanswered([user, vowe], false)).toBe(false);
    expect(unanswered([], false)).toBe(false);
  });
});
