import type { ContextRef } from '../context/refs.js';
import type { NormalizedEvent } from '../types/events.js';

/**
 * The few things a worker does that are worth a line in the conversation.
 *
 * The trace is not a feed. A coding agent produces hundreds of events an hour
 * and almost none of them change what the developer understands: reading a
 * file, grepping, starting a tool. Those stay in worker activity, where they
 * are evidence. What reaches the conversation is the short list below, because
 * each item changes the answer to "what is happening?".
 *
 * This is selection, never summarisation. No model runs here, every milestone
 * names the events it stands for, and every one carries refs so the developer
 * can descend from the line to the trace that produced it.
 */
export type WorkerMilestoneKind =
  | 'session_started'
  | 'edits'
  | 'tests_started'
  | 'tests_finished'
  | 'awaiting_human'
  | 'session_finished';

export interface WorkerMilestone {
  /** The anchoring event's id, so the milestone is stable across recomputes. */
  id: string;
  sessionId: string;
  at: string;
  kind: WorkerMilestoneKind;
  /**
   * One readable line, without the provider's name.
   *
   * The renderer prefixes that — "Claude Code · regression suite passed" — and
   * core does not learn which worker it was talking about.
   */
  text: string;
  /** Every event this line stands for. A run of edits is one milestone. */
  eventIds: string[];
  /** Where the line descends to. */
  refs: ContextRef[];
  /** Set only where the event actually recorded an outcome. */
  failed?: boolean;
}

/**
 * Kinds that never reach the conversation, stated as a decision.
 *
 * A deny-list rather than a fallthrough: an event kind nobody has classified
 * should show up in review as an unhandled case, not silently vanish.
 */
const EXCLUDED = new Set([
  'agent_message',
  // Thinking is not progress. It is also unevenly available, so admitting it
  // would give a session more milestones for having a talkative provider.
  'agent_reasoning',
  'user_instruction',
  'tool_started',
  'tool_finished',
  'command_started',
  'command_finished',
  'unknown',
]);

export interface WorkerMilestoneOptions {
  /** Keep only the newest N. Undefined keeps all of them. */
  limit?: number;
}

export function workerMilestones(
  events: readonly NormalizedEvent[],
  options: WorkerMilestoneOptions = {},
): WorkerMilestone[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const milestones: WorkerMilestone[] = [];

  /**
   * Consecutive edits collapse into one line.
   *
   * §10 of the product contract excludes "every `file_changed`", and it is
   * right: a line per edit is the trace again, in the wrong place. But a
   * developer who looks away for five minutes should still see that the worker
   * changed files. So a *run* of edits — uninterrupted by anything else that
   * matters — becomes a single milestone naming what it touched.
   */
  let run: NormalizedEvent[] = [];
  const flush = () => {
    if (!run.length) return;
    milestones.push(editMilestone(run));
    run = [];
  };

  for (const event of ordered) {
    if (EXCLUDED.has(event.kind)) continue;

    if (event.kind === 'file_changed') {
      run.push(event);
      continue;
    }

    flush();
    const milestone = milestoneFor(event);
    if (milestone) milestones.push(milestone);
  }
  flush();

  milestones.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const collapsed = collapse(milestones);
  const limit = options.limit;
  return typeof limit === 'number' && limit >= 0 ? collapsed.slice(-limit) : collapsed;
}

/**
 * The same thing, said once.
 *
 * A worker that runs its suite after every edit produces "started the test
 * suite / test suite passed" over and over, and ten of those lines crowd out
 * the one fact they all carry: the suite passes. Two rules, both selection and
 * neither summarisation:
 *
 * - a start followed by its own finish is the finish, because by the time
 *   anyone reads it the starting is no longer news;
 * - a run of identical consecutive lines is the last of them.
 *
 * Every collapsed line keeps every `eventId` it stands for, so nothing becomes
 * unreachable — the trace is still there, one descent away.
 */
function collapse(milestones: readonly WorkerMilestone[]): WorkerMilestone[] {
  const settled: WorkerMilestone[] = [];

  for (const milestone of milestones) {
    let current = milestone;
    // Absorbing runs backwards, not one step: a finish that has just swallowed
    // its own start becomes identical to the finish before it, and the round
    // of the loop that created that likeness is the one that must see it.
    while (settled.length) {
      const previous = settled[settled.length - 1]!;
      if (!mergeable(previous, current)) break;
      current = absorb(current, previous);
      settled.pop();
    }
    settled.push(current);
  }

  return settled;
}

function mergeable(previous: WorkerMilestone, current: WorkerMilestone): boolean {
  if (previous.sessionId !== current.sessionId) return false;
  if (previous.kind === 'tests_started' && current.kind === 'tests_finished') return true;
  return previous.kind === current.kind && previous.text === current.text;
}

/**
 * Keep the later line and everything the earlier one stood for.
 *
 * The survivor's own identity is kept — its id anchors it across recomputes —
 * and the absorbed events are prepended so the ids stay in the order they
 * happened.
 */
