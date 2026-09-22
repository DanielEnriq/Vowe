import type { WindowNote } from '../observation/trace-window.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AgentSession } from '../types/session.js';
import type { AttentionItem } from './attention.js';
import { testCounts } from './worker-milestones.js';

/**
 * Vowe catching you up: the checkpoint read as answers rather than as a log.
 *
 * Five questions, each answered from something that was already recorded —
 * the observer's own notes, the outcomes of the commands the worker ran, the
 * session's status and the files its edits named. Nothing here is written by
 * a model at read time, and a question with no recorded answer is left empty
 * rather than filled with a guess.
 *
 * Grouped, never a replay. Ten runs of the same suite are one line saying how
 * it last finished; twelve edits to one file are one file.
 */
export interface ReturnBrief {
  /** What the observer noticed changing, oldest first. At most three. */
  changed: string[];
  /** Each distinct check, as its latest run finished. */
  verified: Verification[];
  /** Where the session is now. */
  state: SessionStateLine;
  /** What is waiting on the developer. Empty is "nothing needs you". */
  needsYou: string[];
  /** Files the worker changed, most-edited first. */
  touched: string[];
}

export interface Verification {
  kind: 'tests' | 'typecheck' | 'build' | 'lint';
  /** `full suite`, `patch tests`, `typecheck`… */
  label: string;
  passed: boolean;
  /** `601 / 601`, `3 of 601 failed`, `clean`. Empty when nothing was printed. */
  result: string;
  /** How many times it ran while they were away. */
  runs: number;
}

export interface SessionStateLine {
  status: AgentSession['status'];
  text: string;
  /** What the worker was last doing, when the interpretation is recent. */
  activity?: string;
}

export interface ReturnBriefInput {
  /** Only the events since the developer last looked. */
  events: readonly NormalizedEvent[];
  notes: readonly WindowNote[];
  /** The moment they last looked; notes and interpretation older than it are old news. */
  since: string;
  needsAttention: readonly AttentionItem[];
  session?: Pick<AgentSession, 'status' | 'semanticState'>;
}

const MAX_CHANGED = 3;

export function returnBrief(input: ReturnBriefInput): ReturnBrief {
  const since = Date.parse(input.since);
  return {
    changed: changedSince(input.notes, since),
    verified: verifications(input.events),
    state: stateLine(input.session, since),
    needsYou: input.needsAttention.map((item) => item.summary),
    touched: touchedFiles(input.events),
  };
}

/**
 * The observer's notable changes, or failing those its latest summary.
 *
 * A window with nothing notable still said what the worker was doing, and one
 * sentence of that is a better answer to "what changed?" than an empty
 * section — but only one, since a summary is a description, not news.
 */
function changedSince(notes: readonly WindowNote[], since: number): string[] {
  const fresh = notes
    .filter((note) => Date.parse(note.createdAt) > since)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

  const notable = fresh
    .map((note) => note.notableChange?.trim() ?? '')
    .filter((text, index, all) => text && all.indexOf(text) === index);
  if (notable.length > 0) return notable.slice(-MAX_CHANGED);

  const summary = fresh.at(-1)?.summary.trim();
  return summary ? [summary] : [];
}

/**
 * Every check the worker ran, one line per check.
 *
 * A finish carries the outcome and its start carries the command; the two are
 * joined by the tool call they share. The command decides what kind of check
 * it was and which one — `vitest run test/patch.test.ts` is the patch tests,
 * `pnpm test` is the full suite — and the latest run of each is the one that
 * counts, because that is the state the code is in now.
 */
function verifications(events: readonly NormalizedEvent[]): Verification[] {
  const commands = new Map<string, string>();
  const byLabel = new Map<string, Verification>();

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const toolUseId = stringAt(event.detail, 'toolUseId');

    if (event.kind === 'test_started' || event.kind === 'command_started') {
      const input = event.detail?.['input'];
      const command =
        input && typeof input === 'object' ? stringAt(input as Record<string, unknown>, 'command') : '';
      if (toolUseId && command) commands.set(toolUseId, command);
      continue;
    }
    if (event.kind !== 'test_finished' && event.kind !== 'command_finished') continue;

    const command = toolUseId ? (commands.get(toolUseId) ?? '') : '';
    const kind = event.kind === 'test_finished' ? 'tests' : checkKind(command);
    if (!kind) continue;

    const output = stringAt(event.detail, 'output');
    const outcome = outcomeOf(kind, output, event.detail?.['failed'] === true);
    const label = kind === 'tests' ? testLabel(command) : kind;
    const previous = byLabel.get(label);
    // Re-inserted so the map's order is the order each check last ran.
    byLabel.delete(label);
    byLabel.set(label, { kind, label, ...outcome, runs: (previous?.runs ?? 0) + 1 });
  }

  return [...byLabel.values()];
}

