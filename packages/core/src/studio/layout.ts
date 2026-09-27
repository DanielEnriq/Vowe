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

/** Give every live part without a slot one, leaving every existing slot where it is. */
export function placeParts(layout: DesignLayout, model: DesignModel): DesignLayout {
  const next: DesignLayout = { ...layout };
  const parts = model.parts.filter((part) => !part.retired);
  const links = model.links.filter((link) => !link.retired);
  const fresh = new Set(parts.filter((part) => !next[part.id]).map((part) => part.id));
  if (!fresh.size) return next;

  for (const id of flowOrder(parts.map((part) => part.id), links).filter((candidate) => fresh.has(candidate))) {
    const sources = links.filter((link) => link.to === id && next[link.from]).map((link) => next[link.from]!);
    const sinks = links.filter((link) => link.from === id && next[link.to]).map((link) => next[link.to]!);
    const occupied = occupiedSlots(next, model);
    let row: number;
    if (sources.length) row = Math.max(...sources.map((slot) => slot.row)) + 1;
    else if (sinks.length) row = Math.min(...sinks.map((slot) => slot.row)) - 1;
    else row = occupied.size ? Math.min(...[...occupied.values()].map((slot) => slot.row)) : 0;
    const neighbours = [...sources, ...sinks];
    const target = neighbours.length
      ? Math.round(neighbours.reduce((sum, slot) => sum + slot.col, 0) / neighbours.length)
      : 0;
    next[id] = { row, col: nearestFree(occupied, row, target) };
  }
  return next;
}

/**
 * Lay everything out again, except what was pinned: rows by the longest path
 * links flow along, each row ordered by where its sources sit, centred.
 */
export function tidyLayout(layout: DesignLayout, model: DesignModel): DesignLayout {
  const parts = model.parts.filter((part) => !part.retired).map((part) => part.id);
  const links = model.links.filter((link) => !link.retired);
  const next: DesignLayout = { ...layout };
  const pinned = new Set(parts.filter((id) => layout[id]?.pinned));

  const order = flowOrder(parts, links);
  const rank = new Map<string, number>();
  for (const id of order) {
    if (pinned.has(id)) {
      rank.set(id, layout[id]!.row);
      continue;
    }
    const above = links.filter((link) => link.to === id && rank.has(link.from)).map((link) => rank.get(link.from)!);
    rank.set(id, above.length ? Math.max(...above) + 1 : 0);
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
    const occupied = new Map([...pinned].filter((id) => next[id]!.row === row).map((id) => [`${row}:${next[id]!.col}`, next[id]!]));
    ids.forEach((id, index) => {
      const target = Math.round(index - (ids.length - 1) / 2);
      const col = nearestFree(occupied, row, target);
      next[id] = { row, col };
      occupied.set(`${row}:${col}`, next[id]!);
    });
  }
  return next;
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

function occupiedSlots(layout: DesignLayout, model: DesignModel): Map<string, DesignSlot> {
  const occupied = new Map<string, DesignSlot>();
  for (const part of model.parts) {
    const slot = layout[part.id];
    if (!part.retired && slot) occupied.set(`${slot.row}:${slot.col}`, slot);
  }
  return occupied;
}

function nearestFree(occupied: Map<string, DesignSlot>, row: number, target: number): number {
  for (let distance = 0; ; distance += 1) {
    if (!occupied.has(`${row}:${target + distance}`)) return target + distance;
    if (!occupied.has(`${row}:${target - distance}`)) return target - distance;
  }
}
