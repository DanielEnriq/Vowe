import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import type {
  LlmClient,
  SemanticUpdate,
  SessionInterpretationInput,
  SessionQuestionInput,
} from '@vowe/core';

import {
  ANSWER_SYSTEM,
  SUMMARIZE_SYSTEM,
  renderInterpretationPrompt,
  renderQuestionPrompt,
} from './prompts.js';

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
export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicLlmClientOptions = {}) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? 'claude-opus-5';
  }

  /**
   * Returns a client when a credential is configured, otherwise `undefined`.
   * Callers degrade to deterministic behaviour rather than failing to start.
   */
  static fromEnvironment(
    options: AnthropicLlmClientOptions = {},
  ): AnthropicLlmClient | undefined {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return undefined;
    return new AnthropicLlmClient({ ...options, apiKey });
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
}
