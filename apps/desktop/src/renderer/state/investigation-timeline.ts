import type { InvestigationCheck, InvestigationReceipt, InvestigationStep } from '@vowe/core';

import type { LiveInvestigation, LiveStep } from './live-investigation.js';

/**
 * One row of an investigation column, in either tense.
 *
 * The live stream and the durable trace describe the same events, so they are
 * rendered by one component — and one component needs one shape. This is it,
 * with the two mappers that produce it: `liveRows` from the stream arriving
 * now, `settledRows` from what was kept.
 *
 * Pure, and in `state` rather than beside the component, so both mappings can
 * be stated as tests rather than as a rendered tree.
 */
export type TimelineRow =
  | { kind: 'check'; id: string; check: InvestigationCheck }
  | {
      kind: 'thought';
      id: string;
      /** What the provider exposed. Empty where it exposed nothing readable. */
      text: string;
      /** What it took, once it closed. Ignored while the span is still open. */
      durationMs: number;
      /**
       * This is the span currently open, and its label counts up from
       * `startedAt` — the moment its first reasoning actually arrived.
       */
      live: boolean;
      startedAt: number;
    };

/**
 * The investigation happening now.
 *
 * A thought's duration is the span's own lifecycle and nothing else: it opens
 * at the first reasoning delta and closes when the next thing happens — a
 * lookup, the answer, or the work finishing. `endedAt === null` is the open
 * one, and only that one carries `live`, because only one span can be in
 * progress at a time.
 */
export function liveRows(state: LiveInvestigation): TimelineRow[] {
  return state.steps.map((step) => rowOf(step, state.active));
}

function rowOf(step: LiveStep, active: boolean): TimelineRow {
  if (step.kind === 'check') {
    return { kind: 'check', id: step.id, check: step.check };
  }
  const endedAt = step.endedAt;
  return {
    kind: 'thought',
    id: step.id,
    text: step.text,
    durationMs: endedAt === null ? 0 : Math.max(0, endedAt - step.at),
    live: endedAt === null && active,
    startedAt: step.at,
  };
}

/**
 * The investigation that already happened.
 *
 * Nothing is live here by construction: every span has closed, and its
 * duration came back from the two nearest real timestamps in the trace. A
 * `startedAt` of `0` is never read, because `live` is never true.
 */
export function settledRows(steps: readonly InvestigationStep[]): TimelineRow[] {
  return steps.map((step) =>
    step.kind === 'check'
      ? { kind: 'check', id: step.id, check: step.check }
      : {
          kind: 'thought',
          id: step.id,
          text: step.text,
          durationMs: step.durationMs,
          live: false,
          startedAt: 0,
        },
  );
}

/**
 * The one line a settled receipt shows.
 *
 * `Checked 14 things · 38s` for Vowe's own lookups. A turn that only checked
 * the repository says so — `Checked the repository · 41s` — rather than
 * counting it as a thing, because to the developer it was one act of going to
 * look, however many files the harness read on the way.
 */
export function receiptSummary(receipt: InvestigationReceipt): string {
  const count = receipt.checks.length;
  const time = seconds(receipt.durationMs);
  const consults = receipt.checks.filter((check) => check.kind === 'consult');
  if (count > 0 && consults.length === count) {
    const answered = consults.some((check) => check.finding);
    return `${answered ? 'Checked the repository' : 'Could not check the repository'}${count > 1 ? ` · ${count} questions` : ''} · ${time}`;
  }
  return `Checked ${count} ${count === 1 ? 'thing' : 'things'} · ${time}`;
}

/** One decimal below ten seconds; whole seconds above. */
export function seconds(ms: number): string {
  const value = ms / 1000;
  return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}
