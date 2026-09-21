import type { RepoIndexState, RepoIndexStatus } from '../knowledge/project-knowledge.js';
import { isActiveSession } from '../projects/project.js';
import type { EventStore } from '../store/event-store.js';
import type { AgentSession, SessionStatus } from '../types/session.js';
import { attentionFor, type AttentionItem } from './attention.js';
import { selectProjectSignal, type ProjectSignal } from './project-signal.js';
import { sessionActivity, sessionTitle } from './session-display.js';

/**
 * What is happening in one repository, in one read.
 *
 * A projection and nothing more. There is no Project entity beyond the
 * identity record `ProjectService` already keeps, no project-level agent, no
 * cross-session reasoning and no model call — the value is that the work is
 * gathered in one place, not that anything new was inferred about it.
 *
 * Nothing here is persisted. A brief is rebuilt from sessions, trace,
 * observation and index state every time it is asked for, which is why it
 * cannot drift out of agreement with them. The alternative — a stored project
 * history — would be a second source of truth about the same facts.
 */
export interface ProjectBrief {
  projectId: string;

  /** Deterministic synthesis. See `projectHeadline`. */
  headline: string;
  /** At most three current factual statements. Never speculation. */
  detailLines: string[];

  active: ProjectSessionSummary[];
  /**
   * Everything else, newest first, capped.
   *
   * Named `recent` rather than `recentlyFinished` because that is what it
   * honestly contains: a session that is idle or in an unknown state has not
   * finished, and the existing sidebar has always shown it here.
   */
  recent: ProjectSessionSummary[];

  needsAttention: AttentionItem[];

  latestSignal: ProjectSignal | null;

  knowledge: ProjectKnowledgeSummary;

  /**
   * The newest underlying state this brief reflects — **not** when it was
   * computed. A timestamp that moved every time the room re-read would tell
   * the developer the project had changed when nothing had.
   */
  updatedAt: string;
}

export interface ProjectSessionSummary {
  sessionId: string;
  title: string;

  status: SessionStatus;
  currentActivity: string | null;

  provider: string;
  branch: string | null;

  lastActivityAt: string;
  needsAttention: boolean;
}

/** `unavailable` means no structural provider at all, which is not an error. */
export type ProjectKnowledgeStatus = RepoIndexStatus | 'unavailable';

export interface ProjectKnowledgeSummary {
  status: ProjectKnowledgeStatus;
  updatedAt?: string;
}

/**
 * The half of `ProjectKnowledgeService` a brief needs.
 *
 * Structural, so the real service satisfies it without this module importing
 * it, and a test can supply four lines instead of an indexer.
 */
export interface ProjectBriefKnowledge {
  readonly structureAvailable: boolean;
  describe(projectId: string): Promise<RepoIndexState>;
}

export interface ProjectBriefServiceOptions {
  store: Pick<EventStore, 'getEvents' | 'getSurfaceUpdates' | 'getWindowNotes'>;
  /**
   * The project's sessions. A callback rather than a registry, matching
   * `ProjectService.listSessions` and `ContextNavigator.resolveCwd`: this
   * service holds no adapter and has no path to a worker.
   */
  sessionsFor: (projectId: string) => AgentSession[];
  /** Absent, knowledge reads `unavailable` and nothing else changes. */
  knowledge?: ProjectBriefKnowledge;
  /** How many non-active sessions the room carries. */
  recentLimit?: number;
  onError?: (scope: string, error: unknown) => void;
}

const DEFAULT_RECENT_LIMIT = 5;
const MAX_DETAIL_LINES = 3;

