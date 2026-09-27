import { describe, expect, it } from 'vitest';

import {
  applyOps,
  describeCanvasMove,
  diffModels,
  EMPTY_MODEL,
  MAX_PARTS,
  parseOp,
  placeParts,
  projectMarkdown,
  revertModel,
  tidyLayout,
  todayModel,
  type DesignModel,
  type DesignOp,
  type RepositoryBasis,
} from '../src/studio/design-model.js';

const BASIS: RepositoryBasis = { worktree: '/repo', head: 'abc123', branch: 'main', dirty: false, at: '2026-09-26T00:00:00.000Z' };

/** Vowe's own runtime, as a design would first draw it. */
function runtime(): DesignModel {
  return applyOps(EMPTY_MODEL, [
    { op: 'design', title: 'Where project understanding lives', intent: 'Place durable understanding above the observer.' },
    { op: 'part', id: 'session-registry', name: 'SessionRegistry', role: 'Knows every worker session', today: true },
    { op: 'part', id: 'observer', name: 'Observer', role: 'Watches a session', today: true },
    { op: 'part', id: 'semantic-state', name: 'Semantic State', role: 'What a session means', today: true },
    { op: 'link', from: 'session-registry', to: 'observer', today: true },
    { op: 'link', from: 'observer', to: 'semantic-state', label: 'updates', today: true },
    { op: 'duty', id: 'durable', part: 'observer', text: 'durable across restarts', today: true },
  ], { basis: BASIS }).model;
}

describe('design model ops', () => {
  it('stamps today with the checkout that established it, and only when one did', () => {
    const model = runtime();
    expect(model.parts.find((part) => part.id === 'observer')!.today).toEqual({ name: 'Observer', role: 'Watches a session', basis: BASIS });
    const unchecked = applyOps(model, [{ op: 'part', id: 'home', name: 'Project Home', role: 'x', today: true }]).model;
    expect(unchecked.parts.find((part) => part.id === 'home')!.today).toEqual({ name: 'Project Home', role: 'x' });
  });

  it('keeps an id through a rename, so selection and layout survive it', () => {
    const renamed = applyOps(runtime(), [{ op: 'part', id: 'observer', name: 'Session Observer' }]).model;
    const part = renamed.parts.find((candidate) => candidate.id === 'observer')!;
    expect(part.name).toBe('Session Observer');
    expect(part.today?.name).toBe('Observer');
    expect(diffModels(runtime(), renamed).entries).toEqual([
      { id: 'observer', kind: 'part', change: 'changed', fields: ['name'], was: { name: 'Observer' } },
    ]);
  });

  it('relocates a responsibility as one visible change', () => {
    const before = applyOps(runtime(), [{ op: 'part', id: 'project-understanding', name: 'Project Understanding', role: 'Durable understanding' }]).model;
    const after = applyOps(before, [{ op: 'duty', id: 'durable', part: 'project-understanding' }]).model;
    const diff = diffModels(before, after);
    expect(diff.entries).toEqual([{ id: 'durable', kind: 'duty', change: 'changed', fields: ['part'], was: { part: 'observer' } }]);
    expect(diff.visible).toBe(1);
    expect(describeCanvasMove(before, after)).toBe('Moved “durable across restarts” from Observer to Project Understanding');
  });

  it('retires what exists today instead of forgetting it, and takes its links along', () => {
    const after = applyOps(runtime(), [{ op: 'remove', id: 'observer' }]).model;
    expect(after.parts.find((part) => part.id === 'observer')!.retired).toBe(true);
    expect(after.links.every((link) => link.retired)).toBe(true);
    expect(after.duties[0]!.retired).toBe(true);
    expect(todayModel(after).parts.map((part) => part.id)).toContain('observer');
    const proposed = applyOps(after, [{ op: 'part', id: 'x', name: 'X', role: '' }, { op: 'remove', id: 'x' }]).model;
    expect(proposed.parts.some((part) => part.id === 'x')).toBe(false);
  });

  it('refuses bad ops and still applies the rest', () => {
    const result = applyOps(runtime(), [
      { op: 'link', from: 'observer', to: 'nowhere' },
      { op: 'part', id: 'Bad Id', name: 'x' },
      { op: 'part', id: 'fresh' },
      { op: 'part', id: 'durable', name: 'clash' },
      { op: 'part', id: 'project-home', name: 'Project Home', role: 'What is going on' },
    ]);
    expect(result.rejected).toHaveLength(4);
    expect(result.model.parts.map((part) => part.id)).toContain('project-home');
  });

  it('holds a working set, not the whole system', () => {
    const ops: DesignOp[] = Array.from({ length: MAX_PARTS + 3 }, (_, index) => ({ op: 'part', id: `p${index}`, name: `P${index}`, role: '' }));
    const result = applyOps(EMPTY_MODEL, ops);
    expect(result.model.parts).toHaveLength(MAX_PARTS);
    expect(result.rejected).toHaveLength(3);
  });

  it('parses untrusted op JSON without throwing', () => {
    expect(parseOp({ op: 'part', id: 'a', name: 'A', today: true, refs: ['repo:/x', 3] })).toEqual({ op: 'part', id: 'a', name: 'A', today: true, refs: ['repo:/x'] });
    expect(parseOp({ op: 'link', from: 'a' })).toBeNull();
    expect(parseOp({ op: 'place', id: 'a', above: 'b' })).toBeNull();
    expect(parseOp('nope')).toBeNull();
  });
});

