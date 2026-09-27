/**
 * Where each part of a design sits: view state, never design.
 *
 * Positions are grid slots, not pixels — rows run in the direction links flow,
 * columns across — so a composition stays calm and the renderer is free to
 * size cards to their words. Vowe owns the layout, and the one rule that
 * matters is stability: a turn places what is new beside its relatives and
 * never moves what is already there. Only `tidy`, asked for, re-lays out, and
 * even that leaves what the developer pinned alone.
 *
 * Boundaries are the one exception, and they only ever correct themselves. A
 * group is drawn around its members, so its members sit together and nothing
 * else sits among them: a part that joins a group moves in beside the others,
 * a part that leaves one steps outside its line. A layout with nothing to
 * correct is returned as it was. A group's own slot is only where it waits
 * while it is empty.
 *
 * A position is not a design decision. Nothing here is a move, reaches the
 * agent, or enters history. A slot outlives its part, so a part removed from
 * the design can still be drawn as a ghost exactly where it was.
 *
 * Imports only types, so the renderer can share it.
 */

import type { DesignModel } from './model.js';

export interface DesignSlot {
  row: number;
  col: number;
  /** The developer put it here; tidy leaves it alone. */
  pinned?: true;
}

export type DesignLayout = Record<string, DesignSlot>;

/** A group's extent in grid cells, inclusive. */
export interface GroupBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * The boundaries of a model: each live group and its live members, in model
 * order. A member of a group that is gone or is not a group is simply outside.
 */
export function groupMembers(model: DesignModel): Map<string, string[]> {
  const parts = model.parts.filter((part) => !part.retired);
  const groups = new Map<string, string[]>();
  for (const part of parts) if (part.kind === 'group') groups.set(part.id, []);
  for (const part of parts) {
    if (part.kind !== 'group' && part.within && groups.has(part.within)) groups.get(part.within)!.push(part.id);
  }
  return groups;
}

/** Each populated group's box in the grid: the cells its placed members span. */
export function groupBoxes(layout: DesignLayout, model: DesignModel): Map<string, GroupBox> {
  return boxesOf(layout, groupMembers(model));
}

/** Give every live part without a slot one, leaving every existing slot where it is. */
export function placeParts(layout: DesignLayout, model: DesignModel): DesignLayout {
  const { next, ghosts } = split(layout, model);
  const parts = model.parts.filter((part) => !part.retired);
  const groups = groupMembers(model);
  const owner = ownerOf(groups);
  // A link to a group reaches what is inside it: Web → Backend puts Web above Backend's parts.
  const links = throughGroups(model, groups);
  const fresh = new Set(parts.filter((part) => !next[part.id]).map((part) => part.id));

  for (const id of flowOrder(parts.map((part) => part.id), links).filter((candidate) => fresh.has(candidate))) {
    // A populated group is drawn around its members; it needs no place of its own yet.
    if (groups.get(id)?.length) continue;
    const sources = links.filter((link) => link.to === id && next[link.from]).map((link) => next[link.from]!);
    const sinks = links.filter((link) => link.from === id && next[link.to]).map((link) => next[link.to]!);
    const occupied = [...taken(next, groups).keys()].map((key) => Number(key.split(':')[0]));
    let row: number;
    // Beneath the nearest thing that feeds it: a store two services write to
    // sits beside the first, not at the bottom of the longest chain.
    if (sources.length) row = Math.min(...sources.map((slot) => slot.row)) + 1;
    else if (sinks.length) row = Math.min(...sinks.map((slot) => slot.row)) - 1;
    else row = occupied.length ? Math.min(...occupied) : 0;
    const neighbours = [...sources, ...sinks];
    const col = neighbours.length ? Math.round(neighbours.reduce((sum, slot) => sum + slot.col, 0) / neighbours.length) : 0;

    const group = owner.get(id);
    next[id] = group ? memberSlot(next, groups, group, id, { row, col }) : outsideSlot(next, groups, id, { row, col });
  }
  return { ...ghosts, ...settleGroups(next, model) };
}

