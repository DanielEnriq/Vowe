import type { CaptainExchange, FleetLayout, FleetNode, FleetPoint, FleetRect, FleetView, FleetViewport, WireRefusal } from '@vowe/core';
import {
  FLEET_NODE_HEIGHT,
  FLEET_NODE_WIDTH,
  addNode,
  addWire,
  canWire,
  clusterAt,
  clusterOf,
  clusterRect,
  createCluster,
  joinCluster,
  leaveCluster,
  moveNode,
  nodeById,
  nodeRect,
  reconcile,
  removeNode,
  removeWire,
  screenToCanvas,
  wireRoute,
} from '@vowe/core/fleet-model';

/**
 * The fleet canvas's own decisions, apart from drawing it: what a drop means
 * for cluster membership, what the rail's tools do with a pointer, and the
 * small edits the canvas makes to a layout. Pure; the component only routes
 * pointer events in and applies what comes out.
 */

// ------------------------------------------------------------ membership

export type DropDecision =
  | { kind: 'stay' }
  | { kind: 'join'; clusterId: string }
  | { kind: 'leave'; clusterId: string };

/** The centre of a node whose top-left is `at`. */
export function nodeCentre(at: FleetPoint): FleetPoint {
  return { x: at.x + FLEET_NODE_WIDTH / 2, y: at.y + FLEET_NODE_HEIGHT / 2 };
}

/**
 * What dropping a node with its top-left at `at` does to its membership.
 *
 * Read by the node's centre. Its own box is the one it was in when the drag
 * began — the box that was on screen — so a nudge inside it stays. Anywhere
 * else is tested against every other box as drawn without this node, and the
 * last drawn wins. A captain never joins. A box's only member stays in it
 * wherever it goes: the box is drawn around it, so there is nothing to leave.
 */
export function dropDecision(layout: FleetLayout, nodeId: string, at: FleetPoint): DropDecision {
  const node = nodeById(layout, nodeId);
  if (!node || node.role !== 'agent') return { kind: 'stay' };
  const centre = nodeCentre(at);
  const current = clusterOf(layout, nodeId);
  const own = current ? clusterRect(current, layout.nodes) : null;
  if (own && inside(own, centre)) return { kind: 'stay' };
  const target = clusterAt(removeNode(layout, nodeId), centre);
  if (target && target.id !== current?.id) return { kind: 'join', clusterId: target.id };
  if (current && current.memberIds.length > 1) return { kind: 'leave', clusterId: current.id };
  return { kind: 'stay' };
}

function inside(rect: FleetRect, point: FleetPoint): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

/** Move a node exactly where it was dropped, and join or leave a box as the drop says. */
export function dropNode(layout: FleetLayout, nodeId: string, at: FleetPoint): FleetLayout {
  const decision = dropDecision(layout, nodeId, at);
  const moved = moveNode(layout, nodeId, { x: Math.round(at.x), y: Math.round(at.y) });
  if (decision.kind === 'join') return joinCluster(moved, decision.clusterId, nodeId);
  if (decision.kind === 'leave') return leaveCluster(moved, nodeId);
  return moved;
}

/**
 * The layout to draw mid-drag: the node where the pointer has it, and its box
 * held exactly as it was when the drag began rather than stretching after it.
 * `highlight` is the box a release here would leave it in.
 */
export function dragPreview(layout: FleetLayout, nodeId: string, at: FleetPoint): { layout: FleetLayout; highlight: string | null } {
  const decision = dropDecision(layout, nodeId, at);
  const current = clusterOf(layout, nodeId);
  let shown = moveNode(layout, nodeId, at);
  if (current && current.memberIds.length > 1) {
    const held = clusterRect(current, layout.nodes);
    shown = leaveCluster(shown, nodeId);
    if (held) shown = { ...shown, clusters: shown.clusters.map((cluster) => (cluster.id === current.id ? { ...cluster, rect: held } : cluster)) };
  }
  const highlight = decision.kind === 'join' ? decision.clusterId : decision.kind === 'stay' && current ? current.id : null;
  return { layout: shown, highlight };
}

// ----------------------------------------------------------------- wires

const WIRE_REFUSAL_TEXT: Record<WireRefusal, string> = {
  'missing-node': 'Nothing there',
  self: 'Not to itself',
  'not-captain': 'Start at a captain',
  'not-agent': 'End at an agent',
  duplicate: 'Already wired',
  'agent-has-captain': 'Already has a captain',
};

export function wireRefusalText(reason: WireRefusal): string {
  return WIRE_REFUSAL_TEXT[reason];
}

