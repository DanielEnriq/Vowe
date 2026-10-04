import { executablePart } from '../product/shell.js';
import { testCounts } from '../product/worker-milestones.js';
import type { NormalizedEvent } from '../types/events.js';
import type { CaptainExchange } from './types.js';

/**
 * What counts as a typecheck, beside `TEST_COMMAND`: the checker itself, or a
 * package script named for it.
 */
export const TYPECHECK_COMMAND =
  /\b(?:tsc|vue-tsc|svelte-check|mypy|pyright)\b|\b(?:npm|pnpm|yarn|bun)\b[^;&|\n]*?\b(?:typecheck|type-check|check-types)\b/;

/** Matched against what the line runs, never against what it writes. */
export function isTypecheckCommand(command: string): boolean {
  return TYPECHECK_COMMAND.test(executablePart(command));
}

/** Errors a checker reported, or `null` where its output does not say. */
export function typecheckErrors(output: string): number | null {
  const found = /Found (\d+) errors?/i.exec(output);
  if (found?.[1]) return Number.parseInt(found[1], 10);
  const tsErrors = output.match(/\berror TS\d+:/g);
  if (tsErrors) return tsErrors.length;
  const summary = /(\d+) errors?\b/i.exec(output);
  return summary?.[1] ? Number.parseInt(summary[1], 10) : null;
}

export interface TestTally {
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  /** The run itself exited cleanly. */
  ok: boolean;
}

export type TypecheckTally = 'clean' | { errors: number | null };

/**
 * Exported declarations that appeared, disappeared or were rewritten in the
 * changed files. A heuristic over `export` lines in a patch: a signature that
 * changes below its first line is not seen.
 */
export interface PublicApiDelta {
  basis: 'exported-declarations';
  added: number;
  removed: number;
  changed: number;
  names: string[];
}

export interface DiffTally {
  files: number;
  added: number;
  removed: number;
}

/**
 * `own-folder`: the diff is this session's alone. `shared-folder`: another
 * session works in the same folder, so the folder's diff cannot be attributed
 * and `diff`/`publicApi` are null; `touchedFiles` is still this session's own.
 * `unavailable`: no diff could be taken.
 */
export type DiffAttribution = 'own-folder' | 'shared-folder' | 'unavailable';

export interface AttemptSummary {
  sessionId: string;
  tests: TestTally | null;
  typecheck: TypecheckTally | null;
  publicApi: 'unchanged' | PublicApiDelta | null;
  diff: DiffTally | null;
  diffAttribution: DiffAttribution;
  /** Files this session's own write events named. */
  touchedFiles: string[];
  /** Model steps: records that carried a message or started a tool. */
  turns: number;
  elapsedMs: number;
  askedCaptain: number;
  askedYou: number;
}

export interface AttemptInput {
  sessionId: string;
  events: readonly NormalizedEvent[];
  exchanges: readonly CaptainExchange[];
  diff?: DiffTally | null;
  publicApi?: 'unchanged' | PublicApiDelta | null;
  diffAttribution?: DiffAttribution;
}

/** One attempt, from its own events and exchanges plus whatever diff was attributable. */
export function attemptSummaryOf(input: AttemptInput): AttemptSummary {
  const { sessionId, events } = input;
  const exchanges = input.exchanges.filter((exchange) => exchange.askerSessionId === sessionId);
  const attribution = input.diffAttribution ?? 'unavailable';
  const own = attribution === 'own-folder';
  return {
    sessionId,
    tests: testsOf(events),
    typecheck: typecheckOf(events),
    publicApi: own ? (input.publicApi ?? null) : null,
    diff: own ? (input.diff ?? null) : null,
    diffAttribution: attribution,
    touchedFiles: touchedFiles(events),
    turns: turnsOf(events),
    elapsedMs: elapsedOf(events),
    askedCaptain: exchanges.filter((exchange) => exchange.captainSessionId !== null).length,
    askedYou: exchanges.filter((exchange) => exchange.route === 'you').length,
  };
}

