import type { AgentSession, CaptainExchange, FleetStatus, Project, TranscriptItem } from '@vowe/core';
import { folderLabelFor } from '@vowe/core/projections';

import { formatElapsed } from './fleet-views.js';

/**
 * What a fleet agent's view reads from its transcript: rows to draw, how a
 * tool call is shown, when to follow the bottom, and which sends are still
 * only ours.
 *
 * Pure, so each reading can be stated as a test.
 */

type Item<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;
export type ToolItem = Item<'tool'>;
export type QuestionItem = Item<'question'>;
export type TurnItem = Item<'turn'>;

export type Streaming = Record<string, { kind: 'assistant' | 'thinking'; text: string }>;

// ------------------------------------------------------------------- rows

export type ResponsePart =
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | {
      kind: 'thinking';
      key: string;
      text: string;
      redacted: boolean;
      streaming: boolean;
      /** Until the next item began; null while it is still being written. */
      durationMs: number | null;
    }
  | { kind: 'tool'; key: string; item: ToolItem };

export type TranscriptRow =
  | { kind: 'task'; key: string; at: string; text: string }
  | { kind: 'message'; key: string; at: string; origin: 'you' | 'captain' | 'relay'; text: string; pending: boolean }
  /** The agent's own run of text, thinking and tool calls between two other rows. */
  | { kind: 'response'; key: string; at: string; parts: ResponsePart[] }
  | { kind: 'question'; key: string; item: QuestionItem }
  | { kind: 'turn'; key: string; item: TurnItem; number: number }
  | { kind: 'system'; key: string; at: string; text: string };

/** A message sent from this view that the transcript has not shown yet. */
export interface PendingSend {
  id: string;
  text: string;
  at: string;
  /** Matching messages already in the transcript, or already pending, when it was sent. */
  baseline: number;
}

/**
 * The transcript as rows: the agent's consecutive output folded into one
 * response, numbered turns, then streamed text not yet committed, then our
 * own sends still in flight.
 */
export function transcriptRows(
  items: readonly TranscriptItem[],
  streaming: Streaming = {},
  pending: readonly PendingSend[] = [],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let response: Extract<TranscriptRow, { kind: 'response' }> | null = null;
  let turns = 0;
  const known = new Set(items.map((item) => item.id));
  const respond = (key: string, at: string, part: ResponsePart) => {
    if (!response) {
      response = { kind: 'response', key: `r:${key}`, at, parts: [] };
      rows.push(response);
    }
    response.parts.push(part);
  };

  items.forEach((item, index) => {
    switch (item.kind) {
      case 'assistant':
        respond(item.id, item.at, { kind: 'text', key: item.id, text: item.text, streaming: false });
        return;
      case 'thinking':
        respond(item.id, item.at, {
          kind: 'thinking',
          key: item.id,
          text: item.text,
          redacted: item.redacted === true,
          streaming: false,
          durationMs: thinkingDuration(item, items[index + 1]),
        });
        return;
      case 'tool':
        respond(item.id, item.at, { kind: 'tool', key: item.id, item });
        return;
    }
    response = null;
    switch (item.kind) {
      case 'user':
        rows.push(
          item.origin === 'task'
            ? { kind: 'task', key: item.id, at: item.at, text: item.text }
            : { kind: 'message', key: item.id, at: item.at, origin: item.origin, text: item.text, pending: false },
        );
        return;
      case 'question':
        rows.push({ kind: 'question', key: item.id, item });
        return;
      case 'turn':
        turns += 1;
        rows.push({ kind: 'turn', key: item.id, item, number: turns });
        return;
      case 'system':
        rows.push({ kind: 'system', key: item.id, at: item.at, text: item.text });
        return;
    }
  });

  for (const [id, stream] of Object.entries(streaming)) {
    if (known.has(id)) continue;
    const part: ResponsePart =
      stream.kind === 'assistant'
        ? { kind: 'text', key: id, text: stream.text, streaming: true }
        : { kind: 'thinking', key: id, text: stream.text, redacted: false, streaming: true, durationMs: null };
    respond(id, '', part);
  }

  for (const send of settlePending(items, pending)) {
    rows.push({ kind: 'message', key: send.id, at: send.at, origin: 'you', text: send.text, pending: true });
  }
  return rows;
}

function thinkingDuration(item: Item<'thinking'>, next: TranscriptItem | undefined): number | null {
  if (!next) return null;
  const span = Date.parse(next.at) - Date.parse(item.at);
  return Number.isFinite(span) && span >= 0 ? span : null;
}

