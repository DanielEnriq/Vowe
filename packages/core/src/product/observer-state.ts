import type { NormalizedEvent } from '../types/events.js';
import {
  MEANINGFUL_UPDATE_LIMIT,
  type AgentSession,
  type MeaningfulUpdate,
} from '../types/session.js';
import { attentionFor, type AttentionItem } from './attention.js';
import { sessionActivity } from './session-display.js';
import { workerMilestones } from './worker-milestones.js';

/**
 * Everything a developer needs to rely on Vowe instead of opening the session.
 *
 * One function, assembled at read time, because only part of this is state. The
 * understanding and the durable updates are genuinely stored — they were
 * reached by interpreting evidence and cannot be recomputed. Activity and
 * attention are projections of events the store already holds, and storing them
 * would create a second copy that can disagree with the trace: an attention
 * flag written when the worker asked a question would still be there after the
 * answer arrived, which is precisely the bug that makes an attention list stop
 * being read.
 *
 * So: what was interpreted is read from `semanticState`, and what is derivable
 * is derived.
 */
export interface LiveObserverState {
  sessionId: string;
  /** What the worker is doing as of the last event. `null` before any. */
  currentActivity: string | null;
  /**
   * Where the work stands, as the observer understands it.
   *
   * `null` when no observation model has run. There is no deterministic floor
   * for this on purpose — see `SemanticState.currentUnderstanding`.
   */
  currentUnderstanding: string | null;
  /** Newest last. Falls back to deterministic milestones when nothing else. */
  recentMeaningfulUpdates: MeaningfulUpdate[];
  /** Something a person can actually act on, or `null`. Usually `null`. */
  attention: AttentionItem | null;
  /** When the interpreted half of this was last written. */
  updatedAt: string | null;
}

export function liveObserverState(
  session: AgentSession,
  events: readonly NormalizedEvent[],
  projectId?: string,
): LiveObserverState {
  const semantic = session.semanticState;

  /*
   * The floor when no observation model is configured.
   *
   * `workerMilestones` is the right answer rather than a consolation one: it
   * selects — never summarises — runs no model, names the events it stands for
   * and carries refs. A session with no observer reads worse than one with an
   * observer, and it still reads.
   */
  const updates = semantic?.meaningfulUpdates?.length
    ? semantic.meaningfulUpdates.slice(-MEANINGFUL_UPDATE_LIMIT)
    : workerMilestones(events, { limit: MEANINGFUL_UPDATE_LIMIT }).map(
        (milestone): MeaningfulUpdate => ({
          id: milestone.id,
          text: milestone.text,
          at: milestone.at,
          refs: milestone.refs,
        }),
      );

  /*
   * Attention is scoped to a project because `Needs You` is a project list.
   * A session Vowe could not place still has work that might be waiting, so it
   * is asked about under its own id rather than dropped.
   */
  const attention = attentionFor(
    session,
    projectId ?? session.projectId ?? session.id,
    [...events],
  );

  return {
    sessionId: session.id,
    currentActivity: sessionActivity(session),
    currentUnderstanding: compact(semantic?.currentUnderstanding),
    recentMeaningfulUpdates: updates,
    attention: attention[0] ?? null,
    updatedAt: semantic?.updatedAt ?? null,
  };
}

/**
 * Whitespace collapsed, nothing else touched.
 *
 * Deliberately not `plainText`: that keeps only the first line, which is right
 * for a name in a column and wrong here, where two sentences on two lines is a
 * perfectly ordinary thing for the observer to have written.
 */
function compact(value: string | null | undefined): string | null {
  if (!value) return null;
  // Some gateways leak an XML field delimiter into an otherwise valid string.
  // The next field is not part of this understanding.
  return value.split(/<\/understanding\s*>/i)[0]!
    .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || null;
}
