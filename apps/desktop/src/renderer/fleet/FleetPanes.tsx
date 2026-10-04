import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { AttemptSummary, CaptainExchange, FleetStatus, NormalizedEvent, Project } from '@vowe/core';

import { useAttemptSummaries, useCaptainExchanges } from '../hooks/useVoweData.js';
import { isWired } from '../state/fleet-compare.js';
import {
  PANE_LAYOUTS,
  captainTally,
  mergeEvents,
  paneLines,
  paneMembers,
  waitingExchange,
  type PaneLayout,
} from '../state/fleet-panes.js';
import { fleetMembers, formatElapsed, formatSpan, labelsBySession, spanBetween, statusLook, type FleetMember } from '../state/fleet-views.js';
import type { FleetViewProps } from './types.js';
import { AnswerBox, CaptainGlyph, StatusMark, useNow } from './view-parts.js';

const SEED_EVENTS = 60;

/**
 * Every agent's live output at once, captains first. Clicking a pane takes
 * it over — opens that session's room.
 */
export function FleetPanes({ project, sessions, layout, statuses, onOpenSession }: FleetViewProps): ReactElement {
  const [grid, setGrid] = useState<PaneLayout>('3x2');
  const [follow, setFollow] = useState(false);
  const [focused, setFocused] = useState(0);
  const members = useMemo(() => fleetMembers(layout, sessions), [layout, sessions]);
  const panes = useMemo(() => paneMembers(members, grid, follow), [members, grid, follow]);
  const labels = useMemo(() => labelsBySession(members), [members]);
  const { exchanges } = useCaptainExchanges(project.id);
  const sessionIds = useMemo(() => panes.map((pane) => pane.sessionId!), [panes]);
  const summaries = useAttemptSummaries(sessionIds);
  const summaryOf = useMemo(() => new Map(summaries.map((summary) => [summary.sessionId, summary])), [summaries]);
  const paneRefs = useRef<(HTMLElement | null)[]>([]);
  const now = useNow(1000);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit) {
        const index = Number(digit) - 1;
        if (index >= panes.length) return;
        event.preventDefault();
        setFocused(index);
        paneRefs.current[index]?.focus();
      } else if (event.key === 'Enter') {
        const pane = panes[focused];
        if (!pane?.sessionId) return;
        event.preventDefault();
        onOpenSession(pane.sessionId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panes, focused, onOpenSession]);

  return (
    <div className="fv-view">
      <div className="fv-toolbar">
        <div className="fv-segmented" role="radiogroup" aria-label="Layout">
          {PANE_LAYOUTS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={grid === option.value}
              className={grid === option.value ? 'on' : undefined}
              onClick={() => setGrid(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`fv-toggle${follow ? ' on' : ''}`}
          aria-pressed={follow}
          onClick={() => setFollow((value) => !value)}
        >
          Follow the newest
        </button>
      </div>

      {panes.length === 0 ? (
        <div className="fv-empty">No agents yet.</div>
      ) : (
        <div className={`fv-panes grid-${grid}`}>
          {panes.map((member, index) => (
            <Pane
              key={member.sessionId}
              paneRef={(element) => {
                paneRefs.current[index] = element;
              }}
              member={member}
              ordinal={index + 1}
              focused={index === focused}
              status={statuses[member.sessionId!]}
              summary={summaryOf.get(member.sessionId!) ?? null}
              exchanges={exchanges}
              labels={labels}
              project={project}
              wired={member.role === 'agent' && isWired(layout, member)}
              wiredCount={member.nodeId ? layout.wires.filter((wire) => wire.captainId === member.nodeId).length : 0}
              now={now}
              onFocus={() => setFocused(index)}
              onOpen={() => onOpenSession(member.sessionId!)}
            />
          ))}
        </div>
      )}

      <div className="fv-foot">
        <span className="fv-mono">⌃1…6 focus a pane · ⌃⏎ take over</span>
      </div>
    </div>
  );
}

interface PaneProps {
  paneRef: (element: HTMLElement | null) => void;
  member: FleetMember;
  ordinal: number;
  focused: boolean;
  status: FleetStatus | undefined;
  summary: AttemptSummary | null;
  exchanges: CaptainExchange[];
  labels: ReadonlyMap<string, string>;
  project: Project;
  wired: boolean;
  wiredCount: number;
  now: number;
  onFocus: () => void;
  onOpen: () => void;
}

function Pane({
  paneRef,
  member,
  ordinal,
  focused,
  status,
  summary,
  exchanges,
  labels,
  project,
  wired,
  wiredCount,
  now,
  onFocus,
  onOpen,
}: PaneProps): ReactElement {
  const sessionId = member.sessionId!;
  const events = usePaneEvents(sessionId);
  const [answering, setAnswering] = useState(false);
  const captain = member.role === 'captain';
  const lines = useMemo(
    () => paneLines({ sessionId, role: member.role, events, exchanges, project, labels }),
    [sessionId, member.role, events, exchanges, project, labels],
  );
  const waiting = captain ? null : waitingExchange(sessionId, exchanges);
  const tone = captain ? 'ask' : statusLook(status).tone;
  const lastProse = lines.length - 1;

  return (
    <article
      ref={paneRef}
      className={`fv-pane fv-tone-${tone}${focused ? ' focused' : ''}`}
      tabIndex={0}
      aria-label={`${member.label}, pane ${ordinal}`}
      onFocus={onFocus}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) onOpen();
      }}
    >
      <header className="fv-pane-head">
        {captain && <CaptainGlyph />}
        <span className="fv-pane-label">{member.label}</span>
        {wired && <CaptainGlyph size={11} />}
        <StatusMark status={status} />
        <span className="fv-mono fv-ordinal">{ordinal}</span>
      </header>

      <div className="fv-pane-log">
        {lines.map((line, index) => (
          <div
            key={line.key}
            className={`fv-line fv-tone-${line.tone}${index < lines.length - 4 ? ' old' : ''}`}
          >
            {line.text}
            {index === lastProse && line.tone === 'prose' && status === 'running' && <span className="fv-cursor">▌</span>}
          </div>
        ))}
        {waiting && <div className="fv-pane-question">{waiting.question}</div>}
        {waiting && answering && (
          <AnswerBox exchange={waiting} compact autoFocus onSent={() => setAnswering(false)} />
        )}
      </div>

      <footer className="fv-pane-foot">
        {captain ? (
          <span className="fv-mono fv-grow">{captainTally(sessionId, exchanges, wiredCount)}</span>
        ) : waiting ? (
          <>
            {!answering && (
              <button
                type="button"
                className="fv-amber small"
                onClick={(event) => {
                  event.stopPropagation();
                  setAnswering(true);
                }}
              >
                Answer
              </button>
            )}
            <span className="fv-grow" />
            <span className="fv-mono fv-tone-attention">{formatSpan(spanBetween(waiting.askedAt, now) ?? 0)}</span>
          </>
        ) : (
          <>
            <span className="fv-mono fv-grow">
              {summary ? `turn ${summary.turns} · ${formatElapsed(summary.elapsedMs)}` : ''}
            </span>
            <DiffTally summary={summary} />
          </>
        )}
      </footer>
    </article>
  );
}