function absorb(survivor: WorkerMilestone, absorbed: WorkerMilestone): WorkerMilestone {
  const eventIds = [...absorbed.eventIds];
  for (const id of survivor.eventIds) if (!eventIds.includes(id)) eventIds.push(id);
  return { ...survivor, eventIds };
}

function milestoneFor(event: NormalizedEvent): WorkerMilestone | null {
  switch (event.kind) {
    case 'session_started':
      return base(event, 'session_started', 'started work');

    case 'test_started':
      return base(event, 'tests_started', 'started the test suite');

    case 'test_finished': {
      const failed = event.detail?.['failed'] === true;
      const milestone = base(event, 'tests_finished', testOutcome(event, failed));
      milestone.failed = failed;
      return milestone;
    }

    case 'permission_requested':
      return base(event, 'awaiting_human', 'is asking permission to continue');

    /**
     * A stop is only a milestone when the worker stopped *for a person*. The
     * adapter is the only thing that knows the difference, and it says so with
     * `awaitingHuman` — the same flag `Needs You` admits on.
     */
    case 'session_waiting':
      return event.detail?.['awaitingHuman'] === true
        ? base(event, 'awaiting_human', waitingText(event))
        : null;

    case 'session_finished':
      return base(event, 'session_finished', 'finished');

    default:
      return null;
  }
}

function base(
  event: NormalizedEvent,
  kind: WorkerMilestoneKind,
  text: string,
): WorkerMilestone {
  return {
    id: event.id,
    sessionId: event.sessionId,
    at: event.at,
    kind,
    text,
    eventIds: [event.id],
    refs: [{ kind: 'event', sessionId: event.sessionId, eventId: event.id }],
  };
}

/**
 * Counts, but only the ones the worker actually printed.
 *
 * The approved design shows "passed 177 / 177", which is worth having — and is
 * only honest when the numbers came out of the test output. When they did not,
 * the line says what is known and stops there rather than inventing a total.
 */
function testOutcome(event: NormalizedEvent, failed: boolean): string {
  const output = typeof event.detail?.['output'] === 'string' ? event.detail['output'] : '';
  const passed = countOf(output, 'passed');
  const failures = countOf(output, 'failed');

  if (failed || (failures !== null && failures > 0)) {
    if (passed !== null && failures !== null) {
      return `test suite failed · ${passed} passed, ${failures} failed`;
    }
    return 'test suite failed';
  }

  if (passed !== null) return `test suite passed ${passed} / ${passed}`;
  return 'test suite passed';
}

/**
 * The pass and fail counts a test run printed, each `null` where it printed
 * none. Shared with the return brief, so both read a run's output one way.
 */
export function testCounts(output: string): { passed: number | null; failed: number | null } {
  return { passed: countOf(output, 'passed'), failed: countOf(output, 'failed') };
}

/**
 * How many tests, not how many files.
 *
 * Real runners print both, files first: vitest's summary is `Test Files 38
 * passed` and then `Tests 357 passed`. Taking the first number in the output
 * reports the file count as a test count, so a line that names tests wins over
 * one that merely contains a number.
 */
function countOf(output: string, outcome: 'passed' | 'failed'): number | null {
  const onTestsLine = new RegExp(String.raw`\btests\b[^\n]*?(\d+)\s+${outcome}`, 'i');
  const anywhere = new RegExp(String.raw`(\d+)\s+(?:tests?\s+)?${outcome}`, 'i');
  return firstCount(output, onTestsLine) ?? firstCount(output, anywhere);
}

function firstCount(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function waitingText(event: NormalizedEvent): string {
  const summary = typeof event.summary === 'string' ? event.summary.trim() : '';
  return summary ? lowerFirst(summary) : 'is waiting for you';
}

/**
 * A run of edits, named by what it touched.
 *
 * File paths come from the event detail, so the refs are real addresses: the
 * line descends to the source and, for a single file, to that file's current
 * diff — which is what the design's edit interstitial links to.
 */
function editMilestone(run: readonly NormalizedEvent[]): WorkerMilestone {
  const last = run[run.length - 1]!;
  const paths = uniquePaths(run);
  const refs: ContextRef[] = [];

  if (paths.length === 1) {
    refs.push({ kind: 'repo', path: paths[0]! });
    refs.push({ kind: 'diff', sessionId: last.sessionId, path: paths[0]! });
  } else {
    refs.push({ kind: 'diff', sessionId: last.sessionId });
  }

  return {
    id: last.id,
    sessionId: last.sessionId,
    at: last.at,
    kind: 'edits',
    text: editText(paths, run.length),
    eventIds: run.map((event) => event.id),
    refs,
  };
}

function editText(paths: readonly string[], changes: number): string {
  if (paths.length === 1) return `edited ${baseName(paths[0]!)}`;
  if (paths.length > 1) return `edited ${paths.length} files`;
  return changes === 1 ? 'changed a file' : `made ${changes} file changes`;
}

function uniquePaths(run: readonly NormalizedEvent[]): string[] {
  const seen: string[] = [];
  for (const event of run) {
    const input = event.detail?.['input'];
    const path =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)['file_path']
        : undefined;
    if (typeof path === 'string' && path && !seen.includes(path)) seen.push(path);
  }
  return seen;
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
