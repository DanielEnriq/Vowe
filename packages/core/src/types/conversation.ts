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
}

/** True for the roles that were delivered to the underlying worker. */
export function reachedWorker(role: ConversationRole): boolean {
  return role === 'user_instruction' || role === 'instruction_result';
}
