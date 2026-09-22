import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { UserProfile } from '@vowe/core';
import { DEFAULT_USER_PROFILE } from '@vowe/core/projections';

import { NewSessionSheet } from './components/NewSessionSheet.js';
import { ComposeIcon, PanelIcon } from './shell/icons.js';
import {
  useAppStatus,
  usePresenceProfile,
  useProjectBrief,
  useTemperament,
  useVoicePreference,
  useWorkspace,
} from './hooks/useVoweData.js';
import { usePresenceSignals } from './presence/index.js';
import { ProjectRoom } from './project/ProjectRoom.js';
import { ProjectSidebar } from './sidebar/ProjectSidebar.js';
import { SessionRoom } from './session/SessionRoom.js';
import { PresenceStudio } from './studio/PresenceStudio.js';
import { projectOf, reconcileRoute, type Route } from './state/navigation.js';

/** Below this, the pane cannot hold a reading measure beside the workbench. */
const NARROW_PANE = 790;
const SIDEBAR_MIN = 208;
const SIDEBAR_MAX = 420;
const SIDEBAR_CLOSE_AT = 150;

/**
 * The window: one sidebar and one room.
 *
 * Selection lives here because two rooms and the sidebar all need it, and
 * because a route has to be reconciled against what still exists — sessions
 * finish and disappear while their room is open.
 */
