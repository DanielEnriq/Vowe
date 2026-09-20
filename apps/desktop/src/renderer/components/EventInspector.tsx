import { useEffect, useMemo, useState, type ReactElement } from 'react';

import type { NormalizedEvent } from '@vowe/core';

import { CloseIcon } from './ui.js';

interface Props {
  sessionId: string;
  /** The observed stream, as loaded for this session. */
  events: NormalizedEvent[];
  /** Event ids cited by the current interpretation. */
  citedIds: string[];
  /** Events inside one window's trace range, when a note asked for them. */
  traceIds: string[] | null;
  /** Which list to show; the owner switches when evidence or a trace is requested. */
  view: EvidenceView;
  onViewChange: (view: EvidenceView) => void;
  onClose: () => void;
}

/**
 * Developer-facing view of the normalized stream, with the provider's original
 * record one click away. This is how we check what evidence produced Vowe's
 * description of a session.
 */
export type EvidenceView = 'cited' | 'all' | 'trace';

export function EventInspector({
  sessionId,
  events,
  citedIds,
  traceIds,
  view,
  onViewChange,
  onClose,
}: Props): ReactElement {
  const [cited, setCited] = useState<NormalizedEvent[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Cited events may be older than the loaded window, so fetch them by id.
  const citedKey = citedIds.join(',');
  useEffect(() => {
    let cancelled = false;
    if (citedIds.length === 0) {
      setCited([]);
      return;
    }
    void window.vowe
      .getEventsByIds(sessionId, citedIds)
      .then((found) => {
        if (!cancelled) setCited([...found].sort((a, b) => a.seq - b.seq));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId, citedKey]);

  const citedSet = useMemo(() => new Set(citedIds), [citedIds]);
  const traceSet = useMemo(() => new Set(traceIds ?? []), [traceIds]);
  const shown =
    view === 'cited'
      ? cited
      : view === 'trace'
        ? events.filter((event) => traceSet.has(event.id))
        : events;

  return (
    <aside className="evidence" aria-label="Evidence">
      <div className="evidence-head">
        <div className="titles">
          <span className="title">Evidence</span>
          <span className="sub">
            {view === 'cited'
              ? 'The events behind the current summary'
              : view === 'trace'
                ? 'The trace one window note was made from'
                : 'Everything observed in this session'}
          </span>
        </div>
        <button className="icon-btn" aria-label="Close evidence" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="segmented stretch" role="group" aria-label="Which events">
        {traceIds && (
          <button
            aria-pressed={view === 'trace'}
            onClick={() => onViewChange('trace')}
          >
            Window · {traceIds.length}
          </button>
        )}
        <button
          aria-pressed={view === 'cited'}
          onClick={() => onViewChange('cited')}
        >
          Cited · {citedIds.length}
        </button>
        <button aria-pressed={view === 'all'} onClick={() => onViewChange('all')}>
          All · {events.length}
        </button>
      </div>

      <div className="evidence-list">
        {shown.length === 0 && (
          <p className="none">
            {view === 'cited'
              ? 'The current summary doesn’t cite any events.'
              : view === 'trace'
                ? 'That window’s events are no longer loaded.'
                : 'Nothing observed yet.'}
          </p>
        )}
        {shown.map((event) => {
          const open = expanded === event.id;
          const isCited = view === 'all' && citedSet.has(event.id);
          return (
            <div
              key={event.id}
              className={`ev${open ? ' open cited' : isCited ? ' cited' : ''}`}
            >
              <button
                className="ev-row"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : event.id)}
              >
                <span className="seq">#{event.seq}</span>
                <span className="kind">{event.kind}</span>
                <span className="sum">{event.summary}</span>
              </button>
              {open && (
                <>
                  <span className="ev-ref">
                    {event.rawRef.source} · line {event.rawRef.line} · byte{' '}
                    {event.rawRef.byteOffset}
                  </span>
                  <pre>{JSON.stringify(event.raw, null, 2)}</pre>
                </>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
