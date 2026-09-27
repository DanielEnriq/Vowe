import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { applyOps, EMPTY_MODEL, type ConsultationFinding, type DesignCapabilities, type DesignOp, type DesignTurn } from '@vowe/core';

import { AnthropicSystemDesignAgent, readNote } from '../src/anthropic-system-design-agent.js';

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
  design: {
    model: applyOps(EMPTY_MODEL, [
      { op: 'design', title: 'Draft' },
      { op: 'part', id: 'observer', name: 'Observer', role: 'Watches a session', today: true },
    ]).model,
    revision: 1,
  },
  moves: [{ id: 'mv-00000001', author: 'vowe', via: 'conversation', summary: 'Drew the observer.' }],
  focus: { kind: 'part', id: 'observer', label: 'Observer' },
  conversation: [{ speaker: 'developer', text: 'Hello' }, { speaker: 'vowe', text: 'Hi.' }],
  findings: [{ question: 'Is it durable?', answer: 'No.', refs: ['repo:/r/a.ts'], at: '2026-09-26T00:00:00.000Z' }],
  signal: new AbortController().signal,
};

const FINDING: ConsultationFinding = {
  status: 'answered', answer: 'The observer is per session.', confidence: 'confirmed',
  refs: [{ kind: 'repo', path: '/r/observer-runner.ts', line: 12 }], provider: 'Claude Code', durationMs: 900, inspected: [],
};

const OPS: DesignOp[] = [
  { op: 'part', id: 'project-understanding', name: 'Project Understanding', role: 'Durable understanding', detail: 'The observer is per session ([runner](ref:repo:/r/observer-runner.ts#12)).' },
  { op: 'link', from: 'observer', to: 'project-understanding' },
];
const WHY = 'The observer is per-session, so durable understanding moved above it.';
/** A move block, split into the fragments a provider might send. */
const BLOCK = `\n\n<design_move>\n<why>${WHY}</why>\n${OPS.map((op) => JSON.stringify(op)).join('\n')}\n</design_move>`;
const fragments = (text: string, size: number): string[] =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

describe('AnthropicSystemDesignAgent', () => {
  it('consults, continues with the finding, and streams the move beside the reply', async () => {
    const bodies: Record<string, unknown>[] = [];
    const asked: { question: string; why: string; part?: string }[] = [];
    const capabilities: DesignCapabilities = {
      consultRepository: async (request) => { asked.push(request); return FINDING; },
    };
    const design = agent([
      start() + thinking(0, ['placement depends on ', 'lifecycle']) +
        text(1, ['That fits. ', 'I want to check the observer.']) +
        tool(2, 'consult_repository', ['{"question":"Is observer coverage durable?",', '"why":"placement","part":"observer"}']) + stop('tool_use'),
      // The marker itself arrives split, as a real stream may split it.
      start() + text(0, ['I checked it: ', 'it is per session.', ...fragments(BLOCK, 7)]) + stop('end_turn'),
    ], bodies);

    const messages: string[] = [];
    const reasoning: string[] = [];
    const moves: DesignOp[][] = [];
    const result = await design.turn(INPUT, capabilities, undefined, {
      message: (delta) => messages.push(delta),
      reasoning: (delta) => reasoning.push(delta),
      move: (ops) => moves.push(ops),
    });

    expect(asked).toEqual([{ question: 'Is observer coverage durable?', why: 'placement', part: 'observer' }]);
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.stream === true)).toBe(true);
    // One tool only: a move is text, not a tool call.
    expect((bodies[0]!.tools as { name: string }[]).map((tool) => tool.name)).toEqual(['consult_repository']);
    // The second request carries the consultation's result.
    const second = bodies[1]!.messages as { role: string; content: unknown }[];
    expect(second.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(second[2]!.content)).toContain('The observer is per session.');
    expect(JSON.stringify(second[2]!.content)).toContain('repo:/r/observer-runner.ts#12');
    // The first request carried the whole design context.
    const opening = JSON.stringify((bodies[0]!.messages as { content: unknown }[])[0]!.content);
    expect(opening).toContain('observer: \\"Observer\\" — Watches a session [exists today]');
    expect(opening).toContain('mv-00000001 (you): Drew the observer.');
    expect(opening).toContain('selected the part Observer (id observer)');
    expect(opening).toContain('Is it durable?');
    expect(opening).toContain('Developer: I think Project Understanding should sit above the observer.');

    // Whitespace before the block is kept, so the stream and the result match exactly.
    expect(result.reply.trimEnd()).toBe('That fits. I want to check the observer.\n\nI checked it: it is per session.');
    // The conversation never saw any of the block, and saw exactly the reply.
    expect(messages.join('')).toBe(result.reply);
    expect(messages.join('')).not.toContain('<');
    expect(reasoning.join('')).toBe('placement depends on lifecycle');
    expect(result.move).toEqual({ ops: OPS, summary: WHY });
    // The move streamed op by op, and the last view is the committed move.
    expect(moves.map((ops) => ops.length)).toEqual([1, 2]);
    expect(moves.at(-1)).toEqual(OPS);
  });

  it('returns no move when the design did not change', async () => {
    const design = agent([start() + text(0, ['Conceptually above. ', 'I do not yet know if the code supports it.']) + stop('end_turn')]);
    const result = await design.turn(INPUT, { consultRepository: async () => FINDING });
    expect(result).toEqual({ reply: 'Conceptually above. I do not yet know if the code supports it.' });
  });

  it('commits what the provider sent even when a view throws', async () => {
    const design = agent([start() + text(0, ['one ', 'two', BLOCK]) + stop('end_turn')]);
    const result = await design.turn(INPUT, { consultRepository: async () => FINDING }, undefined, {
      message: () => { throw new Error('view broke'); },
      move: () => { throw new Error('view broke'); },
    });
    expect(result.reply.trimEnd()).toBe('one two');
    expect(result.move?.ops).toEqual(OPS);
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

  it('reads a considered note, and treats anything else as silence', () => {
    expect(readNote('none')).toBeNull();
    expect(readNote('{"on":"observer","text":"Nothing persists session state now."}')).toEqual({ on: 'observer', text: 'Nothing persists session state now.' });
    expect(readNote('Sure! {"on":1}')).toBeNull();
  });

  it('gives up on a round that goes silent instead of hanging the turn', async () => {
    const fetch = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // As real fetch does: an abort errors the body.
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
        controller.enqueue(new TextEncoder().encode(start() + text(0, ['Thinking about ']).replace(/event: content_block_stop[\s\S]*$/, '')));
        // …and then nothing, ever.
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof globalThis.fetch;
    const design = new AnthropicSystemDesignAgent({ client: new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 }), stallMs: 60 });
    await expect(design.turn(INPUT, { consultRepository: async () => FINDING })).rejects.toThrow(/stopped responding/);
  });
});
