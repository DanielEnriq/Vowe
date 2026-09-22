import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { ContextRef } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import type { TimelineRow } from '../state/investigation-timeline.js';
import { CaretIcon } from '../shell/icons.js';
import { CheckKindIcon } from './CheckKindIcon.js';

/**
 * What Vowe did before it answered, as one column.
 *
 * Thinking is an execution event exactly as a lookup is, so it is drawn in the
 * same restrained language: an icon, a short line of muted prose, the same
 * indentation and the same scale. The earlier treatment gave every thought its
 * own presence mark and its own typography, which made the least certain thing
 * in the column the loudest — and put a piece of Vowe's identity beside a row
 * that is not Vowe speaking.
 *
 * One component for both tenses. While the work is happening the rows come
 * from the live stream; once it has settled they come back from the durable
 * trace. They must look identical, because they are the same events — and the
 * only way to guarantee that is for there to be one renderer.
 *
 * **Bounded.** The column is a window onto the work rather than the work laid
 * end to end: a forty-step investigation is still one screenful tall, and it
 * scrolls inside itself. Both tenses get the same window, so there is one way
 * to read an investigation, live or reopened.
 */
export function InvestigationTimeline({
  rows,
  followTail = false,
  pending,
  onOpenRef,
}: {
  rows: readonly TimelineRow[];
  /**
   * Start pinned to the newest row. The live column does, because the newest
   * row is the one happening; a reopened investigation starts at its
   * beginning, because it is read rather than watched.
   */
  followTail?: boolean;
  /** A last row that is not a step yet — `Thinking · 3s` with nothing exposed. */
  pending?: ReactNode;
  /**
   * Where a lookup opens, in rooms that have somewhere to open it.
   *
   * This is the entry point into the evidence, and it is the only one the
   * conversation needs: the answer used to carry a list of every record it
   * touched, which over-stated a question nobody had asked. What Vowe looked
   * at is already here, in the order it looked, and following one of these
   * rows is how you go and see it.
   *
   * Omitted in the Project Room, which has no workbench: a row that did
   * nothing when clicked would be worse than a row that reads as a record.
   */
  onOpenRef?: (ref: ContextRef) => void;
}): ReactElement | null {
  if (rows.length === 0 && !pending) return null;

  return (
    <TraceViewport rowCount={rows.length} followTail={followTail}>
      {rows.map((row) =>
        row.kind === 'check' ? (
          <Check
            key={row.id}
            row={row}
            {...(onOpenRef ? { onOpenRef } : {})}
          />
        ) : (
          <Thought key={row.id} row={row} />
        ),
      )}
      {pending}
    </TraceViewport>
  );
}

/**
 * The window itself, and who owns its scroll position.
 *
 * The reader does. While they are at the bottom the window follows the tail,
 * the way a log does, and older rows leave through the top edge. The moment
 * they scroll up they have said they want to read something, and nothing that
 * arrives afterwards takes them away from it — new rows accumulate below and a
 * small `↓ N new` says so. Scrolling back down, or clicking that, rejoins the
 * tail.
 *
 * Growth is watched rather than rows being counted, because a row can grow in
 * place: a thought receiving more text, or opening. Following is re-applied on
 * every change of height, and only while following — which is what keeps an
 * update at the tail from moving a reader who is somewhere else.
 *
 * The edges fade only where there is more to see beyond them, as a mask on the
 * scroller rather than an overlay above the rows: it fades into whatever is
 * behind it, and it cannot catch a click.
 */
function TraceViewport({
  rowCount,
  followTail,
  children,
}: {
  rowCount: number;
  followTail: boolean;
  children: ReactNode;
}): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(followTail);
  const counted = useRef(rowCount);
  const held = useRef<{ row: HTMLElement; offset: number } | null>(null);
  const [edges, setEdges] = useState({ above: false, below: false, fits: true });
  const [unseen, setUnseen] = useState(0);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const above = el.scrollTop > 1;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight > SLIVER;
    const fits = el.scrollHeight - el.clientHeight <= SLIVER;
    setEdges((was) =>
      was.above === above && was.below === below && was.fits === fits ? was : { above, below, fits },
    );
  }, []);

  const toTail = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Remember where the clicked row sits, for the one change the click causes.
  // Cleared after two frames whatever happens — by then the change has been
  // laid out and observed, or there was none — so a stale hold can never
  // steer a later, unrelated update.
  const hold = useCallback((row: HTMLElement) => {
    const el = scroller.current;
    if (!el) return;
    held.current = { row, offset: offsetIn(el, row) };
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        held.current = null;
      }),
    );
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      const pin = held.current;
      if (pin) {
        // A row the reader just opened or closed stays exactly where they
        // clicked it, so the text appears below the label rather than the
        // label jumping up to make room. If that leaves the tail out of view,
        // the reader has stopped following it.
        held.current = null;
        el.scrollTop += offsetIn(el, pin.row) - pin.offset;
        following.current = atTail(el);
      } else if (following.current) {
        toTail();
      }
      measure();
    });
    // The content for rows arriving and growing; the scroller for the window
    // itself changing height with the app's.
    observer.observe(inner);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, toTail]);

  useEffect(() => {
    const added = rowCount - counted.current;
    counted.current = rowCount;
    if (added > 0 && !following.current) setUnseen((was) => was + added);
  }, [rowCount]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const at = atTail(el);
    following.current = at;
    if (at) setUnseen(0);
    measure();
  };

  const rejoin = () => {
    following.current = true;
    setUnseen(0);
    toTail();
  };

  return (
    <div className="exec-viewport">
      <div
        ref={scroller}
        className={`exec-scroll${edges.above ? ' more-above' : ''}${edges.below ? ' more-below' : ''}${edges.fits ? ' fits' : ''}`}
        onScroll={onScroll}
        // Rows arrive with a short rise, and a row still sitting a few pixels
        // low counts as overflow while it does. A transform ending resizes
        // nothing, so nothing else would notice the overflow is gone: without
        // this a short trace kept its bottom fade, and a sliver of scroll that
        // swallowed the wheel, until something else changed its height.
        onAnimationEnd={measure}
      >
        <div ref={content} className="exec" aria-live="polite">
          <HoldRow.Provider value={hold}>{children}</HoldRow.Provider>
        </div>
      </div>

      {unseen > 0 && (
        <button className="exec-latest" type="button" onClick={rejoin}>
          ↓ {unseen} new
        </button>
      )}
    </div>
  );
}

