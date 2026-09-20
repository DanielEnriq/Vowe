import type { ReactElement } from 'react';

import type { AgentSession, Project, SessionStatus } from '@vowe/core';

/* Small stroke icons, drawn in currentColor. */

export function PlusIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function EyeIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

export function RefreshIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.5-3.55" />
      <path d="M13 2.5V5h-2.5" />
    </svg>
  );
}

export function PanelIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
    </svg>
  );
}

export function CloseIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function MicIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <rect x="6" y="2" width="4" height="7" rx="2" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2" />
    </svg>
  );
}

export function MicOffIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <path d="M2 2l12 12" />
      <path d="M6 3.2A2 2 0 0 1 10 4v3M10 9.5A2 2 0 0 1 6 9V6" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 6.8 3.9M12.5 7.5v.4M8 12v2" />
    </svg>
  );
}

export function CheckIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/* Labels. Provider-independent: unknown providers fall back to their id. */

const PROVIDER_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
};

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

export function statusLabel(status: SessionStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function isLive(session: AgentSession): boolean {
  return (
    session.status === 'working' ||
    session.status === 'waiting' ||
    session.status === 'starting'
  );
}

export function originLabel(session: AgentSession): string {
  switch (session.attachMode) {
    case 'managed':
      return 'Started from Vowe';
    case 'external-live':
      return 'Running outside Vowe';
    case 'external-idle':
      return 'Not running · can be resumed';
  }
}

/** Why the control channel is closed for this session, in one line. */
export function whyNoControl(session: AgentSession): string {
  if (session.attachMode === 'external-live') {
    return 'Observe only · this session runs in a terminal Vowe doesn’t own';
  }
  if (session.status === 'finished') return 'Observe only · this session has finished';
  return 'This session can’t receive instructions right now';
}

export function formatClock(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatAgo(at: string, now: number = Date.now()): string {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return at;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString();
}

export function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  // Electron prefixes IPC errors with the handler path; keep the useful half.
  const marker = 'Error: ';
  const index = raw.lastIndexOf(marker);
  return index === -1 ? raw : raw.slice(index + marker.length);
}

export function ChevronIcon({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 120ms ease',
      }}
    >
      <path d="M4.5 2.5L8 6l-3.5 3.5" />
    </svg>
  );
}

/* Projects. Grouping happens here, from data the renderer already holds. */

export interface ProjectGroup {
  project: Project;
  /** Still doing something, most recent first. */
  working: AgentSession[];
  /** Finished or idle, most recent first. */
  recent: AgentSession[];
  lastActivityAt: number;
}

/**
 * Group sessions under the repositories they belong to.
 *
 * Deterministic and cheap: no model, no derived state to keep in sync, just a
 * pass over the sessions the renderer was already given. Sessions Vowe could
 * not place come back separately rather than being dropped.
 */
export function groupByProject(
  projects: Project[],
  sessions: AgentSession[],
): { groups: ProjectGroup[]; unplaced: AgentSession[] } {
  const byRecent = [...sessions].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );

  const groups = new Map<string, ProjectGroup>();
  for (const project of projects) {
    groups.set(project.id, {
      project,
      working: [],
      recent: [],
      lastActivityAt: 0,
    });
  }

  const unplaced: AgentSession[] = [];
  for (const session of byRecent) {
    const group = session.projectId ? groups.get(session.projectId) : undefined;
    if (!group) {
      unplaced.push(session);
      continue;
    }
    (isLive(session) ? group.working : group.recent).push(session);
    group.lastActivityAt = Math.max(
      group.lastActivityAt,
      Date.parse(session.lastActivityAt) || 0,
    );
  }

  // A project with no sessions at all is history, not workspace: keep it out of
  // the sidebar rather than showing an empty row forever.
  const populated = [...groups.values()].filter(
    (group) => group.working.length + group.recent.length > 0,
  );

  // Most recently active first, so whatever is happening now is at the top.
  populated.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { groups: populated, unplaced };
}

/** The one-line summary a project row and the Project Room both show. */
export function describeActivity(group: ProjectGroup): string {
  const parts: string[] = [];
  if (group.working.length) {
    parts.push(
      `${group.working.length} agent${group.working.length === 1 ? '' : 's'} working`,
    );
  }
  if (group.recent.length) {
    parts.push(`${group.recent.length} completed recently`);
  }
  return parts.join(' · ') || 'No sessions yet';
}

/** `/Users/me/projects/Vowe` → `~/projects/Vowe`. Metadata, so keep it short. */
export function tildePath(absolute: string): string {
  return absolute.replace(/^(?:\/Users|\/home)\/[^/]+/, '~');
}
