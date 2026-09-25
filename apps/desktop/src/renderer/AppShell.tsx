import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import type { UserProfile } from '@vowe/core';
import { DEFAULT_USER_PROFILE } from '@vowe/core/projections';

import { NewSessionSheet } from './components/NewSessionSheet.js';
import { ComposeIcon } from './shell/icons.js';
import { PanelToggle } from './shell/PanelToggle.js';
import { TopChrome } from './shell/TopChrome.js';
import {
  useAppStatus,
  useAppearance,
  usePresenceProfile,
  useProjectBrief,
  useTemperament,
  useVoicePreference,
  useWorkspace,
} from './hooks/useVoweData.js';
import { usePresenceSignals } from './presence/index.js';
import { ProjectSpace } from './project/ProjectSpace.js';
import { ProjectSidebar } from './sidebar/ProjectSidebar.js';
import { SessionRoom } from './session/SessionRoom.js';
import { PresenceStudio } from './studio/PresenceStudio.js';
import {
  prune,
  readExpanded,
  toggleExpanded,
  withExpanded,
  writeExpanded,
} from './state/disclosure.js';
import { projectOf, reconcileRoute, type Route } from './state/navigation.js';
import { sessionShortcutNumbers, sessionShortcutTargets } from './state/session-shortcuts.js';

import {
  CHROME_HEIGHT,
  CHROME_BODY,
  CHROME_BREATHING,
  CHROME_CONTROL,
  CHROME_GLYPH,
  NARROW_PANE,
  PANEL_LEFT,
  PANEL_LEFT_CLOSE_AT,
  PANEL_LEFT_MAX,
  PANEL_LEFT_MIN,
  PANEL_RIGHT,
  ROOM_GUTTER,
  TRAFFIC_LIGHTS,
  measureCssFor,
} from '../shared/layout.js';

/**
 * The widths, handed to the stylesheet.
 *
 * Set here rather than declared in `styles.css` so there is one copy of each
 * number. They satisfy an arithmetic relationship — the measure is exactly the
 * room both panels leave — and two copies of a number in that relationship is
 * how the relationship quietly stops holding.
 *
 * `--measure` is an expression rather than a length, and it is written in
 * terms of `100vw`. That is what keeps it independent of what is open: a
 * percentage would resolve against the column it lands in, which is the thing
 * a panel changes.
 */
