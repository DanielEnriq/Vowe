import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { RepositoryBasis } from '../studio/model.js';

const run = promisify(execFile);

/**
 * The repository state a read happens against: which checkout, which commit,
 * and whether uncommitted changes meant the commit alone does not reproduce
 * it.
 *
 * What makes a Studio design's "today" temporally meaningful. A part recorded
 * as existing in the code is only true of some checkout at some moment; when
 * a proposal is later reconciled with what landed, this says which one.
 *
 * Never throws: outside Git, or with git missing, the basis is the directory
 * with no commit.
 */
export async function readRepositoryBasis(root: string, now: () => Date = () => new Date()): Promise<RepositoryBasis> {
  const at = now().toISOString();
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run('git', args, { cwd: root, timeout: 5000, windowsHide: true });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  const [worktree, head, branch, status] = await Promise.all([
    git(['rev-parse', '--show-toplevel']),
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git(['status', '--porcelain', '--untracked-files=no']),
  ]);
  return {
    worktree: worktree || root,
    head: head || null,
    // A detached HEAD reports "HEAD", which is not a branch name.
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
    dirty: !!status,
    at,
  };
}
