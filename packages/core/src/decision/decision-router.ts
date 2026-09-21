import type { ModelTrace } from '../llm/model-trace.js';

/**
 * A seam for fast structured decisions.
 *
 * Some choices in the observation harness are not prose problems: which of
 * these older windows is relevant, is this window novel enough to explore,
 * does this development match what the developer asked to hear about. They want
 * a typed answer, quickly, and they want it to be the same answer next time.
 *
 * This interface exists so such a model can be used where it helps without the
 * rest of the system depending on it. Every method may return `null`, and every
 * call site must have a deterministic answer of its own for that case — so the
 * router is an optimization, never a dependency.
 *
 * The router never writes prose. L1 notes and spoken answers come from the
 * observation model; mixing the two would put a decision model in charge of
 * narrative, which is the one thing it is not for.
 */
export interface DecisionRouter {
  readonly name: string;
  /** False when no credential or endpoint is configured. */
  readonly available: boolean;

  /** Pick one of a named set of options. */
  choose<K extends string>(
    input: ChoiceInput<K>,
    trace?: ModelTrace,
  ): Promise<ChoiceResult<K> | null>;

  /** Place something on an ordered scale. */
  score(input: ScoreInput, trace?: ModelTrace): Promise<ScoreResult | null>;

  /** A calibrated yes/no. */
  noul(input: NoulInput, trace?: ModelTrace): Promise<NoulResult | null>;
}

export interface DecisionInput {
  /** The material to judge. Serialized by the implementation. */
  state: unknown;
  /** What is being decided, in one or two sentences. */
  instructions: string;
}

export interface ChoiceInput<K extends string> extends DecisionInput {
  /** Option key -> what choosing it means. */
  criteria: Record<K, string>;
}

export interface ChoiceResult<K extends string> {
  choice: K;
  /** Reported for tuning. Callers must not branch on it. */
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface ScoreInput extends DecisionInput {
  /** Ordered level descriptions, lowest first. */
  levels: string[];
}

export interface ScoreResult {
  score: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface NoulInput extends DecisionInput {
  criteria: { true: string; false: string };
}

export interface NoulResult {
  /** 0 = no, 1 = yes. */
  noul: number;
}

/**
 * The always-available floor.
 *
 * It answers nothing, which is exactly right: `null` means "decide this
 * yourself", and every caller already knows how. Wiring this in place of a real
 * router is how the application runs with no decision-model credential at all.
 */
export class HeuristicDecisionRouter implements DecisionRouter {
  readonly name = 'heuristic';
  readonly available = false;

  async choose<K extends string>(): Promise<ChoiceResult<K> | null> {
    return null;
  }

  async score(): Promise<ScoreResult | null> {
    return null;
  }

  async noul(): Promise<NoulResult | null> {
    return null;
  }
}
