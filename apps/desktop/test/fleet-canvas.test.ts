import { describe, expect, it } from 'vitest';

import type { CaptainExchange, FleetLayout } from '@vowe/core';
import {
  FLEET_NODE_HEIGHT,
  FLEET_NODE_WIDTH,
  addNode,
  addWire,
  clusterOf,
  clusterRect,
  createCluster,
  emptyFleetLayout,
  wireRoute,
  nodeRect,
} from '@vowe/core/fleet-model';

import {
  DRAG_THRESHOLD,
  INITIAL_CANVAS,
  NO_SELECTION,
  answeredBy,
  attemptWire,
  captainNames,
  deleteSelection,
  dragPreview,
  dropDecision,
  dropNode,
  elapsedLabel,
  groupSelection,
  needsYouCount,
  placeCaptain,
  placeUnplaced,
  pruneSelection,
  selectNode,
  spawnPoint,
  stepCanvas,
  waitingQuestion,
  wireAt,
  wireRefusalText,
  type CanvasState,
} from '../src/renderer/state/fleet-canvas.js';

const VIEW = { scale: 1, x: 0, y: 0 };

/**
 * Captain c at (0,0); a box of a1, a2 at y 200; a loose agent l at (800, 200).
 */
function fleet(): FleetLayout {
  let layout = emptyFleetLayout();
  layout = addNode(layout, { id: 'c', sessionId: 'sc', role: 'captain', x: 0, y: 0 }).layout;
  layout = addNode(layout, { id: 'a1', sessionId: 's1', x: 0, y: 200 }).layout;
  layout = addNode(layout, { id: 'a2', sessionId: 's2', x: 200, y: 200 }).layout;
  layout = addNode(layout, { id: 'l', sessionId: 'sl', x: 800, y: 200 }).layout;
  layout = createCluster(layout, ['a1', 'a2'], 'Split the retry policy', 'Parallel · 2', 'box').layout;
  return layout;
}

function exchange(overrides: Partial<CaptainExchange>): CaptainExchange {
  return {
    id: 'x',
    projectId: 'p',
    askerSessionId: 's1',
    questionId: 'q',
    captainSessionId: 'sc',
    question: 'Keep the old header?',
    captainAnswer: null,
    route: 'captain',
    userAnswer: null,
    status: 'pending',
    delivery: null,
    askedAt: '2026-10-01T00:00:00.000Z',
    answeredAt: null,
    ...overrides,
  };
}

