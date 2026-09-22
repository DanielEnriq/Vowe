import { useState, type ReactElement } from 'react';

import type {
  PresenceProfile,
  PresenceState,
  Project,
  ProjectBrief,
  ProjectMemoryRecord,
  ProjectSessionSummary,
} from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { VowePresence } from '../presence/index.js';
import { CheckIcon } from '../shell/icons.js';
import { formatAgo, tildePath } from '../components/ui.js';
import { useProjectMemories } from '../hooks/useVoweData.js';
import { ProjectAsk } from './ProjectAsk.js';

interface Props {
  project: Project;
  brief: ProjectBrief | null;
  presence: PresenceProfile;
  presenceState: PresenceState;
  sidebarOpen: boolean;
  onOpenSession: (sessionId: string) => void;
}

/**
 * What is happening in one repository.
 *
 * Everything on this screen is either a field of `ProjectBrief`, a record
 * Vowe already wrote, or a deterministic rendering of one. There is no project
 * agent, no model call and no cross-session reasoning here — the room reads
 * state that was already reconciled, so its headline cannot contradict the
 * work beneath it.
 *
 * The room has two weightings rather than one layout, because a quiet
 * repository and a busy one are being asked different questions. Busy: what is
 * moving, what needs me, what has Vowe said — history last and short. Quiet:
 * what just happened, what has Vowe learned, what can I do now — which is what
 * the space an idle room has is actually for. Neither fills space for its own
 * sake: every section here disappears when it has nothing true to say.
 */
export function ProjectRoom({
  project,
  brief,
  presence,
  presenceState,
  sidebarOpen,
  onOpenSession,
}: Props): ReactElement {
  const memories = useProjectMemories(project.id);
  const busy = (brief?.active.length ?? 0) > 0;

  return (
    <main className="pane">
      <header className={`pane-header${sidebarOpen ? '' : ' clear-titlebar'}`}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Fading as="h1">{project.name}</Fading>
          {/*
            The whole line fades, not the path inside it. Fading one inline
            run of a sentence would dissolve a word in the middle of it; the
            line is what runs out of room, so the line is what dissolves.
          */}
          <Fading className="meta" title={tildePath(project.repoRoot)}>
            {brief ? describeCounts(brief) : 'Reading the project…'}
            {' · '}
            <span className="path">{tildePath(project.repoRoot)}</span>
          </Fading>
        </div>
      </header>

      <div className="scroll room">
        <div className="room-inner">
          <section className="synthesis">
            <VowePresence
              state={presenceState}
              profile={presence}
              size="project"
              className="hoverable"
            />
            <div className="reading">
              <p className="headline">{brief?.headline ?? 'Reading the project…'}</p>

              {brief && brief.detailLines.length > 0 && (
                <div className="detail-lines">
                  {brief.detailLines.map((line) => (
                    <Fading axis="y" key={line}>
                      {line}
                    </Fading>
                  ))}
                </div>
              )}

              {brief && <QuietOrientation brief={brief} onOpenSession={onOpenSession} />}

              {brief && <KnowledgeChip status={brief.knowledge.status} at={brief.knowledge.updatedAt} />}

              {/*
                The one thing to *do* in this room, as the thing itself.
                Answers land in the project's durable thread, so what was asked
                here last week is still here.
              */}
              <ProjectAsk projectId={project.id} presence={presence} />
            </div>
          </section>

          <div className="rule" />

          <NeedsYou brief={brief} onOpenSession={onOpenSession} />

          {brief && brief.active.length > 0 && (
            <section className="section">
              <h2>Current work</h2>
              {brief.active.map((session) => (
                <WorkRow key={session.sessionId} session={session} onOpen={onOpenSession} />
              ))}
            </section>
          )}

          {brief?.latestSignal && (
            <section className="section">
              <h2>Latest from Vowe</h2>
              <p className="signal">{brief.latestSignal.text}</p>
            </section>
          )}

          <div className="rule" style={{ marginTop: 18 }} />

          {/*
            History, weighted for the room it is in.

            Busy, it is a short tail under the work that is moving. Quiet, it is
            the answer to "what just happened here" and gets the space — beside
            what Vowe has learned, when there is any. Either way the page is the
            only thing that scrolls: the list used to live in a fixed-height box
            with a scrollbar of its own, inside a room that was mostly empty.
          */}
          <section className={`outcomes${busy ? ' secondary' : ''}`}>
            <RecentOutcomes brief={brief} compact={busy} onOpenSession={onOpenSession} />
            {!busy && <LearnedRecently records={memories} />}
          </section>
        </div>
      </div>
    </main>
  );
}

