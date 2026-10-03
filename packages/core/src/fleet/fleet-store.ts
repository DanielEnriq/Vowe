import type { FleetLayout, FleetLayoutChange } from './fleet-model.js';

/**
 * Where a project's fleet canvas is kept. One layout per project, replaced
 * whole on each save: it is the canvas as the developer left it, not history.
 */
export interface FleetLayoutStore {
  /** Empty when nothing was saved; unreadable JSON reads as empty, never throws. */
  getFleetLayout(projectId: string): FleetLayout;
  /** Normalised, written in one transaction, then announced. Returns what was stored. */
  saveFleetLayout(projectId: string, layout: FleetLayout): Promise<FleetLayout>;
  /** After commit: a re-read in the listener sees the new layout. */
  onFleetLayoutChanged(listener: (change: FleetLayoutChange) => void): () => void;
}
