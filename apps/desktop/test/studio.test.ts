import { describe, expect, it } from 'vitest';

import type { DesignEntry, DesignModel, DesignRevision, InvestigationCheck, StudioProgress } from '@vowe/core';
import { applyOps, EMPTY_MODEL } from '@vowe/core/studio-model';

import { browsable } from '../src/renderer/project/DesignBrowser.js';
import { receiptSummary } from '../src/renderer/state/investigation-timeline.js';
import {
  STUDIO_QUIET,
  asLiveProgress,
  canvasNote,
  changeCount,
  lensView,
  neighborhood,
  nextSelection,
  openableLink,
  studioCaption,
  studioStatus,
  visibleLabels,
  shownDesign,
  studioRoom,
  revisionLanded,
  studioTurnReducer,
  unanswered,
} from '../src/renderer/state/studio.js';

const AT = '2026-09-26T10:00:00.000Z';
const at = { designId: 'd', at: AT };

const MODEL: DesignModel = applyOps(EMPTY_MODEL, [
  { op: 'part', id: 'observer', name: 'Observer', role: 'Watches a session' },
  { op: 'part', id: 'understanding', name: 'Project Understanding', role: 'Durable' },
  { op: 'duty', id: 'durable', part: 'observer', text: 'durable across restarts', today: true },
]).model;

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
    expect(consulting.consulting).toEqual({ question: 'Is it durable?', activity: 'Reading a.ts', since: 1000, partId: null });
    expect(consulting.live.active).toBe(true);

    const checked = studioTurnReducer(consulting, { ...at, phase: 'check', check: CONSULT }, 2000);
    expect(checked.consulting).toBeNull();
    expect(checked.live.steps).toEqual([expect.objectContaining({ kind: 'check', check: CONSULT })]);
  });

  it('keeps a previewed move until its revision lands, and drops it when the turn did not move the design', () => {
    const revising = fold([
      { ...at, phase: 'started', entryId: 'q' },
      { ...at, phase: 'model', model: MODEL, layout: {} },
      { ...at, phase: 'finished', entryId: 'e2', revisionId: 'r2', failed: false, cancelled: false },
    ]);
    expect(revising.preview).toEqual({ model: MODEL, layout: {} });
    expect(revisionLanded(revising, [revision(1)])).toBe(false);
    expect(revisionLanded(revising, [revision(1), revision(2)])).toBe(true);

    const unchanged = fold([
      { ...at, phase: 'started', entryId: 'q' },
      { ...at, phase: 'model', model: MODEL, layout: {} },
      { ...at, phase: 'finished', entryId: 'e2', revisionId: null, failed: true, cancelled: false },
    ]);
    expect(unchanged.preview).toBeNull();
    expect(unchanged.live.settledEntryId).toBe('e2');
  });

  it('knows which part a repository check is about', () => {
    const state = fold([{ ...at, phase: 'started', entryId: 'q' }, { ...at, phase: 'consulting', question: 'q?', partId: 'observer' }]);
    expect(state.consulting?.partId).toBe('observer');
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
    expect(asLiveProgress({ ...at, phase: 'model', model: EMPTY_MODEL, layout: {} })).toBeNull();
  });
});

