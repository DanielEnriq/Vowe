import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project, RepoIndexState } from '@vowe/core';

import {
  graphifyPaths,
  GraphifyCli,
  GraphifyProjectKnowledgeProvider,
  type GraphifyRun,
  type GraphifyRunOptions,
} from '../src/index.js';

const PROJECT = 'git:abc123';
// Completion, not wall-clock speed: parallel SQLite/probe tests can delay I/O.
const settle = async (provider: GraphifyProjectKnowledgeProvider, file: string) => {
  await expect.poll(async () => {
    const state=provider.status(PROJECT);
    if(state.status==='indexing') return false;
    try {return JSON.stringify(JSON.parse(await readFile(file,'utf8')))===JSON.stringify(state);}
    catch {return false;}
  }, {timeout:5000}).toBe(true);
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Call {
  args: string[];
  options: GraphifyRunOptions;
}

/**
 * A fixture that stands in for the whole of Graphify: it records the commands,
 * and writes a graph where a real extraction would have written one.
 */
async function harness(options: { head?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-lifecycle-'));
  roots.push(root);
  const repoRoot = path.join(root, 'repo');
  const dataDir = path.join(root, 'data', 'projects', 'git_abc123');
  await mkdir(repoRoot, { recursive: true });

  const calls: Call[] = [];
  let head = options.head ?? 'commit-1';

  const runImpl: GraphifyRun = async (_bin, args, runOptions) => {
    calls.push({ args, options: runOptions });
    const out = runOptions.env['GRAPHIFY_OUT'];
    if (out && (args[0] === 'extract' || args[0] === 'update')) {
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(out, 'graph.json'),
        JSON.stringify({
          nodes: [{ id: 'n1', label: 'Thing', source_file: 'thing.ts' }],
          links: [],
        }),
        'utf8',
      );
    }
    return { stdout: '', stderr: '' };
  };

  const project: Project = {
    id: PROJECT,
    name: 'repo',
    repoRoot,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const make = () =>
    new GraphifyProjectKnowledgeProvider({
      cli: new GraphifyCli({ runImpl }),
      resolveProject: () => project,
      dataDirFor: () => dataDir,
      headCommit: async () => head,
    });

  return {
    calls,
    dataDir,
    repoRoot,
    make,
    provider: make(),
    moveHead: (to: string) => {
      head = to;
    },
    statePath: path.join(dataDir, 'knowledge', 'index.json'),
    paths: graphifyPaths(path.join(dataDir, 'knowledge')),
  };
}

describe('acceptance 1: building persistent repository knowledge', () => {
  it('extracts on the first request, into Vowe’s own directory', async () => {
    const h = await harness();

    const state = h.provider.ensureIndexed(PROJECT);
    expect((await state).status).toBe('indexing');
    await settle(h.provider,h.statePath);

    const [call] = h.calls;
    expect(call!.args[0]).toBe('extract');
    // Both mechanisms, both pointing inside Vowe's data directory. Nothing
    // Graphify writes may land in the user's repository.
    expect(call!.args).toContain('--out');
    expect(call!.options.env['GRAPHIFY_OUT']!.startsWith(h.dataDir)).toBe(true);
    expect(call!.options.env['GRAPHIFY_OUT']!.startsWith(h.repoRoot)).toBe(false);

    expect(h.provider.status(PROJECT).status).toBe('ready');
    expect(h.provider.status(PROJECT).indexedCommit).toBe('commit-1');
  });

  it('builds once, however many questions arrive at the same time', async () => {
    const h = await harness();

    await Promise.all([
      h.provider.ensureIndexed(PROJECT),
      h.provider.ensureIndexed(PROJECT),
      h.provider.ensureIndexed(PROJECT),
    ]);
    await settle(h.provider,h.statePath);

    expect(h.calls.filter((call) => call.args[0] === 'extract')).toHaveLength(1);
  });

  it('survives a restart without rebuilding', async () => {
    const h = await harness();
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);
    expect(h.calls).toHaveLength(1);

    // Quit Vowe, start it again: a new provider over the same directory.
    const restarted = h.make();
    const state = await restarted.ensureIndexed(PROJECT);

    expect(state.status).toBe('ready');
    expect(state.indexedAt).toBeDefined();
    expect(h.calls).toHaveLength(1);

    // And the graph is still usable, not just the state file.
    const hits = await restarted.search({ projectId: PROJECT, query: 'Thing' });
    expect(hits[0]!.label).toBe('Thing');
  });

  it('does not believe a state file that says a build is still running', async () => {
    const h = await harness();
    await mkdir(path.dirname(h.statePath), { recursive: true });
    // What a quit mid-extraction leaves behind. Nothing is running now.
    await writeFile(
      h.statePath,
      JSON.stringify({ projectId: PROJECT, status: 'indexing' } satisfies RepoIndexState),
      'utf8',
    );

    const restarted = h.make();
    expect((await restarted.hydrate(PROJECT)).status).toBe('unindexed');
  });

  it('records a failure instead of pretending to be ready', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-lifecycle-'));
    roots.push(root);
    const provider = new GraphifyProjectKnowledgeProvider({
      cli: new GraphifyCli({
        runImpl: async () => {
          throw Object.assign(new Error('boom'), { stderr: 'no such directory\n' });
        },
      }),
      resolveProject: () => ({
        id: PROJECT,
        name: 'repo',
        repoRoot: path.join(root, 'repo'),
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      dataDirFor: () => path.join(root, 'data'),
      headCommit: async () => null,
    });

    await provider.ensureIndexed(PROJECT);
    await settle(provider,path.join(root,'data','knowledge','index.json'));

    const state = provider.status(PROJECT);
    expect(state.status).toBe('error');
    expect(state.lastError).toBe('no such directory');
    // An error state still answers searches, emptily, rather than throwing.
    expect(await provider.search({ projectId: PROJECT, query: 'anything' })).toEqual([]);
  });
});

describe('acceptance 4: the index notices what no session did', () => {
  it('refreshes incrementally when HEAD has moved underneath it', async () => {
    const h = await harness();
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);

    // A `git pull` or a branch switch. No worker Vowe was watching did this.
    h.moveHead('commit-2');
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);

    expect(h.calls.map((call) => call.args[0])).toEqual(['extract', 'update']);
    expect(h.provider.status(PROJECT).indexedCommit).toBe('commit-2');
  });

  it('leaves a ready index alone when HEAD has not moved', async () => {
    const h = await harness();
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);

    expect(h.calls).toHaveLength(1);
  });

  it('refreshes a stale index rather than rebuilding it', async () => {
    const h = await harness();
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);

    h.provider.markStale(PROJECT);
    expect(h.provider.status(PROJECT).status).toBe('stale');

    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);
    expect(h.calls.map((call) => call.args[0])).toEqual(['extract', 'update']);
  });

  it('will not call an unbuilt index stale', async () => {
    const h = await harness();
    h.provider.markStale(PROJECT);
    // There is nothing on disk to refresh, so saying "stale" would be a claim
    // that something exists.
    expect(h.provider.status(PROJECT).status).toBe('unindexed');
  });

  it('keeps serving the old graph while a refresh runs', async () => {
    const h = await harness();
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);

    h.provider.markStale(PROJECT);
    void h.provider.refresh(PROJECT);

    // Slightly-behind orientation still orients, and source and diff are
    // authoritative anyway. Returning nothing here would be worse.
    const hits = await h.provider.search({ projectId: PROJECT, query: 'Thing' });
    expect(hits).toHaveLength(1);
    await settle(h.provider,h.statePath);
  });

  it('writes its state where the store said, and nowhere near the repository', async () => {
    const h = await harness();
    await h.provider.ensureIndexed(PROJECT);
    await settle(h.provider,h.statePath);

    const state = JSON.parse(await readFile(h.statePath, 'utf8')) as RepoIndexState;
    expect(state.status).toBe('ready');
    // The graph really is on disk where Vowe said it would be, and the
    // repository is untouched.
    expect(JSON.parse(await readFile(h.paths.graphFile, 'utf8')).nodes).toHaveLength(1);
    expect(await readdir(h.repoRoot)).toEqual([]);
  });
});