/**
 * What has been happening here, when nothing is happening now.
 *
 * A quiet project used to say only that it was quiet, which is true and
 * useless: the developer is standing in a repository asking what state it is
 * in, and "nothing is running" does not answer that. This names the last real
 * piece of work and when it landed.
 *
 * Every word comes from state Vowe already holds — the brief's own newest
 * non-active session, its title and its last interpreted activity. No model
 * runs here, nothing is summarised across sessions, and when there is no
 * history to point at this renders nothing rather than filling the space.
 */
function QuietOrientation({
  brief,
  onOpenSession,
}: {
  brief: ProjectBrief;
  onOpenSession: (sessionId: string) => void;
}): ReactElement | null {
  // Only when the room is genuinely idle: work in flight is already the story,
  // and Current Work below is where it belongs.
  if (brief.active.length > 0) return null;
  const latest = brief.recent[0];
  if (!latest) return null;

  return (
    <div className="quiet-orientation">
      <span className="lead">The latest work {finishedWord(latest.status)} {formatAgo(latest.lastActivityAt)}:</span>
      <button className="link-button" type="button" onClick={() => onOpenSession(latest.sessionId)}>
        {latest.title}
      </button>
      {latest.currentActivity && <span className="what">{latest.currentActivity}</span>}
    </div>
  );
}

/**
 * Said accurately: `recent` holds every non-active session, and an idle or
 * resumable one has not finished. Claiming it did would be the kind of small
 * invention that makes a room stop being trustworthy.
 */
function finishedWord(status: ProjectBrief['recent'][number]['status']): string {
  return status === 'finished' ? 'finished' : 'stopped';
}

/**
 * What has happened here lately, at the length the room can hold.
 *
 * Three rows and then the rest on request, rather than a nested scroll area:
 * a scrollbar inside a page that is not itself full is a smaller window
 * volunteered for no reason. Expanded, the page scrolls, which is what a page
 * is for.
 */
function RecentOutcomes({
  brief,
  compact,
  onOpenSession,
}: {
  brief: ProjectBrief | null;
  /** An active project keeps history to a tail and never expands it. */
  compact: boolean;
  onOpenSession: (sessionId: string) => void;
}): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const all = brief?.recent ?? [];
  const open = showAll && !compact;
  const shown = open ? all : all.slice(0, VISIBLE_OUTCOMES);

  return (
    <div className="column">
      <h2>Recent outcomes</h2>
      {all.length === 0 ? (
        <p className="empty">Nothing has finished here yet.</p>
      ) : (
        <>
          <div className="rows">
            {shown.map((session) => (
              <RecentRow key={session.sessionId} session={session} onOpen={onOpenSession} />
            ))}
          </div>
          {!compact && !open && all.length > VISIBLE_OUTCOMES && (
            <button className="link-button" type="button" onClick={() => setShowAll(true)}>
              View all {all.length}
            </button>
          )}
        </>
      )}
    </div>
  );
}

const VISIBLE_OUTCOMES = 3;

/**
 * What Vowe has worked out about this repository and kept.
 *
 * The question of each record, which is the thing a person recognises — these
 * are answers Vowe reached and decided were worth remembering, so the question
 * names the knowledge better than the answer's first line would.
 *
 * Absent entirely when there is no memory. An empty "Learned recently" heading
 * would be furniture claiming a capability that has not produced anything yet,
 * and no model call is made to give it something to say.
 */
