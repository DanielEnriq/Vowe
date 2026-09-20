import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Real repositories in temporary directories.
 *
 * Worktree grouping is the one behaviour here most worth not mocking: it turns
 * on how `git rev-parse` reports paths, which is precisely what a fake would
 * have to guess at. These fixtures make the tests slower and worth trusting.
 */
export class GitFixtures {
  private readonly roots: string[] = [];

  /** An initialised repository with one commit. */
  async repo(name = 'repo'): Promise<string> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'vowe-git-'));
    this.roots.push(base);
    const root = path.join(base, name);
    await mkdir(root, { recursive: true });

    await this.git(root, ['init', '-q', '-b', 'main']);
    await this.git(root, ['config', 'user.email', 'test@example.invalid']);
    await this.git(root, ['config', 'user.name', 'Test']);
    await writeFile(path.join(root, 'README.md'), '# test\n', 'utf8');
    await this.git(root, ['add', '.']);
    await this.git(root, ['commit', '-q', '-m', 'first']);
    return root;
  }

  /** A linked worktree of `repoRoot`, on its own branch. */
  async worktree(repoRoot: string, branch: string): Promise<string> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'vowe-wt-'));
    this.roots.push(base);
    const target = path.join(base, branch);
    await this.git(repoRoot, ['worktree', 'add', '-q', '-b', branch, target]);
    return target;
  }

  async subdirectory(repoRoot: string, relative: string): Promise<string> {
    const target = path.join(repoRoot, relative);
    await mkdir(target, { recursive: true });
    return target;
  }

  /** A plain directory, deliberately not a repository. */
  async plainDirectory(name = 'plain'): Promise<string> {
    const base = await mkdtemp(path.join(os.tmpdir(), 'vowe-plain-'));
    this.roots.push(base);
    const target = path.join(base, name);
    await mkdir(target, { recursive: true });
    return target;
  }

  async setRemote(repoRoot: string, url: string): Promise<void> {
    await this.git(repoRoot, ['remote', 'add', 'origin', url]);
  }

  /**
   * Write a file and commit it.
   *
   * Committing is not incidental: `git grep` searches tracked files, so an
   * uncommitted file is invisible to repository search. A fixture that only
   * wrote the file would be testing something Vowe does not do.
   */
  async commitFile(
    repoRoot: string,
    relative: string,
    content: string,
  ): Promise<string> {
    const file = path.join(repoRoot, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    await this.git(repoRoot, ['add', relative]);
    await this.git(repoRoot, ['commit', '-q', '-m', `add ${relative}`]);
    return file;
  }

  /** The commit HEAD currently points at. */
  async head(repoRoot: string): Promise<string> {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      timeout: 20_000,
      windowsHide: true,
    });
    return stdout.trim();
  }

  async cleanup(): Promise<void> {
    await Promise.all(
      this.roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  }

  private async git(cwd: string, args: string[]): Promise<void> {
    await run('git', args, {
      cwd,
      timeout: 20_000,
      windowsHide: true,
      env: {
        ...process.env,
        // Keep the developer's own git config out of the fixtures.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
  }
}
