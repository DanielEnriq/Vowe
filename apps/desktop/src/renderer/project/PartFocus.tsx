import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';

import type { ContextRef, DesignDuty, DesignLink, DesignModel, DesignPart } from '@vowe/core';
import { refFromLink } from '@vowe/core/refs';
import { live } from '@vowe/core/studio-model';

import { Markdown } from '../workbench/Markdown.js';
import { CloseIcon } from '../shell/icons.js';

export interface DutyGesture {
  down: (event: ReactPointerEvent, duty: DesignDuty) => void;
  move: (event: ReactPointerEvent) => void;
  up: (event: ReactPointerEvent, duty: DesignDuty) => void;
}

interface Anchor { left: number; top: number; right: number; bottom: number }

const WIDTH = 304;
const GAP = 14;
const MARGIN = 12;

/**
 * Where a panel beside something sits: beside it, on whichever side covers
 * the least of the drawing — right, left, below, above — and always inside
 * the canvas.
 */
function place(
  anchor: Anchor,
  bounds: { width: number; height: number },
  size: { width: number; height: number },
  obstacles: readonly Anchor[] = [],
): { left: number; top: number; side: 'right' | 'left' | 'below' | 'above' } {
  const clampX = (x: number) => Math.min(Math.max(MARGIN, x), Math.max(MARGIN, bounds.width - size.width - MARGIN));
  const clampY = (y: number) => Math.min(Math.max(MARGIN, y), Math.max(MARGIN, bounds.height - size.height - MARGIN));
  const candidates = [
    { side: 'right' as const, left: anchor.right + GAP, top: clampY(anchor.top), fits: anchor.right + GAP + size.width <= bounds.width - MARGIN },
    { side: 'left' as const, left: anchor.left - GAP - size.width, top: clampY(anchor.top), fits: anchor.left - GAP - size.width >= MARGIN },
    { side: 'below' as const, left: clampX(anchor.left), top: anchor.bottom + GAP, fits: anchor.bottom + GAP + size.height <= bounds.height - MARGIN },
    { side: 'above' as const, left: clampX(anchor.left), top: anchor.top - GAP - size.height, fits: anchor.top - GAP - size.height >= MARGIN },
  ];
  const covered = (left: number, top: number) => obstacles.reduce((sum, box) => {
    const w = Math.min(left + size.width, box.right) - Math.max(left, box.left);
    const h = Math.min(top + size.height, box.bottom) - Math.max(top, box.top);
    return sum + (w > 0 && h > 0 ? w * h : 0);
  }, 0);
  const fitting = candidates.filter((candidate) => candidate.fits);
  const best = (fitting.length ? fitting : [{ ...candidates[2]!, top: clampY(candidates[2]!.top) }])
    .map((candidate, order) => ({ ...candidate, cost: covered(candidate.left, candidate.top) + order }))
    .sort((a, b) => a.cost - b.cost)[0]!;
  return { left: best.left, top: best.top, side: best.side };
}

function usePanelSize(): [React.RefObject<HTMLElement | null>, { width: number; height: number }] {
  const panel = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: WIDTH, height: 160 });
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const read = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    const resize = new ResizeObserver(read);
    resize.observe(element);
    read();
    return () => resize.disconnect();
  }, []);
  return [panel, size];
}

/**
 * A part, being thought about. The card on the canvas stays a name and a
 * purpose; this is everything else, beside it — what the part is responsible
 * for, why it is in the design, what the code has today, where it lives, and
 * the moves that shaped it. Responsibilities here can be dragged onto another
 * part, which is a change to the architecture.
 */
