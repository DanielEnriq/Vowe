/**
 * The fleet canvas: where a project's agents and captains sit, which of them
 * are parallel attempts at one brief, and which agents may ask which captain.
 *
 * This is project state, not view state that Vowe may rearrange. The one rule
 * is that nothing moves unless someone moved it: a node stays exactly where it
 * was dropped, a spawn goes into free space without disturbing anything, and
 * only `tidy`, asked for, re-lays out. No function here re-sorts the arrays;
 * order is creation order and is what a deterministic tidy reads.
 *
 * Every function is pure and returns a new layout. An operation that would
 * break an invariant returns the layout it was given, unchanged — the `can*`
 * checks say why beforehand. The invariants, which `normalizeFleetLayout`
 * restores on anything read from disk:
 *
 * - Node ids are unique, and a session is on the canvas at most once.
 * - A node is in at most one cluster; a captain is never in one; a cluster
 *   always has at least one member.
 * - A wire runs from a captain to an agent, at most once per pair, and an agent
 *   has at most one captain — "May ask the captain" is singular, and the relay
 *   needs one place to send a question.
 *
 * Coordinates are canvas units with y pointing down; a node's `x`/`y` is its
 * top-left corner.
 *
 * Imports nothing, so the renderer can use it at runtime (`@vowe/core/fleet-model`).
 */

export const FLEET_NODE_WIDTH = 176;
export const FLEET_NODE_HEIGHT = 92;
export const FLEET_NODE_RADIUS = 12;
/** The space kept between nodes when Vowe places one, and between a row's nodes. */
export const FLEET_GAP = 20;
/** How far a cluster's box reaches beyond its members. The top leaves room for the label chip. */
export const FLEET_CLUSTER_INSET = { top: 42, right: 16, bottom: 26, left: 16 } as const;

export interface FleetPoint {
  x: number;
  y: number;
}

export interface FleetRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FleetRole = 'agent' | 'captain';

export interface FleetNode {
  id: string;
  /** The worker this node is. Null is a placeholder that has not been started. */
  sessionId: string | null;
  role: FleetRole;
  x: number;
  y: number;
  /** A name the developer gave it; otherwise the UI names it from its session. */
  label?: string;
}

/** Parallel attempts at the same brief, drawn as one labelled box. */
export interface FleetCluster {
  id: string;
  label: string;
  brief: string;
  /** Agent node ids, in the order they joined. Never empty. */
  memberIds: string[];
  /**
   * The least the box covers. It always covers its members as well; tidy
   * clears it. Absent is the ordinary case.
   */
  rect?: FleetRect;
}

/** Permission for an agent to ask a captain instead of stopping for the developer. */
export interface FleetWire {
  id: string;
  captainId: string;
  agentId: string;
}

export interface FleetLayout {
  version: 1;
  nodes: FleetNode[];
  clusters: FleetCluster[];
  wires: FleetWire[];
}

/** A `FleetLayout` was saved; re-read it. */
export interface FleetLayoutChange {
  projectId: string;
}

export function emptyFleetLayout(): FleetLayout {
  return { version: 1, nodes: [], clusters: [], wires: [] };
}

// ------------------------------------------------------------------ reading

export function nodeById(layout: FleetLayout, nodeId: string): FleetNode | null {
  return layout.nodes.find((node) => node.id === nodeId) ?? null;
}

export function nodeForSession(layout: FleetLayout, sessionId: string): FleetNode | null {
  return layout.nodes.find((node) => node.sessionId === sessionId) ?? null;
}

export function nodeRect(node: Pick<FleetNode, 'x' | 'y'>): FleetRect {
  return { x: node.x, y: node.y, w: FLEET_NODE_WIDTH, h: FLEET_NODE_HEIGHT };
}

/** The cluster a node is in, if any. */
export function clusterOf(layout: FleetLayout, nodeId: string): FleetCluster | null {
  return layout.clusters.find((cluster) => cluster.memberIds.includes(nodeId)) ?? null;
}

