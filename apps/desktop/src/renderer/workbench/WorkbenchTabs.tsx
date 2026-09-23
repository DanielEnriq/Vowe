import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';

import { Fading } from '../shell/Fading.js';
import { CloseIcon, PlusIcon } from '../shell/icons.js';
import {
  idAfterClose,
  nextTabFocus,
  scrollEdges,
  type ScrollEdges,
} from '../state/workbench-tabs.js';
import type { WorkbenchTab } from '../state/workbench.js';
import { ObjectLauncher } from './ObjectLauncher.js';
import type { LauncherEntry } from '../state/object-launcher.js';
import type { ContextRef } from '@vowe/core';

interface Props {
  tabs: WorkbenchTab[];
  activeId: string | null;
  newIds: string[];
  entries: LauncherEntry[];
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onOpenRef: (ref: ContextRef) => void;
  findFiles: (query: string) => Promise<LauncherEntry[]>;
  launcherOpen: boolean;
  onLauncherOpen: (open: boolean) => void;
}

const NO_EDGES: ScrollEdges = { start: false, end: false };

/**
 * What is open, along the top.
 *
 * This replaced a chip strip along the bottom that named the same artifacts
 * the header above already named — two selection systems a panel apart, one
 * of which was the title. The tab is the name now, so the header is gone and
 * the strip moved to where a strip of open things belongs.
 *
 * Every tab is one line and the strip never wraps. A strip that wraps grows
 * downwards into the artifact, and the desk's vertical space is for the
 * artifact. It scrolls sideways instead, and fades at whichever edge has more
 * beyond it.
 *
 * It renders even when nothing is open, because the `+` has to be reachable
 * before there is anything to reach past.
 *
 * The strip sits on the window's own band, level with the panel toggles rather
 * than tucked under them, and the `+` sits at its right end beside the desk's
 * control — one row of controls along the top of the window instead of two
 * rows a chrome-height apart.
 */
export function WorkbenchTabs({
  tabs,
  activeId,
  newIds,
  entries,
  onActivate,
  onClose,
  onOpenRef,
  findFiles,
  launcherOpen,
  onLauncherOpen,
}: Props): ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const launcherButton = useRef<HTMLButtonElement>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_EDGES);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const next = scrollEdges(element.scrollLeft, element.scrollWidth, element.clientWidth);
    // Identity preserved when nothing moved, so an ordinary scroll does not
    // re-render the strip on every frame of it.
    setEdges((was) => (was.start === next.start && was.end === next.end ? was : next));
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The content too: a tab opening, closing or being renamed changes what
    // there is to scroll past without changing the scroller's own box.
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, tabs.length]);

  /*
   * The active tab, brought into view.
   *
   * Keyed on the active id alone, so it never re-runs from a scroll event —
   * which is how it stays out of a fight with the developer's own scrolling.
   * `inline: 'nearest'` does nothing when the tab is already visible, and
   * there is no smooth behaviour to sit out under reduced motion.
   */
  useLayoutEffect(() => {
    if (!activeId) return;
    nodes.current.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const ids = tabs.map((tab) => tab.id);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = focusedId ?? activeId;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (!current) return;
      event.preventDefault();
      setFocusedId(idAfterClose(ids, current, current));
      onClose(current);
      return;
    }
    const next = nextTabFocus(ids, current, event.key);
    if (!next) return;
    event.preventDefault();
    setFocusedId(next);
    nodes.current.get(next)?.focus();
  };

  return (
    <div className="workbench-tabs">
      <div
        className={`tabs${edges.start ? ' more-start' : ''}${edges.end ? ' more-end' : ''}`}
        ref={scroller}
        role="tablist"
        aria-label="Open artifacts"
        aria-orientation="horizontal"
        onScroll={measure}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              className={
                `tab${active ? ' active' : ''}` +
                `${tab.status === 'preview' ? ' preview' : ''}` +
                `${newIds.includes(tab.id) ? ' unseen' : ''}`
              }
              key={tab.id}
              id={`tab-${tab.id}`}
              role="tab"
              aria-selected={active}
              aria-controls="workbench-panel"
              /*
               * Manual activation, not automatic. Showing an artifact runs the
               * highlighter over it, so arrowing across eight tabs under
               * automatic activation would highlight eight files to get to one.
               */
              tabIndex={tab.id === (focusedId ?? activeId) ? 0 : -1}
              ref={(node) => {
                if (node) nodes.current.set(tab.id, node);
                else nodes.current.delete(tab.id);
              }}
              onClick={() => onActivate(tab.id)}
              onFocus={() => setFocusedId(tab.id)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onActivate(tab.id);
              }}
            >
              <Fading className="tab-label">{tab.title}</Fading>
              {/*
                One slot, two things in it. Activating a tab retires its dot, so
                the dot and the close button never need to be visible at once —
                and sharing a box keeps the tab's width steady under the pointer.
              */}
              <span className="tab-slot">
                <span className="tab-dot" aria-hidden />
                <button
                  className="tab-close"
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  <CloseIcon size={10} />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      <button
        className="icon-button tab-launcher"
        type="button"
        ref={launcherButton}
        aria-label="Open something"
        aria-haspopup="dialog"
        aria-expanded={launcherOpen}
        onClick={() => onLauncherOpen(!launcherOpen)}
      >
        <PlusIcon />
      </button>

      {launcherOpen && (
        <ObjectLauncher
          entries={entries}
          findFiles={findFiles}
          onOpen={(ref) => {
            onOpenRef(ref);
            onLauncherOpen(false);
          }}
          onDismiss={() => {
            onLauncherOpen(false);
            launcherButton.current?.focus();
          }}
        />
      )}
    </div>
  );
}