/** Paths named by the session's own file writes, in first-touched order. */
export function touchedFiles(events: readonly NormalizedEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'file_changed') continue;
    const input = event.detail?.['input'];
    const path =
      typeof input === 'object' && input !== null ? (input as { file_path?: unknown }).file_path : undefined;
    if (typeof path === 'string' && path) seen.add(path);
  }
  return [...seen];
}

/** The latest test run's tally. */
function testsOf(events: readonly NormalizedEvent[]): TestTally | null {
  const run = lastOf(events, (event) => event.kind === 'test_finished');
  if (!run) return null;
  const output = outputOf(run);
  const { passed, failed } = testCounts(output);
  const skipped = /(\d+)\s+(?:tests?\s+)?skipped/i.exec(output);
  return {
    passed,
    failed,
    skipped: skipped?.[1] ? Number.parseInt(skipped[1], 10) : null,
    ok: run.detail?.['failed'] !== true,
  };
}

/** The latest typecheck's result: its finish, matched to a typecheck start. */
function typecheckOf(events: readonly NormalizedEvent[]): TypecheckTally | null {
  const checks = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'command_started' && event.kind !== 'test_started') continue;
    const input = event.detail?.['input'];
    const command =
      typeof input === 'object' && input !== null ? (input as { command?: unknown }).command : undefined;
    const id = event.detail?.['toolUseId'];
    if (typeof command === 'string' && typeof id === 'string' && isTypecheckCommand(command)) checks.add(id);
  }
  const run = lastOf(
    events,
    (event) =>
      (event.kind === 'command_finished' || event.kind === 'test_finished') &&
      checks.has(String(event.detail?.['toolUseId'])),
  );
  if (!run) return null;
  const errors = typecheckErrors(outputOf(run));
  if (run.detail?.['failed'] !== true && !errors) return 'clean';
  return { errors };
}

function turnsOf(events: readonly NormalizedEvent[]): number {
  const records = new Set<string>();
  for (const event of events) {
    const steps = event.kind === 'agent_message' || (event.detail !== undefined && 'input' in event.detail);
    if (steps) records.add(`${event.rawRef.source}:${event.rawRef.line}`);
  }
  return records.size;
}

function elapsedOf(events: readonly NormalizedEvent[]): number {
  let first = Infinity;
  let last = -Infinity;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    if (at < first) first = at;
    if (at > last) last = at;
  }
  return last > first ? last - first : 0;
}

function lastOf(
  events: readonly NormalizedEvent[],
  match: (event: NormalizedEvent) => boolean,
): NormalizedEvent | null {
  for (let at = events.length - 1; at >= 0; at--) if (match(events[at]!)) return events[at]!;
  return null;
}

function outputOf(event: NormalizedEvent): string {
  const output = event.detail?.['output'];
  return typeof output === 'string' ? output : '';
}

const EXPORTED =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/;

/**
 * The exported declarations a unified diff adds, removes or rewrites.
 *
 * Reads only `+`/`-` lines that begin an export. A name on both sides with
 * different text is changed; on one side only, added or removed. Identical
 * lines on both sides (a moved declaration) are not a change.
 */
export function publicApiDelta(patch: string): 'unchanged' | PublicApiDelta {
  const added = new Map<string, string>();
  const removed = new Map<string, string>();
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const side = line[0] === '+' ? added : line[0] === '-' ? removed : null;
    if (!side) continue;
    const body = line.slice(1).trim();
    for (const name of exportedNames(body)) side.set(name, body);
  }
  const names = new Set([...added.keys(), ...removed.keys()]);
  let a = 0;
  let r = 0;
  let c = 0;
  const touched: string[] = [];
  for (const name of names) {
    const before = removed.get(name);
    const after = added.get(name);
    if (before !== undefined && after !== undefined) {
      if (before === after) continue;
      c++;
    } else if (after !== undefined) a++;
    else r++;
    touched.push(name);
  }
  if (!touched.length) return 'unchanged';
  return { basis: 'exported-declarations', added: a, removed: r, changed: c, names: touched.sort() };
}

function exportedNames(line: string): string[] {
  const declared = EXPORTED.exec(line);
  if (declared?.[1]) return [declared[1]];
  const list = EXPORT_LIST.exec(line);
  if (!list?.[1]) return [];
  return list[1]
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, '').trim() ?? '')
    .filter(Boolean);
}