/** `Thinking · 4s`; `Thinking` alone while it is still being written or has no measure. */
export function thinkingLabel(part: Extract<ResponsePart, { kind: 'thinking' }>): string {
  if (part.redacted) return 'Thinking (redacted)';
  if (part.streaming || part.durationMs === null || part.durationMs < 1000) return 'Thinking';
  return `Thinking · ${formatElapsed(part.durationMs)}`;
}

/** `Turn 9 · 42s · $0.03`, `Turn 3 · failed`, `Turn 4 · interrupted · 6s`. */
export function turnLabel(item: TurnItem, number: number): string {
  const parts = [`Turn ${number}`];
  if (item.state !== 'completed') parts.push(item.state);
  if (typeof item.durationMs === 'number') parts.push(formatElapsed(item.durationMs));
  if (typeof item.costUsd === 'number' && item.costUsd > 0) {
    parts.push(item.costUsd < 0.01 ? '<$0.01' : `$${item.costUsd.toFixed(2)}`);
  }
  return parts.join(' · ');
}

// -------------------------------------------------------------- windowing

/** How many rows a long transcript draws at first, and adds per step back. */
export const ROW_WINDOW = 160;

/** The first row drawn when the last `shown` rows are. */
export function windowStart(total: number, shown: number): number {
  return Math.max(0, total - Math.max(0, shown));
}

// ------------------------------------------------------- following the end

/** Within this many pixels of the bottom counts as at the bottom. */
export const STICK_SLACK = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function atBottom(metrics: ScrollMetrics, slack = STICK_SLACK): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack;
}

export interface FollowState {
  /** Keep the newest row in view as content grows. */
  follow: boolean;
  /** Rows that arrived while not following; the jump pill shows while any are. */
  unseen: number;
}

/** After the person scrolled: following is wherever they left it. */
export function afterScroll(state: FollowState, metrics: ScrollMetrics): FollowState {
  const follow = atBottom(metrics);
  if (follow === state.follow && (!follow || state.unseen === 0)) return state;
  return { follow, unseen: follow ? 0 : state.unseen };
}

/** After the transcript grew by `added` rows (or a row grew, as 0). */
export function afterGrowth(state: FollowState, added: number): FollowState {
  if (state.follow || added <= 0) return state;
  return { follow: false, unseen: state.unseen + added };
}

/** The pill shows whenever the view is not following the end; `unseen` marks it as having news. */
export function showJump(state: FollowState): boolean {
  return !state.follow;
}

// ------------------------------------------------------- optimistic sends

/** Messages in the transcript — not the task — that say this. */
export function sentCount(items: readonly TranscriptItem[], text: string): number {
  const wanted = text.trim();
  let count = 0;
  for (const item of items) if (item.kind === 'user' && item.origin !== 'task' && item.text.trim() === wanted) count += 1;
  return count;
}

export function pendingSend(
  items: readonly TranscriptItem[],
  pending: readonly PendingSend[],
  id: string,
  text: string,
  at: string,
): PendingSend {
  const wanted = text.trim();
  const ahead = pending.filter((send) => send.text.trim() === wanted).length;
  return { id, text: wanted, at, baseline: sentCount(items, wanted) + ahead };
}

/** The sends the transcript has not yet shown, in the order they were sent. */
export function settlePending(items: readonly TranscriptItem[], pending: readonly PendingSend[]): PendingSend[] {
  return pending.filter((send) => sentCount(items, send.text) <= send.baseline);
}

// ------------------------------------------------------------------ tools

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'gap';
  text: string;
}

export type ToolView =
  | { kind: 'bash'; command: string; description: string | null }
  | { kind: 'edit'; path: string | null; lines: DiffLine[]; added: number; removed: number; truncated: boolean }
  | { kind: 'search'; target: string; detail: string | null }
  | { kind: 'generic'; input: string };

/** Lines a tool card's mini diff draws before saying it was cut. */
export const TOOL_DIFF_LINES = 240;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

/** A path as the project names it; relative paths are already the worker's own. */
export function displayPath(project: Pick<Project, 'folders'>, path: string): string {
  return path.startsWith('/') ? folderLabelFor(project, path) : path;
}

