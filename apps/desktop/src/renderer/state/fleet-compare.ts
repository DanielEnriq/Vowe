import type { AgentSession, AttemptSummary, FleetLayout, FleetStatus } from '@vowe/core';
import { captainOf } from '@vowe/core/fleet-model';

import { formatElapsed, type FleetMember } from './fleet-views.js';

/**
 * Compare: only parallel attempts — the members of one canvas cluster, same
 * brief — are set side by side. Everyone else is a separate task, listed with
 * nothing to compare it to.
 */

export interface AttemptGroup {
  clusterId: string;
  label: string;
  brief: string;
  members: FleetMember[];
}

export interface CompareGroups {
  parallel: AttemptGroup[];
  separate: FleetMember[];
}

const STATUS_RANK: Record<FleetStatus, number> = { 'needs-you': 0, running: 1, failed: 2, done: 3, idle: 4 };

/**
 * Clusters in canvas order with members in the order they joined; then every
 * agent in no cluster, the ones that need you first. Captains are never
 * compared.
 */
export function compareGroups(
  layout: FleetLayout,
  members: readonly FleetMember[],
  statuses: Readonly<Record<string, FleetStatus>>,
): CompareGroups {
  const byNode = new Map(members.filter((m) => m.nodeId).map((m) => [m.nodeId!, m]));
  const clustered = new Set<string>();
  const parallel = layout.clusters.map((cluster) => {
    cluster.memberIds.forEach((id) => clustered.add(id));
    return {
      clusterId: cluster.id,
      label: cluster.label,
      brief: cluster.brief,
      members: cluster.memberIds.map((id) => byNode.get(id)).filter((m): m is FleetMember => m !== undefined),
    };
  });
  const rank = (member: FleetMember) =>
    member.sessionId ? STATUS_RANK[statuses[member.sessionId] ?? 'idle'] : STATUS_RANK.idle + 1;
  const separate = members
    .filter((member) => member.role === 'agent' && !(member.nodeId && clustered.has(member.nodeId)))
    .map((member, index) => ({ member, index }))
    .sort((a, b) => rank(a.member) - rank(b.member) || a.index - b.index)
    .map(({ member }) => member);
  return { parallel, separate };
}

/** Whether this agent may ask a captain, per the canvas wires. */
export function isWired(layout: FleetLayout, member: FleetMember): boolean {
  return member.nodeId !== null && captainOf(layout, member.nodeId) !== null;
}

/** `ink` neutral, `quiet` absent or off. */
export type CellTone = 'ink' | 'quiet' | 'ask' | 'good' | 'warn' | 'bad';

export interface Cell {
  text: string;
  tone: CellTone;
}

export interface AttemptColumn {
  badge: Cell | null;
  /** `3 files`, or the files touched when the folder is shared. */
  files: string;
  added: number | null;
  removed: number | null;
  /** Set when the folder is shared and the diff cannot be attributed. */
  shared: boolean;
  touchedFiles: string[];
  tests: Cell;
  typecheck: Cell;
  publicApi: Cell;
  turns: Cell;
  asked: Cell;
}

const NONE: Cell = { text: '—', tone: 'quiet' };

/** One attempt's column, from its summary. `null` summary is still loading. */
export function attemptColumn(summary: AttemptSummary | null, wired: boolean): AttemptColumn {
  if (!summary) {
    return {
      badge: null,
      files: '—',
      added: null,
      removed: null,
      shared: false,
      touchedFiles: [],
      tests: NONE,
      typecheck: NONE,
      publicApi: NONE,
      turns: NONE,
      asked: wired ? { text: '0 · you 0', tone: 'ask' } : { text: 'off · you 0', tone: 'quiet' },
    };
  }
  const shared = summary.diffAttribution === 'shared-folder';
  const diff = summary.diff;
  const fileCount = diff && !shared ? diff.files : summary.touchedFiles.length;
  return {
    badge: testBadge(summary),
    files: `${fileCount} file${fileCount === 1 ? '' : 's'}`,
    added: diff && !shared ? diff.added : null,
    removed: diff && !shared ? diff.removed : null,
    shared,
    touchedFiles: summary.touchedFiles,
    tests: testsCell(summary),
    typecheck: typecheckCell(summary),
    publicApi: publicApiCell(summary),
    turns: { text: `${summary.turns} · ${formatElapsed(summary.elapsedMs)}`, tone: 'ink' },
    asked: wired
      ? { text: `${summary.askedCaptain} · you ${summary.askedYou}`, tone: 'ask' }
      : { text: `off · you ${summary.askedYou}`, tone: 'quiet' },
  };
}

