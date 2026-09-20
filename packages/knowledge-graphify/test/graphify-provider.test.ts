import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '@vowe/core';
import { UnavailableProjectKnowledge } from '@vowe/core';

import {
  compareVersions,
  GraphifyCli,
  GraphifyGraphReader,
  graphifyPaths,
  GraphifyProjectKnowledgeProvider,
  LexicalRetrieval,
  parseVersion,
  type GraphifyRun,
  type GraphifyRunOptions,
} from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/graph.json', import.meta.url));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vowe-knowledge-'));
  roots.push(root);
  return root;
}

interface Call {
  bin: string;
  args: string[];
  options: GraphifyRunOptions;
}

/** Records every invocation instead of running one, the way jev.test.ts does. */
function capturingRun(
  calls: Call[],
  stdout: (args: string[]) => string = () => '',
): GraphifyRun {
  return async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout: stdout(args), stderr: '' };
  };
}

function project(repoRoot: string): Project {
  return {
    id: 'git:abc123',
    name: 'fixture',
    repoRoot,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------- the reader

describe('GraphifyGraphReader — node-link is a shape, not a contract', () => {
  it('reads what the extractor actually writes', async () => {
    const graph = await new GraphifyGraphReader().read(FIXTURE);
    expect(graph).not.toBeNull();
    const node = graph!.nodes.get('src_registry_sessionregistry')!;
    expect(node.label).toBe('SessionRegistry');
    expect(node.sourceFile).toBe('src/registry.ts');
    // `source_location` is the string "L1". Nothing else in Vowe should ever
    // have to know that.
    expect(node.line).toBe(1);
    // And no `type` field exists on an AST node, so the kind is inferred.
    expect(node.kind).toBe('class');
    expect(graph!.nodes.get('src_registry_assignproject')?.kind).toBe('function');
  });

  it('accepts `edges` as well as `links`', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'graph.json');
    await writeFile(
      file,
      JSON.stringify({
        nodes: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
        edges: [{ source: 'a', target: 'b', relationship: 'imports' }],
      }),
      'utf8',
    );
    const graph = await new GraphifyGraphReader().read(file);
    expect(graph!.neighbours.get('a')).toEqual([
      { nodeId: 'b', relation: 'imports', direction: 'out' },
    ]);
  });

  it('keeps a node with no source location, and drops a dangling edge', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'graph.json');
    await writeFile(
      file,
      JSON.stringify({
        nodes: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }],
        links: [
          { source: 'a', target: 'b', relation: 'calls' },
          { source: 'a', target: 'ghost', relation: 'calls' },
        ],
      }),
      'utf8',
    );
    const graph = await new GraphifyGraphReader().read(file);
    // Graphify's own docs: do not assume every node has a line number.
    expect(graph!.nodes.get('a')?.line).toBeUndefined();
    expect(graph!.nodes.get('a')?.sourceFile).toBeUndefined();
    expect(graph!.nodes.has('ghost')).toBe(false);
    expect(graph!.neighbours.get('a')).toEqual([
      { nodeId: 'b', relation: 'calls', direction: 'out' },
    ]);
  });

  it('treats a missing or half-written graph as no graph, never as an error', async () => {
    const root = await tempRoot();
    const reader = new GraphifyGraphReader();
    expect(await reader.read(path.join(root, 'absent.json'))).toBeNull();

    const partial = path.join(root, 'partial.json');
    await writeFile(partial, '{"nodes": [{"id": "a"', 'utf8');
    expect(await reader.read(partial)).toBeNull();
  });
});

// ------------------------------------------------------------- the retrieval

describe('LexicalRetrieval', () => {
  it('surfaces the thing in between, which the question never named', async () => {
    const graph = (await new GraphifyGraphReader().read(FIXTURE))!;
    const hits = new LexicalRetrieval().retrieve(
      graph,
      'How does SessionRegistry connect to ProjectService?',
      8,
    );
    const labels = hits.map((hit) => hit.node.label);

    expect(labels).toContain('SessionRegistry');
    expect(labels).toContain('ProjectService');
    // The real extractor makes `.absorb()` its own node, so the route runs
    // SessionRegistry → .absorb() → assignProject(). Charging a hop for the
    // first step would stop one short of the actual answer.
    expect(labels).toContain('assignProject()');
    expect(labels).not.toContain('formatBytes()');
  });

  it('returns nothing for a query with no usable terms', async () => {
    const graph = (await new GraphifyGraphReader().read(FIXTURE))!;
    expect(new LexicalRetrieval().retrieve(graph, '?? !', 5)).toEqual([]);
  });
});

