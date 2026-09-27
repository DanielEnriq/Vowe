import { refFromLink } from '@vowe/core/refs';
import { diffModels, EMPTY_MODEL, todayModel } from '@vowe/core/studio-model';
import type {
  ContextRef,
  DesignDiff,
  DesignEntry,
  DesignLayout,
  DesignModel,
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
 * in flight, and the design moving on the canvas.
 *
 * The conversational half is an ordinary live investigation — same reducer,
 * same rules, same component — because a Studio reply and an Ask answer are
 * the same kind of thing arriving. What Studio adds is the two things only it
 * has: a consultation that takes tens of seconds and says which part it is
 * checking, and the move being applied to the system as each op is written.
 *
 * Transient by construction. What lasts is the committed reply and revision,
 * re-read when the store says they changed.
 */
export interface StudioTurn {
  live: LiveInvestigation;
  /** The repository check under way, what the harness is doing, and the part it concerns. */
  consulting: { question: string; activity: string | null; since: number; partId: string | null } | null;
  /** The design with the move so far applied; null when nothing is moving. */
  preview: { model: DesignModel; layout: DesignLayout } | null;
  /** The revision this turn committed, held until the canvas has it. */
  revisionId: string | null;
}

export const STUDIO_QUIET: StudioTurn = { live: QUIET, consulting: null, preview: null, revisionId: null };

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
 * Fold one discrete report into the turn. Text deltas and model previews
 * arrive far faster than anything should re-render; the hook gathers those
 * per frame.
 */
export function studioTurnReducer(state: StudioTurn, progress: StudioProgress, now: number = Date.now()): StudioTurn {
  switch (progress.phase) {
    case 'started':
      return { ...STUDIO_QUIET, live: liveInvestigationReducer(QUIET, { phase: 'started' }, now) };
    case 'consulting': {
      const same = state.consulting?.question === progress.question;
      return {
        ...state,
        consulting: {
          question: progress.question,
          activity: progress.activity ?? (same ? state.consulting!.activity : null),
          since: same ? state.consulting!.since : now,
          partId: progress.partId ?? null,
        },
        live: { ...state.live, beat: state.live.beat + 1 },
      };
    }
    case 'check':
      return {
        ...state,
        consulting: progress.check.kind === 'consult' ? null : state.consulting,
        live: liveInvestigationReducer(state.live, { phase: 'check', check: progress.check }, now),
      };
    case 'model':
      return { ...state, preview: { model: progress.model, layout: progress.layout } };
    case 'finished':
      // Cancelled: nothing was kept, so nothing is left on screen.
      if (!progress.entryId) return STUDIO_QUIET;
      return {
        ...state,
        consulting: null,
        live: liveInvestigationReducer(state.live, { phase: 'finished', entryId: progress.entryId, failed: progress.failed }, now),
        // A turn that did not move the design leaves the committed one in view.
        preview: progress.revisionId ? state.preview : null,
        revisionId: progress.revisionId,
      };
    case 'message':
    case 'reasoning':
      return state;
  }
}

/** Whether a previewed move has landed, so the live copy can give way to it. */
export function revisionLanded(turn: StudioTurn, revisions: readonly DesignRevision[]): boolean {
  return turn.revisionId !== null && revisions.some((revision) => revision.id === turn.revisionId);
}

/**
 * Which room Studio is.
 *
 * `opening` until there is a system to look at: one question, one composer.
 * `workspace` once there is — the canvas, with the conversation as a rail.
 * `legacy` for a Studio 0 design whose latest version is still a document.
 */
export type StudioRoom = 'opening' | 'workspace' | 'legacy';

export function studioRoom(revisions: readonly DesignRevision[], turn: StudioTurn): StudioRoom {
  if (turn.preview && turn.preview.model.parts.some((part) => !part.retired)) return 'workspace';
  const current = revisions[revisions.length - 1];
  if (!current) return 'opening';
  if (!current.model) return 'legacy';
  return 'workspace';
}

/** The design on the canvas: the move being written, else the committed one. */
export function shownDesign(
  revisions: readonly DesignRevision[],
  layout: DesignLayout,
  turn: StudioTurn,
): { model: DesignModel; layout: DesignLayout } {
  if (turn.preview) return turn.preview;
  return { model: revisions[revisions.length - 1]?.model ?? EMPTY_MODEL, layout };
}

/**
 * The note Vowe left on the canvas about the latest move, if any. A later
 * move supersedes it, so it is derived rather than dismissed in storage.
 */
export function canvasNote(entries: readonly DesignEntry[], revisions: readonly DesignRevision[]): DesignEntry | null {
  const latest = revisions[revisions.length - 1]?.move?.id;
  if (!latest) return null;
  return [...entries].reverse().find((entry) => entry.role === 'companion_note' && entry.anchor?.moveId === latest) ?? null;
}

/** The revision a reply committed, for its "N changes" chip. */
export function revisionFor(entryId: string, revisions: readonly DesignRevision[]): DesignRevision | null {
  return revisions.find((revision) => revision.entryId === entryId) ?? null;
}

/**
 * The changes lens: one move laid over the design it produced, or the whole
 * proposal laid over what the code has today. Temporary; Esc leaves it.
 */
export type ChangesLens = { kind: 'move'; ord: number } | { kind: 'today' };

export interface LensView {
  before: DesignModel;
  after: DesignModel;
  diff: DesignDiff;
  /** The move shown, for `move`; null for `today`. */
  revision: DesignRevision | null;
  /** Position among revisions that have a model, for stepping. */
  index: number;
  total: number;
}

export function lensView(revisions: readonly DesignRevision[], lens: ChangesLens | null): LensView | null {
  if (!lens) return null;
  const drawn = revisions.filter((revision) => revision.model);
  const current = drawn[drawn.length - 1];
  if (!current) return null;
  if (lens.kind === 'today') {
    const before = todayModel(current.model!);
    return { before, after: current.model!, diff: diffModels(before, current.model!), revision: null, index: drawn.length - 1, total: drawn.length };
  }
  const index = drawn.findIndex((revision) => revision.ord === lens.ord);
  if (index === -1) return null;
  const revision = drawn[index]!;
  const before = drawn[index - 1]?.model ?? EMPTY_MODEL;
  return { before, after: revision.model!, diff: diffModels(before, revision.model!), revision, index, total: drawn.length };
}

/** "3 changes", counting only what you would see move on the canvas. */
export function changeCount(revisions: readonly DesignRevision[], revision: DesignRevision): number {
  if (!revision.model) return 0;
  const drawn = revisions.filter((candidate) => candidate.model);
  const index = drawn.findIndex((candidate) => candidate.id === revision.id);
  return diffModels(drawn[index - 1]?.model ?? EMPTY_MODEL, revision.model).visible;
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

/**
 * What a selected part is connected to: the parts one link away and the
 * links between. Selection brings these forward and lets the rest recede.
 */
export function neighborhood(model: DesignModel, partId: string): { parts: Set<string>; links: Set<string> } {
  const parts = new Set<string>([partId]);
  const links = new Set<string>();
  for (const link of model.links) {
    if (link.retired) continue;
    if (link.from === partId || link.to === partId) {
      links.add(link.id);
      parts.add(link.from === partId ? link.to : link.from);
    }
  }
  return { parts, links };
}

/**
 * Which link labels to show. A sparse drawing can carry all of them quietly;
 * a dense one shows a label only where attention already is — the link under
 * the pointer, the selected link, the links of the selected part.
 */
export const QUIET_LABELS = 8;

export function visibleLabels(
  model: DesignModel,
  focus: { parts: Set<string>; links: Set<string> } | null,
  hovered: string | null,
  selectedLink: string | null,
): Set<string> {
  const labelled = model.links.filter((link) => !link.retired && link.label);
  if (!focus && labelled.length <= QUIET_LABELS) return new Set(labelled.map((link) => link.id));
  const shown = new Set<string>();
  for (const link of labelled) {
    if (link.id === hovered || link.id === selectedLink || focus?.links.has(link.id)) shown.add(link.id);
  }
  return shown;
}

/**
 * What Vowe is doing right now, in words, derived from the turn itself:
 * checking the code, drawing, or thinking before either. Nothing when it is
 * writing a reply, because the reply is already visible.
 */
export function studioStatus(turn: StudioTurn, working: boolean): string | null {
  if (turn.consulting) return 'Checking current behavior…';
  if (!working && !turn.live.active) return null;
  if (turn.preview) return 'Drawing the design…';
  if (turn.live.answer.trim()) return null;
  return 'Thinking…';
}

/**
 * The line under the design when the conversation is put away: Vowe's reply
 * as it is written, then the settled reply for a moment. Keyed, so a caption
 * that has faded does not come back until something new is said.
 */
export function studioCaption(entries: readonly DesignEntry[], turn: StudioTurn): { key: string; text: string; live: boolean } | null {
  if (turn.live.answer.trim()) return { key: 'live', text: turn.live.answer.trim(), live: true };
  const last = entries[entries.length - 1];
  if (last?.role === 'companion_message' && last.text.trim()) return { key: last.id, text: last.text.trim(), live: false };
  return null;
}

/**
 * What a click on the canvas does to the selection. A plain click chooses
 * one thing, or lets go of the one thing chosen; Shift or ⌘ gathers it into —
 * or out of — the selection, keeping the order things were chosen in.
 */
export function nextSelection<T extends { kind: string; id: string }>(selection: readonly T[], element: T, gather: boolean): T[] {
  const chosen = selection.some((other) => other.kind === element.kind && other.id === element.id);
  if (gather) return chosen ? selection.filter((other) => !(other.kind === element.kind && other.id === element.id)) : [...selection, element];
  return chosen && selection.length === 1 ? [] : [element];
}
