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

import type { CodexLine, CodexPayload } from './rollout.js';

/**
 * Records that are Codex's own bookkeeping: token meters, rate limits, UI
 * settings, per-item completion echoes of things already recorded.
 *
 * An explicit deny-list. Anything not listed and not recognized below still
 * becomes an `unknown` event carrying its raw payload.
 */
const IGNORED_TOP_TYPES = new Set(['token_usage_record', 'world_state']);
const IGNORED_EVENT_MSGS = new Set([
  'token_count',
  'thread_settings_applied',
  // Every completed item is already recorded as its own `response_item`.
  'item_completed',
]);

/** Codex's shell tools, whichever calling convention they arrive under. */
const COMMAND_TOOLS = new Set(['exec', 'shell', 'exec_command', 'local_shell']);
const FILE_WRITING_TOOLS = new Set(['apply_patch', 'edit_file', 'write_file']);
/**
 * The tool Codex calls when it needs the developer.
 *
 * This is the whole reason a Codex session can reach `Needs You`: the adapter
 * knows this one name means a person was asked something, and says so in a
 * word — `awaitingHuman` — that names no provider.
 */
// Optional asynchronous input does not stop the worker on a human decision.
const ASKING_TOOLS = new Set(['request_user_input']);

interface PendingTool {
  name: string;
  kind: NormalizedEventKind;
  label: string;
}

export interface CodexNormalizerContext {
  sessionId: string;
  source: string;
}

/** Turns Codex rollout records into normalized events. */
export class CodexRolloutNormalizer {
  private readonly context: CodexNormalizerContext;
  private readonly pending = new Map<string, PendingTool>();
  private sawOpeningPrompt = false;

  constructor(context: CodexNormalizerContext) {
    this.context = context;
  }

  normalize(line: CodexLine): AdapterEvent[] {
    // One record, several events: each needs its own physical identity
    // or the store keeps the first and drops its siblings.
    return withOrdinals(this.normalizeRecord(line));
  }

  private normalizeRecord(line: CodexLine): AdapterEvent[] {
    const { record } = line;
    const type = record.type ?? 'unknown';
    if (IGNORED_TOP_TYPES.has(type)) return [];
    const payload = record.payload ?? {};

    switch (type) {
      case 'session_meta':
        return [
          this.event(line, 'session_started', 'Session started', {
            cwd: payload.cwd ?? null,
            originator: payload.originator ?? null,
            cliVersion: payload.cli_version ?? null,
            source: payload.source ?? null,
            modelProvider: payload.model_provider ?? null,
          }),
        ];
      /*
       * Not an event. A turn's context restates the working directory and
       * model for every turn; as events they would be a drumbeat of noise
       * saying nothing happened. The adapter folds them into session facts
       * instead, which is where that information belongs.
       */
      case 'turn_context':
        return [];
      case 'compacted':
        return [
          this.event(line, 'unknown', 'Compacted the conversation', {}),
        ];
      case 'event_msg':
        return this.fromEventMsg(line, payload);
      case 'response_item':
        return this.fromResponseItem(line, payload);
      default:
        return [
          this.event(line, 'unknown', `Unrecognized ${type} record`, {
            recordType: type,
          }),
        ];
    }
  }

  // ------------------------------------------------------------- lifecycle

  private fromEventMsg(line: CodexLine, payload: CodexPayload): AdapterEvent[] {
    const subtype = payload.type ?? 'unknown';
    if (IGNORED_EVENT_MSGS.has(subtype)) return [];

    switch (subtype) {
      case 'task_started':
        return [
          this.event(line, 'unknown', 'Started a turn', {
            turnId: payload.turn_id ?? null,
          }),
        ];
      case 'task_complete': {
        /*
         * Codex's clearest signal, and better than most providers give: the
         * turn is genuinely over and the closing message is right here. It
         * becomes two events because they are two facts — what the worker
         * said, and that it then stopped.
         */
        const events: AdapterEvent[] = [];
        const message = asString(payload.last_agent_message).trim();
        if (message) {
          events.push(
            this.event(line, 'agent_message', firstLine(message), { text: message }),
          );
        }
        events.push(
          this.event(line, 'session_waiting', 'Finished a turn', {
            turnId: payload.turn_id ?? null,
          }),
        );
        return events;
      }
      case 'turn_aborted':
        return [
          this.event(line, 'session_waiting', 'The turn was interrupted', {
            turnId: payload.turn_id ?? null,
          }),
        ];
      default:
        return [
          this.event(line, 'unknown', `Codex event (${subtype})`, { subtype }),
        ];
    }
  }

  // ---------------------------------------------------------- response items