/**
 * How close to the bottom still counts as being at it.
 *
 * Less than a row: a reader who has scrolled up by even one line has scrolled
 * up on purpose.
 */
const TAIL_WITHIN = 12;

/**
 * Overflow too small to be content: the few pixels a row occupies below its
 * place while it rises in. Treating it as "more below" flashed a fade over a
 * trace that fits.
 */
const SLIVER = 6;

function atTail(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_WITHIN;
}

/** Where a row sits inside the window, in pixels from its top edge. */
function offsetIn(el: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
}

/**
 * How a row asks the window to keep it still through a change it caused.
 *
 * Only a thought needs it — opening one is the only change a reader makes to
 * the column — and outside a window there is nothing to hold, hence the
 * no-op default.
 */
const HoldRow = createContext<(row: HTMLElement) => void>(() => undefined);

/**
 * One lookup, in the words the recorder wrote at the time.
 *
 * Never the provider's event kind, never a tool name and never a shell
 * command: `Reviewed worker activity`, because that is what happened. The raw
 * call is in the run's trace, which is where a raw call belongs.
 *
 * A lookup that turned nothing up has nothing to open, so it stays a line of
 * text rather than becoming a control that does nothing.
 */
function Check({
  row,
  onOpenRef,
}: {
  row: Extract<TimelineRow, { kind: 'check' }>;
  onOpenRef?: (ref: ContextRef) => void;
}): ReactElement {
  const ref = row.check.refs[0];

  if (!ref || !onOpenRef) {
    return (
      <span className="exec-step check">
        <CheckKindIcon kind={row.check.kind} />
        <Fading className="target-label">{row.check.label}</Fading>
      </span>
    );
  }

  return (
    <button
      className="exec-step check"
      type="button"
      title="Open this on the desk"
      onClick={() => onOpenRef(ref)}
    >
      <CheckKindIcon kind={row.check.kind} />
      <Fading className="target-label">{row.check.label}</Fading>
    </button>
  );
}

/**
 * One span of exposed working.
 *
 * Open while it is being written, so the exposed text can be watched arriving,
 * and collapsed once it has closed, because the thought is evidence and the
 * answer is the point. Openable afterwards in both tenses, since reading it
 * later is the reason it is kept. A reader's own choice outlasts the default:
 * a thought they opened or closed stays that way when the span closes.
 *
 * A span the provider redacted has no text to open, so it is a row rather than
 * a button: a control that does nothing when clicked is worse than a line of
 * text saying that reasoning happened.
 */
function Thought({
  row,
}: {
  row: Extract<TimelineRow, { kind: 'thought' }>;
}): ReactElement {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const hold = useContext(HoldRow);
  const open = chosen ?? row.live;
  // Ticks only while this span is the open one, so a settled thread runs no
  // timers at all.
  const now = useTicking(row.live);
  const label = row.live
    ? `Thinking · ${Math.max(0, Math.round((now - row.startedAt) / 1000))}s`
    : settledLabel(row.durationMs);

  if (!row.text) {
    return (
      <span className={`exec-step thought${row.live ? ' live' : ''}`}>
        <span className="label">{label}</span>
      </span>
    );
  }

  return (
    <div className={`exec-step thought${row.live ? ' live' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={(event) => {
          hold(event.currentTarget);
          setChosen(!open);
        }}
      >
        <CaretIcon />
        <span className="label">{label}</span>
      </button>

      {open && (
        // Append-only, like everything else on this path: the text grows and
        // nothing that was on screen is taken away to make room for more.
        <p className="thought-text">{row.text}</p>
      )}
    </div>
  );
}

/**
 * How long it took, or nothing at all.
 *
 * `Thought for 0.0s` is not a measurement, it is a rounding artefact — and it
 * appears exactly where a span is too short to have a meaningful duration or
 * where there was no earlier timestamp to measure from. Below the floor the
 * row says only that the thought happened, which is the part that is true.
 */
function settledLabel(ms: number): string {
  if (ms < BRIEF_MS) return 'Thought';
  return `Thought for ${(ms / 1000).toFixed(1)}s`;
}

/** Under this, a duration says less than no duration at all. */
const BRIEF_MS = 150;

/**
 * A second hand, and only while something is being timed.
 *
 * `Thinking · 3s` has to advance or it is not a live label, and this is the
 * one clock in the region: a duration genuinely is a function of the wall
 * clock, unlike every other quantity here. A settled thread runs no timer,
 * because nothing in it is still happening.
 */
function useTicking(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
