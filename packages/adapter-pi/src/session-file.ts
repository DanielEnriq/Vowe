import {
  IncrementalJsonlReader,
  type JsonlLine,
  type JsonlReadResult,
} from '@vowe/adapter-kit';

/**
 * One entry of a pi session file.
 *
 * Typed from the CLI's own `docs/session-format.md` (session version 3), and
 * deliberately partial: only what this adapter reads is named, and the whole
 * record always survives into the normalized event's `raw`.
 */
export interface PiRecord {
  /** `session` | `message` | `model_change` | `compaction` | `label` | … */
  type?: string;
  /** 8-char hex entry id. Absent on the session header. */
  id?: string;
  /** Parent entry id, forming the session tree. Null on the first entry. */
  parentId?: string | null;
  timestamp?: string;
  /** Session header only. */
  version?: number;
  cwd?: string;
  parentSession?: string;
  /** `model_change` only. */
  provider?: string;
  modelId?: string;
  /** `thinking_level_change` only. */
  thinkingLevel?: string;
  /** `compaction` / `branch_summary` only. */
  summary?: string;
  /** `custom` / `custom_message` only. */
  customType?: string;
  /** `label` only. */
  label?: string;
  name?: string;
  message?: PiMessage;
  [key: string]: unknown;
}

export interface PiMessage {
  role?: string;
  content?: unknown;
  /** `toolResult` only. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** `bashExecution` only. */
  command?: string;
  output?: string;
  exitCode?: number | undefined;
  cancelled?: boolean;
  /** `assistant` only. */
  model?: string;
  provider?: string;
  stopReason?: string;
  [key: string]: unknown;
}

export type PiLine = JsonlLine<PiRecord>;
export type PiReadResult = JsonlReadResult<PiRecord>;

export class IncrementalPiSessionReader extends IncrementalJsonlReader<PiRecord> {}