describe('Dropping a node', () => {
  it('stays put inside its own box, exactly where it was dropped', () => {
    const layout = fleet();
    expect(dropDecision(layout, 'a2', { x: 210, y: 205 })).toEqual({ kind: 'stay' });
    const dropped = dropNode(layout, 'a2', { x: 210.4, y: 205.6 });
    expect(dropped.nodes.find((node) => node.id === 'a2')).toMatchObject({ x: 210, y: 206 });
    expect(clusterOf(dropped, 'a2')?.id).toBe('box');
  });

  it('leaves its box when dropped outside it, and the box stays for the rest', () => {
    const layout = fleet();
    expect(dropDecision(layout, 'a2', { x: 200, y: 600 })).toEqual({ kind: 'leave', clusterId: 'box' });
    const dropped = dropNode(layout, 'a2', { x: 200, y: 600 });
    expect(clusterOf(dropped, 'a2')).toBeNull();
    expect(dropped.clusters[0]?.memberIds).toEqual(['a1']);
  });

  /** A member's own box would stretch to follow it; the box as it was when the drag began decides. */
  it('leaves once outside the box as it was, though a stretched box would still hold it', () => {
    const layout = fleet();
    const before = clusterRect(layout.clusters[0]!, layout.nodes)!;
    const at = { x: before.x + before.w + 10 - FLEET_NODE_WIDTH / 2, y: 200 };
    const stretched = clusterRect(layout.clusters[0]!, layout.nodes.map((node) => (node.id === 'a2' ? { ...node, ...at } : node)))!;
    expect(at.x + FLEET_NODE_WIDTH / 2).toBeLessThan(stretched.x + stretched.w);
    expect(dropDecision(layout, 'a2', at).kind).toBe('leave');
  });

  it('stays when nudged within the box it was in', () => {
    expect(dropDecision(fleet(), 'a2', { x: 230, y: 190 })).toEqual({ kind: 'stay' });
  });

  it('joins a box it is dropped inside', () => {
    const layout = fleet();
    expect(dropDecision(layout, 'l', { x: 100, y: 210 })).toEqual({ kind: 'join', clusterId: 'box' });
    const dropped = dropNode(layout, 'l', { x: 100, y: 210 });
    expect(clusterOf(dropped, 'l')?.id).toBe('box');
  });

  it('moves from one box to another', () => {
    let layout = fleet();
    layout = addNode(layout, { id: 'b1', sessionId: 'sb1', x: 0, y: 600 }).layout;
    layout = addNode(layout, { id: 'b2', sessionId: 'sb2', x: 200, y: 600 }).layout;
    layout = createCluster(layout, ['b1', 'b2'], 'Other task', 'Parallel · 2', 'other').layout;
    const dropped = dropNode(layout, 'a2', { x: 100, y: 600 });
    expect(clusterOf(dropped, 'a2')?.id).toBe('other');
    expect(dropped.clusters.find((cluster) => cluster.id === 'box')?.memberIds).toEqual(['a1']);
  });

  it('never puts a captain in a box', () => {
    const layout = fleet();
    expect(dropDecision(layout, 'c', { x: 100, y: 210 })).toEqual({ kind: 'stay' });
    const dropped = dropNode(layout, 'c', { x: 100, y: 210 });
    expect(clusterOf(dropped, 'c')).toBeNull();
    expect(dropped.nodes.find((node) => node.id === 'c')).toMatchObject({ x: 100, y: 210 });
  });

  it('keeps a box’s only member in it wherever it goes', () => {
    let layout = emptyFleetLayout();
    layout = addNode(layout, { id: 'solo', sessionId: 's', x: 0, y: 0 }).layout;
    layout = createCluster(layout, ['solo'], 'Alone', 'Parallel · 1', 'one').layout;
    expect(dropDecision(layout, 'solo', { x: 900, y: 900 })).toEqual({ kind: 'stay' });
    expect(clusterOf(dropNode(layout, 'solo', { x: 900, y: 900 }), 'solo')?.id).toBe('one');
  });

  it('moves nothing else', () => {
    const layout = fleet();
    const dropped = dropNode(layout, 'l', { x: 100, y: 210 });
    for (const node of layout.nodes.filter((each) => each.id !== 'l')) {
      expect(dropped.nodes.find((each) => each.id === node.id)).toEqual(node);
    }
  });

  it('previews a drag with the box held still and the landing box lit', () => {
    const layout = fleet();
    const leaving = dragPreview(layout, 'a2', { x: 200, y: 600 });
    expect(leaving.highlight).toBeNull();
    expect(leaving.layout.clusters[0]?.memberIds).toEqual(['a1']);
    // The box holds its shape while its member is away.
    expect(clusterRect(leaving.layout.clusters[0]!, leaving.layout.nodes)).toEqual(clusterRect(layout.clusters[0]!, layout.nodes));
    const joining = dragPreview(layout, 'l', { x: 100, y: 210 });
    expect(joining.highlight).toBe('box');
    const staying = dragPreview(layout, 'a2', { x: 205, y: 205 });
    expect(staying.highlight).toBe('box');
    // The preview is only drawn: the layout itself is untouched.
    expect(clusterOf(layout, 'a2')?.id).toBe('box');
  });
});

describe('Wires', () => {
  it('draws from a captain to an agent', () => {
    const tried = attemptWire(fleet(), 'c', 'l');
    expect(tried.ok).toBe(true);
    if (tried.ok) expect(tried.layout.wires).toEqual([{ id: 'wire-1', captainId: 'c', agentId: 'l' }]);
  });

  it('says why not, tersely', () => {
    const wired = addWire(fleet(), 'c', 'a1');
    expect(attemptWire(wired, 'a1', 'a2')).toEqual({ ok: false, reason: 'Start at a captain' });
    expect(attemptWire(wired, 'c', 'c')).toEqual({ ok: false, reason: 'Not to itself' });
    expect(attemptWire(wired, 'c', 'a1')).toEqual({ ok: false, reason: 'Already wired' });
    expect(attemptWire(wired, 'c', null)).toEqual({ ok: false, reason: 'Nothing there' });
    let two = addNode(wired, { id: 'c2', sessionId: 'sc2', role: 'captain', x: 400, y: 0 }).layout;
    expect(attemptWire(two, 'c2', 'a1')).toEqual({ ok: false, reason: 'Already has a captain' });
    two = addNode(two, { id: 'c3', sessionId: 'sc3', role: 'captain', x: 600, y: 0 }).layout;
    expect(attemptWire(two, 'c2', 'c3')).toEqual({ ok: false, reason: 'End at an agent' });
    expect(wireRefusalText('missing-node')).toBe('Nothing there');
  });

  it('finds a wire under the pointer along its elbow, and nothing beside it', () => {
    const layout = addWire(fleet(), 'c', 'l', 'w');
    const route = wireRoute(nodeRect(layout.nodes[0]!), nodeRect(layout.nodes[3]!));
    const corner = route.points[1]!;
    expect(wireAt(layout, { x: corner.x + 2, y: corner.y }, 4)).toBe('w');
    expect(wireAt(layout, { x: corner.x, y: corner.y + 40 }, 4)).toBeNull();
  });
});

