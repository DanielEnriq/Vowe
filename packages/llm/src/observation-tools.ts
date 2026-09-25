import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { renderDiff } from '@vowe/core';

import type {
  ObserverToolset,
  ReadOnlyToolset,
  WindowObservation,
} from '@vowe/core';

/**
 * Tool definitions shared by the observer and the investigator.
 *
 * Both terminal tools follow the same pattern: the model reports its conclusion
 * by *calling a tool* rather than by emitting constrained output. That is a
 * deliberate choice. Structured-output support varies between the first-party
 * API and the gateways people actually run this through, while tool use is
 * uniform — so an answer-as-a-tool works identically everywhere, and the schema
 * is still enforced by Zod on the way in.
 */

const RefsField = z
  .array(z.string())
  .optional()
  .describe(
    'References to the material this is based on, exactly as they appeared in search or open results, e.g. "trace:claude-code:abc:120-160".',
  );

export interface ObservationCapture {
  observation: WindowObservation | null;
}

/** The observer's terminal tool: one call, and the window is interpreted. */
export function recordObservationTool(capture: ObservationCapture) {
  return betaZodTool({
    name: 'record_observation',
    description:
      'Report what changed in your understanding of this worker. Call this exactly once, when you are done looking.',
    inputSchema: z.object({
      understanding: z
        .string()
        .optional()
        .describe(
          'Where the work stands now, rewritten so it reads on its own without the previous version. One to three short sentences, about sixty words: present state and what is unresolved, not a history of how it got here. Restate it unchanged if nothing changed.',
        ),
      summary: z
        .string()
        .describe(
          'A short paragraph: what happened in this portion, continuing from what you already understood.',
        ),
      currentActivity: z
        .string()
        .optional()
        .describe('One sentence on what the worker is doing as of the end of this portion.'),
      notableChange: z
        .string()
        .optional()
        .describe(
          'A durable update: something that should materially change what the engineer believes about this worker — a finding, a change of approach, a result, a stall, a repeated failure, a completion. OMIT IT for ordinary progress. Most portions warrant none, and omitting it is the expected outcome rather than a failure. Never repeat an update you have already given.',
        ),
      refs: RefsField,
    }),
    run: async (input) => {
      const observation: WindowObservation = { summary: input.summary };
      if (input.understanding) observation.understanding = input.understanding;
      if (input.currentActivity) observation.currentActivity = input.currentActivity;
      if (input.notableChange) observation.notableChange = input.notableChange;
      if (input.refs?.length) observation.refs = input.refs;
      capture.observation = observation;
      return 'Recorded.';
    },
  });
}

export interface AnswerCapture {
  spokenAnswer: string | null;
  refs: string[];
}

/**
 * The investigator's terminal tool, by name.
 *
 * Exported because the investigation loop has to recognise the call in a
 * message's own content rather than waiting for the tool to have run. See
 * `drainInvestigation`.
 */
export const RECORD_ANSWER = 'record_answer';

/**
 * The investigator's terminal tool: "I have looked enough."
 *
 * It deliberately does **not** carry the written answer. A tool call is one
 * opaque JSON payload that exists only once it is complete, so an answer
 * generated inside it cannot be read until all of it has been written — which
 * is exactly the frozen gap this tool used to produce. What the model reports
 * here is the short spoken form, which voice needs immediately, and the
 * evidence it stands on. The written answer is generated afterwards, with the
 * tools taken away, as text that can be streamed as it is composed.
 */
export function recordAnswerTool(capture: AnswerCapture, writingInstruction = 'Now write the full answer.') {
  return betaZodTool({
    name: RECORD_ANSWER,
    description:
      'Report that you have enough evidence to answer. Call this exactly once, when you have finished looking. You will then be asked to write the full answer.',
    inputSchema: z.object({
      spokenAnswer: z
        .string()
        .describe(
          'What a colleague would say out loud: one or two sentences, leading with the answer itself.',
        ),
      refs: RefsField,
    }),
    run: async (input) => {
      capture.spokenAnswer = input.spokenAnswer;
      capture.refs = input.refs ?? [];
      return `Recorded. ${writingInstruction}`;
    },
  });
}

/**
 * The observer's communication primitive.
 *
 * Present on every observer pass without exception. Calling it does not speak
 * to anyone — that is stated in the description too, because a model that
 * thinks it is interrupting the user will use it far more sparingly than it
 * should.
 */
