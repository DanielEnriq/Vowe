import { describe, expect, it } from 'vitest';

import {
  FLEET_CLUSTER_INSET,
  FLEET_GAP,
  FLEET_NODE_HEIGHT,
  FLEET_NODE_WIDTH,
  addCaptain,
  addNode,
  addWire,
  canJoinCluster,
  canWire,
  captainOf,
  clusterAt,
  clusterOf,
  clusterRect,
  createCluster,
  emptyFleetLayout,
  fitView,
  freshId,
  joinCluster,
  layoutBounds,
  leaveCluster,
  mayAskCaptain,
  moveNode,
  nodeAt,
  nodeById,
  nodeRect,
  normalizeFleetLayout,
  parseFleetLayout,
  placeInFreeSpace,
  reconcile,
  removeCluster,
  removeNode,
  removeWire,
  screenToCanvas,
  canvasToScreen,
  setNodeLabel,
  setNodeSession,
  tidy,
  updateCluster,
  wireRoute,
  wiredAgents,
  zoomAt,
  type FleetLayout,
  type FleetNode,
  type FleetRect,
} from '@vowe/core/fleet-model';

function node(id: string, x: number, y: number, overrides: Partial<FleetNode> = {}): FleetNode {
  return { id, sessionId: `s-${id}`, role: 'agent', x, y, ...overrides };
}

/** Captain `c` over three attempts in a cluster, one loose agent, one placeholder. */
function fleet(): FleetLayout {
  return {
    version: 1,
    nodes: [
      node('c', 300, 60, { role: 'captain' }),
      node('a', 104, 254),
      node('b', 300, 254),
      node('d', 496, 254),
      node('loose', 860, 254),
      node('todo', 1060, 254, { sessionId: null }),
    ],
    clusters: [{ id: 'k', label: 'Parallel · 3', brief: 'Split the retry policy', memberIds: ['a', 'b', 'd'] }],
    wires: [
      { id: 'w1', captainId: 'c', agentId: 'a' },
      { id: 'w2', captainId: 'c', agentId: 'b' },
    ],
  };
}

