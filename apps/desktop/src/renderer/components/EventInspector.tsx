import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { NormalizedEvent } from '@vowe/core';

interface Props {
  sessionId: string;
  events: NormalizedEvent[];
  /** Event ids cited by a semantic update, highlighted and scrolled to. */
  highlightIds: string[] | null;
  onClearHighlight: () => void;
}

/**
 * Developer-facing view of the normalized stream, with the provider's original
 * record one click away. This is how we check what evidence produced Vowe's
 * description of a session.
 */
export function EventInspector({
  events,
  highlightIds,
  onClearHighlight,
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const firstHighlight = useRef<HTMLTableRowElement | null>(null);

  const highlighted = useMemo(
    () => new Set(highlightIds ?? []),
    [highlightIds],
  );

  useEffect(() => {
    if (highlightIds?.length) {
      setOpen(true);
      firstHighlight.current?.scrollIntoView({ block: 'center' });
    }
  }, [highlightIds]);

  const visible = open ? events : [];
  let markedFirst = false;

  return (
    <div className="card">
      <h2>
        Observed events ({events.length}){' '}
        <button
          style={{ float: 'right', padding: '2px 8px', fontSize: 12 }}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide' : 'Inspect'}
        </button>
      </h2>

      {open && highlightIds?.length ? (
        <p style={{ color: 'var(--muted)', fontSize: 12 }}>
          Highlighting the {highlightIds.length} events cited by the current
          interpretation.{' '}
          <button
            style={{ padding: '1px 8px', fontSize: 11 }}
            onClick={onClearHighlight}
          >
            Clear
          </button>
        </p>
      ) : null}

      {open && (
        <table className="events-table">
          <tbody>
            {visible.map((event) => {
              const isHighlighted = highlighted.has(event.id);
              const ref =
                isHighlighted && !markedFirst
                  ? ((markedFirst = true), firstHighlight)
                  : undefined;
              return (
                <tr
                  key={event.id}
                  ref={ref}
                  className={isHighlighted ? 'evidence' : undefined}
                >
                  <td className="kind">#{event.seq}</td>
                  <td className="kind">{event.kind}</td>
                  <td className="summary">
                    <div>{event.summary}</div>
                    <button
                      style={{ padding: '1px 8px', fontSize: 11, marginTop: 4 }}
                      onClick={() =>
                        setExpanded(expanded === event.id ? null : event.id)
                      }
                    >
                      {expanded === event.id ? 'Hide raw' : 'Raw'}
                    </button>
                    {expanded === event.id && (
                      <>
                        <div
                          style={{
                            color: 'var(--muted)',
                            fontSize: 11,
                            marginTop: 6,
                          }}
                        >
                          {event.rawRef.source}:{event.rawRef.line} (byte{' '}
                          {event.rawRef.byteOffset})
                        </div>
                        <pre className="raw">
                          {JSON.stringify(event.raw, null, 2)}
                        </pre>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
