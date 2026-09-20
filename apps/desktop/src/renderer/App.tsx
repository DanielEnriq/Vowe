import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import type { AgentSession, Project } from '@vowe/core';
import type { AppStatus } from '../shared/ipc.js';

import { NewSessionSheet } from './components/NewSessionSheet.js';
import { ProjectRoom } from './components/ProjectRoom.js';
import { ProjectSidebar, type Selection } from './components/ProjectSidebar.js';
import { SessionDetail } from './components/SessionDetail.js';
import { groupByProject } from './components/ui.js';

export function App(): ReactElement {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [nextProjects, nextSessions] = await Promise.all([
      window.vowe.listProjects(),
      window.vowe.listSessions(),
    ]);
    setProjects(nextProjects);
    setSessions(nextSessions);
  }, []);

  useEffect(() => {
    void refresh();
    void window.vowe.getStatus().then(setStatus).catch(() => undefined);
    return window.vowe.onSessionsChanged(() => {
      void refresh();
    });
  }, [refresh]);

  const { groups, unplaced } = useMemo(
    () => groupByProject(projects, sessions),
    [projects, sessions],
  );

  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const openSession = useCallback(
    (sessionId: string) => setSelection({ kind: 'session', sessionId }),
    [],
  );

  const selectedSession =
    selection.kind === 'session'
      ? (sessions.find((session) => session.id === selection.sessionId) ?? null)
      : null;

  const selectedGroup =
    selection.kind === 'project'
      ? (groups.find((group) => group.project.id === selection.projectId) ?? null)
      : null;

  const activeCount = groups.reduce((total, group) => total + group.working.length, 0);

  return (
    <div className="app">
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        selection={selection}
        status={status}
        onSelect={setSelection}
        onNewSession={() => setSheetOpen(true)}
      />

      {selectedSession ? (
        <SessionDetail
          key={selectedSession.id}
          session={selectedSession}
          llmConfigured={status?.llmConfigured ?? false}
          voiceConfigured={status?.voiceConfigured ?? false}
          voiceUnavailableReason={status?.voiceUnavailableReason ?? null}
        />
      ) : selectedGroup ? (
        <ProjectRoom
          key={selectedGroup.project.id}
          group={selectedGroup}
          onOpenSession={openSession}
          knowledgeUnavailableReason={
            status && !status.codeKnowledgeConfigured
              ? status.codeKnowledgeUnavailableReason
              : null
          }
        />
      ) : (
        <section className="detail">
          <header className="detail-header titlebar-drag" />
          <div className="placeholder">
            <div className="inner">
              {sessions.length === 0 ? (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <h1>Waiting for a coding session</h1>
                    <p>
                      Start Claude Code in any terminal and it appears here
                      within a few seconds, grouped under its repository. Vowe
                      only watches: it won’t touch the session unless you send
                      it an instruction.
                    </p>
                  </div>
                  <div>
                    <button className="btn primary" onClick={() => setSheetOpen(true)}>
                      New task…
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h1>Your agents are working</h1>
                  <p className="overview">
                    {countLabel(groups.length, 'project')}
                    {' · '}
                    {countLabel(activeCount, 'active session')}
                    {unplaced.length > 0 && (
                      <> · {countLabel(unplaced.length, 'session')} with no project</>
                    )}
                  </p>
                  <p>
                    Open a project to see its work, or open a session to follow
                    it live.
                  </p>
                </div>
              )}

              {status && !status.voiceConfigured && (
                <p className="fine">
                  Vo’s voice is unavailable.{' '}
                  {status.voiceUnavailableReason ??
                    'No voice credential is configured.'}{' '}
                  Observation is unaffected.
                </p>
              )}

              {status && !status.llmConfigured && (
                <div className="notice">
                  <strong>Summaries and answers are off</strong>
                  <p>
                    No <code className="inline">ANTHROPIC_API_KEY</code> or{' '}
                    <code className="inline">OPENROUTER_API_KEY</code> is set.
                    Vowe still finds sessions, groups them by repository,
                    records every event and shows their status. To turn on
                    summaries and Ask Vowe, set a key and restart:
                  </p>
                  <code>export ANTHROPIC_API_KEY=sk-ant-…</code>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {sheetOpen && (
        <NewSessionSheet
          onClose={closeSheet}
          onLaunched={(session) => {
            setSheetOpen(false);
            void refresh();
            setSelection({ kind: 'session', sessionId: session.id });
          }}
        />
      )}
    </div>
  );
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
