import type { AgentSession, Project, ProjectBrief, ProjectSessionSummary } from '@vowe/core';

/**
 * What a project's home and its row in the panel say about the work in it.
 *
 * Pure, and read from what the main process already projected — the sessions
 * and the brief — so nothing here can disagree with the rooms behind it.
 */

/** The tone a status is drawn in. Each one a token, each a different lightness. */
export type StatusTone = 'ask' | 'attention' | 'good' | 'bad' | 'idle';

export interface FleetStatus {
  tone: StatusTone;
  /** Always said in words beside the dot. */
  word: 'running' | 'needs you' | 'done' | 'failed' | 'idle';
}

export interface FleetRow extends FleetStatus {
  sessionId: string;
  title: string;
}

export interface FleetSummary {
  running: number;
  needsYou: number;
  done: number;
  rows: FleetRow[];
}

/** A session in the brief, as a dot and a word. Needing you outranks running. */
export function fleetStatusOf(session: Pick<ProjectSessionSummary, 'status' | 'needsAttention'>): FleetStatus {
  if (session.needsAttention) return { tone: 'attention', word: 'needs you' };
  switch (session.status) {
    case 'working':
    case 'starting':
      return { tone: 'ask', word: 'running' };
    case 'finished':
      return { tone: 'good', word: 'done' };
    default:
      return { tone: 'idle', word: 'idle' };
  }
}

/** The fleet card: counts, then the live work and what finished after it. */
export function fleetSummary(brief: ProjectBrief | null, limit = 6): FleetSummary {
  const sessions = brief ? [...brief.active, ...brief.recent] : [];
  const rows = sessions.map((session) => ({
    sessionId: session.sessionId,
    title: session.title,
    ...fleetStatusOf(session),
  }));
  const count = (word: FleetStatus['word']) => rows.filter((row) => row.word === word).length;
  return {
    running: count('running'),
    needsYou: count('needs you'),
    done: count('done'),
    rows: rows.filter((row) => row.word !== 'idle').slice(0, limit),
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
