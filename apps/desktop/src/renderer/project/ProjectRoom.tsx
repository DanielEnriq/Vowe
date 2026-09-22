import { useState, type ReactElement } from 'react';

import type {
  PresenceProfile,
  PresenceState,
  Project,
  ProjectBrief,
  ProjectSessionSummary,
} from '@vowe/core';

import { VowePresence } from '../presence/index.js';
import { CheckIcon } from '../shell/icons.js';
import { formatAgo, tildePath } from '../components/ui.js';
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
 * Everything on this screen is either a field of `ProjectBrief` or a
 * deterministic rendering of one. There is no project agent, no model call and
 * no cross-session reasoning here — the room reads a projection that was
 * already reconciled, so its headline cannot contradict the work beneath it.
 */
export function ProjectRoom({
  project,
  brief,
  presence,
  presenceState,
  sidebarOpen,
  onOpenSession,
}: Props): ReactElement {
  const [askOpen, setAskOpen] = useState(false);

  return (
    <main className="pane">
      <header className={`pane-header${sidebarOpen ? '' : ' clear-titlebar'}`}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <h1>{project.name}</h1>
          <span className="meta">
            {brief ? describeCounts(brief) : 'Reading the project…'}
            {' · '}
            <span className="path">{tildePath(project.repoRoot)}</span>
          </span>
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
                    <span key={line}>{line}</span>
                  ))}
                </div>
              )}

              <div className="actions">
                <button className="link-button" type="button" onClick={() => setAskOpen((open) => !open)}>
                  Ask about this repository
                </button>
              </div>

              {askOpen && <ProjectAsk projectId={project.id} />}

              {brief && <KnowledgeChip status={brief.knowledge.status} at={brief.knowledge.updatedAt} />}
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

          <div className="rule" style={{ marginTop: 18 }} />

          <section className="columns">
            <div className="column">
              <h2>Latest from Vowe</h2>
              {brief?.latestSignal ? (
                <p className="signal">{brief.latestSignal.text}</p>
              ) : (
                // Omitted rather than filled: there is no summariser here, and
                // nothing meaningful has been said yet.
                <p className="empty">Nothing worth reporting yet.</p>
              )}
            </div>

            <div className="column">
              <h2>Recently finished</h2>
              {brief && brief.recent.length > 0 ? (
                brief.recent.map((session) => (
                  <RecentRow key={session.sessionId} session={session} onOpen={onOpenSession} />
                ))
              ) : (
                <p className="empty">Nothing has finished here yet.</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
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

  if (items.length === 0) {
    return (
      <section className="section">
        <div className="quiet-line">
          <span className="eyebrow">Needs you</span>
          <span>Nothing right now.</span>
        </div>
      </section>
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
        <span>{session.title}</span>
      </span>
      <span className={`state${session.needsAttention ? ' waiting' : ''}`}>
        {session.needsAttention ? 'Waiting' : statusWord(session.status)}
      </span>
      <span className="note">{session.currentActivity ?? 'No interpretation yet.'}</span>
      <span className="where">
        {[session.branch, session.provider, formatAgo(session.lastActivityAt)]
          .filter(Boolean)
          .join(' · ')}
      </span>
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
        <span>{session.title}</span>
      </span>
      <span className="when">{formatAgo(session.lastActivityAt)}</span>
      <span className="where">{[session.branch, session.provider].filter(Boolean).join(' · ')}</span>
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
