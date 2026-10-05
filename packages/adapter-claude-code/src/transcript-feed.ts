import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { relayOriginOf, type TranscriptDelta, type TranscriptItem } from '@vowe/core';
import path from 'node:path';

import { questionsOf } from './control.js';
import { stripNoise, textOf } from './normalize.js';
import type { ClaudeRecord } from './transcript.js';

/**
 * Fleet's transcript feed for Claude Code, built from the same records two
 * ways: the session's JSONL on disk (history, and the tail of a session Vowe
 * does not hold), and the Agent SDK messages of a session Vowe launched.
 *
 * This is not observation. The normalizer in `normalize.ts` stays the only
 * source of `NormalizedEvent`s and keeps thinking out; this keeps it in,
 * because here a person is reading the agent rather than Vowe judging it.
 *
 * Ids are what make the two sources agree. Claude Code writes each content
 * block of an API message as its own record (and the SDK streams them the
 * same way), all sharing the message's `id`; a block's id is that message id
 * plus its position among the message's blocks, which is also the `index` the
 * streaming events carry. So a streamed block, its final SDK message and its
 * line in the JSONL all name the same item.
 */

/** Tool output kept per item. The full result stays in the transcript file. */
export const TOOL_OUTPUT_LIMIT = 8 * 1024;

const INTERRUPTED = /^\[Request interrupted by user/;

/** Folds Claude Code records, in order, into transcript items. */
export class TranscriptBuilder {
  private readonly items = new Map<string, TranscriptItem>();
  /** Blocks seen so far per API message id. */
  private readonly blocks = new Map<string, number>();
  /** Tool use id -> the item it opened. */
  private readonly tools = new Map<string, string>();
  private sawTask = false;
  private cwd: string | null = null;

  /** Every item, oldest first. */
  all(): TranscriptItem[] {
    return [...this.items.values()];
  }

  get(id: string): TranscriptItem | undefined {
    return this.items.get(id);
  }

  /**
   * Fold one record. Returns the items it created or changed, so a tail can
   * send exactly those. `at` stands in for a record without a timestamp.
   */
  consume(record: ClaudeRecord, at: string = record.timestamp ?? new Date().toISOString()): TranscriptItem[] {
    if (typeof record.cwd === 'string' && record.cwd) this.cwd = record.cwd;
    if (record.isSidechain) return [];
    switch (record.type) {
      case 'assistant':
        return this.fromAssistant(record, at);
      case 'user':
        return this.fromUser(record, at);
      case 'system':
        return this.fromSystem(record, at);
      default:
        return [];
    }
  }

  /** Record an item that does not come from a record, such as a turn's end. */
  add(item: TranscriptItem): TranscriptItem {
    return this.put(item);
  }

  private put(item: TranscriptItem): TranscriptItem {
    this.items.set(item.id, item);
    return item;
  }

  private fromAssistant(record: ClaudeRecord, at: string): TranscriptItem[] {
    const message = record.message as { id?: unknown; content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
    const messageId = typeof message?.id === 'string' && message.id ? message.id : null;
    const base = messageId ? (this.blocks.get(messageId) ?? 0) : 0;
    if (messageId) this.blocks.set(messageId, base + content.length);

    const out: TranscriptItem[] = [];
    content.forEach((block, position) => {
      if (typeof block !== 'object' || block === null) return;
      const id = messageId ? blockId(messageId, base + position) : `${record.uuid ?? 'record'}:${position}`;
      switch (block.type) {
        case 'text': {
          const text = asString(block.text);
          if (text.trim()) out.push(this.put({ kind: 'assistant', id, at, text }));
          return;
        }
        case 'thinking': {
          // Claude Code may record a thinking block with its text omitted
          // (signature only). The thought happened; its words are withheld.
          const text = asString(block.thinking);
          out.push(this.put({ kind: 'thinking', id, at, text, ...(text ? {} : { redacted: true }) }));
          return;
        }
        case 'redacted_thinking':
          out.push(this.put({ kind: 'thinking', id, at, text: '', redacted: true }));
          return;
        case 'tool_use': {
          const toolUseId = asString(block.id) || id;
          const name = asString(block.name) || 'tool';
          const input = block.input ?? {};
          this.tools.set(toolUseId, id);
          if (name === 'AskUserQuestion') {
            const asked = questionsOf(isRecord(input) ? input : {});
            const only = asked.length === 1 ? asked[0] : undefined;
            out.push(
              this.put({
                kind: 'question',
                id,
                at,
                toolUseId,
                question: asked.map((q) => q.question.trim()).join('\n'),
                ...(only?.options.length ? { options: only.options } : {}),
              }),
            );
            return;
          }
          out.push(
            this.put({
              kind: 'tool',
              id,
              at,
              toolUseId,
              name,
              input,
              summary: toolSummary(name, input, this.cwd),
              status: 'running',
            }),
          );
          return;
        }
        default:
          return;
      }
    });
    return out;
  }

  private fromUser(record: ClaudeRecord, at: string): TranscriptItem[] {
    if (record.isMeta || record.isCompactSummary) return [];
    const content = record.message?.content;
    const out: TranscriptItem[] = [];

    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (!isRecord(block) || block.type !== 'tool_result') continue;
        const updated = this.settleTool(block, record.toolUseResult, at);
        if (updated) out.push(updated);
      }
    }

    const raw = textOf(content);
    if (!raw.trim()) return out;
    const id = record.uuid ?? `user:${at}`;
    if (INTERRUPTED.test(raw.trim())) {
      out.push(this.put({ kind: 'turn', id: `turn:${id}`, at, state: 'interrupted' }));
      return out;
    }
    const text = userText(raw);
    if (!text) return out;
    const origin = relayOriginOf(text) ?? (this.sawTask ? 'you' : 'task');
    this.sawTask = true;
    out.push(this.put({ kind: 'user', id, at, text, origin }));
    return out;
  }

  private settleTool(block: Record<string, unknown>, structured: unknown, at: string): TranscriptItem | null {
    const itemId = this.tools.get(asString(block.tool_use_id));
    const item = itemId ? this.items.get(itemId) : undefined;
    if (!item) return null;
    const failed = block.is_error === true;
    const text = resultText(block.content);

    if (item.kind === 'question') {
      return this.put({ ...item, answer: failed ? null : (answersOf(structured) ?? text) });
    }
    if (item.kind !== 'tool') return null;
    const truncated = text.length > TOOL_OUTPUT_LIMIT;
    return this.put({
      ...item,
      status: failed ? 'error' : 'ok',
      output: truncated ? text.slice(0, TOOL_OUTPUT_LIMIT) : text,
      ...(truncated ? { outputTruncated: true } : {}),
      endedAt: at,
    });
  }

  private fromSystem(record: ClaudeRecord, at: string): TranscriptItem[] {
    const id = record.uuid ?? `system:${at}`;
    if (record.subtype === 'turn_duration') {
      const durationMs = typeof record.durationMs === 'number' ? record.durationMs : undefined;
      return [this.put({ kind: 'turn', id: `turn:${id}`, at, state: 'completed', ...(durationMs !== undefined ? { durationMs } : {}) })];
    }
    if (record.subtype === 'compact_boundary') {
      return [this.put({ kind: 'system', id, at, text: 'Conversation compacted' })];
    }
    return [];
  }
}

