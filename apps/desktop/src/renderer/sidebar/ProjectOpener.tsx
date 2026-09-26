import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { AgentSession, Project } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { formatAgoShort } from '../components/ui.js';
import { FolderIcon } from '../shell/icons.js';
import {
  closedProjects,
  lastActivityByProject,
  looksLikePath,
} from '../state/project-visibility.js';

interface Props {
  projects: Project[];
  sessions: AgentSession[];
  now: number;
  /** Called with the project once it is open, so the room can follow. */
  onOpened: (projectId: string) => void;
  onDismiss: () => void;
}

/**
 * Opening a project, from the `+` beside the panel's heading.
 *
 * One field, three ways in: a project Vowe has already seen work in, a path
 * typed or pasted into the same field, or a folder chosen natively. The last
 * two resolve to the repository the folder is part of, the same way sessions
 * are grouped — so opening a subdirectory lands on its project.
 *
 * Closing is not here. It belongs to the project's row, where the thing being
 * put away is in front of you.
 */
export function ProjectOpener({
  projects,
  sessions,
  now,
  onOpened,
  onDismiss,
}: Props): ReactElement {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [onDismiss]);

  const isPath = looksLikePath(query);
  const found = isPath ? [] : closedProjects(projects, sessions, query);
  const latest = lastActivityByProject(sessions);

  const openProject = (projectId: string) => {
    void window.vowe.setProjectOpen(projectId, true).catch(() => undefined);
    onOpened(projectId);
    onDismiss();
  };

  const openFolder = async (directory: string | null) => {
    if (!directory) return;
    setBusy(true);
    setError(null);
    try {
      const project = await window.vowe.openProjectAt(directory);
      onOpened(project.id);
      onDismiss();
    } catch (reason) {
      // Electron wraps a handler's rejection; the part worth reading is ours.
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="menu finder project-opener"
      role="dialog"
      aria-label="Open a project"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onDismiss();
      }}
    >
      <input
        className="launcher-field"
        ref={field}
        value={query}
        placeholder="Find a project, or paste a path…"
        aria-label="Find a project, or paste a path"
        disabled={busy}
        onChange={(event) => {
          setQuery(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (isPath) void openFolder(query);
          else if (found[0]) openProject(found[0].id);
        }}
      />
      <div className="launcher-list" role="listbox" aria-label="Projects">
        {isPath && (
          <div className="finder-row" role="option" aria-selected={false}>
            <button
              className="finder-open"
              type="button"
              disabled={busy}
              onClick={() => void openFolder(query)}
            >
              <span className="line">
                <FolderIcon />
                <Fading className="label" reveal>
                  {`Open ${query.trim()}`}
                </Fading>
              </span>
            </button>
          </div>
        )}
        {found.map((project) => {
          const at = latest.get(project.id);
          return (
            <div className="finder-row" key={project.id} role="option" aria-selected={false}>
              <button
                className="finder-open"
                type="button"
                onClick={() => openProject(project.id)}
              >
                <span className="line">
                  <Fading className="label" reveal>
                    {project.name}
                  </Fading>
                  {at !== undefined && (
                    <span className="when">{formatAgoShort(new Date(at).toISOString(), now)}</span>
                  )}
                </span>
                <Fading className="why">{project.repoRoot}</Fading>
              </button>
            </div>
          );
        })}
        {!isPath && !found.length && (
          <p className="empty">
            {query.trim()
              ? `No closed project matching “${query.trim()}”.`
              : 'Every project Vowe has seen is open.'}
          </p>
        )}
        {error && <p className="empty error">{error}</p>}
      </div>
      <button
        className="opener-folder"
        type="button"
        disabled={busy}
        onClick={() =>
          void window.vowe
            .chooseFolder()
            .then(openFolder)
            .catch(() => undefined)
        }
      >
        <FolderIcon />
        Open folder…
      </button>
    </div>
  );
}
