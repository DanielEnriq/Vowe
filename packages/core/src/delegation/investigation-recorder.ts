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
   * The clause each hit's ref was found under, keyed by `formatRef(ref)`.
   *
   * A search names what it was looking for; an open of one of its hits is the
   * same lookup continuing, so the open's label inherits that clause instead
   * of describing the ref in the abstract. Scoped to this one investigation —
   * a fresh recorder per question — so two unrelated questions can never bleed
   * their search context into each other's opens.
   */
  private readonly clauseByRef = new Map<string, string>();

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

  /**
   * A search, and everything it turned up.
   *
   * The label is built from the query itself, not from which sources were
   * asked — two searches over the same sources with different questions must
   * read as two different steps. No hits is still a check, and its detail
   * line says so rather than being silent about it.
   */
  searched(query: string, sources: ContextSource[] | undefined, hits: SearchHit[]): void {
    const clause = clauseOf(query);
    const refs = dedupeRefs(hits.map((hit) => hit.ref));
    for (const ref of refs) this.clauseByRef.set(formatRef(ref), clause);
    this.record({
      kind: 'search',
      label: describeSearch(query, sources),
      detail: describeSearchResult(hits),
      refs,
    });
  }

  /**
   * A descent into one reference.
   *
   * `requested` is the address the investigation asked for, and is what the
   * label describes; `result` says what came back. They are passed separately
   * on purpose: the label must not depend on the result echoing the invocation
   * address, and a lookup that found nothing is still a lookup that happened.
   *
   * When the opened ref was a hit from an earlier search in this same
   * investigation, the label carries that search's clause forward — "reading
   * the worker update about whether the UI repair finished" — rather than
   * describing only the ref's shape.
   */
  opened(requested: ContextRef | null, result: OpenResult): void {
    const found = result.notFound ? null : result.ref;
    const key = found ? formatRef(found) : requested ? formatRef(requested) : null;
    const clause = key ? this.clauseByRef.get(key) : undefined;
    this.record({
      kind: 'open',
      label: describeOpen(requested, clause),
      refs: found ? [found] : [],
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
    a.detail === b.detail &&
    a.refs.length === b.refs.length &&
    a.refs.every((ref, index) => formatRef(ref) === formatRef(b.refs[index]!))
  );
}

/**
 * The labels.
 *
 * Deterministic, derived from the tool call's own arguments — never from a
 * second model asked to phrase it — and written the way a person would say
 * it. The invariant is per invocation, not per tool: the same normalized
 * query produces the same label every time, and a materially different query
 * must never collapse into the same generic phrase as another. `Searched
 * session context` said nothing that told two different questions apart; a
 * label built from the query itself always does.
 *
 * They are also written once, at the time of the lookup, and then persisted.
 * Changing the wording later will not rewrite what Vowe said it did last month,
 * and should not.
 */
export function describeSearch(query: string, sources?: ContextSource[]): string {
  const cleaned = cleanQuery(query);
  if (!cleaned) return sourceFallback(sources);
  const matched = matchQuery(cleaned);
  const label = matched ? matched.pattern.label(matched.rest) : `Looking for ${cleaned}`;
  return capitalize(label);
}

/**
 * What one search turned up, in the developer's terms — never a summary of
 * what the hits mean, because nothing here read them closely enough to say
 * that truthfully. A count is a fact; a paraphrase of a count would be a
 * guess wearing a fact's clothes.
 */
export function describeSearchResult(hits: SearchHit[]): string {
  if (hits.length === 0) return 'No matching items found';
  if (hits.length === 1) return '1 matching item';
  return `${hits.length} matching items`;
}

export function describeOpen(ref: ContextRef | null, clause?: string): string {
  if (!ref) return 'Followed a reference';
  switch (ref.kind) {
    case 'repo': {
      const location =
        ref.line === undefined ? path.basename(ref.path) : `${path.basename(ref.path)}:${ref.line}`;
      return clause ? `Reading ${location} for ${clause}` : `Read ${location}`;
    }
    case 'symbol':
      return clause ? `Checking repository structure for ${clause}` : 'Checked repository structure';
    case 'lesson':
      return clause ? `Consulting project knowledge about ${clause}` : 'Consulted project knowledge';
    case 'window':
      return clause ? `Reading recent observed work about ${clause}` : 'Checked recent observed work';
    case 'trace':
    case 'event':
      return clause ? `Reading the worker update about ${clause}` : 'Reviewed worker activity';
    case 'transcript':
      return clause ? `Reading the exchange about ${clause}` : 'Read the exchange';
    case 'diff':
      return 'Opened the current diff';
  }
}

export function describeDiff(target: string | undefined): string {
  return target ? `Inspecting ${target} changes` : 'Inspecting the current diff';
}

function sourceFallback(sources: ContextSource[] | undefined): string {
  const repo = sources?.includes('repo');
  return repo ? 'Searched the repository' : 'Searched session context';
}

/**
 * The clause an open inherits from the search that found it.
 *
 * Same normalization as the search label itself, so "whether the tests
 * passed?" and "Whether the tests passed" produce the same clause and the
 * same later open label — the invariant applies here too.
 */
function clauseOf(query: string): string {
  const cleaned = cleanQuery(query);
  if (!cleaned) return '';
  const matched = matchQuery(cleaned);
  return matched ? matched.pattern.clause(matched.rest) : cleaned;
}

/**
 * Grammatical cleanup, not intent classification.
 *
 * Strips the transport noise around a query — a polite preamble, wrapping
 * quotes, trailing punctuation, doubled whitespace — while leaving every
 * distinguishing word exactly where it was. Nothing here looks at *what* the
 * query is about, only at how it is dressed.
 */
function cleanQuery(raw: string): string {
  let query = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const filler of FILLER_PREFIXES) {
      const next = query.replace(filler, '');
      if (next !== query) {
        query = next.trim();
        stripped = true;
      }
    }
  }
  query = query.replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim();
  return truncate(query, MAX_QUERY_CHARS);
}