// -------------------------------------------------------------------- the CLI

describe('GraphifyCli — nothing is written inside the user repository', () => {
  it('points --out at the parent and GRAPHIFY_OUT at the directory inside it', async () => {
    const calls: Call[] = [];
    const cli = new GraphifyCli({ runImpl: capturingRun(calls) });
    const paths = graphifyPaths('/vowe/knowledge');

    await cli.extract(paths, '/repo');

    const [call] = calls;
    // The two are not the same path, and getting them the same way round is
    // the difference between a graph Vowe can find and one it cannot.
    expect(call!.args).toEqual([
      'extract',
      '/repo',
      '--out',
      '/vowe/knowledge',
      '--code-only',
    ]);
    expect(call!.options.env['GRAPHIFY_OUT']).toBe(
      path.join('/vowe/knowledge', 'graphify-out'),
    );
    expect(paths.graphFile).toBe(
      path.join('/vowe/knowledge', 'graphify-out', 'graph.json'),
    );
  });

  it('uses a semantic backend only when one is configured', async () => {
    const calls: Call[] = [];
    await new GraphifyCli({
      backend: 'claude',
      runImpl: capturingRun(calls),
    }).extract(graphifyPaths('/vowe/knowledge'), '/repo');
    expect(calls[0]!.args).toContain('--backend');
    expect(calls[0]!.args).not.toContain('--code-only');
  });

  it('refreshes incrementally rather than rebuilding', async () => {
    const calls: Call[] = [];
    const paths = graphifyPaths('/vowe/knowledge');
    await new GraphifyCli({ runImpl: capturingRun(calls) }).update(paths, '/repo');
    // `update` has no --out flag at all, so the environment is the only thing
    // keeping its output out of the user's repository.
    expect(calls[0]!.args).toEqual(['update', '/repo']);
    expect(calls[0]!.options.env['GRAPHIFY_OUT']).toBe(paths.outDir);
  });

  it('mirrors work memory with an explicit memory directory', async () => {
    const calls: Call[] = [];
    const cli = new GraphifyCli({ runImpl: capturingRun(calls) });
    const paths = graphifyPaths('/vowe/knowledge');

    await cli.saveResult(paths, {
      question: 'Where is a project assigned?',
      answer: 'In SessionRegistry.absorb().',
      nodes: ['SessionRegistry', 'assignProject'],
      outcome: 'useful',
    });
    await cli.reflect(paths);

    // `--memory-dir` defaults to a path relative to the working directory, so
    // leaving it off would write into whichever repository Vowe happened to be
    // standing in.
    expect(calls[0]!.args).toEqual([
      'save-result',
      '--question',
      'Where is a project assigned?',
      '--answer',
      'In SessionRegistry.absorb().',
      '--outcome',
      'useful',
      '--memory-dir',
      paths.memoryDir,
      '--nodes',
      'SessionRegistry',
      'assignProject',
    ]);
    expect(calls[1]!.args).toEqual([
      'reflect',
      '--memory-dir',
      paths.memoryDir,
      '--out',
      paths.lessonsFile,
      '--graph',
      paths.graphFile,
    ]);
  });

  it('passes a correction through when there is one', async () => {
    const calls: Call[] = [];
    await new GraphifyCli({ runImpl: capturingRun(calls) }).saveResult(
      graphifyPaths('/vowe/knowledge'),
      {
        question: 'Where is a project assigned?',
        answer: 'In ProjectService.',
        nodes: [],
        outcome: 'corrected',
        correction: 'It is assigned in SessionRegistry.absorb().',
      },
    );
    expect(calls[0]!.args).toContain('--correction');
    expect(calls[0]!.args).toContain('It is assigned in SessionRegistry.absorb().');
  });

  it('returns a readable failure rather than throwing', async () => {
    const cli = new GraphifyCli({
      runImpl: async () => {
        throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
      },
    });
    const result = await cli.extract(graphifyPaths('/vowe/knowledge'), '/repo');
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not found on PATH');
  });
});

describe('version floor', () => {
  it('reads a version out of whatever the binary prints', () => {
    expect(parseVersion('graphify, version 0.9.64\n')).toBe('0.9.64');
    expect(parseVersion('0.10.0')).toBe('0.10.0');
    expect(parseVersion('no digits here')).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.64')).toBe(1);
    expect(compareVersions('0.9.64', '0.9.64')).toBe(0);
    expect(compareVersions('0.9.1', '0.9.64')).toBe(-1);
  });
});

// --------------------------------------------------------------- the provider

