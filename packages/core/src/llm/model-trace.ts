import type { ModelUsage } from '../types/execution.js';

/**
 * Where a model adapter reports what it just did.
 *
 * This is the seam that keeps provider detail out of the domain. A vendor
 * client knows what a thinking block is, what a `tool_use` block is and what
 * its own usage counters are called; it normalizes those into the calls below,
 * and nothing above it ever learns the vendor's vocabulary. That matters
 * because Vowe already speaks to two providers and will speak to more: a
 * `ClaudeThinkingBlock` in a core type would be a bet that it never does.
 *
 * Every method is optional to call and none of them may throw usefully — a
 * trace is a record of work, never a participant in it. Implementations buffer;
 * nothing here awaits, so instrumenting a model call cannot slow the answer
 * somebody is waiting for.
 *
 * Reporting is honest or absent. A provider that exposes no reasoning produces
 * no reasoning call, and there is deliberately nothing here for writing one
 * after the fact.
 */
export interface ModelTrace {
  /**
   * The resolved request, as it was actually sent.
   *
   * The request itself rather than a hash of it: the point is to be able to
   * read it later, replay it, and see why a model did what it did. Never audio.
   *
   * `provider` and `model` are named here because only the adapter knows them,
   * and because a run is worth far less if answering "which model was this?"
   * means reading a JSON blob rather than a column.
   */
  input(
    payload: unknown,
    options?: { text?: string; provider?: string; model?: string },
  ): void;

  /**
   * Reasoning the provider exposed.
   *
   * `summary: true` when what came back is a summary of the model's reasoning
   * rather than the reasoning itself. Getting this wrong in either direction is
   * a lie about how much of the model's thinking we actually hold.
   */
  reasoning(item: {
    text?: string;
    summary: boolean;
    payload?: unknown;
    providerItemId?: string;
  }): void;

  toolCall(item: {
    name: string;
    arguments?: unknown;
    providerItemId?: string;
  }): void;

  toolResult(item: {
    name: string;
    result?: unknown;
    error?: string;
    providerItemId?: string;
  }): void;

  output(item: { text?: string; payload?: unknown; usage?: ModelUsage }): void;

  /** Something went wrong. Whatever happened before it is still kept. */
  error(error: unknown): void;
}
