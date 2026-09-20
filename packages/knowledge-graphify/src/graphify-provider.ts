import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  Project,
  ProjectMemoryMirror,
  ProjectKnowledgeHit,
  ProjectKnowledgeProvider,
  ProjectKnowledgeResult,
  ProjectKnowledgeSearch,
  RepoIndexState,
  SourceLocation,
} from '@vowe/core';
import { UnavailableProjectKnowledge } from '@vowe/core';

import {
  graphifyPaths,
  GraphifyCli,
  type GraphifyCliOptions,
  type GraphifyPaths,
} from './graphify-cli.js';
import { GraphifyGraphReader, type GraphNode } from './graph-reader.js';
import { GraphifyMemoryMirror } from './graphify-memory-mirror.js';
import { LexicalRetrieval, type Retrieval } from './lexical-retrieval.js';

const execFileAsync = promisify(execFile);

export interface GraphifyDeps
  extends Omit<GraphifyProviderOptions, 'cli'> {
  env?: NodeJS.ProcessEnv;
  cliOptions?: GraphifyCliOptions;
}

export interface GraphifyProviderOptions {
  cli: GraphifyCli;
  /** The project's identity, for its repository root. */
  resolveProject: (projectId: string) => Project | null;
  /** `<storeRoot>/projects/<safeId>` — handed over by the store. */
  dataDirFor: (projectId: string) => string;
  retrieval?: Retrieval;
  reader?: GraphifyGraphReader;
  /** Injectable so staleness can be tested without moving a real HEAD. */
  headCommit?: (repoRoot: string) => Promise<string | null>;
  onError?: (scope: string, error: unknown) => void;
  /** Fires whenever a project's index state changes, for the UI. */
  onStateChange?: (state: RepoIndexState) => void;
}

/**
 * Structural repository knowledge, backed by Graphify.
 *
 * **Structure only.** This provider has no idea what Vowe has learned; memory
 * lives in core, in Vowe's own store, and survives this class being deleted.
 *
 * Two properties matter more than anything else here:
 *
 *  - **Nothing is written inside the user's repository.** Graphify's default is
 *    a `graphify-out/` directory next to the source; every invocation overrides
 *    that with Vowe's own path, twice over.
 *  - **A search never waits for a build.** Indexing a large repository takes
 *    minutes, and the caller is usually in the middle of answering a question
 *    out loud. Builds run in the background; searches return what exists now.
 */
export class GraphifyProjectKnowledgeProvider implements ProjectKnowledgeProvider {
  readonly name = 'graphify';
  readonly available = true;

  private readonly cli: GraphifyCli;
  private readonly resolveProject: (projectId: string) => Project | null;
  private readonly dataDirFor: (projectId: string) => string;
  private readonly retrieval: Retrieval;
  private readonly reader: GraphifyGraphReader;
  private readonly headCommit: (repoRoot: string) => Promise<string | null>;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly onStateChange: (state: RepoIndexState) => void;

  private readonly states = new Map<string, RepoIndexState>();
  private readonly hydrated = new Map<string, Promise<RepoIndexState>>();
  private readonly building = new Map<string, Promise<RepoIndexState>>();
  private stopped = false;

  constructor(options: GraphifyProviderOptions) {
    this.cli = options.cli;
    this.resolveProject = options.resolveProject;
    this.dataDirFor = options.dataDirFor;
    this.retrieval = options.retrieval ?? new LexicalRetrieval();
    this.reader = options.reader ?? new GraphifyGraphReader();
    this.headCommit = options.headCommit ?? readHeadCommit;
    this.onError = options.onError ?? (() => undefined);
    this.onStateChange = options.onStateChange ?? (() => undefined);
  }

  /**
   * Probe for the binary and report what was found.
   *
   * Always returns a usable provider: when Graphify is missing, disabled or too
   * old, that is the floor from core carrying the reason, so no caller ever has
   * to handle an absent provider.
   */
  static async fromEnvironment(
    deps: GraphifyDeps,
  ): Promise<ProjectKnowledgeProvider> {
    return (await createGraphifyKnowledge(deps)).provider;
  }

  // ------------------------------------------------------------- lifecycle

  status(projectId: string): RepoIndexState {
    return this.states.get(projectId) ?? { projectId, status: 'unindexed' };
  }

