/**
 * The colour the window is before the renderer has painted anything.
 *
 * Electron fills the frame with this while the page loads, so it has one job:
 * be the colour the page is about to be. These are `--pane` in each
 * appearance — the room's surface, which is the largest area of the window in
 * every state — and they are the one pair of values that must be kept in step
 * with `styles.css` by hand. A mismatch is not a bug anyone can see in a
 * screenshot; it is a flash on launch, which is the thing this exists to stop.
 */
export const WINDOW_BACKGROUND = {
  dark: '#0e0f11',
  light: '#faf9f7',
} as const;
