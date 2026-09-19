import type { DecisionRouter } from '../decision/decision-router.js';
import type { LlmClient } from '../llm/llm-client.js';
import type {
  CommunicationAction,
  CommunicationDecision,
  SurfaceUpdate,
} from '../observation/trace-window.js';

export interface CommunicationPolicyOptions {
  /** Optional; a heuristic router is a valid answer. */
  router?: DecisionRouter;
  /** Optional; used only when no decision router answered. */
  llm?: LlmClient;
  onError?: (scope: string, error: unknown) => void;
}

const ACTIONS: Record<CommunicationAction, string> = {
  ignore:
    'Not worth the developer\'s attention at all, given what they asked for. Record it and move on.',
  quiet_context:
    'Worth knowing but not worth interrupting for. Give it to the assistant silently so it can answer if asked.',
  speak_now:
    'Worth interrupting for right now. The developer asked to hear about developments like this one.',
  queue:
    'Worth saying, but not worth breaking into the current moment. Hold it until the developer next speaks.',
};

/**
 * Decides what to do with a candidate the observer raised.
 *
 * Each observed session carries one plain-language preference — "only tell me
 * when something weird happens", "keep me closely updated on this one" — and
 * this is the only place that preference is interpreted. Everything upstream
 * proposes; everything downstream delivers.
 *
 * Deliberately not a rules engine. It asks a model, in decreasing order of
 * suitability, and falls back to something defensible. The value of the class
 * is the seam, not the cleverness: when surfacing needs to get smarter, this is
 * the one file that changes.
 */
export class CommunicationPolicy {
  private readonly router: DecisionRouter | undefined;
  private readonly llm: LlmClient | undefined;
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: CommunicationPolicyOptions = {}) {
    this.router = options.router;
    this.llm = options.llm;
    this.onError = options.onError ?? (() => undefined);
  }

  async evaluate(
    candidate: SurfaceUpdate,
    preference: string | null,
  ): Promise<CommunicationDecision> {
    const fromRouter = await this.askRouter(candidate, preference);
    if (fromRouter) return fromRouter;

    const fromLlm = await this.askLlm(candidate, preference);
    if (fromLlm) return fromLlm;

    return defaultDecision(candidate, preference);
  }

  /**
   * The decision model picks the action directly.
   *
   * There is no score-to-action mapping and no confidence threshold here. If the
   * model says `speak_now`, it speaks. Confidence and per-option probabilities
   * are recorded on the decision so that, later, there is evidence for whether
   * any threshold would have been worth adding — but nothing branches on them
   * today, because nothing has yet shown that it should.
   */
  private async askRouter(
    candidate: SurfaceUpdate,
    preference: string | null,
  ): Promise<CommunicationDecision | null> {
    if (!this.router?.available) return null;
    try {
      const result = await this.router.choose<CommunicationAction>({
        instructions: preference
          ? `A developer said this about being interrupted while their coding agent works: "${preference}". A development just occurred. What should happen?`
          : 'A developer has not said how closely they want to be kept informed while their coding agent works. A development just occurred. What should happen?',
        criteria: ACTIONS,
        state: {
          development: candidate.message,
          whyItMattersNow: candidate.whyNow,
          urgencyAsJudgedByTheObserver: candidate.urgency,
        },
      });
      if (!result) return null;

      const decision: CommunicationDecision = {
        action: result.choice,
        reason: preference
          ? `Matched against the developer's stated preference: "${preference}".`
          : 'No stated preference; judged on its own terms.',
        source: 'jev',
      };
      const metadata: NonNullable<CommunicationDecision['metadata']> = {};
      if (result.confidence !== undefined) metadata.confidence = result.confidence;
      if (result.probabilities) metadata.probabilities = result.probabilities;
      if (Object.keys(metadata).length) decision.metadata = metadata;
      return decision;
    } catch (error) {
      this.onError('policy:router', error);
      return null;
    }
  }

  private async askLlm(
    candidate: SurfaceUpdate,
    preference: string | null,
  ): Promise<CommunicationDecision | null> {
    if (!this.llm) return null;
    try {
      const answer = await this.llm.answerQuestion({
        sessionId: candidate.sessionId,
        question: [
          'A developer is being kept company while their coding agent works.',
          preference
            ? `They said: "${preference}"`
            : 'They have not said how closely they want to be kept informed.',
          '',
          `Something happened: ${candidate.message}`,
          `The observer thought it mattered because: ${candidate.whyNow}`,
          '',
          'Answer with exactly one word and nothing else:',
          ...Object.entries(ACTIONS).map(([action, meaning]) => `${action} — ${meaning}`),
        ].join('\n'),
        task: null,
        cwd: null,
        semanticState: null,
        events: [],
        conversation: [],
      });

      const action = parseAction(answer);
      if (!action) return null;
      return {
        action,
        reason: preference
          ? `Judged against the developer's stated preference: "${preference}".`
          : 'No stated preference; judged on its own terms.',
        source: 'llm',
      };
    } catch (error) {
      this.onError('policy:llm', error);
      return null;
    }
  }
}

/**
 * What to do when nothing smarter is available.
 *
 * Erring quiet is the right default: an assistant that interrupts wrongly is
 * worse than one that stays silent and can answer when asked, because the quiet
 * path still reaches the developer the moment they ask a question.
 */
export function defaultDecision(
  candidate: SurfaceUpdate,
  preference: string | null,
): CommunicationDecision {
  if (candidate.urgency === 'high') {
    return {
      action: 'speak_now',
      reason: 'No decision model was available, and the observer marked this urgent.',
      source: 'default',
    };
  }
  if (candidate.urgency === 'low') {
    return {
      action: 'quiet_context',
      reason: 'No decision model was available, and the observer did not think this pressing.',
      source: 'default',
    };
  }
  return {
    action: preference ? 'queue' : 'quiet_context',
    reason: preference
      ? 'No decision model was available; held until the developer next speaks rather than guessing at their preference.'
      : 'No decision model was available and no preference was stated, so kept as silent context.',
    source: 'default',
  };
}

function parseAction(text: string): CommunicationAction | null {
  const normalized = text.toLowerCase();
  // Longest first, so "quiet_context" is not shadowed by a stray "queue".
  for (const action of ['quiet_context', 'speak_now', 'ignore', 'queue'] as const) {
    if (normalized.includes(action) || normalized.includes(action.replace('_', ' '))) {
      return action;
    }
  }
  return null;
}