/**
 * The SDK half: tees a managed session's messages into deltas.
 *
 * Partial messages arrive as `stream_event`s and become `stream` deltas under
 * the id their final block will have; each complete message then arrives
 * whole and becomes an `items` delta that replaces the stream. User text is
 * left to the transcript tail: the SDK does not echo the prompts it was given.
 */
export class LiveTranscript {
  private readonly builder = new TranscriptBuilder();
  /** Current API message id, from `message_start`. */
  private messageId: string | null = null;
  /** Streamed text per item id, for a final block recorded without its words. */
  private readonly streamed = new Map<string, string>();
  private lastCost: number | null = null;

  constructor(private readonly sessionId: string) {}

  /** Every item the SDK has delivered so far. */
  items(): TranscriptItem[] {
    return this.builder.all();
  }

  consume(message: SDKMessage): TranscriptDelta[] {
    if ('parent_tool_use_id' in message && message.parent_tool_use_id) return [];
    const at = new Date().toISOString();
    switch (message.type) {
      case 'stream_event':
        return this.fromStream(message.event as StreamEvent);
      case 'assistant': {
        const items = this.builder
          .consume({ type: 'assistant', uuid: message.uuid, message: message.message as ClaudeRecord['message'] }, at)
          .map((item) => this.builder.add(this.withStreamed(item)));
        return this.itemsDelta(items);
      }
      case 'user': {
        const items = this.builder
          .consume(
            {
              type: 'user',
              ...(message.uuid ? { uuid: message.uuid } : {}),
              message: message.message as ClaudeRecord['message'],
              toolUseResult: message.tool_use_result,
            },
            at,
          )
          .filter((item) => item.kind !== 'user' && item.kind !== 'turn');
        return this.itemsDelta(items);
      }
      case 'result':
        return this.itemsDelta([this.builder.add(this.turnOf(message, at))]);
      default:
        return [];
    }
  }

