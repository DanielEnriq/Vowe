import { useEffect, useState, type KeyboardEvent, type ReactElement } from 'react';

import type { CaptainExchange, FleetStatus } from '@vowe/core';

import { messageOf } from '../components/ui.js';
import { ipcMessage } from '../state/project-fleet.js';
import { statusLook } from '../state/fleet-views.js';

/** The captain's mark. Drawn in the wire colour. */
export function CaptainGlyph({ size = 13 }: { size?: number }): ReactElement {
  return (
    <svg className="fv-captain-glyph" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2.2 13.2 5v4.2L8 13.8 2.8 9.2V5z" />
    </svg>
  );
}

/** A status: always a dot and a word. */
export function StatusMark({ status }: { status: FleetStatus | undefined }): ReactElement {
  const look = statusLook(status);
  return (
    <span className={`fv-status fv-tone-${look.tone}`}>
      <span className="fv-dot" aria-hidden="true" />
      <span className="fv-status-word">{look.word}</span>
    </span>
  );
}

/** Re-render on an interval, for ages and waits. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

interface AnswerBoxProps {
  exchange: CaptainExchange;
  placeholder?: string;
  autoFocus?: boolean;
  /** Smaller, for inside a pane or a card. */
  compact?: boolean;
  onSent?: () => void;
}

/**
 * Your answer to a held question, sent to the agent on the control channel.
 * The amber button is the only act; telling the captain too is a plain box
 * beside it, offered only where a captain was involved.
 */
export function AnswerBox({ exchange, placeholder, autoFocus, compact, onSent }: AnswerBoxProps): ReactElement {
  const [text, setText] = useState('');
  const [alsoTell, setAlsoTell] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasCaptain = exchange.captainSessionId !== null;

  const send = async () => {
    const answer = text.trim();
    if (!answer || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.vowe.answerQuestion(exchange.id, answer, hasCaptain && alsoTell);
      setText('');
      onSent?.();
    } catch (cause) {
      setError(ipcMessage(messageOf(cause)));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div
      className={`fv-answer${compact ? ' compact' : ''}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <textarea
        className="fv-answer-field"
        rows={compact ? 2 : 3}
        value={text}
        placeholder={placeholder ?? 'Your answer'}
        autoFocus={autoFocus}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="fv-answer-row">
        <button className="fv-amber" type="button" disabled={busy || !text.trim()} onClick={() => void send()}>
          Send to the agent
        </button>
        {hasCaptain && (
          <label className="fv-check">
            <input type="checkbox" checked={alsoTell} disabled={busy} onChange={(event) => setAlsoTell(event.target.checked)} />
            Also tell the captain
          </label>
        )}
      </div>
      {error && <p className="fv-error">{error}</p>}
    </div>
  );
}