const FILLER_PREFIXES: RegExp[] = [
  /^can you\s+/i,
  /^could you\s+/i,
  /^would you\s+/i,
  /^please\s+/i,
  /^i want to know\s+/i,
  /^i'd like to know\s+/i,
  /^i would like to know\s+/i,
  /^let me check\s+/i,
  /^go (and )?(check|find out|look up)\s+/i,
  /^find out\s+/i,
  /^check\s+/i,
  /^see\s+/i,
  /^look (up|into)\s+/i,
];

/** Roughly one compact line. Cut at a word boundary and marked as cut. */
const MAX_QUERY_CHARS = 100;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

interface QueryPattern {
  match: RegExp;
  label: (rest: string) => string;
  clause: (rest: string) => string;
}

/**
 * Ordered by how specific the leading word is. The first one whose keyword
 * matches wins; everything after it is the query's own words, untouched.
 */
const QUERY_PATTERNS: QueryPattern[] = [
  {
    match: /^whether\s+/i,
    label: (rest) => `Checking whether ${rest}`,
    clause: (rest) => `whether ${rest}`,
  },
  {
    match: /^what\s+/i,
    label: (rest) => `Finding what ${rest}`,
    clause: (rest) => `what ${rest}`,
  },
  {
    match: /^why\s+/i,
    label: (rest) => `Tracing why ${rest}`,
    clause: (rest) => `why ${rest}`,
  },
  {
    match: /^where\s+/i,
    label: (rest) => `Locating where ${rest}`,
    clause: (rest) => `where ${rest}`,
  },
  {
    match: /^who\s+/i,
    label: (rest) => `Finding who ${rest}`,
    clause: (rest) => `who ${rest}`,
  },
  {
    match: /^when\s+/i,
    label: (rest) => `Finding when ${rest}`,
    clause: (rest) => `when ${rest}`,
  },
  {
    match: /^how\s+/i,
    label: (rest) => `Working out how ${rest}`,
    clause: (rest) => `how ${rest}`,
  },
  {
    match: /^latest\s+/i,
    label: (rest) => `Looking for the latest ${rest}`,
    clause: (rest) => `the latest ${rest}`,
  },
];

function matchQuery(cleaned: string): { pattern: QueryPattern; rest: string } | null {
  for (const pattern of QUERY_PATTERNS) {
    const hit = cleaned.match(pattern.match);
    if (!hit) continue;
    const rest = cleaned.slice(hit[0].length).trim();
    if (!rest) continue;
    return { pattern, rest };
  }
  return null;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
