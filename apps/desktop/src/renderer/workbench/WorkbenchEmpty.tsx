import type { ReactElement } from 'react';

import type { ContextRef } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { PlusIcon } from '../shell/icons.js';
import { quickOpen, type LauncherEntry } from '../state/object-launcher.js';

interface Props {
  entries: LauncherEntry[];
  onOpen: (ref: ContextRef) => void;
  onOpenLauncher: () => void;
}

/**
 * Opened with nothing on it, which is a state worth having.
 *
 * The desk is where attention is, and "show me what we are looking at" is a
 * reasonable thing to ask before there is anything to see. It answers honestly
 * rather than refusing to open.
 *
 * What it does *not* do is explain the product. A few real things to open and
 * the way to find more — no illustration, and no list of what Vowe can do,
 * because the panel is for objects and a list of capabilities would be the
 * first thing to teach otherwise.
 */
export function WorkbenchEmpty({ entries, onOpen, onOpenLauncher }: Props): ReactElement {
  const quick = quickOpen(entries);

  return (
    <div className="artifact workbench-empty">
      <p className="empty">Nothing open yet.</p>
      {quick.length > 0 && (
        <div className="quick-open">
          {quick.map((entry) => (
            <button
              className="launcher-entry"
              type="button"
              key={entry.id}
              onClick={() => onOpen(entry.ref)}
            >
              <Fading className="label">{entry.label}</Fading>
              {entry.detail && <Fading className="detail">{entry.detail}</Fading>}
            </button>
          ))}
        </div>
      )}
      <button className="small-button" type="button" onClick={onOpenLauncher}>
        <PlusIcon />
        Open something…
      </button>
    </div>
  );
}
