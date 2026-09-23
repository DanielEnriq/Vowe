import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import type { ContextRef } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import {
  filterEntries,
  flattenEntries,
  groupEntries,
  moveCursor,
  type LauncherEntry,
} from '../state/object-launcher.js';

interface Props {
  entries: LauncherEntry[];
  /** Repository files by name. Answers with nothing for a blank query. */
  findFiles: (query: string) => Promise<LauncherEntry[]>;
  onOpen: (ref: ContextRef) => void;
  onDismiss: () => void;
}

/** Long enough that a typed word is one search, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 120;

/**
 * What do you want to look at?
 *
 * An object launcher, not a capability menu. Every row is a concrete thing —
 * this diff, this file, this lesson — and it is here because something real
 * produced it: a section with nothing behind it is not drawn, and there are no
 * greyed-out rows standing in for things Vowe cannot address yet.
 *
 * The distinction is the point. A menu of capabilities describes the product;
 * a menu of objects describes the work.
 */
export function ObjectLauncher({
  entries,
  findFiles,
  onOpen,
  onDismiss,
}: Props): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<LauncherEntry[]>([]);
  const [cursorId, setCursorId] = useState<string | null>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      // Never scroll to reach it: the field is already on screen, and a
      // scroll-into-view here moves whatever is behind the popover.
      field.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [onDismiss]);

  /*
   * The repository, asked only once the typing settles.
   *
   * The previous answer stays on screen while a new one is in flight — a
   * spinner or a flash of emptiness between two lists is more movement than
   * the result is worth — and a reply that arrives after a later one has been
   * asked for is dropped.
   */
  useEffect(() => {
    const wanted = query;
    if (!wanted.trim()) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void findFiles(wanted)
        .then((next) => {
          if (live) setFound(next);
        })
        .catch(() => undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, findFiles]);

  const groups = useMemo(
    () => groupEntries([...filterEntries(entries, query), ...found]),
    [entries, query, found],
  );
  const flat = useMemo(() => flattenEntries(groups), [groups]);
  const ids = useMemo(() => flat.map((entry) => entry.id), [flat]);

  // A cursor left pointing at a row that a keystroke removed is a cursor on
  // nothing; it goes back to the top of what is actually there.
  const cursor = cursorId && ids.includes(cursorId) ? cursorId : (ids[0] ?? null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onDismiss();
        return;
      case 'ArrowDown':
        event.preventDefault();
        setCursorId(moveCursor(ids, cursor, 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        setCursorId(moveCursor(ids, cursor, -1));
        return;
      case 'Enter': {
        const chosen = flat.find((entry) => entry.id === cursor);
        if (!chosen) return;
        event.preventDefault();
        onOpen(chosen.ref);
        return;
      }
      case 'Tab':
        // Focus escaping a popover that is still open is worse than closing it.
        onDismiss();
        return;
      default:
    }
  };

  return (
    <div
      className="menu launcher"
      role="dialog"
      aria-label="Open something"
      ref={root}
      onKeyDown={onKeyDown}
    >
      <input
        className="launcher-field"
        ref={field}
        value={query}
        placeholder="Search or open…"
        aria-label="Search or open"
        role="combobox"
        aria-expanded
        aria-controls="launcher-list"
        aria-autocomplete="list"
        {...(cursor ? { 'aria-activedescendant': `launcher-${cursor}` } : {})}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="launcher-list" id="launcher-list" role="listbox" aria-label="Results">
        {groups.map((group) => (
          <Fragment key={group.section}>
            <span className="menu-label" id={`launcher-section-${group.section}`}>
              {group.label}
            </span>
            <div role="group" aria-labelledby={`launcher-section-${group.section}`}>
              {group.entries.map((entry) => (
                <div
                  className={`launcher-entry${entry.id === cursor ? ' is-cursor' : ''}`}
                  key={entry.id}
                  id={`launcher-${entry.id}`}
                  role="option"
                  aria-selected={entry.id === cursor}
                  onMouseEnter={() => setCursorId(entry.id)}
                  // `mousedown` with the default prevented, so choosing
                  // something never takes focus out of the field first.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onOpen(entry.ref);
                  }}
                >
                  <Fading className="label">{entry.label}</Fading>
                  {entry.detail && <Fading className="detail">{entry.detail}</Fading>}
                </div>
              ))}
            </div>
          </Fragment>
        ))}
        {!flat.length && (
          <p className="empty">
            {query.trim() ? `Nothing matching “${query.trim()}”.` : 'Nothing to open yet.'}
          </p>
        )}
      </div>
    </div>
  );
}