  /**
   * Read persisted state from disk. Deliberately does **not** start a build:
   * opening a Project's room should not commit the machine to indexing it.
   */
  async hydrate(projectId: string): Promise<RepoIndexState> {
    let pending = this.hydrated.get(projectId);
    if (!pending) {
      pending = this.loadState(projectId);
      this.hydrated.set(projectId, pending);
    }
    await pending;
    // The load happens once; the answer is whatever is true now. Returning the
    // memoized promise's own value would hand back the state as it was before
    // the first build ever ran.
    return this.status(projectId);
  }

  async ensureIndexed(projectId: string): Promise<RepoIndexState> {
    const state = await this.hydrate(projectId);
    if (this.stopped) return state;

    if (state.status === 'indexing' || this.building.has(projectId)) return state;

    if (state.status === 'ready' && (await this.headMoved(projectId, state))) {
      return this.startBuild(projectId, 'update');
    }
    if (state.status === 'ready') return state;
    if (state.status === 'stale') return this.startBuild(projectId, 'update');
    // `unindexed` and `error` both mean: there is nothing dependable on disk.
    return this.startBuild(projectId, 'extract');
  }

  async refresh(projectId: string): Promise<RepoIndexState> {
    const state = await this.hydrate(projectId);
    if (this.stopped || this.building.has(projectId)) return state;
    const mode = state.indexedAt ? 'update' : 'extract';
    return this.startBuild(projectId, mode);
  }

  markStale(projectId: string): void {
    const state = this.states.get(projectId);
    // Only a finished index can go stale. Marking an unbuilt one stale would
    // claim there is something to refresh.
    if (!state || state.status !== 'ready') return;
    void this.setState({ ...state, status: 'stale' });
  }

  stop(): void {
    this.stopped = true;
  }

  private startBuild(
    projectId: string,
    mode: 'extract' | 'update',
  ): RepoIndexState {
    const project = this.resolveProject(projectId);
    if (!project) {
      const failed: RepoIndexState = {
        projectId,
        status: 'error',
        lastError: 'No repository is known for this project.',
      };
      void this.setState(failed);
      return failed;
    }

    const previous = this.status(projectId);
    const indexing: RepoIndexState = { ...previous, projectId, status: 'indexing' };
    delete indexing.lastError;
    void this.setState(indexing);

    const run = this.build(project, mode).finally(() => {
      this.building.delete(projectId);
    });
    this.building.set(projectId, run);
    // The caller gets `indexing` now. Waiting is the one thing it cannot do.
    void run.catch((error) => this.onError('knowledge:build', error));
    return indexing;
  }

  private async build(
    project: Project,
    mode: 'extract' | 'update',
  ): Promise<RepoIndexState> {
    const paths = this.pathsFor(project.id);
    await mkdir(paths.outDir, { recursive: true });

    const result =
      mode === 'extract'
        ? await this.cli.extract(paths, project.repoRoot)
        : await this.cli.update(paths, project.repoRoot);

    if (!result.ok) {
      return this.setState({
        projectId: project.id,
        status: 'error',
        lastError: result.failure ?? 'Indexing failed.',
      });
    }

    this.reader.forget(paths.graphFile);
    const next: RepoIndexState = {
      projectId: project.id,
      status: 'ready',
      indexedAt: new Date().toISOString(),
    };
    const commit = await this.headCommit(project.repoRoot);
    if (commit) next.indexedCommit = commit;
    return this.setState(next);
  }

  /** Catches `git pull` and branch switches that no observed session performed. */
  private async headMoved(
    projectId: string,
    state: RepoIndexState,
  ): Promise<boolean> {
    if (!state.indexedCommit) return false;
    const project = this.resolveProject(projectId);
    if (!project) return false;
    const head = await this.headCommit(project.repoRoot);
    return Boolean(head) && head !== state.indexedCommit;
  }

  // ---------------------------------------------------------------- search

  async search(input: ProjectKnowledgeSearch): Promise<ProjectKnowledgeHit[]> {
    const project = this.resolveProject(input.projectId);
    if (!project) return [];

    const graph = await this.reader.read(this.graphPath(input.projectId));
    if (!graph) return [];

    const limit = Math.max(1, input.limit ?? 6);
    return this.retrieval
      .retrieve(graph, input.query, limit)
      .map(({ node, via }) => {
        const hit: ProjectKnowledgeHit = {
          id: node.id,
          label: node.label,
          summary: summaryOf(node, via),
          locations: this.locationsOf(project, node),
          origin: 'structure',
        };
        if (node.kind) hit.kind = node.kind;
        return hit;
      });
  }

