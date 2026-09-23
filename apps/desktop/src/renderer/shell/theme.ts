import { useEffect, useState } from 'react';

/**
 * Which appearance the window is actually in, right now.
 *
 * Resolved, never preferred: `system`, `dark` and `light` are the developer's
 * *setting*, which lives in the main process and is handed to Electron's
 * `nativeTheme`. Chromium then answers `prefers-color-scheme` accordingly, so
 * by the time anything here runs the question "is this window light?" has one
 * true answer and it is the platform's. Asking the media query rather than the
 * stored preference is what makes `system` keep working after the choice is
 * made — including macOS switching itself at dusk.
 *
 * The stylesheet does not use this. It reads `data-theme` on the document
 * element, which `index.html` sets from the same query before anything paints;
 * this is for the parts of the appearance that are not CSS, which is Vowe's
 * presence — drawn with WebGL and with a point lattice, neither of which a
 * custom property can reach into.
 */
export type ResolvedTheme = 'dark' | 'light';

const LIGHT = '(prefers-color-scheme: light)';

export function resolvedTheme(): ResolvedTheme {
  return window.matchMedia?.(LIGHT).matches ? 'light' : 'dark';
}

/** True when Vowe is being drawn on paper rather than on a dark surface. */
export function useOnLight(): boolean {
  const [onLight, setOnLight] = useState(() => resolvedTheme() === 'light');

  useEffect(() => {
    const query = window.matchMedia?.(LIGHT);
    if (!query) return;
    const handler = (event: MediaQueryListEvent): void => setOnLight(event.matches);
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }, []);

  return onLight;
}

/**
 * The developer's system-wide answer to "how much movement?", watched live.
 *
 * Asked by everything that moves on its own: the presence, and any text that
 * scrolls itself to be read. Somebody who has turned motion down has not
 * asked for a quieter version of it — they have asked for none, and both
 * callers here simply do not move.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const handler = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }, []);

  return reduced;
}