/** The captain an agent node is wired to, if any. */
export function captainOf(layout: FleetLayout, agentId: string): FleetNode | null {
  const wire = layout.wires.find((candidate) => candidate.agentId === agentId);
  return wire ? nodeById(layout, wire.captainId) : null;
}

/** The agents a captain is wired to, in wire order. */
export function wiredAgents(layout: FleetLayout, captainId: string): FleetNode[] {
  return layout.wires
    .filter((wire) => wire.captainId === captainId)
    .map((wire) => nodeById(layout, wire.agentId))
    .filter((node): node is FleetNode => node !== null);
}

/**
 * Which captain session an agent session may ask instead of stopping, or null
 * when it must stop for the developer: no node, not an agent, no wire, or a
 * captain that has not been started.
 */
export function mayAskCaptain(layout: FleetLayout, sessionId: string): string | null {
  const agent = nodeForSession(layout, sessionId);
  if (!agent || agent.role !== 'agent') return null;
  const captain = captainOf(layout, agent.id);
  return captain?.role === 'captain' ? captain.sessionId : null;
}

/**
 * A layout against the sessions that exist. Nothing is dropped — nodes are
 * project state, and a session that vanished may come back — and nothing is
 * reordered.
 */
export interface FleetReconciliation {
  /** Node ids whose session is no longer among `sessions`, in node order. */
  orphaned: string[];
  /** Session ids with no node, in the order given. */
  unplaced: string[];
}

export function reconcile(
  layout: FleetLayout,
  sessions: Iterable<string | { id: string }>,
): FleetReconciliation {
  const ids: string[] = [];
  for (const session of sessions) ids.push(typeof session === 'string' ? session : session.id);
  const present = new Set(ids);
  const placed = new Set(layout.nodes.map((node) => node.sessionId).filter((id): id is string => id !== null));
  return {
    orphaned: layout.nodes
      .filter((node) => node.sessionId !== null && !present.has(node.sessionId))
      .map((node) => node.id),
    unplaced: [...new Set(ids)].filter((id) => !placed.has(id)),
  };
}

