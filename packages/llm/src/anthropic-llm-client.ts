import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import type {
  DelegatedAnswer,
  ModelTrace,
  ModelUsage,
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
  INVESTIGATE_PROJECT_SYSTEM,
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
  /**
   * How hard the model works per call.
   *
   * The other latency lever besides model choice, and the one that matters most
   * for observation: a window is interpreted once, continuously, while the
   * developer is waiting to be told something. Exposed rather than hardcoded so
   * it can be tuned from replay against a real fixture.
   */
  effort?: 'low' | 'medium' | 'high';
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
  private readonly effort: 'low' | 'medium' | 'high';

  constructor(options: AnthropicLlmClientOptions = {}) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      });
    // Sonnet by default. Observation is the hot path — one call per window,
    // continuously, while someone waits to hear whether anything happened — so
    // it is the one place where latency is worth more than the last increment
    // of capability. Override with VOWE_LLM_MODEL when it is not.
    this.model = options.model ?? 'claude-sonnet-5';
    this.maxToolIterations = options.maxToolIterations ?? 12;
    this.effort = options.effort ?? 'low';
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
    const effort = options.effort ?? readEffort(process.env.VOWE_LLM_EFFORT);
    return new AnthropicLlmClient({
      ...options,
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
  }

  async summarizeSession(
    input: SessionInterpretationInput,
    trace?: ModelTrace,
  ): Promise<SemanticUpdate> {
    const request = {
      model: this.model,
      max_tokens: 4000,
      system: SUMMARIZE_SYSTEM,
      thinking: { type: 'adaptive' as const },
      output_config: {
        effort: 'low' as const,
        format: zodOutputFormat(SemanticUpdateSchema),
      },
      messages: [
        { role: 'user' as const, content: renderInterpretationPrompt(input) },
      ],
    };
    trace?.input(request, { provider: 'anthropic', model: this.model });

    const response = await this.client.messages.parse(request);
    reportReasoning(trace, response.content);

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error('Companion model returned no parseable summary.');
    }
    trace?.output({
      text: textOf(response),
      payload: parsed,
      ...usageOf(response),
    });
    return parsed;
  }

  async answerQuestion(
    input: SessionQuestionInput,
    trace?: ModelTrace,
  ): Promise<string> {
    const request = {
      model: this.model,
      max_tokens: 8000,
      system: withGuidance(ANSWER_SYSTEM, input.guidance),
      thinking: { type: 'adaptive' as const },
      output_config: { effort: 'medium' as const },
      messages: [{ role: 'user' as const, content: renderQuestionPrompt(input) }],
    };
    trace?.input(request, { provider: 'anthropic', model: this.model });

    const stream = this.client.messages.stream(request);

    const message = await stream.finalMessage();
    reportReasoning(trace, message.content);
    if (message.stop_reason === 'refusal') {
      throw new Error('Companion model declined to answer.');
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    trace?.output({ text, ...usageOf(message) });
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
    trace?: ModelTrace,
  ): Promise<WindowObservation> {
    const capture: ObservationCapture = { observation: null };
    const bound = [
      recordObservationTool(capture),
      surfaceUpdateTool(tools),
      ...(tools.read ? readTools(tools.read) : []),
    ];

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 8000,
      system: OBSERVER_SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.effort },
      tools: bound,
      max_iterations: this.maxToolIterations,
      messages: [{ role: 'user', content: renderObserverPrompt(input) }],
    });
    const usage: ModelUsage = {};
    const final = await this.drain(runner, trace, usage);

    if (capture.observation) {
      trace?.output({
        text: textOf(final),
        payload: capture.observation,
        usage,
      });
      return capture.observation;
    }

    // The model answered in prose without calling the terminal tool. That is
    // still an observation, and losing a window over a missed tool call would
    // be worse than accepting slightly less structure.
    const text = textOf(final);
    if (text) {
      trace?.output({ text, usage });
      return { summary: text };
    }
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
    trace?: ModelTrace,
  ): Promise<DelegatedAnswer> {
    const capture: AnswerCapture = {
      spokenAnswer: null,
      fullAnswer: null,
      refs: [],
    };

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 16000,
      system: withGuidance(
        'projectId' in input ? INVESTIGATE_PROJECT_SYSTEM : INVESTIGATE_SYSTEM,
        input.guidance,
      ),
      thinking: { type: 'adaptive' },
      // A delegated question has someone waiting on the answer out loud, but it
      // is also the call most likely to be wrong if rushed, so it gets one step
      // more effort than routine observation.
      output_config: { effort: this.effort === 'low' ? 'medium' : this.effort },
      tools: [recordAnswerTool(capture), ...readTools(tools)],
      max_iterations: this.maxToolIterations,
      messages: [{ role: 'user', content: renderInvestigationPrompt(input) }],
    });
    const usage: ModelUsage = {};
    const final = await this.drain(runner, trace, usage);

    const refs = capture.refs
      .map((value) => parseRef(value))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null);

    if (capture.spokenAnswer && capture.fullAnswer) {
      trace?.output({ text: capture.fullAnswer, usage });
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
    trace?.output({ text, usage });
    return { spokenAnswer: firstSentence(text), fullAnswer: text, refs };
  }

  /**
   * Run the tool loop, reporting each round as it happens.
   *
   * Iterating rather than awaiting the runner is the whole of the change: the
   * awaited form hands back only the last message, and the reasoning, the tool
   * calls and the token counts of every round before it are gone. The loop is
   * otherwise identical — `done()` still yields the same final message the
   * awaited form did.
   *
   * The resolved request goes in first, from the runner's own params, so what
   * is recorded is what was actually sent rather than what a caller meant.
   */
  private async drain(
    runner: ReturnType<Anthropic['beta']['messages']['toolRunner']>,
    trace: ModelTrace | undefined,
    usage: ModelUsage,
  ): Promise<Anthropic.Beta.BetaMessage> {
    if (!trace) return runner.done();
    trace.input(runner.params, { provider: 'anthropic', model: this.model });
    for await (const message of runner) {
      // The runner's iterator is typed for either mode; nothing here streams,
      // so a message without content is one this loop has nothing to say about.
      if (!('content' in message)) continue;
      reportReasoning(trace, message.content);
      addUsage(usage, message);
    }
    return runner.done();
  }
}

