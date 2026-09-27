import { describe, expect, it } from 'vitest';

import type { DesignModel, DesignOp } from '@vowe/core';
import { applyOps, EMPTY_MODEL, groupMembers, placeParts, settleGroups } from '@vowe/core/studio-model';

import { canvasGeometry, frameAt, GROUP_HEAD, GROUP_PAD, outsideFrame, routeLinks, type Point } from '../src/renderer/state/design-canvas.js';
import { partLook, technologyLine, technologyMark } from '../src/renderer/state/part-presentation.js';
import { canvasChanges, NO_CHANGES } from '../src/renderer/state/studio-motion.js';
import { AI_PRODUCT, AI_PRODUCT_STORE_OUTSIDE, DESIGNS, LEGACY, MARKETPLACE, SIMPLE_SAAS } from './fixtures/studio-designs.js';

/*
 * The system-design grammar as the canvas draws it: kinds as quiet looks,
 * technology as seasoning, groups as boundaries around their parts, and
 * semantic changes as motion — against the canonical designs, not toy graphs.
 */

function model(ops: DesignOp[], base: DesignModel = EMPTY_MODEL): DesignModel {
  const result = applyOps(base, ops);
  expect(result.rejected).toEqual([]);
  return result.model;
}

/** What the canvas draws for a design: its cards, its empty groups, its boundaries. */
function drawn(design: DesignModel, layout = placeParts({}, design)) {
  const groups = groupMembers(design);
  const parts = design.parts.filter((part) => !part.retired && part.kind !== 'group').map((part) => part.id);
  const waiting = [...groups].filter(([, members]) => !members.length).map(([id]) => id);
  return { layout, groups, geometry: canvasGeometry([...parts, ...waiting], layout, {}, groups) };
}

function crossings(points: readonly Point[], y: number, x0: number, x1: number): boolean {
  // A horizontal run lying on a boundary's top or bottom edge.
  return points.slice(0, -1).some((a, index) => {
    const b = points[index + 1]!;
    return a.y === b.y && Math.abs(a.y - y) < 2 && Math.max(a.x, b.x) > x0 && Math.min(a.x, b.x) < x1;
  });
}

describe('kinds, as looks', () => {
  it('draws a part with no kind, or a kind it does not know, as the plain service card', () => {
    expect(partLook({})).toBe('service');
    expect(partLook({ kind: 'service' })).toBe('service');
    expect(partLook({ kind: 'database' as never })).toBe('service');
    expect(['client', 'store', 'queue', 'external'].map((kind) => partLook({ kind: kind as never }))).toEqual(['client', 'store', 'queue', 'external']);
  });
});

describe('technology, as seasoning', () => {
  it('finds a mark from the key, the name, an alias or the first word — never only an exact slug', () => {
    expect(technologyMark({ name: 'PostgreSQL', key: 'postgresql' })).toBeTruthy();
    expect(technologyMark({ name: 'PostgreSQL' })).toBe(technologyMark({ name: 'PostgreSQL', key: 'postgresql' }));
    expect(technologyMark({ name: 'Postgres' })).toBe(technologyMark({ name: 'PostgreSQL' }));
    expect(technologyMark({ name: 'Supabase Auth', key: 'supabase' })).toBe(technologyMark({ name: 'Supabase' }));
    expect(technologyMark({ name: 'Next.js' })).toBeTruthy();
    expect(technologyMark({ name: 'Anything', key: 'a-key-nobody-knows' })).toBeNull();
  });

  it('degrades to the name alone for a technology it has no mark for', () => {
    expect(technologyLine({ name: 'Search Index', technology: { name: 'OpenSearch' } })).toEqual({ name: 'OpenSearch', mark: null });
    expect(technologyLine({ name: 'Gateway', technology: { name: 'WebSockets' } })).toEqual({ name: 'WebSockets', mark: null });
  });

  it('does not repeat what the name already says', () => {
    const stripe = technologyLine({ name: 'Stripe', technology: { name: 'Stripe', key: 'stripe' } });
    expect(stripe?.name).toBeNull();
    expect(stripe?.mark).toBeTruthy();
    expect(technologyLine({ name: 'Resend', technology: { name: 'Resend-ish thing nobody marks' } })?.name).toBeTruthy();
    expect(technologyLine({ name: 'OpenSearch', technology: { name: 'OpenSearch' } })).toBeNull();
    expect(technologyLine({ name: 'API' })).toBeNull();
  });
});

