import { describe, expect, it } from 'vitest';

import type { DesignLayout } from '@vowe/core';

import { canvasGeometry, freeSlot, looseRoute, placeLabels, roundedPath, routeLinks, type Placed, type Point } from '../src/renderer/state/design-canvas.js';

const commands = (d: string) => d.replace(/[-\d.\s,]+/g, '');

function lay(slots: Record<string, [number, number]>, heights: Record<string, number> = {}) {
  const layout: DesignLayout = Object.fromEntries(Object.entries(slots).map(([id, [row, col]]) => [id, { row, col }]));
  return canvasGeometry(Object.keys(slots), layout, heights);
}

function link(from: string, to: string) {
  return { id: `${from}->${to}`, from, to };
}

/** Whether a polyline passes through the inside of a card. */
function pierces(points: readonly Point[], card: Placed): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index]!;
    const b = points[index + 1]!;
    for (let step = 0; step <= 20; step += 1) {
      const x = a.x + ((b.x - a.x) * step) / 20;
      const y = a.y + ((b.y - a.y) * step) / 20;
      if (x > card.x + 1 && x < card.x + card.w - 1 && y > card.y + 1 && y < card.y + card.h - 1) return true;
    }
  }
  return false;
}

function noneThroughCards(geometry: ReturnType<typeof lay>, links: ReturnType<typeof link>[]) {
  const routes = routeLinks(links, geometry.placed, geometry.rows);
  for (const each of links) {
    const route = routes.get(each.id)!;
    for (const card of geometry.placed.values()) {
      if (card.id === each.from || card.id === each.to) continue;
      expect(pierces(route.points, card), `${each.id} through ${card.id}`).toBe(false);
    }
  }
  return routes;
}

describe('canvas geometry', () => {
  it('gives every card in a row the row’s height, from the measured faces', () => {
    const geometry = lay({ a: [0, 0], b: [0, 1], c: [1, 0] }, { a: 60, b: 90, c: 70 });
    expect(geometry.placed.get('a')!.h).toBe(90);
    expect(geometry.placed.get('b')!.h).toBe(90);
    expect(geometry.placed.get('c')!.y).toBeGreaterThan(90);
    expect(geometry.rows).toHaveLength(2);
  });

  it('normalises grid positions and maps a point back to its slot', () => {
    const geometry = lay({ a: [3, 5], b: [4, 6] });
    expect(geometry.placed.get('a')).toMatchObject({ row: 0, col: 0, x: 0, y: 0 });
    const b = geometry.placed.get('b')!;
    expect(geometry.slotAt(b.x + b.w / 2, b.y + b.h / 2)).toEqual({ row: 4, col: 6 });
    expect(geometry.slotRect({ row: 4, col: 6 })).toMatchObject({ x: b.x, y: b.y });
  });

  it('finds the nearest free slot in the row, ignoring the part being moved', () => {
    const layout: DesignLayout = { a: { row: 0, col: 0 }, b: { row: 0, col: 1 } };
    expect(freeSlot({ row: 0, col: 0 }, layout, ['a', 'b'], 'a')).toEqual({ row: 0, col: 0 });
    expect(freeSlot({ row: 0, col: 1 }, layout, ['a', 'b'], 'a')).toEqual({ row: 0, col: 2 });
    expect(freeSlot({ row: 1, col: 1 }, layout, ['a', 'b'], 'a')).toEqual({ row: 1, col: 1 });
  });
});

