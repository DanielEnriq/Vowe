import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';
import { sessionTitle } from '@vowe/core/projections';

import { Fading } from '../shell/Fading.js';
import { formatAgoShort } from '../components/ui.js';
import { isArchived, isRecent, searchSessions } from '../state/session-visibility.js';

interface Props {
  /** Every session in this project, including the ones the panel is hiding. */
  sessions: AgentSession[];
  now: number;
  onOpen: (sessionId: string) => void;
  /** Only ever used to bring one back: opening is what un-archives it. */
  onUnarchive: (sessionId: string) => void;
  onDismiss: () => void;
}

/**
 * Everything this project has, including what the panel is not showing.
 *
 * The projects panel lists recent work, which means most of a repository's
 * history is deliberately not in it. This is where that history is: one field,
 * every session, newest first — and the way an archived session comes back,
 * because opening one is what un-archives it.
 *
 * Finding and opening, and nothing else. Putting a session away belongs to
 * the row in the panel, where the thing being dismissed is in front of you —
 * a control for it here would be offering to hide something you just went
 * looking for, and it was taking the width the ages needed.
 *
 * Not a second sidebar. It closes the moment it has been used.
 */
export function SessionFinder({
  sessions,
  now,
  onOpen,
  onUnarchive,
  onDismiss,
}: Props): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

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

  const found = searchSessions(sessions, query);

  return (
    <div
      className="menu finder"
      role="dialog"
      aria-label="Find a session"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDismiss();
      }}
    >
      <input
        className="launcher-field"
        ref={field}
        value={query}
        placeholder="Find a session…"
        aria-label="Find a session"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="launcher-list" role="listbox" aria-label="Sessions">
        {found.map((session) => {
          const archived = isArchived(session);
          return (
            <div className="finder-row" key={session.id} role="option" aria-selected={false}>
              <button
                className="finder-open"
                type="button"
                onClick={() => {
                  // Opening is what brings one back: there is no separate
                  // un-archive to go looking for.
                  if (archived) onUnarchive(session.id);
                  onOpen(session.id);
                  onDismiss();
                }}
              >
                <span className="line">
                  <span className={`dot ${session.status}`} aria-hidden />
                  <Fading className="label" reveal>
                    {sessionTitle(session)}
                  </Fading>
                  {/*
                    When this last moved, against the right edge.
                    
                    The list is every session this project has ever had, most
                    of them finished, so "which one was I in" is usually a
                    question about recency. Right-aligned so the ages form a
                    column that can be read down without reading the names.
                  */}
                  <span className="when">{formatAgoShort(session.lastActivityAt, now)}</span>
                </span>
                {/*
                  Said only where it explains an absence. A recent session that
                  nobody archived is in the panel already, and labelling it
                  "showing" would be noise.
                */}
                {archived ? (
                  <span className="why">Put away</span>
                ) : !isRecent(session, now) ? (
                  <span className="why">Older than a week</span>
                ) : null}
              </button>
            </div>
          );
        })}
        {!found.length && (
          <p className="empty">
            {query.trim() ? `No session matching “${query.trim()}”.` : 'No sessions in this project yet.'}
          </p>
        )}
      </div>
    </div>
  );
}
