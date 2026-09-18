import type { AdapterEvent, NormalizedEventKind } from '@vowe/core';

import type { ClaudeRecord, TranscriptLine } from './transcript.js';

/**
 * Record types that are pure CLI bookkeeping: UI mode flips, cost counters,
 * attachment rendering, file-history snapshots. They describe the tool, not
 * the work.
 *
 * This is an explicit deny-list, not a fallthrough. Anything NOT listed here
 * and not recognized below still becomes an `unknown` event and is stored with
 * its raw payload — we skip what we have decided is noise, never what we
 * merely failed to understand.
 */
const IGNORED_RECORD_TYPES = new Set([
  'attachment',
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  'bridge-session',
  'cost-state',
  'queue-operation',
  'file-history-snapshot',
  'file-history-delta',
  'ai-title',
  'agent-name',
  'summary',
]);

const FILE_WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const TEST_COMMAND = /\b(pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|rspec|phpunit|gradle test|mvn test|tox|ctest)\b/;

interface PendingTool {
  name: string;
  kind: NormalizedEventKind;
  label: string;
}

export interface NormalizerContext {
  sessionId: string;
  source: string;
}

/**
 * Turns Claude Code transcript records into normalized events.
 *
 * Stateful per transcript: it remembers in-flight tool calls so a result can
 * be reported as the finish of the thing that started, and it remembers
 * whether the session's opening prompt has been seen.
 */
export class TranscriptNormalizer {
  private readonly context: NormalizerContext;
  private readonly pending = new Map<string, PendingTool>();
  private sawOpeningPrompt = false;

  constructor(context: NormalizerContext) {
    this.context = context;
  }

  /** May produce zero, one or several events for a single record. */
  normalize(line: TranscriptLine): AdapterEvent[] {
    const { record } = line;
    const type = record.type ?? 'unknown';
    if (IGNORED_RECORD_TYPES.has(type)) return [];

    switch (type) {
      case 'assistant':
        return this.fromAssistant(line);
      case 'user':
        return this.fromUser(line);
      case 'system':
        return this.fromSystem(line);
      default:
        return [
          this.event(line, 'unknown', `Unrecognized ${type} record`, {
            recordType: type,
          }),
        ];
    }
  }

  // --------------------------------------------------------------- assistant

