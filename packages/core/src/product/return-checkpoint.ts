import type { ContextRef } from '../context/refs.js';
import type { WindowNote } from '../observation/trace-window.js';
import type { NormalizedEvent } from '../types/events.js';
import type { AttentionItem } from './attention.js';
import { workerMilestones, type WorkerMilestone } from './worker-milestones.js';

/**
 * Where the developer's understanding of a session got to.
 *
 * Not a read receipt and not telemetry: one mark per session saying "they were
 * looking at this, up to here". Everything the checkpoint shows is derived
 * from it, so the mark is the only thing that has to be durable.
 */
export interface SessionAttentionCursor {
  sessionId: string;
  lastMeaningfullyViewedAt: string;
  lastViewedSeq: number;
}

/**
 * What changed while the developer was not looking.
 *
 * Deliberately a selection, never a synthesis. The approved design shows a
 * written paragraph here — "The regression suite passed, then Claude Code
 * changed the replay insertion path after the first fix still duplicated
 * messages" — and producing that would mean a model call and a story Vowe had
 * not actually been asked for. So this carries the milestones that really
 * happened and the prose the observer really wrote, and the UI lays them out.
 */
export interface ReturnCheckpoint {
  sessionId: string;
  /** The moment they last looked. */
  since: string;
  /** How long they were away, at the moment this was built. */
  awayMs: number;
  /** What the worker did, oldest first. */
  milestones: WorkerMilestone[];
  /** What Vowe itself noticed, newest first. The observer's own words. */
  notableChanges: NotableChange[];
  /** Non-empty is the difference between "nothing needs you" and a decision. */
  needsAttention: AttentionItem[];
}

export interface NotableChange {
  text: string;
  at: string;
  refs: ContextRef[];
}

export interface ReturnCheckpointInput {
  sessionId: string;
  cursor: SessionAttentionCursor | null;
  events: readonly NormalizedEvent[];
  notes: readonly WindowNote[];
  needsAttention?: readonly AttentionItem[];
  /** Defaults to now. Injected so the projection is testable and pure. */
  at?: Date;
}

export interface ReturnCheckpointOptions {
  /**
   * Below this, a checkpoint is noise.
   *
   * Someone who glanced away for ninety seconds has not lost their place, and
   * telling them what they missed would be the interruption the whole product
   * is built to avoid.
   */
  minimumAwayMs?: number;
  maxMilestones?: number;
  maxNotableChanges?: number;
}

const DEFAULT_MINIMUM_AWAY_MS = 5 * 60_000;
const DEFAULT_MAX_MILESTONES = 6;
const DEFAULT_MAX_NOTABLE_CHANGES = 2;

/**
 * `null` whenever there is nothing worth saying, which is most of the time.
 *
 * Three ways to get nothing: they never left, they left briefly, or nothing
 * happened. Only the third is about the work; the first two are about respect
 * for someone who simply looked at another window.
 */
export function returnCheckpoint(
  input: ReturnCheckpointInput,
  options: ReturnCheckpointOptions = {},
): ReturnCheckpoint | null {
  const cursor = input.cursor;
  if (!cursor) return null;

  const now = (input.at ?? new Date()).getTime();
  const since = Date.parse(cursor.lastMeaningfullyViewedAt);
  if (!Number.isFinite(since)) return null;

  const awayMs = now - since;
  const minimumAwayMs = options.minimumAwayMs ?? DEFAULT_MINIMUM_AWAY_MS;
  if (awayMs < minimumAwayMs) return null;

  const fresh = input.events.filter((event) => event.seq > cursor.lastViewedSeq);
  const milestones = workerMilestones(fresh, {
    limit: options.maxMilestones ?? DEFAULT_MAX_MILESTONES,
  });

  const notableChanges = input.notes
    .filter((note) => {
      const text = note.notableChange?.trim();
      return Boolean(text) && Date.parse(note.createdAt) > since;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, options.maxNotableChanges ?? DEFAULT_MAX_NOTABLE_CHANGES)
    .map((note) => ({
      text: note.notableChange!.trim(),
      at: note.createdAt,
      refs: note.refs ?? [],
    }));

  const needsAttention = [...(input.needsAttention ?? [])];

  if (!milestones.length && !notableChanges.length && !needsAttention.length) return null;

  return {
    sessionId: input.sessionId,
    since: cursor.lastMeaningfullyViewedAt,
    awayMs,
    milestones,
    notableChanges,
    needsAttention,
  };
}

/** The amber variant in the design. A decision is waiting, not just news. */
export function checkpointNeedsDecision(checkpoint: ReturnCheckpoint): boolean {
  return checkpoint.needsAttention.length > 0;
}
