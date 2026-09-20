import type { ReactElement } from 'react';

import type { AgentSession } from '@vowe/core';

import {
  CheckIcon,
  describeActivity,
  formatAgo,
  statusLabel,
  tildePath,
  type ProjectGroup,
} from './ui.js';

interface Props {
  group: ProjectGroup;
  onOpenSession: (sessionId: string) => void;
}

/**
 * Everything happening in one repository.
 *
 * Composed entirely from session state the renderer already holds: task names,
 * status, the latest interpreted activity, and how long ago each session was
 * last busy. **No model is called to render this.** There is no project
 * observer and no cross-session reasoning — the value here is that the work is
 * gathered in one place, not that anything new was inferred about it.
 */
export function ProjectRoom({ group, onOpenSession }: Props): ReactElement {
  const { project, working, recent } = group;

  return (
    <section className="detail">
      <header className="detail-header titlebar-drag">
        <div className="titles">
          <span className="title">{project.name}</span>
          <span className="subtitle">
            {describeActivity(group)}
            {/* Path is metadata, not identity — subdued and last. */}
            <span className="path"> · {tildePath(project.repoRoot)}</span>
          </span>
        </div>
        {/*
         * Deliberately left clear: this is where "Ask Vo about this project…"
         * goes when project-level intelligence arrives. Nothing else in the
         * hierarchy has to change to add it.
         */}
      </header>

      <div className="detail-main">
        <div className="detail-scroll">
          <section className="room">
            {working.length > 0 && (
              <>
                <h2 className="room-label">Working</h2>
                {working.map((session) => (
                  <WorkingRow
                    key={session.id}
                    session={session}
                    onOpen={onOpenSession}
                  />
                ))}
              </>
            )}

            {recent.length > 0 && (
              <>
                <h2 className="room-label">Recent</h2>
                {recent.map((session) => (
                  <RecentRow
                    key={session.id}
                    session={session}
                    onOpen={onOpenSession}
                  />
                ))}
              </>
            )}

            {working.length === 0 && recent.length === 0 && (
              <p className="room-empty">
                No sessions in this project yet. Start one in a terminal inside{' '}
                <code className="inline">{tildePath(project.repoRoot)}</code> and it
                appears here.
              </p>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

function WorkingRow({
  session,
  onOpen,
}: {
  session: AgentSession;
  onOpen: (sessionId: string) => void;
}): ReactElement {
  return (
    <button className="room-row" onClick={() => onOpen(session.id)}>
      <span className="room-row-top">
        <span className={`dot ${session.status}`} />
        <span className="name">{session.displayLabel}</span>
        <span className="state">{statusLabel(session.status)}</span>
      </span>
      {session.semanticState?.currentActivity && (
        <span className="room-row-note">{session.semanticState.currentActivity}</span>
      )}
      <span className="room-row-meta">
        {formatAgo(session.lastActivityAt)}
        {session.branch && <> · {session.branch}</>}
      </span>
    </button>
  );
}

function RecentRow({
  session,
  onOpen,
}: {
  session: AgentSession;
  onOpen: (sessionId: string) => void;
}): ReactElement {
  return (
    <button className="room-row recent" onClick={() => onOpen(session.id)}>
      <span className="room-row-top">
        <span className="tick">
          <CheckIcon />
        </span>
        <span className="name">{session.displayLabel}</span>
        <span className="state">{formatAgo(session.lastActivityAt)}</span>
      </span>
      {session.branch && <span className="room-row-meta">{session.branch}</span>}
    </button>
  );
}