/** Draw a wire, or say in a few words why not. */
export function attemptWire(
  layout: FleetLayout,
  fromId: string,
  toId: string | null,
): { ok: true; layout: FleetLayout } | { ok: false; reason: string } {
  if (toId === null) return { ok: false, reason: wireRefusalText('missing-node') };
  const check = canWire(layout, fromId, toId);
  if (!check.ok) return { ok: false, reason: wireRefusalText(check.reason) };
  return { ok: true, layout: addWire(layout, fromId, toId) };
}

/**
 * The wire whose line passes within `tolerance` canvas units of a point; the
 * last drawn wins. Lines are hit-tested here rather than by the browser so the
 * drawing layer can stay out of the pointer's way.
 */
export function wireAt(layout: FleetLayout, point: FleetPoint, tolerance: number): string | null {
  for (let index = layout.wires.length - 1; index >= 0; index -= 1) {
    const wire = layout.wires[index]!;
    const from = nodeById(layout, wire.captainId);
    const to = nodeById(layout, wire.agentId);
    if (!from || !to) continue;
    const { points } = wireRoute(nodeRect(from), nodeRect(to));
    for (let at = 1; at < points.length; at += 1) {
      if (segmentDistance(point, points[at - 1]!, points[at]!) <= tolerance) return wire.id;
    }
  }
  return null;
}