  async open(ref: {
    projectId: string;
    nodeId: string;
  }): Promise<ProjectKnowledgeResult | null> {
    const project = this.resolveProject(ref.projectId);
    if (!project) return null;

    const graph = await this.reader.read(this.graphPath(ref.projectId));
    const node = graph?.nodes.get(ref.nodeId);
    if (!graph || !node) return null;

    const related = (graph.neighbours.get(node.id) ?? [])
      .map((edge) => {
        const other = graph.nodes.get(edge.nodeId);
        if (!other) return null;
        return {
          nodeId: other.id,
          label: other.label,
          relation:
            edge.direction === 'out'
              ? `${node.label} ${edge.relation} ${other.label}`
              : `${other.label} ${edge.relation} ${node.label}`,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const locations = await this.resolveLines(
      this.locationsOf(project, node),
      node.label,
    );

    const result: ProjectKnowledgeResult = {
      label: node.label,
      summary: node.summary,
      locations,
      related,
    };
    if (node.kind) result.kind = node.kind;
    return result;
  }

  /**
   * Source paths come out of the graph relative to the repository. Refs travel
   * through model context and come back to a process whose working directory is
   * not the repository, so they are made absolute here — at the only point that
   * still knows which repository they belong to.
   */
  private locationsOf(project: Project, node: GraphNode): SourceLocation[] {
    if (!node.sourceFile) return [];
    const absolute = path.isAbsolute(node.sourceFile)
      ? node.sourceFile
      : path.resolve(project.repoRoot, node.sourceFile);
    return [
      node.line === undefined
        ? { path: absolute }
        : { path: absolute, line: node.line },
    ];
  }

  /**
   * Graphify does not promise line numbers, so find one by looking.
   *
   * A whole-word match on the node's own label is crude but checkable, and it
   * degrades to "the file, no line" rather than to a wrong line. Pointing
   * somebody at the wrong place is worse than pointing at the whole file.
   */
  private async resolveLines(
    locations: SourceLocation[],
    label: string,
  ): Promise<SourceLocation[]> {
    const pattern = wordPattern(label);
    if (!pattern) return locations;

    return Promise.all(
      locations.map(async (location) => {
        if (location.line !== undefined) return location;
        try {
          const lines = (await readFile(location.path, 'utf8')).split('\n');
          const index = lines.findIndex((line) => pattern.test(line));
          return index === -1 ? location : { ...location, line: index + 1 };
        } catch {
          return location;
        }
      }),
    );
  }

  // --------------------------------------------------------------- private

  private knowledgeDir(projectId: string): string {
    return path.join(this.dataDirFor(projectId), 'knowledge');
  }

  /**
   * Graphify's own directory, under Vowe's.
   *
   * `knowledge/` is the parent Graphify is pointed at; it creates
   * `graphify-out/` inside. Keeping its own name means a directory that turns
   * up in a file listing says plainly which tool owns it — and leaves room
   * beside it for what Vowe owns.
   */
  private pathsFor(projectId: string): GraphifyPaths {
    return graphifyPaths(this.knowledgeDir(projectId));
  }

  private graphPath(projectId: string): string {
    return this.pathsFor(projectId).graphFile;
  }

  private statePath(projectId: string): string {
    return path.join(this.knowledgeDir(projectId), 'index.json');
  }

  private async loadState(projectId: string): Promise<RepoIndexState> {
    let state: RepoIndexState = { projectId, status: 'unindexed' };
    try {
      const raw = JSON.parse(
        await readFile(this.statePath(projectId), 'utf8'),
      ) as RepoIndexState;
      if (raw && typeof raw.status === 'string') {
        state = { ...raw, projectId };
        // A build interrupted by a quit left `indexing` on disk. Nothing is
        // running now, so that is a lie; demote it to what it really is.
        if (state.status === 'indexing') {
          state.status = state.indexedAt ? 'stale' : 'unindexed';
        }
      }
    } catch {
      // Never indexed, or unreadable. Both mean: start from nothing.
    }
    this.states.set(projectId, state);
    return state;
  }

  private async setState(state: RepoIndexState): Promise<RepoIndexState> {
    this.states.set(state.projectId, state);
    this.onStateChange(state);
    try {
      const file = this.statePath(state.projectId);
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await rename(tmp, file);
    } catch (error) {
      // Losing the state file costs a rebuild, not correctness.
      this.onError('knowledge:state', error);
    }
    return state;
  }
}

function summaryOf(
  node: GraphNode,
  via?: { label: string; relation: string },
): string {
  const parts: string[] = [];
  if (via) parts.push(`(via ${via.relation})`);
  if (node.summary) parts.push(node.summary);
  else if (node.kind) parts.push(`${node.kind} ${node.label}`);
  if (node.sourceFile) parts.push(`— ${node.sourceFile}`);
  return parts.join(' ').trim() || node.label;
}

/**
 * `null` when the label has nothing a regular expression can anchor on.
 *
 * Graphify labels a function `assignProject()` and a method `.absorb()`, so the
 * decoration comes off before the name is looked for in the file.
 */
function wordPattern(label: string): RegExp | null {
  const bare = label.trim().replace(/\(\)$/, '').replace(/^\./, '');
  if (!bare || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) return null;
  return new RegExp(`\\b${bare}\\b`);
}

async function readHeadCommit(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      timeout: 5_000,
      windowsHide: true,
    });
    return String(stdout).trim() || null;
  } catch {
    // Not a repository, git missing, or an empty repository with no commits.
    return null;
  }
}

