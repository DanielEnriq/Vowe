import type { CaptainExchange, NormalizedEvent, Project } from '@vowe/core';
import { folderLabelFor, isTypecheckCommand, testCounts, typecheckErrors } from '@vowe/core/projections';

import type { FleetMember } from './fleet-views.js';

/**
 * Panes: which sessions get a pane, and the compact log each pane shows.
 *
 * The log is read from the session's own events and from the captain
 * exchanges it was part of. Nothing here guesses: a line names a file, a
 * command or a result the trace recorded, or it is not drawn.
 */

export type PaneLayout = '2x2' | '3x2' | 'rows';

export const PANE_LAYOUTS: { value: PaneLayout; label: string }[] = [
  { value: '2x2', label: '2×2' },
  { value: '3x2', label: '3×2' },
  { value: 'rows', label: 'Rows' },
];

/** How many panes a layout holds; rows hold everyone. */
export function paneCapacity(layout: PaneLayout): number {
  return layout === '2x2' ? 4 : layout === '3x2' ? 6 : Number.POSITIVE_INFINITY;
}

/**
 * The members that get a pane, in pane order: captains first, then agents.
 * Agents keep canvas order, or with `followNewest` the most recently active
 * come first, so a new arrival takes a slot. Placeholders have no output and
 * get no pane.
 */
export function paneMembers(
  members: readonly FleetMember[],
  layout: PaneLayout,
  followNewest: boolean,
): FleetMember[] {
  const live = members.filter((member) => member.sessionId !== null);
  const captains = live.filter((member) => member.role === 'captain');
  let agents = live.filter((member) => member.role === 'agent');
  if (followNewest) {
    agents = agents
      .map((member, index) => ({ member, index }))
      .sort((a, b) => activity(b.member) - activity(a.member) || a.index - b.index)
      .map(({ member }) => member);
  }
  const ordered = [...captains, ...agents];
  const capacity = paneCapacity(layout);
  return Number.isFinite(capacity) ? ordered.slice(0, capacity) : ordered;
}

function activity(member: FleetMember): number {
  const at = member.session ? Date.parse(member.session.lastActivityAt) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
}

/**
 * `quiet` older narration, `plain` ordinary work, `prose` the worker's own
 * words, `ask` the captain involved, `attention` waiting on you.
 */
export type PaneLineTone = 'quiet' | 'plain' | 'prose' | 'ask' | 'good' | 'bad' | 'attention';

export interface PaneLine {
  key: string;
  at: string;
  text: string;
  tone: PaneLineTone;
}

export interface PaneLogInput {
  sessionId: string;
  role: FleetMember['role'];
  events: readonly NormalizedEvent[];
  exchanges: readonly CaptainExchange[];
  project: Pick<Project, 'folders'>;
  /** Names for the sessions on the other side of an exchange. */
  labels: ReadonlyMap<string, string>;
  limit?: number;
}

/** The pane's lines, oldest first, the newest `limit` of them. */
export function paneLines(input: PaneLogInput): PaneLine[] {
  const { sessionId, role, project, labels } = input;
  const events = [...input.events].filter((event) => event.sessionId === sessionId).sort((a, b) => a.seq - b.seq);
  const asked = input.exchanges.filter((exchange) => exchange.askerSessionId === sessionId);
  const answering =
    role === 'captain' ? input.exchanges.filter((exchange) => exchange.captainSessionId === sessionId) : [];
  const relayed = new Set(asked.map((exchange) => exchange.toolUseId).filter(Boolean));

  const lines: PaneLine[] = [];
  const commands = new Map<string, string>();
  for (const event of events) {
    const toolUseId = event.detail?.['toolUseId'];
    if (typeof toolUseId === 'string' && relayed.has(toolUseId)) continue;
    const line = eventLine(event, project, commands);
    if (line) lines.push(line);
  }
  for (const exchange of asked) lines.push(...askerLines(exchange));
  for (const exchange of answering) lines.push(...captainLines(exchange, labels));

  lines.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const limit = input.limit ?? 14;
  return lines.slice(-limit);
}

/**
 * One event as one line, or null when it says nothing worth a line.
 *
 * `commands` carries command text from a start to its finish, by tool use
 * id, so a typecheck's result can be read as one.
 */