describe('reverting a move', () => {
  it('restores what that move changed', () => {
    const before = runtime();
    const after = applyOps(before, [
      { op: 'part', id: 'project-understanding', name: 'Project Understanding', role: 'Durable understanding' },
      { op: 'link', from: 'semantic-state', to: 'project-understanding' },
      { op: 'duty', id: 'durable', part: 'project-understanding' },
    ]).model;
    const { model, conflicts } = revertModel(before, after, after);
    expect(conflicts).toEqual([]);
    expect(model).toEqual(before);
  });

  it('never undoes a later move: what changed since is left and reported', () => {
    const m0 = runtime();
    const m1 = applyOps(m0, [{ op: 'part', id: 'observer', name: 'Session Observer' }, { op: 'part', id: 'semantic-state', role: 'Per-session meaning' }]).model;
    const m2 = applyOps(m1, [{ op: 'part', id: 'observer', name: 'Watcher' }]).model;
    const { model, conflicts } = revertModel(m0, m1, m2);
    expect(conflicts).toEqual(['observer']);
    expect(model.parts.find((part) => part.id === 'observer')!.name).toBe('Watcher');
    expect(model.parts.find((part) => part.id === 'semantic-state')!.role).toBe('What a session means');
  });

  it('is the same whether Vowe or the canvas asks for it', () => {
    const m0 = runtime();
    const m1 = applyOps(m0, [{ op: 'remove', id: 'semantic-state' }]).model;
    const resolveMove = (id: string) => (id === 'mv-1' ? { before: m0, after: m1 } : null);
    const result = applyOps(m1, [{ op: 'revert', move: 'mv-1' }], { resolveMove });
    expect(result.model).toEqual(m0);
    expect(applyOps(m1, [{ op: 'revert', move: 'mv-9' }], { resolveMove }).rejected).toHaveLength(1);
  });
});

describe('projection', () => {
  it('writes the design as a document, including what it changes about today', () => {
    const model = applyOps(runtime(), [
      { op: 'part', id: 'project-understanding', name: 'Project Understanding', role: 'Durable understanding', detail: 'Because sessions end.' },
      { op: 'link', from: 'semantic-state', to: 'project-understanding', label: 'promotes' },
    ]).model;
    const markdown = projectMarkdown(model);
    expect(markdown).toMatch(/^# Where project understanding lives/);
    expect(markdown).toContain('- **Project Understanding** — Durable understanding');
    expect(markdown).toContain('Semantic State → Project Understanding (promotes)');
    expect(markdown).toContain('### Project Understanding');
    expect(markdown).toContain("## Compared with today's code");
    expect(markdown).toContain('Adds Project Understanding');
  });
});

describe('layout', () => {
  it('places a new part beside its relatives and never moves what is there', () => {
    const first = placeParts({}, runtime());
    expect(first['session-registry']).toEqual({ row: 0, col: 0 });
    expect(first['observer']).toEqual({ row: 1, col: 0 });
    expect(first['semantic-state']).toEqual({ row: 2, col: 0 });

    const grown = applyOps(runtime(), [
      { op: 'part', id: 'project-understanding', name: 'Project Understanding', role: '' },
      { op: 'link', from: 'semantic-state', to: 'project-understanding' },
      { op: 'part', id: 'home', name: 'Project Home', role: '' },
      { op: 'link', from: 'project-understanding', to: 'home' },
      { op: 'part', id: 'agent', name: 'Design Agent', role: '' },
      { op: 'link', from: 'project-understanding', to: 'agent' },
    ]).model;
    const second = placeParts({ ...first, observer: { row: 1, col: 3, pinned: true } }, grown);
    expect(second['observer']).toEqual({ row: 1, col: 3, pinned: true });
    expect(second['session-registry']).toEqual(first['session-registry']);
    expect(second['project-understanding']).toEqual({ row: 3, col: 0 });
    expect(second['home']!.row).toBe(4);
    expect(second['agent']!.row).toBe(4);
    expect(second['home']!.col).not.toBe(second['agent']!.col);
  });

  it('tidies only what was not pinned', () => {
    const model = runtime();
    const messy = { 'session-registry': { row: 5, col: 5 }, observer: { row: 0, col: 2, pinned: true as const }, 'semantic-state': { row: 9, col: -4 } };
    const tidy = tidyLayout(messy, model);
    expect(tidy['observer']).toEqual({ row: 0, col: 2, pinned: true });
    expect(tidy['session-registry']!.row).toBe(0);
    expect(tidy['semantic-state']!.row).toBe(1);
  });
});