const WIDTHS = {
  // The band, and the space macOS holds inside it. The main process positions
  // the real buttons from the same two numbers.
  '--chrome-height': `${CHROME_HEIGHT}px`,
  '--traffic-lights': `${TRAFFIC_LIGHTS}px`,
  // The glyphs on the band. Sized to carry the traffic lights' weight, which
  // is not the traffic lights' number: see `CHROME_GLYPH`.
  '--chrome-glyph': `${CHROME_GLYPH}px`,
  // What a glyph and the session's title both measure, seen.
  '--chrome-body': `${CHROME_BODY}px`,
  // The one gap along the band: lights → toggle → pencil.
  '--chrome-breathing': `${CHROME_BREATHING}px`,
  // The band's controls, and part of the arithmetic that places them.
  '--chrome-control': `${CHROME_CONTROL}px`,
  '--room-gutter': `${ROOM_GUTTER}px`,
  '--panel-left': `${PANEL_LEFT}px`,
  '--panel-right': `${PANEL_RIGHT}px`,
} as CSSProperties;

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
  const [appearance, saveAppearance] = useAppearance();
  const [temperament, saveTemperament] = useTemperament();
  const [voice, saveVoice] = useVoicePreference();
  const [route, setRoute] = useState<Route>({ kind: 'none' });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [commandHeld, setCommandHeld] = useState(false);
  const [user, setUser] = useState<UserProfile>(DEFAULT_USER_PROFILE);
  const [expanded, setExpanded] = useState<string[]>(readExpanded);

  const { sidebarOpen, sidebarWidth, toggleSidebar, startResize, resizing } = useSidebar();
  const fullscreen = useFullscreen();
  const viewport = useViewportWidth();
  const paneWidth = viewport - (sidebarOpen ? sidebarWidth : 0);

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

  /**
   * Open somewhere rather than nowhere.
   *
   * Landing on "pick a repository" makes the first thing Vowe shows a piece of
   * furniture. The most recently active project is almost always the one being
   * worked in, and every other room is one click away.
   */
  useEffect(() => {
    if (live.kind !== 'none' || projects.length === 0) return;
    const newest = mostRecentProject(projects, sessions);
    if (newest) setRoute({ kind: 'project', projectId: newest });
  }, [live.kind, projects, sessions]);

  /*
   * Disclosure follows selection, and never the other way around.
   *
   * Opening a session reveals the project it is in, because a selected row
   * inside a folded project would be invisible. Nothing here ever *collapses*
   * anything: what the developer opened stays open until they close it.
   */
  const routeProject = projectOf(live, { projects, sessions });
  useEffect(() => {
    if (!routeProject) return;
    setExpanded((current) => withExpanded(current, routeProject));
  }, [routeProject]);

  // Repositories that have gone are dropped rather than remembered forever.
  const projectKey = projects.map((project) => project.id).join(',');
  useEffect(() => {
    const ids = projectKey ? projectKey.split(',') : [];
    setExpanded((current) => {
      const kept = prune(current, ids);
      return kept.length === current.length ? current : kept;
    });
  }, [projectKey]);

  useEffect(() => {
    writeExpanded(expanded);
  }, [expanded]);

  const session =
    live.kind === 'session' ? sessions.find((item) => item.id === live.sessionId) ?? null : null;
  const project =
    live.kind === 'project' ? projects.find((item) => item.id === live.projectId) ?? null : null;
  const shortcutTargets = useMemo(
    () =>
      sessionShortcutTargets({
        projects,
        sessions,
        expandedProjectIds: expanded,
        now: Date.now(),
        openSessionId: live.kind === 'session' ? live.sessionId : null,
      }),
    [expanded, live, projects, sessions],
  );
  const sessionShortcuts = useMemo(() => sessionShortcutNumbers(shortcutTargets), [shortcutTargets]);
  useEffect(() => {
    const shortcutFor = (event: KeyboardEvent): number | null => {
      const digit = event.code.startsWith('Digit')
        ? event.code.slice('Digit'.length)
        : event.code.startsWith('Numpad')
          ? event.code.slice('Numpad'.length)
          : event.key;
      if (!/^[1-9]$/.test(digit)) return null;
      return Number(digit);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setCommandHeld(true);
      if (!event.metaKey) return;
      setCommandHeld(true);
      const number = shortcutFor(event);
      if (number === null) return;
      const target = shortcutTargets[number - 1];
      if (!target) return;
      event.preventDefault();
      setRoute({ kind: 'session', sessionId: target.id });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta') setCommandHeld(false);
    };
    const onBlur = () => setCommandHeld(false);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [shortcutTargets]);
  const brief = useProjectBrief(project?.id ?? null);

  return (
    <div
      className={`app${fullscreen ? ' fullscreen' : ''}${resizing ? ' resizing' : ''}`}
      style={
        {
          ...WIDTHS,
          /*
           * Which of the two regimes this window is in — the promise, or the
           * room. Decided here rather than in a media query because the
           * threshold is arithmetic over the panel widths and the floor, and
           * a stylesheet cannot be handed those without a second copy of them.
           */
          '--measure': measureCssFor(viewport),
          '--left-column': `${sidebarOpen ? sidebarWidth : 0}px`,
          // What the panel measures whether or not it is showing, so its
          // contents do not reflow to nothing on the way out.
          '--panel-width': `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      {/*
        One band across the top of the window: the space macOS wants and the
        two panel toggles, and nothing else. The three surfaces below run to
        the roof underneath it, and the open room states its own identity on
        this row inside its own column — see `TopChrome`.
      */}
      <TopChrome
        controls={
          <>
            <PanelToggle
              side="left"
              open={sidebarOpen}
              label={sidebarOpen ? 'Hide projects panel' : 'Show projects panel'}
              onToggle={toggleSidebar}
            />
            {/*
              Starting work is the window's act, not the panel's.
              
              It lived in the projects panel's own header, which meant it went
              away with the panel — and a panel is closed precisely when
              somebody wants the room, which is when a new task is most
              likely. On the band it is always where it was last clicked.
            */}
            <button
              className="icon-button chrome-button"
              type="button"
              aria-label="New task"
              title="New task"
              onClick={() => setSheetOpen(true)}
            >
              <ComposeIcon />
            </button>
          </>
        }
      >
      {/*
        The shell's columns, stated once — on `.app` itself, so the panel can
        span the chrome row as well as the body one.

        A closed panel is a zero-width column and not a laid-out box slid out
        of view: `--left-column` is the panel's width or `0px`, and the centre
        is `minmax(0, 1fr)`, so the room genuinely grows into whatever the
        panel gives back. Nothing here reserves width — the toggles are on the
        band and the resize handle is absolute.
      */}
        <aside
          className={`sidebar${sidebarOpen ? '' : ' closed'}`}
          aria-hidden={!sidebarOpen}
        >
          <ProjectSidebar
            projects={projects}
            sessions={sessions}
            route={live}
            expandedProjectIds={expanded}
            onToggleExpanded={(projectId) =>
              setExpanded((current) => toggleExpanded(current, projectId))
            }
            presence={presence}
            presenceState={presenceState}
            sessionShortcuts={sessionShortcuts}
            showSessionShortcuts={commandHeld && shortcutTargets.length > 0}
            onNavigate={setRoute}
          />
        </aside>

        {/*
          The edge, without a line on it.

          There is no divider to draw: a panel that can be resized does not
          need a rule announcing that it can, and the surface reads as one
          surface without it. What remains is the affordance — a few
          transparent pixels straddling the boundary, positioned over it
          rather than between the columns, so the handle costs no width.
        */}
        {sidebarOpen && (
          <button
            className={`resize-handle left${resizing ? ' active' : ''}`}
            type="button"
            aria-label="Resize projects panel"
            title="Drag to resize · drag to the left edge to close"
            onMouseDown={startResize}
          />
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
            narrow={paneWidth < NARROW_PANE}
          />
        ) : project ? (
          <ProjectSpace
            key={project.id}
            project={project}
            brief={brief}
            presence={presence}
            presenceState={presenceState}
            view={live.kind === 'project' ? live.view ?? 'home' : 'home'}
            entryId={live.kind === 'project' ? live.entryId : undefined}
            narrow={paneWidth < NARROW_PANE}
            onNavigate={(view, entryId) => setRoute({ kind: 'project', projectId: project.id, view, ...(entryId ? { entryId } : {}) })}
            onOpenSession={(sessionId) => setRoute({ kind: 'session', sessionId })}
          />
        ) : live.kind === 'studio' ? (
          <PresenceStudio
            profile={presence}
            appearance={appearance}
            temperament={temperament}
            voice={voice}
            voiceUnavailableReason={
              status && !status.voiceConfigured
                ? (status.voiceUnavailableReason ?? 'Voice is unavailable.')
                : null
            }
            onAppearanceChange={(next) => void saveAppearance(next)}
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
      </TopChrome>

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

/** The project whose work moved most recently, which is where someone was. */
function mostRecentProject(
  projects: readonly { id: string }[],
  sessions: readonly { projectId: string | null; lastActivityAt: string }[],
): string | null {
  let best: { id: string; at: string } | null = null;
  for (const session of sessions) {
    if (!session.projectId) continue;
    if (!projects.some((project) => project.id === session.projectId)) continue;
    if (!best || session.lastActivityAt > best.at) {
      best = { id: session.projectId, at: session.lastActivityAt };
    }
  }
  return best?.id ?? projects[0]?.id ?? null;
}

/**
 * Real window state, not a CSS guess.
 *
 * In fullscreen the traffic lights are gone, and the space reserved to clear
 * them becomes a dead band at the top of the sidebar. Only the main process
 * knows which state the window is in.
 */
function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    void window.vowe.isFullscreen().then(setFullscreen).catch(() => undefined);
    return window.vowe.onFullscreenChanged(setFullscreen);
  }, []);
  return fullscreen;
}

/**
 * How wide the panel is, and whether it is there at all.
 *
 * The width is a number the shell turns into a grid column; closed is a column
 * of zero rather than a box pushed out of view under a negative margin, which
 * is the difference between the room growing and the room staying put beside
 * an empty gutter.
 */
function useSidebar() {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(PANEL_LEFT);
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
        if (x < PANEL_LEFT_CLOSE_AT) {
          stop();
          setOpen(false);
          setWidth(PANEL_LEFT_MIN);
          return;
        }
        setWidth(Math.max(PANEL_LEFT_MIN, Math.min(PANEL_LEFT_MAX, x)));
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

/**
 * The window's own width, watched.
 *
 * Two different questions are asked of it and they are not the same question.
 * Which measure regime the window is in is about the *window*, because the
 * regime may not depend on what is open. Whether the desk can sit beside the
 * conversation is about the *pane*, because that is the box the two would
 * have to share.
 */
function useViewportWidth(): number {
  const [viewport, setViewport] = useState(() =>
    typeof window === 'undefined' ? 1400 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewport;
}
