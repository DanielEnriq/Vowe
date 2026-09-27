import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

import {
  formatRef,
  type ConsultationFinding,
  type DesignCapabilities,
  type DesignConsideration,
  type DesignNote,
  type DesignStream,
  type DesignTurn,
  type DesignTurnResult,
  type ModelTrace,
  type ModelUsage,
  type SystemDesignAgent,
} from '@vowe/core';

import { addUsage, reportReasoning, withGuidance } from './anthropic-shared.js';
import { DesignTextStream, splitDesignText } from './design-text.js';
import { CONSIDER_SYSTEM, STUDIO_SYSTEM, renderConsideration, renderDesignTurn } from './studio-prompts.js';

export const CONSULT_REPOSITORY = 'consult_repository';

export interface AnthropicSystemDesignAgentOptions {
  client: Anthropic;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Ceiling on model requests per turn. Consultations are capped separately. */
  maxIterations?: number;
  /**
   * How long a model round may go without sending anything before the turn
   * gives up. A gateway can hold a stream open and silent indefinitely.
   */
  stallMs?: number;
}

/**
 * The first `SystemDesignAgent`: Claude, with one tool.
 *
 * `consult_repository` is the agent's one capability, handed in per turn by
 * `StudioService`. A move is not a tool call: it is a delimited block of JSON
 * lines at the end of the turn's text (see `design-text.ts`), because text
 * streams through every endpoint and a tool's input may not.
 *
 * One streamed tool loop, reported as it happens: reply text from every round
 * to `message`, thinking to `reasoning`, and the move's ops to `move` as each
 * line is written. The result is split from the *final*
 * messages by the same function the stream uses — so what was shown and what
 * is committed cannot differ.
 */
export class AnthropicSystemDesignAgent implements SystemDesignAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high';
  private readonly maxIterations: number;
  private readonly stallMs: number;

  constructor(options: AnthropicSystemDesignAgentOptions) {
    this.client = options.client;
    this.model = options.model ?? 'claude-sonnet-5';
    this.effort = options.effort ?? 'medium';
    this.maxIterations = options.maxIterations ?? 8;
    this.stallMs = options.stallMs ?? 120_000;
  }

  /**
   * The same credential and endpoint Vowe's other models use, or `undefined`
   * when none is configured — Studio then says it needs a model rather than
   * pretending to think. `VOWE_STUDIO_MODEL` picks a different model for
   * design conversation than for observation, which runs far more often.
   */
  static fromEnvironment(): AnthropicSystemDesignAgent | undefined {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) return undefined;
    const baseURL = process.env.VOWE_LLM_BASE_URL;
    const model = process.env.VOWE_STUDIO_MODEL || process.env.VOWE_LLM_MODEL;
    return new AnthropicSystemDesignAgent({
      client: new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) }),
      ...(model ? { model } : {}),
    });
  }

  async turn(
    input: DesignTurn,
    capabilities: DesignCapabilities,
    trace?: ModelTrace,
    stream?: DesignStream,
  ): Promise<DesignTurnResult> {
    // The developer's stop, or a round that went silent. A consultation runs
    // between rounds, so its tens of seconds never count as silence.
    const stop = new AbortController();
    const cancel = () => stop.abort(input.signal.reason);
    input.signal.addEventListener('abort', cancel, { once: true });
    let stalled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const quiet = () => { if (watchdog) clearTimeout(watchdog); watchdog = null; };
    const listen = () => {
      quiet();
      watchdog = setTimeout(() => { stalled = true; stop.abort(new Error('stalled')); }, this.stallMs);
    };
    const runner = this.client.beta.messages.toolRunner(
      {
        model: this.model,
        max_tokens: 16000,
        system: withGuidance(STUDIO_SYSTEM, input.guidance),
        ...tuned(this.model, this.effort),
        tools: [consultTool(capabilities)],
        max_iterations: this.maxIterations,
        messages: [{ role: 'user', content: renderDesignTurn(input) }],
        stream: true,
      },
      { signal: stop.signal },
    );
    trace?.input(runner.params, { provider: 'anthropic', model: this.model });

    const usage: ModelUsage = {};
    /** Every text block, in order, as the final messages hold them. */
    const blocks: string[] = [];
    const text = new DesignTextStream(
      (delta) => emit(stream?.message, delta),
      (ops) => {
        if (!stream?.move) return;
        try {
          stream.move(ops);
        } catch {
          // A view never participates in the work.
        }
      },
    );
    let streamed = false;

    try {
      for await (const round of runner) {
        if (!('on' in round)) continue;
        listen();
        let opened = false;
        round.on('streamEvent', (event) => {
          listen();
          if (event.type === 'content_block_start') opened = event.content_block.type === 'text';
        });
        round.on('text', (delta) => {
          if (!delta) return;
          // A new text block after earlier text is a new paragraph, on screen as
          // in the committed reply.
          if (opened && streamed) text.push('\n\n');
          opened = false;
          streamed = true;
          text.push(delta);
        });
        round.on('thinking', (delta) => emit(stream?.reasoning, delta));

        const message = await round.finalMessage();
        quiet();
        reportReasoning(trace, message.content);
        addUsage(usage, message);
        for (const block of message.content) {
          if (block.type === 'text' && block.text) blocks.push(block.text);
        }
      }
    } catch (error) {
      if (stalled && !input.signal.aborted) {
        throw new Error(`The model stopped responding for ${Math.round(this.stallMs / 1000)}s, so I gave up on this turn.`);
      }
      throw error;
    } finally {
      quiet();
      input.signal.removeEventListener('abort', cancel);
    }
    text.finish();

    const split = splitDesignText(blocks.join('\n\n'));
    const move = split.move?.ops.length ? { ops: split.move.ops, summary: split.move.summary } : undefined;
    trace?.output({
      text: split.reply,
      ...(split.move ? { payload: { move, unreadableLines: split.move.unreadable } } : {}),
      usage,
    });
    return move ? { reply: split.reply, move } : { reply: split.reply };
  }

  async consider(input: DesignConsideration, trace?: ModelTrace): Promise<DesignNote | null> {
    const params = {
      model: this.model,
      max_tokens: 400,
      system: CONSIDER_SYSTEM,
      messages: [{ role: 'user' as const, content: renderConsideration(input) }],
    };
    trace?.input(params, { provider: 'anthropic', model: this.model });
    const message = await this.client.messages.create(params, { signal: input.signal });
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim();
    trace?.output({ text });
    return readNote(text);
  }
}