/**
 * Lay everything out again, except what was pinned: each part a row beneath
 * the nearest part that feeds it, each row ordered by where its sources sit,
 * centred. Each
 * group takes a band of columns of its own, and what is outside it in the
 * rows it spans sits to either side.
 */
export function tidyLayout(layout: DesignLayout, model: DesignModel): DesignLayout {
  const groups = groupMembers(model);
  const populated = new Set([...groups].filter(([, members]) => members.length).map(([id]) => id));
  const parts = model.parts.filter((part) => !part.retired && !populated.has(part.id)).map((part) => part.id);
  const links = throughGroups(model, groups);
  const { next, ghosts } = split(layout, model);
  const pinned = new Set(parts.filter((id) => layout[id]?.pinned));

  const order = flowOrder(parts, links);
  const rank = new Map<string, number>();
  for (const id of order) {
    if (pinned.has(id)) {
      rank.set(id, layout[id]!.row);
      continue;
    }
    const above = links.filter((link) => link.to === id && rank.has(link.from)).map((link) => rank.get(link.from)!);
    rank.set(id, above.length ? Math.min(...above) + 1 : 0);
  }

  const rows = new Map<number, string[]>();
  for (const id of order) {
    if (pinned.has(id)) continue;
    const row = rank.get(id)!;
    rows.set(row, [...(rows.get(row) ?? []), id]);
  }
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const ids = rows.get(row)!;
    const centre = (id: string): number => {
      const above = links.filter((link) => link.to === id && next[link.from] && (pinned.has(link.from) || rank.get(link.from)! < row));
      return above.length ? above.reduce((sum, link) => sum + next[link.from]!.col, 0) / above.length : 0;
    };
    ids.sort((a, b) => centre(a) - centre(b));
    const occupied = new Set([...pinned].filter((id) => next[id]!.row === row).map((id) => next[id]!.col));
    ids.forEach((id, index) => {
      const target = Math.round(index - (ids.length - 1) / 2);
      const col = nearestCol(target, (candidate) => !occupied.has(candidate));
      next[id] = { row, col };
      occupied.add(col);
    });
  }
  if (populated.size) bands(next, groups, pinned);
  return { ...ghosts, ...settleGroups(next, model) };
}

/**
 * Keep every boundary whole: a group's members together, nothing else among
 * them, and no two groups over each other. Only what breaks one of those
 * moves, by as little as it can; a layout that breaks none comes back as it
 * was.
 */
export function settleGroups(layout: DesignLayout, model: DesignModel): DesignLayout {
  const groups = groupMembers(model);
  const owner = ownerOf(groups);
  const { next, ghosts } = split(layout, model);
  const outsiders = model.parts.filter((part) => !part.retired && part.kind !== 'group' && !owner.has(part.id)).map((part) => part.id);

  for (let pass = 0; pass < 8; pass += 1) {
    let moved = false;

    // Two boundaries over each other: the later one steps aside, whole.
    const ids = [...groups.keys()];
    for (let later = 1; later < ids.length; later += 1) {
      for (let earlier = 0; earlier < later; earlier += 1) {
        const boxes = boxesOf(next, groups);
        const a = boxes.get(ids[earlier]!);
        const b = boxes.get(ids[later]!);
        if (!a || !b || !overlaps(a, b)) continue;
        const shift = a.right - b.left + 1;
        for (const member of groups.get(ids[later]!)!) {
          const slot = next[member];
          if (slot) next[member] = { ...slot, col: slot.col + shift };
        }
        moved = true;
      }
    }

    // A member away from the rest of its group joins them.
    for (const [group, members] of groups) {
      const placed = members.filter((id) => next[id]);
      if (placed.length < 2) continue;
      const core = mainCluster(placed, next);
      for (const member of placed) {
        if (core.has(member)) continue;
        next[member] = { ...joinSlot(next, groups, group, member, core), ...(next[member]!.pinned ? { pinned: true as const } : {}) };
        core.add(member);
        moved = true;
      }
    }

    // Anything else inside a boundary steps out of it, along its row.
    const boxes = boxesOf(next, groups);
    const empty = [...groups].filter(([, members]) => !members.some((id) => next[id])).map(([id]) => id);
    for (const id of [...outsiders, ...empty]) {
      const slot = next[id];
      if (!slot || ![...boxes.values()].some((box) => inside(box, slot))) continue;
      next[id] = { ...outsideSlot(next, groups, id, slot), ...(slot.pinned ? { pinned: true as const } : {}) };
      moved = true;
    }

    // An empty group's place taken by something else: it waits beside it.
    const held = new Map<string, string>();
    for (const id of outsiders) if (next[id]) held.set(key(next[id]!), id);
    for (const id of empty) {
      const slot = next[id];
      if (!slot || !held.has(key(slot))) continue;
      next[id] = outsideSlot(next, groups, id, slot);
      moved = true;
    }
    if (!moved) break;
  }

  // A populated group waits where its box begins, so if it empties it is still there.
  for (const [group, box] of boxesOf(next, groups)) {
    const slot = next[group];
    if (!slot || slot.row !== box.top || slot.col !== box.left) next[group] = { row: box.top, col: box.left };
  }
  return { ...ghosts, ...next };
}

