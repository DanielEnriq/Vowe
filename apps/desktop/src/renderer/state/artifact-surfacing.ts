import type { ContextRef, ConversationEntry, InvestigationReceipt } from '@vowe/core';

/**
 * Which of an answer's references belong on the desk.
 *
 * No ranking model, and nothing learned: an investigation already recorded
 * what it opened, in the order it opened it, and that order is a better guide
 * to what the answer is about than anything that could be inferred afterwards.
 *
 * The rule is deliberately modest. The first thing Vowe *opened* takes the
 * view, because that is the artifact the answer is most likely to be built on;
 * everything else it touched joins the stack quietly. An answer that opened
 * nothing surfaces nothing rather than guessing from its prose.
 */
export interface SurfacePlan {
  /** Takes the workbench, unless the developer has pinned something. */
  show: ContextRef | null;
  /** Joins the desk without stealing the view. */
  suggest: ContextRef[];
}

export const NOTHING_TO_SURFACE: SurfacePlan = { show: null, suggest: [] };

/** How many an answer may put on the desk at once. */
const MAX_SUGGESTED = 4;

export function planSurfacing(entry: ConversationEntry): SurfacePlan {
  const receipt = entry.investigation;
  if (!receipt) return NOTHING_TO_SURFACE;

  const opened = refsOfKind(receipt, 'open');
  const rest = [...refsOfKind(receipt, 'diff'), ...refsOfKind(receipt, 'search')];

  const show = opened[0] ?? rest[0] ?? null;
  const suggest = dedupe([...opened.slice(1), ...rest], show).slice(0, MAX_SUGGESTED);

  return { show, suggest };
}

function refsOfKind(
  receipt: InvestigationReceipt,
  kind: InvestigationReceipt['checks'][number]['kind'],
): ContextRef[] {
  return receipt.checks.filter((check) => check.kind === kind).flatMap((check) => check.refs);
}

/**
 * Compared by address, because that is what identity means for a ref — and
 * because the artifact id on the desk is the formatted ref, two refs that
 * print the same are the same thing on the desk.
 */
function dedupe(refs: ContextRef[], exclude: ContextRef | null): ContextRef[] {
  const seen = new Set<string>();
  if (exclude) seen.add(JSON.stringify(exclude));

  const kept: ContextRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(ref);
  }
  return kept;
}