/** `{"on": id, "text": …}` or `none`. Anything else is no note. */
export function readNote(text: string): DesignNote | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const value = JSON.parse(json) as { on?: unknown; text?: unknown };
    return typeof value.on === 'string' && typeof value.text === 'string' && value.text.trim()
      ? { on: value.on, text: value.text.trim() }
      : null;
  } catch {
    return null;
  }
}

function consultTool(capabilities: DesignCapabilities) {
  return betaZodTool({
    name: CONSULT_REPOSITORY,
    description:
      'Ask a coding harness a read-only question about the actual code in this repository. It reads the code and answers with the files it rests on. Slow (tens of seconds): use only when an unknown implementation fact materially affects the design.',
    inputSchema: z.object({
      question: z.string().describe('One specific, self-contained question about what the implementation does.'),
      why: z.string().describe('Why the answer matters to the design, in one sentence.'),
      part: z.string().optional().describe('The id of the part on the design this question is about, if any.'),
    }),
    run: async ({ question, why, part }) =>
      renderFinding(await capabilities.consultRepository({ question, why, ...(part ? { part } : {}) })),
  });
}

/** What the model is shown of a finding: the answer and what it may cite. */
function renderFinding(finding: ConsultationFinding): string {
  if (finding.status !== 'answered') {
    return `The repository could not be checked (${finding.status}): ${finding.reason}\nTreat this point as unchecked.`;
  }
  const refs = finding.refs.map(formatRef);
  return [
    `Finding (${finding.confidence}): ${finding.answer}`,
    refs.length ? `References you may cite: ${refs.join(', ')}` : 'No files were cited.',
  ].join('\n');
}

function tuned(model: string, effort: 'low' | 'medium' | 'high') {
  const adaptive = !/claude-haiku-4|claude-3/.test(model);
  return adaptive
    ? { thinking: { type: 'adaptive' as const }, output_config: { effort } }
    : {};
}

/** A view never participates in the work: a throwing listener is swallowed. */
function emit(method: ((value: string) => void) | undefined, value: string): void {
  if (!method || !value) return;
  try {
    method(value);
  } catch {
    // Deliberately ignored.
  }
}
