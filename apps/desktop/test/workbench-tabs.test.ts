import { describe, expect, it } from 'vitest';

import {
  idAfterClose,
  nextTabFocus,
  scrollEdges,
} from '../src/renderer/state/workbench-tabs.js';

describe('Tab strip — where the fades go', () => {
  it('says nothing when everything fits', () => {
    expect(scrollEdges(0, 300, 300)).toEqual({ start: false, end: false });
  });

  it('fades only to the right at the start', () => {
    expect(scrollEdges(0, 900, 300)).toEqual({ start: false, end: true });
  });

  it('fades both ways in the middle', () => {
    expect(scrollEdges(300, 900, 300)).toEqual({ start: true, end: true });
  });

  it('fades only to the left at the end', () => {
    expect(scrollEdges(600, 900, 300)).toEqual({ start: true, end: false });
  });

  /** A scroller dragged to its end routinely lands a fraction short. */
  it('does not leave a fade standing on a sub-pixel remainder', () => {
    expect(scrollEdges(599.4, 900, 300)).toEqual({ start: true, end: false });
    expect(scrollEdges(0.7, 900, 300).start).toBe(false);
  });
});

describe('Tab strip — which tab takes the view', () => {
  const ids = ['a', 'b', 'c'];

  it('leaves the view alone when the closed tab was not in front', () => {
    expect(idAfterClose(ids, 'a', 'c')).toBe('c');
  });

  it('falls to the neighbour on the right', () => {
    expect(idAfterClose(ids, 'b', 'b')).toBe('c');
  });

  it('falls to the left when there is nothing on the right', () => {
    expect(idAfterClose(ids, 'c', 'c')).toBe('b');
  });

  it('falls to nothing when the last tab closes', () => {
    expect(idAfterClose(['a'], 'a', 'a')).toBeNull();
  });

  it('ignores a tab that is not there', () => {
    expect(idAfterClose(ids, 'nope', 'a')).toBe('a');
  });
});

describe('Tab strip — arrow keys', () => {
  const ids = ['a', 'b', 'c'];

  it('moves along the strip and wraps at both ends', () => {
    expect(nextTabFocus(ids, 'a', 'ArrowRight')).toBe('b');
    expect(nextTabFocus(ids, 'c', 'ArrowRight')).toBe('a');
    expect(nextTabFocus(ids, 'a', 'ArrowLeft')).toBe('c');
    expect(nextTabFocus(ids, 'b', 'ArrowLeft')).toBe('a');
  });

  it('jumps to the ends', () => {
    expect(nextTabFocus(ids, 'b', 'Home')).toBe('a');
    expect(nextTabFocus(ids, 'b', 'End')).toBe('c');
  });

  it('starts from the left when nothing is focused', () => {
    expect(nextTabFocus(ids, null, 'ArrowRight')).toBe('a');
    expect(nextTabFocus(ids, null, 'ArrowLeft')).toBe('c');
  });

  it('is a single tab going nowhere', () => {
    expect(nextTabFocus(['a'], 'a', 'ArrowRight')).toBe('a');
  });

  it('answers with nothing for an empty strip or a key it does not own', () => {
    expect(nextTabFocus([], null, 'ArrowRight')).toBeNull();
    expect(nextTabFocus(ids, 'a', 'PageDown')).toBeNull();
  });
});