describe('acceptance 8: Graphify absent, too old, or switched off', () => {
  const deps = {
    resolveProject: () => null,
    dataDirFor: () => '/tmp/nowhere',
  };

  it('hands back the floor when the binary is missing', async () => {
    const provider = await GraphifyProjectKnowledgeProvider.fromEnvironment({
      ...deps,
      env: {},
      cliOptions: {
        runImpl: async () => {
          throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        },
      },
    });
    expect(provider).toBeInstanceOf(UnavailableProjectKnowledge);
    expect(provider.available).toBe(false);
    expect(provider.unavailableReason).toContain('not found on PATH');
    // The floor answers every question without anyone checking first.
    expect(await provider.search({ projectId: 'git:x', query: 'anything' })).toEqual([]);
    expect(await provider.open({ projectId: 'git:x', nodeId: 'n1' })).toBeNull();
    expect((await provider.ensureIndexed('git:x')).status).toBe('unindexed');
  });

  it('refuses a version below the floor and says which', async () => {
    const provider = await GraphifyProjectKnowledgeProvider.fromEnvironment({
      ...deps,
      env: { VOWE_GRAPHIFY_MIN_VERSION: '0.9.64' },
      cliOptions: { runImpl: async () => ({ stdout: 'graphify 0.9.12', stderr: '' }) },
    });
    expect(provider.available).toBe(false);
    expect(provider.unavailableReason).toContain('0.9.12');
  });

  it('honours VOWE_GRAPHIFY_DISABLE without probing at all', async () => {
    let probed = false;
    const provider = await GraphifyProjectKnowledgeProvider.fromEnvironment({
      ...deps,
      env: { VOWE_GRAPHIFY_DISABLE: '1' },
      cliOptions: {
        runImpl: async () => {
          probed = true;
          return { stdout: '0.9.64', stderr: '' };
        },
      },
    });
    expect(provider.available).toBe(false);
    expect(probed).toBe(false);
  });
});

describe('acceptance 2: searching repository architecture', () => {
  async function ready(): Promise<{
    provider: GraphifyProjectKnowledgeProvider;
    repoRoot: string;
  }> {
    const root = await tempRoot();
    const repoRoot = path.join(root, 'repo');
    const dataDir = path.join(root, 'data');
    const paths = graphifyPaths(path.join(dataDir, 'knowledge'));
    await mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await mkdir(paths.outDir, { recursive: true });

    // The same source the committed fixture was extracted from, so a location
    // in the graph really does point at the line it claims.
    const { readFile: read } = await import('node:fs/promises');
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
    await writeFile(paths.graphFile, await read(FIXTURE, 'utf8'), 'utf8');

    const provider = new GraphifyProjectKnowledgeProvider({
      cli: new GraphifyCli({ runImpl: async () => ({ stdout: '', stderr: '' }) }),
      resolveProject: () => project(repoRoot),
      dataDirFor: () => dataDir,
      headCommit: async () => 'commit-1',
    });
    return { provider, repoRoot };
  }

  it('returns graph hits with absolute source paths', async () => {
    const { provider, repoRoot } = await ready();
    const hits = await provider.search({
      projectId: 'git:abc123',
      query: 'How does SessionRegistry connect to ProjectService?',
      limit: 8,
    });

    const registry = hits.find((hit) => hit.label === 'SessionRegistry');
    expect(registry).toBeDefined();
    expect(registry!.origin).toBe('structure');
    expect(registry!.kind).toBe('class');
    // Absolute, because a ref comes back to a process whose cwd is not the repo.
    expect(registry!.locations[0]!.path).toBe(
      path.join(repoRoot, 'src', 'registry.ts'),
    );
    expect(registry!.locations[0]!.line).toBe(1);
  });

  it('opens a node onto the line the graph recorded', async () => {
    const { provider } = await ready();
    const node = await provider.open({
      projectId: 'git:abc123',
      nodeId: 'src_registry_assignproject',
    });
    expect(node!.label).toBe('assignProject()');
    expect(node!.locations[0]!.line).toBe(4);
    expect(node!.related.map((edge) => edge.relation)).toContain(
      '.absorb() calls assignProject()',
    );
  });

  it('returns nothing, rather than failing, before anything is indexed', async () => {
    const root = await tempRoot();
    const provider = new GraphifyProjectKnowledgeProvider({
      cli: new GraphifyCli({ runImpl: async () => ({ stdout: '', stderr: '' }) }),
      resolveProject: () => project(path.join(root, 'repo')),
      dataDirFor: () => path.join(root, 'data'),
      headCommit: async () => null,
    });
    expect(await provider.search({ projectId: 'git:abc123', query: 'anything' })).toEqual([]);
  });
});
