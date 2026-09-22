import { useState, type ReactElement } from 'react';

import type { PresenceProfile } from '@vowe/core';

import { useProjectInvestigation, useProjectThread } from '../hooks/useVoweData.js';
import { useActivityImpulse } from '../presence/index.js';
import { composerKeyAction } from '../state/composer.js';
import { SendIcon } from '../shell/icons.js';
import { LiveInvestigation } from '../session/LiveInvestigation.js';
import { MessageBody } from '../session/MessageBody.js';
import { SettledInvestigation } from '../session/SettledInvestigation.js';
import { VoweMark } from '../session/VoweMark.js';

/**
 * Asking about the repository rather than about one run.
 *
 * The same investigator answers this as answers a session question — it simply
 * sees the repository, what Vowe has learned about it and what Vowe understood
 * across its sessions, rather than one session's trace. Answers land in the
 * project's own durable thread, which is why they survive being closed.
 *
 * A real input rather than a link that reveals one. The capability is live, and
 * a line of text reading "Ask about this repository" made the most useful thing
 * in an idle room look like a caption — one click away from the thing it was
 * describing, for no reason other than that it had been built later.
 */
export function ProjectAsk({
  projectId,
  presence,
}: {
  projectId: string;
  presence: PresenceProfile;
}): ReactElement {
  const { entries } = useProjectThread(projectId);
  const entryIds = entries.map((entry) => entry.id);
  const investigation = useProjectInvestigation(projectId, entryIds);
  const activity = useActivityImpulse(investigation.beat, investigation.active);
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
    <div className="project-ask">
      {entries.length > 0 && (
        <div className="project-thread">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`turn${entry.role === 'user_question' ? ' user' : ''}`}
            >
              {entry.role === 'user_question' ? (
                <span className="speaker">You</span>
              ) : (
                <div className="signature-line">
                  <VoweMark profile={presence} />
                  <span className="speaker">Vowe</span>
                </div>
              )}
              {entry.role !== 'user_question' && entry.investigation && (
                <SettledInvestigation entryId={entry.id} receipt={entry.investigation} />
              )}
              <MessageBody text={entry.text} />
            </div>
          ))}
        </div>
      )}

      {(asking || investigation.active || investigation.answer.length > 0) && (
        <LiveInvestigation live={investigation} presence={presence} activity={activity} />
      )}

      <div className="ask-field">
        <textarea
          rows={1}
          value={draft}
          placeholder="Ask Vowe about this project…"
          aria-label="Ask Vowe about this project"
          onChange={(event) => {
            setDraft(event.target.value);
            const element = event.target;
            element.style.height = 'auto';
            element.style.height = `${Math.min(120, element.scrollHeight)}px`;
          }}
          onKeyDown={(event) => {
            if (composerKeyAction(event) !== 'send') return;
            event.preventDefault();
            void send();
          }}
        />
        <button
          className="send"
          type="button"
          aria-label="Ask Vowe"
          title="Ask Vowe"
          disabled={!draft.trim() || asking}
          onClick={() => void send()}
        >
          <SendIcon />
        </button>
      </div>

      {error && <span className="fine">{error}</span>}
    </div>
  );
}
