import { useState, type ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';

interface Props {
  sessions: AgentSession[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onLaunched: (session: AgentSession) => void;
}

/**
 * Renders whatever sessions currently exist — zero, one or twenty. Nothing
 * here knows how many there are supposed to be, or what they are called.
 */
export function SessionList({
  sessions,
  selectedId,
  onSelect,
  onLaunched,
}: Props): ReactElement {
  return (
    <aside className="sidebar">
      <header>
        <h1>Active sessions ({sessions.length})</h1>
      </header>
      <div className="session-list">
        {sessions.length === 0 && (
          <p className="empty">Nothing discovered yet.</p>
        )}
        {sessions.map((session) => (
          <button
            key={session.id}
            className={`session-row${session.id === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(session.id)}
          >
            <span className="label">{session.displayLabel}</span>
            <span className="meta">
              <span className={`dot ${session.status}`} />
              <span>{session.status}</span>
              <span>·</span>
              <span>{session.provider}</span>
              {!session.capabilities.sendInstruction && (
                <span className="badge">observe only</span>
              )}
            </span>
            <span className="activity">
              {session.semanticState?.currentActivity ?? 'No interpretation yet.'}
            </span>
          </button>
        ))}
      </div>
      <LaunchForm onLaunched={onLaunched} />
    </aside>
  );
}

function LaunchForm({
  onLaunched,
}: {
  onLaunched: (session: AgentSession) => void;
}): ReactElement {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async () => {
    if (!cwd.trim() || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onLaunched(await window.vowe.launchSession(cwd.trim(), prompt.trim()));
      setPrompt('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="launch">
      <strong style={{ fontSize: 12, color: 'var(--muted)' }}>
        START A SESSION HERE
      </strong>
      <input
        placeholder="/absolute/path/to/repo"
        value={cwd}
        onChange={(event) => setCwd(event.target.value)}
      />
      <textarea
        rows={2}
        placeholder="What should it work on?"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void launch()}>
          {busy ? 'Starting…' : 'Start'}
        </button>
        <span className="hint" style={{ fontSize: 11 }}>
          Sessions started here can also be instructed later.
        </span>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
