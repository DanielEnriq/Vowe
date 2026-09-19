import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import type {
  DelegatedAnswer,
  InvestigationInput,
  LlmClient,
  ObservationLlm,
  ObserveWindowInput,
  ObserverToolset,
  ReadOnlyToolset,
  SemanticUpdate,
  SessionInterpretationInput,
  SessionQuestionInput,
  WindowObservation,
} from '@vowe/core';
import { OBSERVER_SYSTEM, parseRef, renderObserverPrompt } from '@vowe/core';

import {
  ANSWER_SYSTEM,
  SUMMARIZE_SYSTEM,
  renderInterpretationPrompt,
  renderQuestionPrompt,
} from './prompts.js';
import {
  INVESTIGATE_SYSTEM,
  renderInvestigationPrompt,
} from './observer-prompts.js';
import {
  readTools,
  recordAnswerTool,
  recordObservationTool,
  surfaceUpdateTool,
  type AnswerCapture,
  type ObservationCapture,
} from './observation-tools.js';

const SemanticUpdateSchema = z.object({
  task: z.string().nullable(),
  phase: z.string(),
  currentActivity: z.string(),
  recentProgress: z.array(z.string()),
  lastMeaningfulUpdate: z.string(),
});

export interface AnthropicLlmClientOptions {
  apiKey?: string;
  model?: string;
  /**
   * Alternative API base. The Anthropic message protocol is also spoken by
   * gateways, and pointing at one is a configuration change rather than a code
   * change — which is the whole reason this class is the only file that knows
   * a vendor SDK exists.
   */
  baseURL?: string;
  /** Ceiling on tool-use iterations per observation or investigation. */
  maxToolIterations?: number;
  /** Overridden in tests; otherwise the SDK default. */
  client?: Anthropic;
}

/**
 * The only place in Vowe that imports a model vendor SDK.
 *
 * Everything else depends on `LlmClient` from @vowe/core, so replacing or
 * splitting this layer later (a different vendor, a dedicated interpretation
 * service) touches nothing but this file.
 */
export class AnthropicLlmClient implements LlmClient, ObservationLlm {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxToolIterations: number;

  constructor(options: AnthropicLlmClientOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
    this.model = options.model ?? 'claude-opus-5';
    this.maxToolIterations = options.maxToolIterations ?? 12;
  }

  /**
   * Returns a client when a credential is configured, otherwise `undefined`.
   * Callers degrade to deterministic behaviour rather than failing to start.
   *
   * Reads a gateway key as well as a first-party one, because "which endpoint"
   * and "which credential" are the two things that actually vary between
   * developers, and neither should require editing code.
   */
  static fromEnvironment(
    options: AnthropicLlmClientOptions = {},
  ): AnthropicLlmClient | undefined {
    const apiKey =
      options.apiKey ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.OPENROUTER_API_KEY;
    if (!apiKey) return undefined;

    const baseURL = options.baseURL ?? process.env.VOWE_LLM_BASE_URL;
    const model = options.model ?? process.env.VOWE_LLM_MODEL;
    return new AnthropicLlmClient({
      ...options,
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(model ? { model } : {}),
    });
  }

  async summarizeSession(
    input: SessionInterpretationInput,
  ): Promise<SemanticUpdate> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: SUMMARIZE_SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low',
        format: zodOutputFormat(SemanticUpdateSchema),
      },
      messages: [{ role: 'user', content: renderInterpretationPrompt(input) }],
    });

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error('Companion model returned no parseable summary.');
    }
    return parsed;
  }

  async answerQuestion(input: SessionQuestionInput): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8000,
      system: ANSWER_SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: renderQuestionPrompt(input) }],
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new Error('Companion model declined to answer.');
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return text || 'The companion model returned an empty answer.';
  }

  // ------------------------------------------------------------- observation

  /**
   * Interpret one window, with tools.
   *
   * `surface_update` is always bound; the read tools appear only when the
   * runner decided this window justified exploring. The loop is the SDK's tool
   * runner with a hard iteration ceiling, because an observer that wanders
   * indefinitely through a large session costs real money and delays every
   * window behind it.
   */
  async observeWindow(
    input: ObserveWindowInput,
    tools: ObserverToolset,
  ): Promise<WindowObservation> {
    const capture: ObservationCapture = { observation: null };
    const bound = [
      recordObservationTool(capture),
      surfaceUpdateTool(tools),
      ...(tools.read ? readTools(tools.read) : []),
    ];

    const final = await this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 8000,
      system: OBSERVER_SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: tools.read ? 'medium' : 'low' },
      tools: bound,
      max_iterations: this.maxToolIterations,
      messages: [{ role: 'user', content: renderObserverPrompt(input) }],
    });

    if (capture.observation) return capture.observation;

    // The model answered in prose without calling the terminal tool. That is
    // still an observation, and losing a window over a missed tool call would
    // be worse than accepting slightly less structure.
    const text = textOf(final);
    if (text) return { summary: text };
    throw new Error('The observer returned nothing for this window.');
  }

  /**
   * Investigate a question and answer it in both forms.
   *
   * Read tools only. There is no `surface_update` here, and nothing that could
   * reach the worker — answering a question must not be able to change
   * anything.
   */
  async investigate(
    input: InvestigationInput,
    tools: ReadOnlyToolset,
  ): Promise<DelegatedAnswer> {
    const capture: AnswerCapture = {
      spokenAnswer: null,
      fullAnswer: null,
      refs: [],
    };

    const final = await this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 16000,
      system: INVESTIGATE_SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      tools: [recordAnswerTool(capture), ...readTools(tools)],
      max_iterations: this.maxToolIterations,
      messages: [{ role: 'user', content: renderInvestigationPrompt(input) }],
    });

    const refs = capture.refs
      .map((value) => parseRef(value))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null);

    if (capture.spokenAnswer && capture.fullAnswer) {
      return {
        spokenAnswer: capture.spokenAnswer,
        fullAnswer: capture.fullAnswer,
        refs,
      };
    }

    // Same reasoning as above: prose without the terminal tool is still an
    // answer. The spoken form is the first sentence, which is the best
    // available approximation of "what you would say out loud".
    const text = textOf(final);
    if (!text) throw new Error('The investigation returned no answer.');
    return { spokenAnswer: firstSentence(text), fullAnswer: text, refs };
  }
}

function textOf(message: { content: unknown[] }): string {
  return message.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function firstSentence(text: string, limit = 400): string {
  const match = /^[\s\S]*?[.!?](\s|$)/.exec(text.trim());
  const candidate = (match ? match[0] : text).trim();
  return candidate.length > limit ? `${candidate.slice(0, limit - 1)}\u2026` : candidate;
}