function DiffTally({ summary }: { summary: AttemptSummary | null }): ReactElement | null {
  if (!summary) return null;
  if (summary.diffAttribution === 'shared-folder') {
    const n = summary.touchedFiles.length;
    return <span className="fv-mono fv-quiet">shared folder · {n} file{n === 1 ? '' : 's'}</span>;
  }
  if (!summary.diff) return null;
  return (
    <>
      {summary.diff.added > 0 && <span className="fv-mono fv-tone-good">+{summary.diff.added}</span>}
      {summary.diff.removed > 0 && <span className="fv-mono fv-tone-bad">−{summary.diff.removed}</span>}
    </>
  );
}

/** The session's recent events: seeded from the store, then live. */
function usePaneEvents(sessionId: string): NormalizedEvent[] {
  const [events, setEvents] = useState<NormalizedEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    let live = true;
    void window.vowe.getEvents(sessionId, SEED_EVENTS)
      .then((seed) => { if (live) setEvents((current) => mergeEvents(current, seed)); })
      .catch(() => undefined);
    const off = window.vowe.onSessionEvent((event) => {
      if (event.sessionId === sessionId) setEvents((current) => mergeEvents(current, [event]));
    });
    return () => { live = false; off(); };
  }, [sessionId]);
  return events;
}
