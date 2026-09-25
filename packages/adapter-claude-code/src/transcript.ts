import {
  IncrementalJsonlReader,
  type JsonlLine,
  type JsonlReadResult,
} from '@vowe/adapter-kit';

/**
 * A record from a Claude Code transcript (`<sessionId>.jsonl`).
 *
 * Only the fields this adapter reads are typed. The full record is always
 * carried through to the normalized event's `raw`, so nothing is lost by this
 * being partial.
 */
export interface ClaudeRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  level?: string;
  content?: unknown;
  aiTitle?: string;
  toolUseResult?: unknown;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

export type TranscriptLine = JsonlLine<ClaudeRecord>;
export type ReadResult = JsonlReadResult<ClaudeRecord>;

/**
 * Append-only incremental reader over a Claude Code transcript.
 *
 * The reading itself is provider-neutral and lives in `@vowe/adapter-kit`;
 * this only fixes the record type, so the offsets a normalized event points at
 * are produced by exactly the same code for every provider.
 */
export class IncrementalTranscriptReader extends IncrementalJsonlReader<ClaudeRecord> {}