// -------------------------------------------------------------- internals

/** The slots of live parts, to arrange, and the slots removed parts keep, to leave alone. */
function split(layout: DesignLayout, model: DesignModel): { next: DesignLayout; ghosts: DesignLayout } {
  const alive = new Set(model.parts.filter((part) => !part.retired).map((part) => part.id));
  const next: DesignLayout = {};
  const ghosts: DesignLayout = {};
  for (const [id, slot] of Object.entries(layout)) (alive.has(id) ? next : ghosts)[id] = slot;
  return { next, ghosts };
}

function ownerOf(groups: Map<string, string[]>): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [group, members] of groups) for (const member of members) owner.set(member, group);
  return owner;
}

function key(slot: { row: number; col: number }): string {
  return `${slot.row}:${slot.col}`;
}

function boxesOf(layout: DesignLayout, groups: Map<string, string[]>): Map<string, GroupBox> {
  const boxes = new Map<string, GroupBox>();
  for (const [group, members] of groups) {
    const slots = members.flatMap((id) => (layout[id] ? [layout[id]!] : []));
    if (!slots.length) continue;
    boxes.set(group, {
      top: Math.min(...slots.map((slot) => slot.row)),
      bottom: Math.max(...slots.map((slot) => slot.row)),
      left: Math.min(...slots.map((slot) => slot.col)),
      right: Math.max(...slots.map((slot) => slot.col)),
    });
  }
  return boxes;
}

function inside(box: GroupBox, slot: { row: number; col: number }): boolean {
  return slot.row >= box.top && slot.row <= box.bottom && slot.col >= box.left && slot.col <= box.right;
}

function overlaps(a: GroupBox, b: GroupBox): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

function grow(box: GroupBox | undefined, slot: { row: number; col: number }): GroupBox {
  if (!box) return { top: slot.row, bottom: slot.row, left: slot.col, right: slot.col };
  return { top: Math.min(box.top, slot.row), bottom: Math.max(box.bottom, slot.row), left: Math.min(box.left, slot.col), right: Math.max(box.right, slot.col) };
}

/** The cells something stands in: every placed part, and every empty group where it waits. */
function taken(layout: DesignLayout, groups: Map<string, string[]>): Map<string, string> {
  const cells = new Map<string, string>();
  for (const [id, slot] of Object.entries(layout)) {
    // A group with members is drawn around them and holds no cell of its own.
    if (groups.get(id)?.length) continue;
    cells.set(key(slot), id);
  }
  return cells;
}

/** Whether a cell is free for `id`: nobody else there, and no other group's boundary around it. */
function freeFor(layout: DesignLayout, groups: Map<string, string[]>, id: string, cell: { row: number; col: number }, own?: string): boolean {
  const holder = taken(layout, groups).get(key(cell));
  if (holder !== undefined && holder !== id) return false;
  for (const [group, box] of boxesOf(layout, groups)) if (group !== own && inside(box, cell)) return false;
  return true;
}

/**
 * Whether `member` at `cell` keeps its group whole: the grown box holds no
 * outsider and meets no other group.
 */
