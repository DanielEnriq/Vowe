import type { ContextRef, ConversationEntry, InvestigationReceipt } from '@vowe/core';

/**
 * Which of an answer's references belong on the desk.
 *
 * The desk is what Vowe and the developer are *looking at*. It is not a log of
 * what Vowe did — that is the live trail and the receipt, and it belongs in the
 * conversation. Conflating the two is what turns nine lookups into nine pieces
 * of clutter nobody asked to keep.
 *
 * So the rule is about descents, not activity. A `search` is Vowe casting
 * around: its refs are candidates, often many, and none of them is yet a thing
 * anyone chose to look at. An `open` or a `diff` is Vowe going and reading
 * something specific, and that is what earns a place.
 *
 * Nothing is learned and nothing is ranked. The order is the order the
 * investigation actually happened in.
 */
export interface SurfacePlan {
  /** Takes the workbench, unless the developer has pinned something. */
  show: ContextRef | null;
  /** Joins the desk without stealing the view. */
  suggest: ContextRef[];
}

export const NOTHING_TO_SURFACE: SurfacePlan = { show: null, suggest: [] };

/**
 * Kept deliberately small. An answer that quietly added six things to the desk
 * would be doing to the workbench what the trail already does properly.
 */
const MAX_SUGGESTED = 2;

/**
 * Refs worth a visual artifact.
 *
 * A file, a symbol, a diff and a remembered lesson all render as something a
 * person reads. A window or trace range renders as narrative evidence — real,
 * and reachable from the receipt, but not what the desk is for by default.
 */
const CONCRETE = new Set<ContextRef['kind']>(['repo', 'symbol', 'diff', 'lesson']);

export function planSurfacing(entry: ConversationEntry): SurfacePlan {
  const receipt = entry.investigation;
  if (!receipt) return NOTHING_TO_SURFACE;

  // Descents only: what Vowe chose to read, in the order it read it.
  const descended = dedupe(refsOf(receipt, (kind) => kind === 'open' || kind === 'diff'));
  const concrete = descended.filter((ref) => CONCRETE.has(ref.kind));
  if (!concrete.length) return NOTHING_TO_SURFACE;

  const [show, ...rest] = concrete;
  return { show: show ?? null, suggest: rest.slice(0, MAX_SUGGESTED) };
}

function refsOf(
  receipt: InvestigationReceipt,
  accept: (kind: InvestigationReceipt['checks'][number]['kind']) => boolean,
): ContextRef[] {
  return receipt.checks
    .filter((check) => accept(check.kind))
    .flatMap((check) => check.refs);
}

/**
 * Compared by address, because that is what identity means for a ref — and
 * because an artifact's id on the desk is its formatted ref, two refs that
 * print the same are the same thing on the desk.
 */
function dedupe(refs: ContextRef[]): ContextRef[] {
  const seen = new Set<string>();
  const kept: ContextRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(ref);
  }
  return kept;
}