describe('Selection', () => {
  it('selects one node, or adds and removes with shift', () => {
    let selection = selectNode(NO_SELECTION, 'a1', false);
    expect(selection).toEqual({ nodes: ['a1'], wire: null });
    selection = selectNode(selection, 'a2', true);
    expect(selection.nodes).toEqual(['a1', 'a2']);
    selection = selectNode(selection, 'a1', true);
    expect(selection.nodes).toEqual(['a2']);
    expect(selectNode({ nodes: [], wire: 'w' }, 'a1', false)).toEqual({ nodes: ['a1'], wire: null });
  });

  it('deletes a wire alone, or nodes from the canvas with their wires and memberships', () => {
    const layout = addWire(fleet(), 'c', 'a1', 'w');
    const noWire = deleteSelection(layout, { nodes: ['a1'], wire: 'w' });
    expect(noWire.layout.wires).toEqual([]);
    expect(noWire.layout.nodes).toHaveLength(4);
    expect(noWire.sessions).toEqual([]);

    const gone = deleteSelection(layout, { nodes: ['a1', 'c'], wire: null });
    expect(gone.layout.nodes.map((node) => node.id)).toEqual(['a2', 'l']);
    expect(gone.layout.wires).toEqual([]);
    expect(gone.layout.clusters[0]?.memberIds).toEqual(['a2']);
    expect(gone.sessions).toEqual(['s1', 'sc']);
  });

  it('forgets what left the canvas, and is the same object when nothing did', () => {
    const layout = fleet();
    const kept = { nodes: ['a1'], wire: null };
    expect(pruneSelection(layout, kept)).toBe(kept);
    expect(pruneSelection(layout, { nodes: ['a1', 'gone'], wire: 'gone' })).toEqual({ nodes: ['a1'], wire: null });
  });
});

describe('Grouping', () => {
  it('boxes the selected agents with the first one’s brief, skipping captains', () => {
    const grouped = groupSelection(fleet(), ['l', 'c', 'a1'], (sessionId) => `brief of ${sessionId}`);
    expect(grouped.ok).toBe(true);
    if (!grouped.ok) return;
    const cluster = grouped.layout.clusters.find((each) => each.id === grouped.clusterId)!;
    expect(cluster).toMatchObject({ memberIds: ['l', 'a1'], brief: 'brief of sl', label: 'Parallel · 2' });
    // a1 moved out of its old box, which keeps a2.
    expect(grouped.layout.clusters.find((each) => each.id === 'box')?.memberIds).toEqual(['a2']);
  });

  it('refuses fewer than two agents', () => {
    expect(groupSelection(fleet(), ['c', 'l'], () => '')).toEqual({ ok: false, reason: 'Select two or more agents' });
  });
});

