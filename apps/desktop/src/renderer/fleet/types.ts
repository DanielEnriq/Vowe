import type { AgentSession, FleetLayout, FleetStatus, Project } from '@vowe/core';

/** What the fleet room hands each of its views. */
export interface FleetViewProps {
  project: Project;
  /** The sessions of this project. */
  sessions: AgentSession[];
  /** The current canvas layout. */
  layout: FleetLayout;
  statuses: Record<string, FleetStatus>;
  /** Open the agent in Fleet's own view of it. */
  onOpenSession(sessionId: string): void;
}

export type FleetTab = 'overview' | 'canvas' | 'panes' | 'compare' | 'questions';
