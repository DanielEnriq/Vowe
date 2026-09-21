import type {
  ChoiceInput,
  ChoiceResult,
  DecisionRouter,
  ModelTrace,
  NoulInput,
  NoulResult,
  ScoreInput,
  ScoreResult,
} from '@vowe/core';

/**
 * Two documented ways to reach the same decision model. One client covers both
 * because only the base URL and the model id differ.
 */
export const JEV_ENDPOINTS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/alpha/decisions',
    model: 'typesafe/jev-1.13',
  },
  typesafe: {
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
  },
} as const;

export interface JevDecisionRouterOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * Ask, record what came back, then return `null` anyway so callers fall back.
   * For comparing the decision model against the deterministic behaviour on
   * real traffic before letting it decide anything.
   */
  shadow?: boolean;
  onError?: (scope: string, error: unknown) => void;
  onShadowDecision?: (record: {
    kind: 'choice' | 'score' | 'noul';
    instructions: string;
    answer: unknown;
  }) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface DecisionsResponse {
  answers?: Record<string, unknown>;
}

/**
 * A structured-decision model behind the `DecisionRouter` seam.
 *
 * It is used for three things and no others: which older window is relevant,
 * whether a window justifies exploring, and how a development matches the
 * developer's stated preference. It never writes prose — the observation model
 * does that, and mixing the two would put a decision model in charge of
 * narrative.
 *
 * Every method returns `null` on any failure: a timeout, a bad status, an
 * unparseable body, a missing key. That is not error-swallowing — `null` is the
 * documented "decide this yourself" answer, and each call site has a
 * deterministic fallback ready. The application must work exactly as well with
 * this unconfigured, which is why it is a separate package.
 */
export class JevDecisionRouter implements DecisionRouter {
  readonly name = 'jev';
  readonly available: boolean;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly shadow: boolean;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly onShadowDecision: JevDecisionRouterOptions['onShadowDecision'];
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevDecisionRouterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? JEV_ENDPOINTS.openrouter.baseUrl;
    this.model = options.model ?? JEV_ENDPOINTS.openrouter.model;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.shadow = options.shadow ?? false;
    this.onError = options.onError ?? (() => undefined);
    this.onShadowDecision = options.onShadowDecision;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.available = Boolean(this.apiKey) && !this.shadow;
  }

  /**
   * Returns a router when one is configured, otherwise `undefined` so the
   * caller can install the heuristic floor instead.
   */
  static fromEnvironment(
    options: Partial<JevDecisionRouterOptions> = {},
  ): JevDecisionRouter | undefined {
    const apiKey =
      options.apiKey ??
      process.env.TYPESAFE_API_KEY ??
      process.env.OPENROUTER_API_KEY;
    if (!apiKey) return undefined;

    // A TypeSafe key implies the first-party endpoint unless told otherwise.
    const preset = process.env.TYPESAFE_API_KEY
      ? JEV_ENDPOINTS.typesafe
      : JEV_ENDPOINTS.openrouter;

    return new JevDecisionRouter({
      ...options,
      apiKey,
      baseUrl: options.baseUrl ?? process.env.VOWE_JEV_BASE_URL ?? preset.baseUrl,
      model: options.model ?? process.env.VOWE_JEV_MODEL ?? preset.model,
      shadow: options.shadow ?? process.env.VOWE_JEV_SHADOW === '1',
    });
  }

  async choose<K extends string>(
    input: ChoiceInput<K>,
    trace?: ModelTrace,
  ): Promise<ChoiceResult<K> | null> {
    const answer = await this.ask(
      'choice',
      input.state,
      {
        type: 'choice',
        instructions: input.instructions,
        criteria: input.criteria,
      },
      trace,
    );
    if (!answer || typeof answer !== 'object') return null;

    const record = answer as {
      choice?: unknown;
      confidence?: unknown;
      probabilities?: unknown;
    };
    if (typeof record.choice !== 'string') return null;
    // Guard against a model returning an option we did not offer.
    if (!(record.choice in input.criteria)) return null;

    const result: ChoiceResult<K> = { choice: record.choice as K };
    if (typeof record.confidence === 'number') result.confidence = record.confidence;
    if (isNumberMap(record.probabilities)) result.probabilities = record.probabilities;
    return result;
  }

  async score(input: ScoreInput, trace?: ModelTrace): Promise<ScoreResult | null> {
    const answer = await this.ask(
      'score',
      input.state,
      {
        type: 'score',
        instructions: input.instructions,
        criteria: input.levels,
      },
      trace,
    );
    if (!answer || typeof answer !== 'object') return null;

    const record = answer as {
      score?: unknown;
      confidence?: unknown;
      probabilities?: unknown;
    };
    if (typeof record.score !== 'number') return null;

    const result: ScoreResult = { score: record.score };
    if (typeof record.confidence === 'number') result.confidence = record.confidence;
    if (isNumberMap(record.probabilities)) result.probabilities = record.probabilities;
    return result;
  }

  async noul(input: NoulInput, trace?: ModelTrace): Promise<NoulResult | null> {
    const answer = await this.ask(
      'noul',
      input.state,
      {
        type: 'noul',
        instructions: input.instructions,
        criteria: input.criteria,
      },
      trace,
    );
    if (!answer || typeof answer !== 'object') return null;

    const record = answer as { noul?: unknown };
    return typeof record.noul === 'number' ? { noul: record.noul } : null;
  }

  // ----------------------------------------------------------------- private

  /**
   * One request, and the record of it.
   *
   * The decisions API answers with a choice, a confidence and per-option
   * probabilities — and no rationale of any kind. So this reports a request and
   * a result and no reasoning, because there is none to report. Inventing a
   * sentence about why the model chose what it chose would be fiction.
   */
  private async ask(
    kind: 'choice' | 'score' | 'noul',
    state: unknown,
    question: Record<string, unknown>,
    trace?: ModelTrace,
  ): Promise<unknown> {
    if (!this.apiKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // The request as sent, minus the credential — which is a header, and is
      // the one part of a request that must never be written down.
      const request = { model: this.model, state, questions: { q: question } };
      trace?.input(request, { provider: this.name, model: this.model });

      const response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const failure = new Error(`Decision request failed: ${response.status}`);
        this.onError(`jev:${kind}`, failure);
        trace?.error(failure);
        return null;
      }

      const body = (await response.json()) as DecisionsResponse;
      const answer = body.answers?.['q'] ?? null;

      if (this.shadow) {
        this.onShadowDecision?.({
          kind,
          instructions: String(question['instructions'] ?? ''),
          answer,
        });
        // Observed, not obeyed.
        trace?.output({ payload: answer });
        return null;
      }
      trace?.output({ payload: answer });
      return answer;
    } catch (error) {
      this.onError(`jev:${kind}`, error);
      trace?.error(error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isNumberMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}
