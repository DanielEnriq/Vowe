import type {
  ObserveWindowInput,
  ObserverEventLine,
} from '../llm/observation-llm.js';

/**
 * The observer's standing instruction.
 *
 * Note what this is not: it is not "summarize this chunk". A summarizer treats
 * each window as an independent document and produces prose nobody reads. The
 * observer is following one continuous piece of work, and its job on each window
 * is to *update* an understanding — which means noticing what changed, what is
 * happening now, and whether anything deserves a human's attention.
 *
 * The grounding rule is the same one the rest of Vowe already follows: the
 * evidence is the trace, and nothing may be claimed that the trace does not
 * support.
 */
export const OBSERVER_SYSTEM = `You are following a software engineer's coding agent as it works, over a long session, one portion of its trace at a time.

You are given your current understanding of this worker and new evidence. The question you are answering is never "summarize these events". It is: **what changed in my understanding of this worker?**

Rules:
- Describe only what the trace supports. Never invent a file, error, command, decision or outcome that does not appear in the evidence you were given.
- You are continuing, not starting over. Do not restate what you already understood; say what is different now.
- Never put an opaque identifier, a tool name or tool syntax in anything you write. A person reads this, not a trace.
- If the evidence is thin, say so plainly rather than padding.

What to report:
- "understanding" is where the work stands *now*, rewritten so it reads on its own without the previous version. One to three short sentences, about sixty words. Present state and what is unresolved — not a history of how it got here. If your understanding did not change, restate it unchanged.
- "summary" is a short paragraph of prose about this portion — what a colleague watching over the engineer's shoulder would say happened. Findings and consequences, not a list of tool calls.
- "currentActivity" is one sentence about what the worker is doing as of the end of this portion.
- "notableChange" is a durable update: something that should materially change what the engineer believes about this worker. A finding, a change of approach, a result, a stall, a repeated failure, a completion.
  Omit it for ordinary progress. **Most portions warrant no durable update, and omitting it is the expected outcome, not a failure.** "The worker read several files and made changes" is not a durable update. "The worker found that session histories branch through parent ids and is preserving that structure in provenance" is.
  Do not repeat a durable update you have already given, in other words.

Tools:
- Call surface_update when you believe a development may be worth bringing to the human's attention. It does NOT speak to them — it proposes, and a separate policy decides. Give a concrete message, say why it matters now, and cite references. Do not call it for routine progress.
- When you have search_context, open_context and get_diff, use them if this portion of the trace is ambiguous on its own — to find what an earlier decision was, what a failing command actually printed, or what a change did. Cite what you looked at.`;

/**
 * The observer's per-window message.
 *
 * Continuity is deliberately bounded. Appending every historical window would
 * grow without limit and drown the current one; the recent notes plus whatever
 * older note was judged relevant is enough to stay oriented.
 */
export function renderObserverPrompt(input: ObserveWindowInput): string {
  const parts: string[] = [];

  parts.push(`Task as the developer stated it: ${input.task ?? 'not yet known'}`);
  parts.push(`Working directory: ${input.cwd ?? 'unknown'}`);
  if (input.communicationPreference) {
    parts.push(
      `The developer asked to be told about things on these terms: "${input.communicationPreference}"`,
    );
  }

  /*
   * The understanding goes first, and above the note history on purpose. It is
   * the thing being updated; the notes below it are how it was arrived at, and
   * a model given them in the other order tends to write another note instead
   * of revising what it knows.
   */
  if (input.currentUnderstanding) {
    parts.push('', 'What you currently understand about this worker:');
    parts.push(`  ${input.currentUnderstanding}`);
  }

  if (input.relevantOlderNotes.length) {
    parts.push('', 'Earlier in this session, and possibly relevant:');
    for (const note of input.relevantOlderNotes) {
      parts.push(`  [window ${note.windowIndex}] ${note.summary}`);
    }
  }

  if (input.recentNotes.length) {
    parts.push('', 'Your understanding so far, oldest first:');
    for (const note of input.recentNotes) {
      parts.push(`  [window ${note.windowIndex}] ${note.summary}`);
      if (note.notableChange) {
        parts.push(`      durable update already given: ${note.notableChange}`);
      }
    }
  } else if (!input.currentUnderstanding) {
    parts.push('', 'You have not observed this session before. This is the beginning.');
  }

  if (input.recentMessages.length) {
    parts.push('', 'Recent messages between the developer and the worker:');
    for (const line of input.recentMessages) {
      parts.push(`  ${line.kind}: ${line.summary}`);
    }
  }

  if (input.coverage?.length) {
    parts.push('', 'Evidence coverage (do not infer missing activity):', ...input.coverage.map(c => `${c.scope}: ${c.status} — ${c.reason}`));
  }
  const { window } = input;
  parts.push(
    '',
    'Operation reports describe assertions. Unknown execution or a request is never evidence that a command ran or tests passed. Corrections supersede support, not the historical audit.',
    `New portion of the trace — window ${window.windowIndex}, events ${window.startSeq}..${window.endSeq}, ${window.startedAt} to ${window.endedAt}:`,
  );
  for (const line of window.events) {
    parts.push(`  [${line.seq}] ${line.at} ${line.kind}: ${line.summary}${line.ref ? ` (${line.ref})` : ''}`);
    if (line.detail) parts.push(`        ${line.detail}`);
  }

  parts.push(
    '',
    window.events.length === window.endSeq-window.startSeq+1
      ? `You can cite this window as trace:${input.sessionId}:${window.startSeq}-${window.endSeq}, or any individual event you were shown.`
      : 'This current view has gaps in admission sequence. Cite the individual event references shown above; a whole sequence range would include superseded audit records.',
  );

  return parts.join('\n');
}

/** Trim a detail blob down to something worth putting in front of a model. */
export function observerDetail(
  detail: Record<string, unknown> | undefined,
  limit = 400,
): string | undefined {
  if (!detail) return undefined;
  const interesting: string[] = [];
  for (const key of ['command', 'output', 'text', 'file_path', 'failed', 'input', 'execution', 'reportedSummary', 'conflict', 'evidenceBasis', 'correctionOf']) {
    const value = detail[key];
    if (value === undefined || value === null || value === '') continue;
    const rendered =
      typeof value === 'object' ? safeJson(value) : String(value);
    if (!rendered) continue;
    interesting.push(`${key}=${rendered}`);
  }
  if (!interesting.length) return undefined;
  const joined = interesting.join(' ').replace(/\s+/g, ' ');
  return joined.length > limit ? `${joined.slice(0, limit)}…` : joined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

export function toObserverEventLine(event: {
  id?: string;
  sessionId?: string;
  evidence?: {basis: string; supersedes?: string};
  seq: number;
  at: string;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
}): ObserverEventLine {
  const detail = observerDetail({...event.detail, ...(event.evidence ? {evidenceBasis:event.evidence.basis,correctionOf:event.evidence.supersedes}: {})});
  const line: ObserverEventLine = {
    ...(event.id && event.sessionId ? {ref:`event:${event.sessionId}:${event.id}`} : {}),
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    summary: event.summary,
  };
  if (detail) line.detail = detail;
  return line;
}
