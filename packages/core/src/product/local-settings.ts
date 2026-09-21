import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * One small validated JSON file on disk.
 *
 * Vowe's own settings are not events and do not belong in the append-only
 * store: there is no history worth keeping of what your display name used to
 * be. This is the other idiom the codebase already uses — write the whole
 * value atomically, read it back at startup — factored out so the two profile
 * stores cannot drift in how they persist.
 *
 * Every read goes through `normalize`, so a file that is missing, truncated,
 * hand-edited or written by an older version yields defaults rather than an
 * error. Settings failing to load must never be a reason Vowe does not start.
 */
export interface LocalSettingsFileOptions<T> {
  file: string;
  /** Total: it must turn anything at all, including `null`, into a valid `T`. */
  normalize: (value: unknown) => T;
  onError?: (scope: string, error: unknown) => void;
}

export class LocalSettingsFile<T> {
  private readonly file: string;
  private readonly normalize: (value: unknown) => T;
  private readonly onError: (scope: string, error: unknown) => void;

  private loaded: Promise<T> | null = null;
  /** All writes in order; a failure never breaks the chain. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: LocalSettingsFileOptions<T>) {
    this.file = options.file;
    this.normalize = options.normalize;
    this.onError = options.onError ?? (() => undefined);
  }

  async get(): Promise<T> {
    if (!this.loaded) this.loaded = this.read();
    return this.loaded;
  }

  /**
   * Validate, keep, persist — and hand back what was actually stored.
   *
   * Returning the normalized value rather than nothing is the point: the
   * caller asked for something, validation may have adjusted it, and a second
   * round trip to find out what survived would be waste.
   */
  async set(value: unknown): Promise<T> {
    const next = this.normalize(value);
    this.loaded = Promise.resolve(next);
    await this.queue(() => this.write(next));
    return next;
  }

  private async read(): Promise<T> {
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      // No file yet, or an unreadable one. Defaults either way.
      raw = null;
    }
    return this.normalize(raw);
  }

  private async write(value: T): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
      await rename(temporary, this.file);
    } catch (error) {
      // The in-memory value stands for this run; the next write may succeed.
      this.onError('settings:write', error);
    }
  }

  private queue<T2>(work: () => Promise<T2>): Promise<T2> {
    const next = this.writeChain.then(work, work);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