  private fromAssistant(line: TranscriptLine): AdapterEvent[] {
    const blocks = contentBlocks(line.record.message?.content);
    const events: AdapterEvent[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        const text = asString(block.text).trim();
        if (!text) continue;
        events.push(
          this.event(line, 'agent_message', firstLine(text), { text }),
        );
        continue;
      }
      if (block.type === 'tool_use') {
        events.push(this.fromToolUse(line, block));
        continue;
      }
      // `thinking` and other private blocks are intentionally not events.
    }
    return events;
  }

  private fromToolUse(
    line: TranscriptLine,
    block: Record<string, unknown>,
  ): AdapterEvent {
    const name = asString(block.name) || 'tool';
    const id = asString(block.id);
    const input = (block.input ?? {}) as Record<string, unknown>;

    let kind: NormalizedEventKind = 'tool_started';
    let summary = `${name} started`;

    if (name === 'Bash') {
      const command = asString(input.command);
      const isTest = TEST_COMMAND.test(command);
      kind = isTest ? 'test_started' : 'command_started';
      summary = isTest
        ? `Running tests: ${truncate(oneLine(command), 120)}`
        : `Ran: ${truncate(oneLine(command), 120)}`;
    } else if (FILE_WRITING_TOOLS.has(name)) {
      kind = 'file_changed';
      summary = `${name === 'Write' ? 'Wrote' : 'Edited'} ${baseName(asString(input.file_path) || asString(input.notebook_path))}`;
    } else if (WAITING_TOOLS.has(name)) {
      kind = 'session_waiting';
      summary =
        name === 'AskUserQuestion'
          ? 'Asked the developer a question'
          : 'Presented a plan and is waiting for approval';
    } else if (name === 'Read') {
      summary = `Read ${baseName(asString(input.file_path))}`;
    } else if (name === 'Grep' || name === 'Glob') {
      summary = `Searched for ${truncate(asString(input.pattern), 80)}`;
    } else if (name === 'Task' || name === 'Agent') {
      summary = `Delegated to a subagent: ${truncate(asString(input.description), 80)}`;
    } else {
      summary = `Used ${name}`;
    }

    if (id) {
      this.pending.set(id, {
        name,
        kind: finishKindFor(kind),
        label: summary,
      });
    }

    return this.event(line, kind, summary, {
      tool: name,
      toolUseId: id,
      input: compactInput(name, input),
    });
  }

  // -------------------------------------------------------------------- user

  private fromUser(line: TranscriptLine): AdapterEvent[] {
    const { record } = line;
    const blocks = contentBlocks(record.message?.content);
    const toolResults = blocks.filter((block) => block.type === 'tool_result');

    if (toolResults.length) {
      return toolResults.map((block) => this.fromToolResult(line, block));
    }

    // Meta records are the CLI talking to itself, not the developer.
    if (record.isMeta) return [];

    const text = stripNoise(textOf(record.message?.content));
    if (!text) return [];

    if (!this.sawOpeningPrompt && !record.isSidechain) {
      this.sawOpeningPrompt = true;
      return [
        this.event(line, 'session_started', `Task: ${firstLine(text)}`, {
          text,
          cwd: record.cwd ?? null,
          gitBranch: record.gitBranch ?? null,
        }),
      ];
    }

    return [
      this.event(line, 'user_instruction', firstLine(text), {
        text,
        sidechain: record.isSidechain === true,
      }),
    ];
  }

  private fromToolResult(
    line: TranscriptLine,
    block: Record<string, unknown>,
  ): AdapterEvent {
    const id = asString(block.tool_use_id);
    const pending = id ? this.pending.get(id) : undefined;
    if (id) this.pending.delete(id);

    const failed = block.is_error === true;
    const name = pending?.name ?? 'tool';
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

    return this.event(line, kind, truncate(summary, 160), {
      tool: name,
      toolUseId: id,
      failed,
      output: truncate(resultText(block, line.record.toolUseResult), 600),
    });
  }

  // ------------------------------------------------------------------ system

  private fromSystem(line: TranscriptLine): AdapterEvent[] {
    const { record } = line;
    const subtype = record.subtype ?? 'informational';
    if (subtype === 'turn_duration') return [];

    const content = truncate(asString(record.content), 200);
    if (subtype === 'stop_hook_summary' || subtype === 'away_summary') {
      return content
        ? [this.event(line, 'unknown', content, { subtype })]
        : [];
    }
    return [
      this.event(line, 'unknown', content || `System event (${subtype})`, {
        subtype,
        level: record.level ?? null,
      }),
    ];
  }

  // ----------------------------------------------------------------- helpers

  private event(
    line: TranscriptLine,
    kind: NormalizedEventKind,
    summary: string,
    detail: Record<string, unknown>,
  ): AdapterEvent {
    return {
      sessionId: this.context.sessionId,
      at: asString(line.record.timestamp) || new Date().toISOString(),
      kind,
      summary,
      detail,
      raw: line.record,
      rawRef: {
        source: this.context.source,
        byteOffset: line.byteOffset,
        line: line.line,
      },
    };
  }
}

function finishKindFor(startKind: NormalizedEventKind): NormalizedEventKind {
  switch (startKind) {
    case 'command_started':
      return 'command_finished';
    case 'test_started':
      return 'test_finished';
    case 'file_changed':
      return 'file_changed';
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
  return content
    .filter(
      (block): block is { type: string; text?: unknown } =>
        typeof block === 'object' && block !== null && 'type' in block,
    )
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text))
    .join('\n');
}

/**
 * Remove wrappers the CLI injects around developer text (hook output, command
 * echoes, system reminders) so a derived task is the developer's own words.
 */
export function stripNoise(text: string): string {
  let out = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  out = out.replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, '');
  out = out.replace(/<command-(name|message|args|contents)>[\s\S]*?<\/command-\1>/g, '');
  out = out.replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g, '');
  return out.trim();
}

function resultText(block: Record<string, unknown>, structured: unknown): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  const fromBlocks = textOf(content);
  if (fromBlocks) return fromBlocks;
  return structured ? JSON.stringify(structured) : '';
}

function compactInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (name === 'Bash') {
    return {
      command: truncate(asString(input.command), 400),
      description: asString(input.description),
    };
  }
  if (FILE_WRITING_TOOLS.has(name)) {
    return { file_path: asString(input.file_path) };
  }
  return {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function firstLine(text: string, limit = 180): string {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? '';
  return truncate(line.trim().replace(/\s+/g, ' '), limit);
}

/** Collapse a multi-line value into one readable line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function baseName(filePath: string): string {
  if (!filePath) return 'a file';
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function stripPrefix(label: string): string {
  return label.replace(/^(Ran|Running tests): /, '');
}
