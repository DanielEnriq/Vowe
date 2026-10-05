import type { ReactElement } from 'react';

import type { Project } from '@vowe/core';

import { tildePath } from '../components/ui.js';
import { Fading } from '../shell/Fading.js';
import { PlusIcon } from '../shell/icons.js';
import { RoomIdentity } from '../shell/TopChrome.js';

/** Fleet before a project is chosen: every project, and a way to make one. */
export function FleetHome({
  projects,
  onOpenProject,
  onNewProject,
}: {
  projects: readonly Project[];
  onOpenProject: (projectId: string) => void;
  onNewProject: () => void;
}): ReactElement {
  return (
    <main className="session-room fc-room">
      <RoomIdentity>
        <h1 className="fm-title">Fleet</h1>
        <span className="fc-band-spacer" />
        <button className="button solid compact" type="button" onClick={onNewProject}>
          <PlusIcon />New project
        </button>
      </RoomIdentity>
      <div className="fc-body">
        <div className="board scroll">
          <div className="board-inner">
            <section className="card">
              <header className="card-head">
                <h2 className="caps">Projects</h2>
              </header>
              <div className="line-list">
                {projects.map((project) => (
                  <button className="line-row" type="button" key={project.id} onClick={() => onOpenProject(project.id)}>
                    <Fading className="line-title">{project.name}</Fading>
                    <Fading className="fm-path">{tildePath(project.repoRoot)}</Fading>
                  </button>
                ))}
                {projects.length === 0 && <p className="empty line-empty">No projects yet.</p>}
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
