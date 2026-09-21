import { randomUUID } from 'node:crypto';

import type { ContextNavigator } from '../context/context-navigator.js';
import { dedupeRefs, parseRef, type ContextRef } from '../context/refs.js';
import type {
  DelegatedAnswer,
  InvestigationInput,
  ObservationLlm,
  ReadOnlyToolset,
} from '../llm/observation-llm.js';
import type { EventStore } from '../store/event-store.js';
import type { ConversationEntry } from '../types/conversation.js';
import { InvestigationRecorder } from './investigation-recorder.js';

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
  /**
   * The investigation could not be carried out, and the answer says so.
   *
   * Still a perfectly ordinary answer: it was persisted like any other and a
   * caller may render it as one. This is here so a caller that wants to show a
   * failure state does not have to match on the text of the message.
   */
  failed: boolean;
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
    // The refs the investigation touches, and the order it touched them in.
    const recorder = new InvestigationRecorder();

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
    let failed = false;
    // Measured around the investigation itself, so an answer can truthfully say
    // how long it took to go and look. Not telemetry: one number, one answer.
    const startedAt = Date.now();
    let durationMs = 0;
    try {
      answer = await this.investigator.investigate(
        input,
        this.readTools(question.sessionId, recorder),
      );
    } catch (error) {
      this.onError('investigate', error);
      failed = true;
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
    } finally {
      durationMs = Date.now() - startedAt;
    }

    const refs = dedupeRefs([...answer.refs, ...recorder.refs()]);
    const entry: ConversationEntry = {
      id: randomUUID(),
      sessionId: question.sessionId,
      at: new Date().toISOString(),
      role: 'companion_answer',
      text: answer.fullAnswer,
      refs,
      provenance: {
        eventIds: eventIdsFrom(refs),
      },
      // Only when something was actually looked at. An answer that opened
      // nothing — because no model is configured, or because the investigation
      // fell over before its first tool call — carries no receipt rather than
      // an empty one. There is nothing to show, and `Checked 0 things` is not a
      // thing to say.
      ...(recorder.length ? { investigation: recorder.receipt(durationMs) } : {}),
    };
    await this.store.appendConversationEntry(entry);

    const result: DelegatedResult = {
      ...answer,
      question: question.question,
      refs,
      entry,
      failed,
    };
    try {
      this.onAnswer(result);
    } catch (error) {
      this.onError('onAnswer', error);
    }
    return result;
  }

  /**
   * The same three tools the observer gets. Nothing else.
   *
   * The recorder sits here rather than anywhere further out because this is the
   * only place that sees a tool call actually happen. Everything above it has
   * the model's account of what it did, which is a different thing.
   */
  private readTools(sessionId: string, recorder: InvestigationRecorder): ReadOnlyToolset {
    return {
      searchContext: async (input) => {
        const hits = await this.navigator.searchContext({
          sessionId,
          query: input.query,
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        recorder.searched(input.sources, hits);
        return hits;
      },
      openContext: async (input) => {
        const result = await this.navigator.openContext({
          ref: input.ref,
          ...(input.depth ? { depth: input.depth } : {}),
        });
        // The address that was asked for, which is what the label describes.
        // A model can hand back nonsense, in which case there is nothing to
        // name and the check says only that a reference was followed.
        recorder.opened(parseRef(input.ref), result);
        return result;
      },
      getDiff: async (input) => {
        const diff = await this.navigator.getDiff({
          sessionId,
          ...(input.path ? { path: input.path } : {}),
          ...(input.around ? { around: input.around } : {}),
        });
        recorder.diffed({
          kind: 'diff',
          sessionId,
          ...(input.path ? { path: input.path } : {}),
        });
        return diff;
      },
    };
  }
}

/**
 * The evidence inspector resolves event ids, so the entry carries a narrowing
 * of its refs alongside the refs themselves. Nothing is lost by it any more.
 */
function eventIdsFrom(refs: ContextRef[]): string[] {
  return refs
    .filter(
      (ref): ref is Extract<ContextRef, { kind: 'event' | 'transcript' }> =>
        ref.kind === 'event' || ref.kind === 'transcript',
    )
    .map((ref) => ref.eventId);
}
