import type {
  ProjectKnowledgeHit,
  ProjectKnowledgeProvider,
  ProjectKnowledgeResult,
  RepoIndexState,
} from './project-knowledge.js';

export interface ProjectKnowledgeServiceOptions {
  provider: ProjectKnowledgeProvider;
  /** How long a project must go quiet before its index is refreshed. */
  quietMs?: number;
  /** Refresh immediately once this many changes have piled up. */
  burstChanges?: number;
  onError?: (scope: string, error: unknown) => void;
}

const DEFAULT_QUIET_MS = 30_000;
const DEFAULT_BURST_CHANGES = 40;

/**
 * What a Project knows about its own repository.
 *
 * The service is the only thing the rest of Vowe talks to. It owns when an
 * index gets built and refreshed; the provider owns how.
 *
 * The rule that shapes every method here: **a read never waits on a write.**
 * A search that arrives while a project is unindexed starts the build and then
 * returns whatever exists now, which is usually nothing. The caller is often
 * part-way through answering a question out loud, and a correct answer that
 * arrives four minutes late is a worse failure than an incomplete one that
 * arrives immediately. `git grep` covers the gap, and the next question
 * benefits from the build this one started.
 */
export class ProjectKnowledgeService {
  private readonly provider: ProjectKnowledgeProvider;
  private readonly quietMs: number;
  private readonly burstChanges: number;
  private readonly onError: (scope: string, error: unknown) => void;

  private readonly pending = new Map<
    string,
    { count: number; timer: NodeJS.Timeout }
  >();
  private readonly refreshing = new Set<string>();
  private stopped = false;

  constructor(options: ProjectKnowledgeServiceOptions) {
    this.provider = options.provider;
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.burstChanges = options.burstChanges ?? DEFAULT_BURST_CHANGES;
    this.onError = options.onError ?? (() => undefined);
  }

  get available(): boolean {
    return this.provider.available;
  }

  get unavailableReason(): string | undefined {
    return this.provider.unavailableReason;
  }

  // ----------------------------------------------------------------- reads

  /**
   * Repository knowledge for a question.
   *
   * Starting the build is a side effect of asking, which is the only trigger
   * there is: Vowe indexes a repository because somebody wanted to know
   * something about it, never because a window happened to open.
   */
  async search(input: {
    projectId: string;
    query: string;
    limit?: number;
  }): Promise<ProjectKnowledgeHit[]> {
    if (!this.provider.available || this.stopped) return [];
    try {
      void this.provider.ensureIndexed(input.projectId).catch((error) => {
        this.onError('knowledge:ensureIndexed', error);
      });
      return await this.provider.search(input);
    } catch (error) {
      this.onError('knowledge:search', error);
      return [];
    }
  }

  async open(
    projectId: string,
    nodeId: string,
  ): Promise<ProjectKnowledgeResult | null> {
    if (!this.provider.available) return null;
    try {
      return await this.provider.open({ projectId, nodeId });
    } catch (error) {
      this.onError('knowledge:open', error);
      return null;
    }
  }

  /** For the UI. Reads persisted state; never starts a build. */
  async describe(projectId: string): Promise<RepoIndexState> {
    if (!this.provider.available) return { projectId, status: 'unindexed' };
    try {
      return await this.provider.hydrate(projectId);
    } catch (error) {
      this.onError('knowledge:hydrate', error);
      return { projectId, status: 'unindexed' };
    }
  }

  status(projectId: string): RepoIndexState {
    return this.provider.status(projectId);
  }

  // ------------------------------------------------------------- staleness

  /**
   * A source file in this project changed.
   *
   * Driven by the `file_changed` events the adapters already normalize, which
   * is why Vowe needs no filesystem watcher: the workers it observes are the
   * ones doing the editing, and they announce it.
   *
   * Marking is immediate so the UI tells the truth straight away; refreshing
   * waits, because a worker mid-edit produces bursts and re-indexing each one
   * would cost far more than it is worth.
   */
  noteSourceChange(projectId: string): void {
    if (!this.provider.available || this.stopped) return;
    this.provider.markStale(projectId);
    this.schedule(projectId);
  }

  /** Refresh now, skipping the quiet period. */
  async refreshNow(projectId: string): Promise<RepoIndexState> {
    this.clearPending(projectId);
    return this.runRefresh(projectId);
  }

  private schedule(projectId: string): void {
    const existing = this.pending.get(projectId);
    if (existing) clearTimeout(existing.timer);

    const count = (existing?.count ?? 0) + 1;
    if (count >= this.burstChanges) {
      this.pending.delete(projectId);
      void this.runRefresh(projectId);
      return;
    }

    const timer = setTimeout(() => {
      this.pending.delete(projectId);
      void this.runRefresh(projectId);
    }, this.quietMs);
    timer.unref?.();
    this.pending.set(projectId, { count, timer });
  }

  private async runRefresh(projectId: string): Promise<RepoIndexState> {
    if (this.stopped) return this.provider.status(projectId);
    if (this.refreshing.has(projectId)) {
      // Something changed while a refresh was already running. Coalesce it
      // into one more pass afterwards rather than running two at once.
      this.schedule(projectId);
      return this.provider.status(projectId);
    }

    this.refreshing.add(projectId);
    try {
      return await this.provider.refresh(projectId);
    } catch (error) {
      this.onError('knowledge:refresh', error);
      return this.provider.status(projectId);
    } finally {
      this.refreshing.delete(projectId);
    }
  }

  private clearPending(projectId: string): void {
    const existing = this.pending.get(projectId);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.pending.delete(projectId);
  }

  stop(): void {
    this.stopped = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.provider.stop();
  }
}
