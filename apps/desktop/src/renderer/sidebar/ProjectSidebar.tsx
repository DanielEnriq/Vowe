import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { AgentSession, PresenceProfile, PresenceState, Project, UserProfile } from '@vowe/core';
import { DEFAULT_USER_PROFILE } from '@vowe/core/projections';

import { Fading } from '../shell/Fading.js';
import { VowePresence } from '../presence/index.js';
import {
  ArchiveIcon,
  FolderIcon,
  ObservingIcon,
  PlusIcon,
  RepoIcon,
  SearchIcon,
  SettingsIcon,
} from '../shell/icons.js';
import { ProjectOpener } from './ProjectOpener.js';
import { SessionFinder } from './SessionFinder.js';
import { currentSessions } from '../state/session-visibility.js';
import {
  activeCount,
  sessionsForProject,
  type Route,
} from '../state/navigation.js';
import { ProviderGlyph, statusLabel } from '../components/ui.js';
import { sessionActivity, sessionTitle } from '@vowe/core/projections';

interface Props {
  /** The projects the panel shows: the open ones, and the one being looked at. */
  projects: Project[];
  /** Every project Vowe knows, which is what the `+` opens from. */
  allProjects: Project[];
  sessions: AgentSession[];
  route: Route;
  /**
   * Every project currently showing its sessions.
   *
   * A list, not one id: expanding is not selecting, and a developer watching
   * two repositories should be able to see both at once.
   */
  expandedProjectIds: readonly string[];
  onToggleExpanded: (projectId: string) => void;
  presence: PresenceProfile;
  presenceState: PresenceState;
  sessionShortcuts?: ReadonlyMap<string, number>;
  showSessionShortcuts?: boolean;
  onNavigate: (route: Route) => void;
  onCloseProject: (projectId: string) => void;
}

/**
 * Projects are the durable parents of sessions, so they are the spine here.
 *
 * Arbitrary numbers of both: nothing is hardcoded, nothing is capped, and a
 * repository with one session looks like a repository with nine.
 */
export function ProjectSidebar({
  projects,
  allProjects,
  sessions,
  route,
  expandedProjectIds,
  onToggleExpanded,
  presence,
  presenceState,
  sessionShortcuts,
  showSessionShortcuts = false,
  onNavigate,
  onCloseProject,
}: Props): ReactElement {
  const user = useUserProfile();
  const [opening, setOpening] = useState(false);
  const openSessionId = route.kind === 'session' ? route.sessionId : null;
  /*
   * One clock for the whole panel, read once per render.
   *
   * Every row asks whether its sessions are recent, and rows that each called
   * `Date.now()` could disagree about where the week ends — a session could
   * be recent in one block and old in the next within the same paint.
   */
  const now = Date.now();
  const [paused, setPaused] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    void window.vowe.getPausedProjects().then((ids) => setPaused(new Set(ids)), () => undefined);
  }, []);
  const setObserving = async (projectId: string, observing: boolean) =>
    setPaused(new Set(await window.vowe.setProjectObserving(projectId, observing)));
  const archive = (sessionId: string, archived: boolean) => {
    void window.vowe.archiveSession(sessionId, archived).catch(() => undefined);
  };
  const unplaced = currentSessions(
    sessions.filter((session) => session.projectId === null),
    { now, openSessionId },
  );

  return (
    <>
      {/*
        The panel's own header, clear of the window's chrome.

        Neither collapsing nor starting a task is here. Both belong to the
        window: they have to exist whether or not this panel does, and a
        control that moved with the edge it closes was never where it had last
        been clicked. Both sit on the band now, and this row is only a label.
      */}
      <div className="sidebar-title">
        <span className="eyebrow">Projects</span>
        {/*
          Projects are opt-in: every repository a worker runs in is discovered,
          and none of them is in the panel until it is opened here.
        */}
        <button
          className="icon-button add"
          type="button"
          aria-label="Open a project"
          title="Open a project"
          aria-haspopup="dialog"
          aria-expanded={opening}
          onClick={() => setOpening((open) => !open)}
        >
          <PlusIcon />
        </button>
        {opening && (
          <ProjectOpener
            projects={allProjects}
            sessions={sessions}
            now={now}
            onOpened={(projectId) => onNavigate({ kind: 'project', projectId })}
            onDismiss={() => setOpening(false)}
          />
        )}
      </div>

      <nav className="sidebar-nav">
        {projects.length === 0 && unplaced.length === 0 && (
          <p className="empty" style={{ padding: '10px 8px' }}>
            {allProjects.length === 0
              ? 'No coding sessions yet. Start one in any terminal and it appears here.'
              : 'No projects open. Use + to open one.'}
          </p>
        )}

        {projects.map((project) => (
          <ProjectBlock
            key={project.id}
            project={project}
            sessions={sessions}
            route={route}
            expanded={expandedProjectIds.includes(project.id)}
            now={now}
            openSessionId={openSessionId}
            onNavigate={onNavigate}
            onToggleExpanded={() => onToggleExpanded(project.id)}
            paused={paused.has(project.id)}
            onToggleObserving={() => void setObserving(project.id, paused.has(project.id))}
            onArchive={archive}
            onClose={() => onCloseProject(project.id)}
            sessionShortcuts={sessionShortcuts}
            showSessionShortcuts={showSessionShortcuts}
          />
        ))}

        {unplaced.length > 0 && (
          <>
            <div className="project-row">
              <span className="disclose" aria-hidden>
                <FolderIcon />
              </span>
              <span className="open static">
                <span className="name">No project</span>
                <span className="count">{unplaced.length}</span>
              </span>
            </div>
            <div className="session-list">
              {unplaced.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={route.kind === 'session' && route.sessionId === session.id}
                  shortcut={showSessionShortcuts ? sessionShortcuts?.get(session.id) : undefined}
                  onOpen={() => onNavigate({ kind: 'session', sessionId: session.id })}
                  onArchive={() => archive(session.id, true)}
                />
              ))}
            </div>
          </>
        )}
      </nav>

      {/* One identity, above the work it is watching. */}
      <button
        className={`vowe-row${route.kind === 'studio' ? ' selected' : ''}`}
        type="button"
        onClick={() => onNavigate({ kind: 'studio' })}
      >
        <VowePresence state={presenceState} profile={presence} size="signature" />
        <span className="who">
          <span className="name">Your Vowe</span>
          <Fading className="doing">
            {presence.form === 'point-cloud' ? 'point cloud' : presence.form} · {presence.material}
          </Fading>
        </span>
      </button>

      <div className="sidebar-footer">
        <span className="avatar" aria-hidden>
          {initialOf(user.displayName)}
        </span>
        <Fading className="who">{user.displayName}</Fading>
        <button
          className="icon-button"
          type="button"
          aria-label="Your Vowe"
          title="Your Vowe"
          onClick={() => onNavigate({ kind: 'studio' })}
        >
          <SettingsIcon />
        </button>
      </div>
    </>
  );
}

