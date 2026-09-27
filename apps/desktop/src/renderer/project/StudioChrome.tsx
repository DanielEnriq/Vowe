import type { ReactElement } from 'react';

import type { DesignSummary } from '@vowe/core';

import { DesignSwitcher, usePopover } from './DesignBrowser.js';

/**
 * The design, named at the top of the canvas. The project is quiet context
 * beside it and never a way out — Back on the window band is the one way out
 * of Studio. The title opens the designs of this project and nothing else:
 * not projects, not sessions.
 */
export function StudioTitle({
  projectName, title, designs, activeId, onSelect, onNew,
}: {
  projectName: string;
  title: string;
  designs: readonly DesignSummary[];
  activeId: string | null;
  onSelect: (designId: string) => void;
  onNew: (() => void) | null;
}): ReactElement {
  return (
    <div className="studio-title">
      <span className="studio-title-project">{projectName}</span>
      <span className="studio-title-sep" aria-hidden="true">/</span>
      <DesignSwitcher designs={designs} activeId={activeId} title={title} heading={`Designs in ${projectName}`} onSelect={onSelect} onNew={onNew} />
    </div>
  );
}

export interface StudioMenuItem {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function StudioMenu({ items }: { items: StudioMenuItem[] }): ReactElement {
  const [open, setOpen, box] = usePopover();
  return (
    <div className="studio-menu" ref={box}>
      <button type="button" className="studio-menu-button" aria-label="Design options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.5" cy="8" r="1.25" /></svg>
      </button>
      {open && (
        <div className="studio-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitemcheckbox"
              aria-checked={item.active ?? false}
              className={`studio-menu-item${item.active ? ' active' : ''}`}
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
