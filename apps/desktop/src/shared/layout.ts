/**
 * The window's widths, and the one rule that relates them.
 *
 * These numbers used to live in four places that had to agree by luck: the
 * stylesheet held the reading measure, the shell held the projects panel's
 * default width, the session room held the desk's, and the main process held
 * the window's. Nothing connected them, so the layout's actual promise — that
 * opening a panel never re-wraps the conversation — was true only by
 * coincidence, and stopped being true the first time one of the four moved.
 *
 * So the promise is stated here, as arithmetic, and `layout.test.ts` asserts
 * it. Everything else reads these.
 *
 * **The promise.** The measure is a function of the *window*, and of nothing
 * else. It is exactly the room left when both panels are out:
 *
 *     MEASURE(w) = clamp(MIN, w - PANEL_LEFT - PANEL_RIGHT - GUTTER * 2, MAX)
 *
 * Two things follow, and they are the two things that were wanted.
 *
 * **It never re-wraps.** Nothing in that expression mentions whether a panel
 * is open, so opening one cannot change how the text is set. It can only
 * change where the column sits: with both panels away the measure is centred
 * with slack either side, and a panel opens into that slack. A line that was
 * not wrapped stays unwrapped, including the lines already on screen.
 *
 * **It is tight.** A fixed measure turns every extra pixel of window into
 * gutter — at 1515 wide, a 580px column left about 150px of nothing on each
 * side of the text *and* the panels. Sizing it from the window instead means
 * the conversation fills the room the panels leave, at any window size, and
 * the only slack is the slack the panels will take.
 */

/**
 * The application band, and the space macOS holds inside it.
 *
 * Here rather than in the stylesheet because these are not only CSS: the main
 * process positions the real traffic lights from them, and three separate
 * rules key off the band's height — the shell's first grid row, the sidebar's
 * top inset, and where the resize edge begins. A number in that many places is
 * the drift `--measure` was brought here to stop, and the band had been left
 * behind in CSS.
 */
export const CHROME_HEIGHT = 56;

/** macOS's own buttons: three of them, and where the first one starts. */
const TRAFFIC_LIGHT_SIZE = 12;
const TRAFFIC_LIGHT_COUNT = 3;
const TRAFFIC_LIGHT_GAP = 8;
export const TRAFFIC_LIGHT_X = 18;

/** Deliberate room between the last of them and the application's own first control. */
const CHROME_BREATHING = 16;

/** Where the buttons end. */
export const TRAFFIC_LIGHT_END =
  TRAFFIC_LIGHT_X +
  TRAFFIC_LIGHT_SIZE * TRAFFIC_LIGHT_COUNT +
  TRAFFIC_LIGHT_GAP * (TRAFFIC_LIGHT_COUNT - 1);

/** What the band leaves alone on the left, in a window. */
export const TRAFFIC_LIGHTS = TRAFFIC_LIGHT_END + CHROME_BREATHING;

/** Centred in the band, which is the only reason this number is what it is. */
export const TRAFFIC_LIGHT_Y = Math.round((CHROME_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2);

/** The projects panel, at rest. */
export const PANEL_LEFT = 268;
/** The workbench, at rest. */
export const PANEL_RIGHT = 352;

/** The breathing room either side of the measure, inside the room. */
export const ROOM_GUTTER = 40;

/**
 * How far the measure may be stretched, and how far it may be squeezed.
 *
 * The ceiling is typographic and not structural: past about this width a line
 * of prose is hard to track back to the start of, however much room there is,
 * so a very wide monitor gets margins rather than an unreadable column. The
 * floor is where the conversation stops being worth showing beside the desk —
 * `NARROW_PANE` is derived from it, so the desk takes the pane at exactly the
 * width where the two would otherwise start fighting.
 */
export const MEASURE_MIN = 480;
export const MEASURE_MAX = 920;

/** Everything the room spends on something other than the measure. */
export const ROOM_OVERHEAD = PANEL_LEFT + PANEL_RIGHT + ROOM_GUTTER * 2;

/**
 * The measure, as CSS, from the viewport alone.
 *
 * `100vw` and not `100%` is the whole point: a percentage would resolve
 * against the column the measure is in, which shrinks when a panel opens —
 * that is precisely the re-wrap this exists to prevent. The viewport does not
 * care what is open.
 */
export const MEASURE_CSS =
  `clamp(${MEASURE_MIN}px, calc(100vw - ${ROOM_OVERHEAD}px), ${MEASURE_MAX}px)`;

/** What the measure resolves to at a given window width. */
export function measureAt(windowWidth: number): number {
  return Math.min(MEASURE_MAX, Math.max(MEASURE_MIN, windowWidth - ROOM_OVERHEAD));
}

/** What the window opens at. Wide enough that the measure starts generous. */
export const WINDOW_WIDTH = 1440;
export const WINDOW_HEIGHT = 900;

/**
 * How narrow the window may be dragged.
 *
 * Derived from the promise with one panel open rather than two: the projects
 * panel is the one usually out, so the guarantee that has to hold at every
 * allowed size is that *it* never re-wraps the conversation. Both panels at
 * once needs more room, and below that the desk gives way instead — see
 * `NARROW_PANE`.
 */
export const WINDOW_MIN_WIDTH =
  PANEL_LEFT + MEASURE_MIN + ROOM_GUTTER * 2 + 12;
export const WINDOW_MIN_HEIGHT = 560;

/** How far the projects panel may be dragged, and when it closes instead. */
export const PANEL_LEFT_MIN = 216;
export const PANEL_LEFT_MAX = 420;
export const PANEL_LEFT_CLOSE_AT = 150;

/** The same, for the desk. */
export const PANEL_RIGHT_MIN = 320;
export const PANEL_RIGHT_MAX = 620;
export const PANEL_RIGHT_CLOSE_AT = 180;

/**
 * Below this the pane cannot hold the measure beside the desk.
 *
 * The desk takes the pane rather than the conversation being squeezed under
 * its own floor — the one case where something has to give, and the answer is
 * that the text keeps a readable width and the layout changes shape around it.
 *
 * It is the floor plus the desk, which is exactly the window width at which
 * the fluid measure stops being able to absorb the desk on its own.
 */
export const NARROW_PANE = MEASURE_MIN + ROOM_GUTTER * 2 + PANEL_RIGHT;
