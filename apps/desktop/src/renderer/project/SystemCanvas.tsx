import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';

import type {
  ContextRef,
  DesignChangeEntry,
  DesignDuty,
  DesignElementKind,
  DesignEntry,
  DesignLayout,
  DesignLink,
  DesignModel,
  DesignPart,
  DesignSlot,
} from '@vowe/core';
import { diffModels, live, visibleEntries } from '@vowe/core/studio-model';
import { refFromLink } from '@vowe/core/refs';

import { canvasGeometry, edgePath, freeSlot, type CanvasGeometry, type Placed } from '../state/design-canvas.js';
import type { LensView } from '../state/studio.js';
import { Markdown } from '../workbench/Markdown.js';
import { CloseIcon } from '../shell/icons.js';

export interface CanvasSelection {
  kind: DesignElementKind;
  id: string;
}

interface Props {
  model: DesignModel;
  layout: DesignLayout;
  selection: CanvasSelection | null;
  onSelect: (selection: CanvasSelection | null) => void;
  /** The part a repository check is looking at right now. */
  checking: string | null;
  /** Vowe's note on the latest move, anchored to an element. */
  note: DesignEntry | null;
  lens: LensView | null;
  /** False while Vowe is mid-turn: you can look and point, not change. */
  editable: boolean;
  /** Parts arriving on a first appearance materialize rather than simply being there. */
  animateArrival: boolean;
  /** The moves that touched a part, newest first. */
  changesOf: (id: string) => { ord: number; summary: string; by: string }[];
  onShowChange: (ord: number) => void;
  onRename: (id: string, name: string) => void;
  onRelocateDuty: (dutyId: string, partId: string) => void;
  onPin: (id: string, slot: DesignSlot) => void;
  onOpenRef: (ref: ContextRef) => void;
}

/** How long a change stays emphasised before the canvas is calm again. */
const SETTLE_MS = 2600;
const LEAVE_MS = 650;
const PAD = 56;

/**
 * The system being designed, drawn so a developer who knows nothing about
 * Vowe sees software being designed — parts, the links between them, and the
 * odd responsibility under discussion. No glyphs, no badges, no legend.
 *
 * What Vowe knows about each part — whether it exists today, why it is here,
 * what the repository said — is depth: it appears when you select a part and
 * ask. What changed is felt, not annotated: arrivals materialize, changes
 * glow and settle, and only the changes lens draws a diff.
 *
 * The canvas is also a way to speak. Selecting points; renaming, dragging a
 * responsibility onto another part and reverting all become the same moves a
 * sentence would. Dragging a part only places it, which is view, not design.
 */
