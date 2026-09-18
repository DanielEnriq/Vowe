import { open, stat } from 'node:fs/promises';

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

export interface TranscriptLine {
  record: ClaudeRecord;
  /** Byte offset of the line's first byte, used as the raw-evidence address. */
  byteOffset: number;
  /** 1-based line number in the file. */
  line: number;
}

export interface ReadResult {
  lines: TranscriptLine[];
  /** True when the file shrank or vanished, meaning our cursor is invalid. */
  reset: boolean;
}

/**
 * Append-only incremental reader.
 *
 * Reads only the bytes added since the last call and stops at the last
 * complete newline, so a record being written while we read is picked up whole
 * on the next pass instead of being parsed half-formed.
 */
export class IncrementalTranscriptReader {
  readonly file: string;
  private offset = 0;
  private lineNumber = 0;

  constructor(file: string) {
    this.file = file;
  }

  get position(): number {
    return this.offset;
  }

  async read(): Promise<ReadResult> {
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return { lines: [], reset: false };
    }

    if (size < this.offset) {
      // Truncated or replaced; start over rather than emit garbage.
      this.offset = 0;
      this.lineNumber = 0;
      return { lines: await this.readFrom(0, size), reset: true };
    }
    if (size === this.offset) return { lines: [], reset: false };
    return { lines: await this.readFrom(this.offset, size), reset: false };
  }

  private async readFrom(from: number, to: number): Promise<TranscriptLine[]> {
    const length = to - from;
    if (length <= 0) return [];

    const handle = await open(this.file, 'r');
    let buffer: Buffer;
    try {
      buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, from);
    } finally {
      await handle.close();
    }

    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline === -1) return []; // No complete line yet.

    const complete = buffer.subarray(0, lastNewline + 1);
    const lines: TranscriptLine[] = [];
    let cursor = 0;

    while (cursor < complete.length) {
      const newline = complete.indexOf(0x0a, cursor);
      const end = newline === -1 ? complete.length : newline;
      const text = complete.subarray(cursor, end).toString('utf8').trim();
      const byteOffset = from + cursor;
      this.lineNumber += 1;
      if (text) {
        try {
          lines.push({
            record: JSON.parse(text) as ClaudeRecord,
            byteOffset,
            line: this.lineNumber,
          });
        } catch {
          // A malformed line is skipped, never fatal.
        }
      }
      cursor = end + 1;
    }

    this.offset = from + complete.length;
    return lines;
  }
}
