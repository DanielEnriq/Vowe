import type { ContextRef } from '../context/refs.js';
import type { NormalizedEvent } from '../types/events.js';
import {
  baseName,
  commandParts,
  firstOperand,
  firstStatement,
  isPresentable,
  unquote,
} from './shell.js';
import { testCounts } from './worker-milestones.js';

/**
 * What a worker is doing *right now*, derived without a model.
 *
 * The fast half of observation. An interpretation pass costs a model round trip
 * and cannot run per event, so between passes the only honest answer to "what
 * is it doing?" is the one the trace already contains — and the adapters have
 * been recording it all along, in `kind` and `detail`.
 *
 * Two rules give this its character:
 *
 *  1. **Specific or silent.** A label that says `Reading file`, `Running
 *     command` or `Working…` costs the developer a glance and returns nothing.
 *     An event whose summary is one of those generic shapes is passed over and
 *     the walk continues backwards, so the line on screen always names a real
 *     command, file or search.
 *  2. **Only what the trace supports.** Nothing here guesses at intent. A test
 *     run is named by the target the command actually referenced; an edit run
 *     is named by the paths the adapter actually recorded.
 *
 * `agent_reasoning` is skipped, for the reason it is skipped everywhere else:
 * most providers record none, and a Vowe that understood a pi session better
 * than a Codex one would be the wrong product.
 */

/**
 * Phase vocabulary, in one place.
 *
 * Shared with `HeuristicInterpreter`, which used to own it. Two tables would
 * drift, and a session whose phase changed depending on which half of
 * observation last wrote would be unreadable.
 */
export const PHASE_BY_KIND: Partial<Record<NormalizedEvent['kind'], string>> = {
  session_started: 'starting',
  user_instruction: 'reading the request',
  agent_message: 'explaining',
  tool_started: 'exploring',
  tool_finished: 'exploring',
  command_started: 'running commands',
  command_finished: 'running commands',
  file_changed: 'editing',
  test_started: 'testing',
  test_finished: 'testing',
  permission_requested: 'waiting for permission',
  session_waiting: 'waiting',
  session_finished: 'finished',
};

export interface WorkerActivity {
  /** The anchoring event's id, so the same tail always yields the same label. */
  id: string;
  sessionId: string;
  at: string;
  /** One line, specific, present tense. Never a generic placeholder. */
  label: string;
  phase: string;
  /** Every event the label stands for. A run of edits is one activity. */
  eventIds: string[];
  refs: ContextRef[];
}

/**
 * Summaries that describe the tool rather than the work.
 *
 * Every adapter falls back to one of these shapes when it does not recognise a
 * tool, which is exactly when the summary stops being worth showing. Rejecting
 * them here — rather than teaching core each provider's tool names — keeps
 * provider vocabulary out of this package, which is a boundary worth holding.
 */
const GENERIC_SUMMARY: RegExp[] = [
  /^used\s+\S+$/i,
  /^\S+\s+(started|finished|failed)$/i,
  /^tool\s/i,
  /^(working|thinking)\b/i,
  /^(unrecognized|system event)\b/i,
];

/** The most recent thing this session is actually doing, or nothing yet. */
export function workerActivity(
  events: readonly NormalizedEvent[],
): WorkerActivity | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  for (let i = ordered.length - 1; i >= 0; i--) {
    const event = ordered[i]!;
    if (event.kind === 'agent_reasoning' || event.kind === 'unknown') continue;

    if (event.kind === 'file_changed') {
      const run = editRun(ordered, i);
      return activity(event, editLabel(run), run, editRefs(run));
    }

    const label = labelFor(event, ordered);
    if (!label) continue;
    return activity(event, label, [event], [
      { kind: 'event', sessionId: event.sessionId, eventId: event.id },
    ]);
  }

  return null;
}

function activity(
  anchor: NormalizedEvent,
  label: string,
  run: readonly NormalizedEvent[],
  refs: ContextRef[],
): WorkerActivity {
  return {
    id: anchor.id,
    sessionId: anchor.sessionId,
    at: anchor.at,
    label,
    phase: PHASE_BY_KIND[anchor.kind] ?? 'working',
    eventIds: run.map((event) => event.id),
    refs,
  };
}

