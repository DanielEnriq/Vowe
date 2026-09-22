import type { ReactElement } from 'react';

import type { WorkbenchArtifact } from '@vowe/core';

import { CloseIcon, PinIcon, PlusIcon } from '../shell/icons.js';
import { activeArtifact, type WorkbenchState } from '../state/workbench.js';
import { SourceArtifact } from './SourceArtifact.js';
import { DiffArtifact } from './DiffArtifact.js';
import { NarrativeArtifact } from './NarrativeArtifact.js';

interface Props {
  state: WorkbenchState;
  /** True when the pane is too narrow to hold a conversation beside this. */
  full: boolean;
  onActivate: (id: string) => void;
  onTogglePin: () => void;
  onClose: () => void;
  onAttach: (artifact: WorkbenchArtifact) => void;
}

/**
 * What Vowe and the developer are looking at.
 *
 * One primary artifact with the rest on the desk beneath it. Viewing is not
 * attaching: this is where attention is, and what a question carries is said
 * explicitly in the composer.
 */
export function Workbench({
  state,
  full,
  onActivate,
  onTogglePin,
  onClose,
  onAttach,
}: Props): ReactElement | null {
  const artifact = activeArtifact(state);
  if (!artifact) return null;

  const pinned = state.pinnedId === artifact.id;

  return (
    <aside className={`workbench${full ? ' full' : ''}`} aria-label="Workbench">
      <div className="workbench-header">
        <div className="titles">
          <span className="title">{artifact.title}</span>
          <span className="kind">{artifact.subtitle ?? kindLabel(artifact.kind)}</span>
        </div>
        <button className="icon-button" type="button" aria-label="Close workbench" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="workbench-actions">
        <button
          className={`small-button${pinned ? ' on' : ''}`}
          type="button"
          aria-pressed={pinned}
          onClick={onTogglePin}
          title={
            pinned
              ? 'Pinned: Vowe may add to the desk but will not take this view away'
              : 'Pin this so Vowe does not replace it'
          }
        >
          <PinIcon filled={pinned} />
          {pinned ? 'Pinned' : 'Pin'}
        </button>
        <button className="small-button" type="button" onClick={() => onAttach(artifact)}>
          <PlusIcon />
          Add to question
        </button>
      </div>

      <div className="workbench-body">
        <ArtifactBody artifact={artifact} />
      </div>

      {state.items.length > 1 && (
        <div className="desk">
          <span className="eyebrow" style={{ fontSize: 9.5 }}>
            On the desk
          </span>
          <div className="items">
            {state.items.map((item) => (
              <button
                className={`desk-item${item.id === artifact.id ? ' active' : ''}`}
                type="button"
                key={item.id}
                onClick={() => onActivate(item.id)}
              >
                {item.title}
                {state.newIds.includes(item.id) && <span className="new" aria-label="new" />}
                {state.pinnedId === item.id && <span className="pinned">pinned</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function ArtifactBody({ artifact }: { artifact: WorkbenchArtifact }): ReactElement {
  switch (artifact.content.type) {
    case 'source':
      return <SourceArtifact content={artifact.content} focus={artifact.focus} />;
    case 'diff':
      return <DiffArtifact content={artifact.content} />;
    case 'narrative':
      return <NarrativeArtifact content={artifact.content} kind={artifact.kind} />;
    case 'unavailable':
      // An expected absence, said plainly. A fault would have thrown.
      return (
        <div className="artifact">
          <p className="empty">{artifact.content.reason}</p>
        </div>
      );
  }
}

function kindLabel(kind: WorkbenchArtifact['kind']): string {
  const labels: Record<WorkbenchArtifact['kind'], string> = {
    source: 'Source',
    diff: 'Diff',
    worker_activity: 'Worker activity',
    transcript: 'Transcript',
    project_memory: 'Project memory',
  };
  return labels[kind];
}
