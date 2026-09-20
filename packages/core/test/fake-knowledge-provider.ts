import type {
  ProjectKnowledgeHit,
  ProjectKnowledgeProvider,
  ProjectKnowledgeResult,
  ProjectKnowledgeSearch,
  RepoIndexState,
} from '../src/knowledge/project-knowledge.js';

/**
 * A structural provider that records what it was asked instead of indexing
 * anything.
 *
 * Hand-written rather than mocked, like every other fake here: the point of
 * these tests is what the service decides to call and when, and a recording
 * object states that directly.
 */
export class FakeKnowledgeProvider implements ProjectKnowledgeProvider {
  readonly name = 'fake';
  available = true;
  unavailableReason: string | undefined;

  readonly calls: string[] = [];
  readonly searches: ProjectKnowledgeSearch[] = [];
  hits: ProjectKnowledgeHit[] = [];
  node: ProjectKnowledgeResult | null = null;
  /** Set to make a build hang, so "a read never waits on a write" is testable. */
  blockBuild: Promise<void> | null = null;

  private state: RepoIndexState = { projectId: 'git:test', status: 'unindexed' };

  status(projectId: string): RepoIndexState {
    return { ...this.state, projectId };
  }

  async hydrate(projectId: string): Promise<RepoIndexState> {
    this.calls.push('hydrate');
    return this.status(projectId);
  }

  async ensureIndexed(projectId: string): Promise<RepoIndexState> {
    this.calls.push('ensureIndexed');
    if (this.state.status === 'unindexed') {
      this.state = { ...this.state, status: 'indexing' };
      if (this.blockBuild) await this.blockBuild;
    }
    return this.status(projectId);
  }

  async refresh(projectId: string): Promise<RepoIndexState> {
    this.calls.push('refresh');
    this.state = { ...this.state, status: 'ready' };
    return this.status(projectId);
  }

  markStale(): void {
    this.calls.push('markStale');
    this.state = { ...this.state, status: 'stale' };
  }

  async search(input: ProjectKnowledgeSearch): Promise<ProjectKnowledgeHit[]> {
    this.searches.push(input);
    return this.hits;
  }

  async open(): Promise<ProjectKnowledgeResult | null> {
    this.calls.push('open');
    return this.node;
  }

  stop(): void {
    this.calls.push('stop');
  }

  setStatus(status: RepoIndexState['status']): void {
    this.state = { ...this.state, status };
  }

  countOf(call: string): number {
    return this.calls.filter((entry) => entry === call).length;
  }
}
