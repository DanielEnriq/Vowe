import { describe, expect, it } from 'vitest';

import {
  CHROME_HEIGHT,
  MEASURE_CSS,
  MEASURE_MAX,
  MEASURE_MIN,
  NARROW_PANE,
  PANEL_LEFT,
  PANEL_LEFT_MAX,
  PANEL_LEFT_MIN,
  PANEL_RIGHT,
  PANEL_RIGHT_MAX,
  PANEL_RIGHT_MIN,
  ROOM_GUTTER,
  TRAFFIC_LIGHTS,
  TRAFFIC_LIGHT_END,
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  WINDOW_MIN_WIDTH,
  WINDOW_WIDTH,
  measureAt,
} from '../src/shared/layout.js';

/** What the room has left for the conversation with these panels showing. */
const room = (window: number, left: boolean, right: boolean): number =>
  window - (left ? PANEL_LEFT : 0) - (right ? PANEL_RIGHT : 0);

/** The width the measure actually needs at this window size, gutters included. */
const needed = (window: number): number => measureAt(window) + ROOM_GUTTER * 2;

/** Every window width worth asserting about, including both clamp corners. */
const WIDTHS = [WINDOW_MIN_WIDTH, 1180, 1280, WINDOW_WIDTH, 1512, 1728, 2560];

describe('Layout — the measure follows the window, never the panels', () => {
  /**
   * The whole point. The measure is a function of the viewport alone, so
   * opening a panel cannot change how the text is set — only where it sits.
   */
  it('is the same width in all four panel states, at every window size', () => {
    for (const width of WIDTHS) {
      const widths = new Set(
        [
          [true, true],
          [true, false],
          [false, true],
          [false, false],
        ].map(() => measureAt(width)),
      );
      expect({ width, distinct: widths.size }).toEqual({ width, distinct: 1 });
    }
  });

  /**
   * Tight: the measure is exactly the room both panels leave, so the only
   * slack in the window is the slack the panels will take. This is what a
   * fixed measure could not do — every pixel of window past its own width
   * became gutter.
   */
  it('fills the room both panels leave, once the window is wide enough', () => {
    for (const width of [1280, WINDOW_WIDTH, 1512]) {
      expect({ width, spare: room(width, true, true) - needed(width) }).toEqual({
        width,
        spare: 0,
      });
    }
  });

  /** And with the panels away, that same column is centred in what is left. */
  it('leaves the panels’ worth of slack when they are away', () => {
    const spare = room(WINDOW_WIDTH, false, false) - needed(WINDOW_WIDTH);
    expect(spare).toBe(PANEL_LEFT + PANEL_RIGHT);
  });

  /** Nothing ever needs more room than it has, in any state, at any size. */
  it('never asks for more room than the state leaves it', () => {
    for (const width of WIDTHS) {
      for (const left of [true, false]) {
        for (const right of [true, false]) {
          // The desk takes the pane below this rather than sharing it.
          if (right && width - (left ? PANEL_LEFT : 0) < NARROW_PANE) continue;
          expect({ width, left, right, short: needed(width) - room(width, left, right) })
            .toMatchObject({ short: expect.any(Number) });
          expect(needed(width)).toBeLessThanOrEqual(room(width, left, right));
        }
      }
    }
  });

  it('clamps rather than growing without limit', () => {
    expect(measureAt(400)).toBe(MEASURE_MIN);
    expect(measureAt(4000)).toBe(MEASURE_MAX);
    expect(measureAt(WINDOW_WIDTH)).toBeGreaterThan(MEASURE_MIN);
    expect(measureAt(WINDOW_WIDTH)).toBeLessThan(MEASURE_MAX);
  });

  /**
   * The CSS and the arithmetic are the same expression. A test that checked
   * only the numbers would not notice the stylesheet drifting away from them.
   */
  it('hands CSS the same expression it computes here', () => {
    expect(MEASURE_CSS).toBe(
      `clamp(${MEASURE_MIN}px, calc(100vw - ${
        PANEL_LEFT + PANEL_RIGHT + ROOM_GUTTER * 2
      }px), ${MEASURE_MAX}px)`,
    );
  });

  /**
   * The projects panel is the one usually out, so its guarantee has to hold at
   * every size the window is allowed to be — not only at the default.
   */
  it('holds for the projects panel at the narrowest allowed window', () => {
    expect(needed(WINDOW_MIN_WIDTH)).toBeLessThanOrEqual(
      room(WINDOW_MIN_WIDTH, true, false),
    );
  });

  /**
   * Below this the desk takes the pane instead of the conversation being
   * squeezed under its floor, so the breakpoint has to be exactly the width at
   * which the two stop fitting side by side.
   */
  it('switches the desk to the whole pane exactly when the two stop fitting', () => {
    expect(NARROW_PANE).toBe(MEASURE_MIN + ROOM_GUTTER * 2 + PANEL_RIGHT);
    // One pixel wider and they fit; one narrower and they do not.
    const window = PANEL_LEFT + NARROW_PANE;
    expect(needed(window)).toBeLessThanOrEqual(room(window, true, true));
    expect(needed(window - 1)).toBeGreaterThan(room(window - 1, true, true));
  });

  it('keeps every dragged width inside its own bounds', () => {
    expect(PANEL_LEFT).toBeGreaterThanOrEqual(PANEL_LEFT_MIN);
    expect(PANEL_LEFT).toBeLessThanOrEqual(PANEL_LEFT_MAX);
    expect(PANEL_RIGHT).toBeGreaterThanOrEqual(PANEL_RIGHT_MIN);
    expect(PANEL_RIGHT).toBeLessThanOrEqual(PANEL_RIGHT_MAX);
  });
});

/** macOS's buttons are 12px tall; nothing else here needs to know that. */
const TRAFFIC_LIGHT_SIZE = 12;

describe('Layout — the band and the window agree about macOS', () => {
  /**
   * The main process positions the real traffic lights and the stylesheet
   * positions everything around them. They are the same two numbers or they
   * are a drift waiting to happen — the band's height alone is keyed off by
   * three separate rules.
   */
  it('centres the traffic lights in the band', () => {
    const top = TRAFFIC_LIGHT_Y;
    const bottom = CHROME_HEIGHT - (TRAFFIC_LIGHT_Y + TRAFFIC_LIGHT_SIZE);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
  });

  it('leaves the buttons alone, with room to spare', () => {
    expect(TRAFFIC_LIGHTS).toBeGreaterThan(TRAFFIC_LIGHT_END);
    expect(TRAFFIC_LIGHT_END).toBeGreaterThan(TRAFFIC_LIGHT_X);
    // Deliberate breathing room, not a rounding accident.
    expect(TRAFFIC_LIGHTS - TRAFFIC_LIGHT_END).toBeGreaterThanOrEqual(12);
  });

  /** The band has to be taller than what macOS puts in it. */
  it('is tall enough to hold them', () => {
    expect(CHROME_HEIGHT).toBeGreaterThan(TRAFFIC_LIGHT_SIZE * 2);
  });
});
