import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';

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
import { live } from '@vowe/core/studio-model';

import { canvasGeometry, freeSlot, looseRoute, placeLabels, routeLinks, type CanvasGeometry, type Placed, type Route } from '../state/design-canvas.js';
import { canvasChanges, NO_CHANGES, type CanvasChanges } from '../state/studio-motion.js';
import { neighborhood, nextSelection, visibleLabels, type LensView } from '../state/studio.js';
import { usePrefersReducedMotion } from '../shell/theme.js';
import { CloseIcon } from '../shell/icons.js';
import { LinkFocus, PartFocus, PartNote, type DutyGesture } from './PartFocus.js';

export interface CanvasSelection {
  kind: DesignElementKind;
  id: string;
}

interface Props {
  model: DesignModel;
  layout: DesignLayout;
  /** What is selected, first chosen first. Several parts can be gathered to ask about together. */
  selection: CanvasSelection[];
  onSelect: (selection: CanvasSelection[]) => void;
  /** The part a repository check is looking at right now. */
  checking: string | null;
  /** Vowe's note on the latest move, anchored to an element. */
  note: DesignEntry | null;
  lens: LensView | null;
  /** False while Vowe is mid-turn: you can look and point, not change. */
  editable: boolean;
  /** Parts arriving on a first appearance materialize rather than simply being there. */
  animateArrival: boolean;
  /** Room kept clear of the drawing at the top and bottom, for the title and a floating composer. */
  inset: { top: number; bottom: number };
  /** Evidence is open beneath the design: hold the scale and bring the part in question into the band above it. */
  depth: boolean;
  /** The moves that touched a part, newest first. */
  changesOf: (id: string) => { ord: number; summary: string; by: string }[];
  onShowChange: (ord: number) => void;
  onRename: (id: string, name: string) => void;
  onRelocateDuty: (dutyId: string, partId: string) => void;
  onPin: (id: string, slot: DesignSlot) => void;
  onOpenRef: (ref: ContextRef) => void;
  /** Put a question in the composer about what is selected. */
  onAsk: (question: string) => void;
}

/** How long a change stays emphasised before the canvas is calm again. */
const SETTLE_MS = 2400;
const LEAVE_MS = 620;
const TRAVEL_MS = 900;
const STAGGER_MS = 70;
const PAD = 64;
/** The share of the canvas left visible above the evidence sheet. */
const DEPTH_BAND = 0.4;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.12;

/**
 * The system being designed, drawn so that a developer who knows nothing
 * about Vowe sees software being designed: parts, the lines between them, and
 * nothing else. No glyphs, no badges, no legend.
 *
 * A part shows who it is and what it is for. Everything Vowe knows about it —
 * its responsibilities, why it is here, what the code has today, the moves
 * that shaped it — opens beside it when you select it, and only then.
 * Selecting a part brings its neighbourhood forward and lets the rest recede,
 * so "this" is visible before you type it.
 *
 * What changed is felt, not annotated: arrivals materialize along the flow,
 * new lines draw themselves in, a change glows once and lets go, a
 * responsibility flies to the part that took it. Only the changes lens draws a diff.
 *
 * The canvas is also a way to speak. Dragging a part only rearranges the
 * drawing — it lifts, a slot shows where it will land, it settles. Dragging a
 * responsibility onto another part changes the architecture, and feels like
 * it: the parts that could take it light up, and the drop commits a move.
 */
/** Keep a gesture's pointer; a pointer the browser no longer tracks is simply not captured. */
function capture(event: ReactPointerEvent): void {
  try {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  } catch {
    // Not an active pointer (a synthetic or already-released one): the gesture still works without capture.
  }
}

