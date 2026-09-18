import { randomUUID } from 'node:crypto';

import type { LlmClient } from '../llm/llm-client.js';
import { toObservedEvent } from '../llm/llm-client.js';
import type { EventStore } from '../store/event-store.js';
import type { ConversationEntry } from '../types/conversation.js';
import { UnknownSessionError } from '../types/errors.js';

export interface CompanionServiceOptions {
  store: EventStore;
  /** Absent when no LLM credential is configured. */
  llm?: LlmClient;
  /** How much observed evidence to ground an answer in. */
  evidenceWindow?: number;
  conversationWindow?: number;
}

export interface CompanionAnswer {
  question: ConversationEntry;
  answer: ConversationEntry;
  /** False when answered deterministically because no LLM is configured. */
  llmBacked: boolean;
}

/**
 * Answers the developer's questions about a session.
 *
 * This service is constructed with a store and (optionally) an LLM. It holds
 * no adapter, no registry and no transport to any worker — asking Vowe a
 * question cannot reach the coding agent, because there is nothing here to
 * reach it with. Sending an instruction is a different call on a different
 * object, by design.
 */
export class CompanionService {
  private readonly store: EventStore;
  private readonly llm: LlmClient | undefined;
  private readonly evidenceWindow: number;
  private readonly conversationWindow: number;

  constructor(options: CompanionServiceOptions) {
    this.store = options.store;
    this.llm = options.llm;
    this.evidenceWindow = options.evidenceWindow ?? 80;
    this.conversationWindow = options.conversationWindow ?? 20;
  }

  get hasLlm(): boolean {
    return this.llm !== undefined;
  }

  getConversation(sessionId: string, limit?: number): ConversationEntry[] {
    return this.store.getConversation(sessionId, limit);
  }

  async ask(sessionId: string, question: string): Promise<CompanionAnswer> {
    const session = this.store.getSession(sessionId);
    if (!session) throw new UnknownSessionError(sessionId);

    const events = this.store.getEvents(sessionId, {
      limit: this.evidenceWindow,
    });
    const history = this.store.getConversation(
      sessionId,
      this.conversationWindow,
    );

    const questionEntry: ConversationEntry = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      role: 'user_question',
      text: question,
    };
    await this.store.appendConversationEntry(questionEntry);

    let text: string;
    let llmBacked = false;
    if (this.llm) {
      try {
        text = await this.llm.answerQuestion({
          sessionId,
          question,
          task: session.task,
          cwd: session.cwd,
          semanticState: session.semanticState,
          events: events.map(toObservedEvent),
          conversation: history.map((entry) => ({
            role: entry.role,
            text: entry.text,
            at: entry.at,
          })),
        });
        llmBacked = true;
      } catch (error) {
        text = `I could not reach the companion model (${
          error instanceof Error ? error.message : String(error)
        }). Here is what I have observed:\n\n${describeDeterministically(
          session.semanticState,
          events,
        )}`;
      }
    } else {
      text = `No LLM is configured, so I can only report what I observed directly.\n\n${describeDeterministically(
        session.semanticState,
        events,
      )}`;
    }

    const answerEntry: ConversationEntry = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      role: 'companion_answer',
      text,
      provenance: {
        eventIds: events.map((e) => e.id),
        semanticUpdatedAt: session.semanticState?.updatedAt,
      },
    };
    await this.store.appendConversationEntry(answerEntry);

    return { question: questionEntry, answer: answerEntry, llmBacked };
  }
}

function describeDeterministically(
  semanticState: import('../types/session.js').SemanticState | null,
  events: import('../types/events.js').NormalizedEvent[],
): string {
  const lines: string[] = [];
  if (semanticState) {
    lines.push(`Phase: ${semanticState.phase}`);
    lines.push(`Current activity: ${semanticState.currentActivity}`);
    if (semanticState.recentProgress.length) {
      lines.push('Recent progress:');
      for (const item of semanticState.recentProgress) lines.push(`- ${item}`);
    }
  }
  const recent = events.slice(-8);
  if (recent.length) {
    lines.push('', 'Most recent observed events:');
    for (const event of recent) lines.push(`- [${event.kind}] ${event.summary}`);
  }
  return lines.length ? lines.join('\n') : 'Nothing has been observed yet.';
}
