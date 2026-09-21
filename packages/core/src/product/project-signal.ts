import type { ContextRef } from '../context/refs.js';
import type { SurfaceUpdate, WindowNote } from '../observation/trace-window.js';

/**
 * `Latest from Vowe` — the most recent thing observation had to say about a
 * project, shown when the developer comes looking.
 *
 * This is **selection, not summarisation.** Everything here was already
 * produced by the observer running over the sessions; picking the newest one
 * out of what exists adds no second opinion and starts no loop. A project-level
 * summariser would be a project-level observer by another name, and the
 * contract rules that out.
 *
 * It is also a *pull* surface, distinct from proactive interruption. Whether
 * Vowe speaks is `CommunicationPolicy`'s decision and was made when the
 * candidate was raised; this only decides what to show someone who opened the
 * room and looked.
 */
export interface ProjectSignal {
  sessionId: string;
  text: string;
  refs: ContextRef[];
  at: string;
}

/** The two reads this needs. Structural, so any `EventStore` satisfies it. */
export interface ProjectSignalSource {
  getSurfaceUpdates(sessionId: string, limit?: number): SurfaceUpdate[];
  getWindowNotes(sessionId: string, limit?: number): WindowNote[];
}

/**
 * How far back to look per session.
 *
 * Both reads return the *newest* records, and this only ever wants the newest
 * one of those, so the bound cannot change the answer — it just avoids walking
 * a long session's whole observation history to find its last entry.
 */
const SCAN_LIMIT = 20;

/**
 * The newest meaningful signal across a project's sessions.
 *
 * ```text
 * latest meaningful SurfaceUpdate
 *     ↓ fallback
 * latest non-empty WindowNote.notableChange
 *     ↓
 * null
 * ```
 *
 * `null` is a real answer and the UI must honour it. A project where nothing
 * notable has happened should say nothing, not reach further back for
 * something stale to fill the space with.
 */
export function selectProjectSignal(
  sessionIds: string[],
  source: ProjectSignalSource,
  limit = SCAN_LIMIT,
): ProjectSignal | null {
  let best: ProjectSignal | null = null;

  for (const sessionId of sessionIds) {
    for (const update of source.getSurfaceUpdates(sessionId, limit)) {
      if (!isMeaningful(update)) continue;
      best = newer(best, {
        sessionId,
        text: update.message.trim(),
        refs: update.refs ?? [],
        at: update.createdAt,
      });
    }
  }
  if (best) return best;

  for (const sessionId of sessionIds) {
    for (const note of source.getWindowNotes(sessionId, limit)) {
      const change = note.notableChange?.trim();
      if (!change) continue;
      best = newer(best, {
        sessionId,
        text: change,
        refs: note.refs ?? [],
        at: note.createdAt,
      });
    }
  }

  return best;
}

/**
 * Whether a candidate is worth showing at all.
 *
 * `ignore` is the policy's own recorded verdict on this exact update — reading
 * it back is honouring a judgement that was already made, not forming a new
 * one. An undecided candidate is kept: nothing has said it is uninteresting.
 */
function isMeaningful(update: SurfaceUpdate): boolean {
  if (!update.message.trim()) return false;
  return update.decision?.action !== 'ignore';
}

/** Newest wins; ties keep the incumbent, so the result is stable. */
function newer(current: ProjectSignal | null, candidate: ProjectSignal): ProjectSignal {
  if (!current) return candidate;
  return Date.parse(candidate.at) > Date.parse(current.at) ? candidate : current;
}