export function eventLine(
  event: NormalizedEvent,
  project: Pick<Project, 'folders'>,
  commands: Map<string, string> = new Map(),
): PaneLine | null {
  const base = { key: event.id, at: event.at };
  const detail = event.detail ?? {};
  const toolUseId = typeof detail['toolUseId'] === 'string' ? detail['toolUseId'] : null;
  const failed = detail['failed'] === true;
  const output = typeof detail['output'] === 'string' ? detail['output'] : '';

  switch (event.kind) {
    case 'file_changed': {
      const path = inputField(detail, 'file_path');
      // The write's result is a second `file_changed` without input; the start said it.
      if (!path) return failed ? { ...base, text: '✗ write failed', tone: 'bad' } : null;
      const verb = detail['tool'] === 'Write' || /^Wrote\b/.test(event.summary) ? 'Write' : 'Edit';
      return { ...base, text: `· ${verb} ${showPath(project, path)}`, tone: 'plain' };
    }
    case 'command_started':
    case 'test_started': {
      const command = firstLine(inputField(detail, 'command'));
      if (!command) return null;
      if (toolUseId) commands.set(toolUseId, command);
      return { ...base, text: `$ ${command}`, tone: 'plain' };
    }
    case 'test_finished': {
      const { passed, failed: failing } = testCounts(output);
      if (failing || failed) {
        return { ...base, text: failing ? `✗ ${failing} failed` : '✗ tests failed', tone: 'bad' };
      }
      return { ...base, text: passed !== null ? `✓ ${passed} passed` : '✓ tests passed', tone: 'good' };
    }
    case 'command_finished': {
      const command = toolUseId ? commands.get(toolUseId) : undefined;
      if (command && isTypecheckCommand(command)) {
        const errors = typecheckErrors(output);
        if (!failed && !errors) return { ...base, text: '✓ no errors', tone: 'good' };
        return { ...base, text: errors ? `✗ ${errors} error${errors === 1 ? '' : 's'}` : '✗ typecheck failed', tone: 'bad' };
      }
      return failed ? { ...base, text: '✗ command failed', tone: 'bad' } : null;
    }
    case 'tool_started': {
      // A summary naming only the tool (`Used X`) says nothing about the work.
      if (!event.summary || /^Used\s/.test(event.summary)) return null;
      return { ...base, text: `· ${firstLine(event.summary)}`, tone: 'plain' };
    }
    case 'agent_message': {
      const text = firstLine(typeof detail['text'] === 'string' ? detail['text'] : event.summary);
      return text ? { ...base, text, tone: 'prose' } : null;
    }
    case 'user_instruction':
    case 'session_started': {
      const text = firstLine(typeof detail['text'] === 'string' ? detail['text'] : event.summary);
      return text ? { ...base, text: `› ${text}`, tone: 'quiet' } : null;
    }
    case 'session_waiting':
      return detail['awaitingHuman'] === true ? { ...base, text: '? asked you', tone: 'attention' } : null;
    case 'permission_requested':
      return { ...base, text: '? needs permission', tone: 'attention' };
    case 'session_finished':
      return failed ? { ...base, text: '✗ ended with an error', tone: 'bad' } : null;
    default:
      return null;
  }
}

/** A worker's question and what came back, from the asker's side. */
function askerLines(exchange: CaptainExchange): PaneLine[] {
  const lines: PaneLine[] = [];
  const toCaptain = exchange.captainSessionId !== null;
  lines.push({
    key: `${exchange.id}:asked`,
    at: exchange.askedAt,
    text: toCaptain ? '? asked the captain' : '? asked you',
    tone: toCaptain ? 'ask' : 'attention',
  });
  const at = exchange.answeredAt ?? exchange.askedAt;
  if (exchange.status === 'passed') {
    const said = firstLine(exchange.captainAnswer ?? exchange.passedToYouReason ?? '') || 'passed to you';
    lines.push({ key: `${exchange.id}:passed`, at, text: `→ captain: ${said}`, tone: 'quiet' });
  } else if (exchange.status === 'answered' && exchange.route === 'captain' && exchange.captainAnswer) {
    lines.push({ key: `${exchange.id}:answer`, at, text: `→ captain: ${firstLine(exchange.captainAnswer)}`, tone: 'quiet' });
  } else if (exchange.status === 'answered' && exchange.userAnswer) {
    lines.push({ key: `${exchange.id}:answer`, at, text: `→ you: ${firstLine(exchange.userAnswer)}`, tone: 'quiet' });
  }
  return lines;
}

/** The same exchange from the captain's side: ← question, → answer. */
function captainLines(exchange: CaptainExchange, labels: ReadonlyMap<string, string>): PaneLine[] {
  const asker = labels.get(exchange.askerSessionId) ?? 'agent';
  const lines: PaneLine[] = [
    { key: `${exchange.id}:q`, at: exchange.askedAt, text: `← ${asker}: ${firstLine(exchange.question)}`, tone: 'plain' },
  ];
  const at = exchange.answeredAt ?? exchange.askedAt;
  if (exchange.status === 'passed') {
    lines.push({ key: `${exchange.id}:a`, at, text: '→ passed to you', tone: 'attention' });
  } else if (exchange.captainAnswer) {
    lines.push({ key: `${exchange.id}:a`, at, text: `→ ${firstLine(exchange.captainAnswer)}`, tone: 'ask' });
  }
  return lines;
}

/** The captain's footer: `12 answered · 3 wired`. */
export function captainTally(
  captainSessionId: string,
  exchanges: readonly CaptainExchange[],
  wired: number,
): string {
  const answered = exchanges.filter(
    (exchange) => exchange.captainSessionId === captainSessionId && exchange.route === 'captain' && exchange.status === 'answered',
  ).length;
  return `${answered} answered · ${wired} wired`;
}

/** The question a session is waiting on you for, oldest first. */
export function waitingExchange(sessionId: string, exchanges: readonly CaptainExchange[]): CaptainExchange | null {
  const waiting = exchanges
    .filter((exchange) => exchange.askerSessionId === sessionId && exchange.route === 'you' && exchange.status !== 'answered')
    .sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
  return waiting[0] ?? null;
}

/**
 * Merge newly arrived events into a pane's buffer: by id, in seq order, the
 * newest `cap` kept.
 */
export function mergeEvents(
  current: readonly NormalizedEvent[],
  incoming: readonly NormalizedEvent[],
  cap = 200,
): NormalizedEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.seq - b.seq).slice(-cap);
}

function inputField(detail: Record<string, unknown>, field: string): string {
  const input = detail['input'];
  if (typeof input !== 'object' || input === null) return '';
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

function showPath(project: Pick<Project, 'folders'>, path: string): string {
  return path.startsWith('/') ? folderLabelFor(project, path) : path;
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim()) ?? '').trim();
}
