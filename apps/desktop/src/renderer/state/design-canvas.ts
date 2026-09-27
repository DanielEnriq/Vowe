import type { DesignLayout, DesignSlot } from '@vowe/core';

/**
 * Grid slots to pixels, and back; and the lines between parts.
 *
 * Every card is one width — a column of names reads as a composition, not a
 * scatter — and each row is as tall as its tallest card face, so rows never
 * overlap. Only the face is measured: whatever a card shows beside or beneath
 * itself when selected never moves the drawing. Pure, so what the canvas
 * draws and where a drop lands are one calculation.
 */

export const CARD_WIDTH = 216;
export const COL_GAP = 64;
export const ROW_GAP = 76;
const DEFAULT_HEIGHT = 64;
const PITCH = CARD_WIDTH + COL_GAP;
/** A boundary's inner margin beside and beneath what it holds. */
export const GROUP_PAD = 22;
/** Above what it holds: room for the boundary's name. */
export const GROUP_HEAD = 42;

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Grid position, normalised so the top-left occupied slot is 0,0. */
  row: number;
  col: number;
}

/**
 * A boundary around the parts inside it, or — while it holds none — a
 * compact boundary where it waits. `span` is the grid it covers, normalised.
 */
export interface Frame {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  span: { top: number; bottom: number; left: number; right: number };
  empty: boolean;
}

/** A row or column band: where cards sit, and the extra room a boundary edge takes on either side. */
export interface Band {
  top: number;
  bottom: number;
  /** Room a boundary takes above the band (rows) or before it (columns). */
  before: number;
  /** Room a boundary takes below the band, or after it. */
  after: number;
}

export interface CanvasGeometry {
  placed: Map<string, Placed>;
  /** Groups, drawn around their members. */
  frames: Map<string, Frame>;
  width: number;
  height: number;
  /** Each occupied-or-between row's top and bottom, by normalised row index. */
  rows: Band[];
  /** Each column's left (`top`) and right (`bottom`), by normalised column index. */
  cols: Band[];
  /** The slot under a point on the stage. */
  slotAt(x: number, y: number): { row: number; col: number };
  /** Where a slot's card would sit, for previewing a drop. */
  slotRect(slot: { row: number; col: number }): { x: number; y: number; w: number; h: number };
}

/**
 * Where everything is drawn. A group with members takes no slot: it is drawn
 * around them, and a row or column boundary that a group's edge lies on is
 * widened by the boundary's margin, so the grid stays a grid and a design
 * without groups is drawn exactly as before. An empty group is drawn where
 * it waits, the size of a card.
 */
