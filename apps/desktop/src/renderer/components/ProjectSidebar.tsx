import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import type { AgentSession, Project } from '@vowe/core';
import type { AppStatus } from '../../shared/ipc.js';

import {
  ChevronIcon,
  PlusIcon,
  groupByProject,
  isLive,
  providerName,
  statusLabel,
  type ProjectGroup,
} from './ui.js';

export type Selection =
  | { kind: 'none' }
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string };

interface Props {
  projects: Project[];
  sessions: AgentSession[];
  selection: Selection;
  status: AppStatus | null;
  onSelect: (selection: Selection) => void;
  onNewSession: () => void;
}

const EXPANDED_KEY = 'vowe.sidebar.expanded';

/**
 * Projects first, the work inside them second.
 *
 * The old flat Live/Earlier list answered "is anything running?". This answers
 * "what is happening, and where?" — which is the question once several agents
 * work in one repository while others work elsewhere.
 *
 * Provider names, session ids, attach modes and observe-only badges are
 * deliberately absent here. They are diagnostic, not navigational, and they
 * live on the session screen.
 */
export function ProjectSidebar({
  projects,
  sessions,
  selection,
  status,
  onSelect,
  onNewSession,
}: Props): ReactElement {
  const { groups, unplaced } = useMemo(
    () => groupByProject(projects, sessions),
    [projects, sessions],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => restoreExpanded());
  const [touched, setTouched] = useState<Set<string>>(() => new Set());

  // Projects with work in them open themselves, once. After the developer has
  // collapsed one, their choice stands.
  useEffect(() => {
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      for (const group of groups) {
        if (group.working.length > 0 && !touched.has(group.project.id) && !next.has(group.project.id)) {
          next.add(group.project.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [groups, touched]);

  const toggle = useCallback((projectId: string) => {
    setTouched((current) => new Set(current).add(projectId));
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      persistExpanded(next);
      return next;
    });
  }, []);

  const watching = status?.providers.map(providerName).join(', ');

  return (
    <aside className="sidebar">
      <div className="sidebar-top titlebar-drag" />
      <div className="sidebar-heading">
        <h1>Projects</h1>
        <button
          className="icon-btn"
          aria-label="New task"
          title="New task"
          onClick={onNewSession}
        >
          <PlusIcon />
        </button>
      </div>

      <nav className="session-list" aria-label="Projects">
        {groups.length === 0 && unplaced.length === 0 && (
          <p className="sidebar-empty">Nothing yet</p>
        )}

        {groups.map((group) => (
          <ProjectBlock
            key={group.project.id}
            group={group}
            open={expanded.has(group.project.id)}
            selection={selection}
            onToggle={toggle}
            onSelect={onSelect}
          />
        ))}

        {unplaced.length > 0 && (
          <>
            {/* Never dropped: a session Vowe could not place is still work. */}
            <div className="group-label">No project</div>
            {unplaced.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={
                  selection.kind === 'session' && selection.sessionId === session.id
                }
                onSelect={onSelect}
              />
            ))}
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        <span>{watching ? `Watching ${watching}` : 'Starting…'}</span>
        {status && (
          <span className="sub">
            {status.llmConfigured
              ? 'Interpretation by model'
              : 'Interpretation off · no API key'}
          </span>
        )}
      </div>
    </aside>
  );
}

function ProjectBlock({
  group,
  open,
  selection,
  onToggle,
  onSelect,
}: {
  group: ProjectGroup;
  open: boolean;
  selection: Selection;
  onToggle: (projectId: string) => void;
  onSelect: (selection: Selection) => void;
}): ReactElement {
  const { project, working, recent } = group;
  const selected = selection.kind === 'project' && selection.projectId === project.id;

  return (
    <div className="project-block">
      <div className={`project-row${selected ? ' selected' : ''}`}>
        <button
          className="twisty"
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
          onClick={() => onToggle(project.id)}
        >
          <ChevronIcon open={open} />
        </button>
        {/* Selecting a project opens the project, never its first session. */}
        <button
          className="project-name"
          aria-current={selected ? 'true' : undefined}
          onClick={() => onSelect({ kind: 'project', projectId: project.id })}
        >
          <span className="label">{project.name}</span>
          {working.length > 0 && <span className="count">{working.length}</span>}
        </button>
      </div>

      {open && (
        <div className="project-children">
          {working.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={
                selection.kind === 'session' && selection.sessionId === session.id
              }
              onSelect={onSelect}
            />
          ))}
          {recent.length > 0 && working.length > 0 && (
            <div className="group-label nested">Recent</div>
          )}
          {recent.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={
                selection.kind === 'session' && selection.sessionId === session.id
              }
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: AgentSession;
  selected: boolean;
  onSelect: (selection: Selection) => void;
}): ReactElement {
  return (
    <button
      className={`session-row${selected ? ' selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect({ kind: 'session', sessionId: session.id })}
    >
      <span className="line1">
        <span className={`dot ${session.status}`} />
        <span className="label">{session.displayLabel}</span>
      </span>
      <span className="activity">
        {isLive(session)
          ? (session.semanticState?.currentActivity ?? statusLabel(session.status))
          : statusLabel(session.status)}
      </span>
    </button>
  );
}

/* Expansion is a convenience, so it is stored where conveniences belong. */

function restoreExpanded(): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistExpanded(expanded: Set<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    // Private browsing, blocked storage: the sidebar just forgets. Fine.
  }
}