export function SystemCanvas(props: Props): ReactElement {
  const { model, layout, selection, onSelect, checking, note, lens, editable, animateArrival } = props;
  const shown = lens?.after ?? model;

  // ---------------------------------------------------------------- measure
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [measured, setMeasured] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  // Made on first use: a card's ref runs before any effect, so an observer
  // created in one would miss every card already on the canvas.
  const measure = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    observer.current ??= new ResizeObserver((records) => {
      setHeights((current) => {
        let next = current;
        for (const record of records) {
          const id = (record.target as HTMLElement).dataset['part'];
          const height = Math.round((record.target as HTMLElement).offsetHeight);
          if (id && current[id] !== height) {
            if (next === current) next = { ...current };
            next[id] = height;
          }
        }
        return next;
      });
      setMeasured(true);
    });
    observer.current.observe(element);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  // --------------------------------------------------------------- emphasis
  const previous = useRef<DesignModel | null>(null);
  const previousGeometry = useRef<CanvasGeometry | null>(null);
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<{ part: DesignPart; at: Placed }[]>([]);
  useEffect(() => {
    if (lens) return;
    const before = previous.current;
    previous.current = model;
    if (!before && !animateArrival) return;
    const diff = diffModels(before, model);
    if (!diff.entries.length) return;
    const added = new Set<string>();
    const changed = new Set<string>();
    for (const entry of visibleEntries(diff)) {
      if (entry.change === 'added' && entry.kind === 'part') added.add(entry.id);
      else if (entry.kind !== 'link' && entry.change !== 'removed') changed.add(entry.id);
      if (entry.kind === 'duty') {
        const duty = model.duties.find((candidate) => candidate.id === entry.id);
        if (duty) changed.add(duty.part);
      }
    }
    const gone = diff.entries
      .filter((entry) => entry.kind === 'part' && entry.change === 'removed')
      .flatMap((entry) => {
        const part = before?.parts.find((candidate) => candidate.id === entry.id);
        const at = previousGeometry.current?.placed.get(entry.id);
        return part && at ? [{ part, at }] : [];
      });
    setEntering(added);
    setTouched(changed);
    if (gone.length) setLeaving(gone);
    const settle = window.setTimeout(() => { setEntering(new Set()); setTouched(new Set()); }, SETTLE_MS);
    const clear = window.setTimeout(() => setLeaving([]), LEAVE_MS);
    return () => { window.clearTimeout(settle); window.clearTimeout(clear); };
  }, [model, lens, animateArrival]);

  // --------------------------------------------------------------- geometry
  const lensEntries = useMemo(() => new Map((lens?.diff.entries ?? []).map((entry) => [entry.id, entry])), [lens]);
  const ghostParts = useMemo(
    () => (lens ? live(lens.before.parts).filter((part) => lensEntries.get(part.id)?.change === 'removed') : []),
    [lens, lensEntries],
  );
  const parts = live(shown.parts);
  const drawnIds = useMemo(() => [...parts.map((part) => part.id), ...ghostParts.map((part) => part.id)], [parts, ghostParts]);

  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [pinned, setPinned] = useState<DesignLayout | null>(null);
  useEffect(() => setPinned(null), [layout]);
  const effectiveLayout = pinned ?? layout;
  const geometry = useMemo(() => canvasGeometry(drawnIds, effectiveLayout, heights), [drawnIds, effectiveLayout, heights]);
  useEffect(() => { if (!lens) previousGeometry.current = geometry; }, [geometry, lens]);

  // ------------------------------------------------------------------ fit
  const viewport = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 800, height: 600 });
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }));
    resize.observe(element);
    setBox({ width: element.clientWidth, height: element.clientHeight });
    return () => resize.disconnect();
  }, []);
  const contentWidth = geometry.width + PAD * 2;
  const contentHeight = geometry.height + PAD * 2;
  const scale = Math.max(0.62, Math.min(1, box.width / contentWidth, box.height / contentHeight));
  const offsetX = Math.max(0, (box.width - contentWidth * scale) / 2);
  const offsetY = Math.max(0, (box.height - contentHeight * scale) / 2);
  const toStage = (clientX: number, clientY: number) => {
    const rect = viewport.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left + viewport.current!.scrollLeft - offsetX) / scale - PAD,
      y: (clientY - rect.top + viewport.current!.scrollTop - offsetY) / scale - PAD,
    };
  };

  // ------------------------------------------------------------ part drag
  const press = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const onPartDown = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0 || lens) return;
    press.current = { id, x: event.clientX, y: event.clientY, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPartMove = (event: ReactPointerEvent) => {
    const pressed = press.current;
    if (!pressed) return;
    const dx = (event.clientX - pressed.x) / scale;
    const dy = (event.clientY - pressed.y) / scale;
    if (!pressed.moved && Math.hypot(dx, dy) < 4) return;
    pressed.moved = true;
    setDrag({ id: pressed.id, dx, dy });
  };
  const onPartUp = (event: ReactPointerEvent, id: string) => {
    const pressed = press.current;
    press.current = null;
    if (!pressed) return;
    if (!pressed.moved) {
      event.stopPropagation();
      onSelect({ kind: 'part', id });
      return;
    }
    setDrag(null);
    const at = geometry.placed.get(id);
    if (!at) return;
    const dx = (event.clientX - pressed.x) / scale;
    const dy = (event.clientY - pressed.y) / scale;
    const target = geometry.slotAt(at.x + at.w / 2 + dx, at.y + at.h / 2 + dy);
    const slot = { ...freeSlot(target, effectiveLayout, parts.map((part) => part.id), id), pinned: true as const };
    const current = effectiveLayout[id];
    if (current && current.row === slot.row && current.col === slot.col && current.pinned) return;
    setPinned({ ...effectiveLayout, [id]: slot });
    props.onPin(id, slot);
  };

  // ------------------------------------------------------ duty relocation
  const [dutyDrag, setDutyDrag] = useState<{ id: string; text: string; x: number; y: number; over: string | null } | null>(null);
  const dutyPress = useRef<{ duty: DesignDuty; x: number; y: number; moved: boolean } | null>(null);
  const onDutyDown = (event: ReactPointerEvent, duty: DesignDuty) => {
    event.stopPropagation();
    if (event.button !== 0 || lens) return;
    dutyPress.current = { duty, x: event.clientX, y: event.clientY, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onDutyMove = (event: ReactPointerEvent) => {
    const pressed = dutyPress.current;
    if (!pressed || !editable) return;
    if (!pressed.moved && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 4) return;
    pressed.moved = true;
    const under = document.elementsFromPoint(event.clientX, event.clientY)
      .map((element) => (element as HTMLElement).closest<HTMLElement>('[data-part]'))
      .find((element) => element && !element.classList.contains('ghost'));
    const over = under?.dataset['part'] ?? null;
    setDutyDrag({ id: pressed.duty.id, text: pressed.duty.text, x: event.clientX, y: event.clientY, over: over === pressed.duty.part ? null : over });
  };
  const onDutyUp = (event: ReactPointerEvent, duty: DesignDuty) => {
    event.stopPropagation();
    const pressed = dutyPress.current;
    dutyPress.current = null;
    const dropped = dutyDrag?.over;
    setDutyDrag(null);
    if (!pressed) return;
    if (!pressed.moved) {
      onSelect({ kind: 'duty', id: duty.id });
      return;
    }
    if (dropped && dropped !== duty.part) props.onRelocateDuty(duty.id, dropped);
  };

  // ---------------------------------------------------------------- rename
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { if (selection?.id !== renaming) setRenaming(null); }, [selection, renaming]);

  // ------------------------------------------------------------------ draw
  const links = live(shown.links);
  const ghostLinks = lens ? live(lens.before.links).filter((link) => lensEntries.get(link.id)?.change === 'removed') : [];
  const selectedPart = selection?.kind === 'part' ? selection.id : selection?.kind === 'duty' ? shown.duties.find((duty) => duty.id === selection.id)?.part ?? null : null;
  const noteOn = note?.anchor ? (shown.parts.some((part) => part.id === note.anchor!.on) ? note.anchor.on : shown.duties.find((duty) => duty.id === note.anchor!.on)?.part ?? shown.links.find((link) => link.id === note.anchor!.on)?.to ?? null) : null;
  const [dismissed, setDismissed] = useState<string | null>(null);

  const dutiesOn = (partId: string): { duty: DesignDuty; ghost: boolean; entry?: DesignChangeEntry }[] => {
    const now = live(shown.duties).filter((duty) => duty.part === partId).map((duty) => ({ duty, ghost: false, entry: lensEntries.get(duty.id) }));
    if (!lens) return now;
    const gone = live(lens.before.duties)
      .filter((duty) => duty.part === partId)
      .filter((duty) => {
        const entry = lensEntries.get(duty.id);
        return entry?.change === 'removed' || (entry?.change === 'changed' && entry.was?.part === partId);
      })
      .map((duty) => ({ duty, ghost: true }));
    return [...now, ...gone];
  };

  const card = (part: DesignPart, ghost: boolean, placedAt?: Placed) => {
    const at = placedAt ?? geometry.placed.get(part.id);
    if (!at) return null;
    const entry = lens ? lensEntries.get(part.id) : undefined;
    const dragging = drag?.id === part.id;
    const x = at.x + (dragging ? drag.dx : 0);
    const y = at.y + (dragging ? drag.dy : 0);
    const classes = [
      'system-part',
      ghost && 'ghost',
      selectedPart === part.id && 'selected',
      selection && selectedPart !== part.id && !lens && 'receded',
      entering.has(part.id) && 'entering',
      touched.has(part.id) && 'touched',
      checking === part.id && 'checking',
      dragging && 'dragging',
      dutyDrag?.over === part.id && 'drop-target',
      entry?.change === 'added' && 'lens-added',
      entry?.change === 'changed' && entry.fields!.some((field) => field === 'name' || field === 'role') && 'lens-changed',
    ].filter(Boolean).join(' ');
    const duties = dutiesOn(part.id);
    return (
      <div
        key={`${ghost ? 'ghost:' : ''}${part.id}`}
        ref={ghost ? undefined : measure}
        data-part={part.id}
        className={classes}
        style={{ transform: `translate(${x}px, ${y}px)`, width: at.w }}
        onPointerDown={ghost ? undefined : (event) => onPartDown(event, part.id)}
        onPointerMove={ghost ? undefined : onPartMove}
        onPointerUp={ghost ? undefined : (event) => onPartUp(event, part.id)}
        onDoubleClick={(event) => {
          if (ghost || !editable || lens) return;
          event.stopPropagation();
          onSelect({ kind: 'part', id: part.id });
          setRenaming(part.id);
        }}
      >
        {renaming === part.id ? (
          <RenameField
            name={part.name}
            onDone={(name) => {
              setRenaming(null);
              if (name && name !== part.name) props.onRename(part.id, name);
            }}
          />
        ) : (
          <span className="system-part-name">{part.name}</span>
        )}
        {entry?.was?.name && <span className="system-part-was">was {entry.was.name}</span>}
        <span className="system-part-role">{checking === part.id ? 'Checking current behavior…' : part.role}</span>
        {duties.length > 0 && (
          <ul className="system-duties">
            {duties.map(({ duty, ghost: gone, entry: dutyEntry }) => (
              <li
                key={`${gone ? 'was:' : ''}${duty.id}`}
                className={[
                  'system-duty',
                  gone && 'ghost',
                  selection?.kind === 'duty' && selection.id === duty.id && 'selected',
                  touched.has(duty.id) && 'touched',
                  dutyEntry?.change === 'added' && 'lens-added',
                  dutyEntry?.change === 'changed' && 'lens-added',
                  editable && !gone && !lens && 'movable',
                ].filter(Boolean).join(' ')}
                onPointerDown={gone ? undefined : (event) => onDutyDown(event, duty)}
                onPointerMove={gone ? undefined : onDutyMove}
                onPointerUp={gone ? undefined : (event) => onDutyUp(event, duty)}
              >
                {duty.text}
              </li>
            ))}
          </ul>
        )}
        {!ghost && !lens && note && noteOn === part.id && dismissed !== note.id && (
          <span className="system-note" onPointerDown={(event) => event.stopPropagation()}>
            {note.text}
            <button type="button" aria-label="Dismiss" onClick={() => setDismissed(note.id)}><CloseIcon /></button>
          </span>
        )}
      </div>
    );
  };

  const edge = (link: DesignLink, ghost: boolean) => {
    const from = geometry.placed.get(link.from);
    const to = geometry.placed.get(link.to);
    if (!from || !to) return null;
    const fromAt = drag?.id === link.from ? { ...from, x: from.x + drag.dx, y: from.y + drag.dy } : from;
    const toAt = drag?.id === link.to ? { ...to, x: to.x + drag.dx, y: to.y + drag.dy } : to;
    const others = [...geometry.placed.values()].filter((card) => card.id !== drag?.id);
    const { d, mid } = edgePath(fromAt, toAt, others);
    const entry = lens ? lensEntries.get(link.id) : undefined;
    const selected = selection?.kind === 'link' && selection.id === link.id;
    const classes = ['system-link', ghost && 'ghost', selected && 'selected', entry?.change === 'added' && 'lens-added', drag && 'still'].filter(Boolean).join(' ');
    return (
      <g key={`${ghost ? 'ghost:' : ''}${link.id}`} className={classes}>
        <path className="system-link-line" style={{ d: `path('${d}')` } as CSSProperties} markerEnd="url(#system-arrow)" />
        {!ghost && (
          <path
            className="system-link-hit"
            d={d}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onSelect({ kind: 'link', id: link.id }); }}
          />
        )}
        {link.label && (
          <text className="system-link-label" x={mid.x + 8} y={mid.y + 3}>{link.label}</text>
        )}
      </g>
    );
  };

  const detailFor = selection?.kind === 'part' && !lens ? shown.parts.find((part) => part.id === selection.id && !part.retired) : undefined;
  const detailAt = detailFor ? geometry.placed.get(detailFor.id) : undefined;

  return (
    <div
      className={`system-canvas${measured ? ' measured' : ''}${lens ? ' lensed' : ''}${dutyDrag ? ' relocating' : ''}`}
      ref={viewport}
      onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('system-stage')) onSelect(null); }}
    >
      <div
        className="system-stage"
        style={{
          width: contentWidth,
          height: contentHeight,
          transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
        }}
      >
        <svg className="system-links" width={contentWidth} height={contentHeight} style={{ left: 0, top: 0 }}>
          <defs>
            <marker id="system-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0.5 L 7.5 4 L 0 7.5 Z" />
            </marker>
          </defs>
          <g transform={`translate(${PAD} ${PAD})`}>
            {ghostLinks.map((link) => edge(link, true))}
            {links.map((link) => edge(link, false))}
          </g>
        </svg>
        <div className="system-parts" style={{ left: PAD, top: PAD }}>
          {ghostParts.map((part) => card(part, true))}
          {parts.map((part) => card(part, false))}
          {!lens && leaving.map(({ part, at }) => (
            <div key={`leaving:${part.id}`} className="system-part leaving" style={{ transform: `translate(${at.x}px, ${at.y}px)`, width: at.w }}>
              <span className="system-part-name">{part.name}</span>
              <span className="system-part-role">{part.role}</span>
            </div>
          ))}
        </div>
      </div>

      {detailFor && detailAt && (
        <PartDetail
          part={detailFor}
          left={offsetX + (PAD + detailAt.x + detailAt.w) * scale + 14 - (viewport.current?.scrollLeft ?? 0)}
          top={offsetY + (PAD + detailAt.y) * scale - (viewport.current?.scrollTop ?? 0)}
          flip={offsetX + (PAD + detailAt.x + detailAt.w) * scale + 330 > box.width}
          flipLeft={offsetX + (PAD + detailAt.x) * scale - 14}
          changes={props.changesOf(detailFor.id)}
          onShowChange={props.onShowChange}
          onOpenRef={props.onOpenRef}
        />
      )}

      {dutyDrag && (
        <div className="system-duty-flying" style={{ left: dutyDrag.x, top: dutyDrag.y }}>{dutyDrag.text}</div>
      )}
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }): ReactElement {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  return (
    <input
      ref={field}
      className="system-part-rename"
      value={value}
      aria-label="Rename part"
      onPointerDown={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onDone(value.trim() || null)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') onDone(value.trim() || null);
        if (event.key === 'Escape') onDone(null);
      }}
    />
  );
}