  private fromResponseItem(line: CodexLine, payload: CodexPayload): AdapterEvent[] {
    switch (payload.type) {
      case 'message':
        return this.fromMessage(line, payload);
      case 'reasoning':
        return this.fromReasoning(line, payload);
      case 'function_call':
      case 'custom_tool_call':
        return [this.fromToolCall(line, payload)];
      case 'function_call_output':
      case 'custom_tool_call_output':
        return [this.fromToolOutput(line, payload)];
      case 'compaction':
        return [this.event(line, 'unknown', 'Compacted the conversation', {})];
      default:
        return [
          this.event(line, 'unknown', `Unrecognized ${payload.type ?? 'item'}`, {
            itemType: payload.type ?? null,
          }),
        ];
    }
  }

  private fromMessage(line: CodexLine, payload: CodexPayload): AdapterEvent[] {
    const role = asString(payload.role);
    /*
     * The harness talking to itself, not the developer. Codex opens every
     * session with a long `developer` preamble describing the desktop app;
     * treating it as an instruction would make it the session's task.
     * This is Codex's equivalent of Claude Code's `isMeta`.
     */
    if (role === 'developer' || role === 'system') return [];

    const raw = textOf(payload.content);
    // Codex also injects harness context into `user` messages, so the role
    // alone is not enough to tell the developer's words from the app's.
    const text = (role === 'assistant' ? raw : stripHarnessContext(raw)).trim();
    if (!text) return [];

    if (role === 'assistant') {
      return [this.event(line, 'agent_message', firstLine(text), { text })];
    }

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

  /**
   * Codex reasoning, which we can see the shape of but not the content.
   *
   * The records carry `encrypted_content` and, in everything observed, an
   * empty `summary`. Kept as raw evidence so the trace stays complete and a
   * future Codex that fills `summary` needs only this function changed — but
   * deliberately *not* an `agent_reasoning` event, because there is no
   * reasoning in it to read. The adapter reports `reasoning: false` to match,
   * so no surface claims this worker did not think.
   */
  private fromReasoning(line: CodexLine, payload: CodexPayload): AdapterEvent[] {
    const summary = summaryText(payload.summary).trim();
    if (summary) {
      return [
        this.event(line, 'agent_reasoning', firstLine(summary), {
          text: truncate(summary, 600),
        }),
      ];
    }
    return [
      this.event(line, 'unknown', 'Reasoning was recorded but is not readable', {
        readable: false,
        encrypted: typeof payload.encrypted_content === 'string',
      }),
    ];
  }

  private fromToolCall(line: CodexLine, payload: CodexPayload): AdapterEvent {
    const name = asString(payload.name) || 'tool';
    const callId = asString(payload.call_id) || asString(payload.id);
    const input = argumentsOf(payload);

    let kind: NormalizedEventKind = 'tool_started';
    let summary = `Used ${name}`;
    let awaitingHuman = false;

    if (COMMAND_TOOLS.has(name)) {
      const command = commandOf(payload, input);
      const test = isTestCommand(command);
      kind = test ? 'test_started' : 'command_started';
      summary = test
        ? `Running tests: ${truncate(oneLine(command), 120)}`
        : `Ran: ${truncate(oneLine(command), 120)}`;
    } else if (FILE_WRITING_TOOLS.has(name)) {
      kind = 'file_changed';
      summary = `Edited ${baseName(asString(input.path) || asString(input.file_path))}`;
    } else if (ASKING_TOOLS.has(name)) {
      kind = 'session_waiting';
      awaitingHuman = true;
      summary = 'Asked the developer a question';
    }

    if (callId) this.pending.set(callId, { name, kind: finishKindFor(kind), label: summary });

    return this.event(line, kind, summary, {
      tool: name,
      callId,
      ...(awaitingHuman ? { awaitingHuman: true } : {}),
    });
  }

  private fromToolOutput(line: CodexLine, payload: CodexPayload): AdapterEvent {
    const callId = asString(payload.call_id) || asString(payload.id);
    const pending = callId ? this.pending.get(callId) : undefined;
    if (callId) this.pending.delete(callId);

    const output = outputText(payload.output);
    const failed = looksFailed(output);
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
      callId,
      failed,
      output: truncate(output, 600),
    });
  }

  // ------------------------------------------------------------------ helper

  private event(
    line: CodexLine,
    kind: NormalizedEventKind,
    summary: string,
    detail: Record<string, unknown>,
  ): AdapterEvent {
    return {
      sessionId: this.context.sessionId,
      at: asString(line.record.timestamp) || new Date().toISOString(),
      kind,
      summary,
      detail: { ...detail, ordinal: line.record.ordinal ?? null },
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
    case 'session_waiting':
      return 'session_waiting';
    default:
      return 'tool_finished';
  }
}

