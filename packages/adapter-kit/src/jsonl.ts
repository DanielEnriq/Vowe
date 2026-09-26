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
    const lines: JsonlLine<T>[] = [];
    let reset = false;
    for await (const line of this.drain(() => (reset = true))) lines.push(line);
    return { lines, reset };
  }

  /**
   * The complete lines added since the last call, streamed in bounded chunks.
   * The cursor advances as each line is yielded, so a caller that folds lines
   * as they arrive holds one chunk, not the file.
   */
  async *drain(onReset?: () => void): AsyncGenerator<JsonlLine<T>> {
    let size: number;
    try {
      size = (await stat(this.file)).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // Truncated or replaced; start over rather than emit garbage.
      this.offset = 0;
      this.lineNumber = 0;
      onReset?.();
    }
    if (size === this.offset) return;
    const handle = await open(this.file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      let carry: Buffer[] = [];
      let at = this.offset;
      while (at < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - at), at);
        if (!bytesRead) break;
        at += bytesRead;
        let cursor = 0;
        for (;;) {
          const newline = buffer.indexOf(0x0a, cursor);
          if (newline === -1 || newline >= bytesRead) break;
          const piece = buffer.subarray(cursor, newline);
          const whole = carry.length ? Buffer.concat([...carry, piece]) : piece;
          carry = [];
          const byteOffset = this.offset;
          this.offset += whole.length + 1;
          this.lineNumber += 1;
          cursor = newline + 1;
          const text = whole.toString('utf8').trim();
          if (!text) continue;
          let record: T;
          try {
            record = JSON.parse(text) as T;
          } catch {
            continue; // A malformed line is skipped, never fatal.
          }
          yield { record, byteOffset, line: this.lineNumber };
        }
        // An incomplete trailing line is picked up whole on a later pass.
        if (cursor < bytesRead) carry.push(Buffer.from(buffer.subarray(cursor, bytesRead)));
      }
    } finally {
      await handle.close();
    }
  }
}

const CHUNK = 1024 * 1024;
