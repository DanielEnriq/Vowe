import type { AgentSession, FleetLayout, FleetStatus, Project } from '@vowe/core';

/** What every fleet view below the band is handed. */
export interface FleetViewProps {
  project: Project;
  /** Sessions of this project. */
  sessions: AgentSession[];
  /** The current canvas layout. */
  layout: FleetLayout;
  statuses: Record<string, FleetStatus>;
  /** Navigate to `{ kind: 'session', sessionId }`. */
  onOpenSession(sessionId: string): void;
}

export type FleetTab = 'canvas' | 'panes' | 'compare' | 'questions';
