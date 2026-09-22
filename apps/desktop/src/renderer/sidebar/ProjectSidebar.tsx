import { useEffect, useState, type ReactElement } from 'react';

import type { AgentSession, PresenceProfile, PresenceState, Project, UserProfile } from '@vowe/core';
import { DEFAULT_USER_PROFILE } from '@vowe/core/projections';

import { Fading } from '../shell/Fading.js';
import { VowePresence } from '../presence/index.js';
import { ComposeIcon, FolderIcon, RepoIcon, SettingsIcon } from '../shell/icons.js';
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
  onNewTask: () => void;
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
  onNewTask,
}: Props): ReactElement {
  const user = useUserProfile();
  const unplaced = sessions.filter((session) => session.projectId === null);

  return (
    <>
      {/*
        The panel's own header, clear of the window's chrome.

        Collapsing is not here. That control belongs to the window — it has to
        exist whether or not this panel does, and a control that moved with the
        edge it closes was never where it had last been clicked. The row's left
        inset is what keeps this content out from under it.
      */}
      <div className="sidebar-title">
        <span className="eyebrow">Projects</span>
        <span style={{ flex: 1 }} />
        <button
          className="icon-button"
          type="button"
          aria-label="New task"
          title="New task"
          onClick={onNewTask}
        >
          <ComposeIcon />
        </button>
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
            onNavigate={onNavigate}
            onToggleExpanded={() => onToggleExpanded(project.id)}
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
  onNavigate,
  onToggleExpanded,
}: {
  project: Project;
  sessions: AgentSession[];
  route: Route;
  expanded: boolean;
  onNavigate: (route: Route) => void;
  onToggleExpanded: () => void;
}): ReactElement {
  const own = sessionsForProject(project.id, sessions);
  const live = activeCount(project.id, sessions);

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
      </div>

      {expanded && own.length > 0 && (
        <div className="session-list">
          {own.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={route.kind === 'session' && route.sessionId === session.id}
              onOpen={() => onNavigate({ kind: 'session', sessionId: session.id })}
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
}: {
  session: AgentSession;
  selected: boolean;
  onOpen: () => void;
}): ReactElement {
  // The activity line is the interpreter's, not a guess: when nothing has been
  // interpreted yet it says the status rather than inventing a description.
  const activity = sessionActivity(session) ?? statusLabel(session.status);

  return (
    <button
      className={`session-row${selected ? ' selected' : ''}`}
      type="button"
      onClick={onOpen}
    >
      <span className="line">
        <span className={`dot ${session.status}`} aria-hidden />
        <Fading className="label">{sessionTitle(session)}</Fading>
        <span className="provider">{initialsOf(providerName(session.provider))}</span>
      </span>
      <Fading className="activity">{activity}</Fading>
    </button>
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
