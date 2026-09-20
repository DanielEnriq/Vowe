import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '@vowe/core';

import { GraphifyCli, GraphifyProjectKnowledgeProvider } from '../src/index.js';

const run = promisify(execFile);

/**
 * The one test that runs the real binary.
 *
 * Everything else in this package is a unit test against a captured argv, which
 * proves Vowe calls Graphify the way Vowe intends to — but not that Graphify
 * answers the way Vowe expects. This closes that gap, and it is skipped rather
 * than failed when the binary is absent, because `pnpm test` has always run on
 * a machine with nothing but git installed.
 */
const BIN = await findGraphify();

async function findGraphify(): Promise<string | null> {
  for (const candidate of [
    process.env['VOWE_GRAPHIFY_BIN'],
    'graphify',
    path.join(homedir(), '.local', 'bin', 'graphify'),
  ]) {
    if (!candidate) continue;
    try {
      await run(candidate, ['--version'], { timeout: 20_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!BIN)('the real graphify binary', () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-live-'));
    roots.push(root);
    const repoRoot = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    await mkdir(path.join(repoRoot, 'src'), { recursive: true });

    await writeFile(
      path.join(repoRoot, 'src', 'registry.ts'),
      [
        'export class SessionRegistry {',
        '  absorb(session: string) { return assignProject(session); }',
        '}',
        'export function assignProject(session: string) { return session; }',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(repoRoot, 'src', 'project.ts'),
      [
        "import { assignProject } from './registry';",
        'export class ProjectService { resolve(s: string) { return assignProject(s); } }',
        '',
      ].join('\n'),
      'utf8',
    );

    const project: Project = {
      id: 'git:live',
      name: 'repo',
      repoRoot,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    const provider = new GraphifyProjectKnowledgeProvider({
      cli: new GraphifyCli({ bin: BIN!, extractTimeoutMs: 120_000 }),
      resolveProject: () => project,
      dataDirFor: () => dataDir,
      headCommit: async () => null,
    });
    return { provider, repoRoot, dataDir };
  }

  it('indexes a repository, answers from it, and leaves the repository alone', async () => {
    const { provider, repoRoot } = await fixture();

    await provider.ensureIndexed('git:live');
    // The build runs in the background; this test is the one place that waits.
    await waitFor(() => provider.status('git:live').status === 'ready');

    const hits = await provider.search({
      projectId: 'git:live',
      query: 'How does SessionRegistry connect to ProjectService?',
      limit: 8,
    });
    const labels = hits.map((hit) => hit.label);
    expect(labels).toContain('SessionRegistry');
    expect(labels).toContain('ProjectService');
    // Neither the question nor any file name contains this. It comes from the
    // graph, which is the entire point of having one.
    expect(labels).toContain('assignProject()');

    const registry = hits.find((hit) => hit.label === 'SessionRegistry')!;
    expect(registry.locations[0]!.path).toBe(path.join(repoRoot, 'src', 'registry.ts'));
    expect(registry.locations[0]!.line).toBe(1);

    // Nothing was written into the checkout — no graphify-out/, nothing.
    expect((await readdir(repoRoot)).sort()).toEqual(['src']);
  }, 180_000);

  it('picks up a change through an incremental update', async () => {
    const { provider, repoRoot } = await fixture();
    await provider.ensureIndexed('git:live');
    await waitFor(() => provider.status('git:live').status === 'ready');

    await writeFile(
      path.join(repoRoot, 'src', 'registry.ts'),
      [
        'export class SessionRegistry {',
        '  absorb(session: string) { return assignProject(session); }',
        '}',
        'export function assignProject(session: string) { return session; }',
        'export function brandNewSymbol() { return 42; }',
        '',
      ].join('\n'),
      'utf8',
    );

    expect(
      await provider.search({ projectId: 'git:live', query: 'brandNewSymbol' }),
    ).toEqual([]);

    await provider.refresh('git:live');
    await waitFor(() => provider.status('git:live').status === 'ready');

    const hits = await provider.search({
      projectId: 'git:live',
      query: 'brandNewSymbol',
    });
    expect(hits.map((hit) => hit.label)).toContain('brandNewSymbol()');
  }, 180_000);
});

async function waitFor(
  condition: () => boolean,
  timeoutMs = 150_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the index to become ready.');
}