function testBadge({ tests }: AttemptSummary): Cell | null {
  if (!tests) return null;
  if (tests.failed) return { text: `${tests.failed} failing`, tone: 'bad' };
  if (!tests.ok) return { text: 'Tests failing', tone: 'bad' };
  if (tests.skipped) return { text: `${tests.skipped} skipped`, tone: 'warn' };
  return { text: 'Tests green', tone: 'good' };
}

function testsCell({ tests }: AttemptSummary): Cell {
  if (!tests) return { text: 'not run', tone: 'quiet' };
  const parts: string[] = [];
  if (tests.passed !== null) parts.push(`${tests.passed} passed`);
  if (tests.failed) parts.push(`${tests.failed} failed`);
  if (tests.skipped) parts.push(`${tests.skipped} skipped`);
  if (!parts.length) parts.push(tests.ok ? 'passed' : 'failed');
  const tone: CellTone = tests.failed || !tests.ok ? 'bad' : tests.skipped ? 'warn' : 'good';
  return { text: parts.join(' · '), tone };
}

function typecheckCell({ typecheck }: AttemptSummary): Cell {
  if (!typecheck) return { text: 'not run', tone: 'quiet' };
  if (typecheck === 'clean') return { text: 'clean', tone: 'good' };
  const n = typecheck.errors;
  return { text: n ? `${n} error${n === 1 ? '' : 's'}` : 'failed', tone: 'bad' };
}

function publicApiCell(summary: AttemptSummary): Cell {
  const api = summary.publicApi;
  if (api === 'unchanged') return { text: 'unchanged', tone: 'ink' };
  if (!api) return { text: summary.diffAttribution === 'shared-folder' ? 'shared folder' : '—', tone: 'quiet' };
  const parts: string[] = [];
  if (api.added) parts.push(`${api.added} export${api.added === 1 ? '' : 's'} added`);
  if (api.removed) parts.push(`${api.removed} removed`);
  if (api.changed) parts.push(`${api.changed} changed`);
  return { text: parts.join(' · '), tone: api.removed || api.changed ? 'bad' : 'warn' };
}

/**
 * The quiet line under a separate task's name. The status word sits beside
 * it already, so this says only what the word does not.
 */
export function separateLine(
  member: FleetMember,
  status: FleetStatus | undefined,
  summary: AttemptSummary | null,
): string {
  if (!member.sessionId) return 'not started';
  switch (status) {
    case 'needs-you':
      return 'waiting on your answer';
    case 'running':
      return member.session?.semanticState?.currentActivity || '';
    case 'done': {
      if (!summary) return '';
      const own = summary.diff && summary.diffAttribution === 'own-folder';
      const files = own ? summary.diff!.files : summary.touchedFiles.length;
      return `${files} file${files === 1 ? '' : 's'}`;
    }
    default:
      return '';
  }
}

/** What an attempt did, in a sentence, when the observer has said. */
export function attemptPitch(session: AgentSession | null): string | null {
  const state = session?.semanticState;
  return state?.currentUnderstanding || state?.lastMeaningfulUpdate || null;
}

/** The developer's pick among attempts. Recorded here only; nothing is merged or deleted. */
export type AttemptChoice = 'kept' | 'discarded';

/** Keeping one attempt clears the keep on the others in its group; choosing again undoes. */
export function chooseAttempt(
  choices: Readonly<Record<string, AttemptChoice>>,
  group: readonly string[],
  sessionId: string,
  choice: AttemptChoice,
): Record<string, AttemptChoice> {
  const next = { ...choices };
  if (next[sessionId] === choice) {
    delete next[sessionId];
    return next;
  }
  if (choice === 'kept') {
    for (const id of group) if (next[id] === 'kept') delete next[id];
  }
  next[sessionId] = choice;
  return next;
}