/** The smallest unused `${prefix}-${n}` across nodes, clusters and wires. */
export function freshId(layout: FleetLayout, prefix: string): string {
  const taken = new Set<string>([
    ...layout.nodes.map((node) => node.id),
    ...layout.clusters.map((cluster) => cluster.id),
    ...layout.wires.map((wire) => wire.id),
  ]);
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

// ------------------------------------------------------------------- nodes

export interface NewFleetNode {
  /** Defaults to a fresh `node-n`. A taken id refuses the add. */
  id?: string;
  sessionId: string | null;
  label?: string;
  /** Both or neither; without them the node goes into free space near `near`. */
  x?: number;
  y?: number;
}

export interface AddedFleetNode {
  layout: FleetLayout;
  /** The node added — or, when its session was already on the canvas, that node. Null when refused. */
  node: FleetNode | null;
}

/**
 * Put a node on the canvas, in free space unless a position is given. A
 * session already on the canvas is not added twice: its node is returned.
 */
export function addNode(
  layout: FleetLayout,
  input: NewFleetNode & { role?: FleetRole },
  near?: FleetPoint,
): AddedFleetNode {
  if (input.sessionId !== null) {
    const existing = nodeForSession(layout, input.sessionId);
    if (existing) return { layout, node: existing };
  }
  const id = input.id ?? freshId(layout, 'node');
  if (nodeById(layout, id)) return { layout, node: null };
  const at = finite(input.x) && finite(input.y) ? { x: input.x!, y: input.y! } : placeInFreeSpace(layout, near);
  const node: FleetNode = { id, sessionId: input.sessionId, role: input.role ?? 'agent', x: at.x, y: at.y };
  if (input.label !== undefined) node.label = input.label;
  return { layout: { ...layout, nodes: [...layout.nodes, node] }, node };
}

/** A captain is a node like any other; it differs in what it may do. */
export function addCaptain(layout: FleetLayout, input: NewFleetNode, near?: FleetPoint): AddedFleetNode {
  return addNode(layout, { ...input, role: 'captain' }, near);
}

/** Remove a node, its wires, and its cluster membership; a cluster left empty goes too. */
export function removeNode(layout: FleetLayout, nodeId: string): FleetLayout {
  if (!nodeById(layout, nodeId)) return layout;
  return {
    ...layout,
    nodes: layout.nodes.filter((node) => node.id !== nodeId),
    wires: layout.wires.filter((wire) => wire.captainId !== nodeId && wire.agentId !== nodeId),
    clusters: withoutMember(layout.clusters, nodeId),
  };
}

/** Exactly where it was dropped. Nothing else moves, and cluster membership is untouched. */
export function moveNode(layout: FleetLayout, nodeId: string, to: FleetPoint): FleetLayout {
  const node = nodeById(layout, nodeId);
  if (!node || !finite(to.x) || !finite(to.y)) return layout;
  if (node.x === to.x && node.y === to.y) return layout;
  return { ...layout, nodes: layout.nodes.map((each) => (each.id === nodeId ? { ...each, x: to.x, y: to.y } : each)) };
}

/** Give a node a session — a placeholder that started. Refused if that session is already elsewhere. */
export function setNodeSession(layout: FleetLayout, nodeId: string, sessionId: string | null): FleetLayout {
  const node = nodeById(layout, nodeId);
  if (!node || node.sessionId === sessionId) return layout;
  if (sessionId !== null && nodeForSession(layout, sessionId)) return layout;
  return { ...layout, nodes: layout.nodes.map((each) => (each.id === nodeId ? { ...each, sessionId } : each)) };
}

/** Name a node; an empty or absent label clears it. */
export function setNodeLabel(layout: FleetLayout, nodeId: string, label: string | undefined): FleetLayout {
  if (!nodeById(layout, nodeId)) return layout;
  return {
    ...layout,
    nodes: layout.nodes.map((each) => {
      if (each.id !== nodeId) return each;
      const { label: _previous, ...rest } = each;
      return label ? { ...rest, label } : rest;
    }),
  };
}

/**
 * Where a new node can go without touching anything: no overlap with a node or
 * a cluster's box, with `FLEET_GAP` kept clear around it. Deterministic.
 *
 * With `near` (a desired top-left), the closest free slot on a grid through it.
 * Without, the first free slot in reading order on a grid anchored at the
 * top-left of what is already there; an empty canvas starts at the origin.
 */
export function placeInFreeSpace(layout: FleetLayout, near?: FleetPoint): FleetPoint {
  const obstacles = [
    ...layout.nodes.map(nodeRect),
    ...layout.clusters.map((cluster) => clusterRect(cluster, layout.nodes)).filter((rect): rect is FleetRect => rect !== null),
  ];
  const free = (at: FleetPoint) => {
    const mine = inflate(nodeRect(at), FLEET_GAP);
    return !obstacles.some((rect) => overlaps(mine, rect));
  };
  const stepX = FLEET_NODE_WIDTH + FLEET_GAP;
  const stepY = FLEET_NODE_HEIGHT + FLEET_GAP;

  if (near && finite(near.x) && finite(near.y)) {
    const origin = { x: near.x, y: near.y };
    if (free(origin)) return origin;
    // Rings outward; within a ring, nearest first, then top-to-bottom, left-to-right.
    for (let ring = 1; ring <= 24; ring += 1) {
      const candidates: { at: FleetPoint; distance: number; i: number; j: number }[] = [];
      for (let j = -ring; j <= ring; j += 1) {
        for (let i = -ring; i <= ring; i += 1) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          const at = { x: origin.x + i * stepX, y: origin.y + j * stepY };
          candidates.push({ at, distance: Math.hypot(at.x - origin.x, at.y - origin.y), i, j });
        }
      }
      candidates.sort((a, b) => a.distance - b.distance || a.j - b.j || a.i - b.i);
      const found = candidates.find((candidate) => free(candidate.at));
      if (found) return found.at;
    }
  }

  const bounds = unionRects(obstacles);
  if (!bounds) return { x: 0, y: 0 };
  const columns = Math.max(1, Math.ceil((bounds.w + FLEET_GAP) / stepX));
  // Below everything is always free, so this terminates.
  for (let j = 0; ; j += 1) {
    for (let i = 0; i < columns; i += 1) {
      const at = { x: bounds.x + i * stepX, y: bounds.y + j * stepY };
      if (free(at)) return at;
    }
  }
}

