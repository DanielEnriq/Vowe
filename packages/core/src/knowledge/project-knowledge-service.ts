import { formatRef, type ContextRef } from '../context/refs.js';
import type { MemoryAdmissionPolicy } from './memory-admission.js';
import type {
  ProjectKnowledgeHit,
  ProjectKnowledgeProvider,
  ProjectKnowledgeResult,
  ProjectMemoryRecord,
  RepoIndexState,
} from './project-knowledge.js';
import type { ProjectMemoryStore } from './project-memory-store.js';

export interface ProjectKnowledgeServiceOptions {
  provider: ProjectKnowledgeProvider;
  /** Vowe's own memory. Absent, nothing is remembered and nothing breaks. */
  memory?: ProjectMemoryStore;
  /** Decides what is worth keeping. Absent, nothing is admitted. */
  admission?: MemoryAdmissionPolicy;
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
  private readonly memory: ProjectMemoryStore | null;
  private readonly admission: MemoryAdmissionPolicy | null;
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
    this.memory = options.memory ?? null;
    this.admission = options.admission ?? null;
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.burstChanges = options.burstChanges ?? DEFAULT_BURST_CHANGES;
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * Whether repository search has anything beyond `git grep` behind it.
   *
   * True when *either* half is present. Vowe's own memory outlives the
   * structural provider, so a project with remembered lessons and no indexer
   * still has knowledge worth searching.
   */
  get available(): boolean {
    return this.provider.available || this.memory !== null;
  }

  /** Whether a code graph specifically is available. Drives the UI's wording. */
  get structureAvailable(): boolean {
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
    if (this.stopped) return [];
    const limit = Math.max(1, input.limit ?? 6);

    // What Vowe worked out before comes first. A lesson is the product of an
    // investigation that already happened; making the caller rediscover it
    // behind three graph nodes would waste the thing that was worth keeping.
    const remembered = await this.searchMemory({ ...input, limit });
    const room = limit - remembered.length;
    if (room <= 0 || !this.provider.available) return remembered.slice(0, limit);

    try {
      void this.provider.ensureIndexed(input.projectId).catch((error) => {
        this.onError('knowledge:ensureIndexed', error);
      });
      const structural = await this.provider.search({ ...input, limit: room });
      return [...remembered, ...structural];
    } catch (error) {
      this.onError('knowledge:search', error);
      return remembered;
    }
  }

  private async searchMemory(input: {
    projectId: string;
    query: string;
    limit: number;
  }): Promise<ProjectKnowledgeHit[]> {
    if (!this.memory) return [];
    try {
      // At most half the budget: what Vowe remembers must not crowd out what
      // the repository currently says.
      return await this.memory.search({
        projectId: input.projectId,
        query: input.query,
        limit: Math.max(1, Math.floor(input.limit / 2)),
      });
    } catch (error) {
      this.onError('knowledge:memory-search', error);
      return [];
    }
  }

  /** One remembered record, for a `lesson:` ref. */
  async openMemory(
    projectId: string,
    recordId: string,
  ): Promise<ProjectMemoryRecord | null> {
    if (!this.memory) return null;
    try {
      return await this.memory.get(projectId, recordId);
    } catch (error) {
      this.onError('knowledge:memory-open', error);
      return null;
    }
  }

  /**
   * Everything Vowe has worked out about this project, newest first.
   *
   * For the memory surface the design calls "What Vowe knows". A read, not a
   * search: the developer is looking at what is there rather than asking a
   * question, so nothing is scored and nothing is admitted.
   *
   * Superseded records are already absent — the store stops returning a record
   * once a correction replaces it, while keeping it in the file.
   */
  async listMemories(projectId: string, limit?: number): Promise<ProjectMemoryRecord[]> {
    if (!this.memory) return [];
    try {
      const records = await this.memory.list(projectId);
      const newestFirst = [...records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return typeof limit === 'number' ? newestFirst.slice(0, limit) : newestFirst;
    } catch (error) {
      this.onError('knowledge:memory-list', error);
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

  // ---------------------------------------------------------------- writing

  /**
   * Consider keeping a grounded answer.
   *
   * Called after an investigation has finished and been delivered, never
   * during one. Returns the record when something was kept, `null` when it was
   * not — which is the common case, and is meant to be.
   */
  async consider(input: {
    projectId: string;
    question: string;
    answer: string;
    refs: (ContextRef | string)[];
  }): Promise<ProjectMemoryRecord | null> {
    if (!this.memory || !this.admission || this.stopped) return null;
    try {
      const admit = await this.admission.shouldRemember({
        question: input.question,
        answer: input.answer,
        refs: input.refs,
      });
      if (!admit) return null;
      return await this.memory.remember({
        projectId: input.projectId,
        question: input.question,
        answer: input.answer,
        refs: input.refs.map((ref) => (typeof ref === 'string' ? ref : formatRef(ref))),
      });
    } catch (error) {
      this.onError('knowledge:consider', error);
      return null;
    }
  }

  /**
   * Record that something Vowe believed was wrong.
   *
   * Never inferred — somebody has to say so. Corrections skip admission
   * entirely: there is no version of "is being told you were wrong worth
   * remembering?" worth asking a model.
   */
  async recordCorrection(input: {
    projectId: string;
    correction: string;
    supersedes?: string;
    question?: string;
  }): Promise<ProjectMemoryRecord | null> {
    if (!this.memory) return null;
    try {
      return await this.memory.correct(input);
    } catch (error) {
      this.onError('knowledge:correction', error);
      return null;
    }
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