describe('link routing', () => {
  it('always draws the same command sequence, so any route can morph into any other', () => {
    const geometry = lay({ a: [0, 0], b: [1, 2], c: [0, 1], d: [3, 0], x: [1, 0], y: [2, 0] });
    const routes = routeLinks([link('a', 'b'), link('a', 'c'), link('a', 'd'), link('d', 'a')], geometry.placed, geometry.rows);
    const shapes = new Set([...routes.values()].map((route) => commands(route.d)));
    shapes.add(commands(looseRoute(geometry.placed.get('a')!, geometry.placed.get('b')!).d));
    expect(shapes.size).toBe(1);
    for (const route of routes.values()) expect(route.points).toHaveLength(6);
  });

  it('leaves the bottom of a part and enters the top of the one below', () => {
    const geometry = lay({ a: [0, 0], b: [1, 1] });
    const route = routeLinks([link('a', 'b')], geometry.placed, geometry.rows).get('a->b')!;
    const a = geometry.placed.get('a')!;
    const b = geometry.placed.get('b')!;
    expect(route.points[0]).toEqual({ x: a.x + a.w / 2, y: a.y + a.h });
    expect(route.points[5]!.x).toBe(b.x + b.w / 2);
    expect(route.points[5]!.y).toBeLessThan(b.y);
    // Orthogonal: every run is horizontal or vertical.
    for (let index = 0; index < 5; index += 1) {
      const p = route.points[index]!;
      const q = route.points[index + 1]!;
      expect(p.x === q.x || p.y === q.y).toBe(true);
    }
  });

  it('fans links out of one part from a single trunk on one track', () => {
    const geometry = lay({ hub: [0, 1], a: [1, 0], b: [1, 1], c: [1, 2] });
    const routes = routeLinks([link('hub', 'a'), link('hub', 'b'), link('hub', 'c')], geometry.placed, geometry.rows);
    const starts = new Set([...routes.values()].map((route) => `${route.points[0]!.x},${route.points[0]!.y}`));
    const tracks = new Set([...routes.values()].map((route) => route.points[2]!.y));
    expect(starts.size).toBe(1);
    expect(tracks.size).toBe(1);
  });

  it('merges links into one part onto one entry, and keeps unrelated runs on their own tracks', () => {
    const geometry = lay({ a: [0, 0], b: [0, 1], c: [0, 2], sink: [1, 1], other: [1, 3], feeder: [0, 3] });
    const routes = routeLinks([link('a', 'sink'), link('c', 'sink'), link('b', 'other')], geometry.placed, geometry.rows);
    const into = [routes.get('a->sink')!, routes.get('c->sink')!];
    expect(into[0]!.points[5]).toEqual(into[1]!.points[5]);
    expect(into[0]!.points[2]!.y).toBe(into[1]!.points[2]!.y);
    expect(routes.get('b->other')!.points[2]!.y).not.toBe(into[0]!.points[2]!.y);
  });

  it('keeps a side that sends and receives from reading as one line', () => {
    const geometry = lay({ a: [0, 0], b: [1, 0] });
    const routes = routeLinks([link('a', 'b'), link('b', 'a')], geometry.placed, geometry.rows);
    expect(routes.get('a->b')!.points[0]!.x).not.toBe(routes.get('b->a')!.points[5]!.x);
  });

  it('never runs a line through a part that is not one of its ends', () => {
    // Three parts: a straight chain.
    noneThroughCards(lay({ a: [0, 0], b: [1, 0], c: [2, 0] }), [link('a', 'b'), link('b', 'c'), link('a', 'c')]);
    // Eight parts, with a skip-row link blocked in both columns.
    const eight = lay({ a: [0, 0], b: [0, 1], c: [1, 0], d: [1, 1], e: [2, 0], f: [2, 1], g: [3, 0], h: [3, 1] });
    noneThroughCards(eight, [link('a', 'h'), link('b', 'g'), link('a', 'c'), link('c', 'e'), link('e', 'g'), link('b', 'd'), link('h', 'a')]);
    // Twelve parts in a dense topology, including links within a row past a neighbour.
    const ids = 'abcdefghijkl'.split('');
    const twelve = lay(Object.fromEntries(ids.map((id, index) => [id, [Math.floor(index / 4), index % 4] as [number, number]])));
    const dense = ids.flatMap((id, index) => ids.slice(index + 1).filter((_, offset) => (index + offset) % 3 === 0).map((other) => link(id, other)));
    noneThroughCards(twelve, dense);
  });

  it('softens corners without changing the path’s shape when a run is empty', () => {
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }]);
    expect(commands(d)).toBe('MLQLQLQLQL');
  });
});

describe('label placement', () => {
  it('puts labels where they fit, never on another label or a card, and drops what cannot be read', () => {
    const geometry = lay({ hub: [0, 1], a: [1, 0], b: [1, 1], c: [1, 2] });
    const links = [link('hub', 'a'), link('hub', 'b'), link('hub', 'c')];
    const routes = routeLinks(links, geometry.placed, geometry.rows);
    const placed = placeLabels(links.map((each) => ({ id: each.id, text: 'reads and writes' })), routes, [...geometry.placed.values()]);
    const boxes = [...placed.values()].map((at) => ({ x: at.anchor === 'middle' ? at.x - 50 : at.x, y: at.y - 10, w: 100, h: 12 }));
    for (const [index, box] of boxes.entries()) {
      for (const other of boxes.slice(index + 1)) {
        const overlap = box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y;
        expect(overlap).toBe(false);
      }
    }
    expect(placed.size).toBeGreaterThan(0);
    expect(placed.size).toBeLessThanOrEqual(3);
  });
});
