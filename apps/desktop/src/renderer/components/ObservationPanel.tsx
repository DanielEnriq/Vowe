import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type {
  AgentSession,
  ContextRef,
  NormalizedEvent,
  SurfaceUpdate,
  WindowNote,
} from '@vowe/core';
import type { ObservationView } from '../../shared/ipc.js';

interface Props {
  session: AgentSession;
  /** The session's stored events, already loaded by the detail view. */
  events: NormalizedEvent[];
  onShowEvidence: (eventIds: string[]) => void;
  /** Vo shows "getting up to speed…" too, from the same single source. */
  onCatchingUpChange: (catchingUp: boolean) => void;
}

/**
 * What the observer has understood so far, and what it thought was worth
 * saying.
 *
 * This is also the text view everything degrades to: with no voice credential
 * and no decision model, the notes and the candidates are still all here, which
 * is what makes the harness inspectable rather than a black box behind a
 * microphone.
 */
export function ObservationPanel({
  session,
  events,
  onShowEvidence,
  onCatchingUpChange,
}: Props): ReactElement {
  const [view, setView] = useState<ObservationView | null>(null);
  const [preference, setPreference] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const next = await window.vowe.getObservation(session.id);
    setView(next);
    setPreference(next.status.communicationPreference ?? '');
    onCatchingUpChange(next.status.catchingUp);
  }, [onCatchingUpChange, session.id]);

  useEffect(() => {
    void reload();
    return window.vowe.onObservationChanged((sessionId) => {
      if (sessionId === session.id) void reload();
    });
  }, [reload, session.id]);

  const observing = view?.status.observing ?? false;

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      if (observing) await window.vowe.stopObserving(session.id);
      else await window.vowe.startObserving(session.id);
      await reload();
    } finally {
      setBusy(false);
    }
  }, [observing, reload, session.id]);

  const savePreference = useCallback(async () => {
    await window.vowe.setCommunicationPreference(
      session.id,
      preference.trim() || null,
    );
    await reload();
  }, [preference, reload, session.id]);

  return (
    <div className="card">
      <h2>
        Observation{' '}
        {view && (
          <span className={`badge ${observing ? 'llm' : ''}`}>
            {observing
              ? view.status.catchingUp
                ? 'getting up to speed…'
                : 'live'
              : 'not observing'}
          </span>
        )}
        <span className="badge" style={{ marginLeft: 6 }}>
          {view?.status.windowsProcessed ?? 0} windows
        </span>
      </h2>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button onClick={() => void toggle()} disabled={busy}>
          {observing ? 'Stop observing' : 'Observe this session'}
        </button>
      </div>

      <label style={{ display: 'block', marginBottom: 10 }}>
        <div style={{ color: 'var(--muted)', marginBottom: 4 }}>
          When should Vo interrupt you about this session?
        </div>
        <input
          value={preference}
          placeholder="Only tell me if something looks weird."
          onChange={(event) => setPreference(event.target.value)}
          onBlur={() => void savePreference()}
          style={{ width: '100%' }}
        />
      </label>

      {view && view.surfaceUpdates.length > 0 && (
        <>
          <h3>Surfaced</h3>
          {view.surfaceUpdates
            .slice()
            .reverse()
            .map((update) => (
              <SurfaceRow key={update.id} update={update} />
            ))}
        </>
      )}

      <h3>Window notes</h3>
      {!view?.notes.length && (
        <p style={{ color: 'var(--muted)' }}>
          {observing
            ? 'Nothing interpreted yet.'
            : 'This session is not being observed yet.'}
        </p>
      )}
      {view?.notes
        .slice()
        .reverse()
        .map((note) => (
          <NoteRow
            key={note.id}
            note={note}
            onShowEvidence={onShowEvidence}
            findEvents={(ref) => eventIdsFor(events, ref)}
          />
        ))}
    </div>
  );
}

function SurfaceRow({ update }: { update: SurfaceUpdate }): ReactElement {
  const action = update.decision?.action ?? 'pending';
  return (
    <div className="entry">
      <div>
        <span className={`badge ${action === 'speak_now' ? 'warn' : ''}`}>{action}</span>{' '}
        {update.message}
      </div>
      <div style={{ color: 'var(--muted)' }}>{update.whyNow}</div>
      {update.decision && (
        <div style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
          {update.decision.reason} ({update.decision.source}
          {update.deliveredAt ? ', delivered' : ''})
        </div>
      )}
    </div>
  );
}

function NoteRow({
  note,
  onShowEvidence,
  findEvents,
}: {
  note: WindowNote;
  onShowEvidence: (eventIds: string[]) => void;
  findEvents: (ref: ContextRef) => string[];
}): ReactElement {
  const traceRef = note.refs.find((ref) => ref.kind === 'trace');
  return (
    <div className="entry">
      <div>
        <span className="badge">window {note.windowIndex}</span>{' '}
        {note.investigated && <span className="badge">investigated</span>} {note.summary}
      </div>
      {note.currentActivity && (
        <div style={{ color: 'var(--muted)' }}>Now: {note.currentActivity}</div>
      )}
      {note.notableChange && (
        <div style={{ color: 'var(--muted)' }}>Notable: {note.notableChange}</div>
      )}
      {traceRef && (
        // Every note is traceable to the exact L0 range that produced it; this
        // is the button that makes that claim checkable rather than decorative.
        <button
          className="link"
          onClick={() => onShowEvidence(findEvents(traceRef))}
        >
          Show the trace this came from
        </button>
      )}
    </div>
  );
}

/**
 * Resolve a window's trace range to the stored events inside it.
 *
 * The existing event inspector takes event ids, so the `seq` range is mapped
 * onto them here rather than teaching the inspector about windows. This is the
 * descent from L1 to L0, made clickable.
 */
function eventIdsFor(events: NormalizedEvent[], ref: ContextRef): string[] {
  if (ref.kind !== 'trace') return [];
  return events
    .filter((event) => event.seq >= ref.startSeq && event.seq <= ref.endSeq)
    .map((event) => event.id);
}
