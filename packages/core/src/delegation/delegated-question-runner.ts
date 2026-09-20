import { randomUUID } from 'node:crypto';

import type { ContextNavigator } from '../context/context-navigator.js';
import { dedupeRefs, type ContextRef } from '../context/refs.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
} from '../llm/observation-llm.js';
import type { EventStore } from '../store/event-store.js';
import type { ConversationEntry } from '../types/conversation.js';

export interface DelegatedQuestionRunnerOptions {
  store: EventStore;
  navigator: ContextNavigator;
  investigator: ObservationLlm;
  /** How much recent L1 understanding to hand over. */
  recentNotes?: number;
  onError?: (scope: string, error: unknown) => void;
  /**
   * A grounded answer has been produced and persisted.
   *
   * Matches the `onNote` / `onSurfaceUpdate` convention on `ObserverRunner`.
   * Called after the answer is already delivered, and deliberately not awaited:
   * whatever a listener decides to do with the result must not be able to delay
   * an answer somebody is waiting to hear.
   */
  onAnswer?: (result: DelegatedResult) => void;
}

export interface DelegatedQuestion {
  sessionId: string;
  question: string;
  /** What has been said out loud so far, oldest first. */
  liveConversation?: { speaker: 'user' | 'vo'; text: string }[];
}

export interface DelegatedResult extends DelegatedAnswer {
  /** What was asked, so a listener need not go back to the conversation for it. */
  question: string;
  /** The persisted full answer, as it appears in the session conversation. */
  entry: ConversationEntry;
}

/**
 * Answers a technical question about a session by going and looking.
 *
 * This is the other consumer of the `ContextNavigator`, and it holds exactly
 * the same three read tools the observer does — no more. Two constraints make
 * that literal rather than aspirational:
 *
 *  - It is **read-only**. There is no `surface_update` here, and no control
 *    path of any kind. Asking Vowe a question still cannot reach the worker.
 *  - It is **independent**. Nothing here touches the observer's queue, so a
 *    long investigation never pauses trace ingestion, and a slow window never
 *    delays an answer.
 *
 * The answer comes back in two forms; see `DelegatedAnswer` for why.
 */
export class DelegatedQuestionRunner {
  private readonly store: EventStore;
  private readonly navigator: ContextNavigator;
  private readonly investigator: ObservationLlm;
  private readonly recentNotes: number;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly onAnswer: (result: DelegatedResult) => void;

  constructor(options: DelegatedQuestionRunnerOptions) {
    this.store = options.store;
    this.navigator = options.navigator;
    this.investigator = options.investigator;
    this.recentNotes = options.recentNotes ?? 6;
    this.onError = options.onError ?? (() => undefined);
    this.onAnswer = options.onAnswer ?? (() => undefined);
  }

  async answer(question: DelegatedQuestion): Promise<DelegatedResult> {
    const session = this.store.getSession(question.sessionId);
    const touched: ContextRef[] = [];

    const input: InvestigationInput = {
      sessionId: question.sessionId,
      question: question.question,
      task: session?.task ?? null,
      cwd: session?.cwd ?? null,
      recentNotes: this.store.getWindowNotes(question.sessionId, this.recentNotes),
      liveConversation: question.liveConversation ?? [],
    };

    await this.store.appendConversationEntry({
      id: randomUUID(),
      sessionId: question.sessionId,
      at: new Date().toISOString(),
      role: 'user_question',
      text: question.question,
    });

    let answer: DelegatedAnswer;
    try {
      answer = await this.investigator.investigate(
        input,
        this.readTools(question.sessionId, touched),
      );
    } catch (error) {
      this.onError('investigate', error);
      // Saying "I could not find out" is a usable answer. Saying nothing, in a
      // voice conversation, is not.
      const message =
        error instanceof Error ? error.message : String(error);
      answer = {
        spokenAnswer:
          'I could not look that up just now — something went wrong on my side.',
        fullAnswer: `The investigation failed before it could answer the question.\n\n${message}`,
        refs: [],
      };
    }

    const refs = dedupeRefs([...answer.refs, ...touched]);
    const entry: ConversationEntry = {
      id: randomUUID(),
      sessionId: question.sessionId,
      at: new Date().toISOString(),
      role: 'companion_answer',
      text: answer.fullAnswer,
      provenance: {
        eventIds: eventIdsFrom(refs),
      },
    };
    await this.store.appendConversationEntry(entry);

    const result: DelegatedResult = {
      ...answer,
      question: question.question,
      refs,
      entry,
    };
    try {
      this.onAnswer(result);
    } catch (error) {
      this.onError('onAnswer', error);
    }
    return result;
  }

  /** The same three tools the observer gets. Nothing else. */
  private readTools(sessionId: string, touched: ContextRef[]): ReadOnlyToolset {
    return {
      searchContext: async (input) => {
        const hits = await this.navigator.searchContext({
          sessionId,
          query: input.query,
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        for (const hit of hits) touched.push(hit.ref);
        return hits;
      },
      openContext: async (input) => {
        const result = await this.navigator.openContext({
          ref: input.ref,
          ...(input.depth ? { depth: input.depth } : {}),
        });
        if (!result.notFound) touched.push(result.ref);
        return result;
      },
      getDiff: async (input) => {
        const diff = await this.navigator.getDiff({
          sessionId,
          ...(input.path ? { path: input.path } : {}),
          ...(input.around ? { around: input.around } : {}),
        });
        touched.push({
          kind: 'diff',
          sessionId,
          ...(input.path ? { path: input.path } : {}),
        });
        return diff;
      },
    };
  }
}

/** Provenance on a conversation entry is event ids, so refs are narrowed. */
function eventIdsFrom(refs: ContextRef[]): string[] {
  return refs
    .filter(
      (ref): ref is Extract<ContextRef, { kind: 'event' | 'transcript' }> =>
        ref.kind === 'event' || ref.kind === 'transcript',
    )
    .map((ref) => ref.eventId);
}
