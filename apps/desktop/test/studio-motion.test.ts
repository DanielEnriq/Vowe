import { describe, expect, it } from 'vitest';

import { applyOps, EMPTY_MODEL } from '@vowe/core/studio-model';

import { canvasChanges, NO_CHANGES } from '../src/renderer/state/studio-motion.js';

const BASE = applyOps(EMPTY_MODEL, [
  { op: 'part', id: 'api', name: 'API', role: 'Takes requests' },
  { op: 'part', id: 'store', name: 'Store', role: 'Keeps links' },
  { op: 'link', from: 'api', to: 'store', label: 'writes' },
  { op: 'duty', id: 'expire', part: 'api', text: 'Expires old links' },
]).model;

describe('what a change feels like', () => {
  it('materializes a first drawing along its own flow, with its lines drawing in', () => {
    const changes = canvasChanges(null, BASE);
    expect(changes.entering).toEqual(['api', 'store']);
    expect([...changes.drawn]).toEqual(['api->store']);
    expect(changes.touched.size).toBe(0);
  });

  it('orders arrivals so a part arrives before what it feeds', () => {
    const reversed = applyOps(EMPTY_MODEL, [
      { op: 'part', id: 'store', name: 'Store', role: '' },
      { op: 'part', id: 'api', name: 'API', role: '' },
      { op: 'part', id: 'edge', name: 'Edge', role: '' },
      { op: 'link', from: 'edge', to: 'api' },
      { op: 'link', from: 'api', to: 'store' },
    ]).model;
    expect(canvasChanges(null, reversed).entering).toEqual(['edge', 'api', 'store']);
  });

  it('glows a renamed part once, and nothing else', () => {
    const renamed = applyOps(BASE, [{ op: 'part', id: 'api', name: 'Public API' }]).model;
    const changes = canvasChanges(BASE, renamed);
    expect([...changes.touched]).toEqual(['api']);
    expect(changes.entering).toEqual([]);
  });

  it('lets a removed part leave from where it stood', () => {
    const removed = applyOps(BASE, [{ op: 'remove', id: 'store' }]).model;
    const changes = canvasChanges(BASE, removed);
    expect(changes.leaving.map((part) => part.id)).toEqual(['store']);
  });

  it('flies a responsibility from the part it left to the part that took it', () => {
    const moved = applyOps(BASE, [{ op: 'duty', id: 'expire', part: 'store' }]).model;
    const changes = canvasChanges(BASE, moved);
    expect(changes.moved).toEqual([expect.objectContaining({ from: 'api', to: 'store' })]);
    expect([...changes.touched].sort()).toEqual(['api', 'store']);
  });

  it('draws in a new link between parts that were already there', () => {
    const linked = applyOps(BASE, [{ op: 'link', from: 'store', to: 'api', label: 'notifies' }]).model;
    const changes = canvasChanges(BASE, linked);
    expect([...changes.drawn]).toEqual(['store->api']);
    expect(changes.entering).toEqual([]);
  });

  it('feels nothing when only what is invisible changed — a preview becoming its revision', () => {
    const explained = applyOps(BASE, [{ op: 'part', id: 'api', detail: 'Because the edge must stay stateless.' }]).model;
    expect(canvasChanges(BASE, explained)).toBe(NO_CHANGES);
    expect(canvasChanges(BASE, BASE)).toBe(NO_CHANGES);
  });
});
