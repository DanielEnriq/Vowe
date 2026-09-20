import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Who a repository is, canonically.
 *
 * Shared by every session working in it, whichever worktree or subdirectory
 * they happen to sit in. Nothing here describes a particular session.
 */
export interface ProjectIdentity {
  kind: 'git' | 'path';
  /** The grouping key. Two sessions match when these are equal. */
  key: string;
  /** Repository directory name, or the directory's own name outside Git. */
  name: string;
  /**
   * The **main** worktree — never a linked one.
   *
   * Derived from the common Git directory rather than from the session's own
   * toplevel. Taking it from the session would make a project's identity depend
   * on which of its sessions happened to be discovered first.
   */
  repoRoot: string;
  gitCommonDir?: string;
  /** Metadata only. Deliberately not canonicalized. */
  remoteUrl?: string;
}

/**
 * Where one particular session is working.
 *
 * Per session, never shared. Coincides with the project's `repoRoot` for a
 * session in the main worktree and diverges for every other one — conflating
 * the two is exactly how worktree grouping silently breaks.
 */
export interface SessionLocation {
  /** This session's own toplevel. */
  worktreePath: string;
  branch?: string;
  /** False when this session sits in a linked worktree. */
  isPrimaryWorktree: boolean;
}

export interface RepositoryResolution {
  project: ProjectIdentity;
  location: SessionLocation;
}

export interface ResolveOptions {
  timeoutMs?: number;
}

/**
 * Work out which repository a directory belongs to.
 *
 * One `git rev-parse` answers the grouping question:
 *
 *   --git-common-dir   identical across every worktree of a repository
 *   --show-toplevel    different for each worktree
 *
 * So the common directory is the identity and the toplevel is the location.
 * Worktree grouping then falls out of the data rather than needing to be
 * detected.
 *
 * `--path-format=absolute` is not optional: without it the main worktree
 * reports a bare relative `.git` while a linked worktree reports an absolute
 * path, and two sessions in the same repository would not compare equal.
 *
 * Returns `null` only when there is nothing to resolve — no directory at all.
 * A directory outside Git resolves by path rather than failing, because an
 * agent working outside a repository is a normal thing that must not break.
 */
export async function resolveRepository(
  cwd: string | null,
  options: ResolveOptions = {},
): Promise<RepositoryResolution | null> {
  if (!cwd) return null;
  const timeout = options.timeoutMs ?? 5000;

  try {
    const { stdout } = await run(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
      { cwd, timeout, windowsHide: true },
    );
    const [gitCommonDir, worktreePath] = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (gitCommonDir && worktreePath) {
      return gitResolution(gitCommonDir, worktreePath, cwd, timeout);
    }
  } catch {
    // Not a repository, git is missing, or the directory is unreadable. All
    // three mean the same thing here: fall back to the path.
  }

  return pathResolution(cwd);
}

async function gitResolution(
  gitCommonDir: string,
  worktreePath: string,
  cwd: string,
  timeout: number,
): Promise<RepositoryResolution> {
  // `…/Vowe/.git` → `…/Vowe`. For a linked worktree this yields the *main*
  // worktree, which is the whole point: the name and root describe the
  // repository, not whichever copy this session is sitting in.
  const repoRoot = path.dirname(gitCommonDir);

  const project: ProjectIdentity = {
    kind: 'git',
    key: `git:${gitCommonDir}`,
    name: path.basename(repoRoot) || repoRoot,
    repoRoot,
    gitCommonDir,
  };

  const remoteUrl = await readRemoteUrl(cwd, timeout);
  if (remoteUrl) project.remoteUrl = remoteUrl;

  const branch = await readBranch(cwd, timeout);
  const location: SessionLocation = {
    worktreePath,
    isPrimaryWorktree: worktreePath === repoRoot,
  };
  if (branch) location.branch = branch;

  return { project, location };
}

/**
 * The fallback for a directory that is not in a repository.
 *
 * Deliberately simple: the directory is the project. The brief is explicit that
 * arbitrary workspace semantics are not worth solving here — what matters is
 * that the session still appears somewhere sensible.
 */
async function pathResolution(cwd: string): Promise<RepositoryResolution> {
  const canonical = await canonicalize(cwd);
  return {
    project: {
      kind: 'path',
      key: `path:${canonical}`,
      name: path.basename(canonical) || canonical,
      repoRoot: canonical,
    },
    location: { worktreePath: canonical, isPrimaryWorktree: true },
  };
}

/**
 * A stable, opaque id for a repository.
 *
 * Derived from the key rather than allocated and stored, so it is identical
 * across restarts without a lookup — and opaque, so a filesystem path stays
 * metadata rather than becoming the user-facing identity.
 */
export function projectIdFor(identity: ProjectIdentity): string {
  const digest = createHash('sha256').update(identity.key).digest('hex');
  return `${identity.kind}:${digest.slice(0, 16)}`;
}

async function readRemoteUrl(cwd: string, timeout: number): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      timeout,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    // A repository with no remote is perfectly ordinary.
    return null;
  }
}

async function readBranch(cwd: string, timeout: number): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout,
      windowsHide: true,
    });
    const branch = stdout.trim();
    // A detached HEAD reports "HEAD", which is not a branch name.
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/** Resolve symlinks so `/tmp` and `/private/tmp` cannot become two projects. */
async function canonicalize(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}