describe('boundaries, drawn', () => {
  it('draws a group around its members, with room for its name, and every member inside', () => {
    const design = model(AI_PRODUCT.ops);
    const { geometry, groups } = drawn(design);
    const frame = geometry.frames.get('backend')!;
    expect(frame.empty).toBe(false);
    expect(geometry.placed.has('backend')).toBe(false);
    for (const id of groups.get('backend')!) {
      const card = geometry.placed.get(id)!;
      expect(card.x - frame.x).toBeGreaterThanOrEqual(GROUP_PAD);
      expect(frame.x + frame.w - (card.x + card.w)).toBeGreaterThanOrEqual(GROUP_PAD);
      expect(card.y - frame.y).toBeGreaterThanOrEqual(GROUP_PAD);
      expect(frame.y + frame.h - (card.y + card.h)).toBeGreaterThanOrEqual(GROUP_PAD);
    }
    // The name's row: the top member row starts a head's height below the edge.
    expect(Math.min(...groups.get('backend')!.map((id) => geometry.placed.get(id)!.y)) - frame.y).toBe(GROUP_HEAD);
    // Nothing outside the group is drawn inside it.
    for (const id of ['web', 'model']) {
      const card = geometry.placed.get(id)!;
      const inside = card.x < frame.x + frame.w && card.x + card.w > frame.x && card.y < frame.y + frame.h && card.y + card.h > frame.y;
      expect(inside, id).toBe(false);
    }
  });

  it('grows around a part that joins, and shrinks when it leaves', () => {
    const outside = model(AI_PRODUCT_STORE_OUTSIDE.ops);
    const before = drawn(outside);
    const joined = model(AI_PRODUCT_STORE_OUTSIDE.moves![0]!.ops, outside);
    const after = drawn(joined, placeParts(before.layout, joined));
    const was = before.geometry.frames.get('backend')!;
    const now = after.geometry.frames.get('backend')!;
    expect(now.w * now.h).toBeGreaterThan(was.w * was.h);
    const store = after.geometry.placed.get('db')!;
    expect(store.x).toBeGreaterThan(now.x);
    expect(store.x + store.w).toBeLessThan(now.x + now.w);

    const left = model([{ op: 'part', id: 'db', within: null }], joined);
    const again = drawn(left, placeParts(after.layout, left)).geometry.frames.get('backend')!;
    expect(again.w * again.h).toBeLessThan(now.w * now.h);
  });

  it('draws a design with no groups exactly as before: no margins, no frames', () => {
    for (const fixture of [SIMPLE_SAAS, LEGACY]) {
      const design = model(fixture.ops);
      const { geometry, layout } = drawn(design);
      const plain = canvasGeometry(Object.keys(layout), layout, {});
      expect(geometry.frames.size).toBe(0);
      for (const [id, card] of plain.placed) expect(geometry.placed.get(id)).toEqual(card);
      expect(geometry.rows.every((row) => row.before === 0 && row.after === 0)).toBe(true);
    }
  });

  it('draws an empty group where it waits, and lets links end on it', () => {
    const design = model([
      { op: 'part', id: 'clients', name: 'Clients', role: '', kind: 'client' },
      { op: 'part', id: 'edge', name: 'Edge', role: '', kind: 'group' },
      { op: 'link', from: 'clients', to: 'edge' },
    ]);
    const { geometry } = drawn(design);
    const frame = geometry.frames.get('edge')!;
    expect(frame.empty).toBe(true);
    const route = routeLinks([{ id: 'clients->edge', from: 'clients', to: 'edge' }], geometry).get('clients->edge')!;
    const end = route.points[route.points.length - 1]!;
    expect(end.x).toBeGreaterThan(frame.x);
    expect(end.x).toBeLessThan(frame.x + frame.w);
    expect(Math.abs(end.y - frame.y)).toBeLessThanOrEqual(4);
  });

  it('ends a link to a populated group on its boundary, at the side facing the other end', () => {
    const design = model([
      { op: 'part', id: 'web', name: 'Web', role: '', kind: 'client' },
      { op: 'part', id: 'backend', name: 'Backend', role: '', kind: 'group' },
      { op: 'part', id: 'api', name: 'API', role: '', within: 'backend' },
      { op: 'part', id: 'db', name: 'DB', role: '', kind: 'store', within: 'backend' },
      { op: 'link', from: 'api', to: 'db' },
      { op: 'link', from: 'web', to: 'backend' },
    ]);
    const { geometry } = drawn(design);
    const frame = geometry.frames.get('backend')!;
    const route = routeLinks([{ id: 'web->backend', from: 'web', to: 'backend' }], geometry).get('web->backend')!;
    const end = route.points[route.points.length - 1]!;
    expect(Math.abs(end.y - frame.y)).toBeLessThanOrEqual(4);
  });

  it('runs lines across a boundary through open space, never along its edge', () => {
    for (const fixture of [AI_PRODUCT, MARKETPLACE]) {
      const design = model(fixture.ops);
      const { geometry } = drawn(design);
      const links = design.links.filter((link) => !link.retired);
      const routes = routeLinks(links, geometry);
      for (const frame of geometry.frames.values()) {
        for (const link of links) {
          const points = routes.get(link.id)!.points;
          expect(crossings(points, frame.y, frame.x, frame.x + frame.w), `${link.id} on ${frame.id}’s top`).toBe(false);
          expect(crossings(points, frame.y + frame.h, frame.x, frame.x + frame.w), `${link.id} on ${frame.id}’s bottom`).toBe(false);
        }
      }
    }
  });

  it('only counts a dragged part as entering a boundary once it is well inside, and as leaving once well outside', () => {
    const { geometry } = drawn(model(AI_PRODUCT.ops));
    const frame = geometry.frames.get('backend')!;
    const midY = frame.y + frame.h / 2;
    expect(frameAt(geometry.frames, frame.x + 10, midY, 24)).toBeNull();
    expect(frameAt(geometry.frames, frame.x + 40, midY, 24)).toBe('backend');
    expect(outsideFrame(frame, frame.x - 10, midY, 24)).toBe(false);
    expect(outsideFrame(frame, frame.x - 40, midY, 24)).toBe(true);
  });

  it('keeps every canonical design whole and stable across a reload', () => {
    for (const fixture of DESIGNS) {
      const design = model(fixture.ops);
      const layout = placeParts({}, design);
      expect(settleGroups(JSON.parse(JSON.stringify(layout)), design), fixture.title).toEqual(layout);
      const { geometry } = drawn(design, layout);
      const cards = [...geometry.placed.values()];
      for (const a of cards) for (const b of cards) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        expect(overlap, `${fixture.title}: ${a.id} over ${b.id}`).toBe(false);
      }
    }
  });
});