export function SystemCanvas(props: Props): ReactElement {
  const { model, layout, selection, onSelect, checking, note, lens, editable, animateArrival, inset, depth } = props;
  const shown = lens?.after ?? model;
  const reduced = usePrefersReducedMotion();

  // ---------------------------------------------------------------- measure
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [measured, setMeasured] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  // Made on first use: a card's ref runs before any effect, so an observer
  // created in one would miss every card already on the canvas. Only the
  // face is observed, so nothing shown around a card moves the drawing.
  const measure = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    observer.current ??= new ResizeObserver((records) => {
      setHeights((current) => {
        let next = current;
        for (const record of records) {
          const id = (record.target as HTMLElement).dataset['face'];
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

  // --------------------------------------------------------------- geometry
  const lensEntries = useMemo(() => new Map((lens?.diff.entries ?? []).map((entry) => [entry.id, entry])), [lens]);
  const ghostParts = useMemo(
    () => (lens ? live(lens.before.parts).filter((part) => lensEntries.get(part.id)?.change === 'removed') : []),
    [lens, lensEntries],
  );
  const parts = useMemo(() => live(shown.parts), [shown]);
  const drawnIds = useMemo(() => [...parts.map((part) => part.id), ...ghostParts.map((part) => part.id)], [parts, ghostParts]);

  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number; slot: DesignSlot | null } | null>(null);
  const [pinned, setPinned] = useState<DesignLayout | null>(null);
  useEffect(() => setPinned(null), [layout]);
  const effectiveLayout = pinned ?? layout;
  const geometry = useMemo(() => canvasGeometry(drawnIds, effectiveLayout, heights), [drawnIds, effectiveLayout, heights]);

  const links = useMemo(() => live(shown.links), [shown]);
  const ghostLinks = useMemo(
    () => (lens ? live(lens.before.links).filter((link) => lensEntries.get(link.id)?.change === 'removed') : []),
    [lens, lensEntries],
  );
  const routes = useMemo(() => routeLinks([...ghostLinks, ...links], geometry.placed, geometry.rows), [ghostLinks, links, geometry]);

  // --------------------------------------------------------------- emphasis
  const previous = useRef<DesignModel | null>(null);
  const previousGeometry = useRef<CanvasGeometry | null>(null);
  const [changes, setChanges] = useState<CanvasChanges>(NO_CHANGES);
  const [leaving, setLeaving] = useState<{ part: DesignPart; at: Placed }[]>([]);
  const [travelling, setTravelling] = useState<CanvasChanges['moved']>([]);
  useEffect(() => {
    if (lens) return;
    const before = previous.current;
    previous.current = model;
    if (!before && !animateArrival) return;
    const next = canvasChanges(before, model);
    if (next === NO_CHANGES) return;
    setChanges(next);
    const gone = next.leaving.flatMap((part) => {
      const at = previousGeometry.current?.placed.get(part.id);
      return at ? [{ part, at }] : [];
    });
    if (gone.length) setLeaving(gone);
    if (next.moved.length && !reduced) setTravelling(next.moved);
  }, [model, lens, animateArrival, reduced]);
  // Each emphasis lets go on its own clock, whatever arrives in between: a
  // preview becoming its committed revision must not cut a change short.
  useEffect(() => {
    if (changes === NO_CHANGES) return;
    const settle = window.setTimeout(() => setChanges(NO_CHANGES), SETTLE_MS + changes.entering.length * STAGGER_MS);
    return () => window.clearTimeout(settle);
  }, [changes]);
  useEffect(() => {
    if (!leaving.length) return;
    const clear = window.setTimeout(() => setLeaving([]), LEAVE_MS);
    return () => window.clearTimeout(clear);
  }, [leaving]);
  useEffect(() => {
    if (!travelling.length) return;
    const land = window.setTimeout(() => setTravelling([]), TRAVEL_MS);
    return () => window.clearTimeout(land);
  }, [travelling]);
  useEffect(() => { if (!lens) previousGeometry.current = geometry; }, [geometry, lens]);
  const arrival = (id: string) => changes.entering.indexOf(id);

  // ------------------------------------------------------------------ focus
  const [hover, setHover] = useState<{ kind: 'part' | 'link'; id: string } | null>(null);
  // A sweep across empty canvas gathers every part it touches.
  const sweep = useRef<{ x: number; y: number; additive: boolean; moved: boolean } | null>(null);
  const [marquee, setMarquee] = useState<{ left: number; top: number; right: number; bottom: number; hits: Set<string> } | null>(null);
  const single = selection.length === 1 ? selection[0]! : null;
  // The one part being thought about, when there is exactly one: it gets the panel beside it.
  const selectedPart = single?.kind === 'part' ? single.id
    : single?.kind === 'duty' ? shown.duties.find((duty) => duty.id === single.id)?.part ?? null
      : null;
  const selectedLink = single?.kind === 'link' ? single.id : null;
  // Every part in the selection, and the links chosen directly.
  const chosenParts = useMemo(() => new Set(selection.flatMap((element) =>
    element.kind === 'part' ? [element.id]
      : element.kind === 'duty' ? [shown.duties.find((duty) => duty.id === element.id)?.part ?? ''] : [])), [selection, shown]);
  const chosenLinks = useMemo(() => new Set(selection.filter((element) => element.kind === 'link').map((element) => element.id)), [selection]);
  const several = chosenParts.size + chosenLinks.size > 1;
  // Links between two chosen parts: what holds the selection together.
  const bonds = useMemo(() => {
    if (chosenParts.size < 2) return new Set<string>();
    return new Set(shown.links.filter((link) => !link.retired && chosenParts.has(link.from) && chosenParts.has(link.to)).map((link) => link.id));
  }, [chosenParts, shown]);
  const focus = useMemo(() => {
    if (lens || (!chosenParts.size && !chosenLinks.size)) return null;
    const parts = new Set<string>();
    const links = new Set<string>();
    for (const id of chosenParts) {
      const near = neighborhood(shown, id);
      near.parts.forEach((part) => parts.add(part));
      near.links.forEach((link) => links.add(link));
    }
    for (const id of chosenLinks) {
      const link = shown.links.find((candidate) => candidate.id === id);
      if (!link) continue;
      links.add(link.id);
      parts.add(link.from);
      parts.add(link.to);
    }
    return { parts, links };
  }, [lens, chosenParts, chosenLinks, shown]);
  const isChosen = (element: CanvasSelection) => selection.some((other) => other.kind === element.kind && other.id === element.id);
  const choose = (element: CanvasSelection, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
    onSelect(nextSelection(selection, element, event.shiftKey || event.metaKey || event.ctrlKey));
  // A pointer resting on a part previews its neighbourhood, lightly.
  const glance = useMemo(() => (!focus && !lens && hover?.kind === 'part' && !drag ? neighborhood(shown, hover.id) : null), [focus, lens, hover, drag, shown]);
  const labels = useMemo(() => visibleLabels(shown, focus ?? glance, hover?.kind === 'link' ? hover.id : null, selectedLink), [shown, focus, glance, hover, selectedLink]);
  const labelAt = useMemo(() => {
    const wanted = links.filter((link) => labels.has(link.id) && link.label).map((link) => ({ id: link.id, text: link.label! }));
    // What attention is on is placed first, so it gets the best spot.
    wanted.sort((a, b) => Number(isLit(b.id)) - Number(isLit(a.id)));
    return placeLabels(wanted, routes, [...geometry.placed.values()]);
  }, [links, labels, routes, geometry, focus, glance, hover, selectedLink]);

  // ------------------------------------------------------------------ camera
  const viewport = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 800, height: 600 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
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
  const room = { width: box.width, height: Math.max(120, box.height - inset.top - inset.bottom) };
  const fit = Math.max(MIN_SCALE, Math.min(MAX_SCALE, room.width / contentWidth, room.height / contentHeight));
  const held = useRef(fit);
  if (!depth) held.current = fit;
  const scale = depth ? held.current : fit;
  const subject = depth ? geometry.placed.get(selectedPart ?? checking ?? '') ?? null : null;
  let offsetX: number;
  let offsetY: number;
  if (depth) {
    const band = box.height * DEPTH_BAND - inset.top;
    if (subject) {
      offsetX = box.width / 2 - (PAD + subject.x + subject.w / 2) * scale;
      offsetY = inset.top + band / 2 - (PAD + subject.y + subject.h / 2) * scale;
    } else {
      offsetX = (box.width - contentWidth * scale) / 2;
      offsetY = inset.top + Math.max(0, (band - contentHeight * scale) / 2);
    }
  } else {
    offsetX = Math.max(0, (box.width - contentWidth * scale) / 2);
    offsetY = inset.top + Math.max(0, (room.height - contentHeight * scale) / 2);
  }
  const toStage = (clientX: number, clientY: number) => {
    const rect = viewport.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left + viewport.current!.scrollLeft - offsetX) / scale - PAD,
      y: (clientY - rect.top + viewport.current!.scrollTop - offsetY) / scale - PAD,
    };
  };
  const toView = (x: number, y: number) => ({ x: offsetX + (PAD + x) * scale - scroll.left, y: offsetY + (PAD + y) * scale - scroll.top });

  // ------------------------------------------------------------ part drag
  const press = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const onPartDown = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0 || lens) return;
    press.current = { id, x: event.clientX, y: event.clientY, moved: false };
    capture(event);
  };
  const dropSlot = (id: string, dx: number, dy: number): DesignSlot | null => {
    const at = geometry.placed.get(id);
    if (!at) return null;
    const target = geometry.slotAt(at.x + at.w / 2 + dx, at.y + at.h / 2 + dy);
    return { ...freeSlot(target, effectiveLayout, parts.map((part) => part.id), id), pinned: true };
  };
  const onPartMove = (event: ReactPointerEvent) => {
    const pressed = press.current;
    if (!pressed) return;
    const dx = (event.clientX - pressed.x) / scale;
    const dy = (event.clientY - pressed.y) / scale;
    if (!pressed.moved && Math.hypot(dx, dy) < 4) return;
    pressed.moved = true;
    setDrag({ id: pressed.id, dx, dy, slot: dropSlot(pressed.id, dx, dy) });
  };
  const onPartUp = (event: ReactPointerEvent, id: string) => {
    const pressed = press.current;
    press.current = null;
    if (!pressed) return;
    if (!pressed.moved) {
      event.stopPropagation();
      choose({ kind: 'part', id }, event);
      return;
    }
    const slot = drag?.slot ?? dropSlot(id, (event.clientX - pressed.x) / scale, (event.clientY - pressed.y) / scale);
    setDrag(null);
    if (!slot) return;
    const current = effectiveLayout[id];
    if (current && current.row === slot.row && current.col === slot.col && current.pinned) return;
    setPinned({ ...effectiveLayout, [id]: slot });
    props.onPin(id, slot);
  };

  // ------------------------------------------------------ duty relocation
  const [dutyDrag, setDutyDrag] = useState<{ id: string; from: string; text: string; x: number; y: number; over: string | null } | null>(null);
  const dutyPress = useRef<{ duty: DesignDuty; x: number; y: number; moved: boolean } | null>(null);
  const dutyGesture: DutyGesture = {
    down(event, duty) {
      event.stopPropagation();
      if (event.button !== 0 || lens) return;
      dutyPress.current = { duty, x: event.clientX, y: event.clientY, moved: false };
      capture(event);
    },
    move(event) {
      const pressed = dutyPress.current;
      if (!pressed || !editable) return;
      if (!pressed.moved && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < 4) return;
      pressed.moved = true;
      const under = document.elementsFromPoint(event.clientX, event.clientY)
        .map((element) => (element as HTMLElement).closest<HTMLElement>('[data-part]'))
        .find((element) => element && !element.classList.contains('ghost') && !element.classList.contains('leaving'));
      const over = under?.dataset['part'] ?? null;
      setDutyDrag({ id: pressed.duty.id, from: pressed.duty.part, text: pressed.duty.text, x: event.clientX, y: event.clientY, over: over === pressed.duty.part ? null : over });
    },
    up(event, duty) {
      event.stopPropagation();
      const pressed = dutyPress.current;
      dutyPress.current = null;
      const dropped = dutyDrag?.over;
      setDutyDrag(null);
      if (!pressed) return;
      if (!pressed.moved) {
        onSelect(single?.kind === 'duty' && single.id === duty.id ? [{ kind: 'part', id: duty.part }] : [{ kind: 'duty', id: duty.id }]);
        return;
      }
      if (dropped && dropped !== duty.part) props.onRelocateDuty(duty.id, dropped);
    },
  };

  // ---------------------------------------------------------------- rename
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { if (selectedPart !== renaming) setRenaming(null); }, [selectedPart, renaming]);
  const startRename = (id: string) => {
    if (!editable || lens) return;
    onSelect([{ kind: 'part', id }]);
    setRenaming(id);
  };
  const [dismissed, setDismissed] = useState<string | null>(null);
  const noteOn = note?.anchor
    ? (shown.parts.some((part) => part.id === note.anchor!.on) ? note.anchor.on
      : shown.duties.find((duty) => duty.id === note.anchor!.on)?.part ?? shown.links.find((link) => link.id === note.anchor!.on)?.to ?? null)
    : null;

  // ------------------------------------------------------------------ draw
  const lensDuties = (partId: string): { duty: DesignDuty; entry: DesignChangeEntry; gone: boolean }[] => {
    if (!lens) return [];
    const now = live(shown.duties)
      .filter((duty) => duty.part === partId)
      .flatMap((duty) => { const entry = lensEntries.get(duty.id); return entry && entry.change !== 'removed' ? [{ duty, entry, gone: false }] : []; });
    const gone = live(lens.before.duties)
      .filter((duty) => duty.part === partId)
      .flatMap((duty) => {
        const entry = lensEntries.get(duty.id);
        return entry && (entry.change === 'removed' || (entry.change === 'changed' && entry.was?.part === partId)) ? [{ duty, entry, gone: true }] : [];
      });
    return [...now, ...gone];
  };

  const card = (part: DesignPart, ghost: boolean) => {
    const at = geometry.placed.get(part.id);
    if (!at) return null;
    const entry = lens ? lensEntries.get(part.id) : undefined;
    const dragging = drag?.id === part.id;
    const x = at.x + (dragging ? drag.dx : 0);
    const y = at.y + (dragging ? drag.dy : 0);
    const order = arrival(part.id);
    const emphasis = focus ?? glance;
    const relocating = dutyDrag !== null;
    const classes = [
      'system-part',
      part.kind && `kind-${part.kind}`,
      ghost && 'ghost',
      chosenParts.has(part.id) && 'selected',
      emphasis && !relocating && (emphasis.parts.has(part.id) ? (chosenParts.has(part.id) ? '' : 'near') : focus ? 'far' : 'faint'),
      marquee?.hits.has(part.id) && 'gathering',
      order !== -1 && 'entering',
      changes.touched.has(part.id) && 'touched',
      checking === part.id && 'checking',
      dragging && 'dragging',
      relocating && dutyDrag.from !== part.id && (dutyDrag.over === part.id ? 'drop-target' : 'receiving'),
      relocating && dutyDrag.from === part.id && 'giving',
      entry?.change === 'added' && 'lens-added',
      entry?.change === 'changed' && entry.fields!.some((field) => field === 'name' || field === 'role') && 'lens-changed',
    ].filter(Boolean).join(' ');
    const diffs = lensDuties(part.id);
    return (
      <div
        key={`${ghost ? 'ghost:' : ''}${part.id}`}
        data-part={part.id}
        className={classes}
        style={{ transform: `translate(${x}px, ${y}px)`, width: at.w, height: at.h, '--arrive-delay': `${reduced ? 0 : Math.max(0, order) * STAGGER_MS}ms` } as CSSProperties}
        tabIndex={ghost ? -1 : 0}
        role={ghost ? undefined : 'button'}
        aria-label={ghost ? undefined : `${part.name}${part.role ? ` — ${part.role}` : ''}`}
        aria-pressed={ghost ? undefined : chosenParts.has(part.id)}
        title={part.name.length > 28 ? part.name : undefined}
        onPointerDown={ghost ? undefined : (event) => onPartDown(event, part.id)}
        onPointerMove={ghost ? undefined : onPartMove}
        onPointerUp={ghost ? undefined : (event) => onPartUp(event, part.id)}
        onPointerEnter={ghost ? undefined : () => setHover({ kind: 'part', id: part.id })}
        onPointerLeave={ghost ? undefined : () => setHover((current) => (current?.id === part.id ? null : current))}
        onKeyDown={ghost ? undefined : (event: ReactKeyboardEvent) => {
          if (event.target !== event.currentTarget || event.key !== 'Enter') return;
          event.preventDefault();
          if (selectedPart === part.id) startRename(part.id);
          else choose({ kind: 'part', id: part.id }, event);
        }}
        onDoubleClick={(event) => {
          if (ghost) return;
          event.stopPropagation();
          startRename(part.id);
        }}
      >
        <div className="system-part-face" data-face={ghost ? undefined : part.id} ref={ghost ? undefined : measure}>
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
          {part.technology?.name && <span className="system-part-tech">{part.technology.name}</span>}
          {part.role && <span className="system-part-role">{part.role}</span>}
        </div>
        {lens && (diffs.length > 0 || entry?.was?.name) && (
          <div className="system-part-annex" onPointerDown={(event) => event.stopPropagation()}>
            {lens && entry?.was?.name && <span className="system-part-was">was {entry.was.name}</span>}
            {diffs.length > 0 && (
              <ul className="system-duty-diff">
                {diffs.map(({ duty, entry: dutyEntry, gone }) => (
                  <li key={`${gone ? 'was:' : ''}${duty.id}`} className={gone ? 'ghost' : dutyEntry.change === 'added' ? 'added' : 'changed'}>{duty.text}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  };

  const edge = (link: DesignLink, ghost: boolean) => {
    const from = geometry.placed.get(link.from);
    const to = geometry.placed.get(link.to);
    if (!from || !to) return null;
    let route: Route | undefined = routes.get(link.id);
    if (drag && (drag.id === link.from || drag.id === link.to)) {
      const moveBy = (card: Placed) => (drag.id === card.id ? { ...card, x: card.x + drag.dx, y: card.y + drag.dy } : card);
      route = looseRoute(moveBy(from), moveBy(to));
    }
    if (!route) return null;
    const entry = lens ? lensEntries.get(link.id) : undefined;
    const emphasis = focus ?? glance;
    const selected = chosenLinks.has(link.id);
    const bond = bonds.has(link.id);
    // With several things gathered, only what holds them together lights up;
    // their other lines stay quiet rather than turning the canvas into a web.
    const lit = several ? bond || selected || hover?.id === link.id : emphasis?.links.has(link.id) || hover?.id === link.id;
    const drawing = changes.drawn.has(link.id) && !reduced;
    const delay = drawing ? Math.max(arrival(link.from), arrival(link.to), 0) * STAGGER_MS + 260 : 0;
    const classes = [
      'system-link',
      ghost && 'ghost',
      selected && 'selected',
      bond && 'bond',
      lit && 'lit',
      emphasis && !lit && (focus ? 'far' : 'faint'),
      dutyDrag && 'faint',
      drawing && 'drawing',
      entry?.change === 'added' && 'lens-added',
      drag && 'still',
    ].filter(Boolean).join(' ');
    const label = labels.has(link.id) && link.label;
    const at = drag ? undefined : labelAt.get(link.id);
    return (
      <g key={`${ghost ? 'ghost:' : ''}${link.id}`} className={classes} style={{ '--draw-delay': `${delay}ms` } as CSSProperties}>
        <path
          className="system-link-line"
          style={{ d: `path('${route.d}')` } as CSSProperties}
          pathLength={drawing ? 1 : undefined}
          markerEnd={`url(#${bond ? 'system-arrow-bond' : lit || selected ? 'system-arrow-lit' : 'system-arrow'})`}
        />
        {lit && !reduced && !ghost && <path className="system-link-flow" style={{ d: `path('${route.d}')` } as CSSProperties} />}
        {!ghost && (
          <path
            className="system-link-hit"
            d={route.d}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerEnter={() => setHover({ kind: 'link', id: link.id })}
            onPointerLeave={() => setHover((current) => (current?.id === link.id ? null : current))}
            onClick={(event) => { event.stopPropagation(); choose({ kind: 'link', id: link.id }, event); }}
          />
        )}
        {label && at && (
          <text className="system-link-label" x={at.x} y={at.y} textAnchor={at.anchor}>{label}</text>
        )}
      </g>
    );
  };

  function isLit(id: string): boolean {
    if (several) return bonds.has(id) || chosenLinks.has(id) || hover?.id === id;
    return Boolean((focus ?? glance)?.links.has(id) || hover?.id === id || chosenLinks.has(id));
  }

  const noteShown = Boolean(note && noteOn && !lens && !depth && dismissed !== note.id && !drag && !dutyDrag);
  const noteAt = noteOn ? geometry.placed.get(noteOn) : undefined;

  const focusPart = selectedPart && !lens && !depth && !renaming ? shown.parts.find((part) => part.id === selectedPart && !part.retired) : undefined;
  const focusAt = focusPart ? geometry.placed.get(focusPart.id) : undefined;
  const focusLink = selectedLink && !lens && !depth ? shown.links.find((link) => link.id === selectedLink && !link.retired) : undefined;
  const focusLinkRoute = focusLink ? routes.get(focusLink.id) : undefined;
  const nameOf = (id: string) => shown.parts.find((part) => part.id === id)?.name ?? id;

  const anchorFor = (at: Placed) => {
    const topLeft = toView(at.x, at.y);
    const bottomRight = toView(at.x + at.w, at.y + at.h);
    return { left: topLeft.x, top: topLeft.y, right: bottomRight.x, bottom: bottomRight.y };
  };

  return (
    <div
      className={[
        'system-canvas',
        measured && 'measured',
        lens && 'lensed',
        dutyDrag && 'relocating',
        drag && 'arranging',
        focus && 'focusing',
        several && 'several',
        marquee && 'gathering',
        depth && 'deep',
      ].filter(Boolean).join(' ')}
      ref={viewport}
      onScroll={() => setScroll({ left: viewport.current!.scrollLeft, top: viewport.current!.scrollTop })}
      onPointerDown={(event) => {
        const target = event.target as Element;
        const background = target === event.currentTarget || target.classList.contains('system-stage') || target.classList.contains('system-parts') || target.classList.contains('system-links');
        if (!background || event.button !== 0) return;
        const rect = viewport.current!.getBoundingClientRect();
        sweep.current = { x: event.clientX - rect.left, y: event.clientY - rect.top, additive: event.shiftKey || event.metaKey || event.ctrlKey, moved: false };
        capture(event);
      }}
      onPointerMove={(event) => {
        const started = sweep.current;
        if (!started || lens) return;
        const rect = viewport.current!.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        if (!started.moved && Math.hypot(x - started.x, y - started.y) < 5) return;
        started.moved = true;
        const box = { left: Math.min(started.x, x), top: Math.min(started.y, y), right: Math.max(started.x, x), bottom: Math.max(started.y, y) };
        const hits = new Set([...geometry.placed.values()]
          .filter((at) => parts.some((part) => part.id === at.id))
          .filter((at) => { const view = anchorFor(at); return view.left < box.right && view.right > box.left && view.top < box.bottom && view.bottom > box.top; })
          .map((at) => at.id));
        setMarquee({ ...box, hits });
      }}
      onPointerUp={() => {
        const started = sweep.current;
        sweep.current = null;
        if (!started) return;
        const gathered = marquee;
        setMarquee(null);
        if (!started.moved) {
          if (!started.additive) onSelect([]);
          return;
        }
        if (!gathered) return;
        // A sweep gathers the parts it touches, in the order they read.
        const swept = parts.filter((part) => gathered.hits.has(part.id)).map((part) => ({ kind: 'part' as const, id: part.id }));
        onSelect(started.additive ? [...selection, ...swept.filter((element) => !isChosen(element))] : swept);
      }}
    >
      <div
        className="system-stage"
        style={{
          width: contentWidth,
          height: contentHeight,
          transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
        }}
      >
        <svg className="system-links" width={contentWidth} height={contentHeight}>
          <defs>
            <marker id="system-arrow" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M 1.5 1.5 L 8.5 5 L 1.5 8.5" className="system-arrow-head" />
            </marker>
            <marker id="system-arrow-lit" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M 1.5 1.5 L 8.5 5 L 1.5 8.5" className="system-arrow-head lit" />
            </marker>
            <marker id="system-arrow-bond" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M 1.5 1.5 L 8.5 5 L 1.5 8.5" className="system-arrow-head bond" />
            </marker>
          </defs>
          <g transform={`translate(${PAD} ${PAD})`}>
            {ghostLinks.map((link) => edge(link, true))}
            {/* A lit line shares its trunk with others; it is drawn last so it reads as whole. */}
            {[...links].sort((a, b) => Number(isLit(a.id)) - Number(isLit(b.id))).map((link) => edge(link, false))}
          </g>
        </svg>
        <div className="system-parts" style={{ left: PAD, top: PAD }}>
          {drag?.slot && (() => {
            const rect = geometry.slotRect(drag.slot);
            const at = geometry.placed.get(drag.id);
            return <div className="system-slot" style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: at?.h ?? rect.h }} />;
          })()}
          {ghostParts.map((part) => card(part, true))}
          {parts.map((part) => card(part, false))}
          {!lens && leaving.map(({ part, at }) => (
            <div key={`leaving:${part.id}`} className="system-part leaving" style={{ transform: `translate(${at.x}px, ${at.y}px)`, width: at.w, height: at.h }}>
              <div className="system-part-face">
                <span className="system-part-name">{part.name}</span>
                {part.role && <span className="system-part-role">{part.role}</span>}
              </div>
            </div>
          ))}
          {travelling.map(({ duty, from, to }) => {
            const a = geometry.placed.get(from);
            const b = geometry.placed.get(to);
            if (!a || !b) return null;
            return (
              <span
                key={`travel:${duty.id}`}
                className="system-duty-travel"
                style={{
                  '--from-x': `${a.x + a.w / 2}px`, '--from-y': `${a.y + a.h / 2}px`,
                  '--to-x': `${b.x + b.w / 2}px`, '--to-y': `${b.y + b.h / 2}px`,
                } as CSSProperties}
              >
                {duty.text}
              </span>
            );
          })}
        </div>
      </div>

      {focusPart && focusAt && (
        <PartFocus
          part={focusPart}
          model={shown}
          anchor={anchorFor(focusAt)}
          bounds={box}
          obstacles={[...geometry.placed.values()].filter((at) => at.id !== focusPart.id).map(anchorFor)}
          selectedDuty={single?.kind === 'duty' ? single.id : null}
          movable={editable}
          dragging={dutyDrag?.id ?? null}
          gesture={dutyGesture}
          changes={props.changesOf(focusPart.id)}
          onShowChange={props.onShowChange}
          onOpenRef={props.onOpenRef}
          onAsk={props.onAsk}
          onRename={editable ? () => startRename(focusPart.id) : null}
          note={noteShown && noteOn === focusPart.id ? { text: note!.text, onDismiss: () => setDismissed(note!.id) } : null}
        />
      )}
      {noteShown && noteAt && noteOn !== focusPart?.id && (
        <PartNote
          text={note!.text}
          anchor={anchorFor(noteAt)}
          bounds={box}
          obstacles={[...geometry.placed.values()].filter((at) => at.id !== noteOn).map(anchorFor)}
          onDismiss={() => setDismissed(note!.id)}
        />
      )}
      {focusLink && focusLinkRoute && (
        <LinkFocus
          link={focusLink}
          from={nameOf(focusLink.from)}
          to={nameOf(focusLink.to)}
          at={toView(focusLinkRoute.label.x, focusLinkRoute.label.y)}
          bounds={box}
          obstacles={[...geometry.placed.values()].map(anchorFor)}
          onAsk={props.onAsk}
        />
      )}

      {marquee && (
        <div className="system-marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top }} />
      )}

      {dutyDrag && (
        <div className={`system-duty-flying${dutyDrag.over ? ' over' : ''}`} style={{ left: dutyDrag.x, top: dutyDrag.y }}>
          {dutyDrag.text}
          {dutyDrag.over && <span className="to">→ {nameOf(dutyDrag.over)}</span>}
        </div>
      )}
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }): ReactElement {
  const [value, setValue] = useState(name);
  const field = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (result: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(result);
  };
  useEffect(() => { field.current?.focus(); field.current?.select(); }, []);
  return (
    <input
      ref={field}
      className="system-part-rename"
      value={value}
      size={Math.max(4, value.length)}
      aria-label="Rename part"
      spellCheck={false}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(value.trim() || null);
        if (event.key === 'Escape') { event.preventDefault(); finish(null); }
      }}
    />
  );
}
