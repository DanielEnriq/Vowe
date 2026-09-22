import type { ReactElement } from 'react';

import { DeskIcon, PanelIcon } from './icons.js';

interface Props {
  side: 'left' | 'right';
  open: boolean;
  /** Something arrived on this side that has not been looked at. */
  unseen?: boolean;
  label: string;
  onToggle: () => void;
}

/**
 * The control that opens and closes a panel, at one place in the window.
 *
 * It was briefly moved into each panel's own header, on the argument that a
 * control belongs beside the boundary it moves. In use that was wrong twice
 * over: the control travelled with the panel edge, so the thing you click to
 * bring the panel back was never where you last clicked it; and the closed
 * state needed a second control somewhere else, which meant two different
 * glyphs for one act.
 *
 * So it is overlay chrome again, and one control in both states. `position:
 * fixed` at the window's own chrome coordinates — never a grid column, never a
 * flex child — so the shell's columns are free to collapse to nothing
 * underneath it and the panel animates past a control that does not move. The
 * glyph is the panel outline it always was, not an arrow: the button *is* the
 * panel, and whether it is showing is said by `aria-expanded` and by the panel
 * being there.
 */
export function PanelToggle({
  side,
  open,
  unseen = false,
  label,
  onToggle,
}: Props): ReactElement {
  // Where the slot is, and how it answers fullscreen, is the shell's geometry
  // rather than this control's: both come from the chrome variables.
  return (
    <button
      className={`panel-toggle ${side}${open ? ' open' : ''}`}
      type="button"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={onToggle}
    >
      {side === 'left' ? <PanelIcon /> : <DeskIcon />}
      {/*
        A dot, not a count. How many things are on the desk is an
        implementation detail of the desk; that something is there which you
        have not seen is the only part worth saying out here — and only while
        the desk is away, since an open desk shows them itself.
      */}
      {unseen && !open && <span className="unseen" aria-hidden />}
    </button>
  );
}