// ---------------------------------------------------------------- clusters

export type ClusterRefusal = 'missing-node' | 'captain' | 'missing-cluster';

/** Whether a node may join a cluster: it must exist and be an agent. */
export function canJoinCluster(
  layout: FleetLayout,
  clusterId: string,
  nodeId: string,
): { ok: true } | { ok: false; reason: ClusterRefusal } {
  if (!layout.clusters.some((cluster) => cluster.id === clusterId)) return { ok: false, reason: 'missing-cluster' };
  const node = nodeById(layout, nodeId);
  if (!node) return { ok: false, reason: 'missing-node' };
  if (node.role === 'captain') return { ok: false, reason: 'captain' };
  return { ok: true };
}

export interface CreatedFleetCluster {
  layout: FleetLayout;
  /** Null when no member was an agent on the canvas. */
  cluster: FleetCluster | null;
}

/**
 * Group agents as parallel attempts at one brief. Captains and unknown ids are
 * skipped; an agent already in a cluster moves to this one, and the cluster it
 * left goes if that left it empty. Nodes do not move: the box is drawn around
 * wherever they are.
 */
export function createCluster(
  layout: FleetLayout,
  memberIds: readonly string[],
  brief: string,
  label: string,
  id?: string,
): CreatedFleetCluster {
  const members = [...new Set(memberIds)].filter((memberId) => nodeById(layout, memberId)?.role === 'agent');
  const clusterId = id ?? freshId(layout, 'cluster');
  if (members.length === 0 || layout.clusters.some((cluster) => cluster.id === clusterId)) return { layout, cluster: null };
  let clusters = layout.clusters;
  for (const member of members) clusters = withoutMember(clusters, member);
  const cluster: FleetCluster = { id: clusterId, label, brief, memberIds: members };
  return { layout: { ...layout, clusters: [...clusters, cluster] }, cluster };
}

/** Move an agent into a cluster, out of any other. Nothing moves on the canvas. */
export function joinCluster(layout: FleetLayout, clusterId: string, nodeId: string): FleetLayout {
  if (!canJoinCluster(layout, clusterId, nodeId).ok) return layout;
  if (clusterOf(layout, nodeId)?.id === clusterId) return layout;
  const clusters = withoutMember(layout.clusters, nodeId).map((cluster) =>
    cluster.id === clusterId ? { ...cluster, memberIds: [...cluster.memberIds, nodeId] } : cluster,
  );
  // The target cannot have been emptied by removing a node it did not hold.
  return { ...layout, clusters };
}

/** Take a node out of its cluster; a cluster left empty goes. */
export function leaveCluster(layout: FleetLayout, nodeId: string): FleetLayout {
  if (!clusterOf(layout, nodeId)) return layout;
  return { ...layout, clusters: withoutMember(layout.clusters, nodeId) };
}

/** Change a cluster's label or brief. */
export function updateCluster(
  layout: FleetLayout,
  clusterId: string,
  patch: { label?: string; brief?: string },
): FleetLayout {
  if (!layout.clusters.some((cluster) => cluster.id === clusterId)) return layout;
  return {
    ...layout,
    clusters: layout.clusters.map((cluster) =>
      cluster.id === clusterId
        ? { ...cluster, ...(patch.label !== undefined ? { label: patch.label } : {}), ...(patch.brief !== undefined ? { brief: patch.brief } : {}) }
        : cluster,
    ),
  };
}

