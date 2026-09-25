import type { AdapterEvent, NormalizedEventKind } from '@vowe/core';
import {
  asString,
  baseName,
  firstLine,
  isTestCommand,
  oneLine,
  truncate,
  withOrdinals,
} from '@vowe/adapter-kit';

import type { PiLine, PiRecord } from './session-file.js';

/**
 * Entry types that are pi's own bookkeeping rather than the work.
 *
 * An explicit deny-list, not a fallthrough: anything not listed here and not
 * recognized below still becomes an `unknown` event carrying its raw payload.
 * We skip what we have decided is noise, never what we merely failed to read.
 */
const IGNORED_ENTRY_TYPES = new Set([
  'thinking_level_change',
  'label',
  'session_info',
  // Extension state that explicitly does not participate in the conversation.
  'custom',
]);

const FILE_WRITING_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch']);
/** Tools whose whole purpose is to stop and ask the developer something. */
const ASKING_TOOLS = new Set(['ask_user_question']);
const READING_TOOLS = new Set(['read', 'ls']);
const SEARCH_TOOLS = new Set(['grep', 'find', 'glob']);

/** How much of a thought to carry. Reasoning is by far the wordiest record. */
const MAX_REASONING = 600;

interface PendingTool {
  name: string;
  kind: NormalizedEventKind;
  label: string;
}

export interface PiNormalizerContext {
  sessionId: string;
  source: string;
}

/**
 * Turns pi session entries into normalized events.
 *
 * ## Why this reads the file in order rather than rebuilding the tree
 *
 * A pi session is a tree: entries carry `id`/`parentId`, and `/tree` or
 * `/fork` can branch it in place. Vowe's event stream is append-only and
 * ordered by sequence, so a branch switch is not expressible as a retraction.
 *
 * Rather than reconstruct the "current" branch and silently drop the rest,
 * this emits every entry in file order, which is chronological. That is the
 * truthful reading for an observer of activity: an abandoned branch's commands
 * really did run and really did edit files, and a person looking at what
 * happened in their repository should see them. The structure is not lost —
 * every event carries `detail.entryId` and `detail.parentId`, and a branch
 * switch surfaces as its own event — so anything that later wants the tree can
 * rebuild it from what was stored.
 */
export class PiSessionNormalizer {
  private readonly context: PiNormalizerContext;
  private readonly pending = new Map<string, PendingTool>();
  private sawOpeningPrompt = false;

  constructor(context: PiNormalizerContext) {
    this.context = context;
  }

  /** May produce zero, one or several events for a single entry. */
  normalize(line: PiLine): AdapterEvent[] {
    // One record, several events: each needs its own physical identity
    // or the store keeps the first and drops its siblings.
    return withOrdinals(this.normalizeRecord(line));
  }

  private normalizeRecord(line: PiLine): AdapterEvent[] {
    const { record } = line;
    const type = record.type ?? 'unknown';
    if (IGNORED_ENTRY_TYPES.has(type)) return [];

    switch (type) {
      case 'session':
        return [
          this.event(line, 'session_started', 'Session started', {
            cwd: record.cwd ?? null,
            version: record.version ?? null,
            ...(record.parentSession ? { forkedFrom: record.parentSession } : {}),
          }),
        ];
      case 'message':
      case 'custom_message':
        return this.fromMessage(line);
      case 'model_change':
        return [
          this.event(
            line,
            'unknown',
            `Switched to ${asString(record.modelId) || 'another model'}`,
            { provider: record.provider ?? null, model: record.modelId ?? null },
          ),
        ];
      case 'compaction':
        return [
          this.event(line, 'unknown', 'Compacted the conversation', {
            summary: truncate(asString(record.summary), 400),
          }),
        ];
      case 'branch_summary':
        return [
          this.event(line, 'unknown', 'Switched to another branch of this session', {
            summary: truncate(asString(record.summary), 400),
            fromId: record.fromId ?? null,
          }),
        ];
      default:
        return [
          this.event(line, 'unknown', `Unrecognized ${type} entry`, {
            entryType: type,
          }),
        ];
    }
  }

