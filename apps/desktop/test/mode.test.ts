import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMPTY_MODE_MEMORY,
  modeOf,
  parseModeMemory,
  parseRoute,
  readModeMemory,
  rememberRoute,
  routeForMode,
  writeModeMemory,
} from '../src/renderer/state/mode.js';

describe('Vowe and Fleet', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the mode from the route', () => {
    expect(modeOf({ kind: 'none' })).toBe('vowe');
    expect(modeOf({ kind: 'session', sessionId: 's' })).toBe('vowe');
    expect(modeOf({ kind: 'project', projectId: 'p', view: 'conversation' })).toBe('vowe');
    expect(modeOf({ kind: 'presence' })).toBe('vowe');
    expect(modeOf({ kind: 'fleet-home' })).toBe('fleet');
    expect(modeOf({ kind: 'fleet', projectId: 'p' })).toBe('fleet');
    expect(modeOf({ kind: 'fleet-agent', projectId: 'p', sessionId: 's' })).toBe('fleet');
  });

  it('switching restores where each mode was left', () => {
    let memory = rememberRoute(EMPTY_MODE_MEMORY, { kind: 'session', sessionId: 's' });
    memory = rememberRoute(memory, { kind: 'fleet-agent', projectId: 'p', sessionId: 'a' });
    expect(memory.mode).toBe('fleet');
    expect(routeForMode(memory, 'vowe')).toEqual({ kind: 'session', sessionId: 's' });
    expect(routeForMode(memory, 'fleet')).toEqual({ kind: 'fleet-agent', projectId: 'p', sessionId: 'a' });
  });

  it('opens a mode on its landing when nothing is remembered for it', () => {
    expect(routeForMode(EMPTY_MODE_MEMORY, 'fleet')).toEqual({ kind: 'fleet-home' });
    expect(routeForMode(EMPTY_MODE_MEMORY, 'vowe')).toEqual({ kind: 'none' });
  });

  it('does not overwrite a remembered place with nowhere', () => {
    const memory = rememberRoute(EMPTY_MODE_MEMORY, { kind: 'project', projectId: 'p' });
    const after = rememberRoute(memory, { kind: 'none' });
    expect(after).toBe(memory);
    expect(routeForMode(after, 'vowe')).toEqual({ kind: 'project', projectId: 'p' });
  });

  it('round-trips through storage, and treats anything unreadable as nothing', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
    });
    let memory = rememberRoute(EMPTY_MODE_MEMORY, { kind: 'project', projectId: 'p', view: 'studio', designId: 'd' });
    memory = rememberRoute(memory, { kind: 'fleet', projectId: 'p', tab: 'questions' });
    writeModeMemory(memory);
    expect(readModeMemory()).toEqual(memory);

    expect(parseModeMemory('{nope')).toEqual(EMPTY_MODE_MEMORY);
    expect(parseModeMemory(JSON.stringify({ mode: 'other', routes: { vowe: { kind: 'fleet-home' }, fleet: { kind: 'fleet', projectId: 7 } } })))
      .toEqual(EMPTY_MODE_MEMORY);
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
      },
    });
    expect(readModeMemory()).toEqual(EMPTY_MODE_MEMORY);
    expect(() => writeModeMemory(EMPTY_MODE_MEMORY)).not.toThrow();
  });

  it('keeps only routes it understands, and drops a conversation anchor', () => {
    expect(parseRoute({ kind: 'project', projectId: 'p', view: 'conversation', entryId: 'e' })).toEqual({ kind: 'project', projectId: 'p' });
    expect(parseRoute({ kind: 'fleet', projectId: 'p', tab: 'odd' })).toEqual({ kind: 'fleet', projectId: 'p' });
    expect(parseRoute({ kind: 'fleet-agent', projectId: 'p' })).toBeNull();
    expect(parseRoute({ kind: 'elsewhere' })).toBeNull();
    expect(parseRoute(null)).toBeNull();
  });
});
