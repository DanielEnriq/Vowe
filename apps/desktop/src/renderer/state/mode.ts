import type { FleetTab } from '../fleet/types.js';
import { FLEET_TABS, type Route } from './navigation.js';

/**
 * Which of the two apps the window is: Vowe, which watches and answers, or
 * Fleet, which runs agents. The route says which one you are in; this module
 * remembers where you were in each, so switching back lands there again.
 *
 * Kept in this viewer's storage only. Losing it is harmless: Vowe opens on its
 * usual landing and Fleet on its list of projects.
 */

export type AppMode = 'vowe' | 'fleet';

export interface ModeMemory {
  mode: AppMode;
  routes: Partial<Record<AppMode, Route>>;
}

const KEY = 'vowe.mode';

export const EMPTY_MODE_MEMORY: ModeMemory = { mode: 'vowe', routes: {} };

export function modeOf(route: Route): AppMode {
  return route.kind === 'fleet' || route.kind === 'fleet-agent' || route.kind === 'fleet-home' ? 'fleet' : 'vowe';
}

/** Where a mode opens when nothing is remembered for it. */
export function modeLanding(mode: AppMode): Route {
  return mode === 'fleet' ? { kind: 'fleet-home' } : { kind: 'none' };
}

/** The route is now where its mode is. Nowhere is not worth remembering. */
export function rememberRoute(memory: ModeMemory, route: Route): ModeMemory {
  const mode = modeOf(route);
  if (route.kind === 'none') return memory.mode === mode ? memory : { ...memory, mode };
  if (memory.mode === mode && memory.routes[mode] === route) return memory;
  return { mode, routes: { ...memory.routes, [mode]: route } };
}

/** Where switching to `mode` goes: the last place in it, else its landing. */
export function routeForMode(memory: ModeMemory, mode: AppMode): Route {
  const remembered = memory.routes[mode];
  return remembered && modeOf(remembered) === mode ? remembered : modeLanding(mode);
}

const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A stored route, if it is one this version understands. */
export function parseRoute(value: unknown): Route | null {
  if (!value || typeof value !== 'object') return null;
  const route = value as Record<string, unknown>;
  switch (route.kind) {
    case 'none':
    case 'presence':
    case 'fleet-home':
      return { kind: route.kind };
    case 'session':
      return string(route.sessionId) ? { kind: 'session', sessionId: route.sessionId } : null;
    case 'fleet':
      if (!string(route.projectId)) return null;
      return FLEET_TABS.includes(route.tab as FleetTab)
        ? { kind: 'fleet', projectId: route.projectId, tab: route.tab as FleetTab }
        : { kind: 'fleet', projectId: route.projectId };
    case 'fleet-agent':
      return string(route.projectId) && string(route.sessionId)
        ? { kind: 'fleet-agent', projectId: route.projectId, sessionId: route.sessionId }
        : null;
    case 'project': {
      if (!string(route.projectId)) return null;
      if (route.view === 'studio') {
        return string(route.designId)
          ? { kind: 'project', projectId: route.projectId, view: 'studio', designId: route.designId }
          : { kind: 'project', projectId: route.projectId, view: 'studio' };
      }
      // A conversation anchor is a moment, not a place: reopening lands on the project.
      return { kind: 'project', projectId: route.projectId };
    }
    default:
      return null;
  }
}

export function parseModeMemory(raw: string | null | undefined): ModeMemory {
  if (!raw) return EMPTY_MODE_MEMORY;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode: AppMode = parsed?.mode === 'fleet' ? 'fleet' : 'vowe';
    const stored = (parsed?.routes ?? {}) as Record<string, unknown>;
    const routes: Partial<Record<AppMode, Route>> = {};
    for (const key of ['vowe', 'fleet'] as const) {
      const route = parseRoute(stored[key]);
      if (route && modeOf(route) === key) routes[key] = route;
    }
    return { mode, routes };
  } catch {
    return EMPTY_MODE_MEMORY;
  }
}

export function readModeMemory(): ModeMemory {
  try {
    return parseModeMemory(window.localStorage?.getItem(KEY));
  } catch {
    return EMPTY_MODE_MEMORY;
  }
}

export function writeModeMemory(memory: ModeMemory): void {
  try {
    window.localStorage?.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Not kept: the next launch opens on the landing instead.
  }
}