function keepsWhole(layout: DesignLayout, groups: Map<string, string[]>, group: string, member: string, cell: { row: number; col: number }): boolean {
  const others = groups.get(group)!.filter((id) => id !== member);
  const box = grow(boxesOf(layout, new Map([[group, others]])).get(group), cell);
  for (const [other, otherBox] of boxesOf(layout, groups)) if (other !== group && overlaps(box, otherBox)) return false;
  const mine = new Set(groups.get(group));
  for (const [at, holder] of taken(layout, groups)) {
    if (mine.has(holder) || holder === group) continue;
    const [row, col] = at.split(':').map(Number) as [number, number];
    if (inside(box, { row, col })) return false;
  }
  return true;
}

/** The nearest free column in a row outside every boundary. */
function outsideSlot(layout: DesignLayout, groups: Map<string, string[]>, id: string, target: { row: number; col: number }): DesignSlot {
  return { row: target.row, col: nearestCol(target.col, (col) => freeFor(layout, groups, id, { row: target.row, col })) };
}

/**
 * Where a new member goes: beside the members already placed, as near its
 * flow position as keeps the group whole — or, as the first member, where the
 * empty group was waiting.
 */
function memberSlot(layout: DesignLayout, groups: Map<string, string[]>, group: string, id: string, target: { row: number; col: number }): DesignSlot {
  const placed = groups.get(group)!.filter((member) => member !== id && layout[member]);
  if (!placed.length) {
    const anchor = layout[group];
    return outsideSlot(layout, groups, id, anchor ?? target);
  }
  return joinSlot(layout, groups, group, id, new Set(placed), target);
}

/** The best free cell touching `core` for `member`, nearest to where it was headed. */
function joinSlot(
  layout: DesignLayout,
  groups: Map<string, string[]>,
  group: string,
  member: string,
  core: Set<string>,
  toward: { row: number; col: number } = layout[member]!,
): DesignSlot {
  const candidates = new Map<string, { row: number; col: number }>();
  for (const id of core) {
    const slot = layout[id]!;
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const cell = { row: slot.row + dr, col: slot.col + dc };
        if (freeFor(layout, groups, member, cell, group)) candidates.set(key(cell), cell);
      }
    }
  }
  const ranked = [...candidates.values()].sort((a, b) =>
    Math.abs(a.row - toward.row) * 3 + Math.abs(a.col - toward.col) - (Math.abs(b.row - toward.row) * 3 + Math.abs(b.col - toward.col))
    || a.row - b.row || a.col - b.col);
  const whole = ranked.find((cell) => keepsWhole(layout, groups, group, member, cell));
  // Somewhere touching the group always exists; if nothing keeps it whole,
  // whatever it now surrounds steps out on the next pass.
  return { ...(whole ?? ranked[0] ?? { row: toward.row, col: nearestCol(toward.col, () => true) }) };
}

/** The largest set of members touching one another; ties go to the one listed first. */
function mainCluster(members: string[], layout: DesignLayout): Set<string> {
  const seen = new Set<string>();
  let best = new Set<string>();
  for (const start of members) {
    if (seen.has(start)) continue;
    const cluster = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const here = layout[queue.shift()!]!;
      for (const other of members) {
        if (cluster.has(other)) continue;
        const there = layout[other]!;
        if (Math.abs(there.row - here.row) <= 1 && Math.abs(there.col - here.col) <= 1) {
          cluster.add(other);
          queue.push(other);
        }
      }
    }
    cluster.forEach((id) => seen.add(id));
    if (cluster.size > best.size) best = cluster;
  }
  return best;
}

/**
 * Links as layout reads them: a link to a populated group reaches each of its
 * members, and a link between a group and its own member is no link at all.
 */
function throughGroups(model: DesignModel, groups: Map<string, string[]>): { from: string; to: string }[] {
  const ends = (id: string): string[] => (groups.get(id)?.length ? groups.get(id)! : [id]);
  const owner = ownerOf(groups);
  const links: { from: string; to: string }[] = [];
  for (const link of model.links) {
    if (link.retired || owner.get(link.from) === link.to || owner.get(link.to) === link.from) continue;
    for (const from of ends(link.from)) for (const to of ends(link.to)) if (from !== to) links.push({ from, to });
  }
  return links;
}