function LearnedRecently({ records }: { records: ProjectMemoryRecord[] }): ReactElement | null {
  const useful = records
    .filter((record) => record.outcome !== 'dead_end')
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, 3);
  if (useful.length === 0) return null;

  return (
    <div className="column">
      <h2>Learned recently</h2>
      <div className="learned">
        {useful.map((record) => (
          <span className="item" key={record.id}>
            <span className="bullet" aria-hidden>
              •
            </span>
            <span className="what">{record.question}</span>
            <span className="when">{formatAgo(record.at)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Strictly actionable, and nothing else.
 *
 * A session that is merely idle or waiting for its own turn is not attention:
 * the projector admits a permission request and a worker explicitly waiting on
 * a person, and the quiet line says so plainly when there is neither.
 */
function NeedsYou({
  brief,
  onOpenSession,
}: {
  brief: ProjectBrief | null;
  onOpenSession: (sessionId: string) => void;
}): ReactElement {
  const items = brief?.needsAttention ?? [];

  /*
   * Nothing needing you is the ordinary state, and should look like it.
   *
   * One line, no section padding around it: an empty card the size of a real
   * one makes the absence of work as visually loud as work would be.
   */
  if (items.length === 0) {
    return (
      <div className="quiet-line spare">
        <span className="eyebrow">Needs you</span>
        <span>Nothing right now.</span>
      </div>
    );
  }

  return (
    <section className="section">
      <h2 className="attention">Needs you</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item) => (
          <div className="attention-card" key={item.id}>
            <div className="top">
              <span className="dot lg waiting" aria-hidden />
              <span className="title">{titleOf(brief, item.sessionId)}</span>
              <span className="waiting">
                {item.kind === 'permission' ? 'Waiting for permission' : 'Waiting on your decision'}
              </span>
            </div>
            <p>{item.summary}</p>
            <div className="actions">
              {/*
                Open session, not Approve once. Answering a permission prompt
                needs a provider control contract that does not exist, and a
                button that looked like it worked would be the worst kind.
              */}
              <button className="button" type="button" onClick={() => onOpenSession(item.sessionId)}>
                Open session
              </button>
              <span style={{ fontSize: 11.5, color: 'var(--ink-6)' }}>
                {formatAgo(item.createdAt)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkRow({
  session,
  onOpen,
}: {
  session: ProjectSessionSummary;
  onOpen: (sessionId: string) => void;
}): ReactElement {
  return (
    <button className="work-row" type="button" onClick={() => onOpen(session.sessionId)}>
      <span className="name">
        <span
          className={`dot lg ${session.status}${session.needsAttention ? ' hollow' : ''}`}
          aria-hidden
        />
        <Fading className="label">{session.title}</Fading>
      </span>
      <span className={`state${session.needsAttention ? ' waiting' : ''}`}>
        {session.needsAttention ? 'Waiting' : statusWord(session.status)}
      </span>
      <Fading className="note" axis="y">
        {session.currentActivity ?? 'No interpretation yet.'}
      </Fading>
      <Fading className="where">
        {[session.branch, session.provider, formatAgo(session.lastActivityAt)]
          .filter(Boolean)
          .join(' · ')}
      </Fading>
    </button>
  );
}

function RecentRow({
  session,
  onOpen,
}: {
  session: ProjectSessionSummary;
  onOpen: (sessionId: string) => void;
}): ReactElement {
  return (
    <button className="recent-row" type="button" onClick={() => onOpen(session.sessionId)}>
      <span className="name">
        <span className="check">
          <CheckIcon />
        </span>
        <Fading className="label">{session.title}</Fading>
      </span>
      <span className="when">{formatAgo(session.lastActivityAt)}</span>
      <Fading className="where">
        {[session.branch, session.provider].filter(Boolean).join(' · ')}
      </Fading>
    </button>
  );
}

/**
 * A confidence signal and nothing more.
 *
 * Symbol counts and graph status are backend facts; what a developer needs to
 * know is whether an answer about this repository will be current.
 */
function KnowledgeChip({ status, at }: { status: string; at?: string }): ReactElement | null {
  const text: Record<string, string> = {
    ready: 'Vowe knows this repository',
    stale: 'Vowe knows this repository · refreshing',
    indexing: 'Reading this repository',
    unindexed: 'Vowe has not read this repository yet',
    error: 'Vowe could not read this repository',
    unavailable: 'Repository reading is unavailable',
  };
  const label = text[status];
  if (!label) return null;

  return (
    <span className="knows">
      <span className={`dot ${status === 'ready' ? 'working' : 'idle'}`} aria-hidden />
      {label}
      {status === 'ready' && at ? ` · updated ${formatAgo(at)}` : ''}
    </span>
  );
}

function describeCounts(brief: ProjectBrief): string {
  const active = brief.active.length;
  const recent = brief.recent.length;
  const parts = [
    active === 0 ? 'No sessions running' : `${active} active session${active === 1 ? '' : 's'}`,
  ];
  if (recent > 0) parts.push(`${recent} recent`);
  return parts.join(' · ');
}

function titleOf(brief: ProjectBrief | null, sessionId: string): string {
  const found = [...(brief?.active ?? []), ...(brief?.recent ?? [])].find(
    (session) => session.sessionId === sessionId,
  );
  return found?.title ?? 'This session';
}

function statusWord(status: ProjectSessionSummary['status']): string {
  const words: Record<string, string> = {
    working: 'Working',
    waiting: 'Waiting',
    starting: 'Starting',
    idle: 'Idle',
    finished: 'Finished',
    unknown: 'Unknown',
  };
  return words[status] ?? 'Unknown';
}
