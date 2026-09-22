import type { ContextRef } from '../context/refs.js';
import type {
  DelegatedQuestionRunner,
  DelegatedResult,
  ProjectDelegatedResult,
} from '../delegation/delegated-question-runner.js';
import type { EventStore } from '../store/event-store.js';
import type { ConversationEntry } from '../types/conversation.js';
import { UnknownSessionError } from '../types/errors.js';

export interface CompanionServiceOptions {
  store: EventStore;
  /** The one grounded investigator. Shared with the live bridge. */
  delegated: DelegatedQuestionRunner;
}

/**
 * The developer's typed questions about a session.
 *
 * This is a facade over `DelegatedQuestionRunner`, and that is the whole point
 * of it: typing a question and speaking one reach the *same* investigator
 * instance, with the same three read tools, the same context, and the same
 * `onAnswer` hook into project memory. Modality decides presentation, never
 * reasoning capability. There is one grounded question-answering engine.
 *
 * The reach argument the original service made still holds, and holds for the
 * same reason: a store and an investigator, no adapter, no registry and no
 * transport. Asking Vowe a question cannot reach the coding agent because there
 * is nothing here to reach it with. Sending an instruction is a different call
 * on a different object, by design.
 */
export class CompanionService {
  private readonly store: EventStore;
  private readonly delegated: DelegatedQuestionRunner;

  constructor(options: CompanionServiceOptions) {
    this.store = options.store;
    this.delegated = options.delegated;
  }

  getConversation(sessionId: string, limit?: number): ConversationEntry[] {
    return this.store.getConversation(sessionId, limit);
  }

  /**
   * Investigate and answer, persisting both sides of the exchange.
   *
   * The unknown-session check is here rather than in the runner: a question
   * delegated from a live conversation always has a session, while a typed one
   * arrives with whatever id the UI held, and failing loudly on a stale one is
   * more useful than investigating nothing.
   */
  async ask(
    sessionId: string,
    question: string,
    contextRefs?: ContextRef[],
  ): Promise<DelegatedResult> {
    if (!this.store.getSession(sessionId)) throw new UnknownSessionError(sessionId);
    // No `liveConversation`: nothing has been said out loud. The investigation
    // prompt omits that section entirely when it is empty.
    return this.delegated.answer({
      sessionId,
      question,
      ...(contextRefs?.length ? { contextRefs } : {}),
    });
  }

  /**
   * The same question, asked about a repository instead of one run.
   *
   * Here rather than on a second service because it is the same capability at
   * a different scope, and because the facade is what the main process holds:
   * one object that can answer a question, whichever room asked it.
   */
  async askProject(
    projectId: string,
    question: string,
    contextRefs?: ContextRef[],
  ): Promise<ProjectDelegatedResult> {
    return this.delegated.answerProject({
      projectId,
      question,
      ...(contextRefs?.length ? { contextRefs } : {}),
    });
  }
}
