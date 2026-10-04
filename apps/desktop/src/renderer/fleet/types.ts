import type { AgentSession, FleetLayout, FleetStatus, Project } from '@vowe/core';

/** What the fleet room hands each of its views. */
export interface FleetViewProps {
  project: Project;
  /** The sessions of this project. */
  sessions: AgentSession[];
  /** The current canvas layout. */
  layout: FleetLayout;
  statuses: Record<string, FleetStatus>;
  /** Navigate to the session's room. */
  onOpenSession(sessionId: string): void;
}

export type FleetTab = 'canvas' | 'panes' | 'compare' | 'questions';
