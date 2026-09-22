import { useEffect, useState, type ReactElement } from 'react';

import type { ContextRef, InvestigationReceipt, InvestigationStep } from '@vowe/core';

import { settledRows } from '../state/investigation-timeline.js';
import { CaretIcon } from '../shell/icons.js';
import { InvestigationTimeline } from './InvestigationTimeline.js';

/**
 * The investigation behind an answer that has already been given.
 *
 * One line by default — `Checked 14 things · 38s` — because the answer is the
 * point and the work is the evidence. Opening it shows the full chronology in
 * the same bounded window the live column used, so a forty-step investigation
 * reopens as one screenful rather than as the length of the page.
 *
 * Thoughts used to live only in the renderer, which meant they existed for as
 * long as the developer happened to be watching and then were gone — the one
 * part of the column that could not be gone back to. They were durable the
 * whole time: the provider's reasoning is written to the run's trace as it
 * arrives, and the run carries the id of the answer it produced. Nothing was
 * missing except a reader.
 *
 * So this is a read, not a second store. It asks the main process for the
 * chronology of one entry — once it is opened, since nobody is reading it
 * before then — and renders it with the same component the live column uses,
 * which is what makes a reopened session look like the session that was open.
 *
 * Quiet about failure on purpose. An answer whose run predates the execution
 * lane, or whose trace has been pruned, still has its receipt: the lookups are
 * shown without the thinking between them rather than an error box above an
 * answer that is unaffected.
 */
export function SettledInvestigation({
  entryId,
  receipt,
  onOpenRef,
}: {
  entryId: string;
  receipt: InvestigationReceipt;
  /** Where a lookup opens. Absent in rooms with no workbench. */
  onOpenRef?: (ref: ContextRef) => void;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const steps = useInvestigationSteps(open ? entryId : null);
  const count = receipt.checks.length;
  if (count === 0) return null;

  // Nothing until the read has answered, so opening does not flash the bare
  // lookups before the thinking between them arrives.
  const rows = steps && settledRows(
    steps.length > 0
      ? steps
      : receipt.checks.map((check, index) => ({
          kind: 'check' as const,
          id: `${entryId}:check:${index}`,
          check,
        })),
  );

  return (
    <div className="settled-investigation">
      <button
        className={`exec-summary${open ? ' open' : ''}`}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <CaretIcon />
        <span>
          Checked {count} {count === 1 ? 'thing' : 'things'} · {seconds(receipt.durationMs)}
        </span>
      </button>

      {open && rows && (
        <InvestigationTimeline rows={rows} {...(onOpenRef ? { onOpenRef } : {})} />
      )}
    </div>
  );
}

/** One decimal below ten seconds; whole seconds above. */
function seconds(ms: number): string {
  const value = ms / 1000;
  return value < 10 ? `${value.toFixed(1)}s` : `${Math.round(value)}s`;
}

/** `null` until the chronology has been read — including while unopened. */
function useInvestigationSteps(entryId: string | null): InvestigationStep[] | null {
  const [steps, setSteps] = useState<InvestigationStep[] | null>(null);

  useEffect(() => {
    if (!entryId) return;
    let live = true;
    void window.vowe
      .getInvestigationSteps(entryId)
      .then((next) => {
        if (live) setSteps(next);
      })
      .catch(() => {
        if (live) setSteps([]);
      });
    return () => {
      live = false;
    };
  }, [entryId]);

  return steps;
}
