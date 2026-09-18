import type { LlmClient } from '../llm/llm-client.js';
import { toObservedEvent } from '../llm/llm-client.js';
import type { SemanticState } from '../types/session.js';
import { HeuristicInterpreter } from './heuristic-interpreter.js';
import {
  provenanceFor,
  type InterpretationInput,
  type SemanticInterpreter,
} from './semantic-interpreter.js';

/**
 * Wraps the deterministic interpreter with an LLM pass.
 *
 * The heuristic result is always computed first and is what we fall back to if
 * the model call fails, so a bad or slow model can never leave a session with
 * no semantic state at all.
 */
export class LlmSemanticInterpreter implements SemanticInterpreter {
  readonly source = 'llm' as const;
  private readonly llm: LlmClient;
  private readonly fallback = new HeuristicInterpreter();
  private readonly onError: (error: unknown) => void;

  constructor(llm: LlmClient, onError: (error: unknown) => void = () => undefined) {
    this.llm = llm;
    this.onError = onError;
  }

  async interpret(input: InterpretationInput): Promise<SemanticState> {
    const heuristic = await this.fallback.interpret(input);
    if (input.events.length === 0) return heuristic;

    try {
      const update = await this.llm.summarizeSession({
        sessionId: input.session.id,
        task: input.session.task,
        cwd: input.session.cwd,
        previousState: input.previous,
        events: input.events.map(toObservedEvent),
      });

      return {
        task: update.task ?? input.session.task,
        phase: update.phase || heuristic.phase,
        currentActivity: update.currentActivity || heuristic.currentActivity,
        recentProgress: update.recentProgress?.length
          ? update.recentProgress
          : heuristic.recentProgress,
        lastMeaningfulUpdate:
          update.lastMeaningfulUpdate || heuristic.lastMeaningfulUpdate,
        source: this.source,
        provenance: provenanceFor(input.events),
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.onError(error);
      return heuristic;
    }
  }
}
