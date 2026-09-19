import type { ReactElement } from 'react';
import type { AgentSession } from '@vowe/core';

import { CheckIcon, formatAgo } from './ui.js';

interface Props {
  session: AgentSession;
  llmConfigured: boolean;
  refreshing: boolean;
  onShowEvidence: () => void;
  onRefresh: () => void;
}

/**
 * What Vowe currently believes the session is doing — always with a way back
 * to the evidence that produced it.
 */
export function SemanticPanel({
  session,
  llmConfigured,
  refreshing,
  onShowEvidence,
  onRefresh,
}: Props): ReactElement {
  const state = session.semanticState;

  if (!state) {
    return (
      <section className="now" aria-label="Interpreted state">
        <p className="empty-state">
          Nothing interpreted yet. A summary appears once events have been
          observed.
        </p>
        <div>
          <button className="btn" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? 'Interpreting…' : 'Interpret now'}
          </button>
        </div>
      </section>
    );
  }

  const cited = state.provenance.eventIds.length;

  return (
    <section className="now" aria-label="Interpreted state">
      <div className="meta">
        <span className="phase-chip">{state.phase}</span>
        <span>Updated {formatAgo(state.updatedAt)}</span>
      </div>

      <p className="headline">{state.currentActivity}</p>

      <p className="task">
        <span className="k">Task</span>
        {state.task ?? session.task ?? 'Not yet known'}
      </p>

      {state.recentProgress.length > 0 && (
        <ul className="progress">
          {state.recentProgress.map((item, index) => (
            <li key={index}>
              <CheckIcon />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="latest">
        <span className="k">Last meaningful update</span>
        {state.lastMeaningfulUpdate}
      </p>

      <div className="provenance">
        <span>
          {state.source === 'llm'
            ? 'Summarised by the model from'
            : llmConfigured
              ? 'Vowe’s deterministic reading of'
              : 'No model configured · Vowe’s deterministic reading of'}
        </span>
        <button
          className="link-btn"
          disabled={cited === 0}
          onClick={onShowEvidence}
        >
          {cited} observed {cited === 1 ? 'event' : 'events'}
        </button>
      </div>
    </section>
  );
}
