import type { AgentSession, Project } from '@vowe/core';

/**
 * Where the developer is.
 *
 * Three rooms and nothing else. A discriminated union rather than a router
 * because there are no URLs here and nothing to deep-link: this is a desktop
 * window whose whole navigation model is "which of three things am I looking
 * at, and which one of them".
 */
export type Route =
  | { kind: 'project'; projectId: string; view?: 'home' | 'conversation'; entryId?: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'studio' }
  | { kind: 'none' };

export interface NavigationContext {
  projects: readonly Project[];
  sessions: readonly AgentSession[];
}

/**
 * Keep a route pointing at something that still exists.
 *
 * Sessions finish and disappear from discovery while their room is open. Left
 * alone that renders an empty screen; instead the room falls back to the
 * session's project, which is the thing the developer was actually working in.
 */
export function reconcileRoute(route: Route, context: NavigationContext): Route {
  switch (route.kind) {
    case 'session': {
      const session = context.sessions.find((candidate) => candidate.id === route.sessionId);
      if (session) return route;
      return { kind: 'none' };
    }
    case 'project': {
      const project = context.projects.find((candidate) => candidate.id === route.projectId);
      return project ? route : { kind: 'none' };
    }
    default:
      return route;
  }
}

/** Which project a route is "in", for keeping the sidebar's expansion honest. */
export function projectOf(route: Route, context: NavigationContext): string | null {
  if (route.kind === 'project') return route.projectId;
  if (route.kind === 'session') {
    return (
      context.sessions.find((session) => session.id === route.sessionId)?.projectId ?? null
    );
  }
  return null;
}

export function isActiveSession(session: AgentSession): boolean {
  return (
    session.status === 'working' ||
    session.status === 'waiting' ||
    session.status === 'starting'
  );
}

/**
 * A project's sessions, the way the sidebar shows them: live work first, then
 * the rest, each group newest first.
 */
export function sessionsForProject(
  projectId: string,
  sessions: readonly AgentSession[],
): AgentSession[] {
  return sessions
    .filter((session) => session.projectId === projectId)
    .sort((a, b) => {
      const activity = Number(isActiveSession(b)) - Number(isActiveSession(a));
      if (activity !== 0) return activity;
      return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
    });
}

/** The badge beside a project. Live work, not everything ever run. */
export function activeCount(
  projectId: string,
  sessions: readonly AgentSession[],
): number {
  return sessions.filter(
    (session) => session.projectId === projectId && (session.status === 'working' || session.status === 'starting'),
  ).length;
}
