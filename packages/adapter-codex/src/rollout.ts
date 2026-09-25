import {
  IncrementalJsonlReader,
  type JsonlLine,
  type JsonlReadResult,
} from '@vowe/adapter-kit';

/**
 * One record of a Codex rollout file.
 *
 * Partial and observation-derived: Codex publishes no schema, so only the
 * fields this adapter actually reads are named, and every record survives
 * whole into the normalized event's `raw`.
 */
export interface CodexRecord {
  timestamp?: string;
  ordinal?: number;
  /** `session_meta` | `turn_context` | `response_item` | `event_msg` | … */
  type?: string;
  payload?: CodexPayload;
  [key: string]: unknown;
}

export interface CodexPayload {
  /** Discriminates within `response_item` and `event_msg`. */
  type?: string;
  session_id?: string;
  id?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model?: string;
  model_provider?: string;
  workspace_roots?: string[];
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  call_id?: string;
  output?: unknown;
  status?: string;
  summary?: unknown;
  encrypted_content?: string;
  last_agent_message?: string;
  turn_id?: string;
  [key: string]: unknown;
}

export type CodexLine = JsonlLine<CodexRecord>;
export type CodexReadResult = JsonlReadResult<CodexRecord>;

export class IncrementalRolloutReader extends IncrementalJsonlReader<CodexRecord> {}
