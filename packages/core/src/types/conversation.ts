import type { ContextRef } from '../context/refs.js';

/**
 * The companion conversation attached to a session.
 *
 * `user_question` / `companion_answer` never reach the worker.
 * `user_instruction` / `instruction_result` always do.
 * The role is what records which side of that boundary an entry crossed.
 */
export type ConversationRole =
  | 'user_question'
  | 'companion_answer'
  | 'user_instruction'
  | 'instruction_result'
  | 'system_note';

export interface ConversationEntry {
  id: string;
  sessionId: string;
  at: string;
  role: ConversationRole;
  text: string;
  /**
   * Everything the answer was derived from, in full.
   *
   * `provenance.eventIds` below is a narrowing of this to the two ref kinds the
   * evidence inspector can resolve, and it stays because that inspector reads
   * it. It is not a substitute: an answer grounded in the working tree, the
   * diff, the code graph or Vowe's own memory has no event ids at all, and
   * dropping those refs is how "show me why you think that" stops being
   * answerable.
   */
  refs?: ContextRef[];
  provenance?: {
    eventIds: string[];
    semanticUpdatedAt?: string;
  };
  /**
   * What Vowe actually went and looked at before answering.
   *
   * Present only on a grounded answer that performed at least one lookup, which
   * is why it is optional twice over: an entry written before receipts existed
   * has none, and so does an answer that never opened anything. Absent means
   * "nothing to show", never "this was not recorded".
   */
  investigation?: InvestigationReceipt;
}

/**
 * The observable trail of a grounded answer.
 *
 * This is a record of *retrieval*, not of thought. Only actions taken through
 * the investigator's read tools appear here — what was searched, what was
 * opened, which diff was inspected. A hypothesis, a prompt, a scratchpad or
 * anything else the model did in its own head is deliberately not representable
 * in this shape, and adding a field for it would be the wrong change.
 *
 * It lives beside the answer it supports rather than in a stream of its own:
 * the receipt is only meaningful as the basis of that answer, and an
 * investigation store would be a second history to keep in step with the first.
 */
export interface InvestigationReceipt {
  /** How long the delegated investigation took. Not performance telemetry. */
  durationMs: number;
  /** In the order the lookups happened. */
  checks: InvestigationCheck[];
}

/** One lookup the investigator performed, as a person would describe it. */
export interface InvestigationCheck {
  kind: InvestigationCheckKind;
  /**
   * Human-facing and already written: `Read context-navigator.ts:161`, not
   * `open_context(...)`. Stored rather than derived at render time, because a
   * receipt is a record of what happened when it happened — a later change of
   * wording should not rewrite what Vowe said it did last month.
   */
  label: string;
  /** What that one lookup turned up. Empty when it found nothing. */
  refs: ContextRef[];
}

export type InvestigationCheckKind = 'search' | 'open' | 'diff';

/** True for the roles that were delivered to the underlying worker. */
export function reachedWorker(role: ConversationRole): boolean {
  return role === 'user_instruction' || role === 'instruction_result';
}

/** How an entry reached a person. */
export type DeliveryModality = 'text' | 'voice';

/**
 * How far a delivery got.
 *
 * `started` is written when communication begins, before anyone knows how it
 * ends, and the same row is finalized afterwards. That is what makes an
 * interruption distinguishable from a delivery that never began: a row still
 * reading `started` after a restart was in flight when Vowe stopped, which is
 * a different fact from `cancelled`.
 */
export type DeliveryStatus =
  | 'started'
  | 'completed'
  | 'interrupted'
  | 'cancelled';

/**
 * What happened while a `ConversationEntry` was communicated.
 *
 * The entry is what Vowe meant; this is what the person actually got. Keeping
 * them apart is the whole point: a spoken answer cut off halfway is **one**
 * entry holding the complete text, plus one delivery recording how far the
 * audio got. The full answer is not truncated to match what was heard, and the
 * interruption boundary is not thrown away either — so a future agent can tell
 * the difference between what Vowe knew and what the developer actually heard.
 *
 * An entry may have several deliveries — spoken, then re-read as text — and
 * none of them may rewrite the entry. `deliveredText` is a prefix of
 * `entry.text`, never a different answer.
 */
export interface ConversationDelivery {
  id: string;
  /** The entry this delivered. Never a copy of its text. */
  entryId: string;
  sessionId: string;
  modality: DeliveryModality;
  status: DeliveryStatus;
  /**
   * The best available record of what was actually audible or visible, when it
   * differs from the entry. Absent means the whole entry was delivered.
   */
  deliveredText?: string;
  /** How far into the synthesized audio the person got, when speaking. */
  audioEndMs?: number;
  /** The turn that cut this one off, when something did. */
  interruptedByEntryId?: string;
  startedAt: string;
  /** Absent while the delivery is still in flight. */
  completedAt?: string;
}

/**
 * What may change after a delivery has started.
 *
 * Identity is deliberately not here. `id`, `entryId`, `sessionId` and
 * `modality` are fixed when the delivery is created: a record of speaking one
 * answer cannot later become a record of showing a different one.
 */
export type DeliveryProgress = Partial<
  Pick<
    ConversationDelivery,
    | 'status'
    | 'deliveredText'
    | 'audioEndMs'
    | 'interruptedByEntryId'
    | 'completedAt'
  >
>;
