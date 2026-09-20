import { useCallback, useEffect, useState, type ReactElement } from 'react';

import type { AgentSession, RepoIndexState } from '@vowe/core';

import {
  CheckIcon,
  codeKnowledgeChip,
  describeActivity,
  formatAgo,
  statusLabel,
  tildePath,
  type ProjectGroup,
} from './ui.js';

interface Props {
  group: ProjectGroup;
  onOpenSession: (sessionId: string) => void;
  /** Set when no code graph can be built at all. */
  knowledgeUnavailableReason: string | null;
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
export function ProjectRoom({
  group,
  onOpenSession,
  knowledgeUnavailableReason,
}: Props): ReactElement {
  const { project, working, recent } = group;
  const knowledge = useProjectKnowledge(project.id);
  const chip = codeKnowledgeChip(knowledge, knowledgeUnavailableReason);

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
         * What Vowe knows about the code itself, as opposed to the work.
         * Status only: there is no graph to browse here and no memory to read,
         * because this is infrastructure for answering questions, not a
         * second application bolted onto the side of the first.
         */}
        <span className="status-pill" title={chip.title ?? undefined}>
          <span className={`dot small ${chip.dot}`} />
          Code knowledge · {chip.label}
        </span>
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

/**
 * The Project's index state, kept current from the main process.
 *
 * Asking for it never starts a build. A room that indexed a repository just by
 * being opened would be spending the user's machine on a question nobody asked.
 */
function useProjectKnowledge(projectId: string): RepoIndexState | null {
  const [state, setState] = useState<RepoIndexState | null>(null);

  const reload = useCallback(() => {
    void window.vowe.getProjectKnowledge(projectId).then(setState);
  }, [projectId]);

  useEffect(() => {
    reload();
    return window.vowe.onProjectKnowledgeChanged((changed) => {
      if (changed === projectId) reload();
    });
  }, [projectId, reload]);

  return state;
}
