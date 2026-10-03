import { useState, type ReactElement, type ReactNode } from 'react';

import type { Project, ProjectBrief } from '@vowe/core';

import { messageOf, tildePath } from '../components/ui.js';
import { Fading } from '../shell/Fading.js';
import { CloseIcon, FolderIcon, PlusIcon } from '../shell/icons.js';
import { fleetSummary, ipcMessage, type StatusTone } from '../state/project-fleet.js';

interface Props {
  project: Project;
  brief: ProjectBrief | null;
  onOpenFleet: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenConversation: () => void;
  onOpenStudio: () => void;
}

/**
 * A project's home: the folders it covers, and how its fleet is doing.
 *
 * Folders are added and removed here, by hand. The root is the one the
 * project's identity comes from, so it stays.
 */
export function ProjectHome({
  project,
  brief,
  onOpenFleet,
  onOpenSession,
  onOpenConversation,
  onOpenStudio,
}: Props): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fleet = fleetSummary(brief);

  const change = async (act: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
    } catch (cause) {
      setError(ipcMessage(messageOf(cause)));
    } finally {
      setBusy(false);
    }
  };

  const addFolder = async () => {
    const chosen = await window.vowe.chooseFolder().catch(() => null);
    if (chosen) await change(() => window.vowe.addProjectFolder(project.id, chosen));
  };

  return (
    <div className="board scroll">
      <div className="board-inner">
        <section className="card">
          <header className="card-head">
            <h2 className="caps">Folders in this project</h2>
            <button className="button small" type="button" disabled={busy} onClick={() => void addFolder()}>
              <PlusIcon />
              Add a folder
            </button>
          </header>
          <div className="card-body folder-list">
            {project.folders.map((folder) => (
              <div className="folder-row" key={folder.path}>
                <span className={`folder-glyph${folder.isDefault ? ' lit' : ''}`}><FolderIcon /></span>
                <Fading className="mono-line" title={folder.path}>{tildePath(folder.path)}</Fading>
                {folder.isDefault ? (
                  <span className="flat-chip">Root</span>
                ) : (
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Remove ${tildePath(folder.path)}`}
                    title="Remove folder"
                    disabled={busy}
                    onClick={() => void change(() => window.vowe.removeProjectFolder(project.id, folder.path))}
                  >
                    <CloseIcon size={14} />
                  </button>
                )}
              </div>
            ))}
            {error && <p className="sheet-error">{error}</p>}
          </div>
        </section>

        <div className="board-split">
          <section className="card grow">
            <header className="card-head">
              <h2 className="caps">Fleet</h2>
              <button className="link-button tint" type="button" onClick={onOpenFleet}>Open Fleet</button>
            </header>
            <div className="card-body stats">
              <Stat tone="ask" value={fleet.running} label="Running" />
              <Stat tone="attention" value={fleet.needsYou} label="Needs you" />
              <Stat tone="good" value={fleet.done} label="Done" />
            </div>
            <div className="line-list">
              {fleet.rows.map((row) => (
                <button className="line-row" type="button" key={row.sessionId} onClick={() => onOpenSession(row.sessionId)}>
                  <span className={`dot lg ${row.tone}`} aria-hidden />
                  <Fading className="line-title">{row.title}</Fading>
                  <span className={`status-word ${row.tone}`}>{row.word}</span>
                </button>
              ))}
              {brief && fleet.rows.length === 0 && <p className="empty line-empty">No agents running.</p>}
            </div>
          </section>

          <aside className="card side">
            <header className="card-head bare">
              <h2 className="caps">Jump to</h2>
            </header>
            <nav className="jump-list">
              <Jump label="Panes" onClick={onOpenFleet} />
              <Jump label="Compare attempts" onClick={onOpenFleet} />
              <Jump label="Questions" onClick={onOpenFleet} count={fleet.needsYou || null} />
              <Jump label="Conversation" onClick={onOpenConversation} />
              <Jump label="Studio" onClick={onOpenStudio} />
            </nav>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Stat({ tone, value, label }: { tone: StatusTone; value: number; label: string }): ReactElement {
  return (
    <div className="stat">
      <span className="stat-figure">
        <span className={`stat-number ${tone}`}>{value}</span>
        <span className={`dot lg ${tone}`} aria-hidden />
      </span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function Jump({ label, onClick, count }: { label: string; onClick: () => void; count?: ReactNode }): ReactElement {
  return (
    <button className="jump-row" type="button" onClick={onClick}>
      <span className="jump-label">{label}</span>
      {count ? <span className="jump-count">{count}</span> : null}
    </button>
  );
}
