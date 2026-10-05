import { useEffect, useMemo, useState, type ReactElement } from 'react';

import type { AgentSession, Project } from '@vowe/core';

import { useFleetLayout, useFleetStatuses } from '../hooks/useVoweData.js';
import { Fading } from '../shell/Fading.js';
import { PlusIcon, RepoIcon } from '../shell/icons.js';
import { statusLook } from '../state/fleet-views.js';
import type { AppMode } from '../state/mode.js';
import { fleetAgentRoute, fleetRoute, type Route } from '../state/navigation.js';
import { panelMembers, projectLine } from '../state/project-fleet.js';

/** Which app the window is. Sits above either panel. */
export function ModeSwitch({ mode, onMode }: { mode: AppMode; onMode: (mode: AppMode) => void }): ReactElement {
  return (
    <div className="fm-mode">
      <div className="segmented fm-switch" role="tablist" aria-label="Mode">
        {(['vowe', 'fleet'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={mode === item}
            className={mode === item ? 'on' : undefined}
            onClick={() => onMode(item)}
          >
            {item === 'vowe' ? 'Vowe' : 'Fleet'}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  projects: Project[];
  sessions: AgentSession[];
  route: Route;
  onNavigate: (route: Route) => void;
  onNewProject: () => void;
}

/** Fleet's panel: projects, and the captains and agents each one runs. */
export function FleetSidebar({ projects, sessions, route, onNavigate, onNewProject }: Props): ReactElement {
  const routeProject = route.kind === 'fleet' || route.kind === 'fleet-agent' ? route.projectId : null;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(routeProject ? [routeProject] : []));
  useEffect(() => {
    if (!routeProject) return;
    setExpanded((current) => (current.has(routeProject) ? current : new Set([...current, routeProject])));
  }, [routeProject]);
  const toggle = (projectId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });

  return (
    <>
      <div className="sidebar-title">
        <span className="eyebrow">Projects</span>
        <button
          className="icon-button add"
          type="button"
          aria-label="New project"
          title="New project"
          onClick={onNewProject}
        >
          <PlusIcon />
        </button>
      </div>
      <nav className="sidebar-nav">
        {projects.length === 0 && <p className="empty fm-empty">No projects yet. Use + to make one.</p>}
        {projects.map((project) => (
          <FleetProjectBlock
            key={project.id}
            project={project}
            sessions={sessions}
            route={route}
            expanded={expanded.has(project.id)}
            onToggle={() => toggle(project.id)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </>
  );
}

function FleetProjectBlock({
  project,
  sessions,
  route,
  expanded,
  onToggle,
  onNavigate,
}: {
  project: Project;
  sessions: AgentSession[];
  route: Route;
  expanded: boolean;
  onToggle: () => void;
  onNavigate: (route: Route) => void;
}): ReactElement {
  const { layout } = useFleetLayout(project.id);
  const members = useMemo(() => panelMembers(layout, sessions), [layout, sessions]);
  const ids = useMemo(() => (expanded ? members.map((member) => member.sessionId).sort() : []), [expanded, members]);
  const statuses = useFleetStatuses(ids);
  const selected = route.kind === 'fleet' && route.projectId === project.id;
  const openSessionId = route.kind === 'fleet-agent' && route.projectId === project.id ? route.sessionId : null;

  return (
    <>
      <div className={`project-row${selected ? ' selected' : ''}`}>
        <button
          className={`disclose${expanded ? ' expanded' : ''}`}
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide agents in ${project.name}` : `Show agents in ${project.name}`}
          title={expanded ? 'Hide agents' : 'Show agents'}
          disabled={members.length === 0}
          onClick={onToggle}
        >
          <RepoIcon />
        </button>
        <button className="open fm-open" type="button" onClick={() => onNavigate(fleetRoute(project.id))}>
          <Fading className="name">{project.name}</Fading>
          <Fading className="fm-sub">{projectLine(members.length, project.folders.length)}</Fading>
        </button>
      </div>
      {expanded && members.length > 0 && (
        <div className="fm-members">
          {members.map((member) => {
            const look = statusLook(statuses[member.sessionId]);
            return (
              <button
                key={member.sessionId}
                type="button"
                className={`fm-member${openSessionId === member.sessionId ? ' selected' : ''}`}
                onClick={() => onNavigate(fleetAgentRoute(project.id, member.sessionId))}
              >
                {member.role === 'captain' && member.label !== 'Captain' && <span className="fm-role">Captain</span>}
                <Fading className="fm-member-name">{member.label}</Fading>
                <span className="fm-member-status">
                  <span className={`dot ${look.tone}`} aria-hidden />
                  <span className={`status-word ${look.tone}`}>{look.word}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