function labelFor(
  event: NormalizedEvent,
  ordered: readonly NormalizedEvent[],
): string | null {
  switch (event.kind) {
    case 'session_started':
      return 'Starting work';

    case 'user_instruction':
      return 'Reading a new instruction from you';

    /*
     * The worker talking is not the worker doing.
     *
     * Its own prose is the least useful thing this line could carry: it is
     * long, it is written for a different purpose, and it reads as narration
     * rather than status. So a message is passed over in favour of whatever
     * action came before it, and only a tail that holds nothing but messages
     * falls back to saying so — see `workerActivity`.
     */
    case 'agent_message':
      return null;

    case 'command_started':
    case 'test_started':
      return describeCommand(commandOf(event), event.kind === 'test_started')
        ?? null;

    /*
     * A command that finished is not a new thing to be doing.
     *
     * The same collapse `workerMilestones` makes between a test run's start and
     * its finish, for the same reason: by the time anyone reads it, "ran that"
     * and "finished running that" are one fact, and showing both turns a real
     * session into a line that flickers between two phrasings of one command.
     * So the label the start put on screen stays there — unless the command
     * failed, which is genuinely news.
     */
    case 'command_finished': {
      const started = startedFor(event, ordered);
      if (event.detail?.['failed'] === true) {
        const running = started ? describeCommand(commandOf(started), false) : null;
        return running ? `Failed: ${running}` : null;
      }
      return started ? labelFor(started, ordered) : null;
    }

    case 'test_finished':
      return testOutcomeLabel(event);

    case 'permission_requested':
      return 'Waiting for your permission to continue';

    /*
     * Only a stop the adapter marked as a stop *for a person*. An ordinary
     * pause of the worker's own is not something to report as waiting on you —
     * that conflation is what makes an attention surface unreadable.
     */
    case 'session_waiting':
      return event.detail?.['awaitingHuman'] === true
        ? waitingLabel(event)
        : null;

    case 'session_finished':
      return 'Finished';

    default:
      return presentTense(event);
  }
}

/**
 * What the worker stopped to ask for.
 *
 * The adapters distinguish a question from a plan awaiting approval, and that
 * difference decides what the developer has to do next, so it survives. Their
 * wording is past tense because it describes a record; this line describes a
 * state.
 */
function waitingLabel(event: NormalizedEvent): string {
  return /plan|approv/i.test(event.summary)
    ? 'Waiting for your approval'
    : 'Waiting for your answer';
}

/**
 * The adapter's summary, said as something happening now.
 *
 * All three adapters phrase these for a person to read — "Read
 * session-registry.ts", "Searched for applySemanticState" — so the words are
 * already right and only the tense is wrong. The rewritten verbs are ordinary
 * English, not any provider's vocabulary, which is what keeps tool names out
 * of core. A summary whose verb is not in the table is shown unchanged if it
 * says anything, and dropped if it does not.
 */
const PRESENT_TENSE: [RegExp, string][] = [
  [/^Read\b/, 'Reading'],
  [/^Wrote\b/, 'Writing'],
  [/^Edited\b/, 'Updating'],
  [/^Searched for\b/, 'Searching for'],
  [/^Delegated to\b/, 'Delegating to'],
  [/^Fetched\b/, 'Fetching'],
  [/^Ran\b/, 'Running'],
];

function presentTense(event: NormalizedEvent): string | null {
  const summary = fromSummary(event);
  if (!summary) return null;
  for (const [pattern, verb] of PRESENT_TENSE) {
    if (pattern.test(summary)) return summary.replace(pattern, verb);
  }
  return summary;
}

/**
 * The start a finish event is the finish *of*.
 *
 * Matched on the correlation id rather than on adjacency, because the command
 * before it in the stream may belong to an entirely different call — workers
 * routinely run several at once, and their results come back interleaved.
 */
function startedFor(
  finished: NormalizedEvent,
  ordered: readonly NormalizedEvent[],
): NormalizedEvent | null {
  const id = correlationId(finished);
  if (!id) return null;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const event = ordered[i]!;
    if (event.seq >= finished.seq) continue;
    if (event.kind !== 'command_started' && event.kind !== 'test_started') continue;
    if (correlationId(event) !== id) continue;
    return event;
  }
  return null;
}

