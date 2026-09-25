import { useState, type ReactElement } from 'react';

import type { ContextRef, WorkbenchArtifact } from '@vowe/core';

import { Fading } from '../shell/Fading.js';
import { PinIcon } from '../shell/icons.js';
import type { LauncherEntry } from '../state/object-launcher.js';
import { activeTab, type WorkbenchState } from '../state/workbench.js';
import { SourceArtifact } from './SourceArtifact.js';
import { DiffArtifact } from './DiffArtifact.js';
import { NarrativeArtifact } from './NarrativeArtifact.js';
import { WorkbenchEmpty } from './WorkbenchEmpty.js';
import { WorkbenchTabs } from './WorkbenchTabs.js';

interface Props {
  state: WorkbenchState;
  /** True when the pane is too narrow to hold a conversation beside this. */
  full: boolean;
  entries: LauncherEntry[];
  findFiles: (query: string) => Promise<LauncherEntry[]>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onKeep: (id: string) => void;
  onOpenRef: (ref: ContextRef) => void;
  onOpenSession?: (sessionId: string) => void;
}

/**
 * What Vowe and the developer are looking at.
 *
 * Tabs along the top, one artifact beneath. Viewing is not attaching: this is
 * where attention is, and what a question carries is said explicitly in the
 * composer — twenty tabs can be open without a word of it reaching Vowe.
 *
 * Closing the panel is not in this header. One control, fixed to the window,
 * opens and closes the desk in both states — a control that travelled with the
 * panel edge was never where it had last been clicked, and a second control
 * for the closed state meant two glyphs for one act. The header's right inset
 * keeps its own content clear of it.
 */
export function Workbench({
  state,
  full,
  entries,
  findFiles,
  onActivate,
  onClose,
  onKeep,
  onOpenRef,
  onOpenSession,
}: Props): ReactElement {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const tab = activeTab(state);
  const artifact = tab?.artifact ?? null;

  return (
    <aside className={`workbench${full ? ' full' : ''}`} aria-label="Workbench">
      <WorkbenchTabs
        tabs={state.tabs}
        activeId={state.activeId}
        newIds={state.newIds}
        entries={entries}
        onActivate={onActivate}
        onClose={onClose}
        onOpenRef={onOpenRef}
        findFiles={findFiles}
        launcherOpen={launcherOpen}
        onLauncherOpen={setLauncherOpen}
      />

      {/*
        What kind of thing this is, and why it is in front of you where that is
        actually known. Said in the product's terms and never guessed: an
        artifact opened by hand carries no reason, because the reason was that
        you opened it. The row is absent when it would have nothing to say.
      */}
      {artifact && (
        <div className="workbench-note">
          {/* A source artifact's subtitle is its directory, which readily
              outruns a 352px panel. Faded like every other line that can. */}
          <Fading className="kind">{artifact.subtitle ?? kindLabel(artifact.kind)}</Fading>
          {onOpenSession && 'sessionId' in artifact.sourceRef && (
            <button className="link-button" type="button" onClick={() => {
              if ('sessionId' in artifact.sourceRef) onOpenSession(artifact.sourceRef.sessionId);
            }}>Open session</button>
          )}
          {state.reason && <span className="because">{state.reason}</span>}
        </div>
      )}

      {/*
        Keeping is the whole of what pinning used to be, and the only action
        that belongs beside the artifact. It appears on Vowe's own tab alone,
        because a tab you opened is already kept.

        Attaching is said in the composer instead — "Viewing X · Add", where
        the question is being written. A second button up here was the same act
        in two places, and the one that mattered was the one next to the text.
      */}
      {tab?.status === 'preview' && (
        <div className="workbench-actions">
          <button
            className="small-button"
            type="button"
            onClick={() => onKeep(tab.id)}
            title="Keep this tab: Vowe will not replace it with the next thing it shows you"
          >
            <PinIcon filled={false} />
            Keep
          </button>
        </div>
      )}

      <div
        className="workbench-body"
        id="workbench-panel"
        role="tabpanel"
        {...(state.activeId ? { 'aria-labelledby': `tab-${state.activeId}` } : {})}
        tabIndex={0}
      >
        {tab ? (
          <ArtifactBody tab={tab} />
        ) : (
          <WorkbenchEmpty
            entries={entries}
            onOpen={onOpenRef}
            /*
              The empty state's own affordance opens the one launcher, which
              lives in the strip because that is what it hangs off.
            */
            onOpenLauncher={() => setLauncherOpen(true)}
          />
        )}
      </div>
    </aside>
  );
}

function ArtifactBody({ tab }: { tab: { artifact: WorkbenchArtifact | null; title: string } }): ReactElement {
  const artifact = tab.artifact;
  /*
   * Restored, and not read yet.
   *
   * Distinct from `unavailable`, which is the resolver saying the thing is not
   * there. This is Vowe not having looked — a tab nobody has clicked since the
   * session came back — and drawing the two the same way would turn a file
   * that exists into a file that does not.
   */
  if (!artifact) {
    return (
      <div className="artifact">
        <p className="empty">Opening {tab.title}…</p>
      </div>
    );
  }

  switch (artifact.content.type) {
    case 'source':
      return <SourceArtifact content={artifact.content} focus={artifact.focus} />;
    case 'diff':
      return <DiffArtifact content={artifact.content} />;
    case 'narrative':
      return (
        <NarrativeArtifact content={artifact.content} kind={artifact.kind} />
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
