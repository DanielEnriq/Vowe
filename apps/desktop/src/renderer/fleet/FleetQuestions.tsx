import { useMemo, type ReactElement } from 'react';

import type { CaptainExchange, FleetStatus } from '@vowe/core';

import { useCaptainExchanges } from '../hooks/useVoweData.js';
import { fleetMembers, labelsBySession } from '../state/fleet-views.js';
import {
  answeredByCaptain,
  answeredHeader,
  answeredLine,
  askRoster,
  captainSaid,
  passedToYou,
  waitingFor,
} from '../state/fleet-questions.js';
import type { FleetViewProps } from './types.js';
import { AnswerBox, CaptainGlyph, StatusMark, useNow } from './view-parts.js';

/**
 * What the fleet's workers asked: the questions passed to you, to answer
 * here, and the ones a captain answered. Blue is the captain talking; amber
 * is your answer going to the agent.
 */
export function FleetQuestions({ project, sessions, layout, statuses, onOpenSession }: FleetViewProps): ReactElement {
  const { exchanges } = useCaptainExchanges(project.id);
  const members = useMemo(() => fleetMembers(layout, sessions), [layout, sessions]);
  const labels = useMemo(() => labelsBySession(members), [members]);
  const roster = useMemo(() => askRoster(layout, members), [layout, members]);
  const toYou = useMemo(() => passedToYou(exchanges), [exchanges]);
  const answered = useMemo(() => answeredByCaptain(exchanges), [exchanges]);
  const now = useNow();
  const nameOf = (sessionId: string) => labels.get(sessionId) ?? 'Agent';

  return (
    <div className="fv-questions">
      <aside className="fv-questions-side">
        <div className="fv-count fv-tone-attention">
          <span className="fv-count-n">{toYou.length}</span>
          <span>to you</span>
        </div>
        <div className="fv-count fv-tone-ask">
          <span className="fv-count-n">{answered.length}</span>
          <span>captain answered</span>
        </div>
        <div className="fv-rule" />
        <div className="caps fv-side-head">Who may ask the captain</div>
        {roster.length === 0 && <div className="fv-quiet fv-side-empty">No agents on the canvas.</div>}
        <ul className="fv-roster">
          {roster.map((row) => (
            <li key={row.nodeId} className="fv-roster-row">
              <span className="fv-roster-name">{row.label}</span>
              <span
                className={`fv-switch${row.wired ? ' on' : ''}`}
                role="img"
                aria-label={row.wired ? 'wired' : 'not wired'}
                title="Wire on the canvas"
              >
                <span />
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <div className="fv-questions-main scroll">
        <div className="fv-questions-head">
          <span className="fv-grow" />
          <span className="fv-mono fv-quiet">⌥⏎ answer</span>
        </div>

        {toYou.map((exchange) => (
          <PassedCard
            key={exchange.id}
            exchange={exchange}
            name={nameOf(exchange.askerSessionId)}
            status={statuses[exchange.askerSessionId]}
            now={now}
            onOpen={() => onOpenSession(exchange.askerSessionId)}
          />
        ))}

        <section className="fv-answered">
          <header className="fv-answered-head">
            <CaptainGlyph size={14} />
            <span className="caps fv-grow">Answered by the captain</span>
            <span className="fv-mono fv-quiet">{answeredHeader(answered, now)}</span>
          </header>
          {answered.length === 0 && <div className="fv-empty">Nothing yet.</div>}
          {answered.map((exchange) => (
            <div key={exchange.id} className="fv-answered-row">
              <div className="fv-answered-who">
                <StatusMark status={statuses[exchange.askerSessionId]} />
                <span className="fv-answered-name">{nameOf(exchange.askerSessionId)}</span>
                <span className="fv-mono fv-quiet">{answeredLine(exchange, now)}</span>
              </div>
              <div className="fv-answered-text">
                <div className="fv-asked">{exchange.question}</div>
                <div className="fv-reply">{exchange.captainAnswer}</div>
              </div>
              <button type="button" className="fv-link" onClick={() => onOpenSession(exchange.askerSessionId)}>
                Open
              </button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

interface PassedCardProps {
  exchange: CaptainExchange;
  name: string;
  status: FleetStatus | undefined;
  now: number;
  onOpen: () => void;
}

function PassedCard({ exchange, name, status, now, onOpen }: PassedCardProps): ReactElement {
  const said = captainSaid(exchange);
  return (
    <section className="fv-passed">
      <header className="fv-passed-head">
        <StatusMark status={status} />
        <span className="fv-passed-name">{name}</span>
        <span className="fv-badge fv-tone-attention">Passed to you</span>
        <span className="fv-mono fv-tone-attention">{waitingFor(exchange, now)}</span>
        <span className="fv-grow" />
        <button type="button" className="fv-link" onClick={onOpen}>
          Open the agent
        </button>
      </header>
      <div className="fv-passed-body">
        <div className="fv-passed-ask">
          <p className="fv-passed-question">{exchange.question}</p>
          {exchange.options && exchange.options.length > 0 && (
            <ul className="fv-options">
              {exchange.options.map((option) => (
                <li key={option}>{option}</li>
              ))}
            </ul>
          )}
          {said && (
            <div className="fv-said">
              <CaptainGlyph size={15} />
              <div>
                <div className="caps fv-tone-ask">The captain said</div>
                <div className="fv-said-text">{said}</div>
              </div>
            </div>
          )}
        </div>
        <div className="fv-passed-answer">
          <div className="caps fv-tone-attention">Your answer</div>
          <AnswerBox exchange={exchange} />
        </div>
      </div>
    </section>
  );
}
