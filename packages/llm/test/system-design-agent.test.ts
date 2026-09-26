import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import type { ConsultationFinding, DesignCapabilities, DesignTurn } from '@vowe/core';

import { AnthropicSystemDesignAgent } from '../src/anthropic-system-design-agent.js';

/*
 * The design agent against a fake transport speaking real server-sent events,
 * so what is asserted is what crossed the wire: the request history the model
 * saw, which tools ran, when the loop stopped, and whether the streamed view
 * and the returned result are the same text.
 */

const sse = (type: string, payload: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

const start = (): string =>
  sse('message_start', {
    message: {
      id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
    },
  });

const stop = (reason: string): string =>
  sse('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } }) +
  sse('message_stop', {});

const text = (index: number, deltas: string[]): string =>
  sse('content_block_start', { index, content_block: { type: 'text', text: '' } }) +
  deltas.map((delta) => sse('content_block_delta', { index, delta: { type: 'text_delta', text: delta } })).join('') +
  sse('content_block_stop', { index });

const thinking = (index: number, deltas: string[]): string =>
  sse('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
  deltas.map((delta) => sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: delta } })).join('') +
  sse('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig' } }) +
  sse('content_block_stop', { index });

/** A tool call whose JSON arrives in the given fragments. */
const tool = (index: number, name: string, fragments: string[], id = `toolu_${name}`): string =>
  sse('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } }) +
  fragments.map((partial_json) => sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json } })).join('') +
  sse('content_block_stop', { index });

function agent(rounds: string[], bodies: Record<string, unknown>[] = []): AnthropicSystemDesignAgent {
  let round = 0;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    const body = rounds[round++];
    if (body === undefined) throw new Error('an unexpected extra request');
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-event, as a real transport may.
        const bytes = encoder.encode(body);
        controller.enqueue(bytes.slice(0, 37));
        controller.enqueue(bytes.slice(37));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch;
  return new AnthropicSystemDesignAgent({ client: new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 }) });
}

const INPUT: DesignTurn = {
  projectName: 'Vowe',
  message: 'I think Project Understanding should sit above the observer.',
  design: { document: '# Draft', revision: 1 },
  conversation: [{ speaker: 'developer', text: 'Hello' }, { speaker: 'vowe', text: 'Hi.' }],
  findings: [{ question: 'Is it durable?', answer: 'No.', refs: ['repo:/r/a.ts'], at: '2026-09-26T00:00:00.000Z' }],
  signal: new AbortController().signal,
};

const FINDING: ConsultationFinding = {
  status: 'answered', answer: 'The observer is per session.', confidence: 'confirmed',
  refs: [{ kind: 'repo', path: '/r/observer-runner.ts', line: 12 }], provider: 'Claude Code', durationMs: 900, inspected: [],
};

const DOCUMENT = '# Project Understanding\n\nAbove the observer ([runner](ref:repo:/r/observer-runner.ts#12)).';
const REVISE = JSON.stringify({ document: DOCUMENT, summary: 'The observer is per-session, so durable understanding moved above it.' });

