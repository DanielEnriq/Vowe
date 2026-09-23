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
 *
 * **And it stops.** The promise is paid for in reserved width, and there is a
 * window size below which the reserve is most of the window: at half a screen
 * the expression floors at `MEASURE_MIN` and sets a 480px column in a 760px
 * room, holding back two panels' worth of space for panels that are not open
 * and, at that size, cannot both be. So below `MEASURE_FILLS_BELOW` the
 * measure is the pane instead — see `MEASURE_FILL_CSS`. The promise is a
 * wide-window promise, and the threshold is the exact width at which it stops
 * being one.
 */

/*
 * The application band, and the space macOS holds inside it.
 *
 * Here rather than in the stylesheet because these are not only CSS: the main
 * process positions the real traffic lights from them, and three separate
 * rules key off the band's height — the shell's first grid row, the sidebar's
 * top inset, and where the resize edge begins. A number in that many places is
 * the drift `--measure` was brought here to stop, and the band had been left
 * behind in CSS.
 */

/** macOS's own buttons: three of them, and where the first one starts. */
const TRAFFIC_LIGHT_SIZE = 12;
const TRAFFIC_LIGHT_COUNT = 3;
const TRAFFIC_LIGHT_GAP = 8;
export const TRAFFIC_LIGHT_X = 18;

/**
 * Above and below the buttons.
 *
 * Enough that Vowe's own 26px controls clear the band's edges by the same
 * margin the lights do — the row holds both or it holds neither.
 */
const TRAFFIC_LIGHT_BREATHING = 20;

/**
 * The band's height, sized to what macOS puts in it rather than to a round
 * number.
 *
 * At 56 the band was half again as tall as the traffic lights' own row, which
 * read as a separate storey above the work — and it was, until the
 * workbench's tabs moved onto it. It is now the buttons' row: the lights, the
 * panel toggles and the tab strip on one line.
 */
export const CHROME_HEIGHT = TRAFFIC_LIGHT_SIZE + 2 * TRAFFIC_LIGHT_BREATHING;

/**
 * The band's glyphs draw a 10-unit body inside a 16-unit box — the panel
 * toggles' rectangle, the `+`'s cross. Both, so this is the family's shape
 * rather than one icon's accident.
 */
const ICON_VIEWBOX = 16;
const ICON_BODY = 10;

/**
 * What everything on the band measures, seen rather than boxed.
 *
 * The traffic lights are 12px, a glyph's drawn shape is 12px, and the session
 * title is set at 12px. One size along the row: the band reads as a single
 * line of things rather than a title with controls arranged around it.
 */
export const CHROME_BODY = TRAFFIC_LIGHT_SIZE;

/**
 * The box a band glyph is drawn in.
 *
 * Sized from the body outwards rather than picked: what has to match the
 * traffic lights is the part you can see, and the icon's box is half again
 * as tall as the shape inside it. Setting the box to 12 made the drawn
 * rectangle 7.5 and the glyphs read as small.
 *
 * The body is a hair under a light rather than equal to it. Drawn at a
 * light's own 12 the glyphs won on weight — a stroked outline the same height
 * as a filled disc reads as the larger of the two — so they come down by one
 * to sit level with them instead of over them.
 *
 * macOS owns the lights' own size. Nothing here changes it — this is Vowe's
 * icon meeting them.
 */
const GLYPH_BODY = 11;
export const CHROME_GLYPH = (GLYPH_BODY * ICON_VIEWBOX) / ICON_BODY;

/**
 * Deliberate room between the last of the lights and Vowe's first control —
 * and, because it is exported, the gap between Vowe's own band controls too.
 *
 * One light wide, and one measure along the row: the lights, then this, then
 * the sidebar toggle, then this again, then the pencil. Spacing that changes
 * halfway along a row of buttons reads as two groups that happen to be
 * adjacent, and a gap borrowed from the buttons' own size ties the row to
 * what macOS put at the start of it.
 */
export const CHROME_BREATHING = TRAFFIC_LIGHT_SIZE;

/**
 * The box a band control is drawn in — the toggles, the pencil, the `+`.
 *
 * Here rather than in the stylesheet alone because the left inset below is
 * computed from it: where the first control starts depends on how wide it is.
 */
export const CHROME_CONTROL = 26;

/** Where the buttons end. */
export const TRAFFIC_LIGHT_END =
  TRAFFIC_LIGHT_X +
  TRAFFIC_LIGHT_SIZE * TRAFFIC_LIGHT_COUNT +
  TRAFFIC_LIGHT_GAP * (TRAFFIC_LIGHT_COUNT - 1);