function ProjectBlock({
  project,
  sessions,
  route,
  expanded,
  now,
  openSessionId,
  onNavigate,
  onToggleExpanded,
  paused,
  onToggleObserving,
  onArchive,
  onClose,
  sessionShortcuts,
  showSessionShortcuts,
}: {
  project: Project;
  sessions: AgentSession[];
  route: Route;
  expanded: boolean;
  now: number;
  openSessionId: string | null;
  onNavigate: (route: Route) => void;
  onToggleExpanded: () => void;
  paused: boolean;
  onToggleObserving: () => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  onClose: () => void;
  sessionShortcuts?: ReadonlyMap<string, number>;
  showSessionShortcuts: boolean;
}): ReactElement {
  const all = sessionsForProject(project.id, sessions);
  /*
   * What is going on now, not everything that ever ran here.
   *
   * A coding worker leaves a session behind on every run, so an unfiltered
   * panel becomes a list of finished work with today's buried in it. The rest
   * is one click away through the search on this row — see `SessionFinder`.
   */
  const own = currentSessions(all, { now, openSessionId });
  const live = activeCount(project.id, sessions);
  const [finding, setFinding] = useState(false);
  /** Where the row was right-clicked, relative to the row. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      {/*
        Two acts, two controls, and no extra furniture for the second one.
        The project's own icon is the disclosure: clicking it shows or hides
        the sessions inside, which is what a folder has always meant. Clicking
        the name opens the project. A separate chevron said the same thing
        twice and made every row a pixel busier for it.

        Siblings rather than nested, because a button inside a button is not
        valid markup — and because these genuinely are two targets.
      */}
      <div
        className={`project-row${
          route.kind === 'project' && route.projectId === project.id ? ' selected' : ''
        }`}
        onContextMenu={(event) => {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          setMenuAt({ x: event.clientX - box.left, y: event.clientY - box.top });
        }}
      >
        <button
          className={`disclose${expanded ? ' expanded' : ''}`}
          type="button"
          aria-expanded={expanded}
          aria-label={
            expanded ? `Hide sessions in ${project.name}` : `Show sessions in ${project.name}`
          }
          title={expanded ? 'Hide sessions' : 'Show sessions'}
          disabled={own.length === 0}
          onClick={onToggleExpanded}
        >
          <RepoIcon />
        </button>
        <button
          className="open"
          type="button"
          onClick={() => onNavigate({ kind: 'project', projectId: project.id })}
        >
          <Fading className="name">{project.name}</Fading>
        </button>
        {/*
          Whether Vowe is observing this project, and how much of it is live.
          The count is just the number, beside the eye: how many workers are
          running here. Paused, the project's sessions are still recorded but
          nothing reaches a model for them until it is resumed.
        */}
        <button
          className={`observe${paused ? ' paused' : ''}${live > 0 ? ' live' : ''}`}
          type="button"
          aria-pressed={!paused}
          aria-label={`${paused ? 'Resume' : 'Pause'} observing ${project.name}`}
          title={[
            live > 0 ? `${live} active` : null,
            paused
              ? 'Paused · still recorded, not interpreted. Click to resume'
              : 'Observing · click to pause',
          ]
            .filter(Boolean)
            .join(' · ')}
          onClick={onToggleObserving}
        >
          {live > 0 && <span className="live-count">{live}</span>}
          <ObservingIcon paused={paused} />
        </button>
        {/*
          Where everything this project has actually is. The row above shows
          recent work; this reaches the rest, and is how a session that was
          put away comes back.
        */}
        <button
          className="find"
          type="button"
          aria-label={`Find a session in ${project.name}`}
          title="Find a session"
          aria-haspopup="dialog"
          aria-expanded={finding}
          disabled={all.length === 0}
          onClick={() => setFinding((open) => !open)}
        >
          <SearchIcon />
        </button>
        {finding && (
          <SessionFinder
            sessions={all}
            now={now}
            onOpen={(sessionId) => onNavigate({ kind: 'session', sessionId })}
            onUnarchive={(sessionId) => onArchive(sessionId, false)}
            onDismiss={() => setFinding(false)}
          />
        )}
        {menuAt && (
          <ProjectMenu
            at={menuAt}
            name={project.name}
            onClose={onClose}
            onDismiss={() => setMenuAt(null)}
          />
        )}
      </div>

      {expanded && own.length > 0 && (
        <div className="session-list">
          {own.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={route.kind === 'session' && route.sessionId === session.id}
              shortcut={showSessionShortcuts ? sessionShortcuts?.get(session.id) : undefined}
              onOpen={() => onNavigate({ kind: 'session', sessionId: session.id })}
              onArchive={() => onArchive(session.id, true)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * A project row's right-click menu.
 *
 * Closing only takes the project out of the panel. Its sessions are still
 * observed, and it comes back from the `+` beside the heading.
 */
function ProjectMenu({
  at,
  name,
  onClose,
  onDismiss,
}: {
  at: { x: number; y: number };
  name: string;
  onClose: () => void;
  onDismiss: () => void;
}): ReactElement {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    root.current?.querySelector('button')?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onDismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', onDismiss);
    };
  }, [onDismiss]);

  return (
    <div
      className="menu row-menu"
      role="menu"
      aria-label={`${name} actions`}
      ref={root}
      style={{ top: at.y, left: at.x }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDismiss();
          onClose();
        }}
      >
        Close project
      </button>
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onOpen,
  onArchive,
  shortcut,
}: {
  session: AgentSession;
  selected: boolean;
  onOpen: () => void;
  onArchive?: (() => void) | undefined;
  shortcut?: number | undefined;
}): ReactElement {
  // The activity line is the interpreter's, not a guess: when nothing has been
  // interpreted yet it says the status rather than inventing a description.
  const activity = sessionActivity(session) ?? statusLabel(session.status);

  /*
   * Two acts, two controls — the same shape the project row above uses, and
   * for the same reason: a button inside a button is not valid markup, and
   * opening a session and putting it away genuinely are two targets.
   */
  return (
    <div className={`session-row${selected ? ' selected' : ''}${shortcut ? ' has-shortcut' : ''}`}>
      <button className="open" type="button" onClick={onOpen}>
        {/*
          The line fades as one piece, not the name inside it. A fade on the
          name alone landed wherever that name ended — short of the provider's
          mark — while the activity line under it faded at the edge of the
          row, so one row had two different boundaries. Resting here now
          scrolls the whole line, which is also how the mark comes back into
          view on a title too long to hold it.
        */}
        <Fading className="line" reveal title={sessionTitle(session)}>
          <span className={`dot ${session.status}`} aria-hidden />
          <span className="label">{sessionTitle(session)}</span>
          <span className="provider">
            <ProviderGlyph provider={session.provider} size={13} />
          </span>
        </Fading>
        <Fading className="activity">{activity}</Fading>
        {shortcut ? (
          <span className="session-shortcut" aria-hidden>
            <span className="cmd">⌘</span>
            {shortcut}
          </span>
        ) : null}
      </button>
      {onArchive && (
        <button
          className="hide"
          type="button"
          aria-label={`Put ${sessionTitle(session)} away`}
          title="Put away"
          onClick={onArchive}
        >
          <ArchiveIcon />
        </button>
      )}
    </div>
  );
}

function useUserProfile(): UserProfile {
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_USER_PROFILE);
  useEffect(() => {
    void window.vowe.getUserProfile().then(setProfile).catch(() => undefined);
  }, []);
  return profile;
}

const initialOf = (name: string): string => name.trim().charAt(0).toUpperCase() || 'Y';
