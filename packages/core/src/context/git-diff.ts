import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface DiffResult {
  /** Absolute path the diff was taken in, or `null` when unknown. */
  cwd: string | null;
  /** `git diff --stat`, which is usually what a question actually wants. */
  stat: string;
  /** The unified diff, truncated. */
  patch: string;
  truncated: boolean;
  /** Set when no diff could be taken, e.g. the session has no working tree. */
  unavailable?: string;
}

export interface GitDiffOptions {
  cwd: string | null;
  path?: string;
  /** Hard ceiling on returned patch text. */
  maxBytes?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 24_000;

/**
 * The current diff of a session's working tree.
 *
 * Diffs stay first-class because "what did it actually change?" is the question
 * that most often cannot be answered from the trace alone — the trace records
 * that an edit happened, not what the file looks like now.
 *
 * Deliberately limited to the *current* state. Reconstructing historical diffs
 * would mean either keeping our own copies of the tree or replaying edits, and
 * neither is justified yet.
 */
export async function getGitDiff(options: GitDiffOptions): Promise<DiffResult> {
  const { cwd } = options;
  if (!cwd) {
    return {
      cwd: null,
      stat: '',
      patch: '',
      truncated: false,
      unavailable: 'This session has no known working directory.',
    };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeout = options.timeoutMs ?? 10_000;
  // Include staged changes: a worker that has run `git add` has still changed
  // the tree, and the developer asking "what did it change?" means both.
  const pathArgs = options.path ? ['--', options.path] : [];

  try {
    const [stat, patch] = await Promise.all([
      git(['diff', 'HEAD', '--stat', ...pathArgs], cwd, timeout),
      git(['diff', 'HEAD', ...pathArgs], cwd, timeout),
    ]);

    const truncated = patch.length > maxBytes;
    return {
      cwd,
      stat: stat.trim(),
      patch: truncated
        ? `${patch.slice(0, maxBytes)}\n… diff truncated at ${maxBytes} bytes …`
        : patch,
      truncated,
    };
  } catch (error) {
    return {
      cwd,
      stat: '',
      patch: '',
      truncated: false,
      unavailable: describe(error),
    };
  }
}

/**
 * `git grep -n` over a session's working tree.
 *
 * This is the whole of the `repo` search source for now. It is not an index and
 * does not pretend to be one — but it respects `.gitignore`, which a naive
 * recursive walk would not, and that is most of the value an index would add at
 * this scale.
 */
export async function gitGrep(
  cwd: string | null,
  query: string,
  limit: number,
  timeoutMs = 10_000,
): Promise<{ path: string; line: number; text: string }[]> {
  if (!cwd || !query.trim()) return [];
  try {
    const output = await git(
      [
        'grep',
        '--no-color',
        '-n',
        '-I', // skip binaries
        '--fixed-strings',
        '--ignore-case',
        '--max-count',
        String(Math.max(1, Math.ceil(limit / 2))),
        '-e',
        query,
      ],
      cwd,
      timeoutMs,
    );
    const hits: { path: string; line: number; text: string }[] = [];
    for (const raw of output.split('\n')) {
      if (hits.length >= limit) break;
      const match = /^([^:]+):(\d+):(.*)$/.exec(raw);
      if (!match) continue;
      hits.push({
        path: match[1]!,
        line: Number(match[2]),
        text: match[3]!.trim(),
      });
    }
    return hits;
  } catch {
    // `git grep` exits non-zero when it finds nothing, and also when the
    // directory is not a repository. Neither is worth surfacing as an error.
    return [];
  }
}

async function git(args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr.split('\n')[0]!;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Repository file paths, matched by name.
 *
 * Paths, never contents. What a file *says* is read by opening it, which keeps
 * reading material on the one channel that was built to carry it — this
 * answers with addresses and stops there.
 *
 * `--cached --others --exclude-standard` rather than a bare `ls-files`: the
 * worker may have written a file two minutes ago that has never been staged,
 * and a search that could not find the thing that was just created would be
 * useless exactly when it matters most. `--exclude-standard` keeps ignored
 * files out, so the answer is the repository rather than `node_modules`.
 *
 * A blank query returns nothing rather than everything. This is a search, not
 * a file tree, and the launcher says so.
 */
export async function listGitFiles(
  cwd: string | null,
  query: string,
  limit: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const needle = query.trim().toLowerCase();
  if (!cwd || !needle) return [];
  try {
    const output = await git(
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      cwd,
      timeoutMs,
    );
    const found: string[] = [];
    for (const path of output.split('\0')) {
      if (found.length >= limit) break;
      if (path && path.toLowerCase().includes(needle)) found.push(path);
    }
    return found;
  } catch {
    // Not a repository, or git is unavailable. Neither is worth an error: the
    // launcher simply has nothing to offer from the repository.
    return [];
  }
}
