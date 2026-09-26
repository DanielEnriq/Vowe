import { refFromLink } from '@vowe/core/refs';
import type {
  ContextRef,
  DesignEntry,
  DesignRevision,
  StudioProgress,
} from '@vowe/core';

import {
  liveInvestigationReducer,
  QUIET,
  type LiveInvestigation,
  type LiveProgress,
} from './live-investigation.js';

/**
 * A Studio turn as it happens: the conversational half, the repository check
 * in flight, and the design being rewritten.
 *
 * The conversational half is an ordinary live investigation — same reducer,
 * same rules, same component — because a Studio reply and an Ask answer are
 * the same kind of thing arriving. What Studio adds is the two things only it
 * has: a consultation that takes tens of seconds and says what it is doing,
 * and a document streaming in beside the conversation.
 *
 * Transient by construction. What lasts is the committed reply and revision,
 * re-read when the store says they changed.
 */
export interface StudioTurn {
  live: LiveInvestigation;
  /** The repository check under way, and what the harness is doing now. */
  consulting: { question: string; activity: string | null; since: number } | null;
  /** The design as it is being rewritten; null when nothing is streaming. */
  design: string | null;
  /** The revision this turn committed, held until the pane has it. */
  revisionId: string | null;
}

export const STUDIO_QUIET: StudioTurn = { live: QUIET, consulting: null, design: null, revisionId: null };

/** The conversational part of a Studio report, in the live reducer's terms. */
export function asLiveProgress(progress: StudioProgress): LiveProgress | null {
  switch (progress.phase) {
    case 'started':
      return { phase: 'started' };
    case 'message':
      return { phase: 'answer', delta: progress.delta };
    case 'reasoning':
      return { phase: 'reasoning', delta: progress.delta };
    case 'check':
      return { phase: 'check', check: progress.check };
    case 'finished':
      return progress.entryId ? { phase: 'finished', entryId: progress.entryId, failed: progress.failed } : null;
    default:
      return null;
  }
}

/**
 * Fold one discrete report into the turn. Text and design deltas arrive far
 * faster than anything should re-render; the hook gathers those per frame.
 */
export function studioTurnReducer(state: StudioTurn, progress: StudioProgress, now: number = Date.now()): StudioTurn {
  switch (progress.phase) {
    case 'started':
      return { ...STUDIO_QUIET, live: liveInvestigationReducer(QUIET, { phase: 'started' }, now) };
    case 'consulting':
      return {
        ...state,
        consulting: {
          question: progress.question,
          activity: progress.activity ?? (state.consulting?.question === progress.question ? state.consulting.activity : null),
          since: state.consulting?.question === progress.question ? state.consulting.since : now,
        },
        live: { ...state.live, beat: state.live.beat + 1 },
      };
    case 'check':
      return {
        ...state,
        consulting: progress.check.kind === 'consult' ? null : state.consulting,
        live: liveInvestigationReducer(state.live, { phase: 'check', check: progress.check }, now),
      };
    case 'design':
      return { ...state, design: progress.document };
    case 'finished':
      // Cancelled: nothing was kept, so nothing is left on screen.
      if (!progress.entryId) return STUDIO_QUIET;
      return {
        ...state,
        consulting: null,
        live: liveInvestigationReducer(state.live, { phase: 'finished', entryId: progress.entryId, failed: progress.failed }, now),
        // A turn that did not revise leaves the committed design in view.
        design: progress.revisionId ? state.design : null,
        revisionId: progress.revisionId,
      };
    case 'message':
    case 'reasoning':
      return state;
  }
}

/**
 * What the design pane shows.
 *
 * `streaming` wins while it exists: Vowe is rewriting the design and the
 * developer is watching it happen. Otherwise the revision chosen from history,
 * else the current one, else nothing yet.
 */
export type DesignPaneView =
  | { mode: 'empty' }
  | { mode: 'streaming'; document: string; basedOn: DesignRevision | null }
  | { mode: 'current'; revision: DesignRevision; total: number }
  | { mode: 'historical'; revision: DesignRevision; total: number; current: DesignRevision };

export function designPaneView(
  revisions: readonly DesignRevision[],
  streaming: string | null,
  viewingOrd: number | null,
): DesignPaneView {
  const current = revisions[revisions.length - 1] ?? null;
  if (streaming !== null) return { mode: 'streaming', document: streaming, basedOn: current };
  if (!current) return { mode: 'empty' };
  const viewed = viewingOrd === null ? null : revisions.find((revision) => revision.ord === viewingOrd);
  if (viewed && viewed.id !== current.id) {
    return { mode: 'historical', revision: viewed, total: revisions.length, current };
  }
  return { mode: 'current', revision: current, total: revisions.length };
}

/** Whether a streamed revision has landed, so the live copy can give way to it. */
export function revisionLanded(turn: StudioTurn, revisions: readonly DesignRevision[]): boolean {
  return turn.revisionId !== null && revisions.some((revision) => revision.id === turn.revisionId);
}

/**
 * The target of a Markdown link, if it is one Vowe may open.
 *
 * Only `ref:` links that parse as a real reference are ever clickable, and only
 * once committed: the store unlinks any citation a consultation did not
 * return, and a design still being written has not been checked yet.
 */
export function openableLink(href: string | undefined, committed: boolean): ContextRef | null {
  if (!committed || !href) return null;
  return refFromLink(href);
}

/**
 * The developer spoke last and nothing is working on it: the turn was stopped
 * or Vowe was closed mid-thought. Derived, never stored.
 */
export function unanswered(entries: readonly DesignEntry[], working: boolean): boolean {
  return !working && entries[entries.length - 1]?.role === 'user_message';
}

/** A short, stable "2m ago" style label is shared elsewhere; this is the revision's own line. */
export function revisionLine(revision: DesignRevision, total: number): string {
  return total > 1 ? `Revision ${revision.ord} of ${total}` : 'First draft';
}
