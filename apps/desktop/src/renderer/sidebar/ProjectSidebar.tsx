import { useEffect, useState, type ReactElement } from 'react';

import type { AgentSession, PresenceProfile, PresenceState, Project, UserProfile } from '@vowe/core';
import { DEFAULT_USER_PROFILE } from '@vowe/core/projections';

import { Fading } from '../shell/Fading.js';
import { VowePresence } from '../presence/index.js';
import { ArchiveIcon, FolderIcon, RepoIcon, SearchIcon, SettingsIcon } from '../shell/icons.js';
import { SessionFinder } from './SessionFinder.js';
import { currentSessions } from '../state/session-visibility.js';
import {
  activeCount,
  sessionsForProject,
  type Route,
} from '../state/navigation.js';
import { providerName, statusLabel } from '../components/ui.js';
import { sessionActivity, sessionTitle } from '@vowe/core/projections';

interface Props {
  projects: Project[];
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
  onNavigate: (route: Route) => void;
}

/**
 * Projects are the durable parents of sessions, so they are the spine here.
 *
 * Arbitrary numbers of both: nothing is hardcoded, nothing is capped, and a
 * repository with one session looks like a repository with nine.
 */
export function ProjectSidebar({
  projects,
  sessions,
  route,
  expandedProjectIds,
  onToggleExpanded,
  presence,
  presenceState,
  onNavigate,
}: Props): ReactElement {
  const user = useUserProfile();
  const openSessionId = route.kind === 'session' ? route.sessionId : null;
  /*
   * One clock for the whole panel, read once per render.
   *
   * Every row asks whether its sessions are recent, and rows that each called
   * `Date.now()` could disagree about where the week ends — a session could
   * be recent in one block and old in the next within the same paint.
   */
  const now = Date.now();
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
      </div>

      <nav className="sidebar-nav">
        {projects.length === 0 && unplaced.length === 0 && (
          <p className="empty" style={{ padding: '10px 8px' }}>
            No coding sessions yet. Start one in any terminal and it appears here.
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
            onArchive={archive}
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
  onArchive,
}: {
  project: Project;
  sessions: AgentSession[];
  route: Route;
  expanded: boolean;
  now: number;
  openSessionId: string | null;
  onNavigate: (route: Route) => void;
  onToggleExpanded: () => void;
  onArchive: (sessionId: string, archived: boolean) => void;
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
          {live > 0 && <span className="count">{live}</span>}
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
      </div>

      {expanded && own.length > 0 && (
        <div className="session-list">
          {own.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={route.kind === 'session' && route.sessionId === session.id}
              onOpen={() => onNavigate({ kind: 'session', sessionId: session.id })}
              onArchive={() => onArchive(session.id, true)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SessionRow({
  session,
  selected,
  onOpen,
  onArchive,
}: {
  session: AgentSession;
  selected: boolean;
  onOpen: () => void;
  onArchive?: (() => void) | undefined;
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
    <div className={`session-row${selected ? ' selected' : ''}`}>
      <button className="open" type="button" onClick={onOpen}>
        {/*
          The line fades as one piece, not the name inside it. A fade on the
          name alone landed wherever that name ended — short of the provider's
          initials — while the activity line under it faded at the edge of the
          row, so one row had two different boundaries. Resting here now
          scrolls the whole line, which is also how the initials come back
          into view on a title too long to hold them.
        */}
        <Fading className="line" reveal title={sessionTitle(session)}>
          <span className={`dot ${session.status}`} aria-hidden />
          <span className="label">{sessionTitle(session)}</span>
          <span className="provider">{initialsOf(providerName(session.provider))}</span>
        </Fading>
        <Fading className="activity">{activity}</Fading>
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

/** `Claude Code` → `CC`, as the design abbreviates a provider in a tight row. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export const __testables = { initialsOf };
