import { describe, expect, it } from 'vitest';

import {
  applyOps,
  EMPTY_MODEL,
  groupBoxes,
  groupMembers,
  placeParts,
  settleGroups,
  tidyLayout,
  type DesignLayout,
  type DesignModel,
  type DesignOp,
} from '../src/studio/design-model.js';

/*
 * Boundaries in the layout: a group is drawn around its members, so they sit
 * together, nothing else sits among them, and two groups never overlap. The
 * layout corrects only what breaks that, and otherwise never moves anything.
 */

function model(ops: DesignOp[], base: DesignModel = EMPTY_MODEL): DesignModel {
  const result = applyOps(base, ops);
  expect(result.rejected).toEqual([]);
  return result.model;
}

const AI: DesignOp[] = [
  { op: 'part', id: 'web', name: 'Web app', role: '', kind: 'client' },
  { op: 'part', id: 'backend', name: 'Backend', role: '', kind: 'group' },
  { op: 'part', id: 'api', name: 'API', role: '', kind: 'service', within: 'backend' },
  { op: 'part', id: 'db', name: 'Document store', role: '', kind: 'store', within: 'backend' },
  { op: 'part', id: 'jobs', name: 'Job queue', role: '', kind: 'queue', within: 'backend' },
  { op: 'part', id: 'worker', name: 'Summarizer worker', role: '', kind: 'service', within: 'backend' },
  { op: 'part', id: 'model', name: 'Model provider', role: '', kind: 'external', technology: { name: 'Anthropic' } },
  { op: 'link', from: 'web', to: 'api' },
  { op: 'link', from: 'api', to: 'db' },
  { op: 'link', from: 'api', to: 'jobs' },
  { op: 'link', from: 'jobs', to: 'worker' },
  { op: 'link', from: 'worker', to: 'db' },
  { op: 'link', from: 'worker', to: 'model' },
];

/** Every boundary whole: members touching, nothing else inside, no two overlapping, no two parts on one cell. */
function expectWhole(layout: DesignLayout, design: DesignModel): void {
  const groups = groupMembers(design);
  const boxes = groupBoxes(layout, design);
  const live = design.parts.filter((part) => !part.retired && part.kind !== 'group');
  const cells = live.map((part) => `${layout[part.id]!.row}:${layout[part.id]!.col}`);
  expect(new Set(cells).size).toBe(cells.length);
  for (const [group, box] of boxes) {
    const members = new Set(groups.get(group));
    for (const part of live) {
      const slot = layout[part.id]!;
      const within = slot.row >= box.top && slot.row <= box.bottom && slot.col >= box.left && slot.col <= box.right;
      if (!members.has(part.id)) expect(within, `${part.id} sits inside ${group}`).toBe(false);
    }
    for (const [other, otherBox] of boxes) {
      if (other === group) continue;
      const overlap = box.left <= otherBox.right && otherBox.left <= box.right && box.top <= otherBox.bottom && otherBox.top <= box.bottom;
      expect(overlap, `${group} overlaps ${other}`).toBe(false);
    }
    // Members form one cluster.
    const slots = [...members].map((id) => layout[id]!);
    const reached = new Set([0]);
    const queue = [0];
    while (queue.length) {
      const here = slots[queue.shift()!]!;
      slots.forEach((there, index) => {
        if (!reached.has(index) && Math.abs(there.row - here.row) <= 1 && Math.abs(there.col - here.col) <= 1) {
          reached.add(index);
          queue.push(index);
        }
      });
    }
    expect(reached.size, `${group} is in pieces`).toBe(slots.length);
  }
}