  private fromStream(event: StreamEvent): TranscriptDelta[] {
    if (event.type === 'message_start') {
      this.messageId = typeof event.message?.id === 'string' ? event.message.id : null;
      return [];
    }
    if (event.type !== 'content_block_delta' || !this.messageId || typeof event.index !== 'number') return [];
    const delta = event.delta;
    const kind = delta?.type === 'text_delta' ? 'assistant' : delta?.type === 'thinking_delta' ? 'thinking' : null;
    const textDelta = kind === 'assistant' ? asString(delta?.text) : kind === 'thinking' ? asString(delta?.thinking) : '';
    if (!kind || !textDelta) return [];
    const itemId = blockId(this.messageId, event.index);
    this.streamed.set(itemId, (this.streamed.get(itemId) ?? '') + textDelta);
    return [{ type: 'stream', sessionId: this.sessionId, itemId, kind, textDelta }];
  }

  private withStreamed(item: TranscriptItem): TranscriptItem {
    const streamed = this.streamed.get(item.id);
    this.streamed.delete(item.id);
    if (item.kind === 'thinking' && !item.text && streamed) return { kind: 'thinking', id: item.id, at: item.at, text: streamed };
    return item;
  }

  private turnOf(message: Extract<SDKMessage, { type: 'result' }>, at: string): TranscriptItem {
    const total = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null;
    // The SDK reports a running total across turns; a turn shows its own share.
    const costUsd = total === null ? undefined : this.lastCost !== null && total >= this.lastCost ? total - this.lastCost : total;
    if (total !== null) this.lastCost = total;
    const common = {
      kind: 'turn' as const,
      id: `turn:${message.uuid}`,
      at,
      ...(typeof message.duration_ms === 'number' ? { durationMs: message.duration_ms } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    const reason = (message as { terminal_reason?: string }).terminal_reason;
    if (reason === 'aborted_streaming' || reason === 'aborted_tools') return { ...common, state: 'interrupted' };
    if (message.subtype === 'success' && !message.is_error) return { ...common, state: 'completed' };
    const error = message.subtype === 'success' ? message.result : [message.subtype, ...message.errors].join(': ');
    return { ...common, state: 'failed', ...(error ? { error } : {}) };
  }

  private itemsDelta(items: TranscriptItem[]): TranscriptDelta[] {
    return items.length ? [{ type: 'items', sessionId: this.sessionId, items }] : [];
  }
}

/** The subset of the Messages API stream events the tee reads. */
interface StreamEvent {
  type: string;
  index?: number;
  message?: { id?: unknown };
  delta?: { type?: string; text?: unknown; thinking?: unknown };
}

export function blockId(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

/** One line a person can scan: `Bash · pnpm test`, `Edit · src/x.ts`. */
export function toolSummary(name: string, input: unknown, cwd: string | null = null): string {
  const fields = isRecord(input) ? input : {};
  const field = (...keys: string[]) => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const file = field('file_path', 'notebook_path', 'path');
  const detail =
    name === 'Bash'
      ? field('command')
      : file
        ? relativeTo(cwd, file)
        : field('pattern', 'url', 'query', 'description', 'prompt', 'skill', 'command');
  const line = oneLine(detail);
  return line ? `${name} · ${line}` : name;
}

function relativeTo(cwd: string | null, file: string): string {
  if (!cwd || !path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

function oneLine(text: string): string {
  const first = text.split('\n').find((line) => line.trim())?.trim() ?? '';
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

/**
 * What the developer typed, without the wrappers the CLI adds. A slash
 * command is shown as the command.
 */
function userText(raw: string): string {
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw)?.[1]?.trim();
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
    return args ? `${command} ${args}` : command;
  }
  return stripNoise(raw);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!isRecord(block)) return '';
      if (block.type === 'text') return asString(block.text);
      if (block.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** The answers an `AskUserQuestion` result carries, in question order. */
function answersOf(structured: unknown): string | null {
  if (!isRecord(structured) || !isRecord(structured.answers)) return null;
  const answers = Object.values(structured.answers).filter((value): value is string => typeof value === 'string');
  return answers.length ? answers.join('\n') : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
