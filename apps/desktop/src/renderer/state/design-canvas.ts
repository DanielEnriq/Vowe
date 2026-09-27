import type { DesignLayout, DesignSlot } from '@vowe/core';

/**
 * Grid slots to pixels, and back.
 *
 * Every card is one width — a column of names reads as a composition, not a
 * scatter — and each row is as tall as its tallest card, so a part that holds
 * a responsibility pushes its row down rather than overlapping the next.
 * Pure, so what the canvas draws and where a drop lands are one calculation.
 */

export const CARD_WIDTH = 212;
export const COL_GAP = 56;
export const ROW_GAP = 68;
const DEFAULT_HEIGHT = 74;
const PITCH = CARD_WIDTH + COL_GAP;

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasGeometry {
  placed: Map<string, Placed>;
  width: number;
  height: number;
  /** The slot under a point on the stage. */
  slotAt(x: number, y: number): { row: number; col: number };
}

export function canvasGeometry(
  ids: readonly string[],
  layout: DesignLayout,
  heights: Readonly<Record<string, number>>,
): CanvasGeometry {
  const slots = ids.flatMap((id) => (layout[id] ? [[id, layout[id]!] as const] : []));
  if (!slots.length) return { placed: new Map(), width: 0, height: 0, slotAt: () => ({ row: 0, col: 0 }) };
  const minRow = Math.min(...slots.map(([, slot]) => slot.row));
  const maxRow = Math.max(...slots.map(([, slot]) => slot.row));
  const minCol = Math.min(...slots.map(([, slot]) => slot.col));
  const maxCol = Math.max(...slots.map(([, slot]) => slot.col));

  const rowHeight = new Map<number, number>();
  for (const [id, slot] of slots) {
    rowHeight.set(slot.row, Math.max(rowHeight.get(slot.row) ?? 0, heights[id] ?? DEFAULT_HEIGHT));
  }
  const rowTop = new Map<number, number>();
  let y = 0;
  for (let row = minRow; row <= maxRow; row += 1) {
    rowTop.set(row, y);
    y += (rowHeight.get(row) ?? DEFAULT_HEIGHT) + ROW_GAP;
  }

  const placed = new Map<string, Placed>();
  for (const [id, slot] of slots) {
    placed.set(id, {
      id,
      x: (slot.col - minCol) * PITCH,
      y: rowTop.get(slot.row)!,
      w: CARD_WIDTH,
      h: heights[id] ?? DEFAULT_HEIGHT,
    });
  }

  return {
    placed,
    width: (maxCol - minCol) * PITCH + CARD_WIDTH,
    height: y - ROW_GAP,
    slotAt(px, py) {
      const col = Math.round((px - CARD_WIDTH / 2) / PITCH) + minCol;
      if (py < 0) return { row: minRow + Math.floor(py / (DEFAULT_HEIGHT + ROW_GAP)), col };
      for (let row = minRow; row <= maxRow; row += 1) {
        const bottom = rowTop.get(row)! + (rowHeight.get(row) ?? DEFAULT_HEIGHT) + ROW_GAP / 2;
        if (py < bottom) return { row, col };
      }
      return { row: maxRow + 1 + Math.floor((py - y) / (DEFAULT_HEIGHT + ROW_GAP)), col };
    },
  };
}

/** The nearest slot in a row not held by another part. */
export function freeSlot(
  target: { row: number; col: number },
  layout: DesignLayout,
  live: readonly string[],
  moving: string,
): DesignSlot {
  const taken = new Set(live.filter((id) => id !== moving && layout[id]).map((id) => `${layout[id]!.row}:${layout[id]!.col}`));
  for (let distance = 0; ; distance += 1) {
    for (const col of [target.col + distance, target.col - distance]) {
      if (!taken.has(`${target.row}:${col}`)) return { row: target.row, col };
    }
  }
}

/**
 * A link as a soft curve: out of the bottom of a part into the top of the one
 * it feeds, or out of the side when they share a row. A link that would run
 * behind another card bows out into the gap beside it instead, so two links
 * never read as one line. `mid` is the curve's own midpoint, where a label sits.
 */
export function edgePath(from: Placed, to: Placed, others: readonly Placed[] = []): { d: string; mid: { x: number; y: number } } {
  const fx = from.x + from.w / 2;
  const tx = to.x + to.w / 2;
  let p0: Point, p1: Point, p2: Point, p3: Point;
  if (to.y >= from.y + from.h || from.y >= to.y + to.h) {
    const down = to.y >= from.y + from.h;
    const y1 = down ? from.y + from.h : from.y;
    const y2 = down ? to.y - 6 : to.y + to.h + 6;
    const bend = Math.max(24, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
    p0 = { x: fx, y: y1 };
    p1 = { x: fx, y: y1 + bend };
    p2 = { x: tx, y: y2 - bend };
    p3 = { x: tx, y: y2 };
    const blocking = others.filter((card) => card.id !== from.id && card.id !== to.id && crosses(card, p0, p1, p2, p3));
    if (blocking.length) {
      // Into the gap to the right of whatever is in the way; a cubic reaches
      // about three quarters of the way to its control points.
      const edge = Math.max(...blocking.map((card) => card.x + card.w)) + COL_GAP / 2;
      const lane = Math.max(fx, tx) + (edge - Math.max(fx, tx)) / 0.75;
      p1 = { x: lane, y: y1 + bend / 2 };
      p2 = { x: lane, y: y2 - bend / 2 };
    }
  } else {
    const rightward = to.x > from.x;
    const x1 = rightward ? from.x + from.w : from.x;
    const x2 = rightward ? to.x - 6 : to.x + to.w + 6;
    const y1 = from.y + from.h / 2;
    const y2 = to.y + to.h / 2;
    const bend = Math.max(20, Math.abs(x2 - x1) / 2) * (rightward ? 1 : -1);
    p0 = { x: x1, y: y1 };
    p1 = { x: x1 + bend, y: y1 };
    p2 = { x: x2 - bend, y: y2 };
    p3 = { x: x2, y: y2 };
  }
  return {
    d: `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`,
    mid: bezier(p0, p1, p2, p3, 0.5),
  };
}

interface Point { x: number; y: number }

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Whether the curve passes through a card, sampled. */
function crosses(card: Placed, p0: Point, p1: Point, p2: Point, p3: Point): boolean {
  for (let step = 1; step < 20; step += 1) {
    const point = bezier(p0, p1, p2, p3, step / 20);
    if (point.x > card.x - 4 && point.x < card.x + card.w + 4 && point.y > card.y - 4 && point.y < card.y + card.h + 4) return true;
  }
  return false;
}
