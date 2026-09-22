import { describe, expect, it } from 'vitest';

import {
  prune,
  toggleExpanded,
  withExpanded,
  withoutExpanded,
} from '../src/renderer/state/disclosure.js';

/**
 * The separation this file is about: expanding a project, selecting a project
 * and selecting a session are three different acts, and the sidebar used to
 * derive all three from the route.
 */
describe('Sidebar disclosure — projects expand independently', () => {
  it('keeps every project that was expanded expanded', () => {
    const expanded = withExpanded(withExpanded([], 'a'), 'b');
    expect(expanded).toEqual(['a', 'b']);
  });

  it('toggles one without touching the others', () => {
    expect(toggleExpanded(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(toggleExpanded(['a', 'c'], 'b')).toEqual(['a', 'c', 'b']);
  });

  it('treats expanding twice as one expansion', () => {
    expect(withExpanded(['a'], 'a')).toEqual(['a']);
  });

  it('collapsing something that was never open changes nothing', () => {
    expect(withoutExpanded(['a'], 'b')).toEqual(['a']);
  });

  /** A stored list that only ever grew would be a leak with a friendly name. */
  it('forgets projects that are no longer here', () => {
    expect(prune(['a', 'gone', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b']);
  });
});
