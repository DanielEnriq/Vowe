import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  projectIdFor,
  resolveRepository,
} from '../src/projects/repository-identity.js';
import { GitFixtures } from './git-fixtures.js';

const git = new GitFixtures();
afterEach(() => git.cleanup());

describe('repository identity — acceptance 1 and 2: grouping', () => {
  it('gives the repository, a subdirectory and a worktree the same identity', async () => {
    const repo = await git.repo('Vowe');
    const nested = await git.subdirectory(repo, 'packages/core/src');
    const worktree = await git.worktree(repo, 'feature');

    const [fromRoot, fromNested, fromWorktree] = await Promise.all([
      resolveRepository(repo),
      resolveRepository(nested),
      resolveRepository(worktree),
    ]);

    // The grouping invariant: one repository, one identity, whichever copy or
    // subdirectory a session happens to be sitting in.
    const keys = [fromRoot, fromNested, fromWorktree].map((r) => r!.project.key);
    expect(new Set(keys).size).toBe(1);

    const ids = [fromRoot, fromNested, fromWorktree].map((r) =>
      projectIdFor(r!.project),
    );
    expect(new Set(ids).size).toBe(1);

    for (const resolution of [fromRoot, fromNested, fromWorktree]) {
      expect(resolution!.project.name).toBe('Vowe');
      expect(resolution!.project.repoRoot).toBe(await realpath(repo));
    }
  });

  it('keeps the session’s own worktree separate from the project’s root', async () => {
    const repo = await git.repo('Vowe');
    const worktree = await git.worktree(repo, 'feature');

    const main = (await resolveRepository(repo))!;
    const linked = (await resolveRepository(worktree))!;

    // Same project...
    expect(linked.project.repoRoot).toBe(main.project.repoRoot);
    // ...different location. Conflating these is how worktree grouping breaks.
    expect(linked.location.worktreePath).not.toBe(main.location.worktreePath);
    expect(linked.location.worktreePath).toBe(await realpath(worktree));

    expect(main.location.isPrimaryWorktree).toBe(true);
    expect(linked.location.isPrimaryWorktree).toBe(false);

    expect(main.location.branch).toBe('main');
    expect(linked.location.branch).toBe('feature');
  });

  it('names the repository from the main worktree, even when resolved from a linked one', async () => {
    const repo = await git.repo('Vowe');
    // The worktree directory is called "feature", not "Vowe".
    const worktree = await git.worktree(repo, 'feature');

    const resolution = (await resolveRepository(worktree))!;
    expect(resolution.project.name).toBe('Vowe');
    expect(path.basename(resolution.location.worktreePath)).toBe('feature');
  });

  it('separates two unrelated repositories', async () => {
    const [a, b] = await Promise.all([git.repo('alpha'), git.repo('beta')]);
    const [ra, rb] = await Promise.all([resolveRepository(a), resolveRepository(b)]);

    expect(ra!.project.key).not.toBe(rb!.project.key);
    expect(projectIdFor(ra!.project)).not.toBe(projectIdFor(rb!.project));
  });

  it('records a remote when there is one, without canonicalizing it', async () => {
    const repo = await git.repo('withremote');
    await git.setRemote(repo, 'git@github.com:someone/Thing.git');

    const resolution = (await resolveRepository(repo))!;
    expect(resolution.project.remoteUrl).toBe('git@github.com:someone/Thing.git');
    // Identity still comes from the local repository, not the remote.
    expect(resolution.project.key).toContain('.git');
  });

  it('gives a stable id across repeated resolution', async () => {
    const repo = await git.repo('stable');
    const first = await resolveRepository(repo);
    const second = await resolveRepository(repo);
    expect(projectIdFor(first!.project)).toBe(projectIdFor(second!.project));
  });
});

describe('repository identity — acceptance 8: outside Git', () => {
  it('falls back to the directory rather than failing', async () => {
    const plain = await git.plainDirectory('scratch');
    const resolution = (await resolveRepository(plain))!;

    expect(resolution.project.kind).toBe('path');
    expect(resolution.project.name).toBe('scratch');
    expect(resolution.project.repoRoot).toBe(await realpath(plain));
    expect(resolution.location.isPrimaryWorktree).toBe(true);
  });

  it('groups two sessions in the same non-Git directory together', async () => {
    const plain = await git.plainDirectory('scratch');
    const [a, b] = await Promise.all([
      resolveRepository(plain),
      resolveRepository(plain),
    ]);
    expect(projectIdFor(a!.project)).toBe(projectIdFor(b!.project));
  });

  it('resolves symlinked paths to one identity', async () => {
    // /tmp is a symlink to /private/tmp on macOS; two spellings of one
    // directory must not become two projects.
    const plain = await git.plainDirectory('scratch');
    const real = await realpath(plain);
    if (real === plain) return; // No symlink on this platform; nothing to prove.

    const [viaLink, viaReal] = await Promise.all([
      resolveRepository(plain),
      resolveRepository(real),
    ]);
    expect(projectIdFor(viaLink!.project)).toBe(projectIdFor(viaReal!.project));
  });

  it('fails soft on a path that does not exist', async () => {
    const resolution = await resolveRepository('/definitely/not/here/at/all');
    expect(resolution).not.toBeNull();
    expect(resolution!.project.kind).toBe('path');
  });

  it('returns null only when there is no directory at all', async () => {
    expect(await resolveRepository(null)).toBeNull();
  });
});