describe('semantic changes, as motion', () => {
  it('moves a part into a boundary without a glow, and names where it left and joined', () => {
    const before = model(AI_PRODUCT_STORE_OUTSIDE.ops);
    const after = model(AI_PRODUCT_STORE_OUTSIDE.moves![0]!.ops, before);
    const changes = canvasChanges(before, after);
    expect(changes.regrouped.get('db')).toEqual({ from: null, to: 'backend' });
    expect(changes.touched.has('db')).toBe(false);
    const out = canvasChanges(after, model([{ op: 'part', id: 'db', within: null }], after));
    expect(out.regrouped.get('db')).toEqual({ from: 'backend', to: null });
  });

  it('changes a technology in place', () => {
    const before = model(SIMPLE_SAAS.ops);
    const after = model(SIMPLE_SAAS.moves![1]!.ops, before);
    const changes = canvasChanges(before, after);
    expect([...changes.retech]).toEqual(['api']);
    expect(changes.entering).toEqual([]);
  });

  it('does not move anything when only a technology’s key is corrected', () => {
    const before = model(SIMPLE_SAAS.ops);
    const after = model([{ op: 'part', id: 'db', technology: { name: 'PostgreSQL', key: 'postgres' } }], before);
    expect(canvasChanges(before, after)).toBe(NO_CHANGES);
  });

  it('brings an external system in along its links', () => {
    const before = model(SIMPLE_SAAS.ops);
    const after = model(SIMPLE_SAAS.moves![0]!.ops, before);
    const changes = canvasChanges(before, after);
    expect(changes.entering).toEqual(['stripe']);
    expect([...changes.drawn].sort()).toEqual(['api->stripe', 'stripe->api']);
  });

  it('flies a responsibility from the API to the worker', () => {
    const before = model(AI_PRODUCT.ops);
    const after = model(AI_PRODUCT.moves![0]!.ops, before);
    const changes = canvasChanges(before, after);
    expect(changes.moved.map(({ duty, from, to }) => [duty.id, from, to])).toEqual([['retries', 'api', 'worker']]);
  });
});
