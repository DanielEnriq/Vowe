import type { DecisionRouter } from '../decision/decision-router.js';
import type { RunHandle, VoweRunRecorder } from '../execution/run-recorder.js';
import type { LlmClient } from '../llm/llm-client.js';
import type {
  CommunicationAction,
  CommunicationDecision,
  SurfaceUpdate,
} from '../observation/trace-window.js';
import {
  interruptionAppetite,
  meetsSpeakFloor,
  type TemperamentProfile,
} from '../product/temperament.js';

export interface CommunicationPolicyOptions {
  /** Optional; a heuristic router is a valid answer. */
  router?: DecisionRouter;
  /** Optional; used only when no decision router answered. */
  llm?: LlmClient;
  /** Where each attempt at a decision is recorded, when anywhere. */
  runs?: VoweRunRecorder;
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
  private readonly runs: VoweRunRecorder | null;
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: CommunicationPolicyOptions = {}) {
    this.router = options.router;
    this.llm = options.llm;
    this.runs = options.runs ?? null;
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * One run per attempt, not one per decision.
   *
   * The two strategies are two different model calls to two different
   * providers, and which of them actually answered is the interesting part of
   * the record. Collapsing them into one run would lose exactly that.
   */
  private beginRun(candidate: SurfaceUpdate, strategy: string): RunHandle | undefined {
    return this.runs?.begin({
      kind: 'communication_decision',
      sessionId: candidate.sessionId,
      metadata: { strategy, surfaceUpdateId: candidate.id },
    });
  }

  /**
   * `temperament` is optional, and its absence is not a default.
   *
   * A caller that has no temperament to offer gets exactly the behaviour this
   * class had before temperament existed. Nothing here invents a middle
   * setting on the developer's behalf.
   */
  async evaluate(
    candidate: SurfaceUpdate,
    preference: string | null,
    temperament?: TemperamentProfile,
  ): Promise<CommunicationDecision> {
    const decision = await this.decide(candidate, preference, temperament);
    return withSpeakFloor(decision, candidate, temperament);
  }

  private async decide(
    candidate: SurfaceUpdate,
    preference: string | null,
    temperament: TemperamentProfile | undefined,
  ): Promise<CommunicationDecision> {
    const fromRouter = await this.askRouter(candidate, preference, temperament);
    if (fromRouter) return fromRouter;

    const fromLlm = await this.askLlm(candidate, preference, temperament);
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
    temperament: TemperamentProfile | undefined,
  ): Promise<CommunicationDecision | null> {
    if (!this.router?.available) return null;
    const run = this.beginRun(candidate, 'router');
    try {
      const result = await this.router.choose<CommunicationAction>(
        {
          instructions: preference
            ? `A developer said this about being interrupted while their coding agent works: "${preference}". A development just occurred. What should happen?`
            : 'A developer has not said how closely they want to be kept informed while their coding agent works. A development just occurred. What should happen?',
          criteria: ACTIONS,
          state: {
            development: candidate.message,
            whyItMattersNow: candidate.whyNow,
            urgencyAsJudgedByTheObserver: candidate.urgency,
            // The developer's own words stay in `instructions`; this is the
            // setting they moved, described. Keeping them apart is what lets a
            // decision's `reason` quote the person and never the dial.
            ...(temperament
              ? { statedInterruptionAppetite: interruptionAppetite(temperament) }
              : {}),
          },
        },
        run,
      );
      if (!result) {
        // The router declined to answer. Nothing went wrong; this strategy
        // simply produced no decision, and the next one is tried.
        await run?.complete();
        return null;
      }
      // A `DecisionRouter` is an interface anyone can implement, and this class
      // is what defines the action set — so validate rather than trust. An
      // unrecognized action falls through to the next strategy.
      if (!(result.choice in ACTIONS)) {
        const unknown = new Error(
          `Decision model returned an unknown action: ${result.choice}`,
        );
        this.onError('policy:router', unknown);
        await run?.failed(unknown);
        return null;
      }

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
      await run?.complete({ metadata: { decision: decision.action } });
      return decision;
    } catch (error) {
      this.onError('policy:router', error);
      await run?.failed(error);
      return null;
    }
  }

  private async askLlm(
    candidate: SurfaceUpdate,
    preference: string | null,
    temperament: TemperamentProfile | undefined,
  ): Promise<CommunicationDecision | null> {
    if (!this.llm) return null;
    const run = this.beginRun(candidate, 'llm');
    try {
      const answer = await this.llm.answerQuestion(
        {
          sessionId: candidate.sessionId,
          question: [
            'A developer is being kept company while their coding agent works.',
            preference
              ? `They said: "${preference}"`
              : 'They have not said how closely they want to be kept informed.',
            ...(temperament ? [interruptionAppetite(temperament)] : []),
            '',
            `Something happened: ${candidate.message}`,
            `The observer thought it mattered because: ${candidate.whyNow}`,
            '',
            'Answer with exactly one word and nothing else:',
            ...Object.entries(ACTIONS).map(
              ([action, meaning]) => `${action} — ${meaning}`,
            ),
          ].join('\n'),
          task: null,
          cwd: null,
          semanticState: null,
          events: [],
          conversation: [],
        },
        run,
      );

      const action = parseAction(answer);
      if (!action) {
        await run?.complete();
        return null;
      }
      const decision: CommunicationDecision = {
        action,
        reason: preference
          ? `Judged against the developer's stated preference: "${preference}".`
          : 'No stated preference; judged on its own terms.',
        source: 'llm',
      };
      await run?.complete({ metadata: { decision: decision.action } });
      return decision;
    } catch (error) {
      this.onError('policy:llm', error);
      await run?.failed(error);
      return null;
    }
  }
}

/**
 * The one place temperament overrules a decision, and only downwards.
 *
 * Quiet↔Proactive has to change what actually happens or it has no business
 * being a control. So a candidate that was approved for speaking but sits
 * below this developer's floor is held until they next speak rather than
 * interrupting them. It is never promoted the other way: overruling a model
 * that declined to speak, in order to speak, is the opposite of erring quiet.
 */
function withSpeakFloor(
  decision: CommunicationDecision,
  candidate: SurfaceUpdate,
  temperament: TemperamentProfile | undefined,
): CommunicationDecision {
  if (!temperament) return decision;
  if (decision.action !== 'speak_now') return decision;
  if (meetsSpeakFloor(candidate.urgency, temperament)) return decision;

  return {
    ...decision,
    action: 'queue',
    reason: `${decision.reason} Held until you next speak rather than said now, because you asked to be interrupted less.`,
  };
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
