import type { AgentSession, Project } from '@vowe/core';

import type { FleetTab } from '../fleet/types.js';

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
  /** Studio: a project's designs. Without a `designId`, the most recent one. */
  | { kind: 'project'; projectId: string; view: 'studio'; designId?: string }
  | { kind: 'session'; sessionId: string }
  /** Your Vowe: how Vowe looks, sounds and talks. Presence Studio in code. */
  | { kind: 'presence' }
  | { kind: 'none' }
  /** Fleet, before a project is chosen. */
  | { kind: 'fleet-home' }
  /** A project's fleet: the canvas, or one of its other views. Without a `tab`, the canvas. */
  | { kind: 'fleet'; projectId: string; tab?: FleetTab }
  /** One of a fleet's agents, in Fleet's own view of it. */
  | { kind: 'fleet-agent'; projectId: string; sessionId: string };

export const FLEET_TABS: readonly FleetTab[] = ['overview', 'canvas', 'panes', 'compare', 'questions'];

/** The fleet's tab a route shows: the canvas unless it names another. */
export function fleetTabOf(route: Route): FleetTab {
  return route.kind === 'fleet' && route.tab && FLEET_TABS.includes(route.tab) ? route.tab : 'canvas';
}

export function fleetRoute(projectId: string, tab?: FleetTab): Route {
  return tab && tab !== 'canvas' ? { kind: 'fleet', projectId, tab } : { kind: 'fleet', projectId };
}

export function fleetAgentRoute(projectId: string, sessionId: string): Route {
  return { kind: 'fleet-agent', projectId, sessionId };
}

/**
 * Every way out of a fleet screen, as routes that stay in Fleet. Nothing here
 * leads to a Vowe session room, Ask or conversation.
 */
export function fleetHandlers(projectId: string, navigate: (route: Route) => void) {
  return {
    onOpenSession: (sessionId: string) => navigate(fleetAgentRoute(projectId, sessionId)),
    onOpenAgent: (sessionId: string) => navigate(fleetAgentRoute(projectId, sessionId)),
    onTab: (tab: FleetTab) => navigate(fleetRoute(projectId, tab)),
    onCompare: () => navigate(fleetRoute(projectId, 'compare')),
    onBack: () => navigate(fleetRoute(projectId)),
  };
}

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
    case 'fleet': {
      if (!context.projects.some((candidate) => candidate.id === route.projectId)) return { kind: 'fleet-home' };
      // A tab that is not one of the fleet's is the canvas.
      if (route.tab !== undefined && !FLEET_TABS.includes(route.tab)) return fleetRoute(route.projectId);
      return route;
    }
    case 'fleet-agent': {
      if (!context.projects.some((candidate) => candidate.id === route.projectId)) return { kind: 'fleet-home' };
      const session = context.sessions.find((candidate) => candidate.id === route.sessionId);
      return session && session.projectId === route.projectId ? route : fleetRoute(route.projectId);
    }
    default:
      return route;
  }
}

/** Which project a route is "in", for keeping the sidebar's expansion honest. */
export function projectOf(route: Route, context: NavigationContext): string | null {
  if (route.kind === 'project' || route.kind === 'fleet' || route.kind === 'fleet-agent') return route.projectId;
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