/** Dissolve a cluster. Its members stay where they are, now loose. */
export function removeCluster(layout: FleetLayout, clusterId: string): FleetLayout {
  if (!layout.clusters.some((cluster) => cluster.id === clusterId)) return layout;
  return { ...layout, clusters: layout.clusters.filter((cluster) => cluster.id !== clusterId) };
}

/**
 * A cluster's box: its members' bounds plus `FLEET_CLUSTER_INSET`, and at least
 * its `rect`. Null when none of its members is on the canvas and it has no rect.
 */
export function clusterRect(cluster: FleetCluster, nodes: readonly FleetNode[]): FleetRect | null {
  const members = cluster.memberIds
    .map((memberId) => nodes.find((node) => node.id === memberId))
    .filter((node): node is FleetNode => node !== undefined);
  const around = unionRects(members.map(nodeRect));
  const boxed = around
    ? {
        x: around.x - FLEET_CLUSTER_INSET.left,
        y: around.y - FLEET_CLUSTER_INSET.top,
        w: around.w + FLEET_CLUSTER_INSET.left + FLEET_CLUSTER_INSET.right,
        h: around.h + FLEET_CLUSTER_INSET.top + FLEET_CLUSTER_INSET.bottom,
      }
    : null;
  return unionRects([boxed, cluster.rect ?? null].filter((rect): rect is FleetRect => rect !== null));
}

/** The cluster whose box contains a point; the last drawn wins where boxes overlap. */
export function clusterAt(layout: FleetLayout, point: FleetPoint): FleetCluster | null {
  for (let index = layout.clusters.length - 1; index >= 0; index -= 1) {
    const cluster = layout.clusters[index]!;
    const rect = clusterRect(cluster, layout.nodes);
    if (rect && contains(rect, point)) return cluster;
  }
  return null;
}

/** The node under a point; the last drawn wins where nodes overlap. */
export function nodeAt(layout: FleetLayout, point: FleetPoint): FleetNode | null {
  for (let index = layout.nodes.length - 1; index >= 0; index -= 1) {
    const node = layout.nodes[index]!;
    if (contains(nodeRect(node), point)) return node;
  }
  return null;
}

// ------------------------------------------------------------------- wires

export type WireRefusal =
  | 'missing-node'
  | 'self'
  /** The wire must start at a captain. */
  | 'not-captain'
  /** The wire must end at an agent. */
  | 'not-agent'
  | 'duplicate'
  /** That agent already has a captain; remove its wire first. */
  | 'agent-has-captain';

export function canWire(
  layout: FleetLayout,
  fromId: string,
  toId: string,
): { ok: true } | { ok: false; reason: WireRefusal } {
  const from = nodeById(layout, fromId);
  const to = nodeById(layout, toId);
  if (!from || !to) return { ok: false, reason: 'missing-node' };
  if (fromId === toId) return { ok: false, reason: 'self' };
  if (from.role !== 'captain') return { ok: false, reason: 'not-captain' };
  if (to.role !== 'agent') return { ok: false, reason: 'not-agent' };
  if (layout.wires.some((wire) => wire.captainId === fromId && wire.agentId === toId)) return { ok: false, reason: 'duplicate' };
  if (layout.wires.some((wire) => wire.agentId === toId)) return { ok: false, reason: 'agent-has-captain' };
  return { ok: true };
}

/** Draw a wire from a captain to an agent; refused (layout unchanged) when `canWire` says no. */
export function addWire(layout: FleetLayout, captainId: string, agentId: string, id?: string): FleetLayout {
  if (!canWire(layout, captainId, agentId).ok) return layout;
  const wireId = id ?? freshId(layout, 'wire');
  if (layout.wires.some((wire) => wire.id === wireId)) return layout;
  return { ...layout, wires: [...layout.wires, { id: wireId, captainId, agentId }] };
}

export function removeWire(layout: FleetLayout, wireId: string): FleetLayout {
  if (!layout.wires.some((wire) => wire.id === wireId)) return layout;
  return { ...layout, wires: layout.wires.filter((wire) => wire.id !== wireId) };
}

