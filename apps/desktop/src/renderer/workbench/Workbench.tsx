import type { ReactElement } from 'react';

import type { WorkbenchArtifact } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { PinIcon, PlusIcon } from '../shell/icons.js';
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
  onAttach: (artifact: WorkbenchArtifact) => void;
}

/**
 * What Vowe and the developer are looking at.
 *
 * One primary artifact with the rest on the desk beneath it. Viewing is not
 * attaching: this is where attention is, and what a question carries is said
 * explicitly in the composer.
 *
 * Closing is not in this header. One control, fixed to the window, opens and
 * closes the desk in both states — a control that travelled with the panel
 * edge was never where it had last been clicked, and a second control for the
 * closed state meant two glyphs for one act. The header's right inset keeps
 * its own content clear of it.
 */
export function Workbench({
  state,
  full,
  onActivate,
  onTogglePin,
  onAttach,
}: Props): ReactElement {
  const artifact = activeArtifact(state);

  /*
   * Opened with nothing on it, which is a state worth having.
   *
   * The desk is where attention is, and "show me what we are looking at" is a
   * reasonable thing to ask before there is anything to see. It answers
   * honestly rather than refusing to open — and the panel existing is not a
   * claim that Vowe has put something in it.
   */
  if (!artifact) {
    return (
      <aside className={`workbench${full ? ' full' : ''}`} aria-label="Workbench">
        <div className="workbench-header">
          <div className="titles">
            <Fading className="title">Nothing on the desk</Fading>
            <span className="kind">Workbench</span>
          </div>
        </div>
        <div className="workbench-body">
          <div className="artifact">
            <p className="empty">
              This is what you and Vowe are looking at. Open a file, a diff or
              something Vowe checked, and it appears here.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const pinned = state.pinnedId === artifact.id;

  return (
    <aside className={`workbench${full ? ' full' : ''}`} aria-label="Workbench">
      <div className="workbench-header">
        <div className="titles">
          <Fading className="title">{artifact.title}</Fading>
          <span className="kind">{artifact.subtitle ?? kindLabel(artifact.kind)}</span>
          {/*
            Why this is in front of you, where that is actually known. Said in
            the product's terms and never guessed: an artifact opened by hand
            carries no reason, because the reason was that you opened it.
          */}
          {state.reason && <span className="because">{state.reason}</span>}
        </div>
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
      return (
        <NarrativeArtifact
          content={artifact.content}
          kind={artifact.kind}
          sourceRef={artifact.sourceRef}
          {...(artifact.focus ? { focus: artifact.focus } : {})}
        />
      );
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
