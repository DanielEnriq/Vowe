import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import type { InvestigationInput, ReadOnlyToolset } from '@vowe/core';

import { AnthropicLlmClient } from '../src/anthropic-llm-client.js';

/**
 * Does the investigation genuinely stream, and does Vowe add any chunking of
 * its own on the way out?
 *
 * Both halves are measured here rather than reasoned about, against a fake
 * transport that speaks real server-sent events. The request bodies are
 * captured, so `stream: true` is asserted where it actually matters — on the
 * wire — and not at the call site that asks for it. And because the fixture
 * decides how the SSE bytes are split, the deltas that reach
 * `InvestigationStream` can be compared one-for-one with the deltas the
 * provider sent.
 *
 * This is the leg from provider SSE through the model client. The legs after
 * it are covered elsewhere: `DelegatedQuestionRunner` forwards each delta as
 * it arrives (`investigation-progress.test.ts`), the main process sends each
 * one over IPC unbatched, and the renderer appends immediately and commits
 * once per animation frame (`live-investigation.test.ts`). Nothing on that
 * path debounces, buffers to a threshold or reveals text on a timer.
 */

interface Captured {
  bodies: Record<string, unknown>[];
}

/**
 * One SSE body, with the event boundaries the fixture chooses.
 *
 * `frames` is a list of byte-level chunks. Splitting an event across two of
 * them is the case worth having: a transport that only ever delivered whole
 * events would not tell us whether the client waits for one.
 */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const sse = (type: string, payload: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

const messageStart = (): string =>
  sse('message_start', {
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });

const messageStop = (stopReason: string): string =>
  sse('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 20 },
  }) + sse('message_stop', {});

/** A text block whose deltas are exactly the strings given. */
function textBlock(index: number, deltas: string[]): string {
  return (
    sse('content_block_start', { index, content_block: { type: 'text', text: '' } }) +
    deltas
      .map((text) =>
        sse('content_block_delta', { index, delta: { type: 'text_delta', text } }),
      )
      .join('') +
    sse('content_block_stop', { index })
  );
}

function thinkingBlock(index: number, deltas: string[]): string {
  return (
    sse('content_block_start', {
      index,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }) +
    deltas
      .map((thinking) =>
        sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking } }),
      )
      .join('') +
    sse('content_block_delta', {
      index,
      delta: { type: 'signature_delta', signature: 'sig' },
    }) +
    sse('content_block_stop', { index })
  );
}

function toolUseBlock(index: number, name: string, input: unknown): string {
  return (
    sse('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: `toolu_${index}`, name, input: {} },
    }) +
    sse('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }) +
    sse('content_block_stop', { index })
  );
}

/** The provider's own chunking of the answer, which the test asserts against. */
const ANSWER_DELTAS = [
  '## What happens\n\n',
  'The reconnect path ',
  'retries twice and then ',
  'gives up.',
];
const THINKING_DELTAS = ['the trace is ', 'the place to look'];
const LOOKING_DELTAS = ['Checking the reconnect path.'];

function client(captured: Captured, frames: string[][]): AnthropicLlmClient {
  let round = 0;
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.bodies.push(JSON.parse(String(init?.body ?? '{}')));
    const body = frames[Math.min(round, frames.length - 1)]!;
    round += 1;
    return sseResponse(body);
  }) as unknown as typeof globalThis.fetch;

  return new AnthropicLlmClient({
    client: new Anthropic({ apiKey: 'test', fetch, maxRetries: 0 }),
  });
}

const INPUT: InvestigationInput = {
  sessionId: 'claude-code:abc',
  question: 'why does the reconnect give up?',
  task: null,
  cwd: null,
  recentNotes: [],
  liveConversation: [],
};

/** Read-only tools that are never reached: the fixture answers immediately. */
const TOOLS: ReadOnlyToolset = {
  searchContext: async () => ({ hits: [] }),
  openContext: async () => ({ ref: { kind: 'repo', path: 'x' }, content: '', truncated: false }),
  getDiff: async () => ({ diff: '', stat: '' }),
};