/**
 * Everything Graphify contributes to a Project, from one probe.
 *
 * The provider and the mirror share a `GraphifyCli`, so the binary is looked for
 * exactly once, and the mirror is honest about being unavailable whenever the
 * provider is.
 */
export async function createGraphifyKnowledge(deps: GraphifyDeps): Promise<{
  provider: ProjectKnowledgeProvider;
  mirror: ProjectMemoryMirror;
}> {
  const env = deps.env ?? process.env;
  const { env: _env, cliOptions, ...providerDeps } = deps;

  const unavailable = (reason: string, cli: GraphifyCli) => ({
    provider: new UnavailableProjectKnowledge(reason),
    mirror: new GraphifyMemoryMirror({
      cli,
      available: false,
      resolveProject: providerDeps.resolveProject,
      dataDirFor: providerDeps.dataDirFor,
      ...(providerDeps.onError ? { onError: providerDeps.onError } : {}),
    }),
  });

  const options: GraphifyCliOptions = { ...cliOptions };
  if (deps.onError) options.onError ??= deps.onError;
  options.bin ??= env['VOWE_GRAPHIFY_BIN'] || undefined;
  options.minVersion ??= env['VOWE_GRAPHIFY_MIN_VERSION'] || undefined;
  options.backend ??= env['VOWE_GRAPHIFY_BACKEND'] || undefined;

  if (env['VOWE_GRAPHIFY_DISABLE']) {
    return unavailable(
      'Repository knowledge is switched off by VOWE_GRAPHIFY_DISABLE.',
      new GraphifyCli(options),
    );
  }

  let cli = new GraphifyCli(options);
  let probe = await cli.probe();

  // A desktop app launched from Finder inherits a minimal PATH, which will not
  // include the directory `uv tool install` puts binaries in. Looking there
  // before giving up is the difference between this working and the user being
  // told to configure something they have already installed.
  if (!probe.available && !options.bin) {
    const retry = new GraphifyCli({
      ...options,
      bin: path.join(homedir(), '.local', 'bin', 'graphify'),
    });
    const retried = await retry.probe();
    if (retried.available) {
      cli = retry;
      probe = retried;
    }
  }

  if (!probe.available) {
    return unavailable(probe.reason ?? 'Graphify is not available.', cli);
  }

  return {
    provider: new GraphifyProjectKnowledgeProvider({ ...providerDeps, cli }),
    mirror: new GraphifyMemoryMirror({
      cli,
      available: true,
      resolveProject: providerDeps.resolveProject,
      dataDirFor: providerDeps.dataDirFor,
      ...(providerDeps.onError ? { onError: providerDeps.onError } : {}),
    }),
  };
}
