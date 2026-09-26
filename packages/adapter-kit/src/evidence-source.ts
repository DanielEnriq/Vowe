import { createHash, randomUUID } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import {
  EvidenceContinuityError,
  type AdapterEvent,
  type EvidenceBatch,
  type EvidenceCandidate,
  type EvidenceRecord,
  type EvidenceSource,
  type EvidenceSubscription,
} from '@vowe/core';
import type { JsonlLine, JsonlRecord } from './jsonl.js';

/**
 * A normalizer may carry context from earlier records (a tool call awaiting
 * its result). Exposing it lets an append-only source resume mid-file and
 * still normalize exactly as a read from the start would.
 */
export interface EvidenceNormalizer<T extends JsonlRecord> {
  normalize(line: JsonlLine<T>): AdapterEvent[];
  state?(): unknown;
  restore?(state: unknown): void;
}

export interface JsonlEvidenceOptions<T extends JsonlRecord> {
  id: string;
  file: () => string;
  normalizer: (source: string) => EvidenceNormalizer<T>;
  /** Source-specific interpretation of outcome evidence, never a transport default. */
  interpret?: (event: AdapterEvent) => Pick<EvidenceCandidate, 'basis' | 'execution' | 'factKey'>;
  recordKey?: (record: T) => string | undefined;
  /**
   * What the file's writer guarantees. `append-log` resumes from a verified
   * offset and reads only new bytes; `mutable-snapshot` (the default, since it
   * assumes nothing) re-reads the whole file whenever it changes.
   */
  continuity?: 'append-log' | 'mutable-snapshot';
  /** Change when normalization rules change; derived candidates carry it. */
  version?: string;
  pollMs?: number;
  /** Bounds on one acquired segment. A single larger record is still one segment. */
  segment?: { records: number; bytes: number };
  onError?: (error: unknown) => void;
}

/** Where a source stopped, and enough to tell whether the file is still that file. */
interface Checkpoint {
  v: 1;
  file: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Consumed bytes and lines: everything before this is admitted. */
  offset: number;
  line: number;
  records: number;
  /** sha256 of the first `headLength` bytes and of the ANCHOR bytes before `offset`. */
  head: string;
  headLength: number;
  boundary: string;
  normalizer: string;
  captureId: string;
  state?: unknown;
}

const ANCHOR = 64 * 1024;
const NEWLINE = Buffer.from('\n');
const READ = 1024 * 1024;
// Admission of one segment is synchronous SQLite work (~30 ms per MB), so a
// segment also bounds how long catch-up can hold the process at once.
const SEGMENT = { records: 250, bytes: 1024 * 1024 };

export type JsonlEvidenceSource = EvidenceSource & {
  /** Bytes read from disk, including anchors. Diagnostic, for budgets and tests. */
  readonly stats: { bytesRead: number };
};

/**
 * A retained JSONL file as evidence, acquired in bounded segments.
 *
 * Nothing here holds a whole history: a segment is parsed, normalized and
 * admitted before the next is read. An `append-log` file resumes from its
 * checkpoint after verifying the file is the same one (identity, head and
 * boundary anchors), so a grown file costs its new bytes. Anything else, or a
 * file that broke its append guarantee, is re-read whole as a snapshot, which
 * the ledger reconciles against what it already knew.
 */
