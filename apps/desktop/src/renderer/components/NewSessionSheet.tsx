import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';

import { messageOf } from './ui.js';

interface Props {
  onLaunched: (session: AgentSession) => void;
  onClose: () => void;
}

/** Starts a managed session — the kind Vowe can also instruct later. */
export function NewSessionSheet({ onLaunched, onClose }: Props): ReactElement {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    folderInput.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = async () => {
    const folder = await window.vowe.chooseFolder().catch(() => null);
    if (folder) setCwd(folder);
  };

  const launch = async () => {
    if (!cwd.trim() || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onLaunched(await window.vowe.launchSession(cwd.trim(), prompt.trim()));
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onSubmit={(event) => {
          event.preventDefault();
          void launch();
        }}
      >
        <div>
          <h2 id="new-session-title">New Claude Code session</h2>
          <p className="intro">
            Vowe starts it and keeps a live connection, so you can instruct it
            later.
          </p>
        </div>

        <div className="field">
          <label htmlFor="ns-folder">Project folder</label>
          <div className="row">
            <input
              id="ns-folder"
              ref={folderInput}
              placeholder="/absolute/path/to/repo"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            />
            <button type="button" className="btn" onClick={() => void choose()}>
              Choose…
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="ns-prompt">What should it work on?</label>
          <textarea
            id="ns-prompt"
            rows={4}
            placeholder="Describe the task the way you would in the terminal."
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void launch();
              }
            }}
          />
        </div>

        {error && <div className="error">{error}</div>}

        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || !cwd.trim() || !prompt.trim()}
          >
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </div>
      </form>
    </div>
  );
}
