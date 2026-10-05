import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { Project } from '@vowe/core';
import { folderName } from '@vowe/core/projections';

import { messageOf, tildePath } from '../components/ui.js';
import { CloseIcon, FolderIcon, PlusIcon } from '../shell/icons.js';
import { ipcMessage } from '../state/project-fleet.js';

interface Props {
  onCreated: (project: Project) => void;
  onClose: () => void;
}

/**
 * A name and a folder. Further folders are possible, never automatic: each one
 * is chosen here by hand.
 */
export function NewProjectSheet({ onCreated, onClose }: Props): ReactElement {
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [extras, setExtras] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInput.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = async (): Promise<string | null> => window.vowe.chooseFolder().catch(() => null);

  const chooseMain = async () => {
    const chosen = await choose();
    if (!chosen) return;
    setFolder(chosen);
    setError(null);
    // The folder names the project until somebody types a name of their own.
    if (!named) setName(folderName(chosen));
  };

  const addExtra = async () => {
    const chosen = await choose();
    if (!chosen || chosen === folder || extras.includes(chosen)) return;
    setExtras((current) => [...current, chosen]);
    setError(null);
  };

  const create = async () => {
    if (!folder || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await window.vowe.createProject({ name: name.trim(), folder, folders: extras }));
    } catch (cause) {
      setError(ipcMessage(messageOf(cause)));
      setBusy(false);
    }
  };

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="sheet sectioned"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="sheet-head">
          <h2 id="new-project-title">New project</h2>
          <button className="icon-button outlined" type="button" aria-label="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="sheet-body">
          <div className="sheet-field">
            <label htmlFor="np-name">Name</label>
            <input
              id="np-name"
              ref={nameInput}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNamed(true);
              }}
            />
          </div>

          <div className="sheet-field">
            <span className="sheet-label">Folder</span>
            <div className="folder-field">
              <span className="folder-glyph"><FolderIcon /></span>
              <span className="mono-line">{folder ? tildePath(folder) : ''}</span>
              <button className="button raised" type="button" onClick={() => void chooseMain()}>
                Choose…
              </button>
            </div>
            {extras.map((extra) => (
              <div className="folder-field" key={extra}>
                <span className="folder-glyph"><FolderIcon /></span>
                <span className="mono-line">{tildePath(extra)}</span>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove ${tildePath(extra)}`}
                  onClick={() => setExtras((current) => current.filter((item) => item !== extra))}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            ))}
            <button
              className="quiet-add"
              type="button"
              disabled={!folder}
              onClick={() => void addExtra()}
            >
              <PlusIcon />
              Add another folder
            </button>
          </div>

          {error && <p className="sheet-error">{error}</p>}
        </div>

        <div className="sheet-foot">
          <button type="button" className="link-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button solid" disabled={busy || !folder || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