function segmentDistance(p: FleetPoint, a: FleetPoint, b: FleetPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ------------------------------------------------------------- selection

export interface CanvasSelection {
  nodes: string[];
  wire: string | null;
}

export const NO_SELECTION: CanvasSelection = { nodes: [], wire: null };

/** A click on a node: alone, or added to (and taken from) the selection with shift. */
export function selectNode(selection: CanvasSelection, nodeId: string, additive: boolean): CanvasSelection {
  if (!additive) return selection.nodes.length === 1 && selection.nodes[0] === nodeId && !selection.wire ? selection : { nodes: [nodeId], wire: null };
  return selection.nodes.includes(nodeId)
    ? { nodes: selection.nodes.filter((id) => id !== nodeId), wire: null }
    : { nodes: [...selection.nodes, nodeId], wire: null };
}

/**
 * Take the selection off the canvas: a wire, or nodes with their wires and
 * memberships. Sessions are untouched; `sessions` are the ones whose nodes went,
 * so the canvas can keep from putting them straight back.
 */
export function deleteSelection(layout: FleetLayout, selection: CanvasSelection): { layout: FleetLayout; sessions: string[] } {
  if (selection.wire) return { layout: removeWire(layout, selection.wire), sessions: [] };
  let next = layout;
  const sessions: string[] = [];
  for (const id of selection.nodes) {
    const node = nodeById(next, id);
    if (!node) continue;
    if (node.sessionId) sessions.push(node.sessionId);
    next = removeNode(next, id);
  }
  return { layout: next, sessions };
}

/** Selection minus anything no longer on the canvas. */
export function pruneSelection(layout: FleetLayout, selection: CanvasSelection): CanvasSelection {
  const nodes = selection.nodes.filter((id) => nodeById(layout, id));
  const wire = selection.wire && layout.wires.some((each) => each.id === selection.wire) ? selection.wire : null;
  return nodes.length === selection.nodes.length && wire === selection.wire ? selection : { nodes, wire };
}

// --------------------------------------------------------------- grouping

/** `Parallel · 3`, from whoever is in the box now. */
export function clusterChip(memberCount: number): string {
  return `Parallel · ${memberCount}`;
}

/**
 * The selected agents as parallel attempts. The brief is the first member's
 * prompt. Captains in the selection are skipped; fewer than two agents is not
 * a comparison.
 */
export function groupSelection(
  layout: FleetLayout,
  nodeIds: readonly string[],
  briefOf: (sessionId: string | null) => string,
): { ok: true; layout: FleetLayout; clusterId: string } | { ok: false; reason: string } {
  const agents = nodeIds.filter((id) => nodeById(layout, id)?.role === 'agent');
  if (agents.length < 2) return { ok: false, reason: 'Select two or more agents' };
  const first = nodeById(layout, agents[0]!)!;
  const created = createCluster(layout, agents, briefOf(first.sessionId), clusterChip(agents.length));
  if (!created.cluster) return { ok: false, reason: 'Could not group these' };
  return { ok: true, layout: created.layout, clusterId: created.cluster.id };
}

// ------------------------------------------------------------- placement

/**
 * Put every session that has no node into free space, in the order given,
 * skipping `skip`. Nothing already on the canvas moves; an unchanged layout is
 * returned as the same object.
 */
export function placeUnplaced(layout: FleetLayout, sessionIds: readonly string[], skip: ReadonlySet<string> = new Set()): FleetLayout {
  let next = layout;
  for (const sessionId of reconcile(layout, sessionIds).unplaced) {
    if (skip.has(sessionId)) continue;
    next = addNode(next, { sessionId }).layout;
  }
  return next;
}

/** Where a new node goes so it lands in the middle of what is on screen: its top-left. */
export function spawnPoint(view: FleetView, viewport: FleetViewport): FleetPoint {
  const centre = screenToCanvas(view, { x: viewport.width / 2, y: viewport.height / 2 });
  return { x: Math.round(centre.x - FLEET_NODE_WIDTH / 2), y: Math.round(centre.y - FLEET_NODE_HEIGHT / 2) };
}

/**
 * A captain's session arrived. If the canvas already put it down as an agent
 * (its session showed up before the launch returned), it becomes a captain in
 * place — losing any wire or box an agent could have and a captain cannot.
 */
export function placeCaptain(layout: FleetLayout, sessionId: string, near: FleetPoint): FleetLayout {
  const existing = layout.nodes.find((node) => node.sessionId === sessionId);
  if (existing?.role === 'captain') return layout;
  if (existing) {
    const without = removeNode(layout, existing.id);
    return addNode(without, { id: existing.id, sessionId, x: existing.x, y: existing.y, role: 'captain' }).layout;
  }
  return addNode(layout, { sessionId, role: 'captain' }, near).layout;
}

// ------------------------------------------------------------------ face

/** `Captain`, or `Captain 2` and on when there are several without names; by node id. */
export function captainNames(nodes: readonly FleetNode[]): Map<string, string> {
  const names = new Map<string, string>();
  let n = 0;
  for (const node of nodes) {
    if (node.role !== 'captain') continue;
    n += 1;
    names.set(node.id, node.label ?? (n === 1 ? 'Captain' : `Captain ${n}`));
  }
  return names;
}

/** `12s`, `4m`, `1h 5m`: how long, compactly. */
export function elapsedLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Questions a captain answered for the workers wired to it. */
export function answeredBy(exchanges: readonly CaptainExchange[], captainSessionId: string | null): number {
  if (!captainSessionId) return 0;
  return exchanges.filter(
    (exchange) => exchange.captainSessionId === captainSessionId && exchange.route === 'captain' && exchange.status === 'answered',
  ).length;
}

/** The question a worker is waiting on you for, if any. Newest first in, newest first out. */
export function waitingQuestion(exchanges: readonly CaptainExchange[], sessionId: string | null): CaptainExchange | null {
  if (!sessionId) return null;
  return exchanges.find((exchange) => exchange.askerSessionId === sessionId && exchange.route === 'you' && exchange.status !== 'answered') ?? null;
}

/** Questions waiting on you: route `you`, not yet answered. */
export function needsYouCount(exchanges: readonly CaptainExchange[]): number {
  return exchanges.filter((exchange) => exchange.route === 'you' && exchange.status !== 'answered').length;
}

// ---------------------------------------------------------- the gestures

/**
 * The rail's tools. Spawning, grouping, tidying and zooming are acts, not
 * modes; only drawing a wire changes what a press on the canvas does.
 */
export type CanvasTool = 'select' | 'wire';

export type CanvasGesture =
  | { kind: 'idle' }
  /** Pressed on a node, not yet far enough to be a drag. */
  | { kind: 'press'; nodeId: string; start: FleetPoint; origin: FleetPoint; additive: boolean }
  | { kind: 'drag'; nodeId: string; start: FleetPoint; origin: FleetPoint; at: FleetPoint }
  /** Drawing a wire from a captain; `to` is the pointer in canvas units. */
  | { kind: 'wire'; fromId: string; to: FleetPoint; over: string | null }
  | { kind: 'pan'; start: FleetPoint; view: FleetView; moved: boolean };

export interface CanvasState {
  tool: CanvasTool;
  selection: CanvasSelection;
  gesture: CanvasGesture;
}

export const INITIAL_CANVAS: CanvasState = { tool: 'select', selection: NO_SELECTION, gesture: { kind: 'idle' } };

/** Screen pixels a press travels before it is a drag. */
export const DRAG_THRESHOLD = 4;

export type CanvasInput =
  | { type: 'tool'; tool: CanvasTool }
  | { type: 'escape' }
  /** `screen` is the pointer relative to the viewport; `canvas` the same in canvas units. */
  | { type: 'down-node'; nodeId: string; screen: FleetPoint; canvas: FleetPoint; additive: boolean }
  | { type: 'down-wire'; wireId: string }
  | { type: 'down-empty'; screen: FleetPoint; view: FleetView }
  | { type: 'move'; screen: FleetPoint; canvas: FleetPoint }
  | { type: 'up' }
  | { type: 'cancel' }
  | { type: 'select'; selection: CanvasSelection };

/** What the component has to do after a step. */
export type CanvasEffect =
  | { kind: 'drop'; nodeId: string; at: FleetPoint }
  | { kind: 'wire'; fromId: string; toId: string | null }
  | { kind: 'view'; view: FleetView }
  | { kind: 'refuse'; reason: string };

export interface CanvasStep {
  state: CanvasState;
  effect: CanvasEffect | null;
}

/**
 * One pointer or key event against the canvas. Reads the layout for roles and
 * hit-testing; never changes it — a change comes out as an effect.
 */
export function stepCanvas(state: CanvasState, input: CanvasInput, layout: FleetLayout, view: FleetView): CanvasStep {
  const idle: CanvasGesture = { kind: 'idle' };
  const done = (next: CanvasState, effect: CanvasEffect | null = null): CanvasStep => ({ state: next, effect });
  const g = state.gesture;

  switch (input.type) {
    case 'tool':
      return done({ ...state, tool: input.tool, gesture: idle });

    case 'escape':
      if (g.kind !== 'idle') return done({ ...state, gesture: idle });
      if (state.tool !== 'select') return done({ ...state, tool: 'select' });
      return done({ ...state, selection: NO_SELECTION });

    case 'select':
      return done({ ...state, selection: input.selection });

    case 'down-node': {
      const node = nodeById(layout, input.nodeId);
      if (!node) return done(state);
      if (state.tool === 'wire') {
        if (node.role !== 'captain') return done(state, { kind: 'refuse', reason: wireRefusalText('not-captain') });
        return done({ ...state, gesture: { kind: 'wire', fromId: node.id, to: input.canvas, over: null } });
      }
      return done({
        ...state,
        gesture: { kind: 'press', nodeId: node.id, start: input.screen, origin: { x: node.x, y: node.y }, additive: input.additive },
      });
    }

    case 'down-wire':
      if (state.tool !== 'select') return done(state);
      return done({ ...state, selection: { nodes: [], wire: input.wireId } });

    case 'down-empty':
      return done({ ...state, gesture: { kind: 'pan', start: input.screen, view: input.view, moved: false } });

    case 'move': {
      if (g.kind === 'press' || g.kind === 'drag') {
        const dx = input.screen.x - g.start.x;
        const dy = input.screen.y - g.start.y;
        if (g.kind === 'press' && Math.hypot(dx, dy) < DRAG_THRESHOLD) return done(state);
        const at = { x: g.origin.x + dx / view.scale, y: g.origin.y + dy / view.scale };
        const selection = state.selection.nodes.includes(g.nodeId) ? state.selection : { nodes: [g.nodeId], wire: null };
        return done({ ...state, selection, gesture: { kind: 'drag', nodeId: g.nodeId, start: g.start, origin: g.origin, at } });
      }
      if (g.kind === 'wire') {
        const over = overNode(layout, input.canvas, g.fromId);
        return done({ ...state, gesture: { ...g, to: input.canvas, over } });
      }
      if (g.kind === 'pan') {
        const dx = input.screen.x - g.start.x;
        const dy = input.screen.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return done(state);
        return done({ ...state, gesture: { ...g, moved: true } }, { kind: 'view', view: { ...g.view, x: g.view.x + dx, y: g.view.y + dy } });
      }
      return done(state);
    }

    case 'up': {
      if (g.kind === 'press') return done({ ...state, gesture: idle, selection: selectNode(state.selection, g.nodeId, g.additive) });
      if (g.kind === 'drag') return done({ ...state, gesture: idle }, { kind: 'drop', nodeId: g.nodeId, at: g.at });
      if (g.kind === 'wire') return done({ ...state, gesture: idle }, { kind: 'wire', fromId: g.fromId, toId: g.over });
      if (g.kind === 'pan') return done({ ...state, gesture: idle, selection: g.moved ? state.selection : NO_SELECTION });
      return done(state);
    }

    case 'cancel':
      return done({ ...state, gesture: idle });
  }
}

/** The topmost node under a canvas point, other than `except`. */
function overNode(layout: FleetLayout, point: FleetPoint, except: string): string | null {
  for (let index = layout.nodes.length - 1; index >= 0; index -= 1) {
    const node = layout.nodes[index]!;
    if (node.id === except) continue;
    if (point.x >= node.x && point.x <= node.x + FLEET_NODE_WIDTH && point.y >= node.y && point.y <= node.y + FLEET_NODE_HEIGHT) return node.id;
  }
  return null;
}