function checkKind(command: string): Verification['kind'] | null {
  if (/\b(tsc|typecheck|mypy|pyright|cargo check|go vet)\b/.test(command)) return 'typecheck';
  if (/\b(eslint|ruff|clippy|lint)\b/.test(command)) return 'lint';
  if (/\bbuild\b/.test(command)) return 'build';
  return null;
}

/**
 * Passed or failed, and the numbers only where the output printed them.
 *
 * The exit status is not trusted alone: a command piped through `tail` exits
 * with `tail`'s status, so a type error or a failure count in the output wins
 * over a clean exit.
 */
function outcomeOf(
  kind: Verification['kind'],
  output: string,
  exitFailed: boolean,
): Pick<Verification, 'passed' | 'result'> {
  if (kind === 'tests') {
    const { passed, failed } = testCounts(output);
    const failing = exitFailed || (failed ?? 0) > 0;
    if (failing) {
      if (passed !== null && failed !== null) {
        return { passed: false, result: `${failed} of ${passed + failed} failed` };
      }
      return { passed: false, result: failed !== null ? `${failed} failed` : 'failed' };
    }
    return { passed: true, result: passed !== null ? `${passed} / ${passed}` : 'passed' };
  }

  if (kind === 'typecheck') {
    const errors = output.match(/error TS\d+/g)?.length ?? 0;
    if (exitFailed || errors > 0) {
      return { passed: false, result: errors > 0 ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : 'errors' };
    }
    return { passed: true, result: 'clean' };
  }

  const failed = exitFailed || /\b(build failed|error during build)\b/i.test(output);
  return { passed: !failed, result: failed ? 'failed' : kind === 'build' ? 'built' : 'clean' };
}

/**
 * Which tests, in the developer's words.
 *
 * A run naming one test file is that file's tests; a run naming several says
 * how many; a run naming none is the whole suite.
 */
function testLabel(command: string): string {
  const files = [
    ...new Set(
      command.match(/[\w./-]*?[\w-]+(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.(?:go|py)|\.py(?=\s|$))/g) ?? [],
    ),
  ].filter((file) => /test|spec/.test(file));
  if (files.length === 0) return 'full suite';
  if (files.length > 1) return `${files.length} test files`;
  const name = files[0]!.split('/').pop()!;
  return `${name.replace(/\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|\.py$/, '').replace(/^test_/, '')} tests`;
}

function stateLine(
  session: ReturnBriefInput['session'],
  since: number,
): SessionStateLine {
  const status = session?.status ?? 'unknown';
  const semantic = session?.semanticState;
  const activity =
    semantic && Date.parse(semantic.updatedAt) > since && semantic.currentActivity.trim()
      ? semantic.currentActivity.trim()
      : undefined;

  const text =
    status === 'finished'
      ? 'The session has finished.'
      : status === 'working' || status === 'starting'
        ? 'The worker is still going.'
        : status === 'waiting' || status === 'idle'
          ? 'The worker has stopped and is idle.'
          : 'Vowe is not watching this session live, so where it is now is unknown.';

  return activity ? { status, text, activity } : { status, text };
}

/**
 * Each file the worker's edits named, once, the most-edited first.
 *
 * Ties go to the one touched most recently, since that is nearer to where the
 * work is now.
 */
function touchedFiles(events: readonly NormalizedEvent[]): string[] {
  const files = new Map<string, { edits: number; lastSeq: number }>();
  for (const event of events) {
    if (event.kind !== 'file_changed') continue;
    const input = event.detail?.['input'];
    const path =
      input && typeof input === 'object' ? stringAt(input as Record<string, unknown>, 'file_path') : '';
    if (!path) continue;
    const seen = files.get(path);
    files.set(path, {
      edits: (seen?.edits ?? 0) + 1,
      lastSeq: Math.max(seen?.lastSeq ?? 0, event.seq),
    });
  }
  return [...files.entries()]
    .sort(([, a], [, b]) => b.edits - a.edits || b.lastSeq - a.lastSeq)
    .map(([path]) => path);
}

function stringAt(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value : '';
}
