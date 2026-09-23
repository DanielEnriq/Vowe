import type { ContextRef, ConversationEntry, InvestigationReceipt } from '@vowe/core';

/**
 * Which of an answer's references belongs on the desk.
 *
 * One, or none. The desk is what Vowe and the developer are *looking at*. It is
 * not a log of what Vowe did — that is the live trail and the receipt, and it
 * belongs in the conversation. Conflating the two is what turns nine lookups
 * into nine pieces of clutter nobody asked to keep.
 *
 * So the rule is about descents, not activity. A `search` is Vowe casting
 * around: its refs are candidates, often many, and none of them is yet a thing
 * anyone chose to look at. An `open` or a `diff` is Vowe going and reading
 * something specific, and the first of those is what earns the preview tab.
 *
 * Everything else an answer touched stays one click away in the trace, and
 * becomes a tab of its own only when the developer goes and opens it.
 *
 * Nothing is learned and nothing is ranked. The order is the order the
 * investigation actually happened in.
 */
export function planSurfacing(entry: ConversationEntry): ContextRef | null {
  const receipt = entry.investigation;
  if (!receipt) return null;

  // Descents only: what Vowe chose to read, in the order it read it.
  const descended = refsOf(receipt, (kind) => kind === 'open' || kind === 'diff');
  return descended.find((ref) => CONCRETE.has(ref.kind)) ?? null;
}

/**
 * Refs worth a visual artifact.
 *
 * A file, a symbol, a diff and a remembered lesson all render as something a
 * person reads. A window or trace range renders as narrative evidence — real,
 * and reachable from the receipt, but not what the desk is for by default.
 */
const CONCRETE = new Set<ContextRef['kind']>(['repo', 'symbol', 'diff', 'lesson']);

function refsOf(
  receipt: InvestigationReceipt,
  accept: (kind: InvestigationReceipt['checks'][number]['kind']) => boolean,
): ContextRef[] {
  return receipt.checks
    .filter((check) => accept(check.kind))
    .flatMap((check) => check.refs);
}
