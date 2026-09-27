import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyOps,
  EMPTY_MODEL,
  live,
  projectMarkdown,
  type DesignCapabilities,
  type DesignModel,
  type DesignTurn,
  type DesignTurnResult,
} from '@vowe/core';

import { ClaudeCodeConsultant } from '../../adapter-claude-code/src/consultant.js';
import { AnthropicSystemDesignAgent } from '../src/anthropic-system-design-agent.js';

/**
 * The design agent against a real model: does a first design come out as a
 * system, at whiteboard altitude, without being told how?
 *
 * Opt-in because it calls models and costs money — the start-from-code case
 * also runs Claude Code against this repository, read-only:
 *
 *   VOWE_LIVE_STUDIO=1 pnpm exec vitest run packages/llm/test/studio-design.live.test.ts
 *   VOWE_LIVE_STUDIO=1 pnpm exec vitest run packages/llm/test/studio-design.live.test.ts -t altitude
 *
 * Each case prints the design it drew as the brief `projectMarkdown` writes,
 * so a person can judge what the assertions cannot.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

/** A name that reads as code rather than as a system: a file, a path, a call, or a compound identifier. */
const CODE_NAME = /\.(ts|tsx|js|py|go|rs)\b|\/|\(\)|::|^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){1,}$|^[a-z]+(?:[A-Z][a-z0-9]+)+$/;

function sentences(text: string): number {
  return text.replace(/\[[^\]]*\]\([^)]*\)/g, 'x').split(/(?<=[.!?])\s+(?=[A-Z"“])/).filter((part) => part.trim()).length;
}

async function firstTurn(
  message: string,
  start: 'code' | 'idea',
  capabilities: DesignCapabilities,
): Promise<{ result: DesignTurnResult; model: DesignModel; refused: number }> {
  const agent = AnthropicSystemDesignAgent.fromEnvironment();
  if (!agent) throw new Error('Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.');
  const input: DesignTurn = {
    projectName: 'Vowe',
    message,
    design: null,
    moves: [],
    start,
    conversation: [],
    findings: [],
    signal: new AbortController().signal,
  };
  const result = await agent.turn(input, capabilities);
  const applied = applyOps(EMPTY_MODEL, result.move?.ops ?? []);
  console.log(`[live studio] ${message}\n\n--- reply\n${result.reply}\n\n--- why\n${result.move?.summary ?? '(no move)'}\n\n--- brief\n${projectMarkdown(applied.model)}\n\n--- model\n${JSON.stringify(applied.model, null, 1)}\n\n--- refused\n${JSON.stringify(applied.rejected)}`);
  return { result, model: applied.model, refused: applied.rejected.length };
}

const IDEAS: [string, string][] = [
  ['simple SaaS', 'An invoicing SaaS: teams sign in, send invoices and customers pay by card through Stripe. Postgres for data.'],
  ['AI product', 'Users upload long documents and get an AI summary a minute later. They should not wait on the request.'],
  ['realtime product', 'A multiplayer whiteboard: many people on one board, edits and cursors show up instantly, boards are kept forever.'],
];

describe.skipIf(!process.env.VOWE_LIVE_STUDIO)('Studio design agent (live)', () => {
  it.each(IDEAS)('drafts a %s from an idea, without claiming a repository', async (_name, message) => {
    const consulted: string[] = [];
    const { result, model, refused } = await firstTurn(message, 'idea', {
      consultRepository: async ({ question, why }) => {
        consulted.push(question);
        console.log('[live studio] consulted', JSON.stringify({ question, why }));
        return { status: 'unavailable', reason: 'No repository for this idea.', provider: 'none', durationMs: 0 };
      },
    });
    const parts = live(model.parts);
    expect(result.move).toBeDefined();
    expect(consulted).toEqual([]);
    // A refused op silently thins the design; the draft must land whole.
    expect(refused).toBe(0);
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts.length).toBeLessThanOrEqual(10);
    expect(parts.filter((part) => part.kind).length / parts.length).toBeGreaterThanOrEqual(0.8);
    expect(parts.every((part) => part.today === null)).toBe(true);
    expect(live(model.duties).length).toBeLessThanOrEqual(Math.ceil(parts.length / 3));
    expect(sentences(result.reply)).toBeLessThanOrEqual(4);
  }, 180_000);

  it('abstracts this repository to system altitude when starting from code', async () => {
    const consultant = new ClaudeCodeConsultant({ maxBudgetUsd: 0.75 });
    const findings: string[] = [];
    let started = 0;
    const { result, model, refused } = await firstTurn(
      'How do Studio, project understanding, the coding harnesses and observation relate today? Draw that neighbourhood.',
      'code',
      {
        consultRepository: async ({ question, why, part }) => {
          // Bounded as StudioService bounds a turn: counted when a check starts, since checks may run in parallel.
          if (started++ >= 2) return { status: 'failed', reason: 'Two checks already this turn.', provider: consultant.provider, durationMs: 0 };
          console.log('[live studio] consulting', JSON.stringify({ question, why, part }));
          const finding = await consultant
            .consult({ repoRoot: REPO, question, context: why, signal: new AbortController().signal })
            .catch((error: unknown) => {
              console.log('[live studio] consultation threw', error instanceof Error ? error.message : String(error));
              throw error;
            });
          findings.push(finding.status === 'answered' ? finding.answer : `${finding.status}: ${finding.reason}`);
          const { status, durationMs } = finding;
          console.log('[live studio] consulted', JSON.stringify(finding.status === 'answered'
            ? { status, confidence: finding.confidence, durationMs, costUsd: finding.costUsd, refs: finding.refs.length, inspected: finding.inspected.length }
            : { status, durationMs }));
          return finding;
        },
      },
    );
    const parts = live(model.parts);
    console.log('[live studio] findings', JSON.stringify(findings, null, 2));

    expect(result.move).toBeDefined();
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(refused).toBe(0);
    // What the repository confirmed is recorded as today.
    expect(parts.some((part) => part.today)).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts.length).toBeLessThanOrEqual(12);
    // Altitude, the point of this case: system concepts, not the files,
    // classes and functions the harness read to find them.
    // A product's own name (GitHub, WebSockets) is not code, even when it is camel-cased.
    const product = (part: (typeof parts)[number]) => part.kind === 'external' || part.technology?.name === part.name;
    const codeNamed = parts.filter((part) => !product(part) && CODE_NAME.test(part.name.trim())).map((part) => part.name);
    expect(codeNamed, `named like code: ${codeNamed.join(', ')}`).toEqual([]);
    expect(parts.filter((part) => part.kind).length / parts.length).toBeGreaterThanOrEqual(0.8);
    expect(new Set(parts.map((part) => part.kind)).size).toBeGreaterThanOrEqual(3);
    expect(live(model.duties).length).toBeLessThanOrEqual(Math.ceil(parts.length / 3));
    expect(sentences(result.reply)).toBeLessThanOrEqual(4);
  }, 600_000);
});