/**
 * The id that pairs a tool call with its result.
 *
 * Three spellings for one fact, because each adapter carried its provider's own
 * word for it into `detail` — `toolUseId`, `toolCallId`, `callId`. That is
 * normalization debt rather than a design: the normalized event model exists so
 * core does not have to know which provider produced a record, and reading
 * three keys is knowing it in all but name.
 *
 * Repaying it means picking one name and having every adapter set it. That is a
 * change to all three adapters, and it would also change `product/attention.ts`
 * — which reads `toolUseId` alone, and therefore cannot tell that a pi or Codex
 * worker's question was answered. Worth doing, and too wide to do here.
 */
function correlationId(event: NormalizedEvent): string | null {
  for (const key of ['toolUseId', 'toolCallId', 'callId']) {
    const value = event.detail?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * The adapter's own summary, when it says something.
 *
 * All three adapters already phrase these in product language — "Read
 * session-registry.ts", "Searched for applySemanticState" — because they were
 * written for a person to read. Using them verbatim is why this module needs no
 * adapter changes and knows no tool names.
 */
function fromSummary(event: NormalizedEvent): string | null {
  const summary = event.summary.replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  if (GENERIC_SUMMARY.some((pattern) => pattern.test(summary))) return null;
  if (/^(?:Ran:|Running |Command (?:finished|failed):)/i.test(summary)) return null;
  if (summary.length > 160 || /[{}]|\$\(|```|\b[0-9a-f]{8}-[0-9a-f-]{20,}\b/i.test(summary)) return null;
  return summary;
}

function commandOf(event: NormalizedEvent): string {
  const input = event.detail?.['input'];
  if (input && typeof input === 'object') {
    const command = (input as Record<string, unknown>)['command'] ?? (input as Record<string, unknown>)['cmd'];
    if (typeof command === 'string' && command.trim()) return command;
  }
  return '';
}

/**
 * A command, named by what it is for rather than by what was typed.
 *
 * The families below are the ones a coding agent actually runs, and each is
 * recognised from metadata the trace already carries — the program and its
 * first operand, nothing inferred. "Inspecting the installed claude" is what a
 * colleague would say; `which claude` is what the shell was told.
 *
 * The fallback is deliberately strict. A command that survives `isPresentable`
 * is quoted as-is, because a clean command line reads perfectly well; anything
 * carrying substitutions, redirections or assignments returns `null`, and the
 * caller looks further back rather than putting execution residue on screen.
 * Silence beats an ugly label, every time.
 */
function describeCommand(command: string, isTest: boolean): string | null {
  const text = firstStatement(command);
  if (!text) return null;

  if (isTest) {
    const target = testTarget(text);
    return target ? `Running ${target} tests` : 'Running the test suite';
  }

  const { program, args } = commandParts(text);
  const operand = firstOperand(args);
  const rest = args.join(' ');

  // --- locating what is installed -----------------------------------------
  if (program === 'which' || program === 'whereis' || program === 'type') {
    return operand ? `Inspecting the installed ${operand}` : null;
  }

  // --- the repository's own state ------------------------------------------
  if (program === 'git') {
    const subcommand = operand ?? '';
    if (subcommand === 'status') return 'Checking the repository status';
    if (subcommand === 'diff') return 'Reviewing the current changes';
    if (subcommand === 'log' || subcommand === 'show') return 'Reading the commit history';
    if (subcommand === 'branch' || subcommand === 'remote' || subcommand === 'ls-remote') {
      return 'Checking how the repository is set up';
    }
    if (subcommand === 'add' || subcommand === 'commit') return 'Committing changes';
    if (subcommand === 'fetch' || subcommand === 'pull' || subcommand === 'push') {
      return 'Syncing with the remote';
    }
    return subcommand ? `Running git ${subcommand}` : null;
  }

  // --- looking around the working tree -------------------------------------
  if (program === 'ls' || program === 'tree' || program === 'du') {
    return operand ? `Looking through ${prettyPath(operand)}` : 'Looking through the working tree';
  }
  if (program === 'find' || program === 'fd') {
    return operand ? `Looking for files in ${prettyPath(operand)}` : 'Looking for files';
  }
  if (program === 'stat' || program === 'file' || program === 'wc') {
    return operand ? `Inspecting ${prettyPath(operand)}` : null;
  }

  // --- reading and writing source ------------------------------------------
  if (program === 'cat' || program === 'head' || program === 'tail' || program === 'bat') {
    // `cat > file` is a write wearing a reader's name.
    const written = /(?:^|\s)>\s*(\S+)/.exec(executableTail(command));
    if (written?.[1]) return `Writing ${prettyPath(unquote(written[1]))}`;
    return operand ? `Reading ${prettyPath(operand)}` : null;
  }
  if (program === 'sed' && rest.includes('-n')) {
    const file = args.find((token) => !token.startsWith('-') && /[./]/.test(token));
    return file ? `Reading ${prettyPath(unquote(file))}` : null;
  }
  if (program === 'tee') return operand ? `Writing ${prettyPath(operand)}` : null;

  // --- search ---------------------------------------------------------------
  if (program === 'grep' || program === 'rg' || program === 'ag' || program === 'ack') {
    const pattern = firstOperand(args.filter((token) => token !== '-n' && token !== '-r'));
    return pattern ? `Searching for ${bound(pattern, 48)}` : 'Searching the source';
  }

  // --- build, types, lint, dependencies ------------------------------------
  // The compiler is reached as often through a package runner (`pnpm exec
  // tsc`, `npx tsc`) as directly, so the program alone does not identify it.
  if (program === 'tsc' || /\b(tsc|typecheck|type-check)\b/.test(rest)) {
    return 'Checking types';
  }
  if (/\blint\b/.test(rest) || program === 'eslint' || program === 'ruff') {
    return 'Linting the project';
  }
  if (/\bbuild\b/.test(rest) || program === 'make') return 'Building the project';
  if (/\b(install|add|ci)\b/.test(rest) && isPackageManager(program)) {
    return 'Installing dependencies';
  }

  // --- running something ----------------------------------------------------
  if (program === 'node' || program === 'python' || program === 'python3' || program === 'npx') {
    const script = args.find((token) => /[./]/.test(token) && !token.startsWith('-'));
    return script ? `Running ${baseName(unquote(script))}` : null;
  }
  if (program === 'curl' || program === 'wget') {
    const url = args.find((token) => /^https?:/.test(unquote(token)));
    return url ? `Fetching ${hostOf(unquote(url))}` : null;
  }
  if (program === 'mkdir' || program === 'mv' || program === 'cp' || program === 'rm') {
    return 'Reorganising files';
  }

  return isPresentable(text) ? `Running ${text}` : null;
}

/** Everything after the heredoc body is removed, for spotting a redirection. */
function executableTail(command: string): string {
  return firstStatement(command);
}

function isPackageManager(program: string): boolean {
  return program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun' || program === 'pip' || program === 'pip3';
}

/**
 * A path as a person refers to it: the file, and the package it is in.
 *
 * A full repository-relative path is precise and unreadable at a glance; the
 * leaf alone is ambiguous across a monorepo. Naming both is how the developer
 * would say it out loud.
 */
function prettyPath(value: string): string {
  const cleaned = unquote(value).replace(/^\.\//, '');
  if (!cleaned || cleaned === '.' || cleaned === './') return 'the working tree';
  if (cleaned === '~' || cleaned.startsWith('~/')) return cleaned;
  const segments = cleaned.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 2) return cleaned;

  /*
   * "in <package>" only where a package is what it is in.
   *
   * Naming the containing directory unconditionally produced "Vowe in
   * projects", which says less than "Vowe" and reads like the repository is a
   * component of something. The qualifier earns its place inside a workspace,
   * where the leaf really is ambiguous — a dozen packages have a `normalize.ts`
   * — and nowhere else.
   */
  const leaf = segments[segments.length - 1]!;
  const scope = workspacePackageOf(cleaned);
  return scope && scope !== leaf ? `${leaf} in ${scope}` : leaf;
}

function hostOf(url: string): string {
  const match = /^https?:\/\/([^/]+)/.exec(url);
  return match?.[1] ?? url;
}

/**
 * The narrowest thing a test command pointed at.
 *
 * The last path-shaped argument, stripped of its directories and of the
 * `.test.ts` scaffolding around the name. When a command names no target it is
 * the whole suite, and saying so is better than naming the runner.
 */
function testTarget(command: string): string | null {
  const tokens = command.split(' ').filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.startsWith('-')) continue;
    if (!token.includes('/') && !token.includes('.')) continue;

    const segments = token.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const name = last
      .replace(/\.(test|spec)\.[a-z]+$/i, '')
      .replace(/\.[a-z]+$/i, '');
    // A bare directory of tests is named by the directory above it, so
    // `packages/adapter-pi/test` reads as "adapter-pi" rather than "test".
    if (!name || name === 'test' || name === 'tests' || name === '__tests__') {
      const parent = segments[segments.length - 2];
      if (parent && parent !== 'packages' && parent !== 'apps') return parent;
      continue;
    }
    return name;
  }
  return null;
}

/**
 * How a test run ended, counting only what the runner printed.
 *
 * `testCounts` is shared with `workerMilestones` so "the suite passed" means
 * the same thing whether it is read as current activity or as a milestone.
 */
function testOutcomeLabel(event: NormalizedEvent): string {
  const output =
    typeof event.detail?.['output'] === 'string' ? event.detail['output'] : '';
  const { passed, failed } = testCounts(output);
  const didFail = event.detail?.['failed'] === true || (failed ?? 0) > 0;

  if (didFail) {
    return passed !== null && failed !== null
      ? `Test suite failed · ${passed} passed, ${failed} failed`
      : 'Test suite failed';
  }
  return passed !== null ? `Test suite passed ${passed} / ${passed}` : 'Test suite passed';
}

/** The trailing run of edits, so a burst of them is one line rather than ten. */
function editRun(
  ordered: readonly NormalizedEvent[],
  end: number,
): NormalizedEvent[] {
  const run: NormalizedEvent[] = [];
  for (let i = end; i >= 0; i--) {
    const event = ordered[i]!;
    if (event.kind === 'file_changed') {
      run.unshift(event);
      continue;
    }
    // Reasoning and unclassified records do not interrupt a run, because
    // neither is something the worker did.
    if (event.kind === 'agent_reasoning' || event.kind === 'unknown') continue;
    break;
  }
  return run;
}

function editLabel(run: readonly NormalizedEvent[]): string {
  const paths = uniquePaths(run);
  if (!paths.length) {
    return run.length === 1 ? 'Changing a file' : `Making ${run.length} file changes`;
  }

  const packages = new Set(paths.map(packageOf).filter((name): name is string => !!name));
  const where = packages.size === 1 ? ` in ${[...packages][0]}` : '';

  if (paths.length === 1) return `Updating ${baseName(paths[0]!)}${where}`;
  return `Updating ${paths.length} files${where}`;
}

function editRefs(run: readonly NormalizedEvent[]): ContextRef[] {
  const last = run[run.length - 1]!;
  const paths = uniquePaths(run);
  const refs: ContextRef[] = [
    { kind: 'event', sessionId: last.sessionId, eventId: last.id },
  ];
  if (paths.length === 1) {
    refs.push({ kind: 'repo', path: paths[0]! });
    refs.push({ kind: 'diff', sessionId: last.sessionId, path: paths[0]! });
  } else if (paths.length > 1) {
    refs.push({ kind: 'diff', sessionId: last.sessionId });
  }
  return refs;
}

/**
 * The workspace package a path belongs to.
 *
 * `packages/adapter-pi/src/normalize.ts` is "adapter-pi", which is how the
 * developer refers to it. Outside a workspace layout the containing directory
 * is the closest true answer, and no answer is better than a wrong one.
 */
function packageOf(path: string): string | null {
  const workspace = workspacePackageOf(path);
  if (workspace) return workspace;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const parent = segments[segments.length - 2];
  return parent && parent !== 'src' ? parent : null;
}

/** The workspace package a path is in, and nothing looser. */
function workspacePackageOf(path: string): string | null {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  for (const anchor of ['packages', 'apps']) {
    const at = segments.lastIndexOf(anchor);
    if (at >= 0 && segments[at + 1]) return segments[at + 1]!;
  }
  return null;
}

/** Shared with `workerMilestones`: paths the adapter actually recorded. */
function uniquePaths(run: readonly NormalizedEvent[]): string[] {
  const seen: string[] = [];
  for (const event of run) {
    const input = event.detail?.['input'];
    const path =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)['file_path'] ??
          (input as Record<string, unknown>)['path']
        : undefined;
    if (typeof path === 'string' && path && !seen.includes(path)) seen.push(path);
  }
  return seen;
}

function bound(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}
