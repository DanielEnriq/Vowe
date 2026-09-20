import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type {
  AgentSession,
  CommunicationAction,
  ContextRef,
  NormalizedEvent,
  SurfaceUpdate,
  WindowNote,
} from '@vowe/core';
import type { ObservationView } from '../../shared/ipc.js';

import { MicOffIcon, formatClock } from './ui.js';

interface Props {
  session: AgentSession;
  /** The session's stored events, already loaded by the detail view. */
  events: NormalizedEvent[];
  voiceConfigured: boolean;
  voiceUnavailableReason: string | null;
  onShowTrace: (eventIds: string[]) => void;
  /** Vo shows "getting up to speed…" too, from the same single source. */
  onCatchingUpChange: (catchingUp: boolean) => void;
}

/**
 * What the observer has understood so far, and what it thought was worth
 * saying.
 *
 * This is also the view everything degrades to: with no voice credential and no
 * decision model, the notes and the candidates are still all here, which is what
 * makes the harness inspectable rather than a black box behind a microphone.
 */
export function ObservationPanel({
  session,
  events,
  voiceConfigured,
  voiceUnavailableReason,
  onShowTrace,
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
  const catchingUp = view?.status.catchingUp ?? false;

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

  const surfaced = view ? [...view.surfaceUpdates].reverse() : [];
  const notes = view ? [...view.notes].reverse() : [];

  return (
    <section className="observation" aria-label="Observation">
      <div className="obs-head">
        <h2>Observation</h2>
        <span className="state-chip">
          <span
            className={`dot small ${observing ? (catchingUp ? 'waiting' : 'working') : 'idle'}`}
          />
          {observing ? (catchingUp ? 'Getting up to speed…' : 'Live') : 'Not observing'}
        </span>
        {observing && (
          <span className="count">
            {view?.status.windowsProcessed ?? 0} windows processed
          </span>
        )}
        <span className="spacer" />
        <button className="btn tiny" disabled={busy} onClick={() => void toggle()}>
          {observing ? 'Stop observing' : 'Observe this session'}
        </button>
      </div>

      <div className="field">
        <label htmlFor="preference">
          When should Vo interrupt you about this session?
        </label>
        <input
          id="preference"
          value={preference}
          placeholder="Only tell me if something looks weird."
          onChange={(event) => setPreference(event.target.value)}
          onBlur={() => void savePreference()}
        />
      </div>

      {!voiceConfigured && (
        <div className="degraded">
          <MicOffIcon />
          <span>
            Vo’s voice is unavailable.{' '}
            {voiceUnavailableReason ?? 'No voice credential is configured.'}{' '}
            Observation is unaffected: windows, notes and surfaced updates are
            all still here.
          </span>
        </div>
      )}

      {surfaced.length > 0 && (
        <>
          <h3>Surfaced</h3>
          <div className="surfaced">
            {surfaced.map((update) => (
              <SurfaceRow key={update.id} update={update} />
            ))}
          </div>
        </>
      )}

      <h3>Window notes</h3>
      {notes.length === 0 ? (
        <p className="none">
          {observing
            ? 'Nothing interpreted yet.'
            : 'Not observing this session yet. Start observation to build window notes and let Vo tell you when something is worth knowing.'}
        </p>
      ) : (
        <div className="notes">
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              onShowTrace={onShowTrace}
              findEvents={(ref) => eventIdsFor(events, ref)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Past tense: by the time this is on screen, the decision has been made. */
const ACTION_LABELS: Record<CommunicationAction, string> = {
  speak_now: 'spoke now',
  queue: 'queued',
  quiet_context: 'kept quiet',
  ignore: 'ignored',
};

function SurfaceRow({ update }: { update: SurfaceUpdate }): ReactElement {
  const action = update.decision?.action;
  const spoken = action === 'speak_now';
  return (
    <div className={`surface${spoken ? ' spoken' : ''}`}>
      <div className="line">
        <span className={`action-chip${spoken ? ' spoken' : ''}`}>
          {action ? ACTION_LABELS[action] : 'pending'}
        </span>
        <span className="message">{update.message}</span>
      </div>
      <span className="why">{update.whyNow}</span>
      {update.decision && (
        <span className="decision">
          {update.decision.reason} · decided by {sourceLabel(update.decision.source)}
          {update.deliveredAt && ` · delivered ${formatClock(update.deliveredAt)}`}
        </span>
      )}
    </div>
  );
}

function sourceLabel(source: string): string {
  if (source === 'llm') return 'the model';
  if (source === 'default') return 'the fallback';
  return source;
}

function NoteRow({
  note,
  onShowTrace,
  findEvents,
}: {
  note: WindowNote;
  onShowTrace: (eventIds: string[]) => void;
  findEvents: (ref: ContextRef) => string[];
}): ReactElement {
  const traceRef = note.refs.find((ref) => ref.kind === 'trace');
  return (
    <>
      <span className="w">w{note.windowIndex}</span>
      <div className="note">
        <span className="summary">
          {note.summary}
          {note.investigated && <span className="chip">investigated</span>}
        </span>
        {note.currentActivity && (
          <span className="aside">Now · {note.currentActivity}</span>
        )}
        {note.notableChange && (
          <span className="aside">Notable · {note.notableChange}</span>
        )}
        {traceRef && (
          // Every note is traceable to the exact L0 range that produced it; this
          // is the button that makes that claim checkable rather than decorative.
          <button
            className="link-btn"
            onClick={() => onShowTrace(findEvents(traceRef))}
          >
            Show the trace this came from
          </button>
        )}
      </div>
    </>
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
