import { useState, type ReactElement } from 'react';

import { useProjectThread } from '../hooks/useVoweData.js';
import { SendIcon } from '../shell/icons.js';
import { Receipt } from '../session/Receipt.js';

/**
 * Asking about the repository rather than about one run.
 *
 * The same investigator answers this as answers a session question — it simply
 * sees the repository, what Vowe has learned about it and what Vowe understood
 * across its sessions, rather than one session's trace. Answers land in the
 * project's own durable thread, which is why they survive being closed.
 */
export function ProjectAsk({ projectId }: { projectId: string }): ReactElement {
  const { entries } = useProjectThread(projectId);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const question = draft.trim();
    if (!question || asking) return;
    setDraft('');
    setAsking(true);
    setError(null);
    try {
      await window.vowe.askProject(projectId, question);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 680, marginTop: 4 }}>
      {entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {entries.map((entry) => (
            <div key={entry.id} className={`turn${entry.role === 'user_question' ? ' user' : ''}`}>
              <span className="speaker">{entry.role === 'user_question' ? 'You' : 'Vowe'}</span>
              {entry.investigation && entry.investigation.checks.length > 0 && (
                <Receipt receipt={entry.investigation} />
              )}
              <p>{entry.text}</p>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
          padding: '10px 10px 10px 14px',
          border: '1px solid var(--border-2)',
          borderRadius: 12,
          background: 'var(--field)',
        }}
      >
        <textarea
          rows={2}
          value={draft}
          placeholder="Ask about this repository…"
          aria-label="Ask about this repository"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            border: 0,
            outline: 'none',
            resize: 'none',
            background: 'transparent',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--ink)',
            padding: '2px 0',
          }}
        />
        <button
          className="send"
          type="button"
          aria-label="Ask"
          title="Ask"
          disabled={!draft.trim() || asking}
          onClick={() => void send()}
        >
          <SendIcon />
        </button>
      </div>

      {asking && <span className="fine">Looking into it…</span>}
      {error && <span className="fine">{error}</span>}
    </div>
  );
}
