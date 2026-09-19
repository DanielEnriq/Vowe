import { useMemo, type ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';
import type { AppStatus } from '../../shared/ipc.js';

import { EyeIcon, PlusIcon, isLive, providerName, statusLabel } from './ui.js';

interface Props {
  sessions: AgentSession[];
  selectedId: string | null;
  status: AppStatus | null;
  onSelect: (sessionId: string) => void;
  onNewSession: () => void;
}

/**
 * Renders whatever sessions currently exist — zero, one or twenty. Nothing
 * here knows how many there are supposed to be, or what they are called.
 */
export function SessionList({
  sessions,
  selectedId,
  status,
  onSelect,
  onNewSession,
}: Props): ReactElement {
  const [live, earlier] = useMemo(() => {
    const byRecent = [...sessions].sort(
      (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
    );
    return [byRecent.filter(isLive), byRecent.filter((s) => !isLive(s))];
  }, [sessions]);

  const watching = status?.providers.map(providerName).join(', ');

  return (
    <aside className="sidebar">
      <div className="sidebar-top titlebar-drag" />
      <div className="sidebar-heading">
        <h1>Sessions</h1>
        <button
          className="icon-btn"
          aria-label="New session"
          title="New session"
          onClick={onNewSession}
        >
          <PlusIcon />
        </button>
      </div>

      <nav className="session-list" aria-label="Sessions">
        {sessions.length === 0 && <p className="sidebar-empty">None yet</p>}
        {live.length > 0 && <div className="group-label">Live</div>}
        {live.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            selected={session.id === selectedId}
            onSelect={onSelect}
          />
        ))}
        {earlier.length > 0 && <div className="group-label">Earlier</div>}
        {earlier.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            selected={session.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </nav>

      <div className="sidebar-footer">
        <span>{watching ? `Watching ${watching}` : 'Starting…'}</span>
        {status && (
          <span className="sub">
            {status.llmConfigured
              ? 'Interpretation by model'
              : 'Interpretation off · no API key'}
          </span>
        )}
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: AgentSession;
  selected: boolean;
  onSelect: (sessionId: string) => void;
}): ReactElement {
  const observeOnly = !session.capabilities.sendInstruction;
  return (
    <button
      className={`session-row${selected ? ' selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(session.id)}
    >
      <span className="line1">
        <span className={`dot ${session.status}`} />
        <span className="label">{session.displayLabel}</span>
        {observeOnly && (
          <span className="observe" title="Observe only">
            <EyeIcon />
          </span>
        )}
      </span>
      <span className="activity">
        {session.semanticState?.currentActivity ?? statusLabel(session.status)}
      </span>
    </button>
  );
}
