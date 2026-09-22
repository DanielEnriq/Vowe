import { useEffect, useState, type ReactElement } from 'react';

import type { AgentSession, PresenceProfile, PresenceState, Project, UserProfile } from '@vowe/core';
import { DEFAULT_USER_PROFILE } from '@vowe/core/projections';

import { VowePresence } from '../presence/index.js';
import { FolderIcon, RepoIcon, SettingsIcon } from '../shell/icons.js';
import {
  activeCount,
  sessionsForProject,
  type Route,
} from '../state/navigation.js';
import { providerName, statusLabel } from '../components/ui.js';

interface Props {
  projects: Project[];
  sessions: AgentSession[];
  route: Route;
  /** The project whose sessions are shown expanded. */
  expandedProjectId: string | null;
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
  expandedProjectId,
  presence,
  presenceState,
  onNavigate,
}: Props): ReactElement {
  const user = useUserProfile();
  const unplaced = sessions.filter((session) => session.projectId === null);

  return (
    <>
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
            expanded={expandedProjectId === project.id}
            onNavigate={onNavigate}
          />
        ))}

        {unplaced.length > 0 && (
          <>
            <button className="project-row" type="button" disabled>
              <FolderIcon />
              <span className="name">No project</span>
              <span className="count">{unplaced.length}</span>
            </button>
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
          <span className="doing">
            {presence.form === 'point-cloud' ? 'point cloud' : presence.form} · {presence.material}
          </span>
        </span>
      </button>

      <div className="sidebar-footer">
        <span className="avatar" aria-hidden>
          {initialOf(user.displayName)}
        </span>
        <span className="who">{user.displayName}</span>
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
}: {
  project: Project;
  sessions: AgentSession[];
  route: Route;
  expanded: boolean;
  onNavigate: (route: Route) => void;
}): ReactElement {
  const own = sessionsForProject(project.id, sessions);
  const live = activeCount(project.id, sessions);

  return (
    <>
      <button
        className={`project-row${
          route.kind === 'project' && route.projectId === project.id ? ' selected' : ''
        }`}
        type="button"
        onClick={() => onNavigate({ kind: 'project', projectId: project.id })}
      >
        <RepoIcon />
        <span className="name">{project.name}</span>
        {live > 0 && <span className="count">{live}</span>}
      </button>

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
  const activity = session.semanticState?.currentActivity ?? statusLabel(session.status);

  return (
    <button
      className={`session-row${selected ? ' selected' : ''}`}
      type="button"
      onClick={onOpen}
    >
      <span className="line">
        <span className={`dot ${session.status}`} aria-hidden />
        <span className="label">{session.displayLabel}</span>
        <span className="provider">{initialsOf(providerName(session.provider))}</span>
      </span>
      <span className="activity">{activity}</span>
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