function overlaps(a: FleetRect, b: FleetRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('fleet nodes', () => {
  it('moves a node exactly where it was dropped and nothing else', () => {
    const before = fleet();
    const after = moveNode(before, 'b', { x: 333.5, y: -12.25 });
    expect(nodeById(after, 'b')).toMatchObject({ x: 333.5, y: -12.25 });
    for (const other of before.nodes.filter((each) => each.id !== 'b')) {
      expect(nodeById(after, other.id)).toBe(other);
    }
    // Moving out of the box does not change membership: the UI decides that.
    expect(after.clusters).toBe(before.clusters);
    expect(after.wires).toBe(before.wires);
    expect(before.nodes.find((each) => each.id === 'b')).toMatchObject({ x: 300, y: 254 });
  });

  it('ignores a move to the same place, of an unknown node, or to a non-finite point', () => {
    const before = fleet();
    expect(moveNode(before, 'b', { x: 300, y: 254 })).toBe(before);
    expect(moveNode(before, 'nope', { x: 1, y: 1 })).toBe(before);
    expect(moveNode(before, 'b', { x: Number.NaN, y: 1 })).toBe(before);
  });

  it('adds nodes with fresh ids, at a given position or in free space', () => {
    let layout = emptyFleetLayout();
    const first = addNode(layout, { sessionId: 's1' });
    expect(first.node).toEqual({ id: 'node-1', sessionId: 's1', role: 'agent', x: 0, y: 0 });
    layout = first.layout;
    const second = addNode(layout, { sessionId: null, label: 'Audit log index', x: 500, y: 40 });
    expect(second.node).toEqual({ id: 'node-2', sessionId: null, role: 'agent', x: 500, y: 40, label: 'Audit log index' });
    const captain = addCaptain(second.layout, { sessionId: 'cap' });
    expect(captain.node?.role).toBe('captain');
    expect(captain.layout.nodes.map((each) => each.id)).toEqual(['node-1', 'node-2', 'node-3']);
  });

  it('never puts a session on the canvas twice, and refuses a taken id', () => {
    const before = fleet();
    const again = addNode(before, { sessionId: 's-a' });
    expect(again.layout).toBe(before);
    expect(again.node?.id).toBe('a');
    const taken = addNode(before, { id: 'a', sessionId: 'new' });
    expect(taken).toEqual({ layout: before, node: null });
  });

  it('removes a node with its wires and cluster membership, and a cluster it emptied', () => {
    let layout = removeNode(fleet(), 'a');
    expect(layout.wires.map((wire) => wire.id)).toEqual(['w2']);
    expect(layout.clusters[0]!.memberIds).toEqual(['b', 'd']);
    layout = removeNode(removeNode(layout, 'b'), 'd');
    expect(layout.clusters).toEqual([]);
    layout = removeNode(layout, 'c');
    expect(layout.wires).toEqual([]);
    expect(layout.nodes.map((each) => each.id)).toEqual(['loose', 'todo']);
  });

  it('starts a placeholder by giving it a session, never one already placed', () => {
    const started = setNodeSession(fleet(), 'todo', 's-new');
    expect(nodeById(started, 'todo')!.sessionId).toBe('s-new');
    expect(setNodeSession(started, 'todo', 's-a')).toBe(started);
  });

  it('labels and unlabels a node', () => {
    const named = setNodeLabel(fleet(), 'a', 'Attempt A');
    expect(nodeById(named, 'a')!.label).toBe('Attempt A');
    expect(nodeById(setNodeLabel(named, 'a', undefined), 'a')).not.toHaveProperty('label');
  });

  it('hit-tests nodes, the last drawn on top', () => {
    const layout = fleet();
    expect(nodeAt(layout, { x: 110, y: 260 })?.id).toBe('a');
    expect(nodeAt(layout, { x: 0, y: 0 })).toBeNull();
    const stacked = moveNode(layout, 'b', { x: 110, y: 260 });
    expect(nodeAt(stacked, { x: 120, y: 270 })?.id).toBe('b');
  });
});

describe('fleet free space', () => {
  it('starts an empty canvas at the origin', () => {
    expect(placeInFreeSpace(emptyFleetLayout())).toEqual({ x: 0, y: 0 });
  });

  it('never overlaps a node or a cluster box, with a gap kept clear', () => {
    let layout = fleet();
    for (let count = 0; count < 25; count += 1) {
      const at = placeInFreeSpace(layout);
      const mine = nodeRect(at);
      const padded = { x: mine.x - FLEET_GAP, y: mine.y - FLEET_GAP, w: mine.w + FLEET_GAP * 2, h: mine.h + FLEET_GAP * 2 };
      for (const other of layout.nodes) expect(overlaps(padded, nodeRect(other))).toBe(false);
      for (const cluster of layout.clusters) expect(overlaps(padded, clusterRect(cluster, layout.nodes)!)).toBe(false);
      layout = addNode(layout, { sessionId: `spawn-${count}`, x: at.x, y: at.y }).layout;
    }
  });

  it('is deterministic and moves nothing already there', () => {
    const layout = fleet();
    expect(placeInFreeSpace(layout)).toEqual(placeInFreeSpace(fleet()));
    const added = addNode(layout, { sessionId: 'new' });
    expect(added.layout.nodes.slice(0, -1)).toEqual(layout.nodes);
  });

  it('takes the asked-for spot when it is free, and the nearest free one when not', () => {
    const layout = fleet();
    expect(placeInFreeSpace(layout, { x: 2000, y: 2000 })).toEqual({ x: 2000, y: 2000 });
    const near = placeInFreeSpace(layout, { x: 300, y: 254 });
    expect(near).not.toEqual({ x: 300, y: 254 });
    const mine = nodeRect(near);
    for (const other of layout.nodes) expect(overlaps(mine, nodeRect(other))).toBe(false);
    expect(Math.hypot(near.x - 300, near.y - 254)).toBeLessThan(600);
    expect(placeInFreeSpace(layout, { x: 300, y: 254 })).toEqual(near);
  });
});

describe('fleet clusters', () => {
  it('creates a cluster of agents only; captains and unknown ids are skipped', () => {
    const base = { ...fleet(), clusters: [] };
    const { layout, cluster } = createCluster(base, ['a', 'c', 'b', 'nope', 'a'], 'Do the thing', 'Parallel · 2');
    expect(cluster).toEqual({ id: 'cluster-1', label: 'Parallel · 2', brief: 'Do the thing', memberIds: ['a', 'b'] });
    expect(layout.clusters).toEqual([cluster]);
    expect(layout.nodes).toBe(base.nodes);
    expect(createCluster(base, ['c'], 'x', 'y')).toEqual({ layout: base, cluster: null });
  });

  it('keeps a node in at most one cluster, and drops a cluster it emptied', () => {
    const { layout } = createCluster(fleet(), ['d', 'loose'], 'Other', 'Parallel · 2', 'k2');
    expect(layout.clusters.map((each) => [each.id, each.memberIds])).toEqual([
      ['k', ['a', 'b']],
      ['k2', ['d', 'loose']],
    ]);
    const moved = joinCluster(joinCluster(layout, 'k2', 'a'), 'k2', 'b');
    expect(moved.clusters.map((each) => [each.id, each.memberIds])).toEqual([['k2', ['d', 'loose', 'a', 'b']]]);
  });

  it('never lets a captain into a cluster', () => {
    const layout = fleet();
    expect(canJoinCluster(layout, 'k', 'c')).toEqual({ ok: false, reason: 'captain' });
    expect(canJoinCluster(layout, 'nope', 'loose')).toEqual({ ok: false, reason: 'missing-cluster' });
    expect(canJoinCluster(layout, 'k', 'nope')).toEqual({ ok: false, reason: 'missing-node' });
    expect(joinCluster(layout, 'k', 'c')).toBe(layout);
  });

  it('joins and leaves without moving anything on the canvas', () => {
    const joined = joinCluster(fleet(), 'k', 'loose');
    expect(clusterOf(joined, 'loose')?.id).toBe('k');
    expect(joined.nodes).toEqual(fleet().nodes);
    expect(joinCluster(joined, 'k', 'loose')).toBe(joined);
    const left = leaveCluster(joined, 'loose');
    expect(clusterOf(left, 'loose')).toBeNull();
    expect(leaveCluster(left, 'loose')).toBe(left);
    const emptied = leaveCluster(leaveCluster(leaveCluster(left, 'a'), 'b'), 'd');
    expect(emptied.clusters).toEqual([]);
  });

  it('renames and dissolves a cluster, leaving its members where they are', () => {
    const renamed = updateCluster(fleet(), 'k', { label: 'Retry', brief: 'New brief' });
    expect(renamed.clusters[0]).toMatchObject({ label: 'Retry', brief: 'New brief', memberIds: ['a', 'b', 'd'] });
    const gone = removeCluster(renamed, 'k');
    expect(gone.clusters).toEqual([]);
    expect(gone.nodes).toBe(renamed.nodes);
  });

  it('draws a box around the members with padding and room for the label chip', () => {
    const layout = fleet();
    // The artboard: attempts at 104…672 × 254…346 in a box at 88,212 600×160.
    expect(clusterRect(layout.clusters[0]!, layout.nodes)).toEqual({ x: 88, y: 212, w: 600, h: 160 });
    expect(FLEET_CLUSTER_INSET.top).toBeGreaterThan(FLEET_CLUSTER_INSET.bottom);
    const withRect = { ...layout.clusters[0]!, rect: { x: 0, y: 0, w: 10, h: 10 } };
    expect(clusterRect(withRect, layout.nodes)).toEqual({ x: 0, y: 0, w: 688, h: 372 });
    expect(clusterRect({ id: 'e', label: '', brief: '', memberIds: ['ghost'] }, layout.nodes)).toBeNull();
  });

  it('hit-tests a cluster box, including its label strip, and nothing outside', () => {
    const layout = fleet();
    expect(clusterAt(layout, { x: 95, y: 220 })?.id).toBe('k');
    expect(clusterAt(layout, { x: 687, y: 371 })?.id).toBe('k');
    expect(clusterAt(layout, { x: 87, y: 220 })).toBeNull();
    expect(clusterAt(layout, { x: 900, y: 300 })).toBeNull();
  });
});

describe('fleet wires', () => {
  it('allows only captain → agent, once, and one captain per agent', () => {
    const layout = addCaptain(fleet(), { id: 'c2', sessionId: 'docs', x: 920, y: 60 }).layout;
    expect(canWire(layout, 'c', 'd')).toEqual({ ok: true });
    expect(canWire(layout, 'd', 'c')).toEqual({ ok: false, reason: 'not-captain' });
    expect(canWire(layout, 'a', 'b')).toEqual({ ok: false, reason: 'not-captain' });
    expect(canWire(layout, 'c', 'c2')).toEqual({ ok: false, reason: 'not-agent' });
    expect(canWire(layout, 'c', 'c')).toEqual({ ok: false, reason: 'self' });
    expect(canWire(layout, 'c', 'a')).toEqual({ ok: false, reason: 'duplicate' });
    expect(canWire(layout, 'c2', 'a')).toEqual({ ok: false, reason: 'agent-has-captain' });
    expect(canWire(layout, 'c', 'nope')).toEqual({ ok: false, reason: 'missing-node' });
    expect(canWire(layout, 'c2', 'todo')).toEqual({ ok: true });
  });

  it('adds and removes wires; a refused wire leaves the layout as it was', () => {
    const before = fleet();
    const wired = addWire(before, 'c', 'loose');
    expect(wired.wires.at(-1)).toEqual({ id: 'wire-1', captainId: 'c', agentId: 'loose' });
    expect(addWire(wired, 'c', 'loose')).toBe(wired);
    expect(addWire(wired, 'loose', 'c')).toBe(wired);
    expect(removeWire(wired, 'w1').wires.map((wire) => wire.id)).toEqual(['w2', 'wire-1']);
    expect(removeWire(wired, 'nope')).toBe(wired);
  });

  it('lists a captain’s agents and an agent’s captain', () => {
    const layout = fleet();
    expect(wiredAgents(layout, 'c').map((each) => each.id)).toEqual(['a', 'b']);
    expect(captainOf(layout, 'a')?.id).toBe('c');
    expect(captainOf(layout, 'loose')).toBeNull();
  });

  it('says which captain session an agent may ask, or null to stop for the developer', () => {
    const layout = fleet();
    expect(mayAskCaptain(layout, 's-a')).toBe('s-c');
    expect(mayAskCaptain(layout, 's-loose')).toBeNull();
    expect(mayAskCaptain(layout, 's-c')).toBeNull();
    expect(mayAskCaptain(layout, 'unknown')).toBeNull();
    const unstarted = setNodeSession(layout, 'c', null);
    expect(mayAskCaptain(unstarted, 's-a')).toBeNull();
    expect(mayAskCaptain(removeWire(layout, 'w1'), 's-a')).toBeNull();
  });

  it('routes an elbow down from the captain, across at half height, into the agent', () => {
    const route = wireRoute(nodeRect({ x: 300, y: 60 }), nodeRect({ x: 104, y: 254 }));
    expect(route.points).toEqual([
      { x: 388, y: 152 },
      { x: 388, y: 203 },
      { x: 192, y: 203 },
      { x: 192, y: 254 },
    ]);
    expect(route.d).toBe('M 388 152 L 388 203 L 192 203 L 192 254');
  });

  it('only ever draws straight, axis-aligned segments', () => {
    const from = nodeRect({ x: 0, y: 0 });
    const targets = [
      { x: 0, y: 300 },
      { x: 400, y: 300 },
      { x: -400, y: -300 },
      { x: 400, y: 10 },
      { x: -400, y: -10 },
      { x: 0, y: -300 },
    ];
    for (const target of targets) {
      const route = wireRoute(from, nodeRect(target));
      expect(route.d).not.toMatch(/[QCASqcas]/);
      expect(route.d).toMatch(/^M [-\d. ]+( L [-\d. ]+)+$/);
      for (let index = 1; index < route.points.length; index += 1) {
        const a = route.points[index - 1]!;
        const b = route.points[index]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    }
  });

  it('is a single segment when the centres line up, and leaves from the side beside it', () => {
    expect(wireRoute(nodeRect({ x: 0, y: 0 }), nodeRect({ x: 0, y: 300 })).points).toEqual([
      { x: 88, y: 92 },
      { x: 88, y: 300 },
    ]);
    expect(wireRoute(nodeRect({ x: 0, y: 0 }), nodeRect({ x: 400, y: 0 })).d).toBe('M 176 46 L 400 46');
    const up = wireRoute(nodeRect({ x: 0, y: 300 }), nodeRect({ x: 0, y: 0 }));
    expect(up.points).toEqual([
      { x: 88, y: 300 },
      { x: 88, y: 92 },
    ]);
  });
});

describe('fleet tidy', () => {
  it('puts captains in a left column, clusters as boxed rows, then loose agents', () => {
    const layout = addCaptain(fleet(), { id: 'c2', sessionId: 'docs', x: 999, y: 999 }).layout;
    const tidied = tidy(layout);
    const at = (id: string) => ({ x: nodeById(tidied, id)!.x, y: nodeById(tidied, id)!.y });
    expect(at('c')).toEqual({ x: 0, y: 0 });
    expect(at('c2')).toEqual({ x: 0, y: FLEET_NODE_HEIGHT + FLEET_GAP });
    const box = clusterRect(tidied.clusters[0]!, tidied.nodes)!;
    expect(box.x).toBeGreaterThan(FLEET_NODE_WIDTH);
    expect(box.y).toBe(0);
    expect([at('a').y, at('b').y, at('d').y]).toEqual([box.y + FLEET_CLUSTER_INSET.top, box.y + FLEET_CLUSTER_INSET.top, box.y + FLEET_CLUSTER_INSET.top]);
    expect(at('b').x - at('a').x).toBe(FLEET_NODE_WIDTH + FLEET_GAP);
    expect(at('loose').y).toBeGreaterThan(box.y + box.h);
    expect(at('todo')).toEqual({ x: at('loose').x + FLEET_NODE_WIDTH + FLEET_GAP, y: at('loose').y });
    expect(at('loose').x).toBe(box.x);
  });

  it('is deterministic, idempotent, overlap-free, and keeps every array in order', () => {
    const layout = fleet();
    const once = tidy(layout);
    expect(tidy(fleet())).toEqual(once);
    expect(tidy(once)).toEqual(once);
    expect(once.nodes.map((each) => each.id)).toEqual(layout.nodes.map((each) => each.id));
    expect(once.wires).toBe(layout.wires);
    for (const a of once.nodes) {
      for (const b of once.nodes) if (a !== b) expect(overlaps(nodeRect(a), nodeRect(b))).toBe(false);
    }
    for (const loose of once.nodes.filter((each) => !clusterOf(once, each.id))) {
      expect(overlaps(nodeRect(loose), clusterRect(once.clusters[0]!, once.nodes)!)).toBe(false);
    }
  });

  it('clears a cluster rect so the box fits its members again', () => {
    const layout = fleet();
    layout.clusters[0]!.rect = { x: -500, y: -500, w: 10, h: 10 };
    expect(tidy(layout).clusters[0]).not.toHaveProperty('rect');
  });
});

describe('fleet reconcile', () => {
  it('reports orphans and unplaced sessions without dropping or reordering anything', () => {
    const layout = fleet();
    const result = reconcile(layout, [{ id: 's-new' }, { id: 's-c' }, { id: 's-b' }, { id: 's-new' }]);
    expect(result).toEqual({ orphaned: ['a', 'd', 'loose'], unplaced: ['s-new'] });
    expect(reconcile(layout, new Set(['s-a', 's-b', 's-c', 's-d', 's-loose']))).toEqual({ orphaned: [], unplaced: [] });
  });
});

describe('fleet view', () => {
  it('fits everything, centred, never zooming past 1', () => {
    const layout = fleet();
    const bounds = layoutBounds(layout)!;
    const view = fitView(layout, { width: 800, height: 600 });
    expect(view.scale).toBeCloseTo((800 - 96) / bounds.w);
    const centre = canvasToScreen(view, { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 });
    expect(centre.x).toBeCloseTo(400);
    expect(centre.y).toBeCloseTo(300);
    expect(fitView(layout, { width: 5000, height: 5000 }).scale).toBe(1);
    expect(fitView(emptyFleetLayout(), { width: 800, height: 600 })).toEqual({ scale: 1, x: 48, y: 48 });
  });

  it('zooms around a fixed screen point and converts both ways', () => {
    const view = { scale: 1, x: 10, y: 20 };
    const anchor = { x: 200, y: 100 };
    const before = screenToCanvas(view, anchor);
    const zoomed = zoomAt(view, 2, anchor);
    expect(zoomed.scale).toBe(2);
    expect(screenToCanvas(zoomed, anchor)).toEqual(before);
    expect(zoomAt(view, 100, anchor).scale).toBe(2);
    expect(zoomAt(view, 0.001, anchor).scale).toBe(0.25);
    expect(canvasToScreen(zoomed, screenToCanvas(zoomed, { x: 5, y: 7 }))).toEqual({ x: 5, y: 7 });
  });
});

describe('fleet layout validity', () => {
  it('reads bad JSON, wrong versions and junk as an empty layout', () => {
    for (const raw of [null, undefined, '', '{', 'null', '[]', '{"version":2,"nodes":[]}', '"x"']) {
      expect(parseFleetLayout(raw)).toEqual(emptyFleetLayout());
    }
  });

  it('round-trips a valid layout unchanged', () => {
    const layout = fleet();
    expect(parseFleetLayout(JSON.stringify(layout))).toEqual(layout);
  });

  it('restores every invariant, first occurrence winning', () => {
    const raw = {
      version: 1,
      nodes: [
        node('c', 0, 0, { role: 'captain' }),
        node('c2', 0, 200, { role: 'captain', sessionId: 'docs' }),
        node('a', 200, 0),
        node('a', 999, 999),
        node('dup-session', 400, 0, { sessionId: 's-a' }),
        { id: 'bad-role', sessionId: null, role: 'boss', x: 0, y: 0 },
        { id: 'bad-x', sessionId: null, role: 'agent', x: 'left', y: 0 },
        { id: 'empty-session', sessionId: '', role: 'agent', x: 600, y: 0, label: 7 },
        'junk',
      ],
      clusters: [
        { id: 'k1', label: 'L', brief: 'B', memberIds: ['a', 'c', 'ghost'] },
        { id: 'k2', label: 'L2', memberIds: ['a', 'empty-session'], rect: { x: 0, y: 0, w: -5, h: 1 } },
        { id: 'k3', label: 'L3', brief: 'B', memberIds: ['c'] },
        { id: 'a', label: 'clash', brief: '', memberIds: [] },
      ],
      wires: [
        { id: 'w1', captainId: 'c', agentId: 'a' },
        { id: 'w2', captainId: 'c2', agentId: 'a' },
        { id: 'w3', captainId: 'a', agentId: 'c' },
        { id: 'w1', captainId: 'c', agentId: 'empty-session' },
        { id: 'w4', captainId: 'c', agentId: 'empty-session' },
      ],
    };
    const layout = normalizeFleetLayout(raw);
    expect(layout.nodes.map((each) => each.id)).toEqual(['c', 'c2', 'a', 'empty-session']);
    expect(nodeById(layout, 'a')).toMatchObject({ x: 200, y: 0 });
    expect(nodeById(layout, 'empty-session')).toEqual({ id: 'empty-session', sessionId: null, role: 'agent', x: 600, y: 0 });
    expect(layout.clusters).toEqual([
      { id: 'k1', label: 'L', brief: 'B', memberIds: ['a'] },
      { id: 'k2', label: 'L2', brief: '', memberIds: ['empty-session'] },
    ]);
    expect(layout.wires).toEqual([
      { id: 'w1', captainId: 'c', agentId: 'a' },
      { id: 'w4', captainId: 'c', agentId: 'empty-session' },
    ]);
    expect(normalizeFleetLayout(layout)).toEqual(layout);
  });

  it('hands out the smallest unused id across every kind', () => {
    const layout: FleetLayout = { ...emptyFleetLayout(), nodes: [node('node-1', 0, 0), node('node-3', 0, 0)] };
    expect(freshId(layout, 'node')).toBe('node-2');
    expect(freshId(layout, 'wire')).toBe('wire-1');
  });
});