export function surfaceUpdateTool(toolset: ObserverToolset) {
  return betaZodTool({
    name: 'surface_update',
    description:
      'Propose that this development may be worth bringing to the human\'s attention. This does NOT speak to them — it records a candidate, and a separate policy decides whether, and how, they hear about it. Use it for meaningful progress, a milestone, something weird, a possible stall, a surprising discovery, a completion, or an important change of approach. Do not use it for routine progress.',
    inputSchema: z.object({
      message: z
        .string()
        .describe('What you would tell them, in one or two plain sentences.'),
      whyNow: z
        .string()
        .describe('Why this is worth their attention at this moment.'),
      refs: RefsField,
      urgency: z.enum(['low', 'normal', 'high']).optional(),
    }),
    run: async (input) => {
      const update = await toolset.surfaceUpdate({
        message: input.message,
        whyNow: input.whyNow,
        ...(input.refs ? { refs: input.refs } : {}),
        ...(input.urgency ? { urgency: input.urgency } : {}),
      });
      return `Recorded as a candidate (${update.id}). Whether the developer hears it is decided separately.`;
    },
  });
}

/**
 * The three read tools, identical for the observer and the investigator.
 *
 * Results come back as text rather than JSON on purpose: the model reads them,
 * and a rendered hit list with its reference strings visible is both cheaper
 * and easier to cite from than nested objects.
 */
export function readTools(read: ReadOnlyToolset) {
  return [
    betaZodTool({
      name: 'search_context',
      description:
        'Search Vowe knowledge and the repository. Project scope uses repo and observations across sessions; session scope can also search its windows, trace, and transcript. Returns references and short snippets — open what looks relevant.',
      inputSchema: z.object({
        query: z.string().describe('Words to look for.'),
        sources: z
          .array(z.enum(['windows', 'trace', 'transcript', 'repo', 'observations']))
          .optional()
          .describe(
            'At project scope use observations (understanding across sessions) and repo (working tree). At session scope windows = earlier interpretations, trace = raw events, transcript = developer/worker messages. Omit sources to use the correct defaults for the current scope.',
          ),
        limit: z.number().int().min(1).max(40).optional(),
      }),
      run: async (input) => {
        const hits = await read.searchContext({
          query: input.query,
          ...(input.sources ? { sources: input.sources } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });
        if (!hits.length) return 'No matches.';
        return hits
          .map((hit) => `${hit.refId}\n  ${hit.label} — ${hit.snippet}`)
          .join('\n');
      },
    }),

    betaZodTool({
      name: 'open_context',
      description:
        'Open something a search returned, to see it in detail. Pass a reference exactly as it was printed.',
      inputSchema: z.object({
        ref: z.string().describe('A reference from a search result.'),
        depth: z
          .enum(['summary', 'full', 'raw'])
          .optional()
          .describe(
            'summary = orientation, full = the normalized material (default), raw = the coding agent\'s own record, for when output was truncated.',
          ),
      }),
      run: async (input) => {
        const result = await read.openContext({
          ref: input.ref,
          ...(input.depth ? { depth: input.depth } : {}),
        });
        if (result.notFound) return result.notFound;
        const related = result.related.length
          ? `\n\nAlso openable: ${result.related.map(refString).join(', ')}`
          : '';
        return `[${result.refId}]\n${result.content}${related}`;
      },
    }),

    betaZodTool({
      name: 'get_diff',
      description:
        'Show what has actually changed in the working tree. The trace records that an edit happened; this shows what it did.',
      inputSchema: z.object({
        path: z.string().optional().describe('Narrow to one file.'),
        around: z
          .string()
          .optional()
          .describe('A reference to take the file path from, when you have one but not a filename.'),
      }),
      run: async (input) => {
        const diff = await read.getDiff({
          ...(input.path ? { path: input.path } : {}),
          ...(input.around ? { around: input.around } : {}),
        });
        return renderDiff(diff);
      },
    }),
  ];
}

function refString(ref: { kind: string } & Record<string, unknown>): string {
  // The navigator already formats refs; this is only for the "also openable"
  // hint, where a compact form is enough.
  if (ref.kind === 'trace') return `trace:${ref['sessionId']}:${ref['startSeq']}-${ref['endSeq']}`;
  if (ref.kind === 'event') return `event:${ref['sessionId']}:${ref['eventId']}`;
  if (ref.kind === 'window') return `window:${ref['sessionId']}:${ref['windowId']}`;
  if (ref.kind === 'repo') return `repo:${ref['path']}`;
  return ref.kind;
}
