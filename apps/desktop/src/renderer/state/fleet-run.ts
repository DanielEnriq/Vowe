import type { FleetLayout, FleetPoint, FleetRect } from '@vowe/core';
import {
  FLEET_CLUSTER_INSET,
  FLEET_GAP,
  FLEET_NODE_HEIGHT,
  FLEET_NODE_WIDTH,
  addNode,
  addWire,
  clusterRect,
  createCluster,
  layoutBounds,
  nodeById,
  nodeRect,
  placeInFreeSpace,
} from '@vowe/core/fleet-model';

import { clusterChip } from './fleet-canvas.js';

/**
 * Running agents from the sheet: what will be launched, and where the new
 * nodes go once their sessions exist. Pure — the sheet launches, then hands
 * the session ids it got back to `applyRun`.
 */

export type RunMode = 'parallel' | 'single';

export const PARALLEL_COUNTS = [2, 3, 5] as const;
export type ParallelCount = (typeof PARALLEL_COUNTS)[number];

export interface RunPlan {
  task: string;
  mode: RunMode;
  /** Sessions to launch: 1 for a single agent. */
  count: number;
  provider: string;
  folder: string;
  /** The captain node each new agent is wired to, or null for none. */
  captainId: string | null;
}

export interface RunChoices {
  task: string;
  mode: RunMode;
  parallelCount: ParallelCount;
  provider: string;
  folder: string;
  captainId: string | null;
}

/** The plan the sheet's choices describe, or null when it cannot run yet. */
export function buildRunPlan(choices: RunChoices): RunPlan | null {
  const task = choices.task.trim();
  if (!task || !choices.folder || !choices.provider) return null;
  return {
    task,
    mode: choices.mode,
    count: choices.mode === 'single' ? 1 : choices.parallelCount,
    provider: choices.provider,
    folder: choices.folder,
    captainId: choices.captainId,
  };
}

export function runButtonLabel(mode: RunMode, parallelCount: ParallelCount): string {
  return `Run ${mode === 'single' ? 1 : parallelCount}`;
}

/**
 * Providers offered in the sheet: those that can launch here, or Claude Code
 * alone when the main process has not said.
 */
export function runProviders(launchCapable: readonly string[] | null | undefined): string[] {
  return launchCapable && launchCapable.length ? [...launchCapable] : ['claude-code'];
}

/**
 * Where `count` new nodes go, side by side in one row, without touching
 * anything. For a row that will be boxed, the room is checked with the box's
 * inset around it so the label chip does not land on a neighbour. The row
 * starts where `placeInFreeSpace` would put one node near `near`; if the row
 * does not fit there, it goes below everything, which is always free.
 */
export function placeRow(layout: FleetLayout, count: number, near?: FleetPoint, boxed = count > 1): FleetPoint[] {
  if (count <= 0) return [];
  const step = FLEET_NODE_WIDTH + FLEET_GAP;
  const row = (origin: FleetPoint) => Array.from({ length: count }, (_, index) => ({ x: origin.x + index * step, y: origin.y }));
  const first = placeInFreeSpace(layout, near);
  if (rowFits(layout, first, count, boxed)) return row(first);
  const bounds = layoutBounds(layout);
  if (!bounds) return row({ x: 0, y: 0 });
  const top = bounds.y + bounds.h + FLEET_GAP + (boxed ? FLEET_CLUSTER_INSET.top : 0);
  return row({ x: Math.round(near?.x ?? bounds.x), y: Math.round(top) });
}

function rowFits(layout: FleetLayout, origin: FleetPoint, count: number, boxed: boolean): boolean {
  const inset = boxed ? FLEET_CLUSTER_INSET : { top: 0, right: 0, bottom: 0, left: 0 };
  const width = count * FLEET_NODE_WIDTH + (count - 1) * FLEET_GAP;
  const mine: FleetRect = {
    x: origin.x - inset.left - FLEET_GAP,
    y: origin.y - inset.top - FLEET_GAP,
    w: width + inset.left + inset.right + FLEET_GAP * 2,
    h: FLEET_NODE_HEIGHT + inset.top + inset.bottom + FLEET_GAP * 2,
  };
  const obstacles = [
    ...layout.nodes.map(nodeRect),
    ...layout.clusters.map((cluster) => clusterRect(cluster, layout.nodes)).filter((rect): rect is FleetRect => rect !== null),
  ];
  return !obstacles.some((rect) => mine.x < rect.x + rect.w && rect.x < mine.x + mine.w && mine.y < rect.y + rect.h && rect.y < mine.y + mine.h);
}

/**
 * The launched sessions on the canvas: one row near `near`, boxed as parallel
 * attempts when there are two or more of them, each wired to the chosen
 * captain. A session the canvas already holds keeps its node and place.
 */
export function applyRun(
  layout: FleetLayout,
  plan: Pick<RunPlan, 'task' | 'mode' | 'captainId'>,
  sessionIds: readonly string[],
  near?: FleetPoint,
): { layout: FleetLayout; nodeIds: string[] } {
  const fresh = [...new Set(sessionIds)];
  if (fresh.length === 0) return { layout, nodeIds: [] };
  const boxed = plan.mode === 'parallel' && fresh.length > 1;
  const spots = placeRow(layout, fresh.length, near, boxed);
  let next = layout;
  const nodeIds: string[] = [];
  fresh.forEach((sessionId, index) => {
    const added = addNode(next, { sessionId, ...spots[index]! });
    next = added.layout;
    if (added.node) nodeIds.push(added.node.id);
  });
  if (boxed) next = createCluster(next, nodeIds, plan.task, clusterChip(nodeIds.length)).layout;
  const captain = plan.captainId ? nodeById(next, plan.captainId) : null;
  if (captain?.role === 'captain') {
    for (const nodeId of nodeIds) next = addWire(next, captain.id, nodeId);
  }
  return { layout: next, nodeIds };
}

/** `Started 2 of 3. <why>`, or null when every launch started. */
export function launchFailureText(started: number, asked: number, reason: string | null): string | null {
  if (started >= asked) return null;
  const why = reason ? ` ${reason}` : '';
  return started === 0 ? `Nothing started.${why}` : `Started ${started} of ${asked}.${why}`;
}
