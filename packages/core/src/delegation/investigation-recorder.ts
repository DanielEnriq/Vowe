import path from 'node:path';

import type { OpenResult, SearchHit } from '../context/context-navigator.js';
import { dedupeRefs, formatRef, type ContextRef, type ContextSource } from '../context/refs.js';
import type {
  InvestigationCheck,
  InvestigationReceipt,
} from '../types/conversation.js';

/**
 * What the investigator actually looked at, in the order it looked.
 *
 * Built from the tool calls themselves as they happen — not inferred afterwards
 * from the answer's prose, and not produced by a second model asked to describe
 * the first. Those would both be guesses, and a receipt that guesses is worse
 * than no receipt: it invites belief in something nobody checked.
 *
 * What it therefore cannot contain is as important as what it can. A tool call
 * is observable; a hypothesis, a plan, a prompt or a discarded line of thinking
 * is not, and none of them reaches this object.
 */
export class InvestigationRecorder {
  private readonly checks: InvestigationCheck[] = [];
  private readonly onCheck: (check: InvestigationCheck) => void;

  /**
   * `onCheck` fires the moment a lookup is recorded, which is the moment it
   * actually happened.
   *
   * It exists so a waiting developer can watch the investigation proceed
   * rather than watching nothing for half a minute. What it emits is the same
   * check that will later be persisted in the receipt — the live line and the
   * recorded line are one object, so the UI cannot show a step that turns out
   * not to have been taken.
   */
  constructor(options: { onCheck?: (check: InvestigationCheck) => void } = {}) {
    this.onCheck = options.onCheck ?? (() => undefined);
  }

  /** A search, and everything it turned up. No hits is still a check. */
  searched(sources: ContextSource[] | undefined, hits: SearchHit[]): void {
    this.record({
      kind: 'search',
      label: describeSearch(sources),
      refs: dedupeRefs(hits.map((hit) => hit.ref)),
    });
  }

  /**
   * A descent into one reference.
   *
   * `requested` is the address the investigation asked for, and is what the
   * label describes; `result` says what came back. They are passed separately
   * on purpose: the label must not depend on the result echoing the invocation
   * address, and a lookup that found nothing is still a lookup that happened.
   */
  opened(requested: ContextRef | null, result: OpenResult): void {
    this.record({
      kind: 'open',
      label: describeOpen(requested),
      refs: result.notFound ? [] : [result.ref],
    });
  }

  diffed(ref: Extract<ContextRef, { kind: 'diff' }>): void {
    this.record({
      kind: 'diff',
      label: describeDiff(ref.path),
      refs: [ref],
    });
  }

  /**
   * Every ref touched, in the order it was touched.
   *
   * This is what the answer's own `refs` are built from, so the receipt and the
   * grounding cannot drift apart: they are the same material, narrated once and
   * flattened once.
   */
  refs(): ContextRef[] {
    return this.checks.flatMap((check) => check.refs);
  }

  get length(): number {
    return this.checks.length;
  }

  receipt(durationMs: number): InvestigationReceipt {
    return { durationMs, checks: this.checks.map((check) => ({ ...check })) };
  }

  /**
   * Only an immediately repeated, identical check collapses.
   *
   * Enough to keep a retry loop from printing the same line four times, and
   * deliberately no more: compressing further would start hiding the shape of
   * the investigation, which is the one thing the receipt exists to show.
   */
  private record(check: InvestigationCheck): void {
    const previous = this.checks[this.checks.length - 1];
    if (previous && sameCheck(previous, check)) return;
    this.checks.push(check);
    // A listener must never be able to fail the investigation it is watching.
    try {
      this.onCheck(check);
    } catch {
      // Deliberately swallowed: this is a view concern, not the work.
    }
  }
}

function sameCheck(a: InvestigationCheck, b: InvestigationCheck): boolean {
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    a.refs.length === b.refs.length &&
    a.refs.every((ref, index) => formatRef(ref) === formatRef(b.refs[index]!))
  );
}

/**
 * The labels.
 *
 * Deterministic, derived from the tool and the address it was given, and
 * written the way a person would say it — never `search_context(...)` and never
 * a tool-call id. No model is asked to phrase these: a label that varies run to
 * run is not a record of anything.
 *
 * They are also written once, at the time of the lookup, and then persisted.
 * Changing the wording later will not rewrite what Vowe said it did last month,
 * and should not.
 */
export function describeSearch(sources: ContextSource[] | undefined): string {
  if (!sources?.length) return 'Searched session context';
  const repo = sources.includes('repo');
  const session = sources.some((source) => source !== 'repo');
  if (repo && session) return 'Searched session context and the repository';
  if (repo) return 'Searched the repository';
  return 'Searched session context';
}

export function describeOpen(ref: ContextRef | null): string {
  if (!ref) return 'Followed a reference';
  switch (ref.kind) {
    case 'repo':
      return ref.line === undefined
        ? `Read ${path.basename(ref.path)}`
        : `Read ${path.basename(ref.path)}:${ref.line}`;
    case 'symbol':
      return 'Checked repository structure';
    case 'lesson':
      return 'Consulted project knowledge';
    case 'window':
      return 'Checked recent observed work';
    case 'trace':
    case 'event':
      return 'Reviewed worker activity';
    case 'transcript':
      return 'Read the exchange';
    case 'diff':
      return 'Opened the current diff';
  }
}

export function describeDiff(target: string | undefined): string {
  return target ? `Inspected the diff for ${target}` : 'Inspected the current diff';
}
