import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

import {
  formatRef,
  type ConsultationFinding,
  type DesignCapabilities,
  type DesignStream,
  type DesignTurn,
  type DesignTurnResult,
  type ModelTrace,
  type ModelUsage,
  type SystemDesignAgent,
} from '@vowe/core';

import { addUsage, reportReasoning, withGuidance } from './anthropic-shared.js';
import { DesignTextStream, splitDesignText } from './design-text.js';
import { STUDIO_SYSTEM, renderDesignTurn } from './studio-prompts.js';

export const CONSULT_REPOSITORY = 'consult_repository';

export interface AnthropicSystemDesignAgentOptions {
  client: Anthropic;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Ceiling on model requests per turn. Consultations are capped separately. */
  maxIterations?: number;
}

/**
 * The first `SystemDesignAgent`: Claude, with one tool.
 *
 * `consult_repository` is the agent's one capability, handed in per turn by
 * `StudioService`. A proposed revision is not a tool call: it is a delimited
 * block at the end of the turn's text (see `design-text.ts`), because text
 * streams through every endpoint and a tool's input may not.
 *
 * One streamed tool loop, reported as it happens: reply text from every round
 * to `message`, thinking to `reasoning`, and the document inside the revision
 * block to `design` as it is written. The result is split from the *final*
 * messages by the same function the stream uses — so what was shown and what
 * is committed cannot differ.
 */
export class AnthropicSystemDesignAgent implements SystemDesignAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: 'low' | 'medium' | 'high';
  private readonly maxIterations: number;

  constructor(options: AnthropicSystemDesignAgentOptions) {
    this.client = options.client;
    this.model = options.model ?? 'claude-sonnet-5';
    this.effort = options.effort ?? 'medium';
    this.maxIterations = options.maxIterations ?? 8;
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
      { signal: input.signal },
    );
    trace?.input(runner.params, { provider: 'anthropic', model: this.model });

    const usage: ModelUsage = {};
    /** Every text block, in order, as the final messages hold them. */
    const blocks: string[] = [];
    const text = new DesignTextStream(
      (delta) => emit(stream?.message, delta),
      (document) => emit(stream?.design, document),
    );
    let streamed = false;

    for await (const round of runner) {
      if (!('on' in round)) continue;
      let opened = false;
      round.on('streamEvent', (event) => {
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
      reportReasoning(trace, message.content);
      addUsage(usage, message);
      for (const block of message.content) {
        if (block.type === 'text' && block.text) blocks.push(block.text);
      }
    }
    text.finish();

    const split = splitDesignText(blocks.join('\n\n'));
    const revision = split.revision?.document
      ? { document: split.revision.document, summary: split.revision.summary }
      : undefined;
    trace?.output({ text: split.reply, ...(revision ? { payload: { revision } } : {}), usage });
    return revision ? { reply: split.reply, revision } : { reply: split.reply };
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
    }),
    run: async (request) => renderFinding(await capabilities.consultRepository(request)),
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
