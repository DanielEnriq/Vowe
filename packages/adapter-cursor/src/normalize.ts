import type { AdapterEvent, EvidenceRecord } from '@vowe/core';
import type { JsonlLine } from '@vowe/adapter-kit';

export type CursorPayload = Record<string, unknown>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const shorten = (value: string) => value.replace(/\s+/g, ' ').slice(0, 240);

/** Hooks describe reports. In particular Shell completion is not execution proof. */
export function hookRecord(
  payload: CursorPayload,
  receiptId: string,
  source: string,
  at: string,
  sessionId: string,
): EvidenceRecord {
  const actorId = text(payload.conversation_id);
  const hook = text(payload.hook_event_name);
  const name = text(payload.tool_name);
  const location = { source, byteOffset: 0, line: 1 };
  const detail: Record<string, unknown> = {
    hook,
    actorId,
    toolName: name,
    input: payload.tool_input,
    workspaceRoots: payload.workspace_roots,
    callId: JSON.stringify([actorId, name, payload.tool_use_id]),
    timeBasis: 'received',
    generationId: payload.generation_id,
  };
  let kind: AdapterEvent['kind'] = 'unknown',
    summary = `Cursor reported ${hook}`;
  if (hook === 'afterAgentThought') {
    kind = 'agent_reasoning';
    detail.text = text(payload.text);
    summary = shorten(text(payload.text));
  } else if (hook === 'sessionStart') {
    kind = 'session_started';
    summary = 'Conversation observed';
  } else if (hook === 'sessionEnd' || hook === 'stop') {
    kind = 'session_waiting';
    summary = 'Provider reported a run ended';
    detail.reason = payload.reason;
  } else if (hook === 'afterFileEdit') {
    kind = 'file_changed';
    summary = `Reported edit: ${text(payload.file_path)}`;
    detail.file_path = payload.file_path;
    detail.edits = payload.edits;
  } else if (['preToolUse', 'postToolUse', 'postToolUseFailure'].includes(hook)) {
    const shell = name === 'Shell';
    kind = shell ? 'operation_reported' : hook === 'preToolUse' ? 'tool_started' : 'tool_finished';
    summary = shell
      ? hook === 'preToolUse'
        ? 'Command requested; execution is unverified'
        : 'Command result reported; execution is unverified'
      : `${name} ${hook === 'preToolUse' ? 'requested' : hook === 'postToolUseFailure' ? 'reported failure' : 'reported completion'}`;
    detail.execution = shell ? 'unknown' : undefined;
    detail.output = payload.tool_output ?? payload.error_message;
    detail.reportedOutcome =
      hook === 'postToolUse' ? 'success' : hook === 'postToolUseFailure' ? 'failure' : 'requested';
    if (!shell && hook === 'postToolUseFailure') detail.failed = true;
  }
  // These overlap generic tools or transcript messages and have no verified join.
  // Retain their raw observations without manufacturing a second semantic action.
  const supplemental = [
    'beforeShellExecution',
    'afterShellExecution',
    'beforeSubmitPrompt',
    'afterAgentResponse',
    'beforeReadFile',
    'preCompact',
  ].includes(hook);
  return {
    key: receiptId,
    raw: payload,
    location,
    events:
      supplemental || (hook === 'afterAgentThought' && !detail.text)
        ? []
        : [
            {
              slot: '0',
              basis: 'reported',
              ...(name === 'Shell' ? { execution: 'unknown' as const } : {}),
              event: { sessionId, at, kind, summary, detail, raw: payload, rawRef: location },
            },
          ],
  };
}

/** Transcript is the conversation surface. Tool-use blocks are not tool results. */
export class CursorTranscriptNormalizer {
  constructor(private context: { sessionId: string; source: string }) {}
  normalize(line: JsonlLine): AdapterEvent[] {
    const record = line.record;
    const message = record.message as
      | { content?: Array<{ type?: string; text?: string }> }
      | undefined;
    const kind =
      record.role === 'user'
        ? 'user_instruction'
        : record.role === 'assistant'
          ? 'agent_message'
          : null;
    if (!kind || !Array.isArray(message?.content)) return [];
    return message.content.flatMap((block, index) => {
      if (block.type !== 'text' || !text(block.text).trim()) return [];
      const value = text(block.text)
        .replace(/^.*?<user_query>\s*/s, '')
        .replace(/\s*<\/user_query>.*$/s, '')
        .trim();
      return [
        {
          sessionId: this.context.sessionId,
          at: new Date(0).toISOString(),
          kind,
          summary: shorten(value),
          detail: { text: value, timeBasis: 'unknown' },
          raw: record,
          rawRef: {
            source: this.context.source,
            byteOffset: line.byteOffset,
            line: line.line,
            ordinal: index,
          },
        },
      ];
    });
  }
}