export interface FleetRoute {
  /** Corner points, first at the captain's edge, last at the agent's edge. Consecutive points share x or y. */
  points: FleetPoint[];
  /** An SVG path of straight segments only: `M x y L x y …`. */
  d: string;
}

/**
 * An orthogonal elbow from one box to another — never a curve, never rounded.
 *
 * When one box is clearly above the other the line leaves the bottom (or top)
 * centre, runs across at the halfway height, and arrives at the other's top
 * (or bottom) centre. When the boxes overlap vertically it leaves from the
 * facing side instead and turns at the halfway width. Aligned centres give a
 * single straight segment.
 */
export function wireRoute(from: FleetRect, to: FleetRect): FleetRoute {
  let points: FleetPoint[];
  if (to.y >= from.y + from.h || to.y + to.h <= from.y) {
    const down = to.y >= from.y + from.h;
    const s = { x: from.x + from.w / 2, y: down ? from.y + from.h : from.y };
    const e = { x: to.x + to.w / 2, y: down ? to.y : to.y + to.h };
    const my = (s.y + e.y) / 2;
    points = [s, { x: s.x, y: my }, { x: e.x, y: my }, e];
  } else {
    const right = to.x + to.w / 2 >= from.x + from.w / 2;
    const s = { x: right ? from.x + from.w : from.x, y: from.y + from.h / 2 };
    const e = { x: right ? to.x : to.x + to.w, y: to.y + to.h / 2 };
    const mx = (s.x + e.x) / 2;
    points = [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e];
  }
  points = simplify(points);
  return { points, d: straightPath(points) };
}