describe('Placing sessions', () => {
  it('puts sessions without a node into free space and moves nothing', () => {
    const layout = fleet();
    const placed = placeUnplaced(layout, ['s1', 'new-1', 'new-2', 'skip'], new Set(['skip']));
    expect(placed.nodes.slice(0, 4)).toEqual(layout.nodes);
    const added = placed.nodes.slice(4);
    expect(added.map((node) => node.sessionId)).toEqual(['new-1', 'new-2']);
    for (const node of added) {
      for (const other of placed.nodes) {
        if (other === node) continue;
        const apart = node.x + FLEET_NODE_WIDTH <= other.x || other.x + FLEET_NODE_WIDTH <= node.x
          || node.y + FLEET_NODE_HEIGHT <= other.y || other.y + FLEET_NODE_HEIGHT <= node.y;
        expect(apart).toBe(true);
      }
    }
  });

  it('is the same layout when everything is placed', () => {
    const layout = fleet();
    expect(placeUnplaced(layout, ['s1', 's2', 'sc', 'sl'])).toBe(layout);
  });

  it('lands a spawn in the middle of the screen', () => {
    expect(spawnPoint({ scale: 2, x: 100, y: 50 }, { width: 900, height: 650 })).toEqual({
      x: Math.round((450 - 100) / 2 - FLEET_NODE_WIDTH / 2),
      y: Math.round((325 - 50) / 2 - FLEET_NODE_HEIGHT / 2),
    });
  });

  it('places a captain, or turns an agent node for its session into one in place', () => {
    const fresh = placeCaptain(emptyFleetLayout(), 'cap', { x: 40, y: 40 });
    expect(fresh.nodes).toEqual([{ id: 'node-1', sessionId: 'cap', role: 'captain', x: 40, y: 40 }]);

    // The session appeared, and was put down as an agent in a box, before the launch returned.
    const early = placeCaptain(fleet(), 's2', { x: 999, y: 999 });
    const node = early.nodes.find((each) => each.sessionId === 's2')!;
    expect(node).toMatchObject({ id: 'a2', role: 'captain', x: 200, y: 200 });
    expect(clusterOf(early, 'a2')).toBeNull();
    expect(placeCaptain(early, 's2', { x: 0, y: 0 })).toBe(early);
  });
});

describe('Node faces', () => {
  it('says how long compactly', () => {
    expect(elapsedLabel(12_000)).toBe('12s');
    expect(elapsedLabel(4 * 60_000 + 5_000)).toBe('4m');
    expect(elapsedLabel(65 * 60_000)).toBe('1h 5m');
    expect(elapsedLabel(120 * 60_000)).toBe('2h');
    expect(elapsedLabel(50 * 3_600_000)).toBe('2d');
    expect(elapsedLabel(-1)).toBe('');
  });

  it('counts what a captain answered, and finds what waits on you', () => {
    const exchanges = [
      exchange({ id: '1', route: 'captain', status: 'answered', captainAnswer: 'Yes' }),
      exchange({ id: '2', route: 'captain', status: 'pending' }),
      exchange({ id: '3', route: 'you', status: 'passed', captainAnswer: null, askerSessionId: 's2' }),
      exchange({ id: '4', route: 'you', status: 'answered', userAnswer: 'No' }),
      exchange({ id: '5', route: 'captain', status: 'answered', captainSessionId: 'other' }),
    ];
    expect(answeredBy(exchanges, 'sc')).toBe(1);
    expect(answeredBy(exchanges, null)).toBe(0);
    expect(waitingQuestion(exchanges, 's2')?.id).toBe('3');
    expect(waitingQuestion(exchanges, 's1')).toBeNull();
    expect(needsYouCount(exchanges)).toBe(1);
  });

  it('names captains in order, keeping a given name', () => {
    let layout = fleet();
    layout = addNode(layout, { id: 'c2', sessionId: 'x', role: 'captain', x: 500, y: 0, label: 'Docs captain' }).layout;
    layout = addNode(layout, { id: 'c3', sessionId: 'y', role: 'captain', x: 700, y: 0 }).layout;
    expect([...captainNames(layout.nodes)]).toEqual([['c', 'Captain'], ['c2', 'Docs captain'], ['c3', 'Captain 3']]);
  });
});