export class ProjectBriefService {
  private readonly store: ProjectBriefServiceOptions['store'];
  private readonly sessionsFor: (projectId: string) => AgentSession[];
  private readonly knowledge: ProjectBriefKnowledge | null;
  private readonly recentLimit: number;
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(options: ProjectBriefServiceOptions) {
    this.store = options.store;
    this.sessionsFor = options.sessionsFor;
    this.knowledge = options.knowledge ?? null;
    this.recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * A project whose id Vowe does not recognise is not an error: it simply has
   * no sessions, and the brief says so. Rooms are opened from a list the
   * renderer already holds, so the only way here is a race with removal.
   */
  async get(projectId: string): Promise<ProjectBrief> {
    const sessions = [...this.sessionsFor(projectId)].sort(byMostRecent);

    const needsAttention: AttentionItem[] = [];
    for (const session of sessions) {
      needsAttention.push(
        ...attentionFor(session, projectId, this.store.getEvents(session.id)),
      );
    }
    needsAttention.sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const waiting = new Set(needsAttention.map((item) => item.sessionId));

    const active = sessions
      .filter(isActiveSession)
      .map((session) => summarize(session, waiting));
    const recent = sessions
      .filter((session) => !isActiveSession(session))
      .slice(0, this.recentLimit)
      .map((session) => summarize(session, waiting));

    const latestSignal = selectProjectSignal(
      sessions.map((session) => session.id),
      this.store,
    );
    const knowledge = await this.describeKnowledge(projectId);

    return {
      projectId,
      headline: projectHeadline(sessions, active.length, needsAttention.length),
      detailLines: detailLinesFor(active, recent),
      active,
      recent,
      needsAttention,
      latestSignal,
      knowledge,
      updatedAt: newestOf([
        ...sessions.map((session) => session.lastActivityAt),
        ...needsAttention.map((item) => item.createdAt),
        latestSignal?.at,
        knowledge.updatedAt,
      ]),
    };
  }

  private async describeKnowledge(
    projectId: string,
  ): Promise<ProjectKnowledgeSummary> {
    if (!this.knowledge?.structureAvailable) return { status: 'unavailable' };
    try {
      // `describe` reads persisted state and never starts a build: opening a
      // room must not commit the machine to indexing the repository.
      const state = await this.knowledge.describe(projectId);
      return {
        status: state.status,
        ...(state.indexedAt ? { updatedAt: state.indexedAt } : {}),
      };
    } catch (error) {
      this.onError('brief:knowledge', error);
      return { status: 'unavailable' };
    }
  }
}

/**
 * The one-line synthesis.
 *
 * Deterministic, and deliberately so. This sentence is the first thing the
 * developer reads, and a model rewording it on every poll would make a calm
 * project look like a changing one. Attention outranks everything else,
 * because a thing that needs a person is the only fact here worth leading on.
 */
export function projectHeadline(
  sessions: AgentSession[],
  activeCount: number,
  attentionCount: number,
): string {
  if (attentionCount === 1) return 'One thing needs you.';
  if (attentionCount > 1) return `${attentionCount} things need you.`;
  if (sessions.length === 0) return "Everything's quiet.";
  if (activeCount > 0) return 'Everything is moving.';
  if (sessions.every((session) => session.status === 'finished')) {
    return 'Work is complete.';
  }
  return "Everything's quiet.";
}

/** Facts about the work in flight, in the order it was last touched. */
function detailLinesFor(
  active: ProjectSessionSummary[],
  recent: ProjectSessionSummary[],
): string[] {
  if (active.length) {
    return active
      .slice(0, MAX_DETAIL_LINES)
      .map(
        (summary) =>
          `${summary.title} — ${summary.currentActivity ?? statusPhrase(summary.status)}`,
      );
  }
  if (recent.length) {
    const count = recent.length;
    return [`${count} recent session${count === 1 ? '' : 's'}, none active.`];
  }
  return [];
}

function summarize(
  session: AgentSession,
  waiting: Set<string>,
): ProjectSessionSummary {
  return {
    sessionId: session.id,
    title: sessionTitle(session),
    status: session.status,
    currentActivity: sessionActivity(session),
    provider: session.provider,
    branch: session.branch ?? null,
    lastActivityAt: session.lastActivityAt,
    needsAttention: waiting.has(session.id),
  };
}

/**
 * How a status reads when nothing has interpreted the session yet.
 *
 * `waiting` is the one worth spelling out: it means the worker is between
 * turns, not that it is waiting on the developer. Conflating those two is
 * exactly the mistake `Needs You` exists to stop making.
 */
const STATUS_PHRASE: Record<SessionStatus, string> = {
  starting: 'starting up',
  working: 'working',
  waiting: 'waiting for its next turn',
  idle: 'idle',
  finished: 'finished',
  unknown: 'in an unknown state',
};

function statusPhrase(status: SessionStatus): string {
  return STATUS_PHRASE[status];
}

function byMostRecent(a: AgentSession, b: AgentSession): number {
  return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

/** Epoch when a project has nothing at all — a real answer, not a clock read. */
function newestOf(values: (string | null | undefined)[]): string {
  let newest = 0;
  for (const value of values) {
    if (!value) continue;
    const at = Date.parse(value);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return new Date(newest).toISOString();
}
