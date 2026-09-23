import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { usePrefersReducedMotion } from './theme.js';

/**
 * Reading a name that does not fit, by resting on it.
 *
 * The fade is honest about there being more text; it does not help you read
 * it. Usually that is fine — a truncated name is recognisable long before it
 * is complete. It stops being fine in a list of sessions from one repository,
 * where several names share a long opening and differ only at the end: the
 * part that is cut off is exactly the part that tells them apart, and that is
 * the moment somebody is choosing between them.
 *
 * So this is a reveal, not an animation. Three properties make it one:
 *
 *  - It waits. Moving the pointer down a list to reach the ninth row must not
 *    set the eight above it sliding; the movement answers attention, and a
 *    pointer passing through is not that.
 *  - It travels once and stays. A loop restarts under your eye mid-word and
 *    is unreadable by construction. This runs to the end and holds there, so
 *    the tail — the part you came for — is what is on screen while you decide.
 *  - It moves at a reading pace, not a fixed duration. A name two words too
 *    long and a name two lines too long travel at the same speed rather than
 *    the same time, so neither crawls nor blurs.
 *
 * It does nothing at all for text that fits, and nothing for somebody who has
 * asked for reduced motion — the tooltip still has the whole string.
 */
const DWELL_MS = 420;
/** A reading pace, in pixels per second. */
const REVEAL_SPEED = 58;
/** Coming back is not reading, so it is quick. */
const RETURN_MS = 220;

/**
 * Text that runs out of room, faded rather than cut with an ellipsis.
 *
 * `text-overflow: ellipsis` is a typographic apology: it spends three
 * characters saying that something was removed, and it says it in the middle
 * of the phrase it removed — `Session concluded after summa...` reads as a
 * sentence that ends badly rather than as one that continues past the edge. A
 * mask says the same thing by showing it: the text dissolves into the surface,
 * which is what is actually happening to it.
 *
 * One treatment everywhere. This started on titles alone, which left two
 * different truncations a line apart in the same sidebar row — a name that
 * faded above a description that trailed three dots. Anything that can outrun
 * its box gets this: names, activity lines, paths, bylines, tool labels.
 *
 * The mask is applied only when the text really does overflow, which is the
 * one thing CSS cannot answer on its own — an unconditional mask would fade
 * the tail of every short string too. So the element measures itself and
 * re-measures whenever its box or its content changes.
 *
 * Nothing is removed from the document: the whole string is still the
 * element's text, so selection, search and screen readers see all of it, and
 * a plain-text child becomes the `title` so hovering shows the rest.
 */
export function Fading({
  children,
  as = 'span',
  axis = 'x',
  className,
  title,
  reveal = false,
}: {
  children: ReactNode;
  /** The element this should be, where the surrounding CSS expects one. */
  as?: 'span' | 'div' | 'h1' | 'h2';
  /**
   * Which edge the text runs out at.
   *
   * `x` for the single line that outgrows its column, `y` for the block held
   * to a couple of lines. The same idea either way — the text dissolves at the
   * boundary it crosses instead of being cut off with a mark.
   */
  axis?: 'x' | 'y';
  className?: string;
  /** The tooltip, when the children are not a plain string to take it from. */
  title?: string;
  /**
   * Let resting on this scroll it, when it does not fit.
   *
   * Opt-in, because it is only worth it where the hidden part decides
   * something — a row you are about to click. Text that is merely long can
   * stay faded.
   */
  reveal?: boolean;
}) {
  const node = useRef<HTMLElement | null>(null);
  const [faded, setFaded] = useState(false);
  const [edges, setEdges] = useState<{ start: boolean; end: boolean } | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const element = node.current;
    if (!element) return;

    // A pixel of tolerance: sub-pixel metrics make an exactly-fitting string
    // report a scroll width a fraction larger than its box, and fading text
    // that fits is worse than not fading text that barely does not.
    const measure = (): void =>
      setFaded(
        axis === 'y'
          ? element.scrollHeight > element.clientHeight + 1
          : element.scrollWidth > element.clientWidth + 1,
      );

    measure();
    const box = new ResizeObserver(measure);
    box.observe(element);
    // The text itself can change without the box doing: an activity line is
    // rewritten in place every time the interpreter reads the session again.
    const content = new MutationObserver(measure);
    content.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      box.disconnect();
      content.disconnect();
    };
  }, [children, axis]);

  const stop = useCallback(() => {
    if (dwell.current) clearTimeout(dwell.current);
    dwell.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  /** Which edges have more text beyond them, while it is moving. */
  const readEdges = useCallback((element: HTMLElement) => {
    const max = element.scrollWidth - element.clientWidth;
    setEdges({ start: element.scrollLeft > 1, end: element.scrollLeft < max - 1 });
  }, []);

  const travel = useCallback(
    (to: number, speedPerMs: number, done?: () => void) => {
      const element = node.current;
      if (!element) return;
      const from = element.scrollLeft;
      const distance = to - from;
      if (Math.abs(distance) < 1) {
        done?.();
        return;
      }
      const started = performance.now();
      const duration = Math.abs(distance) / speedPerMs;
      const step = (at: number): void => {
        const through = Math.min(1, (at - started) / duration);
        element.scrollLeft = from + distance * through;
        readEdges(element);
        if (through < 1) {
          frame.current = requestAnimationFrame(step);
          return;
        }
        frame.current = null;
        done?.();
      };
      frame.current = requestAnimationFrame(step);
    },
    [readEdges],
  );

  const enter = useCallback(() => {
    if (!reveal || !faded || reducedMotion) return;
    stop();
    dwell.current = setTimeout(() => {
      const element = node.current;
      if (!element) return;
      // Runs to the end and stays: the tail is what the reader came for.
      travel(element.scrollWidth - element.clientWidth, REVEAL_SPEED / 1000);
    }, DWELL_MS);
  }, [reveal, faded, reducedMotion, stop, travel]);

  const leave = useCallback(() => {
    if (!reveal) return;
    stop();
    const element = node.current;
    if (!element || element.scrollLeft === 0) {
      setEdges(null);
      return;
    }
    travel(0, element.scrollLeft / RETURN_MS, () => setEdges(null));
  }, [reveal, stop, travel]);

  useEffect(() => stop, [stop]);

  const tooltip = title ?? (typeof children === 'string' ? children : undefined);
  return createElement(
    as,
    {
      ref: node,
      className: [
        axis === 'y' ? 'fading-block' : 'fading',
        faded ? 'is-faded' : null,
        // While it is moving, the cut edge is wherever there is more text —
        // which is the left as soon as any of it has gone past.
        edges ? 'is-revealing' : null,
        edges?.start ? 'more-start' : null,
        edges?.end ? 'more-end' : null,
        className,
      ]
        .filter(Boolean)
        .join(' '),
      ...(tooltip ? { title: tooltip } : {}),
      ...(reveal && faded && !reducedMotion
        ? { onPointerEnter: enter, onPointerLeave: leave }
        : {}),
    },
    children,
  );
}
