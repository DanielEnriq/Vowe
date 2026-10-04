import { describe, expect, it } from 'vitest';

import type { FleetLayout, FleetRect } from '@vowe/core';
import {
  FLEET_GAP,
  FLEET_NODE_WIDTH,
  addNode,
  captainOf,
  clusterOf,
  clusterRect,
  emptyFleetLayout,
  nodeRect,
} from '@vowe/core/fleet-model';

import {
  applyRun,
  buildRunPlan,
  launchFailureText,
  placeRow,
  runButtonLabel,
  runProviders,
} from '../src/renderer/state/fleet-run.js';

const choices = {
  task: '  Split the retry policy  ',
  mode: 'parallel' as const,
  parallelCount: 3 as const,
  provider: 'claude-code',
  folder: '/code/payments-api',
  captainId: 'c',
};

function overlaps(a: FleetRect, b: FleetRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function crowded(): FleetLayout {
  let layout = emptyFleetLayout();
  layout = addNode(layout, { id: 'c', sessionId: 'sc', role: 'captain', x: 0, y: 0 }).layout;
  layout = addNode(layout, { id: 'x', sessionId: 'sx', x: 400, y: 0 }).layout;
  return layout;
}

describe('A run plan', () => {
  it('launches the parallel count, or one for a single agent, with the task trimmed', () => {
    expect(buildRunPlan(choices)).toEqual({
      task: 'Split the retry policy',
      mode: 'parallel',
      count: 3,
      provider: 'claude-code',
      folder: '/code/payments-api',
      captainId: 'c',
    });
    expect(buildRunPlan({ ...choices, mode: 'single' })?.count).toBe(1);
  });

  it('cannot run without a task, a folder or an agent', () => {
    expect(buildRunPlan({ ...choices, task: '   ' })).toBeNull();
    expect(buildRunPlan({ ...choices, folder: '' })).toBeNull();
    expect(buildRunPlan({ ...choices, provider: '' })).toBeNull();
  });

  it('labels the button with what it will start', () => {
    expect(runButtonLabel('parallel', 5)).toBe('Run 5');
    expect(runButtonLabel('single', 5)).toBe('Run 1');
  });

  it('offers what can launch, or Claude Code alone when nothing was said', () => {
    expect(runProviders(['claude-code', 'codex'])).toEqual(['claude-code', 'codex']);
    expect(runProviders([])).toEqual(['claude-code']);
    expect(runProviders(null)).toEqual(['claude-code']);
  });

  it('says how many started when some did not', () => {
    expect(launchFailureText(3, 3, null)).toBeNull();
    expect(launchFailureText(2, 3, 'No installed provider can start a new session.')).toBe(
      'Started 2 of 3. No installed provider can start a new session.',
    );
    expect(launchFailureText(0, 1, null)).toBe('Nothing started.');
  });
});

describe('Placing a run', () => {
  it('puts a row side by side starting at the origin of an empty canvas', () => {
    expect(placeRow(emptyFleetLayout(), 3)).toEqual([
      { x: 0, y: 0 },
      { x: FLEET_NODE_WIDTH + FLEET_GAP, y: 0 },
      { x: 2 * (FLEET_NODE_WIDTH + FLEET_GAP), y: 0 },
    ]);
  });

  it('never overlaps what is there, box and label included', () => {
    const layout = crowded();
    const spots = placeRow(layout, 3, { x: 0, y: 0 });
    expect(spots).toHaveLength(3);
    for (const spot of spots) {
      for (const node of layout.nodes) expect(overlaps(nodeRect(spot), nodeRect(node))).toBe(false);
    }
    const applied = applyRun(layout, { task: 't', mode: 'parallel', captainId: null }, ['a', 'b', 'c2'], { x: 0, y: 0 });
    const box = clusterRect(applied.layout.clusters[0]!, applied.layout.nodes)!;
    for (const node of layout.nodes) expect(overlaps(box, nodeRect(node))).toBe(false);
  });

  it('boxes parallel attempts with the task as brief, and wires each to the captain', () => {
    const { layout, nodeIds } = applyRun(crowded(), { task: 'Split it', mode: 'parallel', captainId: 'c' }, ['s1', 's2', 's3']);
    expect(nodeIds).toHaveLength(3);
    const cluster = clusterOf(layout, nodeIds[0]!)!;
    expect(cluster).toMatchObject({ brief: 'Split it', label: 'Parallel · 3', memberIds: nodeIds });
    for (const id of nodeIds) expect(captainOf(layout, id)?.id).toBe('c');
    // Nothing that was there moved.
    expect(layout.nodes.slice(0, 2)).toEqual(crowded().nodes);
  });

  it('leaves a single agent loose, and wires nothing for None', () => {
    const { layout, nodeIds } = applyRun(crowded(), { task: 't', mode: 'single', captainId: null }, ['s1']);
    expect(layout.clusters).toEqual([]);
    expect(layout.wires).toEqual([]);
    expect(nodeIds).toHaveLength(1);
  });

  it('boxes only what started: one survivor of a parallel run stays loose', () => {
    const { layout } = applyRun(crowded(), { task: 't', mode: 'parallel', captainId: 'c' }, ['s1']);
    expect(layout.clusters).toEqual([]);
    expect(layout.wires).toHaveLength(1);
  });

  it('keeps a session the canvas already placed where it is', () => {
    const before = addNode(crowded(), { id: 'early', sessionId: 's2', x: 900, y: 900 }).layout;
    const { layout, nodeIds } = applyRun(before, { task: 't', mode: 'parallel', captainId: null }, ['s1', 's2']);
    expect(nodeIds).toContain('early');
    expect(layout.nodes.find((node) => node.id === 'early')).toMatchObject({ x: 900, y: 900 });
    expect(layout.nodes.filter((node) => node.sessionId === 's2')).toHaveLength(1);
  });

  it('ignores a captain that is not on the canvas', () => {
    const { layout } = applyRun(crowded(), { task: 't', mode: 'single', captainId: 'gone' }, ['s1']);
    expect(layout.wires).toEqual([]);
  });

  it('changes nothing when nothing started', () => {
    const layout = crowded();
    expect(applyRun(layout, { task: 't', mode: 'parallel', captainId: 'c' }, []).layout).toBe(layout);
  });
});
