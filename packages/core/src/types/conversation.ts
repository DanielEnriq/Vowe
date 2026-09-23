import type { ContextRef } from '../context/refs.js';

/**
 * The companion conversation attached to a session.
 *
 * `user_question` / `companion_answer` never reach the worker.
 * `user_instruction` / `instruction_result` always do.
 * The role is what records which side of that boundary an entry crossed.
 *
 * `user_message` / `companion_message` are on the same side of that boundary as
 * the question-and-answer pair, and are the ordinary conversation around it:
 * someone said something, and someone said something back. They exist because
 * the pair is a claim as well as a boundary — `companion_answer` says an
 * investigation produced this, and storing `Checking.` under it would be a
 * durable lie. Which of the two an entry is has nothing to do with how it
 * arrived: modality lives on `ConversationDelivery`, and a typed remark and a
 * spoken one are the same kind of turn.
 */
export type ConversationRole =
  | 'user_question'
  | 'companion_answer'
  | 'user_message'
  | 'companion_message'
  | 'user_instruction'
  | 'instruction_result'
  | 'system_note';

/**
 * Where a turn came from, when something outside Vowe minted it.
 *
 * This exists for exactly one reason: a provider may deliver the same turn
 * twice — a retry, a reconnect, a replayed stream — and history must not grow a
 * second copy of it. The three parts together are a stable name for one turn at
 * its source, so the database can refuse the duplicate rather than asking Vowe
 * to notice that two texts look alike. Comparing text would be the wrong test
 * anyway: a person may say the same sentence twice, and meaning it twice is not
 * the same as it arriving twice.
 *
 * Absent on anything Vowe wrote itself, which needs no such protection.
 */
export interface ConversationOrigin {
  /** The system that produced it, e.g. `openai-live`. */
  provider: string;
  /** What kind of thing it is over there, e.g. `live_turn`. */
  kind: string;
  /** Stable at the source, and reproduced exactly on a replay. */
  id: string;
}

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
  /**
   * Present only when a provider minted this turn. See `ConversationOrigin`:
   * it is an identity, not a provenance record, and nothing reads it except
   * the uniqueness check that keeps a redelivered turn from being stored twice.
   */
  origin?: ConversationOrigin;
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
  /**
   * A muted second line saying what that specific lookup found — a count, not
   * a summary. Only a search writes one: an open or a diff already names one
   * concrete thing, and a paraphrase of *its* content would be a claim this
   * receipt has no basis for making.
   */
  detail?: string;
  /** What that one lookup turned up. Empty when it found nothing. */
  refs: ContextRef[];
}

export type InvestigationCheckKind = 'search' | 'open' | 'diff';

/** True for the roles that were delivered to the underlying worker. */
export function reachedWorker(role: ConversationRole): boolean {
  return role === 'user_instruction' || role === 'instruction_result';
}

/** How an entry reached a person. */
/**
 * A turn in a conversation about a project rather than about one session.
 *
 * Same shape as a session turn minus the two things that only make sense
 * inside a session: there is no `sessionId`, and there is no delivery, because
 * a project conversation is typed and read rather than spoken. When project
 * voice exists it brings its own record rather than having been anticipated
 * here.
 *
 * Kept a separate type rather than a `ConversationEntry` with a nullable
 * session so that no query can confuse the two and no reader has to remember
 * to filter.
 */
export interface ProjectConversationEntry {
  id: string;
  projectId: string;
  at: string;
  role: ConversationRole;
  text: string;
  refs?: ContextRef[];
  provenance?: { eventIds: string[]; semanticUpdatedAt?: string };
  investigation?: InvestigationReceipt;
  origin?: ConversationOrigin;
}

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
 * none of them may rewrite the entry.
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
   * differs from the entry. Absent means the whole entry was delivered — or
   * that nobody can honestly say what was, which is the commoner case out loud
   * and is why this is optional rather than approximated.
   *
   * Usually a prefix of `entry.text`, and deliberately not required to be one:
   * a grounded answer spoken by the voice model is the short spoken form of
   * that answer, which is shorter than the entry and worded differently. What
   * this promises is that it is a record of *this* entry being delivered, never
   * a second answer.
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
