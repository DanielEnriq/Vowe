import type { ReactElement } from 'react';
import type { AgentSession } from '@vowe/core';

interface Props {
  session: AgentSession;
  llmConfigured: boolean;
  onShowEvidence: (eventIds: string[]) => void;
  onRefresh: () => void;
}

/**
 * What Vowe currently believes the session is doing — always with a way back
 * to the evidence that produced it.
 */
export function SemanticPanel({
  session,
  llmConfigured,
  onShowEvidence,
  onRefresh,
}: Props): ReactElement {
  const state = session.semanticState;

  return (
    <div className="card">
      <h2>
        Interpreted state{' '}
        {state ? (
          <span className={`badge ${state.source === 'llm' ? 'llm' : ''}`}>
            {state.source}
          </span>
        ) : null}
        {!llmConfigured && (
          <span className="badge warn" style={{ marginLeft: 6 }}>
            no LLM configured
          </span>
        )}
      </h2>

      {!state && (
        <p style={{ color: 'var(--muted)' }}>
          Nothing interpreted yet. It will appear once events have been
          observed.
        </p>
      )}

      {state && (
        <>
          <dl className="kv">
            <dt>Task</dt>
            <dd>{state.task ?? session.task ?? 'not yet known'}</dd>
            <dt>Phase</dt>
            <dd>{state.phase}</dd>
            <dt>Current activity</dt>
            <dd>{state.currentActivity}</dd>
            <dt>Recent progress</dt>
            <dd>
              {state.recentProgress.length === 0 ? (
                'nothing notable yet'
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {state.recentProgress.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              )}
            </dd>
            <dt>Last meaningful update</dt>
            <dd>{state.lastMeaningfulUpdate}</dd>
          </dl>

          <div className="row" style={{ marginTop: 12 }}>
            <button
              onClick={() => onShowEvidence(state.provenance.eventIds)}
              disabled={state.provenance.eventIds.length === 0}
            >
              Show the {state.provenance.eventIds.length} events behind this
            </button>
            <button onClick={onRefresh}>Re-interpret now</button>
          </div>
        </>
      )}

      {!state && (
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={onRefresh}>Interpret now</button>
        </div>
      )}
    </div>
  );
}