export function canvasGeometry(
  ids: readonly string[],
  layout: DesignLayout,
  heights: Readonly<Record<string, number>>,
  groups: ReadonlyMap<string, readonly string[]> = new Map(),
): CanvasGeometry {
  const drawn = new Set(ids);
  const members = new Map([...groups].map(([id, list]) => [id, list.filter((member) => drawn.has(member) && layout[member])]));
  const populated = new Set([...members].filter(([, list]) => list.length).map(([id]) => id));
  const slots = ids.flatMap((id) => (layout[id] && !populated.has(id) ? [[id, layout[id]!] as const] : []));
  if (!slots.length) {
    return {
      placed: new Map(), frames: new Map(), width: 0, height: 0, rows: [], cols: [],
      slotAt: () => ({ row: 0, col: 0 }),
      slotRect: () => ({ x: 0, y: 0, w: CARD_WIDTH, h: DEFAULT_HEIGHT }),
    };
  }
  const minRow = Math.min(...slots.map(([, slot]) => slot.row));
  const maxRow = Math.max(...slots.map(([, slot]) => slot.row));
  const minCol = Math.min(...slots.map(([, slot]) => slot.col));
  const maxCol = Math.max(...slots.map(([, slot]) => slot.col));

  // Each populated group's box, and the margins its edges take.
  const boxes = new Map<string, Frame['span']>();
  for (const id of populated) {
    const cells = members.get(id)!.map((member) => layout[member]!);
    boxes.set(id, {
      top: Math.min(...cells.map((slot) => slot.row)),
      bottom: Math.max(...cells.map((slot) => slot.row)),
      left: Math.min(...cells.map((slot) => slot.col)),
      right: Math.max(...cells.map((slot) => slot.col)),
    });
  }
  const edge = (side: keyof Frame['span'], at: number) => [...boxes.values()].some((box) => box[side] === at);

  const rowHeight = new Map<number, number>();
  for (const [id, slot] of slots) {
    rowHeight.set(slot.row, Math.max(rowHeight.get(slot.row) ?? 0, heights[id] ?? DEFAULT_HEIGHT));
  }
  const rowTop = new Map<number, number>();
  const rows: Band[] = [];
  let y = 0;
  for (let row = minRow; row <= maxRow; row += 1) {
    const before = edge('top', row) ? GROUP_HEAD : 0;
    const after = edge('bottom', row) ? GROUP_PAD : 0;
    y += before;
    const height = rowHeight.get(row) ?? DEFAULT_HEIGHT;
    rowTop.set(row, y);
    rows.push({ top: y, bottom: y + height, before, after });
    y += height + after + ROW_GAP;
  }
  const height = y - ROW_GAP;

  const colLeft = new Map<number, number>();
  const cols: Band[] = [];
  let x = 0;
  for (let col = minCol; col <= maxCol; col += 1) {
    const before = edge('left', col) ? GROUP_PAD : 0;
    const after = edge('right', col) ? GROUP_PAD : 0;
    x += before;
    colLeft.set(col, x);
    cols.push({ top: x, bottom: x + CARD_WIDTH, before, after });
    x += CARD_WIDTH + after + COL_GAP;
  }
  const width = x - COL_GAP;

  const placed = new Map<string, Placed>();
  for (const [id, slot] of slots) {
    placed.set(id, {
      id,
      x: colLeft.get(slot.col)!,
      y: rowTop.get(slot.row)!,
      w: CARD_WIDTH,
      // A row is one height: cards that sit together end together.
      h: rowHeight.get(slot.row)!,
      row: slot.row - minRow,
      col: slot.col - minCol,
    });
  }

  const frames = new Map<string, Frame>();
  for (const [id, box] of boxes) {
    const left = colLeft.get(box.left)! - GROUP_PAD;
    const top = rowTop.get(box.top)! - GROUP_HEAD;
    const right = colLeft.get(box.right)! + CARD_WIDTH + GROUP_PAD;
    const bottom = rowTop.get(box.bottom)! + rowHeight.get(box.bottom)! + GROUP_PAD;
    frames.set(id, {
      id, x: left, y: top, w: right - left, h: bottom - top, empty: false,
      span: { top: box.top - minRow, bottom: box.bottom - minRow, left: box.left - minCol, right: box.right - minCol },
    });
  }
  for (const id of groups.keys()) {
    const at = placed.get(id);
    if (!at || populated.has(id)) continue;
    frames.set(id, { id, x: at.x, y: at.y, w: at.w, h: at.h, empty: true, span: { top: at.row, bottom: at.row, left: at.col, right: at.col } });
  }

  const step = DEFAULT_HEIGHT + ROW_GAP;
  const xOf = (col: number) =>
    col < minCol ? (col - minCol) * PITCH : col > maxCol ? width + COL_GAP + (col - maxCol - 1) * PITCH : colLeft.get(col)!;
  return {
    placed,
    frames,
    width,
    height,
    rows,
    cols,
    slotAt(px, py) {
      // Beyond the drawing, columns continue at the plain pitch.
      const lastEdge = width + COL_GAP / 2;
      let col = maxCol;
      if (px < -COL_GAP / 2) col = minCol - 1 - Math.floor((-COL_GAP / 2 - px) / PITCH);
      else if (px >= lastEdge) col = maxCol + 1 + Math.floor((px - lastEdge) / PITCH);
      else {
        for (let candidate = minCol; candidate <= maxCol; candidate += 1) {
          const band = cols[candidate - minCol]!;
          if (px < band.bottom + band.after + COL_GAP / 2) { col = candidate; break; }
        }
      }
      if (py < 0) return { row: minRow + Math.floor(py / step), col };
      for (let row = minRow; row <= maxRow; row += 1) {
        const band = rows[row - minRow]!;
        if (py < band.bottom + band.after + ROW_GAP / 2) return { row, col };
      }
      return { row: maxRow + 1 + Math.floor((py - height - ROW_GAP) / step), col };
    },
    slotRect({ row, col }) {
      const x = xOf(col);
      if (row < minRow) return { x, y: (row - minRow) * step, w: CARD_WIDTH, h: DEFAULT_HEIGHT };
      if (row > maxRow) return { x, y: height + ROW_GAP + (row - maxRow - 1) * step, w: CARD_WIDTH, h: DEFAULT_HEIGHT };
      return { x, y: rowTop.get(row)!, w: CARD_WIDTH, h: rowHeight.get(row) ?? DEFAULT_HEIGHT };
    },
  };
}

