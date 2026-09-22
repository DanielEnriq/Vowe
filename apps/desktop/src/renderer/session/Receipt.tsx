import { useState, type ReactElement } from 'react';

import type { ContextRef, InvestigationReceipt } from '@vowe/core';

import { CaretIcon } from '../shell/icons.js';

/**
 * What Vowe checked, not what it thought.
 *
 * Collapsed to one line by default, because the answer is the point and the
 * trail is the evidence. Expanding shows the retrieval actions in the order
 * they happened — never a chain of reasoning, which is a different thing and
 * not something this receipt has ever contained.
 */
export function Receipt({
  receipt,
  onOpen,
}: {
  receipt: InvestigationReceipt;
  onOpen?: (ref: ContextRef) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const count = receipt.checks.length;
  if (count === 0) return null;

  return (
    <>
      <button
        className={`receipt${open ? ' open' : ''}`}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <CaretIcon />
        Checked {count} {count === 1 ? 'thing' : 'things'} · {seconds(receipt.durationMs)}
      </button>

      {open && (
        <div className="trail">
          {receipt.checks.map((check, index) => {
            const ref = check.refs[0];
            return (
              <button
                key={`${check.label}-${index}`}
                type="button"
                disabled={!ref || !onOpen}
                onClick={() => ref && onOpen?.(ref)}
              >
                <span className="action">{actionOf(check.kind)}</span>
                <span className="target">{check.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

function actionOf(kind: InvestigationReceipt['checks'][number]['kind']): string {
  switch (kind) {
    case 'search':
      return 'Searched';
    case 'open':
      return 'Opened';
    case 'diff':
      return 'Read the diff';
  }
}

/** One decimal below ten seconds; whole seconds above. */
function seconds(ms: number): string {
  const value = ms / 1000;
  return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}
