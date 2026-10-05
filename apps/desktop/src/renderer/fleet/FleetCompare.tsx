import { useMemo, useState, type CSSProperties, type ReactElement } from 'react';

import type { AttemptSummary, CaptainExchange, FleetLayout, FleetStatus } from '@vowe/core';

import { useAttemptSummaries, useCaptainExchanges } from '../hooks/useVoweData.js';
import {
  attemptColumn,
  attemptPitch,
  chooseAttempt,
  compareGroups,
  isWired,
  separateLine,
  type AttemptChoice,
  type AttemptGroup,
  type Cell,
} from '../state/fleet-compare.js';
import { waitingExchange } from '../state/fleet-panes.js';
import { fleetMembers, statusLook, type FleetMember } from '../state/fleet-views.js';
import type { FleetViewProps } from './types.js';
import { AnswerBox, CaptainGlyph, StatusMark } from './view-parts.js';

/**
 * Parallel attempts at one brief, side by side under a bracket; everything
 * else below, unbracketed, with nothing to compare it to.
 *
 * Keep and Discard are recorded in this view only. Nothing is merged,
 * checked out or deleted.
 */
export function FleetCompare({ project, sessions, layout, statuses, onOpenSession }: FleetViewProps): ReactElement {
  const members = useMemo(() => fleetMembers(layout, sessions), [layout, sessions]);
  const groups = useMemo(() => compareGroups(layout, members, statuses), [layout, members, statuses]);
  const [choices, setChoices] = useState<Record<string, AttemptChoice>>({});
  const { exchanges } = useCaptainExchanges(project.id);
  const separateIds = useMemo(
    () => groups.separate.map((member) => member.sessionId).filter((id): id is string => id !== null),
    [groups.separate],
  );
  const separateSummaries = useAttemptSummaries(separateIds);
  const summaryOf = useMemo(
    () => new Map(separateSummaries.map((summary) => [summary.sessionId, summary])),
    [separateSummaries],
  );

  return (
    <div className="fv-view scroll">
      <div className="fv-compare">
        {groups.parallel.length === 0 && <div className="fv-empty">No parallel attempts.</div>}
        {groups.parallel.map((group) => (
          <AttemptBracket
            key={group.clusterId}
            group={group}
            layout={layout}
            statuses={statuses}
            choices={choices}
            onChoose={(sessionId, choice) =>
              setChoices((current) =>
                chooseAttempt(
                  current,
                  group.members.map((member) => member.sessionId).filter((id): id is string => id !== null),
                  sessionId,
                  choice,
                ),
              )
            }
            onOpenSession={onOpenSession}
          />
        ))}

        {groups.separate.length > 0 && (
          <section className="fv-separate">
            <div className="fv-section-head">
              <span className="caps">Separate tasks</span>
              <span className="fv-quiet">nothing to compare</span>
            </div>
            <div className="fv-separate-grid">
              {groups.separate.map((member) => (
                <SeparateCard
                  key={member.sessionId ?? member.nodeId}
                  member={member}
                  status={member.sessionId ? statuses[member.sessionId] : undefined}
                  summary={member.sessionId ? (summaryOf.get(member.sessionId) ?? null) : null}
                  exchanges={exchanges}
                  onOpenSession={onOpenSession}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

interface BracketProps {
  group: AttemptGroup;
  layout: FleetLayout;
  statuses: Record<string, FleetStatus>;
  choices: Record<string, AttemptChoice>;
  onChoose: (sessionId: string, choice: AttemptChoice) => void;
  onOpenSession: (sessionId: string) => void;
}

function AttemptBracket({ group, layout, statuses, choices, onChoose, onOpenSession }: BracketProps): ReactElement {
  const ids = useMemo(
    () => group.members.map((member) => member.sessionId).filter((id): id is string => id !== null),
    [group.members],
  );
  const summaries = useAttemptSummaries(ids);
  const summaryOf = new Map(summaries.map((summary) => [summary.sessionId, summary]));
  const columns = { '--fv-cols': Math.max(group.members.length, 1) } as CSSProperties;

  return (
    <section className="fv-bracket">
      <header className="fv-bracket-head">
        <span className="fv-chip">Parallel · {group.members.length}</span>
        <span className="fv-brief">{group.brief || group.label}</span>
      </header>
      <div className="fv-bracket-rule" style={columns} aria-hidden="true">
        {group.members.map((member) => (
          <span key={member.nodeId} />
        ))}
      </div>
      <div className="fv-attempts" style={columns}>
        {group.members.map((member) => (
          <AttemptCard
            key={member.nodeId}
            member={member}
            status={member.sessionId ? statuses[member.sessionId] : undefined}
            summary={member.sessionId ? (summaryOf.get(member.sessionId) ?? null) : null}
            wired={isWired(layout, member)}
            choice={member.sessionId ? choices[member.sessionId] : undefined}
            onChoose={onChoose}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
    </section>
  );
}

interface AttemptCardProps {
  member: FleetMember;
  status: FleetStatus | undefined;
  summary: AttemptSummary | null;
  wired: boolean;
  choice: AttemptChoice | undefined;
  onChoose: (sessionId: string, choice: AttemptChoice) => void;
  onOpenSession: (sessionId: string) => void;
}

function AttemptCard({ member, status, summary, wired, choice, onChoose, onOpenSession }: AttemptCardProps): ReactElement {
  const column = attemptColumn(summary, wired);
  const pitch = attemptPitch(member.session);
  const sessionId = member.sessionId;
  const cls = `fv-attempt${choice ? ` ${choice}` : ''}`;

  if (!sessionId) {
    return (
      <div className={cls}>
        <div className="fv-attempt-head">
          <div className="fv-attempt-title">
            <span className="fv-attempt-name">{member.label}</span>
            <StatusMark status={undefined} />
          </div>
          <span className="fv-quiet">not started</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cls}>
      <div className="fv-attempt-head">
        <div className="fv-attempt-title">
          <span className="fv-attempt-name">{member.label}</span>
          {wired && <CaptainGlyph />}
          <StatusMark status={status} />
          {column.badge && <span className={`fv-badge fv-tone-${column.badge.tone}`}>{column.badge.text}</span>}
        </div>
        <div className="fv-attempt-files fv-mono">
          <span className="fv-grow">{column.files}</span>
          {column.shared ? (
            <span className="fv-marker">shared folder</span>
          ) : (
            <>
              {column.added !== null && <span className="fv-tone-good">+{column.added}</span>}
              {column.removed !== null && <span className="fv-tone-bad">−{column.removed}</span>}
            </>
          )}
        </div>
      </div>

      <div className="fv-attempt-body">
        {pitch && <p className="fv-pitch">{pitch}</p>}
        {column.shared && column.touchedFiles.length > 0 && (
          <ul className="fv-touched fv-mono">
            {column.touchedFiles.slice(0, 6).map((path) => (
              <li key={path}>{path.slice(path.lastIndexOf('/') + 1)}</li>
            ))}
            {column.touchedFiles.length > 6 && <li className="fv-quiet">+{column.touchedFiles.length - 6} more</li>}
          </ul>
        )}
        <dl className="fv-facts">
          <Fact name="Tests" cell={column.tests} />
          <Fact name="Typecheck" cell={column.typecheck} />
          <Fact name="Public API" cell={column.publicApi} />
          <Fact name="Turns · time" cell={column.turns} />
          <Fact name="Asked the captain" cell={column.asked} />
        </dl>
      </div>

      <div className="fv-attempt-actions">
        <button
          type="button"
          className={`fv-button grow${choice === 'kept' ? ' solid' : ''}`}
          aria-pressed={choice === 'kept'}
          title="Recorded here only. Nothing is merged."
          onClick={() => onChoose(sessionId, 'kept')}
        >
          {choice === 'kept' ? 'Kept · not merged' : 'Keep this one'}
        </button>
        <button
          type="button"
          className="fv-button ghost"
          aria-pressed={choice === 'discarded'}
          title="Recorded here only. Nothing is deleted."
          onClick={() => onChoose(sessionId, 'discarded')}
        >
          {choice === 'discarded' ? 'Discarded · not deleted' : 'Discard'}
        </button>
        <button type="button" className="fv-button ghost" onClick={() => onOpenSession(sessionId)}>
          Open
        </button>
      </div>
    </div>
  );
}

function Fact({ name, cell }: { name: string; cell: Cell }): ReactElement {
  return (
    <div className="fv-fact">
      <dt>{name}</dt>
      <dd className={`fv-mono fv-tone-${cell.tone}`}>{cell.text}</dd>
    </div>
  );
}

interface SeparateCardProps {
  member: FleetMember;
  status: FleetStatus | undefined;
  summary: AttemptSummary | null;
  exchanges: CaptainExchange[];
  onOpenSession: (sessionId: string) => void;
}

function SeparateCard({ member, status, summary, exchanges, onOpenSession }: SeparateCardProps): ReactElement {
  const [answering, setAnswering] = useState(false);
  const sessionId = member.sessionId;
  const waiting = sessionId ? waitingExchange(sessionId, exchanges) : null;
  const tone = sessionId ? statusLook(status).tone : 'idle';
  const line = separateLine(member, status, summary);

  return (
    <div className={`fv-task fv-tone-${tone}`}>
      <div className="fv-task-row">
        <StatusMark status={sessionId ? status : undefined} />
        <div className="fv-task-text">
          <div className="fv-task-name">{member.label}</div>
          {line && <div className="fv-task-line">{line}</div>}
        </div>
        {waiting && !answering && (
          <button type="button" className="fv-amber-text" onClick={() => setAnswering(true)}>
            Answer
          </button>
        )}
        {sessionId && !waiting && (
          <button type="button" className="fv-button small" onClick={() => onOpenSession(sessionId)}>
            Open
          </button>
        )}
      </div>
      {waiting && answering && (
        <>
          <div className="fv-task-question">{waiting.question}</div>
          <AnswerBox exchange={waiting} compact autoFocus onSent={() => setAnswering(false)} />
        </>
      )}
    </div>
  );
}
