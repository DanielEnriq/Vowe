import type { ModelTrace, ModelUsage } from '@vowe/core';

/** Helpers both Anthropic-backed Vowe models share. */

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
export function reportReasoning(
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

export interface UsageBearing {
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

/**
 * Add one round's counters to a loop's total.
 *
 * A tool loop is several requests, and the tokens a run cost are all of them.
 * Reporting only the last round would understate every investigation that
 * looked anything up.
 */
export function addUsage(total: ModelUsage, message: UsageBearing): void {
  const usage = message.usage;
  if (!usage) return;
  if (typeof usage.input_tokens === 'number') {
    total.inputTokens = (total.inputTokens ?? 0) + usage.input_tokens;
  }
  if (typeof usage.output_tokens === 'number') {
    total.outputTokens = (total.outputTokens ?? 0) + usage.output_tokens;
  }
}

/**
 * Temperament reaches the model as system text, or not at all.
 *
 * Appended rather than interpolated so the shipped prompt stays readable on
 * its own and a missing preference leaves it byte-identical.
 */
export function withGuidance(system: string, guidance: string | undefined): string {
  const extra = guidance?.trim();
  return extra ? `${system}\n\n${extra}` : system;
}