/**
 * The boundary a point is well inside, if any: `inset` in from its edge, so
 * crossing a boundary is not the same as entering it.
 */
export function frameAt(frames: ReadonlyMap<string, Frame>, x: number, y: number, inset: number): string | null {
  for (const frame of frames.values()) {
    if (x > frame.x + inset && x < frame.x + frame.w - inset && y > frame.y + inset && y < frame.y + frame.h - inset) return frame.id;
  }
  return null;
}

/** Whether a point is clearly outside a boundary: `margin` beyond its edge. */
export function outsideFrame(frame: Frame, x: number, y: number, margin: number): boolean {
  return x < frame.x - margin || x > frame.x + frame.w + margin || y < frame.y - margin || y > frame.y + frame.h + margin;
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

// ------------------------------------------------------------------ links

export interface Point { x: number; y: number }

export interface Route {
  /** Always six points — five segments, some of them empty — so every path has one shape and can morph into any other. */
  points: Point[];
  d: string;
  /** Where a label reads best: the middle of the longest straight run. */
  label: Point & { along: 'x' | 'y' };
}

interface RoutedLink { id: string; from: string; to: string }

type Side = 'top' | 'bottom' | 'left' | 'right';

const CORNER = 10;
const TRACK = 10;
/** How far apart a side's outgoing and incoming ports sit. */
const SPLIT = 16;
/** The gap between the arrow's tip and the card it points at. */
const ARRIVE = 3;

/**
 * Links drawn the way a person draws architecture: straight runs and soft
 * corners, out of the bottom of a part and into the top of the one it feeds.
 *
 * Several links on one side of a card leave from their own ports, ordered
 * by where they are going, so they fan out instead of stacking. Horizontal
 * runs travel in the gaps between rows and vertical detours in the gaps
 * between columns — the only space no card can ever occupy — and runs that
 * share a gap take separate tracks, so two links never read as one line.
 */
export function routeLinks(
  links: readonly RoutedLink[],
  geometry: Pick<CanvasGeometry, 'placed' | 'rows' | 'cols' | 'frames'>,
): Map<string, Route> {
  const { rows, cols, frames } = geometry;
  // A link to a group ends on its boundary, at the row nearest the other end.
  const centreRow = (id: string): number | null => {
    const card = geometry.placed.get(id);
    if (card) return card.row;
    const frame = frames.get(id);
    return frame ? (frame.span.top + frame.span.bottom) / 2 : null;
  };
  const endOf = (id: string, other: string): Placed | undefined => {
    const card = geometry.placed.get(id);
    if (card) return card;
    const frame = frames.get(id);
    const toward = centreRow(other);
    if (!frame || toward === null) return undefined;
    const row = Math.min(frame.span.bottom, Math.max(frame.span.top, Math.round(toward)));
    return { id, x: frame.x, y: frame.y, w: frame.w, h: frame.h, row, col: Math.round((frame.span.left + frame.span.right) / 2) };
  };
  const ends = new Map<string, { a: Placed; b: Placed }>();
  for (const link of links) {
    if (link.from === link.to) continue;
    const a = endOf(link.from, link.to);
    const b = endOf(link.to, link.from);
    if (a && b) ends.set(link.id, { a, b });
  }
  const drawable = links.filter((link) => ends.has(link.id));
  const placed = geometry.placed;
  // Runs travel the free part of each gap: clear of any boundary's margin.
  const gapAbove = (row: number) => (row <= 0 ? (rows[0] ? rows[0].top - rows[0].before : 0) - ROW_GAP / 2 : gapBelow(row - 1));
  const gapBelow = (row: number): number => {
    const here = rows[row];
    if (!here) return (rows[rows.length - 1]?.bottom ?? 0) + ROW_GAP / 2;
    const next = rows[row + 1];
    return next ? (here.bottom + here.after + next.top - next.before) / 2 : here.bottom + here.after + ROW_GAP / 2;
  };
  const laneX = (boundary: number): number => {
    if (!cols.length) return boundary * PITCH - COL_GAP / 2;
    if (boundary <= 0) return cols[0]!.top - cols[0]!.before - COL_GAP / 2 + boundary * PITCH;
    if (boundary >= cols.length) {
      const last = cols[cols.length - 1]!;
      return last.bottom + last.after + COL_GAP / 2 + (boundary - cols.length) * PITCH;
    }
    return (cols[boundary - 1]!.bottom + cols[boundary - 1]!.after + cols[boundary]!.top - cols[boundary]!.before) / 2;
  };

  // 1. Which side each end uses, and the shape of the route.
  interface Plan {
    link: RoutedLink;
    fromSide: Side;
    toSide: Side;
    /** Horizontal runs: which gap, keyed by the row it sits below. */
    runs: { gap: number; slot: number }[];
    lane: number | null;
    kind: 'step' | 'lane' | 'row-over' | 'beside';
  }
  const plans: Plan[] = [];
  for (const link of drawable) {
    const { a, b } = ends.get(link.id)!;
    if (a.row === b.row) {
      const between = [...placed.values()].some((card) => card.row === a.row && card.id !== a.id && card.id !== b.id && card.col > Math.min(a.col, b.col) && card.col < Math.max(a.col, b.col));
      if (!between) {
        plans.push({ link, fromSide: b.col > a.col ? 'right' : 'left', toSide: b.col > a.col ? 'left' : 'right', runs: [], lane: null, kind: 'beside' });
      } else {
        plans.push({ link, fromSide: 'top', toSide: 'top', runs: [{ gap: a.row - 1, slot: 0 }], lane: null, kind: 'row-over' });
      }
      continue;
    }
    const down = b.row > a.row;
    const fromSide: Side = down ? 'bottom' : 'top';
    const toSide: Side = down ? 'top' : 'bottom';
    const gapNearFrom = down ? a.row : a.row - 1;
    const gapNearTo = down ? b.row - 1 : b.row;
    if (Math.abs(b.row - a.row) === 1) {
      plans.push({ link, fromSide, toSide, runs: [{ gap: gapNearFrom, slot: 0 }], lane: null, kind: 'step' });
      continue;
    }
    // Spanning rows: a straight drop in either end's column if nothing is in
    // the way there, otherwise down the nearest gap between columns.
    const lo = Math.min(a.row, b.row);
    const hi = Math.max(a.row, b.row);
    const clear = (col: number) => ![...placed.values()].some((card) => card.col === col && card.row > lo && card.row < hi);
    if (clear(a.col)) {
      plans.push({ link, fromSide, toSide, runs: [{ gap: gapNearTo, slot: 0 }], lane: null, kind: 'step' });
    } else if (clear(b.col)) {
      plans.push({ link, fromSide, toSide, runs: [{ gap: gapNearFrom, slot: 0 }], lane: null, kind: 'step' });
    } else {
      const boundary = b.col > a.col ? a.col + 1 : b.col < a.col ? a.col : a.col + 1;
      plans.push({ link, fromSide, toSide, runs: [{ gap: gapNearFrom, slot: 0 }, { gap: gapNearTo, slot: 0 }], lane: boundary, kind: 'lane' });
    }
  }

  // 2. Ports: one per side of a card. Links leaving a part together leave as
  // one trunk and branch; links arriving together merge into one entry, so a
  // part fed by five others still has one arrow pointing at it.
  const sidePoint = (card: Placed, side: Side): Point =>
    side === 'top' ? { x: card.x + card.w / 2, y: card.y }
      : side === 'bottom' ? { x: card.x + card.w / 2, y: card.y + card.h }
        : side === 'left' ? { x: card.x, y: card.y + card.h / 2 }
          : { x: card.x + card.w, y: card.y + card.h / 2 };
  // A side that both sends and receives keeps the two apart: out on one
  // side of its centre, in on the other, so direction never reads double.
  const roles = new Map<string, Set<'from' | 'to'>>();
  for (const plan of plans) {
    roles.set(`${plan.link.from}:${plan.fromSide}`, (roles.get(`${plan.link.from}:${plan.fromSide}`) ?? new Set()).add('from'));
    roles.set(`${plan.link.to}:${plan.toSide}`, (roles.get(`${plan.link.to}:${plan.toSide}`) ?? new Set()).add('to'));
  }
  const portOf = (id: string, other: string, side: Side, end: 'from' | 'to'): Point => {
    const point = sidePoint(endOf(id, other)!, side);
    if (roles.get(`${id}:${side}`)!.size < 2) return point;
    const shift = end === 'from' ? -SPLIT : SPLIT;
    return side === 'top' || side === 'bottom' ? { x: point.x + shift, y: point.y } : { x: point.x, y: point.y + shift };
  };
  const port = new Map<string, Point>();
  for (const plan of plans) {
    port.set(`${plan.link.id}:from`, portOf(plan.link.from, plan.link.to, plan.fromSide, 'from'));
    port.set(`${plan.link.id}:to`, portOf(plan.link.to, plan.link.from, plan.toSide, 'to'));
  }

  // 3. Tracks. Runs through one gap that share a source branch from one
  // line, runs that share a target merge onto one, and everything else gets
  // a line of its own — so a shared line always means a shared end.
  const runSpan = (plan: Plan, index: number): [number, number] => {
    const start = port.get(`${plan.link.id}:from`)!;
    const end = port.get(`${plan.link.id}:to`)!;
    if (plan.kind === 'lane') {
      const lane = laneX(plan.lane!);
      return index === 0 ? [Math.min(start.x, lane), Math.max(start.x, lane)] : [Math.min(lane, end.x), Math.max(lane, end.x)];
    }
    return [Math.min(start.x, end.x), Math.max(start.x, end.x)];
  };
  const byGap = new Map<number, { plan: Plan; index: number; span: [number, number] }[]>();
  for (const plan of plans) {
    plan.runs.forEach((run, index) => {
      byGap.set(run.gap, [...(byGap.get(run.gap) ?? []), { plan, index, span: runSpan(plan, index) }]);
    });
  }
  const gapTracks = new Map<number, number>();
  for (const [gap, runs] of byGap) {
    // The end a run shares: its source when that source branches here, else its target.
    const leaving = new Map<string, number>();
    for (const run of runs) if (run.index === 0) leaving.set(run.plan.link.from, (leaving.get(run.plan.link.from) ?? 0) + 1);
    const groups = new Map<string, { runs: typeof runs; span: [number, number] }>();
    for (const run of runs) {
      const key = run.index === 0 && (leaving.get(run.plan.link.from) ?? 0) > 1 ? `from:${run.plan.link.from}` : `to:${run.plan.link.to}`;
      const group = groups.get(key);
      if (group) {
        group.runs.push(run);
        group.span = [Math.min(group.span[0], run.span[0]), Math.max(group.span[1], run.span[1])];
      } else groups.set(key, { runs: [run], span: [...run.span] });
    }
    const sorted = [...groups.values()].sort((p, q) => p.span[0] - q.span[0] || p.span[1] - q.span[1]);
    const ends: number[] = [];
    for (const group of sorted) {
      let track = ends.findIndex((end) => end < group.span[0] - 10);
      if (track === -1) { track = ends.length; ends.push(group.span[1]); } else ends[track] = group.span[1];
      for (const run of group.runs) run.plan.runs[run.index]!.slot = track;
    }
    gapTracks.set(gap, ends.length);
  }
  const trackY = (gap: number, slot: number) => {
    const count = gapTracks.get(gap) ?? 1;
    const centre = gap < 0 ? gapAbove(0) : gapBelow(gap);
    const spacing = Math.min(TRACK, (ROW_GAP - 28) / Math.max(1, count - 1));
    return centre + (slot - (count - 1) / 2) * spacing;
  };
  // Detours down one lane share it when they share a source, like a trunk.
  const laneUsers = new Map<number, string[]>();
  for (const plan of plans) {
    if (plan.lane === null) continue;
    const users = laneUsers.get(plan.lane) ?? [];
    if (!users.includes(plan.link.from)) users.push(plan.link.from);
    laneUsers.set(plan.lane, users);
  }
  const laneOffset = (plan: Plan) => {
    const users = laneUsers.get(plan.lane!)!;
    const index = users.indexOf(plan.link.from);
    return (index - (users.length - 1) / 2) * Math.min(TRACK, (COL_GAP - 24) / Math.max(1, users.length - 1));
  };

  // 4. Points.
  const routes = new Map<string, Route>();
  for (const plan of plans) {
    const s = port.get(`${plan.link.id}:from`)!;
    const e0 = port.get(`${plan.link.id}:to`)!;
    const e = plan.toSide === 'top' ? { x: e0.x, y: e0.y - ARRIVE }
      : plan.toSide === 'bottom' ? { x: e0.x, y: e0.y + ARRIVE }
        : plan.toSide === 'left' ? { x: e0.x - ARRIVE, y: e0.y }
          : { x: e0.x + ARRIVE, y: e0.y };
    let points: Point[];
    if (plan.kind === 'beside') {
      const mx = (s.x + e.x) / 2;
      points = [s, { x: mx, y: s.y }, { x: mx, y: s.y }, { x: mx, y: e.y }, { x: mx, y: e.y }, e];
    } else if (plan.kind === 'lane') {
      const lx = laneX(plan.lane!) + laneOffset(plan);
      const y1 = trackY(plan.runs[0]!.gap, plan.runs[0]!.slot);
      const y2 = trackY(plan.runs[1]!.gap, plan.runs[1]!.slot);
      points = [s, { x: s.x, y: y1 }, { x: lx, y: y1 }, { x: lx, y: y2 }, { x: e.x, y: y2 }, e];
    } else {
      const y = trackY(plan.runs[0]!.gap, plan.runs[0]!.slot);
      points = [s, { x: s.x, y }, { x: s.x, y }, { x: e.x, y }, { x: e.x, y }, e];
    }
    routes.set(plan.link.id, { points, d: roundedPath(points), label: labelAt(points) });
  }
  return routes;
}

/**
 * A link whose end is being dragged: no grid to follow, so the simplest
 * honest line — down, across at the halfway height, and in — in the same
 * six-point shape, so it hands back to the routed line without a jump.
 */
export function looseRoute(from: Pick<Placed, 'x' | 'y' | 'w' | 'h'>, to: Pick<Placed, 'x' | 'y' | 'w' | 'h'>): Route {
  const down = to.y >= from.y + from.h / 2;
  const s = { x: from.x + from.w / 2, y: down ? from.y + from.h : from.y };
  const e = { x: to.x + to.w / 2, y: down ? to.y - ARRIVE : to.y + to.h + ARRIVE };
  const my = (s.y + e.y) / 2;
  const points = [s, { x: s.x, y: my }, { x: s.x, y: my }, { x: e.x, y: my }, { x: e.x, y: my }, e];
  return { points, d: roundedPath(points), label: labelAt(points) };
}

/**
 * Six points as a path with softened corners. The command sequence never
 * varies — M, then L Q at each of the four inner points, then L — so the
 * browser can interpolate from any route to any other.
 */
export function roundedPath(points: readonly Point[]): string {
  const f = (value: number) => Math.round(value * 10) / 10;
  let d = `M ${f(points[0]!.x)} ${f(points[0]!.y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index - 1]!;
    const here = points[index]!;
    const next = points[index + 1]!;
    const inLength = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLength = Math.hypot(next.x - here.x, next.y - here.y);
    const radius = Math.min(CORNER, inLength / 2, outLength / 2);
    const a = inLength ? { x: here.x - ((here.x - prev.x) / inLength) * radius, y: here.y - ((here.y - prev.y) / inLength) * radius } : here;
    const b = outLength ? { x: here.x + ((next.x - here.x) / outLength) * radius, y: here.y + ((next.y - here.y) / outLength) * radius } : here;
    d += ` L ${f(a.x)} ${f(a.y)} Q ${f(here.x)} ${f(here.y)} ${f(b.x)} ${f(b.y)}`;
  }
  const last = points[points.length - 1]!;
  return `${d} L ${f(last.x)} ${f(last.y)}`;
}

function labelAt(points: readonly Point[]): Route['label'] {
  let best = { length: -1, index: 0 };
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index]!;
    const b = points[index + 1]!;
    // A horizontal run is where a label reads; prefer it at equal length.
    const length = Math.hypot(b.x - a.x, b.y - a.y) * (a.y === b.y ? 1.6 : 1);
    if (length > best.length) best = { length, index };
  }
  const a = points[best.index]!;
  const b = points[best.index + 1]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, along: a.y === b.y ? 'x' : 'y' };
}

export interface PlacedLabel { x: number; y: number; anchor: 'middle' | 'start' }

const LABEL_HEIGHT = 14;
/** Roughly how wide a label is at the canvas's label size. */
function labelWidth(text: string): number {
  return text.length * 6.1 + 6;
}

/**
 * Where each shown label goes: on the longest straight run of its line that
 * has room for it and is not already taken by another label or a card —
 * trying the next run along, and then either side of the middle, before
 * giving up and leaving the label off. A label nobody can read is noise.
 */
export function placeLabels(
  labels: readonly { id: string; text: string }[],
  routes: ReadonlyMap<string, Route>,
  cards: readonly Pick<Placed, 'x' | 'y' | 'w' | 'h'>[],
): Map<string, PlacedLabel> {
  type Box = { x: number; y: number; w: number; h: number };
  const taken: Box[] = cards.map((card) => ({ x: card.x - 2, y: card.y - 2, w: card.w + 4, h: card.h + 4 }));
  const overlaps = (box: Box, other: Box) => box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y;
  // Every other line's runs: a label sitting across another link's line reads as that link's.
  const lines = [...routes].flatMap(([id, route]) => route.points.slice(0, -1).map((a, index) => {
    const b = route.points[index + 1]!;
    return { id, box: { x: Math.min(a.x, b.x) - 1, y: Math.min(a.y, b.y) - 1, w: Math.abs(b.x - a.x) + 2, h: Math.abs(b.y - a.y) + 2 } };
  }));
  const clashes = (box: Box, own: string) =>
    taken.some((other) => overlaps(box, other)) || lines.some((line) => line.id !== own && overlaps(box, line.box));
  const placed = new Map<string, PlacedLabel>();
  for (const { id, text } of labels) {
    const route = routes.get(id);
    if (!route) continue;
    const width = labelWidth(text);
    const segments = route.points.slice(0, -1)
      .map((a, index) => ({ a, b: route.points[index + 1]! }))
      .map(({ a, b }) => ({ a, b, length: Math.hypot(b.x - a.x, b.y - a.y), flat: a.y === b.y }))
      .filter((segment) => segment.length > 0)
      .sort((p, q) => (q.flat ? q.length * 1.6 : q.length) - (p.flat ? p.length * 1.6 : p.length));
    let chosen: { box: { x: number; y: number; w: number; h: number }; label: PlacedLabel } | null = null;
    for (const { a, b, flat, length } of segments) {
      if ((flat && length < width + 8) || (!flat && length < LABEL_HEIGHT + 12)) continue;
      for (const t of [0.5, 0.3, 0.7]) {
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        const box = flat
          ? { x: x - width / 2, y: y - LABEL_HEIGHT - 3, w: width, h: LABEL_HEIGHT }
          : { x: x + 6, y: y - LABEL_HEIGHT / 2, w: width, h: LABEL_HEIGHT };
        if (clashes(box, id)) continue;
        chosen = { box, label: flat ? { x, y: y - 7, anchor: 'middle' } : { x: x + 8, y: y + 3.5, anchor: 'start' } };
        break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    taken.push(chosen.box);
    placed.set(id, chosen.label);
  }
  return placed;
}
