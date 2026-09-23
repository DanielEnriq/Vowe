import type { InvestigationCheck, InvestigationProgress } from '@vowe/core';

/**
 * An investigation, as it is happening.
 *
 * Everything here is undurable by construction: it exists between a question
 * being asked and its answer being written, and the persisted
 * `ConversationEntry` with its receipt is what survives. Holding the streamed
 * text too means the room shows Vowe's actual words as they are composed
 * rather than a spinner followed by a wall.
 *
 * A reducer rather than hook state so the two rules that matter here can be
 * stated once and tested without a window:
 *
 *  - **Text only ever grows.** Nothing in this file slices, windows or replaces
 *    the accumulated strings. An earlier version rendered a fixed-length tail
 *    of the working, which took text off the screen while the developer was
 *    reading it and made a steadily-growing answer look like it was sliding.
 *  - **The execution is one sequence.** Lookups and thinking are interleaved in
 *    the order they happened, because that is the order they happened in.
 *    Reasoning used to accumulate into a single separate region, which said
 *    that Vowe had looked at four things and thought once, when what actually
 *    occurred was look, think, look, think.
 */

/**
 * One thing that happened, in the order it happened.
 *
 * A lookup is a fact with a label the recorder already wrote. A thought is a
 * span: it opens when reasoning starts arriving, grows while it does, and
 * closes the moment anything else happens — another lookup, the answer, or the
 * work finishing. So `endedAt === null` means "still thinking", and it is a
 * property of the step rather than a flag beside it.
 */
export type LiveStep =
  | { kind: 'check'; id: string; at: number; check: InvestigationCheck }
  | {
      kind: 'thought';
      id: string;
      at: number;
      /**
       * Exposed working, and only that.
       *
       * Where a provider returns a summary of its reasoning this is the
       * summary; where it exposes nothing at all no thought step is ever
       * opened, because a monologue invented to fill the gap would be the one
       * part of this column that was not true.
       */
      text: string;
      endedAt: number | null;
    };

export interface LiveInvestigation {
  active: boolean;
  /** Lookups and thinking, interleaved, oldest first. */
  steps: LiveStep[];
  /** The written answer, so far. The same text the entry will hold. */
  answer: string;
  /**
   * The entry this investigation produced, once it says it has finished.
   *
   * Held rather than acted on: the live text stays on screen until the durable
   * entry is actually in the thread, so the swap is a replacement and never a
   * blank frame between the two.
   */
  settledEntryId: string | null;
  /**
   * Rises once per real execution event.
   *
   * Not a clock and not a percentage: it counts things that actually happened,
   * which is what lets the presence react to work without anything inventing a
   * rhythm for it.
   */
  beat: number;
}

/**
 * Where the turn as a whole is — distinct from anything happening inside it.
 *
 * Two levels, kept apart on purpose. Inside the trace, `Thinking · Ns` is a
 * single reasoning span that is open right now; it is one row among lookups
 * and says nothing about the turn. Out here the question is only whether the
 * turn is still alive and what it is doing at the largest grain: gathering
 * (`investigating`), writing the reply (`answering`), or done (`finished`).
 * A turn can be investigating for a minute while no reasoning span is open at
 * all, which is exactly why the two must not share a word.
 */
export type TurnPhase = 'investigating' | 'answering' | 'finished';

export function turnPhase(state: LiveInvestigation): TurnPhase {
  if (!state.active || state.settledEntryId !== null) return 'finished';
  return state.answer.length > 0 ? 'answering' : 'investigating';
}

export const QUIET: LiveInvestigation = {
  active: false,
  steps: [],
  answer: '',
  settledEntryId: null,
  beat: 0,
};

/** Every lookup, for the places that want the trail rather than the sequence. */
export function checksOf(state: LiveInvestigation): InvestigationCheck[] {
  return state.steps.flatMap((step) => (step.kind === 'check' ? [step.check] : []));
}

/** The thought currently open, when one is. */
export function openThought(state: LiveInvestigation): LiveStep | null {
  const last = state.steps[state.steps.length - 1];
  return last && last.kind === 'thought' && last.endedAt === null ? last : null;
}

