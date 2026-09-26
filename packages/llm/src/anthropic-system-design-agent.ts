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
import { STUDIO_SYSTEM, renderDesignTurn } from './studio-prompts.js';

export const CONSULT_REPOSITORY = 'consult_repository';
export const REVISE_DESIGN = 'revise_design';

export interface AnthropicSystemDesignAgentOptions {
  client: Anthropic;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Ceiling on model requests per turn. Consultations are capped separately. */
  maxIterations?: number;
}

/**
 * The first `SystemDesignAgent`: Claude, with two tools.
 *
 * `consult_repository` is the agent's one capability, handed in per turn by
 * `StudioService`. `revise_design` is not a capability at all — it is how the
 * model proposes the next version of the design, and it is never executed:
 * the loop captures its input and ends, and the service decides whether to
 * commit it.
 *
 * One streamed tool loop, reported as it happens:
 *
 *  - every text block of every round is the reply, streamed to `message`;
 *  - thinking goes to `reasoning`;
 *  - the `revise_design` document streams to `design` as the model writes it.
 *
 * The result is assembled from the *final* messages, never from deltas, by
 * the same joining rule the stream follows — so what was shown and what is
 * committed cannot differ.
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
        tools: [consultTool(capabilities), reviseTool()],
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
    /** Whether anything has been streamed yet, for the block separator. */
    let streamed = false;
    let revision: DesignTurnResult['revision'];

    for await (const round of runner) {
      if (!('on' in round)) continue;
      let tool: string | null = null;
      let opened = false;

      round.on('streamEvent', (event) => {
        if (event.type !== 'content_block_start') return;
        tool = event.content_block.type === 'tool_use' ? event.content_block.name : null;
        opened = event.content_block.type === 'text';
      });
      round.on('text', (delta) => {
        if (!delta) return;
        // A new text block after earlier text is a new paragraph, on screen as
        // in the committed reply.
        if (opened && streamed) emit(stream?.message, '\n\n');
        opened = false;
        streamed = true;
        emit(stream?.message, delta);
      });
      round.on('thinking', (delta) => emit(stream?.reasoning, delta));
      round.on('inputJson', (_partial, snapshot) => {
        if (tool !== REVISE_DESIGN) return;
        const document = (snapshot as { document?: unknown } | null)?.document;
        if (typeof document === 'string') emit(stream?.design, document);
      });

      const message = await round.finalMessage();
      reportReasoning(trace, message.content);
      addUsage(usage, message);
      for (const block of message.content) {
        if (block.type === 'text' && block.text) blocks.push(block.text);
      }

      const revise = message.content.find(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use' && block.name === REVISE_DESIGN,
      );
      if (revise) {
        const proposed = revise.input as { document?: unknown; summary?: unknown };
        if (typeof proposed.document === 'string' && proposed.document.trim()) {
          revision = {
            document: proposed.document,
            summary: typeof proposed.summary === 'string' ? proposed.summary : '',
          };
          // The last snapshot the view saw is the document that will commit.
          emit(stream?.design, proposed.document);
        }
        // The proposal is the end of the turn. Leaving the loop here means the
        // runner never executes the tool and never sends another request —
        // its generator is closed, and its stream is already complete.
        break;
      }
    }

    const reply = blocks.join('\n\n');
    trace?.output({ text: reply, ...(revision ? { payload: { revision } } : {}), usage });
    return revision ? { reply, revision } : { reply };
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

function reviseTool() {
  return betaZodTool({
    name: REVISE_DESIGN,
    description:
      'Replace the living design document with a new version. Call only when the conversation changed the design, and only as your last action in the turn, after your reply.',
    inputSchema: z.object({
      document: z.string().describe('The whole design document, in Markdown, starting with "# " and a short title.'),
      summary: z.string().describe('Why the design changed, in one or two sentences — the idea or finding that moved it.'),
    }),
    run: async () => 'Recorded.',
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
