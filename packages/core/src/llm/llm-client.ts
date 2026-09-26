import type { ConversationEntry } from '../types/conversation.js';
import type { NormalizedEvent } from '../types/events.js';
import type { SemanticState } from '../types/session.js';
import type { ModelTrace } from './model-trace.js';

/**
 * The companion's own intelligence layer.
 *
 * Deliberately separate from `AgentAdapter`: the model that interprets a
 * session and answers questions about it must not be coupled to the provider
 * running the session. A later implementation (Jev, a different vendor, a
 * split between summarization and Q&A) drops in here without touching the
 * session or adapter architecture.
 *
 * Only the implementation package may import a vendor SDK.
 */
export interface LlmClient {
  summarizeSession(
    input: SessionInterpretationInput,
    trace?: ModelTrace,
  ): Promise<SemanticUpdate>;
  answerQuestion(
    input: SessionQuestionInput,
    trace?: ModelTrace,
  ): Promise<string>;
}

/** The interpretable shape of an observed event. */
export interface ObservedEvent {
  evidence?: NormalizedEvent['evidence'];
  id: string;
  seq: number;
  at: string;
  kind: NormalizedEvent['kind'];
  summary: string;
}

export interface SessionInterpretationInput {
  sessionId: string;
  task: string | null;
  cwd: string | null;
  previousState: SemanticState | null;
  /** The evidence window, oldest first. */
  events: ObservedEvent[];
}

/** What the model may change. Provenance and bookkeeping stay ours. */
export interface SemanticUpdate {
  task: string | null;
  phase: string;
  currentActivity: string;
  recentProgress: string[];
  lastMeaningfulUpdate: string;
}

export interface SessionQuestionInput {
  sessionId: string;
  question: string;
  task: string | null;
  cwd: string | null;
  /**
   * How this developer asked Vowe to talk, composed from their temperament.
   *
   * Appended to the system prompt rather than the question, because it governs
   * every answer rather than this one. Absent means nobody set a preference and
   * the prompt stands as written — never a silently applied middle setting.
   */
  guidance?: string;
  semanticState: SemanticState | null;
  /** Observed evidence the answer must be grounded in, oldest first. */
  events: ObservedEvent[];
  /** Prior companion conversation, oldest first. */
  conversation: Pick<ConversationEntry, 'role' | 'text' | 'at'>[];
}

export function toObservedEvent(event: NormalizedEvent): ObservedEvent {
  return {
    id: event.id,
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    summary: event.summary,
    ...(event.evidence ? {evidence:event.evidence}:{}),
  };
}
