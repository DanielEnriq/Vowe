import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { DesignSummary } from '@vowe/core';

import { formatAgo } from '../components/ui.js';

/**
 * A project's designs, to go back to.
 *
 * Each row is recognisable before it is read: the design's own shape in
 * miniature — where its parts sit, nothing more — beside its title and what it
 * is for. A design that was started and never spoken in is not a design yet,
 * so it is left out unless it is the one open.
 */
export function browsable(designs: readonly DesignSummary[], activeId: string | null): DesignSummary[] {
  return designs.filter((design) => design.id === activeId || design.revisions > 0 || design.updatedAt !== design.createdAt);
}

/** The design in view, and a way to any other. */
export function DesignSwitcher({
  designs, activeId, onSelect, onNew,
}: {
  designs: readonly DesignSummary[];
  activeId: string | null;
  onSelect: (designId: string) => void;
  onNew: (() => void) | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const listed = browsable(designs, activeId);
  const current = designs.find((design) => design.id === activeId);
  return (
    <div className="design-switcher" ref={box}>
      <button type="button" className="design-switcher-button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <span className="title">{current?.title ?? 'Designs'}</span>
        <span className="count">{listed.length > 1 ? listed.length : ''}</span>
      </button>
      {open && (
        <div className="design-switcher-menu" role="menu" aria-label="Designs in this project">
          <DesignList
            designs={listed}
            activeId={activeId}
            onSelect={(id) => { setOpen(false); onSelect(id); }}
          />
          {onNew && (
            <button type="button" className="link-button design-switcher-new" onClick={() => { setOpen(false); onNew(); }}>
              New design
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function DesignList({
  designs, activeId, onSelect,
}: {
  designs: readonly DesignSummary[];
  activeId: string | null;
  onSelect: (designId: string) => void;
}): ReactElement {
  return (
    <ol className="design-list">
      {designs.map((design) => (
        <li key={design.id}>
          <button
            type="button"
            role="menuitem"
            className={`design-row${design.id === activeId ? ' current' : ''}`}
            aria-current={design.id === activeId ? 'true' : undefined}
            onClick={() => onSelect(design.id)}
          >
            <DesignShape outline={design.outline} />
            <span className="design-row-text">
              <span className="design-row-title">{design.title}</span>
              {design.intent && <span className="design-row-intent">{design.intent}</span>}
              <span className="design-row-meta">
                {design.parts ? `${design.parts} part${design.parts === 1 ? '' : 's'} · ` : design.revisions ? 'A document · ' : ''}
                {formatAgo(design.updatedAt)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/** The design's shape in miniature: one small block where each part sits. */
function DesignShape({ outline }: { outline: DesignSummary['outline'] }): ReactElement {
  const width = 56;
  const height = 42;
  if (!outline.length) return <span className="design-shape empty" aria-hidden="true" />;
  const minRow = Math.min(...outline.map((slot) => slot.row));
  const minCol = Math.min(...outline.map((slot) => slot.col));
  const rows = Math.max(...outline.map((slot) => slot.row)) - minRow + 1;
  const cols = Math.max(...outline.map((slot) => slot.col)) - minCol + 1;
  const cell = Math.min((width - 8) / cols, (height - 8) / rows);
  const block = { w: Math.min(12, cell * 0.72), h: Math.min(5, cell * 0.36) };
  const left = (width - cols * cell) / 2;
  const top = (height - rows * cell) / 2;
  return (
    <svg className="design-shape" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {outline.map((slot, index) => (
        <rect
          key={index}
          x={left + (slot.col - minCol) * cell + (cell - block.w) / 2}
          y={top + (slot.row - minRow) * cell + (cell - block.h) / 2}
          width={block.w}
          height={block.h}
          rx={1.5}
        />
      ))}
    </svg>
  );
}