/** A polyline as an SVG path of straight segments. */
export function straightPath(points: readonly FleetPoint[]): string {
  const f = (value: number) => Math.round(value * 10) / 10;
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${f(point.x)} ${f(point.y)}`).join(' ');
}

// -------------------------------------------------------------------- tidy

/** Room between the captains' column and everything else, so wires have space to turn. */
export const FLEET_TIDY_COLUMN_GAP = 80;
/** Between one cluster box (or row of loose agents) and the next. */
export const FLEET_TIDY_ROW_GAP = 40;
/** Loose agents per row. */
export const FLEET_TIDY_LOOSE_PER_ROW = 4;

/**
 * Arrange everything, only because someone pressed Tidy. Captains in a column
 * on the left; each cluster as a boxed row of its members to the right, in
 * cluster order; then loose agents in rows beneath. Node order within each is
 * array order, so the result depends on nothing but the layout. Cluster rects
 * are cleared: the box fits its members again. Arrays keep their order.
 */
export function tidy(layout: FleetLayout): FleetLayout {
  const positions = new Map<string, FleetPoint>();
  let captainY = 0;
  for (const node of layout.nodes) {
    if (node.role !== 'captain') continue;
    positions.set(node.id, { x: 0, y: captainY });
    captainY += FLEET_NODE_HEIGHT + FLEET_GAP;
  }

  const left = layout.nodes.some((node) => node.role === 'captain') ? FLEET_NODE_WIDTH + FLEET_TIDY_COLUMN_GAP : 0;
  let y = 0;
  for (const cluster of layout.clusters) {
    const members = cluster.memberIds.filter((memberId) => nodeById(layout, memberId));
    if (members.length === 0) continue;
    members.forEach((memberId, index) => {
      positions.set(memberId, {
        x: left + FLEET_CLUSTER_INSET.left + index * (FLEET_NODE_WIDTH + FLEET_GAP),
        y: y + FLEET_CLUSTER_INSET.top,
      });
    });
    y += FLEET_CLUSTER_INSET.top + FLEET_NODE_HEIGHT + FLEET_CLUSTER_INSET.bottom + FLEET_TIDY_ROW_GAP;
  }

  const loose = layout.nodes.filter((node) => node.role === 'agent' && !positions.has(node.id));
  loose.forEach((node, index) => {
    const column = index % FLEET_TIDY_LOOSE_PER_ROW;
    const row = Math.floor(index / FLEET_TIDY_LOOSE_PER_ROW);
    positions.set(node.id, {
      x: left + column * (FLEET_NODE_WIDTH + FLEET_GAP),
      y: y + row * (FLEET_NODE_HEIGHT + FLEET_GAP),
    });
  });

  return {
    ...layout,
    nodes: layout.nodes.map((node) => {
      const at = positions.get(node.id)!;
      return at.x === node.x && at.y === node.y ? node : { ...node, x: at.x, y: at.y };
    }),
    clusters: layout.clusters.map((cluster) => {
      if (!cluster.rect) return cluster;
      const { rect: _rect, ...rest } = cluster;
      return rest;
    }),
  };
}

// -------------------------------------------------------------------- view

/** Screen = canvas × scale + (x, y). */
export interface FleetView {
  scale: number;
  x: number;
  y: number;
}

export interface FleetViewport {
  width: number;
  height: number;
}

export const FLEET_MIN_SCALE = 0.25;
export const FLEET_MAX_SCALE = 2;

/** Everything drawn: every node and every cluster box. Null on an empty canvas. */
export function layoutBounds(layout: FleetLayout): FleetRect | null {
  return unionRects([
    ...layout.nodes.map(nodeRect),
    ...layout.clusters.map((cluster) => clusterRect(cluster, layout.nodes)).filter((rect): rect is FleetRect => rect !== null),
  ]);
}

/**
 * The view that shows everything, centred, with `padding` screen pixels
 * around it. Never zooms in past 1: fitting a small fleet should not blow it up.
 * An empty canvas is shown at 1 with the origin at the padding.
 */
export function fitView(
  layout: FleetLayout,
  viewport: FleetViewport,
  options: { padding?: number; minScale?: number; maxScale?: number } = {},
): FleetView {
  const padding = options.padding ?? 48;
  const minScale = options.minScale ?? FLEET_MIN_SCALE;
  const maxScale = Math.min(options.maxScale ?? 1, FLEET_MAX_SCALE);
  const bounds = layoutBounds(layout);
  if (!bounds) return { scale: 1, x: padding, y: padding };
  const availableW = Math.max(1, viewport.width - padding * 2);
  const availableH = Math.max(1, viewport.height - padding * 2);
  const scale = clamp(Math.min(availableW / bounds.w, availableH / bounds.h), minScale, maxScale);
  return {
    scale,
    x: viewport.width / 2 - (bounds.x + bounds.w / 2) * scale,
    y: viewport.height / 2 - (bounds.y + bounds.h / 2) * scale,
  };
}

/** Zoom by `factor` keeping the canvas point under `anchor` (a screen point) where it is. */
export function zoomAt(view: FleetView, factor: number, anchor: FleetPoint): FleetView {
  const scale = clamp(view.scale * factor, FLEET_MIN_SCALE, FLEET_MAX_SCALE);
  const world = screenToCanvas(view, anchor);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}

export function screenToCanvas(view: FleetView, point: FleetPoint): FleetPoint {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

export function canvasToScreen(view: FleetView, point: FleetPoint): FleetPoint {
  return { x: point.x * view.scale + view.x, y: point.y * view.scale + view.y };
}

// ---------------------------------------------------------------- validity

/**
 * Whatever was stored, as a layout that keeps every invariant. Never throws:
 * anything unreadable is an empty layout, and anything partly wrong keeps what
 * is right — first occurrence wins wherever two things conflict.
 */
export function normalizeFleetLayout(raw: unknown): FleetLayout {
  if (!isRecord(raw) || raw['version'] !== 1) return emptyFleetLayout();

  const nodes: FleetNode[] = [];
  const nodeIds = new Set<string>();
  const sessions = new Set<string>();
  for (const value of array(raw['nodes'])) {
    if (!isRecord(value)) continue;
    const { id, sessionId, role, x, y, label } = value;
    if (typeof id !== 'string' || !id || nodeIds.has(id)) continue;
    if (role !== 'agent' && role !== 'captain') continue;
    if (!finite(x) || !finite(y)) continue;
    const session: string | null = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (session !== null && sessions.has(session)) continue;
    if (session !== null) sessions.add(session);
    const node: FleetNode = { id, sessionId: session, role, x, y };
    if (typeof label === 'string' && label) node.label = label;
    nodes.push(node);
    nodeIds.add(id);
  }
  const agents = new Set(nodes.filter((node) => node.role === 'agent').map((node) => node.id));

  const clusters: FleetCluster[] = [];
  const clustered = new Set<string>();
  const taken = new Set(nodeIds);
  for (const value of array(raw['clusters'])) {
    if (!isRecord(value)) continue;
    const { id, label, brief, memberIds, rect } = value;
    if (typeof id !== 'string' || !id || taken.has(id)) continue;
    const members: string[] = [];
    for (const member of array(memberIds)) {
      if (typeof member === 'string' && agents.has(member) && !clustered.has(member)) {
        members.push(member);
        clustered.add(member);
      }
    }
    if (members.length === 0) continue;
    const cluster: FleetCluster = {
      id,
      label: typeof label === 'string' ? label : '',
      brief: typeof brief === 'string' ? brief : '',
      memberIds: members,
    };
    if (isRecord(rect) && finite(rect['x']) && finite(rect['y']) && finite(rect['w']) && finite(rect['h']) && rect['w'] >= 0 && rect['h'] >= 0) {
      cluster.rect = { x: rect['x'], y: rect['y'], w: rect['w'], h: rect['h'] };
    }
    clusters.push(cluster);
    taken.add(id);
  }

  const wires: FleetWire[] = [];
  const captains = new Set(nodes.filter((node) => node.role === 'captain').map((node) => node.id));
  const wiredAgentsSeen = new Set<string>();
  for (const value of array(raw['wires'])) {
    if (!isRecord(value)) continue;
    const { id, captainId, agentId } = value;
    if (typeof id !== 'string' || !id || taken.has(id)) continue;
    if (typeof captainId !== 'string' || !captains.has(captainId)) continue;
    if (typeof agentId !== 'string' || !agents.has(agentId) || wiredAgentsSeen.has(agentId)) continue;
    wires.push({ id, captainId, agentId });
    wiredAgentsSeen.add(agentId);
    taken.add(id);
  }

  return { version: 1, nodes, clusters, wires };
}

/** A stored layout's JSON, read without ever throwing. */
export function parseFleetLayout(json: string | null | undefined): FleetLayout {
  if (typeof json !== 'string') return emptyFleetLayout();
  try {
    return normalizeFleetLayout(JSON.parse(json));
  } catch {
    return emptyFleetLayout();
  }
}

// --------------------------------------------------------------- geometry

function withoutMember(clusters: readonly FleetCluster[], nodeId: string): FleetCluster[] {
  return clusters
    .map((cluster) =>
      cluster.memberIds.includes(nodeId)
        ? { ...cluster, memberIds: cluster.memberIds.filter((memberId) => memberId !== nodeId) }
        : cluster,
    )
    .filter((cluster) => cluster.memberIds.length > 0);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function inflate(rect: FleetRect, by: number): FleetRect {
  return { x: rect.x - by, y: rect.y - by, w: rect.w + by * 2, h: rect.h + by * 2 };
}

/** Open intervals: rects that only touch do not overlap. */
function overlaps(a: FleetRect, b: FleetRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(rect: FleetRect, point: FleetPoint): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

function unionRects(rects: readonly FleetRect[]): FleetRect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Drop repeated points and the middle of any straight run. */
function simplify(points: readonly FleetPoint[]): FleetPoint[] {
  const distinct = points.filter((point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y);
  return distinct.filter((point, index) => {
    if (index === 0 || index === distinct.length - 1) return true;
    const prev = distinct[index - 1]!;
    const next = distinct[index + 1]!;
    return !((prev.x === point.x && point.x === next.x) || (prev.y === point.y && point.y === next.y));
  });
}
