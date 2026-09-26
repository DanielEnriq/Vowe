import type { ReactElement } from 'react';

import type { ContextRef, DesignRevision } from '@vowe/core';

import { formatAgo } from '../components/ui.js';
import { revisionLine, type DesignPaneView } from '../state/studio.js';
import { Markdown } from '../workbench/Markdown.js';

interface Props {
  pane: DesignPaneView;
  revisions: readonly DesignRevision[];
  onView: (ord: number | null) => void;
  onOpenRef: (ref: ContextRef) => void;
}

/**
 * The living design: the document Vowe keeps while the developer thinks.
 *
 * The primary object beside the conversation, so it is a document and nothing
 * else — no cards, no fields, no diagram of the ontology. A quiet line says
 * which revision this is and, more importantly, why it changed; history is one
 * control away and never in the way. While Vowe is rewriting it, the new text
 * arrives here as it is written, and its citations stay inert until the turn
 * commits and the store has checked them.
 */
export function DesignPane({ pane, revisions, onView, onOpenRef }: Props): ReactElement {
  return (
    <aside className="design-pane" aria-label="Living design">
      <div className="design-scroll">
        <div className="design-measure">
          <DesignHeader pane={pane} revisions={revisions} onView={onView} />
          {pane.mode === 'empty' ? (
            <p className="design-empty">Nothing drafted yet. The design takes shape here as you talk.</p>
          ) : (
            <div className={`design-document${pane.mode === 'streaming' ? ' streaming' : ''}${pane.mode === 'historical' ? ' historical' : ''}`}>
              <Markdown
                text={pane.mode === 'streaming' ? pane.document : pane.revision.document}
                onOpenRef={onOpenRef}
                committed={pane.mode !== 'streaming'}
              />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function DesignHeader({
  pane,
  revisions,
  onView,
}: {
  pane: DesignPaneView;
  revisions: readonly DesignRevision[];
  onView: (ord: number | null) => void;
}): ReactElement | null {
  if (pane.mode === 'empty') return <div className="design-kicker"><span>Living design</span></div>;

  const shown = pane.mode === 'streaming' ? null : pane.revision;
  return (
    <header className="design-header">
      <div className="design-kicker">
        <span>Living design</span>
        {pane.mode === 'streaming' ? (
          <span className="design-state revising" role="status">Revising…</span>
        ) : (
          <span className="design-state">
            {pane.mode === 'historical' ? 'Earlier · ' : ''}
            {revisionLine(pane.revision, pane.total)} · {formatAgo(pane.revision.at)}
          </span>
        )}
        {revisions.length > 1 && pane.mode !== 'streaming' && (
          <select
            className="design-history"
            aria-label="Design history"
            value={pane.mode === 'historical' ? String(pane.revision.ord) : ''}
            onChange={(event) => onView(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">History · {revisions.length}</option>
            {[...revisions].reverse().map((revision) => (
              <option key={revision.id} value={String(revision.ord)}>
                {revision.ord}. {revision.summary.slice(0, 90)}
              </option>
            ))}
          </select>
        )}
      </div>
      {shown?.summary && (
        <p className="design-why">
          <span className="label">Why it changed</span> {shown.summary}
        </p>
      )}
      {pane.mode === 'historical' && (
        <button className="link-button design-back" type="button" onClick={() => onView(null)}>
          Back to the current design →
        </button>
      )}
    </header>
  );
}