export function AppShell(): ReactElement {
  const { projects, sessions } = useWorkspace();
  const status = useAppStatus();
  const [presence, savePresence] = usePresenceProfile();
  const [temperament, saveTemperament] = useTemperament();
  const [voice, saveVoice] = useVoicePreference();
  const [route, setRoute] = useState<Route>({ kind: 'none' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [user, setUser] = useState<UserProfile>(DEFAULT_USER_PROFILE);

  const { sidebarOpen, sidebarWidth, toggleSidebar, startResize, resizing } = useSidebar();
  const paneWidth = usePaneWidth(sidebarOpen ? sidebarWidth : 0);

  const { state: presenceState } = usePresenceSignals({ status, sessions });

  useEffect(() => {
    void window.vowe.getUserProfile().then(setUser).catch(() => undefined);
  }, []);

  // A room whose subject has gone is not a room. Reconciling here keeps every
  // screen below from having to handle an absent session of its own.
  const live = useMemo(
    () => reconcileRoute(route, { projects, sessions }),
    [route, projects, sessions],
  );
  useEffect(() => {
    if (live !== route) setRoute(live);
  }, [live, route]);

  const session =
    live.kind === 'session' ? sessions.find((item) => item.id === live.sessionId) ?? null : null;
  const project =
    live.kind === 'project' ? projects.find((item) => item.id === live.projectId) ?? null : null;
  const brief = useProjectBrief(project?.id ?? null);

  return (
    <div className="app">
      <div className="titlebar">
        <button
          className="icon-button"
          type="button"
          aria-label="Toggle projects panel"
          title="Toggle projects panel"
          onClick={toggleSidebar}
        >
          <PanelIcon />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="New task"
          title="New task"
          onClick={() => setSheetOpen(true)}
        >
          <ComposeIcon />
        </button>
      </div>

      <div className="body">
        <aside
          className={`sidebar${sidebarOpen ? '' : ' closed'}${resizing ? ' resizing' : ''}`}
          style={{
            flexBasis: sidebarWidth,
            width: sidebarWidth,
            marginLeft: sidebarOpen ? 0 : -(sidebarWidth + 1),
          }}
          aria-hidden={!sidebarOpen}
        >
          <ProjectSidebar
            projects={projects}
            sessions={sessions}
            route={live}
            expandedProjectId={projectOf(live, { projects, sessions })}
            presence={presence}
            presenceState={presenceState}
            onNavigate={setRoute}
          />
        </aside>

        {sidebarOpen && (
          <button
            className={`resizer${resizing ? ' active' : ''}`}
            type="button"
            aria-label="Resize projects panel"
            title="Drag to resize · drag to the left edge to close"
            onMouseDown={startResize}
          >
            <span />
          </button>
        )}

        {session ? (
          <SessionRoom
            key={session.id}
            session={session}
            presence={presence}
            presenceState={presenceState}
            userName={user.displayName}
            voiceUnavailableReason={
              status && !status.voiceConfigured
                ? (status.voiceUnavailableReason ?? 'Voice is unavailable.')
                : null
            }
            sidebarOpen={sidebarOpen}
            narrow={paneWidth < NARROW_PANE}
          />
        ) : project ? (
          <ProjectRoom
            key={project.id}
            project={project}
            brief={brief}
            presence={presence}
            presenceState={presenceState}
            sidebarOpen={sidebarOpen}
            onOpenSession={(sessionId) => setRoute({ kind: 'session', sessionId })}
          />
        ) : live.kind === 'studio' ? (
          <PresenceStudio
            profile={presence}
            temperament={temperament}
            voice={voice}
            voiceUnavailableReason={
              status && !status.voiceConfigured
                ? (status.voiceUnavailableReason ?? 'Voice is unavailable.')
                : null
            }
            sidebarOpen={sidebarOpen}
            onProfileChange={(next) => void savePresence(next)}
            onTemperamentChange={(next) => void saveTemperament(next)}
            onVoiceChange={(next) => void saveVoice(next)}
          />
        ) : (
          <Nowhere
            hasSessions={sessions.length > 0}
            llmConfigured={status?.llmConfigured ?? true}
            onNewTask={() => setSheetOpen(true)}
          />
        )}
      </div>

      {sheetOpen && (
        <NewSessionSheet
          onClose={() => setSheetOpen(false)}
          onLaunched={(launched) => {
            setSheetOpen(false);
            setRoute({ kind: 'session', sessionId: launched.id });
          }}
        />
      )}
    </div>
  );
}

/**
 * Nothing selected. Honest about why, and about what Vowe can still do.
 */
function Nowhere({
  hasSessions,
  llmConfigured,
  onNewTask,
}: {
  hasSessions: boolean;
  llmConfigured: boolean;
  onNewTask: () => void;
}): ReactElement {
  return (
    <main className="pane">
      <header className="pane-header clear-titlebar" />
      <div className="scroll room">
        <div className="room-inner">
          <div className="empty-block" style={{ paddingTop: 48 }}>
            <h2>{hasSessions ? 'Open a project' : 'Waiting for a coding session'}</h2>
            <p className="empty">
              {hasSessions
                ? 'Pick a repository on the left to see what is happening in it, or open a session to follow it live.'
                : 'Start Claude Code in any terminal and it appears here within a few seconds, grouped under its repository. Vowe only watches: it will not touch the session unless you send it an instruction.'}
            </p>
            {!hasSessions && (
              <div>
                <button className="button" type="button" onClick={onNewTask}>
                  New task…
                </button>
              </div>
            )}
            {!llmConfigured && (
              <div className="notice">
                <strong>Answers are off</strong>
                <p>
                  No model credential is configured. Vowe still finds sessions, groups them by
                  repository and records everything; asking needs a key.
                </p>
                <code>export ANTHROPIC_API_KEY=sk-ant-…</code>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * The panel keeps its width and slides out under a negative margin, which is
 * also what reclaims the space. The toggle lives in the title bar so that
 * collapsing never moves it.
 */
function useSidebar() {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(252);
  const [resizing, setResizing] = useState(false);
  const frame = useRef<number | null>(null);

  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const move = (moved: MouseEvent) => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const x = moved.clientX;
        // Dragged to the left edge, the panel closes rather than shrinking to
        // something too narrow to read.
        if (x < SIDEBAR_CLOSE_AT) {
          stop();
          setOpen(false);
          setWidth(SIDEBAR_MIN);
          return;
        }
        setWidth(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, x)));
      });
    };

    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setResizing(false);
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }, []);

  return {
    sidebarOpen: open,
    sidebarWidth: width,
    resizing,
    toggleSidebar: () => setOpen((was) => !was),
    startResize,
  };
}

/** Breakpoints are about the pane the content gets, not the window. */
function usePaneWidth(sidebarWidth: number): number {
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined' ? 1400 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport - sidebarWidth;
}