/** Codex content blocks are `input_text` / `output_text`, not `text`. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is Record<string, unknown> =>
        typeof block === 'object' && block !== null,
    )
    .filter((block) => asString(block.type).endsWith('text'))
    .map((block) => asString(block.text))
    .join('\n');
}

function summaryText(summary: unknown): string {
  if (typeof summary === 'string') return summary;
  if (!Array.isArray(summary)) return '';
  return summary
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : typeof entry === 'object' && entry !== null
          ? asString((entry as Record<string, unknown>).text)
          : '',
    )
    .filter(Boolean)
    .join('\n');
}

function argumentsOf(payload: CodexPayload): Record<string, unknown> {
  const raw = payload.arguments ?? payload.input;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : { input: raw };
    } catch {
      // `custom_tool_call` inputs are free-form source, not JSON.
      return { input: raw };
    }
  }
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  return {};
}

function commandOf(payload: CodexPayload, input: Record<string, unknown>): string {
  const direct = asString(input.command) || asString(input.cmd) || asString(input.input);
  if (direct) return direct;
  const command = input.command;
  if (Array.isArray(command)) return command.map((part) => asString(part)).join(' ');
  return asString(payload.input);
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  return JSON.stringify(output);
}

/**
 * Codex does not flag a failed call the way pi's `isError` does, so this reads
 * the shape its outputs actually take. Conservative on purpose: a command is
 * reported as finished unless the output says otherwise.
 */
function looksFailed(output: string): boolean {
  if (!output) return false;
  return /"(success|ok)"\s*:\s*false|"error"\s*:|exit(_|\s)?code"?\s*[:=]\s*[1-9]/i.test(
    output,
  );
}

/**
 * Remove what the Codex application injects into a `user` message.
 *
 * Observed rather than documented, and this matters in practice: the first
 * `user` message of a real session is usually a plugin catalogue wrapped in
 * `<recommended_plugins>`, so without this the session's task — the label a
 * person reads in the sidebar — came out as "<recommended_plugins>".
 *
 * The same shape as `stripNoise` in the Claude Code adapter, for the same
 * reason: a derived task should be the developer's own words.
 */
export function stripHarnessContext(text: string): string {
  let out = text.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g, '');
  out = out.replace(
    /<(recommended_plugins|app-context|environment_context|user_instructions|plugin_instructions|ide_opened_file|codex_delegation|turn_aborted)>[\s\S]*?<\/\1>/g,
    '',
  );
  // An unterminated wrapper is common when the block was truncated; drop from
  // the tag to the end rather than keeping a half-open catalogue.
  out = out.replace(
    /<(recommended_plugins|app-context|environment_context|user_instructions|plugin_instructions)>[\s\S]*$/,
    '',
  );
  /*
   * An attachment-carrying message states the developer's own ask under a
   * heading, after a list of what was pasted or mentioned. Keep the ask and
   * drop the listing, which is file paths rather than intent.
   *
   * The heading varies — "My request:" and "My request for Codex:" both
   * occur — so it is matched loosely rather than spelled out.
   */
  const request = /^##[ \t]*My request[^:\n]*:[ \t]*$/m.exec(out);
  if (request) {
    out = out.slice(request.index + request[0].length);
  } else if (/^#[ \t]*Files [a-z]+ by the user:/m.test(out)) {
    // A listing with no stated ask is entirely file paths. There is no
    // instruction in it to recover, and a path makes a poor session title.
    out = '';
  }

  /*
   * Whole messages the application writes in the developer's voice.
   *
   * These are not a wrapper around a request — they are the entire message,
   * and the developer's actual words arrive in the *next* one. By far the
   * most common is the repository's own AGENTS.md, which led 54 of 80 real
   * sessions sampled here; left in, every one of those sessions would be
   * titled after a file path.
   */
  if (/^#[ \t]*AGENTS\.md instructions for /m.test(out)) return '';
  if (/^The following is the Codex agent history/m.test(out)) return '';

  out = out.trim();

  /*
   * A catch-all for the ones not yet named.
   *
   * Codex keeps adding wrappers — `<ide_opened_file>`, `<codex_delegation>`,
   * `<turn_aborted>` all turned up in real sessions — and the list above will
   * always trail them. A message that is *entirely* one snake_case tag block
   * is the application writing, not a person: developers do not send that and
   * nothing else. Deliberately narrow, so a message that merely contains
   * markup alongside real words keeps its words.
   */
  if (/^<([a-z][a-z0-9_]*)>[\s\S]*<\/\1>$/.test(out)) return '';
  // The same block left unterminated, which truncation produces.
  if (/^<[a-z][a-z0-9_]*>$/m.test(out.split('\n')[0] ?? '')) return '';

  return out;
}

function stripPrefix(label: string): string {
  return label.replace(/^(Ran|Running tests): /, '');
}
