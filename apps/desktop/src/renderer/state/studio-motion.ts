import type { DesignDuty, DesignModel, DesignPart } from '@vowe/core';
import { diffModels, visibleEntries } from '@vowe/core/studio-model';

/**
 * What the canvas should make you feel when the design changes.
 *
 * Nothing on the canvas says "added" or "changed". Instead a new part
 * materializes, a new link draws itself in, a part whose words changed glows
 * once and lets go, a removed part fades from where it stood, and a
 * responsibility that moved flies from the part it left to the part that
 * took it. The motion is the diff; afterwards the design is simply the design.
 */
export interface CanvasChanges {
  /** New parts, in the order they should arrive. */
  entering: string[];
  /** Parts whose name, role or responsibilities changed. */
  touched: Set<string>;
  /** Links that are new, to draw in. */
  drawn: Set<string>;
  /** Parts that were removed, as they were. */
  leaving: DesignPart[];
  /** Responsibilities that changed hands. */
  moved: { duty: DesignDuty; from: string; to: string }[];
}

export const NO_CHANGES: CanvasChanges = { entering: [], touched: new Set(), drawn: new Set(), leaving: [], moved: [] };

export function canvasChanges(before: DesignModel | null, after: DesignModel): CanvasChanges {
  const diff = diffModels(before, after);
  if (!diff.entries.length) return NO_CHANGES;
  const entering: string[] = [];
  const touched = new Set<string>();
  const drawn = new Set<string>();
  const leaving: DesignPart[] = [];
  const moved: CanvasChanges['moved'] = [];
  for (const entry of visibleEntries(diff)) {
    if (entry.kind === 'part') {
      if (entry.change === 'added') entering.push(entry.id);
      else if (entry.change === 'changed') touched.add(entry.id);
      else {
        const part = before?.parts.find((candidate) => candidate.id === entry.id);
        if (part) leaving.push(part);
      }
    } else if (entry.kind === 'link') {
      if (entry.change === 'added') drawn.add(entry.id);
    } else {
      const duty = after.duties.find((candidate) => candidate.id === entry.id);
      const was = entry.was?.part;
      if (entry.change === 'changed' && duty && was && was !== duty.part) {
        moved.push({ duty, from: was, to: duty.part });
        touched.add(duty.part);
        touched.add(was);
      } else if (duty && entry.change !== 'removed') {
        touched.add(duty.part);
      } else if (entry.change === 'removed') {
        const gone = before?.duties.find((candidate) => candidate.id === entry.id);
        if (gone) touched.add(gone.part);
      }
    }
  }
  // An arriving part is felt by arriving; it does not also glow.
  for (const id of entering) touched.delete(id);
  // Links to a part that is arriving draw in with it.
  for (const link of after.links) {
    if (!link.retired && (entering.includes(link.from) || entering.includes(link.to))) drawn.add(link.id);
  }
  // Only invisible fields moved — a reason written down, a preview becoming
  // the committed revision: nothing to feel, and nothing to interrupt.
  if (!entering.length && !touched.size && !drawn.size && !leaving.length && !moved.length) return NO_CHANGES;
  return { entering: arrivalOrder(entering, after), touched, drawn, leaving, moved };
}

/**
 * Arrivals in the order the system reads: a part that feeds another arrives
 * before it, so a multi-part change assembles along its own flow.
 */
function arrivalOrder(ids: readonly string[], model: DesignModel): string[] {
  const set = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const link of model.links) {
    if (!link.retired && set.has(link.from) && set.has(link.to)) incoming.set(link.to, (incoming.get(link.to) ?? 0) + 1);
  }
  const order: string[] = [];
  const queue = ids.filter((id) => incoming.get(id) === 0);
  const seen = new Set<string>();
  while (order.length < ids.length) {
    const next = queue.shift() ?? ids.find((id) => !seen.has(id))!;
    if (seen.has(next)) continue;
    seen.add(next);
    order.push(next);
    for (const link of model.links) {
      if (link.retired || link.from !== next || !set.has(link.to)) continue;
      incoming.set(link.to, incoming.get(link.to)! - 1);
      if (incoming.get(link.to) === 0) queue.push(link.to);
    }
  }
  return order;
}