/**
 * Text that arrived since the last commit.
 *
 * Deltas land far faster than anything should re-render, so they are gathered
 * here and applied once a frame. That is rendering coalescing and not
 * batching: every character the provider sent is in the next commit, in order,
 * and nothing waits for a chunk to fill.
 */
export interface StreamedText {
  reasoning: string;
  answer: string;
  /** How many real events this batch stands for. */
  events: number;
}

export const NOTHING_STREAMED: StreamedText = { reasoning: '', answer: '', events: 0 };

/**
 * Fold one progress report into the live state.
 *
 * Discrete events — the start, a lookup, the finish — are applied as they
 * arrive, because each one is a thing the developer is waiting to see appear.
 * Text is not applied here: it goes to `gather` and is committed by the frame,
 * which is the only difference in how the two kinds of event are handled.
 */
export function liveInvestigationReducer(
  state: LiveInvestigation,
  progress: InvestigationProgress,
  now: number = Date.now(),
): LiveInvestigation {
  switch (progress.phase) {
    case 'started':
      return { ...QUIET, active: true };

    case 'check':
      return {
        ...state,
        active: true,
        // A lookup after a thought is the end of that thought: Vowe stopped
        // considering and went and looked.
        steps: [
          ...closeThought(state.steps, now),
          {
            kind: 'check',
            id: `check-${state.steps.length}`,
            at: now,
            check: progress.check,
          },
        ],
        beat: state.beat + 1,
      };

    /**
     * The work has stopped, so the presence settles — but nothing is cleared.
     * What is on screen stays until the durable entry replaces it.
     */
    case 'finished':
      return {
        ...state,
        active: false,
        steps: closeThought(state.steps, now),
        settledEntryId: progress.entryId,
      };

    // Text is gathered, not reduced. See `gather`.
    case 'reasoning':
    case 'answer':
      return state;
  }
}

/** Accumulate a text delta for the next frame. Order is preserved exactly. */
export function gather(pending: StreamedText, progress: InvestigationProgress): StreamedText {
  if (progress.phase === 'reasoning') {
    return { ...pending, reasoning: pending.reasoning + progress.delta, events: pending.events + 1 };
  }
  if (progress.phase === 'answer') {
    return { ...pending, answer: pending.answer + progress.delta, events: pending.events + 1 };
  }
  return pending;
}

/**
 * Commit a frame's worth of text.
 *
 * Append-only, and deliberately does not touch `active`: a frame scheduled
 * just before the investigation reported itself finished must not put the room
 * back into thinking after the thinking stopped.
 *
 * Reasoning extends the open thought or opens one; the answer starting closes
 * it, because once Vowe is writing the answer it has stopped deliberating.
 */
export function commitStreamed(
  state: LiveInvestigation,
  batch: StreamedText,
  now: number = Date.now(),
): LiveInvestigation {
  if (!batch.events) return state;

  let steps = state.steps;

  if (batch.reasoning) {
    const last = steps[steps.length - 1];
    if (last && last.kind === 'thought' && last.endedAt === null) {
      steps = [...steps.slice(0, -1), { ...last, text: last.text + batch.reasoning }];
    } else {
      steps = [
        ...steps,
        {
          kind: 'thought',
          id: `thought-${steps.length}`,
          at: now,
          text: batch.reasoning,
          endedAt: null,
        },
      ];
    }
  }

  if (batch.answer) steps = closeThought(steps, now);

  return {
    ...state,
    steps,
    answer: state.answer + batch.answer,
    beat: state.beat + 1,
  };
}

/**
 * End the thought in progress, if there is one.
 *
 * The timestamp is the caller's, so a duration is measured from two points on
 * the same clock and a test can state both.
 */
function closeThought(steps: readonly LiveStep[], now: number): LiveStep[] {
  const last = steps[steps.length - 1];
  if (!last || last.kind !== 'thought' || last.endedAt !== null) return [...steps];
  return [...steps.slice(0, -1), { ...last, endedAt: now }];
}

/** Whether the durable entry this was streaming towards has arrived. */
export function isReplaced(
  state: LiveInvestigation,
  entryIds: readonly string[],
): boolean {
  return state.settledEntryId !== null && entryIds.includes(state.settledEntryId);
}
