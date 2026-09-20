/**
 * What Vowe knows about a repository, as opposed to what it knows about the
 * work happening inside one.
 *
 * Two kinds of knowledge live behind this file, and keeping them apart is the
 * whole design:
 *
 *  - **Structure** — what the repository contains and how it connects. A code
 *    graph, extracted from the source itself. Whoever extracts it owns it.
 *  - **Memory** — what Vowe has learned while working in the repository.
 *    **Vowe owns this**, in its own store, and it survives the structural
 *    provider being disabled, removed or replaced.
 *
 * Nothing here names a vendor. The structural provider is replaceable without
 * any caller changing, which is the same bargain `DecisionRouter` and
 * `LiveTransport` already make.
 */

/**
 * Where a project's index has got to.
 *
 * `stale` is deliberately not an error state: a slightly-behind graph is still
 * useful for orientation, and current source and diff are authoritative anyway.
 * So a stale index keeps serving while it refreshes.
 */
export type RepoIndexStatus =
  | 'unindexed'
  | 'indexing'
  | 'ready'
  | 'stale'
  | 'error';

export interface RepoIndexState {
  projectId: string;
  status: RepoIndexStatus;
  /** The commit the graph was built from, for detecting a moved HEAD. */
  indexedCommit?: string;
  indexedAt?: string;
  lastError?: string;
}

/** A place in the working tree. `line` is absent when nothing knows it. */
export interface SourceLocation {
  path: string;
  line?: number;
}

/**
 * One piece of project knowledge, from either store.
 *
 * `origin` exists so a result can say where it came from, not so a caller can
 * decide which store to ask. The caller asks for repository knowledge and gets
 * repository knowledge.
 */
export interface ProjectKnowledgeHit {
  /** Opaque to Vowe. Only the provider that issued it interprets it. */
  nodeId: string;
  label: string;
  /** The provider's own vocabulary — 'function', 'class', … Display only. */
  kind?: string;
  summary: string;
  locations: SourceLocation[];
  origin: 'structure' | 'memory';
}

export interface ProjectKnowledgeResult {
  label: string;
  kind?: string;
  summary: string;
  locations: SourceLocation[];
  related: { nodeId: string; label: string; relation: string }[];
}

export interface ProjectKnowledgeSearch {
  projectId: string;
  query: string;
  limit?: number;
}

/**
 * Structural repository knowledge. **Structure only** — this interface knows
 * nothing about what Vowe has learned, and deliberately cannot be asked.
 *
 * Every method is safe to call when `available` is false; searches come back
 * empty and lifecycle calls report `unindexed`. Nothing throws, because the
 * caller is a read tool in the middle of answering a question out loud.
 */
export interface ProjectKnowledgeProvider {
  readonly name: string;
  readonly available: boolean;
  /** Why not, when `available` is false. */
  readonly unavailableReason?: string;

  status(projectId: string): RepoIndexState;
  /**
   * Load what is already known about this project's index, **without starting
   * a build**. Opening a Project's room should not commit the machine to
   * indexing it; only asking a repository question should.
   */
  hydrate(projectId: string): Promise<RepoIndexState>;
  /** Builds the index if there is none. Returns without waiting for a build. */
  ensureIndexed(projectId: string): Promise<RepoIndexState>;
  /** Incremental update. Never a full rebuild. */
  refresh(projectId: string): Promise<RepoIndexState>;
  markStale(projectId: string): void;

  search(input: ProjectKnowledgeSearch): Promise<ProjectKnowledgeHit[]>;
  open(ref: {
    projectId: string;
    nodeId: string;
  }): Promise<ProjectKnowledgeResult | null>;

  stop(): void;
}

/**
 * One thing Vowe learned, durably.
 *
 * This is Vowe's own record, in Vowe's own store. A structural provider may
 * mirror it for its own purposes, but the copy here is the canonical one.
 */
export interface ProjectMemoryRecord {
  id: string;
  projectId: string;
  at: string;
  question: string;
  answer: string;
  /** String forms of the refs the answer was built from. */
  refs: string[];
  /** Structural node ids among those refs, for a mirror that wants them. */
  nodeIds: string[];
  locations: SourceLocation[];
  outcome: 'useful' | 'dead_end' | 'corrected';
  /** Set when `outcome` is `corrected`. */
  correction?: string;
  /** The record this correction replaces. */
  supersedes?: string;
}

/**
 * Optional enrichment for a structural provider that keeps its own work
 * memory.
 *
 * **Vowe's memory does not depend on this.** A mirror that is missing, slow or
 * broken changes nothing about what Vowe remembers or can retrieve — which is
 * why every method is best-effort and none of them can fail a write.
 */
export interface ProjectMemoryMirror {
  readonly available: boolean;
  mirror(record: ProjectMemoryRecord): Promise<void>;
  reflect(projectId: string, options?: { ifStale?: boolean }): Promise<void>;
}

/**
 * The floor: no structural knowledge at all.
 *
 * Mirrors `HeuristicDecisionRouter`. Vowe runs on this happily — repository
 * search falls back to `git grep`, and the UI says intelligence is
 * unavailable. Nothing is conditional on the provider existing.
 */
export class UnavailableProjectKnowledge implements ProjectKnowledgeProvider {
  readonly name = 'unavailable';
  readonly available = false;
  readonly unavailableReason: string;

  constructor(reason = 'No repository knowledge provider is configured.') {
    this.unavailableReason = reason;
  }

  status(projectId: string): RepoIndexState {
    return { projectId, status: 'unindexed' };
  }

  async hydrate(projectId: string): Promise<RepoIndexState> {
    return this.status(projectId);
  }

  async ensureIndexed(projectId: string): Promise<RepoIndexState> {
    return this.status(projectId);
  }

  async refresh(projectId: string): Promise<RepoIndexState> {
    return this.status(projectId);
  }

  markStale(): void {
    // Nothing to mark.
  }

  async search(): Promise<ProjectKnowledgeHit[]> {
    return [];
  }

  async open(): Promise<ProjectKnowledgeResult | null> {
    return null;
  }

  stop(): void {
    // Nothing to stop.
  }
}