describe('AnthropicSystemDesignAgent', () => {
  it('consults, continues with the finding, and ends at the revision without another request', async () => {
    const bodies: Record<string, unknown>[] = [];
    const asked: { question: string; why: string }[] = [];
    const capabilities: DesignCapabilities = {
      consultRepository: async (request) => { asked.push(request); return FINDING; },
    };
    const design = agent([
      start() + thinking(0, ['placement depends on ', 'lifecycle']) +
        text(1, ['That fits. ', 'I want to check the observer.']) +
        tool(2, 'consult_repository', ['{"question":"Is observer coverage durable?",', '"why":"placement"}']) + stop('tool_use'),
      start() + text(0, ['I checked it: ', 'it is per session.']) +
        tool(1, 'revise_design', [REVISE.slice(0, 30), REVISE.slice(30, 70), REVISE.slice(70)]) + stop('tool_use'),
    ], bodies);

    const messages: string[] = [];
    const reasoning: string[] = [];
    const documents: string[] = [];
    const result = await design.turn(INPUT, capabilities, undefined, {
      message: (delta) => messages.push(delta),
      reasoning: (delta) => reasoning.push(delta),
      design: (document) => documents.push(document),
    });

    expect(asked).toEqual([{ question: 'Is observer coverage durable?', why: 'placement' }]);
    // Exactly two requests: the loop stopped at the proposal.
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.stream === true)).toBe(true);
    // The second request carries the consultation's result.
    const second = bodies[1]!.messages as { role: string; content: unknown }[];
    expect(second.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(second[2]!.content)).toContain('The observer is per session.');
    expect(JSON.stringify(second[2]!.content)).toContain('repo:/r/observer-runner.ts#12');
    // The first request carried the whole design context.
    const opening = JSON.stringify((bodies[0]!.messages as { content: unknown }[])[0]!.content);
    expect(opening).toContain('# Draft');
    expect(opening).toContain('Is it durable?');
    expect(opening).toContain('Developer: I think Project Understanding should sit above the observer.');

    expect(result.reply).toBe('That fits. I want to check the observer.\n\nI checked it: it is per session.');
    expect(messages.join('')).toBe(result.reply);
    expect(reasoning.join('')).toBe('placement depends on lifecycle');
    expect(result.revision).toEqual({ document: DOCUMENT, summary: 'The observer is per-session, so durable understanding moved above it.' });
    // The design streamed as it was written, and the last view is the committed text.
    expect(documents.length).toBeGreaterThan(1);
    expect(documents.at(-1)).toBe(DOCUMENT);
    expect(DOCUMENT.startsWith(documents[0]!)).toBe(true);
  });

  it('returns no revision when the design did not change', async () => {
    const design = agent([start() + text(0, ['Conceptually above. ', 'I do not yet know if the code supports it.']) + stop('end_turn')]);
    const result = await design.turn(INPUT, { consultRepository: async () => FINDING });
    expect(result).toEqual({ reply: 'Conceptually above. I do not yet know if the code supports it.' });
  });

  it('commits what the provider sent even when a view throws', async () => {
    const design = agent([start() + text(0, ['one ', 'two']) + tool(1, 'revise_design', [REVISE]) + stop('tool_use')]);
    const result = await design.turn(INPUT, { consultRepository: async () => FINDING }, undefined, {
      message: () => { throw new Error('view broke'); },
      design: () => { throw new Error('view broke'); },
    });
    expect(result.reply).toBe('one two');
    expect(result.revision?.document).toBe(DOCUMENT);
  });

  it('tells the model when the repository could not be checked', async () => {
    const bodies: Record<string, unknown>[] = [];
    const design = agent([
      start() + tool(0, 'consult_repository', ['{"question":"q","why":"w"}']) + stop('tool_use'),
      start() + text(0, ['I could not check that; it stays an assumption.']) + stop('end_turn'),
    ], bodies);
    const result = await design.turn(INPUT, {
      consultRepository: async () => ({ status: 'unavailable', reason: 'Not signed in.', provider: 'Claude Code', durationMs: 1 }),
    });
    expect(JSON.stringify(bodies[1]!.messages)).toContain('could not be checked (unavailable): Not signed in.');
    expect(result.reply).toBe('I could not check that; it stays an assumption.');
  });

  it('stops when the turn is cancelled', async () => {
    const controller = new AbortController();
    const design = agent([
      start() + tool(0, 'consult_repository', ['{"question":"q","why":"w"}']) + stop('tool_use'),
      start() + text(0, ['never']) + stop('end_turn'),
    ]);
    const turn = design.turn({ ...INPUT, signal: controller.signal }, {
      consultRepository: async () => { controller.abort(); return FINDING; },
    });
    await expect(turn).rejects.toThrow();
  });
});