/**
 * A touch more than the arithmetic asks for.
 *
 * The centring below is right about the middles and still sits a shade tight
 * against the lights, because macOS's buttons are solid and Vowe's are
 * outlines with air inside them. Measured by eye, kept small, and named so it
 * is visibly a choice rather than a number that drifted into the sum.
 */
const CHROME_NUDGE = 4;

/** The middle of the last light, which is what the eye lines things up on. */
const LAST_LIGHT_CENTRE =
  TRAFFIC_LIGHT_X +
  TRAFFIC_LIGHT_SIZE * (TRAFFIC_LIGHT_COUNT - 1) +
  TRAFFIC_LIGHT_GAP * (TRAFFIC_LIGHT_COUNT - 1) +
  TRAFFIC_LIGHT_SIZE / 2;

/**
 * What the band leaves alone on the left, in a window.
 *
 * Placed so the sidebar toggle sits midway between the last light and the
 * pencil — centre to centre, not edge to edge. Equal *gaps* looked wrong
 * here, and for a reason: a light is 12px and a control is 26, so matching
 * the gaps pushes the toggle towards the lights by half the difference. What
 * the eye measures is the space between the middles of things.
 */
export const TRAFFIC_LIGHTS =
  LAST_LIGHT_CENTRE + CHROME_CONTROL / 2 + CHROME_BREATHING + CHROME_NUDGE;

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

/**
 * The other regime: the room, used.
 *
 * The promise above costs the width of both panels, held in reserve whether
 * they are open or not. That is worth paying while there is width to spare,
 * and below `MEASURE_FILLS_BELOW` there is not — the reserve becomes most of
 * the window, and a conversation in a half-screen window is set at its floor
 * with two panels' worth of nothing on either side of it. Which is the one
 * case where protecting the promise costs more than the promise is worth.
 *
 * So below that width the column simply takes the pane it is in, up to the
 * same typographic ceiling. `100%` rather than a viewport expression is the
 * whole of it: every box the measure is applied to sits inside the room's own
 * gutters already, so `100%` *is* the room minus its gutters, whatever is
 * open. The centring offset falls out at zero on its own.
 */
export const MEASURE_FILL_CSS = `min(100%, ${MEASURE_MAX}px)`;

/**
 * Where one regime becomes the other, and why it is not a taste.
 *
 * It is `PANEL_LEFT + NARROW_PANE` — the window width at which the desk can
 * no longer sit beside the conversation and takes the pane instead. Below it
 * there is no side-by-side left to protect: the desk replaces the
 * conversation rather than squeezing it, so the only panel that can still
 * re-wrap the text is the projects one, and at these widths a reflow when it
 * opens is the honest answer rather than a floor-width column in a wide room.
 *
 * Stated as the sum below because that is the form the arithmetic takes;
 * `layout.test.ts` asserts the two definitions are the same number.
 */
export const MEASURE_FILLS_BELOW = ROOM_OVERHEAD + MEASURE_MIN;

/** Which regime this window is in. */
export function measureFills(windowWidth: number): boolean {
  return windowWidth < MEASURE_FILLS_BELOW;
}

/** The expression the shell hands the stylesheet, for this window. */
export function measureCssFor(windowWidth: number): string {
  return measureFills(windowWidth) ? MEASURE_FILL_CSS : MEASURE_CSS;
}

/**
 * What the measure resolves to.
 *
 * Above the threshold the pane is not consulted, because that is exactly what
 * the promise means. Below it, it is the only thing consulted.
 */
export function measureAt(windowWidth: number, paneWidth: number = windowWidth): number {
  if (measureFills(windowWidth)) {
    return Math.min(MEASURE_MAX, paneWidth - ROOM_GUTTER * 2);
  }
  return Math.min(MEASURE_MAX, Math.max(MEASURE_MIN, windowWidth - ROOM_OVERHEAD));
}

/** What the window opens at. Wide enough that the measure starts generous. */
export const WINDOW_WIDTH = 1440;
export const WINDOW_HEIGHT = 900;

/**
 * How narrow the window may be dragged.
 *
 * Derived from the projects panel, which is the one usually out: at the
 * narrowest the window may be dragged, the pane that panel leaves still holds
 * a floor-width measure with its gutters. That is what keeps the filling
 * regime from filling with something too narrow to read — the floor is
 * enforced by the window's own minimum rather than by a clamp the pane would
 * then overflow.
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
