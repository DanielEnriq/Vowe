import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * The explicit worker-control path for pi.
 *
 * Kept apart from observation for the same reason it is in the Claude adapter:
 * observing a worker and sending something to a worker are different actions,
 * and the product depends on them staying different.
 *
 * pi documents a headless mode (`--print`) and addressable sessions
 * (`--session-id`, `--session-dir`), so control here is spawning the CLI
 * against a known session id. That only works if the CLI is installed, which
 * is an environment fact rather than a provider fact — hence `available`.
 */
export interface PiControlOptions {
  /** Overridable for tests. Defaults to whatever `pi` resolves to on PATH. */
  binary?: string;
  onError?: (scope: string, error: unknown) => void;
}

export interface ManagedPiSession {
  sessionId: string;
  cwd: string;
  startedAt: number;
}

export class PiControlChannel {
  private readonly binary: string | null;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly managed = new Map<string, ManagedPiSession>();
  private readonly processes = new Map<string, ReturnType<typeof spawn>>();

  constructor(options: PiControlOptions = {}) {
    this.onError = options.onError ?? (() => undefined);
    /*
     * An explicitly empty binary means "pretend it is not installed", which is
     * how a test reaches the degraded path without uninstalling anything.
     * Only an absent option falls back to looking on PATH.
     */
    this.binary =
      options.binary === undefined ? resolveBinary() : options.binary || null;
  }

  /** Whether the CLI is actually present on this machine. */
  get available(): boolean {
    return this.binary !== null;
  }

  isManaged(sessionId: string): boolean {
    return this.managed.has(sessionId);
  }

  getManaged(sessionId: string): ManagedPiSession | undefined {
    return this.managed.get(sessionId);
  }

  managedSessionIds(): string[] {
    return [...this.managed.keys()];
  }

  /**
   * Run one non-interactive turn against a session id.
   *
   * pi creates the session when the id is unknown and continues it when it is
   * known, which is what makes launching and resuming the same call here.
   */
  run(sessionId: string, cwd: string, sessionDir: string, prompt: string): void {
    if (!this.binary) throw new Error('the pi command-line tool was not found');

    const child = spawn(
      this.binary,
      ['--session-dir', sessionDir, '--session-id', sessionId, '--print', '--', prompt],
      { cwd, stdio: 'ignore', detached: false },
    );
    child.on('error', (error) => this.onError(`pi:run:${sessionId}`, error));
    child.on('exit', () => {
      this.processes.delete(sessionId);
      this.managed.delete(sessionId);
    });
    this.processes.set(sessionId, child);
    this.managed.set(sessionId, { sessionId, cwd, startedAt: Date.now() });
  }

  /** Only reaches a process we started ourselves. */
  interrupt(sessionId: string): boolean {
    const child = this.processes.get(sessionId);
    if (!child) return false;
    child.kill('SIGINT');
    return true;
  }

  async dispose(): Promise<void> {
    for (const child of this.processes.values()) child.kill('SIGTERM');
    this.processes.clear();
    this.managed.clear();
  }
}

/**
 * Look for `pi` on PATH directly rather than asking a shell.
 *
 * Walking PATH avoids spawning anything at all to answer a question we ask on
 * every discovery pass, and keeps a directory name that happens to contain
 * shell syntax from being interpreted.
 */
function resolveBinary(): string | null {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, 'pi');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
