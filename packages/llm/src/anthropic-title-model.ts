import Anthropic from '@anthropic-ai/sdk';

import type { SessionTitleModel } from '@vowe/core';

/**
 * The cheapest model Vowe already has, asked to name a piece of work.
 *
 * Haiku rather than the observation model: naming is a one-line job with no
 * tools, no context and no consequence if it is merely adequate, and running
 * it on Sonnet would cost several times as much for a result nobody could tell
 * apart. It is the same provider and the same credential — no new vendor is
 * introduced for this.
 */
const TITLE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * The same model through a gateway, which names models differently.
 *
 * Chosen from the shape of the configured base URL rather than from a separate
 * setting, because there is only one thing to know here — which endpoint the
 * developer already configured — and asking them to state it twice is how the
 * two drift apart.
 */
const GATEWAY_TITLE_MODEL = 'anthropic/claude-haiku-4.5';

function titleModelFor(baseURL: string | undefined): string {
  return baseURL?.includes('openrouter') ? GATEWAY_TITLE_MODEL : TITLE_MODEL;
}

const SYSTEM = `You name software engineering tasks.

Given what a developer asked a coding agent to do, reply with a title of three to six words naming the task. Prefer a verb and its object. Never exceed 42 characters.

Return only the title. No quotes, no trailing period, no explanation, no tool or provider names, no file paths, no identifiers, no version or issue numbers.

Examples:
Implement SQLite persistence
Fix voice interruption
Port the Vowe UI
Tighten retrieval ranking`;

/**
 * Said again, harder, after a first answer broke the contract.
 *
 * Separate from the system prompt rather than always appended: a model that
 * gets it right first time should not be shouted at, and the first prompt
 * stays the one that is normally sent.
 */
const STRICTER = `Your previous answer was too long. Reply with AT MOST 6 words and AT MOST 42 characters. No sub-clauses, no parentheses, no lists. Just the short name of the task.`;

export interface AnthropicTitleModelOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  onError?: (scope: string, error: unknown) => void;
}

export class AnthropicTitleModel implements SessionTitleModel {
  readonly available: boolean;
  private readonly client: Anthropic | null;
  private readonly model: string;
  private readonly onError: (scope: string, error: unknown) => void;

  /**
   * Configured exactly like the observation client, because it is the same
   * credential and the same endpoint — only a cheaper model on the other end.
   * Reading a different variable is how this silently did nothing at all on a
   * machine that runs through a gateway.
   */
  constructor(options: AnthropicTitleModelOptions = {}) {
    const apiKey =
      options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENROUTER_API_KEY;
    const baseURL = options.baseURL ?? process.env.VOWE_LLM_BASE_URL;

    this.client = apiKey
      ? new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
      : null;
    this.available = this.client !== null;
    this.model =
      options.model ?? process.env.VOWE_TITLE_MODEL ?? titleModelFor(baseURL);
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * `null` on anything at all going wrong.
   *
   * A session without a generated title already has a readable name, so there
   * is nothing here worth surfacing as a failure — and a naming call that
   * could throw into a background loop would be a way to lose the loop.
   */
  async title(task: string, options: { stricter?: boolean } = {}): Promise<string | null> {
    if (!this.client) return null;
    try {
      const message = await this.client.messages.create({
        model: this.model,
        // A title cannot need more than this, and the ceiling is also what
        // stops a model that decided to explain itself from being expensive.
        max_tokens: 32,
        system: options.stricter ? `${SYSTEM}\n\n${STRICTER}` : SYSTEM,
        messages: [{ role: 'user', content: task }],
      });

      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      return text || null;
    } catch (error) {
      this.onError('title:anthropic', error);
      return null;
    }
  }
}