export function PartFocus({
  part, model, anchor, bounds, obstacles, note, selectedDuty, movable, dragging, gesture, changes, onShowChange, onOpenRef, onAsk, onRename,
}: {
  part: DesignPart;
  model: DesignModel;
  anchor: Anchor;
  bounds: { width: number; height: number };
  /** The rest of the drawing, which the panel should cover as little of as it can. */
  obstacles: readonly Anchor[];
  /** Vowe's note on the latest move, when it is about this part. */
  note: { text: string; onDismiss: () => void } | null;
  selectedDuty: string | null;
  movable: boolean;
  dragging: string | null;
  gesture: DutyGesture;
  changes: { ord: number; summary: string; by: string }[];
  onShowChange: (ord: number) => void;
  onOpenRef: (ref: ContextRef) => void;
  onAsk: (question: string) => void;
  onRename: (() => void) | null;
}): ReactElement {
  const [panel, size] = usePanelSize();
  const [more, setMore] = useState(false);
  const [history, setHistory] = useState(false);
  useEffect(() => { setMore(false); setHistory(false); }, [part.id]);
  const duties = live(model.duties).filter((duty) => duty.part === part.id);
  const refs = (part.refs ?? []).flatMap((ref) => {
    const parsed = refFromLink(`ref:${ref}`);
    return parsed ? [{ ref: parsed, label: ref.split('/').pop()!.replace(/#.*$/, '') }] : [];
  });
  const today = part.today;
  // "Not in the code yet" only means something in a design that has met the code.
  const grounded = model.parts.some((candidate) => candidate.today);
  const todayLine = !today ? null
    : today.name !== part.name || today.role !== part.role ? `In the code today: ${today.name}${today.role ? ` — ${today.role}` : ''}`
      : 'In the code today';
  const where = place(anchor, bounds, size, obstacles);
  // Only what there is: a part with nothing more to say gets a small panel, not an empty one.
  const full = duties.length > 0 || Boolean(part.detail) || refs.length > 0 || Boolean(note) || (history && changes.length > 0);
  const long = (part.detail?.length ?? 0) > 280;
  return (
    <aside
      ref={panel}
      className={`system-focus side-${where.side}`}
      style={{ left: where.left, top: where.top, ...(full ? { width: WIDTH } : {}) }}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={`${part.name}`}
    >
      {note && (
        <section className="system-focus-section system-focus-note">
          <NoteText text={note.text} onDismiss={note.onDismiss} />
        </section>
      )}
      {duties.length > 0 && (
        <section className="system-focus-section">
          <h4>Responsibilities</h4>
          <ul className="system-focus-duties">
            {duties.map((duty) => (
              <li
                key={duty.id}
                className={[
                  'system-focus-duty',
                  selectedDuty === duty.id && 'selected',
                  dragging === duty.id && 'lifted',
                  movable && 'movable',
                ].filter(Boolean).join(' ')}
                title={movable ? 'Drag onto another part to move this responsibility' : undefined}
                onPointerDown={(event) => gesture.down(event, duty)}
                onPointerMove={gesture.move}
                onPointerUp={(event) => gesture.up(event, duty)}
              >
                {duty.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {part.detail && (
        <section className={`system-focus-section system-focus-why${long && !more ? ' clamped' : ''}`}>
          <Markdown text={part.detail} onOpenRef={onOpenRef} />
          {long && (
            <button type="button" className="link-button system-focus-more" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>
          )}
        </section>
      )}

      {(todayLine || (!today && grounded) || refs.length > 0) && (
        <section className="system-focus-section system-focus-code">
          {!today && grounded && <p className="system-focus-fact">Not in the code yet</p>}
          {todayLine && <p className="system-focus-fact">{todayLine}</p>}
          {refs.map(({ ref, label }) => (
            <button key={label} type="button" className="system-focus-source" onClick={() => onOpenRef(ref)}>
              <span className="file">{label}</span><span className="arrow">→</span>
            </button>
          ))}
        </section>
      )}

      {history && changes.length > 0 && (
        <ol className="system-focus-section system-focus-changes">
          {changes.map((change) => (
            <li key={change.ord}>
              <button type="button" className="link-button" onClick={() => onShowChange(change.ord)}>
                <span className="by">{change.by}</span> {change.summary || 'Changed the design'}
              </button>
            </li>
          ))}
        </ol>
      )}

      <footer className="system-focus-actions">
        <button type="button" className="link-button" onClick={() => onAsk(part.detail ? 'Why this way?' : 'Why is this part here?')}>Ask why</button>
        {onRename && <button type="button" className="link-button" onClick={onRename}>Rename</button>}
        {changes.length > 0 && (
          <button type="button" className={`link-button${history ? ' active' : ''}`} onClick={() => setHistory(!history)}>
            {changes.length === 1 ? '1 change' : `${changes.length} changes`}
          </button>
        )}
      </footer>
    </aside>
  );
}

/** A link, being thought about: what it connects and what it carries. */
export function LinkFocus({
  link, from, to, at, bounds, obstacles, onAsk,
}: {
  link: DesignLink;
  from: string;
  to: string;
  at: { x: number; y: number };
  bounds: { width: number; height: number };
  obstacles: readonly Anchor[];
  onAsk: (question: string) => void;
}): ReactElement {
  const [panel, size] = usePanelSize();
  const where = place({ left: at.x - 8, top: at.y - 8, right: at.x + 8, bottom: at.y + 8 }, bounds, size, obstacles);
  const today = link.today?.label && link.today.label !== link.label ? `In the code today: ${link.today.label}` : null;
  return (
    <aside
      ref={panel}
      className="system-focus link"
      style={{ left: where.left, top: where.top, maxWidth: 280 }}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={`${from} to ${to}`}
    >
      <section className="system-focus-section">
        <p className="system-focus-route"><span>{from}</span><span className="arrow">→</span><span>{to}</span></p>
        {link.label && <p className="system-focus-carries">{link.label}</p>}
        {today && <p className="system-focus-fact">{today}</p>}
      </section>
      <footer className="system-focus-actions">
        <button type="button" className="link-button" onClick={() => onAsk('Why does this connection exist?')}>Ask why</button>
      </footer>
    </aside>
  );
}

function NoteText({ text, onDismiss }: { text: string; onDismiss: () => void }): ReactElement {
  return (
    <p className="system-note">
      <span>{text}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss}><CloseIcon size={11} /></button>
    </p>
  );
}

/**
 * Vowe's note on the latest move, beside the part it is about — on whichever
 * side covers the least of the drawing, never on top of another part.
 */
export function PartNote({
  text, anchor, bounds, obstacles, onDismiss,
}: {
  text: string;
  anchor: Anchor;
  bounds: { width: number; height: number };
  obstacles: readonly Anchor[];
  onDismiss: () => void;
}): ReactElement {
  const [panel, size] = usePanelSize();
  const where = place(anchor, bounds, size, obstacles);
  return (
    <aside
      ref={panel}
      className={`system-note-callout side-${where.side}`}
      style={{ left: where.left, top: where.top }}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label="Note from Vowe"
    >
      <NoteText text={text} onDismiss={onDismiss} />
    </aside>
  );
}
