import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Every invocation of the `graphify` binary, and nothing else.
 *
 * Graphify is a Python tool installed out of band (`uv tool install graphifyy`)
 * — it cannot be a dependency of this workspace, so the only honest thing to do
 * is probe for it and degrade when it is not there.
 *
 * Shaped after `git-diff.ts` in core: argv arrays rather than shell strings,
 * explicit timeouts and buffer ceilings, and **failures come back as a result
 * with a readable `failure`, never as a throw**. A missing indexer must not be
 * able to interrupt an answer being spoken out loud.
 */

export interface GraphifyRunOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** Injectable so the adapter can be unit-tested without the binary. */
export type GraphifyRun = (
  bin: string,
  args: string[],
  options: GraphifyRunOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface GraphifyResult {
  ok: boolean;
  stdout: string;
  /** Set when the command did not succeed. One line, human-readable. */
  failure?: string;
}

/**
 * Where one project's Graphify state lives.
 *
 * Kept as one object because the four paths are related in ways that are not
 * obvious — `parent` and `outDir` differ by exactly the directory Graphify
 * creates for itself — and passing them separately invites getting it wrong.
 */
export interface GraphifyPaths {
  /** What `--out` is given. Graphify creates `graphify-out/` inside it. */
  parent: string;
  /** `<parent>/graphify-out`. What `GRAPHIFY_OUT` is set to. */
  outDir: string;
  graphFile: string;
  memoryDir: string;
  lessonsFile: string;
}

export function graphifyPaths(parent: string): GraphifyPaths {
  const outDir = path.join(parent, 'graphify-out');
  return {
    parent,
    outDir,
    graphFile: path.join(outDir, 'graph.json'),
    memoryDir: path.join(outDir, 'memory'),
    lessonsFile: path.join(outDir, 'reflections', 'LESSONS.md'),
  };
}

export interface GraphifyProbe {
  available: boolean;
  version?: string;
  /** Why not. Shown in the UI verbatim. */
  reason?: string;
}

export interface GraphifyCliOptions {
  /** Defaults to `graphify` on `PATH`. */
  bin?: string;
  /**
   * Refuse to use anything older than this.
   *
   * There is no lockfile to pin a Python tool into, so the version floor is
   * enforced by asserting rather than by resolving.
   */
  minVersion?: string;
  /**
   * A semantic extraction backend. Left unset, extraction runs `--code-only`:
   * local AST, deterministic, and no API key — which matches how the rest of
   * Vowe treats credentials as optional.
   */
  backend?: string;
  timeoutMs?: number;
  /** Extraction walks a whole repository and is allowed to take much longer. */
  extractTimeoutMs?: number;
  runImpl?: GraphifyRun;
  onError?: (scope: string, error: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_EXTRACT_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export class GraphifyCli {
  private readonly bin: string;
  private readonly minVersion: string | null;
  private readonly backend: string | null;
  private readonly timeoutMs: number;
  private readonly extractTimeoutMs: number;
  private readonly run: GraphifyRun;
  private readonly onError: (scope: string, error: unknown) => void;
  private probed: Promise<GraphifyProbe> | null = null;

  constructor(options: GraphifyCliOptions = {}) {
    this.bin = options.bin ?? 'graphify';
    this.minVersion = options.minVersion ?? null;
    this.backend = options.backend ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extractTimeoutMs = options.extractTimeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
    this.run = options.runImpl ?? defaultRun;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Probed once. The answer does not change while the app is running. */
  probe(): Promise<GraphifyProbe> {
    this.probed ??= this.doProbe();
    return this.probed;
  }

  private async doProbe(): Promise<GraphifyProbe> {
    const result = await this.exec(['--version'], { timeoutMs: this.timeoutMs });
    if (!result.ok) {
      return {
        available: false,
        reason: `\`${this.bin}\` could not be run: ${result.failure}`,
      };
    }

    const version = parseVersion(result.stdout);
    if (!version) {
      // It ran, so it exists. An unreadable version string is not a reason to
      // refuse to use it.
      return { available: true };
    }
    if (this.minVersion && compareVersions(version, this.minVersion) < 0) {
      return {
        available: false,
        version,
        reason: `graphify ${version} is older than the required ${this.minVersion}.`,
      };
    }
    return { available: true, version };
  }

  /**
   * Build the graph for a repository.
   *
   * Two things about the paths here are easy to get wrong, and both were
   * settled by running the real binary rather than by reading about it:
   *
   *  - `--out` names the **parent**. Graphify creates `<parent>/graphify-out/`
   *    inside it and writes everything there.
   *  - `GRAPHIFY_OUT` names that **`graphify-out` directory itself**, and it is
   *    what `update` honours, since `update` has no `--out` flag at all.
   *
   * Between them, nothing Graphify writes ever lands in the user's checkout.
   */
  async extract(paths: GraphifyPaths, repoRoot: string): Promise<GraphifyResult> {
    const args = ['extract', repoRoot, '--out', paths.parent];
    args.push(...(this.backend ? ['--backend', this.backend] : ['--code-only']));
    return this.exec(args, {
      paths,
      cwd: repoRoot,
      timeoutMs: this.extractTimeoutMs,
    });
  }

  /** Incremental: re-extracts only the code files that changed, and merges. */
  async update(paths: GraphifyPaths, repoRoot: string): Promise<GraphifyResult> {
    return this.exec(['update', repoRoot], {
      paths,
      cwd: repoRoot,
      timeoutMs: this.extractTimeoutMs,
    });
  }

  async saveResult(
    paths: GraphifyPaths,
    input: {
      question: string;
      answer: string;
      nodes: string[];
      outcome: 'useful' | 'dead_end' | 'corrected';
      correction?: string;
    },
  ): Promise<GraphifyResult> {
    const args = [
      'save-result',
      '--question',
      input.question,
      '--answer',
      input.answer,
      '--outcome',
      input.outcome,
      // Explicit rather than inherited: `save-result` defaults to a path
      // relative to the working directory, which would be the user's repo.
      '--memory-dir',
      paths.memoryDir,
    ];
    if (input.correction) args.push('--correction', input.correction);
    if (input.nodes.length) args.push('--nodes', ...input.nodes);
    return this.exec(args, { paths, timeoutMs: this.timeoutMs });
  }

  /**
   * Aggregate saved outcomes into `LESSONS.md`.
   *
   * There is no `--if-stale` flag on the real binary, whatever the
   * documentation says — deciding when this is worth running is Vowe's job.
   */
  async reflect(paths: GraphifyPaths): Promise<GraphifyResult> {
    return this.exec(
      [
        'reflect',
        '--memory-dir',
        paths.memoryDir,
        '--out',
        paths.lessonsFile,
        '--graph',
        paths.graphFile,
      ],
      { paths, timeoutMs: this.timeoutMs },
    );
  }

  private async exec(
    args: string[],
    options: { paths?: GraphifyPaths; cwd?: string; timeoutMs: number },
  ): Promise<GraphifyResult> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.paths) env['GRAPHIFY_OUT'] = options.paths.outDir;

    const runOptions: GraphifyRunOptions = {
      env,
      timeoutMs: options.timeoutMs,
    };
    if (options.cwd) runOptions.cwd = options.cwd;

    try {
      const { stdout } = await this.run(this.bin, args, runOptions);
      return { ok: true, stdout };
    } catch (error) {
      this.onError(`graphify:${args[0] ?? 'run'}`, error);
      return { ok: false, stdout: '', failure: describe(error) };
    }
  }
}

const defaultRun: GraphifyRun = async (bin, args, options) => {
  const execOptions: Parameters<typeof execFileAsync>[2] = {
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  };
  if (options.cwd) execOptions.cwd = options.cwd;
  const { stdout, stderr } = await execFileAsync(bin, args, execOptions);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** `graphify 0.9.64`, `0.9.64`, `graphify, version 0.9.64` — take the digits. */
export function parseVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match ? match[0] : null;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error ? String(error.stderr).trim() : '';
    if (stderr) return stderr.split('\n')[0]!;
    if ('code' in error && error.code === 'ENOENT') return 'not found on PATH';
  }
  return error instanceof Error ? error.message : String(error);
}