describe('group-aware layout', () => {
  it('places a group’s members together, with the rest of the system around it', () => {
    const design = model(AI);
    const layout = placeParts({}, design);
    expectWhole(layout, design);
    const box = groupBoxes(layout, design).get('backend')!;
    expect(layout['web']!.row).toBeLessThan(box.top);
    // A populated group waits where its box begins.
    expect(layout['backend']).toEqual({ row: box.top, col: box.left });
  });

  it('never moves anything when nothing breaks a boundary, across a reload and an unrelated turn', () => {
    const design = model(AI);
    const first = placeParts({}, design);
    const reloaded = JSON.parse(JSON.stringify(first)) as DesignLayout;
    expect(settleGroups(reloaded, design)).toEqual(first);
    const grown = model([{ op: 'part', id: 'cdn', name: 'CDN', role: '', kind: 'external' }, { op: 'link', from: 'cdn', to: 'web' }], design);
    const second = placeParts(reloaded, grown);
    for (const [id, slot] of Object.entries(first)) expect(second[id], id).toEqual(slot);
    expectWhole(second, grown);
  });

  it('moves a part that joins a group in beside the others, and nothing else', () => {
    const design = model([
      { op: 'part', id: 'web', name: 'Web app', role: '', kind: 'client' },
      { op: 'part', id: 'backend', name: 'Backend', role: '', kind: 'group' },
      { op: 'part', id: 'api', name: 'API', role: '', kind: 'service', within: 'backend' },
      { op: 'part', id: 'auth', name: 'Auth', role: '', kind: 'service', within: 'backend' },
      { op: 'part', id: 'db', name: 'Database', role: '', kind: 'store' },
      { op: 'link', from: 'web', to: 'api' },
      { op: 'link', from: 'web', to: 'auth' },
      { op: 'link', from: 'api', to: 'db' },
    ]);
    const before = placeParts({ db: { row: 6, col: 4 } }, design);
    expectWhole(before, design);
    const joined = model([{ op: 'part', id: 'db', within: 'backend' }], design);
    const after = placeParts(before, joined);
    expectWhole(after, joined);
    expect(after['db']).not.toEqual(before['db']);
    for (const id of ['web', 'api', 'auth']) expect(after[id], id).toEqual(before[id]);
  });

  it('steps a part that leaves a group out of its line, keeping its row', () => {
    const design = model(AI);
    const before = placeParts({}, design);
    const box = groupBoxes(before, design).get('backend')!;
    // The member in the middle of the box is the interesting one to take out.
    const middle = groupMembers(design).get('backend')!.find((id) => {
      const slot = before[id]!;
      return slot.row > box.top && slot.row < box.bottom;
    }) ?? 'db';
    const left = model([{ op: 'part', id: middle, within: null }], design);
    const after = placeParts(before, left);
    expectWhole(after, left);
    expect(after[middle]!.row).toBe(before[middle]!.row);
    for (const id of ['web', 'model']) expect(after[id], id).toEqual(before[id]);
  });

  it('keeps an empty group where it waits, and puts its first member there', () => {
    const empty = model([
      { op: 'part', id: 'web', name: 'Web app', role: '', kind: 'client' },
      { op: 'part', id: 'backend', name: 'Backend', role: '', kind: 'group' },
      { op: 'link', from: 'web', to: 'backend' },
    ]);
    const waiting = placeParts({}, empty);
    expect(waiting['backend']).toEqual({ row: 1, col: 0 });
    const first = model([{ op: 'part', id: 'api', name: 'API', role: '', within: 'backend' }], empty);
    const placed = placeParts(waiting, first);
    expect(placed['api']).toEqual({ row: 1, col: 0 });
    expect(placed['backend']).toEqual({ row: 1, col: 0 });
    expect(placed['web']).toEqual(waiting['web']);

    // Emptied, the group waits beside what used to be inside it.
    const emptied = model([{ op: 'part', id: 'api', within: null }], first);
    const after = placeParts(placed, emptied);
    expect(after['api']).toEqual(placed['api']);
    expect(after['backend']!.row).toBe(1);
    expect(after['backend']!.col).not.toBe(after['api']!.col);
  });

  it('keeps two groups side by side, never over each other', () => {
    const design = model([
      { op: 'part', id: 'front', name: 'Frontend', role: '', kind: 'group' },
      { op: 'part', id: 'back', name: 'Backend', role: '', kind: 'group' },
      { op: 'part', id: 'web', name: 'Web', role: '', within: 'front' },
      { op: 'part', id: 'admin', name: 'Admin', role: '', within: 'front' },
      { op: 'part', id: 'api', name: 'API', role: '', within: 'back' },
      { op: 'part', id: 'db', name: 'DB', role: '', within: 'back' },
    ]);
    // Everything on one row, interleaved: the worst start.
    const layout = settleGroups({ web: { row: 0, col: 0 }, api: { row: 0, col: 1 }, admin: { row: 0, col: 2 }, db: { row: 0, col: 3 } }, design);
    expectWhole(layout, design);
  });

  it('tidies each group into a band of its own', () => {
    const design = model(AI);
    const scattered: DesignLayout = {
      web: { row: 3, col: 5 }, api: { row: 0, col: -3 }, db: { row: 8, col: 2 }, jobs: { row: 1, col: 9 }, worker: { row: 4, col: 0 }, model: { row: 2, col: 1 },
    };
    const tidy = tidyLayout(scattered, design);
    expectWhole(tidy, design);
    const box = groupBoxes(tidy, design).get('backend')!;
    expect(tidy['web']!.row).toBeLessThan(box.top);
    expect(box.right - box.left).toBeLessThanOrEqual(1);
  });

  it('draws a link to a group from above it', () => {
    const design = model([
      { op: 'part', id: 'backend', name: 'Backend', role: '', kind: 'group' },
      { op: 'part', id: 'api', name: 'API', role: '', within: 'backend' },
      { op: 'part', id: 'web', name: 'Web', role: '', kind: 'client' },
      { op: 'link', from: 'web', to: 'backend' },
    ]);
    const layout = tidyLayout(placeParts({}, design), design);
    expect(layout['web']!.row).toBeLessThan(layout['api']!.row);
  });

  it('tidies a system we do not run to the edge of the drawing, keeping its row', () => {
    const design = model([
      { op: 'part', id: 'web', name: 'Web', role: '', kind: 'client' },
      { op: 'part', id: 'auth', name: 'Auth', role: '', kind: 'service' },
      { op: 'part', id: 'api', name: 'API', role: '', kind: 'service' },
      { op: 'part', id: 'db', name: 'Database', role: '', kind: 'store' },
      { op: 'part', id: 'stripe', name: 'Stripe', role: '', kind: 'external' },
      { op: 'link', from: 'web', to: 'auth' },
      { op: 'link', from: 'web', to: 'api' },
      { op: 'link', from: 'api', to: 'db' },
      { op: 'link', from: 'api', to: 'stripe' },
    ]);
    const tidy = tidyLayout(placeParts({}, design), design);
    const ours = ['web', 'auth', 'api', 'db'].map((id) => tidy[id]!.col);
    const stripe = tidy['stripe']!;
    expect(stripe.row).toBe(tidy['db']!.row);
    expect(stripe.col > Math.max(...ours) || stripe.col < Math.min(...ours)).toBe(true);

    // Outside the backend's boundary too, and a pinned external stays where it was put.
    const ai = model(AI);
    const aiTidy = tidyLayout(placeParts({}, ai), ai);
    expectWhole(aiTidy, ai);
    const box = groupBoxes(aiTidy, ai).get('backend')!;
    expect(aiTidy['model']!.col > box.right || aiTidy['model']!.col < box.left).toBe(true);
    const pinned = tidyLayout({ ...aiTidy, model: { row: 9, col: 0, pinned: true } }, ai);
    expect(pinned['model']).toEqual({ row: 9, col: 0, pinned: true });
  });
});