/**
 * After a tidy: each populated group gets a band of columns as wide as its
 * busiest row, bands side by side in the order their members sat, and
 * whatever else is in the rows a band spans moves to the side it was on.
 */
function bands(layout: DesignLayout, groups: Map<string, string[]>, pinned: Set<string>): void {
  const owner = ownerOf(groups);
  const loose = (id: string) => layout[id] && !pinned.has(id);
  const order = [...groups]
    .map(([group, members]) => ({ group, members: members.filter(loose) }))
    .filter(({ members }) => members.length)
    .map((entry) => ({ ...entry, centre: entry.members.reduce((sum, id) => sum + layout[id]!.col, 0) / entry.members.length }))
    .sort((a, b) => a.centre - b.centre);
  const width = (members: string[]) => {
    const perRow = new Map<number, number>();
    for (const id of members) perRow.set(layout[id]!.row, (perRow.get(layout[id]!.row) ?? 0) + 1);
    return Math.max(...perRow.values());
  };
  const total = order.reduce((sum, entry) => sum + width(entry.members), 0);
  let start = -Math.floor((total - 1) / 2);
  const spans: { left: number; right: number; top: number; bottom: number; centre: number }[] = [];
  for (const { members } of order) {
    const w = width(members);
    const rows = new Map<number, string[]>();
    for (const id of [...members].sort((a, b) => layout[a]!.col - layout[b]!.col)) {
      rows.set(layout[id]!.row, [...(rows.get(layout[id]!.row) ?? []), id]);
    }
    for (const [row, ids] of rows) {
      const offset = Math.floor((w - ids.length) / 2);
      ids.forEach((id, index) => { layout[id] = { row, col: start + offset + index }; });
    }
    const top = Math.min(...members.map((id) => layout[id]!.row));
    const bottom = Math.max(...members.map((id) => layout[id]!.row));
    spans.push({ left: start, right: start + w - 1, top, bottom, centre: start + (w - 1) / 2 });
    start += w;
  }

  // What is outside every group, row by row, in the order it sat.
  const rows = new Map<number, string[]>();
  for (const [id, slot] of Object.entries(layout)) {
    if (owner.has(id) || groups.get(id)?.length || !loose(id)) continue;
    rows.set(slot.row, [...(rows.get(slot.row) ?? []), id]);
  }
  for (const [row, ids] of rows) {
    const blocked = spans.filter((span) => row >= span.top && row <= span.bottom);
    if (!blocked.length) continue;
    const used = new Set(Object.entries(layout).filter(([id, slot]) => slot.row === row && (pinned.has(id) || owner.has(id))).map(([, slot]) => slot.col));
    ids.sort((a, b) => layout[a]!.col - layout[b]!.col);
    for (const id of ids) {
      const wanted = layout[id]!.col;
      const inBand = blocked.find((span) => wanted >= span.left && wanted <= span.right);
      const target = inBand ? (wanted < inBand.centre ? inBand.left - 1 : inBand.right + 1) : wanted;
      const col = nearestCol(target, (candidate) => !used.has(candidate) && !blocked.some((span) => candidate >= span.left && candidate <= span.right));
      layout[id] = { row, col };
      used.add(col);
    }
  }
}

/** Sources before what they feed; a cycle is broken where the model lists it. */
function flowOrder(ids: string[], links: readonly { from: string; to: string }[]): string[] {
  const present = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const link of links) if (present.has(link.from) && present.has(link.to)) incoming.set(link.to, incoming.get(link.to)! + 1);
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < ids.length) {
    const ready = ids.find((id) => !done.has(id) && incoming.get(id) === 0) ?? ids.find((id) => !done.has(id))!;
    done.add(ready);
    order.push(ready);
    for (const link of links) if (link.from === ready && present.has(link.to) && !done.has(link.to)) incoming.set(link.to, incoming.get(link.to)! - 1);
  }
  return order;
}

function nearestCol(target: number, free: (col: number) => boolean): number {
  for (let distance = 0; ; distance += 1) {
    if (free(target + distance)) return target + distance;
    if (free(target - distance)) return target - distance;
  }
}