describe('Investigation streaming — the request boundary', () => {
  it('sends stream: true on every round of the investigation', async () => {
    const captured: Captured = { bodies: [] };
    const llm = client(captured, [
      [
        messageStart() +
          thinkingBlock(0, THINKING_DELTAS) +
          textBlock(1, LOOKING_DELTAS) +
          toolUseBlock(2, 'record_answer', {
            spokenAnswer: 'It retries twice and gives up.',
            refs: [],
          }) +
          messageStop('tool_use'),
      ],
      [messageStart() + textBlock(0, ANSWER_DELTAS) + messageStop('end_turn')],
    ]);

    await llm.investigate(INPUT, TOOLS);

    // Two rounds: the looking round and the writing round.
    expect(captured.bodies).toHaveLength(2);
    for (const body of captured.bodies) {
      expect(body.stream).toBe(true);
    }
  });

  /**
   * The two-phase shape, on the wire: the writing round is the same request
   * with its tools left in place and forbidden, which is what keeps the prompt
   * prefix cacheable and the evidence in front of the model.
   */
  it('writes the answer with tools present but disallowed', async () => {
    const captured: Captured = { bodies: [] };
    const llm = client(captured, [
      [
        messageStart() +
          toolUseBlock(0, 'record_answer', { spokenAnswer: 'Twice.', refs: [] }) +
          messageStop('tool_use'),
      ],
      [messageStart() + textBlock(0, ANSWER_DELTAS) + messageStop('end_turn')],
    ]);

    await llm.investigate(INPUT, TOOLS);

    const [looking, writing] = captured.bodies;
    expect(looking?.tool_choice).toBeUndefined();
    expect(writing?.tool_choice).toEqual({ type: 'none' });
    expect(Array.isArray(writing?.tools)).toBe(true);
  });
});

describe('Investigation streaming — Vowe adds no chunking', () => {
  it('forwards every provider delta, unaltered and in order', async () => {
    const captured: Captured = { bodies: [] };
    const llm = client(captured, [
      [
        messageStart() +
          thinkingBlock(0, THINKING_DELTAS) +
          textBlock(1, LOOKING_DELTAS) +
          toolUseBlock(2, 'record_answer', { spokenAnswer: 'Twice.', refs: [] }) +
          messageStop('tool_use'),
      ],
      [messageStart() + textBlock(0, ANSWER_DELTAS) + messageStop('end_turn')],
    ]);

    const reasoning: string[] = [];
    const answer: string[] = [];
    const result = await llm.investigate(INPUT, TOOLS, undefined, {
      reasoning: (delta) => reasoning.push(delta),
      answer: (delta) => answer.push(delta),
    });

    /*
     * One call per provider delta. Not "the same text in the end" — the same
     * *events*, so nothing on this leg accumulated to a threshold before
     * passing anything on. If chunkiness is visible in the room, it is the
     * provider's chunking that is visible.
     */
    expect(answer).toEqual(ANSWER_DELTAS);

    // Reasoning and prose emitted while still looking share one lane, in order.
    expect(reasoning).toEqual([...THINKING_DELTAS, ...LOOKING_DELTAS]);

    // And the persisted answer is the final message, not the deltas someone
    // happened to be watching.
    expect(result.fullAnswer).toBe(ANSWER_DELTAS.join(''));
  });

  /**
   * The provider decides where its bytes are cut, including mid-event. The
   * deltas that come out must not change because of it.
   */
  it('is unaffected by where the transport splits the SSE bytes', async () => {
    const round1 =
      messageStart() +
      toolUseBlock(0, 'record_answer', { spokenAnswer: 'Twice.', refs: [] }) +
      messageStop('tool_use');
    const round2 = messageStart() + textBlock(0, ANSWER_DELTAS) + messageStop('end_turn');

    const byte = (text: string): string[] => text.split('');
    const halves = (text: string): string[] => [
      text.slice(0, Math.floor(text.length / 2)),
      text.slice(Math.floor(text.length / 2)),
    ];

    for (const split of [byte, halves, (text: string) => [text]]) {
      const captured: Captured = { bodies: [] };
      const llm = client(captured, [split(round1), split(round2)]);
      const answer: string[] = [];
      await llm.investigate(INPUT, TOOLS, undefined, {
        reasoning: () => undefined,
        answer: (delta) => answer.push(delta),
      });
      expect(answer).toEqual(ANSWER_DELTAS);
    }
  });

  /** A view is never a participant: a listener that throws cannot fail the work. */
  it('survives a listener that throws', async () => {
    const captured: Captured = { bodies: [] };
    const llm = client(captured, [
      [
        messageStart() +
          toolUseBlock(0, 'record_answer', { spokenAnswer: 'Twice.', refs: [] }) +
          messageStop('tool_use'),
      ],
      [messageStart() + textBlock(0, ANSWER_DELTAS) + messageStop('end_turn')],
    ]);

    const result = await llm.investigate(INPUT, TOOLS, undefined, {
      reasoning: () => {
        throw new Error('the view fell over');
      },
      answer: () => {
        throw new Error('the view fell over');
      },
    });
    expect(result.fullAnswer).toBe(ANSWER_DELTAS.join(''));
  });
});
