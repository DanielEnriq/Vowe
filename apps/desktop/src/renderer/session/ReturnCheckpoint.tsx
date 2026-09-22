import { useState, type ReactElement } from 'react';

import type { ReturnCheckpoint as Checkpoint } from '@vowe/core';
import { checkpointNeedsDecision } from '@vowe/core/projections';

import { CloseIcon } from '../shell/icons.js';

/**
 * What changed while the developer was not looking.
 *
 * Selection, never synthesis. The design shows a written paragraph here, and
 * producing one would mean a model call and a story nobody asked for — so this
 * lists the milestones that really happened and the prose the observer really
 * wrote, and says nothing else.
 */
export function ReturnCheckpoint({ checkpoint }: { checkpoint: Checkpoint }): ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const needsDecision = checkpointNeedsDecision(checkpoint);

  return (
    <div
      className={`checkpoint${needsDecision ? ' needs-decision' : ''}`}
      style={{ margin: '22px 40px 0' }}
    >
      <div className="top">
        <span className="when">While you were away · {minutes(checkpoint.awayMs)}</span>
        <button
          className="icon-button"
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          <CloseIcon size={10} />
        </button>
      </div>

      {checkpoint.notableChanges.length > 0 && (
        <ul>
          {checkpoint.notableChanges.map((change) => (
            <li key={change.at}>{change.text}</li>
          ))}
        </ul>
      )}

      {checkpoint.milestones.length > 0 && (
        <ul>
          {checkpoint.milestones.map((milestone) => (
            <li key={milestone.id} style={{ color: 'var(--ink-5)' }}>
              {milestone.text}
            </li>
          ))}
        </ul>
      )}

      {needsDecision && (
        <p style={{ color: 'var(--ink-2)' }}>
          {checkpoint.needsAttention[0]?.summary}
        </p>
      )}
    </div>
  );
}

function minutes(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  return `${hours}h ${total % 60}m`;
}
