import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
}) {
  const node = useRef<HTMLElement | null>(null);
  const [faded, setFaded] = useState(false);

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

  const tooltip = title ?? (typeof children === 'string' ? children : undefined);
  return createElement(
    as,
    {
      ref: node,
      className: [
        axis === 'y' ? 'fading-block' : 'fading',
        faded ? 'is-faded' : null,
        className,
      ]
        .filter(Boolean)
        .join(' '),
      ...(tooltip ? { title: tooltip } : {}),
    },
    children,
  );
}