/**
 * A part, asked about. Nothing here shows until the part is selected, and the
 * reasoning and evidence only when asked for: the canvas stays the system,
 * and what Vowe knows about it is depth.
 */
function PartDetail({
  part, left, top, flip, flipLeft, changes, onShowChange, onOpenRef,
}: {
  part: DesignPart;
  left: number;
  top: number;
  flip: boolean;
  flipLeft: number;
  changes: { ord: number; summary: string; by: string }[];
  onShowChange: (ord: number) => void;
  onOpenRef: (ref: ContextRef) => void;
}): ReactElement {
  const [open, setOpen] = useState<'why' | 'changes' | null>(null);
  useEffect(() => setOpen(null), [part.id]);
  const refs = (part.refs ?? []).flatMap((ref) => {
    const parsed = refFromLink(`ref:${ref}`);
    return parsed ? [{ ref: parsed, label: ref.split('/').pop()!.replace(/#.*$/, '') }] : [];
  });
  const todayDiffers = part.today && (part.today.name !== part.name || part.today.role !== part.role);
  return (
    <aside
      className={`system-detail${flip ? ' flipped' : ''}`}
      style={flip ? { right: `calc(100% - ${flipLeft}px)`, top } : { left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      aria-label={`${part.name} details`}
    >
      <div className="system-detail-actions">
        <button type="button" className={`link-button${open === 'why' ? ' active' : ''}`} onClick={() => setOpen(open === 'why' ? null : 'why')}>Why</button>
        {changes.length > 0 && (
          <button type="button" className={`link-button${open === 'changes' ? ' active' : ''}`} onClick={() => setOpen(open === 'changes' ? null : 'changes')}>
            Changes
          </button>
        )}
      </div>
      {open === 'why' && (
        <div className="system-detail-body">
          {part.detail ? (
            <Markdown text={part.detail} onOpenRef={onOpenRef} />
          ) : (
            <p className="fine">No reasoning written down for this part yet. Ask Vowe why.</p>
          )}
          {todayDiffers && (
            <p className="system-detail-today">In the code today: {part.today!.name} — {part.today!.role}</p>
          )}
          {refs.map(({ ref, label }) => (
            <button key={label} type="button" className="link-button system-source" onClick={() => onOpenRef(ref)}>
              Show source · {label} →
            </button>
          ))}
        </div>
      )}
      {open === 'changes' && (
        <ol className="system-detail-body system-detail-changes">
          {changes.map((change) => (
            <li key={change.ord}>
              <button type="button" className="link-button" onClick={() => onShowChange(change.ord)}>
                <span className="by">{change.by}</span> {change.summary || 'Changed the design'}
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