export function jsonlEvidenceSource<T extends JsonlRecord>(
  options: JsonlEvidenceOptions<T>,
): JsonlEvidenceSource {
  const continuity = options.continuity ?? 'mutable-snapshot';
  const normalizerId = `${options.id}@${options.version ?? '1'}`;
  const limits = options.segment ?? SEGMENT;
  const stats = { bytesRead: 0 };
  const scope = 'retained transcript';

  const readRange = async (handle: FileHandle, from: number, to: number) => {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(READ, Math.max(0, to - from)));
    for (let at = from; at < to; ) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, to - at), at);
      if (!bytesRead) break;
      stats.bytesRead += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
    return hash.digest('hex');
  };

  /** Complete lines in [start, end), as bounded segments of records. */
  async function* segments(
    handle: FileHandle,
    file: string,
    start: { offset: number; line: number },
    end: number,
    normalizer: EvidenceNormalizer<T>,
    bounds: { records: number; bytes: number },
  ) {
    let records: EvidenceRecord[] = [];
    let bytes = 0;
    let malformed = 0;
    let offset = start.offset;
    let line = start.line;
    let carry: Buffer[] = [];
    let carried = 0;
    // The last ANCHOR consumed bytes, so a checkpoint's boundary anchor is
    // hashed from memory rather than read back from disk.
    const recent: Buffer[] = [];
    let recentBytes = 0;
    const remember = (bytes: Buffer) => {
      const kept = Buffer.from(bytes.subarray(Math.max(0, bytes.length - ANCHOR)));
      recent.push(kept);
      recentBytes += kept.length;
      while (recentBytes - recent[0]!.length >= ANCHOR) recentBytes -= recent.shift()!.length;
    };
    const tail = () => {
      const length = Math.min(ANCHOR, offset);
      if (offset - start.offset < length) return undefined;
      const all = Buffer.concat(recent);
      return all.subarray(all.length - length);
    };
    const buffer = Buffer.allocUnsafe(READ);
    for (let at = start.offset; at < end; ) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(READ, end - at), at);
      if (!bytesRead) break;
      stats.bytesRead += bytesRead;
      at += bytesRead;
      let from = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, from);
        if (newline === -1 || newline >= bytesRead) break;
        const piece = buffer.subarray(from, newline);
        const bytesOfLine = carried + piece.length;
        const whole = carried ? Buffer.concat([...carry, piece]) : piece;
        remember(whole);
        remember(NEWLINE);
        const text = whole.toString('utf8');
        carry = [];
        carried = 0;
        from = newline + 1;
        line += 1;
        const location = { source: file, byteOffset: offset, line };
        offset += bytesOfLine + 1;
        if (!text.trim()) continue;
        try {
          const record = JSON.parse(text) as T;
          const key = options.recordKey?.(record);
          const events = normalizer.normalize({ record, byteOffset: location.byteOffset, line });
          records.push({
            ...(key === undefined ? {} : { key }),
            raw: record,
            text,
            location,
            events: events.map((event, n) => ({
              slot: String(event.rawRef.ordinal ?? n),
              event,
              ...options.interpret?.(event),
            })),
          });
        } catch {
          malformed++;
          records.push({ raw: text, location, events: [] });
        }
        bytes += bytesOfLine;
        if (records.length >= bounds.records || bytes >= bounds.bytes) {
          yield { records, through: { byteOffset: offset, line }, tail: tail(), malformed, trailing: false };
          records = [];
          bytes = 0;
          malformed = 0;
        }
      }
      if (from < bytesRead) {
        carry.push(Buffer.from(buffer.subarray(from, bytesRead)));
        carried += bytesRead - from;
      }
    }
    yield { records, through: { byteOffset: offset, line }, tail: tail(), malformed, trailing: carried > 0 };
  }

  const reason = (malformed: number, trailing: boolean, note?: string) =>
    [
      note,
      malformed ? `${malformed} record(s) could not be decoded; bytes retained` : undefined,
      // Incomplete bytes are not evidence yet; they are captured once complete.
      trailing ? 'Incomplete trailing record; waiting for the writer' : undefined,
      malformed || trailing
        ? undefined
        : 'Retained transcript captured; provider history and omitted evidence may be incomplete',
    ]
      .filter(Boolean)
      .join('; ');

  const same = (a: Stats, b: Stats) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

  const unavailable = (code: string | undefined): EvidenceBatch => ({
    sourceId: options.id,
    captureId: randomUUID(),
    observedAt: new Date().toISOString(),
    mode: 'delta',
    records: [],
    coverage: {
      scope,
      status: 'unavailable',
      reason: `Source unavailable (${code ?? 'read error'}); prior captures remain available`,
    },
  });

  /**
   * One acquisition pass. Returns the checkpoint now admitted, or undefined
   * when the pass could not establish one (unavailable, or changed mid-read).
   */
  async function acquire(
    checkpoint: Checkpoint | undefined,
    emit: (batch: EvidenceBatch) => Promise<void>,
    turn: () => Promise<() => void>,
    reported: { unavailable?: string },
  ): Promise<Checkpoint | undefined> {
    const file = options.file();
    let info: Stats;
    try {
      info = await stat(file);
      delete reported.unavailable;
    } catch (error) {
      // Loss is reported once per distinct condition, not on every poll.
      const code = (error as NodeJS.ErrnoException).code;
      if (reported.unavailable !== `${file}:${code}`) {
        const release = await turn();
        try {
          await emit(unavailable(code));
          reported.unavailable = `${file}:${code}`;
        } finally {
          release();
        }
      }
      return checkpoint;
    }
    const sameFile = checkpoint?.file === file && checkpoint.dev === info.dev && checkpoint.ino === info.ino;
    if (sameFile && checkpoint.size === info.size && checkpoint.mtimeMs === info.mtimeMs && checkpoint.normalizer === normalizerId)
      return checkpoint;
    const handle = await open(file, 'r');
    try {
      let note: string | undefined;
      if (
        continuity === 'append-log' &&
        sameFile &&
        checkpoint.normalizer === normalizerId &&
        info.size >= checkpoint.offset
      ) {
        const head = await readRange(handle, 0, checkpoint.headLength);
        const boundary = await readRange(handle, Math.max(0, checkpoint.offset - ANCHOR), checkpoint.offset);
        const normalizer = options.normalizer(file);
        const resumable = checkpoint.state === undefined || !!normalizer.restore;
        if (head === checkpoint.head && boundary === checkpoint.boundary && resumable) {
          if (checkpoint.state !== undefined) normalizer.restore!(checkpoint.state);
          return await extend(handle, file, info, checkpoint, normalizer, emit, turn);
        }
        note = 'History was rewritten in place; re-read it whole';
      }
      return await snapshot(handle, file, info, emit, turn, note);
    } finally {
      await handle.close();
    }
  }

  async function nextCheckpoint(
    handle: FileHandle,
    file: string,
    info: Stats,
    previous: Pick<Checkpoint, 'head' | 'headLength'> | undefined,
    through: { byteOffset: number; line: number },
    records: number,
    captureId: string,
    normalizer: EvidenceNormalizer<T>,
    tail: Buffer | undefined,
  ): Promise<Checkpoint> {
    const headLength = Math.min(ANCHOR, through.byteOffset);
    return {
      v: 1,
      file,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset: through.byteOffset,
      line: through.line,
      records,
      head:
        previous && previous.headLength === headLength
          ? previous.head
          : await readRange(handle, 0, headLength),
      headLength,
      boundary: tail
        ? createHash('sha256').update(tail).digest('hex')
        : await readRange(handle, Math.max(0, through.byteOffset - ANCHOR), through.byteOffset),
      normalizer: normalizerId,
      captureId,
      ...(normalizer.state ? { state: normalizer.state() } : {}),
    };
  }

  /** Append-only continuation: each segment extends the admitted view. */
  async function extend(
    handle: FileHandle,
    file: string,
    info: Stats,
    from: Checkpoint,
    normalizer: EvidenceNormalizer<T>,
    emit: (batch: EvidenceBatch) => Promise<void>,
    turn: () => Promise<() => void>,
  ): Promise<Checkpoint> {
    let checkpoint = from;
    const reader = segments(handle, file, { offset: from.offset, line: from.line }, info.size, normalizer, limits);
    for (;;) {
      const release = await turn();
      try {
        const next = await reader.next();
        if (next.done) return checkpoint;
        const segment = next.value;
        if (!segment.records.length) {
          // Only blank lines or an incomplete tail: nothing to admit, but the
          // metadata of an unchanged prefix still moves forward.
          return { ...checkpoint, size: info.size, mtimeMs: info.mtimeMs };
        }
        const captureId = randomUUID();
        const records = checkpoint.records + segment.records.length;
        const nextCheckpoint_ = await nextCheckpoint(
          handle,
          file,
          info,
          checkpoint,
          segment.through,
          records,
          captureId,
          normalizer,
          segment.tail,
        );
        await emit({
          sourceId: options.id,
          captureId,
          observedAt: new Date().toISOString(),
          mode: 'snapshot',
          extends: { captureId: checkpoint.captureId, records: checkpoint.records },
          normalizer: normalizerId,
          records: segment.records,
          through: segment.through,
          coverage: { scope, status: 'partial', reason: reason(segment.malformed, segment.trailing) },
          checkpoint: JSON.stringify(nextCheckpoint_),
        });
        checkpoint = nextCheckpoint_;
      } finally {
        release();
      }
    }
  }

  /** A whole-file read, streamed as parts of one snapshot. */
  async function snapshot(
    handle: FileHandle,
    file: string,
    info: Stats,
    emit: (batch: EvidenceBatch) => Promise<void>,
    turn: () => Promise<() => void>,
    note?: string,
  ): Promise<Checkpoint | undefined> {
    const id = randomUUID();
    const normalizer = options.normalizer(file);
    const reader = segments(handle, file, { offset: 0, line: 0 }, info.size, normalizer, limits);
    let index = 0;
    let records = 0;
    let malformed = 0;
    let pending = await (async () => {
      const release = await turn();
      try {
        return (await reader.next()).value;
      } finally {
        release();
      }
    })();
    while (pending) {
      const release = await turn();
      try {
        // Read one segment ahead: a part is final only when nothing follows.
        const following = pending.trailing ? undefined : (await reader.next()).value;
        const final = following === undefined;
        records += pending.records.length;
        malformed += pending.malformed;
        let checkpoint: Checkpoint | undefined;
        let stable = true;
        if (final) {
          // Coherence: an append-only file may have grown, but must still be
          // the file we started; any other file must not have changed at all.
          const after = await stat(file).catch(() => undefined);
          stable =
            !!after &&
            after.dev === info.dev &&
            after.ino === info.ino &&
            (continuity === 'append-log' ? after.size >= info.size : same(after, info));
          if (stable)
            checkpoint = await nextCheckpoint(
              handle,
              file,
              info,
              undefined,
              pending.through,
              records,
              id,
              normalizer,
              pending.tail,
            );
        }
        if (final && !stable) return undefined;
        await emit({
          sourceId: options.id,
          captureId: `${id}#${index}`,
          observedAt: new Date().toISOString(),
          mode: 'snapshot',
          normalizer: normalizerId,
          part: { snapshot: id, index, final },
          records: pending.records,
          through: pending.through,
          coverage: { scope, status: 'partial', reason: reason(malformed, pending.trailing, note) },
          ...(checkpoint ? { checkpoint: JSON.stringify(checkpoint) } : {}),
        });
        index++;
        pending = following;
        if (final) return checkpoint;
      } finally {
        release();
      }
    }
    return undefined;
  }

  const run = (
    initial: Checkpoint | undefined,
    accept: (batch: EvidenceBatch) => Promise<void>,
    subscription: EvidenceSubscription = {},
  ) => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let checkpoint = initial;
    const reported: { unavailable?: string } = {};
    const turn = subscription.turn ?? defaultTurn;
    const emit = async (batch: EvidenceBatch) => {
      if (stopped) throw new Stopped();
      await accept(batch);
    };
    const pump = async () => {
      try {
        // A read that changed underneath it establishes nothing; retry later.
        checkpoint = (await acquire(checkpoint, emit, turn, reported)) ?? checkpoint;
        subscription.idle?.();
      } catch (error) {
        if (error instanceof EvidenceContinuityError) checkpoint = undefined;
        else if (!(error instanceof Stopped)) options.onError?.(error);
      } finally {
        if (!stopped) {
          timer = setTimeout(() => void pump(), options.pollMs ?? 750);
          timer.unref?.();
        }
      }
    };
    void pump();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  };

  return {
    id: options.id,
    continuity,
    stats,
    /** A whole snapshot as one batch, for small sources and fixtures. */
    async read() {
      const file = options.file();
      let info: Stats;
      try {
        info = await stat(file);
      } catch (error) {
        return unavailable((error as NodeJS.ErrnoException).code);
      }
      const handle = await open(file, 'r');
      try {
        const reader = segments(handle, file, { offset: 0, line: 0 }, info.size, options.normalizer(file), {
          records: Infinity,
          bytes: Infinity,
        });
        const all = (await reader.next()).value!;
        return {
          sourceId: options.id,
          captureId: randomUUID(),
          observedAt: new Date().toISOString(),
          mode: 'snapshot',
          normalizer: normalizerId,
          records: all.records,
          through: all.through,
          coverage: { scope, status: 'partial', reason: reason(all.malformed, all.trailing) },
        };
      } finally {
        await handle.close();
      }
    },
    subscribe: (accept, subscription) => run(undefined, accept, subscription),
    resumeAfter: (checkpoint, accept, subscription) => {
      let parsed: Checkpoint | undefined;
      try {
        const value = JSON.parse(checkpoint) as Checkpoint;
        if (value?.v === 1) parsed = value;
      } catch {
        // A checkpoint from an older source form: acquire from the start.
      }
      return run(parsed, accept, subscription);
    },
  };
}

class Stopped extends Error {}

// Without a consumer-provided turn, one acquisition at a time process-wide:
// memory is bounded by one segment regardless of how many sources exist.
let slot: Promise<void> = Promise.resolve();
function defaultTurn(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const ready = slot.then(() => release);
  slot = slot.then(() => held);
  return ready;
}