  // ----------------------------------------------------------------- messages

  private fromMessage(line: PiLine): AdapterEvent[] {
    const message = line.record.message;
    const role = asString(message?.role) || asString(line.record.customType && 'custom');
    switch (role) {
      case 'user':
        return this.fromUser(line);
      case 'assistant':
        return this.fromAssistant(line);
      case 'toolResult':
        return this.fromToolResult(line);
      case 'bashExecution':
        return this.fromBashExecution(line);
      case 'custom':
        return [
          this.event(line, 'unknown', 'An extension added context', {
            customType: line.record.customType ?? null,
          }),
        ];
      default:
        return [
          this.event(line, 'unknown', `Unrecognized ${role || 'message'} record`, {
            role: role || null,
          }),
        ];
    }
  }

  private fromUser(line: PiLine): AdapterEvent[] {
    const text = textOf(line.record.message?.content).trim();
    if (!text) return [];

    if (!this.sawOpeningPrompt) {
      this.sawOpeningPrompt = true;
      return [
        this.event(line, 'user_instruction', `Task: ${firstLine(text)}`, {
          text,
          opening: true,
        }),
      ];
    }
    return [this.event(line, 'user_instruction', firstLine(text), { text })];
  }

  private fromAssistant(line: PiLine): AdapterEvent[] {
    const blocks = contentBlocks(line.record.message?.content);
    const events: AdapterEvent[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        const text = asString(block.text).trim();
        if (text) events.push(this.event(line, 'agent_message', firstLine(text), { text }));
        continue;
      }
      if (block.type === 'thinking') {
        // pi records thinking as plain text, so unlike most providers this is
        // genuinely readable. It is still only supporting evidence — see the
        // note on `agent_reasoning` — so it is truncated like any other record
        // rather than carried whole.
        const thinking = asString(block.thinking).trim();
        if (thinking) {
          events.push(
            this.event(line, 'agent_reasoning', firstLine(thinking), {
              text: truncate(thinking, MAX_REASONING),
            }),
          );
        }
        continue;
      }
      if (block.type === 'toolCall') {
        events.push(this.fromToolCall(line, block));
      }
    }
    return events;
  }

  private fromToolCall(line: PiLine, block: Record<string, unknown>): AdapterEvent {
    const name = asString(block.name) || 'tool';
    const id = asString(block.id);
    const input = (block.arguments ?? {}) as Record<string, unknown>;

    let kind: NormalizedEventKind = 'tool_started';
    let summary = `Used ${name}`;
    /**
     * Whether this stop is the worker asking a *person* something.
     *
     * Core must not learn any provider's tool names, and a `session_waiting`
     * event alone does not say whether the pause was a question for a human.
     * Only the adapter knows, so the adapter says so here.
     */
    let awaitingHuman = false;

    if (name === 'bash') {
      const command = asString(input.command);
      const test = isTestCommand(command);
      kind = test ? 'test_started' : 'command_started';
      summary = test
        ? `Running tests: ${truncate(oneLine(command), 120)}`
        : `Ran: ${truncate(oneLine(command), 120)}`;
    } else if (FILE_WRITING_TOOLS.has(name)) {
      kind = 'file_changed';
      summary = `${name === 'write' ? 'Wrote' : 'Edited'} ${baseName(asString(input.path) || asString(input.file_path))}`;
    } else if (ASKING_TOOLS.has(name)) {
      kind = 'session_waiting';
      awaitingHuman = true;
      summary = 'Asked the developer a question';
    } else if (READING_TOOLS.has(name)) {
      summary = `Read ${baseName(asString(input.path) || asString(input.file_path))}`;
    } else if (SEARCH_TOOLS.has(name)) {
      summary = `Searched for ${truncate(asString(input.pattern) || asString(input.query), 80)}`;
    }

    if (id) this.pending.set(id, { name, kind: finishKindFor(kind), label: summary });

    return this.event(line, kind, summary, {
      tool: name,
      toolCallId: id,
      input: compactInput(name, input),
      ...(awaitingHuman ? { awaitingHuman: true } : {}),
    });
  }

  private fromToolResult(line: PiLine): AdapterEvent[] {
    const message = line.record.message;
    const id = asString(message?.toolCallId);
    const pending = id ? this.pending.get(id) : undefined;
    if (id) this.pending.delete(id);

    const failed = message?.isError === true;
    const name = asString(message?.toolName) || pending?.name || 'tool';
    const kind: NormalizedEventKind = pending?.kind ?? 'tool_finished';
    const outcome = failed ? 'failed' : 'finished';

    let summary: string;
    if (kind === 'command_finished') {
      summary = `Command ${outcome}${pending ? `: ${stripPrefix(pending.label)}` : ''}`;
    } else if (kind === 'test_finished') {
      summary = `Tests ${failed ? 'failed' : 'passed or completed'}`;
    } else {
      summary = `${name} ${outcome}`;
    }

    return [
      this.event(line, kind, truncate(summary, 160), {
        tool: name,
        toolCallId: id,
        failed,
        output: truncate(textOf(message?.content), 600),
      }),
    ];
  }

  /**
   * A command the *developer* ran inside pi, not the worker.
   *
   * Marked as such in the detail so nothing later reads it as agent action.
   * It is one completed fact rather than a start and a finish, because that is
   * how pi records it.
   */
  private fromBashExecution(line: PiLine): AdapterEvent[] {
    const message = line.record.message;
    const command = asString(message?.command);
    const exitCode = typeof message?.exitCode === 'number' ? message.exitCode : null;
    const failed = exitCode !== null && exitCode !== 0;
    const test = isTestCommand(command);

    return [
      this.event(
        line,
        test ? 'test_finished' : 'command_finished',
        `The developer ran: ${truncate(oneLine(command), 120)}`,
        {
          command: truncate(command, 400),
          byDeveloper: true,
          failed,
          exitCode,
          cancelled: message?.cancelled === true,
          output: truncate(asString(message?.output), 600),
        },
      ),
    ];
  }

  // ------------------------------------------------------------------ helpers

  private event(
    line: PiLine,
    kind: NormalizedEventKind,
    summary: string,
    detail: Record<string, unknown>,
  ): AdapterEvent {
    return {
      sessionId: this.context.sessionId,
      at: timestampOf(line.record),
      kind,
      summary,
      detail: {
        ...detail,
        // The session is a tree; these two keep every event addressable
        // within it even though the stream itself is flat.
        entryId: line.record.id ?? null,
        parentId: line.record.parentId ?? null,
      },
      raw: line.record,
      rawRef: {
        source: this.context.source,
        byteOffset: line.byteOffset,
        line: line.line,
      },
    };
  }
}

function timestampOf(record: PiRecord): string {
  const iso = asString(record.timestamp);
  if (iso) return iso;
  const epoch = record.message?.timestamp;
  if (typeof epoch === 'number') return new Date(epoch).toISOString();
  return new Date().toISOString();
}

function finishKindFor(startKind: NormalizedEventKind): NormalizedEventKind {
  switch (startKind) {
    case 'command_started':
      return 'command_finished';
    case 'test_started':
      return 'test_finished';
    case 'file_changed':
      return 'file_changed';
    case 'session_waiting':
      return 'session_waiting';
    default:
      return 'tool_finished';
  }
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null,
  );
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return contentBlocks(content)
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text))
    .join('\n');
}

function compactInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (name === 'bash') {
    return {
      command: truncate(asString(input.command), 400),
      description: asString(input.description),
    };
  }
  if (FILE_WRITING_TOOLS.has(name)) {
    return { path: asString(input.path) || asString(input.file_path) };
  }
  return {};
}

function stripPrefix(label: string): string {
  return label.replace(/^(Ran|Running tests): /, '');
}
