import { open, stat } from 'node:fs/promises';

/**
 * One line of a provider's append-only JSONL trace.
 *
 * Every coding agent we observe writes its history this way, so the reading is
 * shared and only the interpretation of `record` is per-provider. Nothing here
 * knows what a record means.
 */
export type JsonlRecord = Record<string, unknown>;

export interface JsonlLine<T extends JsonlRecord = JsonlRecord> {
  record: T;
  /** Byte offset of the line's first byte, used as the raw-evidence address. */
  byteOffset: number;
  /** 1-based line number in the file. */
  line: number;
}

export interface JsonlReadResult<T extends JsonlRecord = JsonlRecord> {
  lines: JsonlLine<T>[];
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
export class IncrementalJsonlReader<T extends JsonlRecord = JsonlRecord> {
  readonly file: string;
  private offset = 0;
  private lineNumber = 0;

  constructor(file: string) {
    this.file = file;
  }

  get position(): number {
    return this.offset;
  }

  async read(): Promise<JsonlReadResult<T>> {
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

  private async readFrom(from: number, to: number): Promise<JsonlLine<T>[]> {
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
    const lines: JsonlLine<T>[] = [];
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
            record: JSON.parse(text) as T,
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