describe('the room', () => {
  const moved = applyOps(MODEL, [{ op: 'duty', id: 'durable', part: 'understanding' }]).model;
  const drawn = [
    revision(1, { model: MODEL, move: { id: 'mv-1', ops: [], summary: 'Drew it.', author: 'vowe', via: 'conversation' } }),
    revision(2, { model: moved, move: { id: 'mv-2', ops: [], summary: 'Moved durability.', author: 'developer', via: 'canvas' } }),
  ];

  it('opens as one question, becomes the workspace once there is a system, and keeps a Studio 0 document apart', () => {
    expect(studioRoom([], STUDIO_QUIET)).toBe('opening');
    expect(studioRoom([], { ...STUDIO_QUIET, preview: { model: EMPTY_MODEL, layout: {} } })).toBe('opening');
    expect(studioRoom([], { ...STUDIO_QUIET, preview: { model: MODEL, layout: {} } })).toBe('workspace');
    expect(studioRoom([revision(1)], STUDIO_QUIET)).toBe('legacy');
    expect(studioRoom(drawn, STUDIO_QUIET)).toBe('workspace');
  });

  it('shows the move being written over the committed design', () => {
    expect(shownDesign(drawn, { observer: { row: 0, col: 0 } }, STUDIO_QUIET)).toEqual({ model: moved, layout: { observer: { row: 0, col: 0 } } });
    expect(shownDesign(drawn, {}, { ...STUDIO_QUIET, preview: { model: MODEL, layout: {} } }).model).toBe(MODEL);
  });

  it('lays one move over the design it produced, or the proposal over today', () => {
    const lens = lensView(drawn, { kind: 'move', ord: 2 })!;
    expect(lens.before).toBe(MODEL);
    expect(lens.diff.entries).toEqual([{ id: 'durable', kind: 'duty', change: 'changed', fields: ['part'], was: { part: 'observer' } }]);
    expect([lens.index, lens.total]).toEqual([1, 2]);
    const today = lensView(drawn, { kind: 'today' })!;
    expect(today.before.parts).toEqual([]);
    expect(lensView(drawn, null)).toBeNull();
    expect(changeCount(drawn, drawn[0]!)).toBe(3);
    expect(changeCount(drawn, drawn[1]!)).toBe(1);
  });

  it('shows Vowe’s note only while the move it answers is the latest', () => {
    const note: DesignEntry = { id: 'n', designId: 'd', at: AT, role: 'companion_note', text: 'Nothing persists now.', anchor: { moveId: 'mv-2', on: 'observer' } };
    expect(canvasNote([note], drawn)).toBe(note);
    expect(canvasNote([note], [...drawn, revision(3, { model: moved, move: { id: 'mv-3', ops: [], summary: '', author: 'vowe', via: 'conversation' } })])).toBeNull();
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

describe('going back to earlier designs', () => {
  const summary = (id: string, overrides: Partial<import('@vowe/core').DesignSummary> = {}) => ({
    id, projectId: 'p', createdAt: AT, updatedAt: AT, title: 'New design', intent: '', revisions: 0, parts: 0, outline: [], ...overrides,
  });

  it('lists designs that were spoken in, and an empty one only while it is open', () => {
    const designs = [summary('used', { updatedAt: '2026-09-26T11:00:00.000Z' }), summary('drawn', { revisions: 2 }), summary('blank')];
    expect(browsable(designs, null).map((design) => design.id)).toEqual(['used', 'drawn']);
    expect(browsable(designs, 'blank').map((design) => design.id)).toEqual(['used', 'drawn', 'blank']);
  });
});

describe('selection and what it brings forward', () => {
  const SYSTEM: DesignModel = applyOps(EMPTY_MODEL, [
    { op: 'part', id: 'a', name: 'A', role: '' },
    { op: 'part', id: 'b', name: 'B', role: '' },
    { op: 'part', id: 'c', name: 'C', role: '' },
    { op: 'part', id: 'd', name: 'D', role: '' },
    { op: 'link', from: 'a', to: 'b', label: 'calls' },
    { op: 'link', from: 'c', to: 'a', label: 'feeds' },
    { op: 'link', from: 'c', to: 'd' },
  ]).model;

  it('knows a part’s neighbours in both directions', () => {
    const near = neighborhood(SYSTEM, 'a');
    expect([...near.parts].sort()).toEqual(['a', 'b', 'c']);
    expect([...near.links].sort()).toEqual(['a->b', 'c->a']);
  });

  it('shows every label on a sparse drawing, and only the focused ones on a dense one', () => {
    expect([...visibleLabels(SYSTEM, null, null, null)].sort()).toEqual(['a->b', 'c->a']);
    const dense = applyOps(SYSTEM, [
      ...['e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((id) => ({ op: 'part' as const, id, name: id.toUpperCase(), role: '' })),
      ...['e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((id) => ({ op: 'link' as const, from: 'b', to: id, label: `to ${id}` })),
    ]).model;
    expect(visibleLabels(dense, null, null, null).size).toBe(0);
    expect([...visibleLabels(dense, null, 'a->b', null)]).toEqual(['a->b']);
    expect([...visibleLabels(dense, neighborhood(dense, 'a'), null, null)].sort()).toEqual(['a->b', 'c->a']);
  });
});

describe('what Vowe is doing, and what it said', () => {
  const started = studioTurnReducer(STUDIO_QUIET, { ...at, phase: 'started', entryId: 'u1' });

  it('says checking, drawing or thinking from the turn itself, and nothing once the reply is visible', () => {
    expect(studioStatus(STUDIO_QUIET, false)).toBeNull();
    expect(studioStatus(started, true)).toBe('Thinking…');
    const consulting = studioTurnReducer(started, { ...at, phase: 'consulting', question: 'Is it durable?' });
    expect(studioStatus(consulting, true)).toBe('Checking current behavior…');
    const drawing = studioTurnReducer(started, { ...at, phase: 'model', model: MODEL, layout: {} });
    expect(studioStatus(drawing, true)).toBe('Drawing the design…');
    const writing = { ...started, live: { ...started.live, answer: 'Because' } };
    expect(studioStatus(writing, true)).toBeNull();
  });

  it('captions the reply as it is written, then the settled reply, keyed so it can fade for good', () => {
    const writing = { ...started, live: { ...started.live, answer: '  Because the edge  ' } };
    expect(studioCaption([], writing)).toEqual({ key: 'live', text: 'Because the edge', live: true });
    const reply = { id: 'e2', designId: 'd', at: AT, role: 'companion_message', text: 'Done.' } as DesignEntry;
    expect(studioCaption([reply], STUDIO_QUIET)).toEqual({ key: 'e2', text: 'Done.', live: false });
    const mine = { id: 'e3', designId: 'd', at: AT, role: 'user_message', text: 'why?' } as DesignEntry;
    expect(studioCaption([reply, mine], STUDIO_QUIET)).toBeNull();
  });
});

describe('gathering a selection', () => {
  const api = { kind: 'part', id: 'api' };
  const store = { kind: 'part', id: 'store' };
  const edge = { kind: 'link', id: 'api->store' };

  it('chooses one thing on a plain click, and lets go of it on a second', () => {
    expect(nextSelection([], api, false)).toEqual([api]);
    expect(nextSelection([api], store, false)).toEqual([store]);
    expect(nextSelection([api], api, false)).toEqual([]);
    expect(nextSelection([api, store], api, false)).toEqual([api]);
  });

  it('gathers with Shift or ⌘ in the order chosen, and lets one go without the rest', () => {
    expect(nextSelection([api], store, true)).toEqual([api, store]);
    expect(nextSelection([api, store], edge, true)).toEqual([api, store, edge]);
    expect(nextSelection([api, store, edge], store, true)).toEqual([api, edge]);
  });
});