export function toolView(item: ToolItem, project: Pick<Project, 'folders'>): ToolView {
  const input = record(item.input);
  if (item.name === 'Bash' && input && typeof input.command === 'string') {
    return { kind: 'bash', command: input.command, description: text(input.description) };
  }
  if (EDIT_TOOLS.has(item.name) && input) {
    const file = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
    const edit = editLines(item.name, input);
    if (edit) return { kind: 'edit', path: file ? displayPath(project, file) : null, ...edit };
  }
  if (SEARCH_TOOLS.has(item.name) && input) {
    const file = text(input.file_path) ?? text(input.path);
    const pattern = text(input.pattern);
    if (pattern) return { kind: 'search', target: pattern, detail: file ? displayPath(project, file) : null };
    if (file) return { kind: 'search', target: displayPath(project, file), detail: readRange(input) };
  }
  return { kind: 'generic', input: json(item.input) };
}

/** `Name · summary`, and the edit's size where there is one. */
export function toolHeadline(
  item: ToolItem,
  view: ToolView,
): { name: string; summary: string; added: number | null; removed: number | null } {
  let summary = item.summary.trim();
  if (view.kind === 'bash') summary = firstLine(view.command);
  else if (view.kind === 'edit' && view.path) summary = view.path;
  else if (view.kind === 'search') summary = view.detail && view.target !== view.detail ? `${view.target} in ${view.detail}` : view.target;
  const edit = view.kind === 'edit' ? view : null;
  return {
    name: item.name,
    summary: summary || item.summary.trim(),
    added: edit && edit.added > 0 ? edit.added : null,
    removed: edit && edit.removed > 0 ? edit.removed : null,
  };
}

function editLines(
  name: string,
  input: Record<string, unknown>,
): { lines: DiffLine[]; added: number; removed: number; truncated: boolean } | null {
  const pairs: Array<[string, string]> = [];
  if (name === 'Write') {
    const content = text(input.content, true);
    if (content === null) return null;
    pairs.push(['', content]);
  } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const entry = record(edit);
      if (!entry) continue;
      pairs.push([text(entry.old_string, true) ?? '', text(entry.new_string, true) ?? '']);
    }
    if (!pairs.length) return null;
  } else if (name === 'NotebookEdit') {
    const source = text(input.new_source, true);
    if (source === null) return null;
    pairs.push(['', source]);
  } else {
    const before = text(input.old_string, true);
    const after = text(input.new_string, true);
    if (before === null && after === null) return null;
    pairs.push([before ?? '', after ?? '']);
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  pairs.forEach(([before, after], index) => {
    if (index > 0) lines.push({ kind: 'gap', text: '' });
    for (const line of replacementLines(before, after)) {
      if (line.kind === 'add') added += 1;
      if (line.kind === 'remove') removed += 1;
      lines.push(line);
    }
  });
  const truncated = lines.length > TOOL_DIFF_LINES;
  return { lines: truncated ? lines.slice(0, TOOL_DIFF_LINES) : lines, added, removed, truncated };
}

/** One replacement as lines: shared head and tail as context, the middle as removed then added. */
export function replacementLines(before: string, after: string): DiffLine[] {
  const old = splitLines(before);
  const next = splitLines(after);
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  return [
    ...old.slice(0, head).map((line): DiffLine => ({ kind: 'context', text: line })),
    ...old.slice(head, old.length - tail).map((line): DiffLine => ({ kind: 'remove', text: line })),
    ...next.slice(head, next.length - tail).map((line): DiffLine => ({ kind: 'add', text: line })),
    ...old.slice(old.length - tail).map((line): DiffLine => ({ kind: 'context', text: line })),
  ];
}

function splitLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function readRange(input: Record<string, unknown>): string | null {
  const offset = typeof input.offset === 'number' ? input.offset : null;
  const limit = typeof input.limit === 'number' ? input.limit : null;
  if (offset === null && limit === null) return null;
  const from = offset ?? 1;
  return limit === null ? `from line ${from}` : `lines ${from}–${from + limit - 1}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== 'string') return null;
  return allowEmpty || value.trim() ? value : null;
}

function firstLine(value: string): string {
  const line = value.trim().split('\n')[0] ?? '';
  return value.trim().includes('\n') ? `${line} …` : line;
}

function json(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------- the diff

export interface PatchFile {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
  lines: Array<{ kind: 'add' | 'remove' | 'context' | 'hunk'; text: string }>;
}

/** A `git diff`, as each file's unified lines and its own counts. */
export function unifiedPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('… diff truncated')) break;
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      file = { path: match?.[1] ?? line.slice(11), added: 0, removed: 0, binary: false, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('@@')) {
      inHunk = true;
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      file.lines.push({ kind: 'hunk', text: hunk ? `@@ ${hunk[1]},${hunk[2] ?? '1'} +${hunk[3]},${hunk[4] ?? '1'}` : line });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('Binary files')) file.binary = true;
      if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (line.startsWith('+')) {
      file.added += 1;
      file.lines.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      file.removed += 1;
      file.lines.push({ kind: 'remove', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'context', text: line.slice(1) });
    }
  }
  return files;
}

export interface TouchedFile {
  /** As the diff names it, repository-relative; or as the project labels a touched path. */
  path: string;
  added: number | null;
  removed: number | null;
  /** In the folder's diff, so its lines can be shown. */
  inDiff: boolean;
}

/**
 * The files this agent wrote, with the folder diff's counts where the diff
 * has the file, then any other file the diff has.
 */
export function touchedFiles(
  project: Pick<Project, 'folders'>,
  touched: readonly string[],
  diff: readonly PatchFile[],
): TouchedFile[] {
  const byPath = new Map(diff.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const out: TouchedFile[] = [];
  for (const path of touched) {
    const label = displayPath(project, path);
    const file = byPath.get(label) ?? diff.find((candidate) => path.endsWith(`/${candidate.path}`)) ?? null;
    const key = file?.path ?? label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file ? { path: file.path, added: file.added, removed: file.removed, inDiff: true } : { path: label, added: null, removed: null, inDiff: false });
  }
  for (const file of diff) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    out.push({ path: file.path, added: file.added, removed: file.removed, inDiff: true });
  }
  return out;
}

// --------------------------------------------------------------- the agent

/** Whether a turn is in flight: text streaming, a tool running, or the status says so. */
export function turnInFlight(
  items: readonly TranscriptItem[],
  streaming: Streaming,
  status: FleetStatus | undefined,
): boolean {
  if (status === 'running') return true;
  if (Object.keys(streaming).length > 0) return true;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === 'turn') return false;
    if (item.kind === 'tool' && item.status === 'running') return status !== 'done' && status !== 'failed' && status !== 'idle';
  }
  return false;
}

/** Turns ended so far, plus the one in flight. */
export function currentTurn(items: readonly TranscriptItem[], inFlight: boolean): number {
  let turns = 0;
  for (const item of items) if (item.kind === 'turn') turns += 1;
  return turns + (inFlight ? 1 : 0);
}

/** From the session's start to now, or to its last activity once it has stopped. */
export function agentElapsed(session: Pick<AgentSession, 'createdAt' | 'lastActivityAt'>, inFlight: boolean, now: number): number {
  const start = Date.parse(session.createdAt);
  const end = inFlight ? now : Date.parse(session.lastActivityAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** Why the composer cannot send, in a few words; null when it can. */
export function composerBlock(session: Pick<AgentSession, 'capabilities' | 'attachMode'>): string | null {
  if (session.capabilities.sendInstruction) return null;
  switch (session.attachMode) {
    case 'external-live':
      return 'Running outside Vowe';
    case 'external-idle':
      return 'Not running';
    default:
      return 'Can’t take instructions now';
  }
}

/** The held exchange this question is, if the relay recorded one. */
export function exchangeFor(
  item: QuestionItem,
  sessionId: string,
  exchanges: readonly CaptainExchange[],
): CaptainExchange | null {
  const mine = exchanges.filter((exchange) => exchange.askerSessionId === sessionId);
  if (item.toolUseId) {
    const byTool = mine.find((exchange) => exchange.toolUseId === item.toolUseId);
    if (byTool) return byTool;
  }
  const question = item.question.trim();
  const byText = mine.filter((exchange) => exchange.question.trim() === question);
  return byText.find((exchange) => exchange.status !== 'answered') ?? byText[0] ?? null;
}

/** The answer a question already has, from the transcript or its exchange. */
export function questionAnswer(item: QuestionItem, exchange: CaptainExchange | null): { text: string; by: 'you' | 'captain' } | null {
  if (item.answer) {
    const byCaptain = exchange?.captainAnswer && exchange.captainAnswer.trim() === item.answer.trim() && !exchange.userAnswer;
    return { text: item.answer, by: byCaptain ? 'captain' : 'you' };
  }
  if (exchange?.status === 'answered') {
    if (exchange.userAnswer) return { text: exchange.userAnswer, by: 'you' };
    if (exchange.captainAnswer) return { text: exchange.captainAnswer, by: 'captain' };
  }
  return null;
}

/** `1 of 3 parallel`, and what the compare button says. */
export function clusterWords(position: number, count: number): { place: string; compare: string } {
  const names = ['', '', 'two', 'three', 'four', 'five', 'six'];
  return {
    place: `${position} of ${count} parallel`,
    compare: count < names.length ? `Compare the ${names[count]}` : `Compare all ${count}`,
  };
}
