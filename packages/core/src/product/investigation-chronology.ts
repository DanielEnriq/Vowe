import type {
  InvestigationCheck,
  InvestigationReceipt,
} from '../types/conversation.js';
import type { VoweTraceItem } from '../types/execution.js';

/**
 * A finished investigation, read back in the order it happened.
 *
 * The live column already shows look, think, look, think while the work is in
 * flight. The moment the answer settled, all of that used to disappear: the
 * receipt kept the lookups and nothing kept the thinking, so a developer who
 * reopened the session saw a one-line receipt where a chronology had been.
 *
 * Nothing new is stored to fix that. Both halves were already durable in two
 * lanes that were simply never read together:
 *
 *  - the **receipt** on the answer holds the lookups, with the labels that were
 *    written at the time they happened;
 *  - the **trace** of the `VoweRun` that produced the answer holds the
 *    reasoning the provider exposed, in execution order, each row with the
 *    time it was recorded.
 *
 * So this is a join and not a store. `VoweRun.outputEntryId` is what makes it
 * one — the link Slice 4 built for exactly this question — and the trace's own
 * `ord` is the order. A second reasoning database would be a second history to
 * keep in step with the first, which is the thing this deliberately is not.
 */
export type InvestigationStep =
  | { kind: 'check'; id: string; check: InvestigationCheck }
  | {
      kind: 'thought';
      id: string;
      /** What the provider exposed. Empty where it exposed nothing readable. */
      text: string;
      /**
       * How long this span took, from the two nearest real timestamps.
       *
       * `0` where there is genuinely nothing to measure from — the first item
       * in a run has no predecessor — and the renderer says `Thought` rather
       * than `Thought for 0.0s`, because a duration nobody measured is not a
       * duration.
       */
      durationMs: number;
    };

/** Trace rows that carry exposed working, whatever the provider called it. */
function isReasoning(item: VoweTraceItem): boolean {
  return item.kind === 'reasoning' || item.kind === 'reasoning_summary';
}

/**
 * Rebuild the chronology of one settled answer.
 *
 * The two lanes are aligned by counting rather than by matching text, because
 * text is the one thing that cannot be relied on to match: the labels are
 * human prose written by the recorder, and the trace holds the tool's own
 * arguments. What both lanes agree on is *how many* lookups there were and in
 * *what order*, so each `tool_call` consumes the next check in the receipt.
 *
 * Checks recorded before the run began — the references a developer attached,
 * which are opened first of all — have no `tool_call` behind them. They are
 * exactly the leading surplus, so they lead.
 *
 * With no trace at all this degrades to the receipt: an answer written before
 * runs were recorded still reads as the sequence of lookups it was, with no
 * thinking, which is the truth about it.
 */
export function investigationChronology(input: {
  receipt?: InvestigationReceipt | undefined;
  trace?: readonly VoweTraceItem[] | undefined;
}): InvestigationStep[] {
  const checks = input.receipt?.checks ?? [];
  const trace = [...(input.trace ?? [])].sort((a, b) => a.ord - b.ord);

  const calls = trace.filter((item) => item.kind === 'tool_call').length;
  // Whatever the trace cannot account for happened before the run opened.
  const preamble = Math.max(0, checks.length - calls);

  const steps: InvestigationStep[] = [];
  let next = 0;

  const takeCheck = (): void => {
    const check = checks[next];
    if (!check) return;
    steps.push({ kind: 'check', id: `check-${next}`, check });
    next += 1;
  };

  for (let index = 0; index < preamble; index += 1) takeCheck();

  let previousAt: number | null = null;
  for (const item of trace) {
    const at = Date.parse(item.at);
    const stamped = Number.isFinite(at) ? at : null;

    if (isReasoning(item)) {
      const text = item.text?.trim() ?? '';
      // A redacted block carries nothing readable. The honest record is that
      // reasoning happened, so the row stays and the body is empty.
      steps.push({
        kind: 'thought',
        id: `thought-${item.id}`,
        text,
        durationMs:
          stamped !== null && previousAt !== null
            ? Math.max(0, stamped - previousAt)
            : 0,
      });
    } else if (item.kind === 'tool_call') {
      takeCheck();
    }

    if (stamped !== null) previousAt = stamped;
  }

  // A retried, identical lookup collapses in the receipt but not in the trace,
  // so there can be more calls than checks — never the reverse. Anything still
  // unconsumed is a lookup that happened and belongs at the end.
  while (next < checks.length) takeCheck();

  return steps;
}