describe('The canvas’s gestures', () => {
  const layout = fleet();
  const step = (state: CanvasState, input: Parameters<typeof stepCanvas>[1], view = VIEW) => stepCanvas(state, input, layout, view);

  it('treats a short press as a click that selects', () => {
    let s = step(INITIAL_CANVAS, { type: 'down-node', nodeId: 'a1', screen: { x: 10, y: 210 }, canvas: { x: 10, y: 210 }, additive: false }).state;
    s = step(s, { type: 'move', screen: { x: 10 + DRAG_THRESHOLD - 1, y: 210 }, canvas: { x: 0, y: 0 } }).state;
    expect(s.gesture.kind).toBe('press');
    const up = step(s, { type: 'up' });
    expect(up.effect).toBeNull();
    expect(up.state.selection).toEqual({ nodes: ['a1'], wire: null });
    expect(up.state.gesture.kind).toBe('idle');
  });

  it('drags past the threshold and drops where the pointer let go, scaled to the canvas', () => {
    const view = { scale: 2, x: 0, y: 0 };
    let s = step(INITIAL_CANVAS, { type: 'down-node', nodeId: 'l', screen: { x: 0, y: 0 }, canvas: { x: 0, y: 0 }, additive: false }, view).state;
    s = step(s, { type: 'move', screen: { x: 40, y: 20 }, canvas: { x: 0, y: 0 } }, view).state;
    expect(s.gesture).toMatchObject({ kind: 'drag', nodeId: 'l', at: { x: 820, y: 210 } });
    expect(s.selection.nodes).toEqual(['l']);
    const up = step(s, { type: 'up' }, view);
    expect(up.effect).toEqual({ kind: 'drop', nodeId: 'l', at: { x: 820, y: 210 } });
  });

  it('draws a wire only from a captain, with the wire tool', () => {
    let s = step(INITIAL_CANVAS, { type: 'tool', tool: 'wire' }).state;
    const refused = step(s, { type: 'down-node', nodeId: 'a1', screen: { x: 0, y: 0 }, canvas: { x: 0, y: 0 }, additive: false });
    expect(refused.effect).toEqual({ kind: 'refuse', reason: 'Start at a captain' });
    expect(refused.state.gesture.kind).toBe('idle');

    s = step(s, { type: 'down-node', nodeId: 'c', screen: { x: 10, y: 10 }, canvas: { x: 10, y: 10 }, additive: false }).state;
    s = step(s, { type: 'move', screen: { x: 0, y: 0 }, canvas: { x: 850, y: 240 } }).state;
    expect(s.gesture).toMatchObject({ kind: 'wire', fromId: 'c', over: 'l', to: { x: 850, y: 240 } });
    const up = step(s, { type: 'up' });
    expect(up.effect).toEqual({ kind: 'wire', fromId: 'c', toId: 'l' });
    // The tool stays, for the next wire.
    expect(up.state.tool).toBe('wire');
  });

  it('pans on empty canvas, and an unmoved click there clears the selection', () => {
    const selected = { ...INITIAL_CANVAS, selection: { nodes: ['a1'], wire: null } };
    let s = step(selected, { type: 'down-empty', screen: { x: 100, y: 100 }, view: VIEW }).state;
    const moved = step(s, { type: 'move', screen: { x: 130, y: 90 }, canvas: { x: 0, y: 0 } });
    expect(moved.effect).toEqual({ kind: 'view', view: { scale: 1, x: 30, y: -10 } });
    expect(step(moved.state, { type: 'up' }).state.selection.nodes).toEqual(['a1']);

    s = step(selected, { type: 'down-empty', screen: { x: 100, y: 100 }, view: VIEW }).state;
    expect(step(s, { type: 'up' }).state.selection).toEqual(NO_SELECTION);
  });

  it('selects a wire with the select tool', () => {
    const s = step(INITIAL_CANVAS, { type: 'down-wire', wireId: 'w' }).state;
    expect(s.selection).toEqual({ nodes: [], wire: 'w' });
  });

  it('escapes a gesture, then the tool, then the selection', () => {
    let s: CanvasState = { tool: 'wire', selection: { nodes: ['a1'], wire: null }, gesture: { kind: 'wire', fromId: 'c', to: { x: 0, y: 0 }, over: null } };
    s = step(s, { type: 'escape' }).state;
    expect(s.gesture.kind).toBe('idle');
    expect(s.tool).toBe('wire');
    s = step(s, { type: 'escape' }).state;
    expect(s.tool).toBe('select');
    s = step(s, { type: 'escape' }).state;
    expect(s.selection).toEqual(NO_SELECTION);
  });

  it('lets a cancelled pointer end a drag without a drop', () => {
    let s = step(INITIAL_CANVAS, { type: 'down-node', nodeId: 'l', screen: { x: 0, y: 0 }, canvas: { x: 0, y: 0 }, additive: false }).state;
    s = step(s, { type: 'move', screen: { x: 50, y: 50 }, canvas: { x: 0, y: 0 } }).state;
    const cancelled = step(s, { type: 'cancel' });
    expect(cancelled.effect).toBeNull();
    expect(cancelled.state.gesture.kind).toBe('idle');
  });
});
