import type { AgentSession, FleetStatus, Project, ProjectBrief, ProjectSessionSummary } from '@vowe/core';

/**
 * What a project's home, its row in the panel and the fleet band say about the
 * work in it.
 *
 * One vocabulary: the main process's `FleetStatus` projection. The brief is
 * only read for which sessions to list, and for a status in the moment before
 * the projection has answered.
 */

/** The tone a status is drawn in. Each one a token, each a different lightness. */
export type StatusTone = 'ask' | 'attention' | 'good' | 'bad' | 'idle';

export const STATUS_TONE: Record<FleetStatus, StatusTone> = {
  running: 'ask',
  'needs-you': 'attention',
  done: 'good',
  failed: 'bad',
  idle: 'idle',
};

/** Always said in words beside the dot. */
export function statusWord(status: FleetStatus): string {
  return status === 'needs-you' ? 'needs you' : status;
}

/**
 * A brief's session as a status, until the projection says otherwise. It can
 * tell neither a failure nor a captain's question apart, so it never says
 * `failed`, and attention reads as needing you.
 */
export function statusFromBrief(session: Pick<ProjectSessionSummary, 'status' | 'needsAttention'>): FleetStatus {
  if (session.needsAttention) return 'needs-you';
  switch (session.status) {
    case 'working':
    case 'starting':
      return 'running';
    case 'finished':
      return 'done';
    default:
      return 'idle';
  }
}

export interface FleetCounts {
  running: number;
  needsYou: number;
  done: number;
  failed: number;
}

/** Counts over `sessionIds` (every key when absent); a session with no status yet is not counted. */
export function fleetCounts(statuses: Readonly<Record<string, FleetStatus>>, sessionIds?: readonly string[]): FleetCounts {
  const counts: FleetCounts = { running: 0, needsYou: 0, done: 0, failed: 0 };
  for (const id of new Set(sessionIds ?? Object.keys(statuses))) {
    const status = statuses[id];
    if (status === 'running') counts.running += 1;
    else if (status === 'needs-you') counts.needsYou += 1;
    else if (status === 'done') counts.done += 1;
    else if (status === 'failed') counts.failed += 1;
  }
  return counts;
}

/** `4 running · 1 needs you · 2 done`, as parts so each can carry its dot. */
export function countParts(counts: FleetCounts): { tone: StatusTone; text: string }[] {
  return [
    { tone: 'ask', text: `${counts.running} running` },
    { tone: 'attention', text: `${counts.needsYou} needs you` },
    { tone: 'good', text: `${counts.done} done` },
  ];
}

export interface FleetRow {
  sessionId: string;
  title: string;
  status: FleetStatus;
  tone: StatusTone;
  word: string;
}

export interface FleetSummary extends Omit<FleetCounts, 'failed'> {
  rows: FleetRow[];
}

/** The sessions a brief lists, live work first. */
export function briefSessionIds(brief: ProjectBrief | null): string[] {
  return brief ? [...new Set([...brief.active, ...brief.recent].map((session) => session.sessionId))] : [];
}

/** The fleet card: counts, then the live work and what finished after it. */
export function fleetSummary(
  brief: ProjectBrief | null,
  statuses: Readonly<Record<string, FleetStatus>> = {},
  limit = 6,
): FleetSummary {
  const sessions = brief ? [...brief.active, ...brief.recent] : [];
  const seen = new Set<string>();
  const rows: FleetRow[] = [];
  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    const status = statuses[session.sessionId] ?? statusFromBrief(session);
    rows.push({ sessionId: session.sessionId, title: session.title, status, tone: STATUS_TONE[status], word: statusWord(status) });
  }
  const count = (status: FleetStatus) => rows.filter((row) => row.status === status).length;
  return {
    running: count('running'),
    needsYou: count('needs-you'),
    done: count('done'),
    rows: rows.filter((row) => row.status !== 'idle').slice(0, limit),
  };
}

/** Electron wraps a handler's rejection; the part worth reading is ours. */
export function ipcMessage(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** The line under a project's name in the panel: `5 agents · 1 folder`, or `idle · 2 folders`. */
export function projectLine(
  project: Pick<Project, 'id' | 'folders'>,
  sessions: readonly AgentSession[],
): string {
  const agents = sessions.filter(
    (session) =>
      session.projectId === project.id &&
      !session.archivedAt &&
      (session.status === 'working' || session.status === 'starting' || session.status === 'waiting'),
  ).length;
  const folders = Math.max(project.folders.length, 1);
  const work = agents > 0 ? `${agents} agent${agents === 1 ? '' : 's'}` : 'idle';
  return `${work} · ${folders} folder${folders === 1 ? '' : 's'}`;
}