/**
 * Reasoning, as this provider actually exposes it.
 *
 * Adaptive thinking returns a *summary* of the model's reasoning — the SDK says
 * so: the output mode is `summarized` by default — so every block here is
 * reported as a summary, and never as the reasoning itself. Claiming to hold
 * more of a model's thinking than we do would make this lane worse than empty.
 *
 * A redacted block is recorded with no text at all: it is encrypted and carries
 * nothing readable, and the fact that reasoning happened and cannot be shown is
 * itself the truthful record.
 */
function reportReasoning(
  trace: ModelTrace | undefined,
  content: readonly { type: string; thinking?: string }[],
): void {
  if (!trace) return;
  for (const block of content) {
    if (block.type === 'thinking') {
      trace.reasoning({ text: block.thinking ?? '', summary: true });
    } else if (block.type === 'redacted_thinking') {
      trace.reasoning({ summary: true, payload: { redacted: true } });
    }
  }
}

/** Only what the provider reported. An absent counter stays absent. */
function usageOf(message: UsageBearing): { usage?: ModelUsage } {
  const usage: ModelUsage = {};
  addUsage(usage, message);
  return Object.keys(usage).length ? { usage } : {};
}

interface UsageBearing {
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

/**
 * Add one round's counters to a loop's total.
 *
 * A tool loop is several requests, and the tokens a run cost are all of them.
 * Reporting only the last round would understate every investigation that
 * looked anything up.
 */
function addUsage(total: ModelUsage, message: UsageBearing): void {
  const usage = message.usage;
  if (!usage) return;
  if (typeof usage.input_tokens === 'number') {
    total.inputTokens = (total.inputTokens ?? 0) + usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    total.outputTokens = (total.outputTokens ?? 0) + usage.output_tokens;
  }
}

function readEffort(value: string | undefined): 'low' | 'medium' | 'high' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

/**
 * Temperament reaches the model as system text, or not at all.
 *
 * Appended rather than interpolated so the shipped prompt stays readable on
 * its own and a missing preference leaves it byte-identical.
 */
function withGuidance(system: string, guidance: string | undefined): string {
  const extra = guidance?.trim();
  return extra ? `${system}\n\n${extra}` : system;
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
