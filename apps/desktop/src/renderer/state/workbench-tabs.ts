/**
 * The parts of the tab strip that are arithmetic rather than markup.
 *
 * Extracted so the behaviour a strip most often gets wrong — which tab takes
 * the view when one closes, where an arrow key lands at the end of the row —
 * is stated once and tested without a window.
 */

export interface ScrollEdges {
  /** There is more strip to the left of what is visible. */
  start: boolean;
  /** There is more to the right. */
  end: boolean;
}

/**
 * Where the fades go.
 *
 * A sliver of slack, because a scroller that has been dragged to its end
 * routinely lands a fraction of a pixel short and a fade that never quite
 * retires reads as a rendering fault.
 */
export function scrollEdges(
  scrollStart: number,
  scrollSize: number,
  clientSize: number,
  sliver = 2,
): ScrollEdges {
  return {
    start: scrollStart > sliver,
    end: scrollStart + clientSize < scrollSize - sliver,
  };
}

/**
 * Which tab the view falls to when one closes.
 *
 * The neighbour to the right, else the left, else nothing. Right first because
 * the strip is chronological: the newer thing is usually what the closed tab
 * was on the way towards. Closing a tab that was not in front changes nothing.
 */
export function idAfterClose(
  ids: readonly string[],
  closedId: string,
  activeId: string | null,
): string | null {
  const index = ids.indexOf(closedId);
  if (index === -1) return activeId;
  if (activeId !== closedId) return activeId;
  const remaining = ids.filter((id) => id !== closedId);
  return remaining[index] ?? remaining[index - 1] ?? null;
}

/**
 * Where an arrow key moves focus. Wraps, because a strip that scrolls is a
 * loop to the hand even when it is a line on the screen.
 */
export function nextTabFocus(
  ids: readonly string[],
  currentId: string | null,
  key: string,
): string | null {
  if (!ids.length) return null;
  const at = currentId ? ids.indexOf(currentId) : -1;
  switch (key) {
    case 'ArrowRight':
      return ids[(at + 1) % ids.length] ?? null;
    case 'ArrowLeft':
      return ids[(at <= 0 ? ids.length : at) - 1] ?? null;
    case 'Home':
      return ids[0] ?? null;
    case 'End':
      return ids[ids.length - 1] ?? null;
    default:
      return null;
  }
}
