import {
  createContext,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The window's one application band.
 *
 * What lives here is what belongs to the *window* rather than to what is in
 * it: the space macOS wants for its own controls, and the two panel toggles.
 * Nothing else. The band is transparent and stretches the full width, so the
 * three surfaces below — panel, room, desk — run underneath it unbroken; it
 * paints no background of its own and draws no rule.
 *
 * **What is not here any more: the room's identity.** It was, and it was
 * wrong in one specific way. A room's title placed on the band takes its x
 * from the band — from where the traffic lights end and the toggle after them
 * — so it belonged to the window and not to the room it names. Open the
 * projects panel and the room moved out from under its own title; the only
 * way back was to add the panel's width to the title as a margin, which is
 * the compensation this layout exists to avoid.
 *
 * So identity is placed by the room, in the room's own column, at the room's
 * own inset — see `.room-identity`. It still sits on the band's row, because
 * that is the right height for it, but the band no longer decides where along
 * that row it starts. The sidebar pushes the room; the room takes its title
 * with it.
 *
 * The band therefore has no hit area of its own except its controls: it is
 * `pointer-events: none` with the controls opted back in, so the identity
 * beneath it is clickable. Dragging the window is unaffected — a draggable
 * region is an OS-level rect, not a hit test — and the identity's own buttons
 * subtract themselves from it.
 */
interface Slots {
  actions: HTMLElement | null;
}

const SlotContext = createContext<Slots>({ actions: null });

export function TopChrome({
  controls,
  children,
}: {
  /** The window's own controls, at the left. */
  controls: ReactNode;
  /** The body. A sibling row, so the band is never inside what it labels. */
  children: ReactNode;
}): ReactElement {
  const [actions, setActions] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <header className="top-chrome">
        <div className="chrome-controls">{controls}</div>
        <div className="chrome-actions" ref={setActions} />
      </header>
      <SlotContext.Provider value={{ actions }}>{children}</SlotContext.Provider>
    </>
  );
}

/**
 * What this room is, said at the top of the room.
 *
 * Rendered where the room is and *drawn* where the room is — the one row of
 * the room that happens to be level with the application band. It is an
 * ordinary first child of the room's grid, so its left edge is the room's left
 * edge plus the room's inset, and nothing about it knows whether a panel is
 * open. When one opens, the room's column moves and this moves with it.
 *
 * A room with nothing worth stating simply does not use this, and its first
 * row is empty; the row is the same height either way, because the one thing
 * the geometry must never depend on is what happens to be open.
 */
export function RoomIdentity({ children }: { children: ReactNode }): ReactElement {
  return <div className="room-identity">{children}</div>;
}

/**
 * The same, for a control the room owns that belongs on the band's right.
 *
 * This one really is the window's: the desk's toggle sits at a fixed distance
 * from the window's right edge whether the desk is open or shut, so it is on
 * the band and reserves no column anywhere. Hence the portal — it is the room
 * that knows the desk's state, and the band that knows where the control goes.
 */
export function RoomActions({ children }: { children: ReactNode }): ReactElement | null {
  const { actions } = useContext(SlotContext);
  return actions ? createPortal(children, actions) : null;
}
