import type { ContextRef, ContextSource } from '../context/refs.js';
import type { ModelTrace } from './model-trace.js';
import type { DiffResult } from '../context/git-diff.js';
import type { OpenResult, SearchHit } from '../context/context-navigator.js';
import type { SurfaceUpdate, SurfaceUrgency, WindowNote } from '../observation/trace-window.js';

/**
 * The observation model, kept separate from `LlmClient`.
 *
 * `LlmClient` answers a question about stored state in one shot. Observation is
 * a different job: it runs continuously, it carries its own understanding
 * forward, and it may need to go and look something up mid-thought. Rather than
 * widen the existing interface until it covers both, this is its own contract,
 * and one implementation is free to satisfy both.
 */
export interface ObservationLlm {
  /**
   * Interpret one window in the context of what is already understood.
   *
   * `tools` is always supplied and always includes `surface_update`. The read
   * tools are present only when the runner decided this window justified
   * exploration — that gate is about cost, never about whether the observer is
   * allowed to raise something.
   */
  observeWindow(
    input: ObserveWindowInput,
    tools: ObserverToolset,
    trace?: ModelTrace,
  ): Promise<WindowObservation>;

  /** Investigate a user's question and return a grounded answer. */
  investigate(
    input: InvestigationInput,
    tools: ReadOnlyToolset,
    trace?: ModelTrace,
  ): Promise<DelegatedAnswer>;
}

/** The three read tools, shared unchanged by observation and delegation. */
export interface ReadOnlyToolset {
  searchContext(input: {
    query: string;
    sources?: ContextSource[];
    limit?: number;
  }): Promise<SearchHit[]>;
  openContext(input: {
    ref: string;
    depth?: 'summary' | 'full' | 'raw';
  }): Promise<OpenResult>;
  getDiff(input: { path?: string; around?: string }): Promise<DiffResult>;
}

/**
 * What the observer can do.
 *
 * `read` is absent when the runner chose the cheap path. `surfaceUpdate` never
 * is: any window may propose that something is worth the developer's attention.
 */
export interface ObserverToolset {
  read?: ReadOnlyToolset;
  surfaceUpdate(input: {
    message: string;
    whyNow: string;
    refs?: string[];
    urgency?: SurfaceUrgency;
  }): Promise<SurfaceUpdate>;
}

export interface ObserverWindowSlice {
  windowId: string;
  windowIndex: number;
  startSeq: number;
  endSeq: number;
  startedAt: string;
  endedAt: string;
  /** One line per event, oldest first. */
  events: ObserverEventLine[];
}

export interface ObserverEventLine {
  seq: number;
  at: string;
  kind: string;
  summary: string;
  /** Present for events whose detail carries the substance, e.g. output. */
  detail?: string;
}

export interface ObserveWindowInput {
  sessionId: string;
  /** The developer's own words about what the work is for. */
  task: string | null;
  cwd: string | null;
  /** The window being interpreted. */
  window: ObserverWindowSlice;
  /** The last few notes, oldest first. Not the whole history. */
  recentNotes: WindowNote[];
  /** Older notes the decision router judged relevant, if any. */
  relevantOlderNotes: WindowNote[];
  /** Recent worker and developer messages, oldest first. */
  recentMessages: ObserverEventLine[];
  /** What the developer said about being interrupted, if anything. */
  communicationPreference: string | null;
}

/** What the model may return. Identity, refs and bookkeeping stay ours. */
export interface WindowObservation {
  summary: string;
  currentActivity?: string;
  notableChange?: string;
  /** Refs the model chose to cite, in string form. */
  refs?: string[];
}

/**
 * One session's roster line, for a project-scoped investigation.
 *
 * Enough to orient the model about what is going on across a repository
 * without handing it any trace: it searches for the detail it needs, and every
 * line here names the session so it knows where to look.
 */
export interface ProjectSessionLine {
  sessionId: string;
  label: string;
  status: string;
  currentActivity: string | null;
  branch: string | null;
}

interface InvestigationBase {
  question: string;
  /**
   * How this developer asked Vowe to talk, composed from their temperament.
   *
   * Appended to the system prompt rather than the question, because it governs
   * every answer rather than this one. Absent means nobody set a preference and
   * the prompt stands as written — never a silently applied middle setting.
   */
  guidance?: string;
  /** What has been said out loud so far, oldest first. */
  liveConversation: { speaker: 'user' | 'vo'; text: string }[];
  /**
   * What the developer attached to the question, already opened.
   *
   * Opened before the model runs rather than described to it, so an attachment
   * is material the answer was actually built on rather than a suggestion the
   * model might have followed. Each one is also the first entry in the
   * receipt, which is what makes "I attached this" and "it looked at this" the
   * same claim.
   */
  attachments?: InvestigationAttachment[];
}

export interface InvestigationAttachment {
  /** The ref's string form, so the model can re-open it for more depth. */
  refId: string;
  /** A short description of what it is. */
  label: string;
  /** The opened material, already bounded by the navigator. */
  content: string;
}

/**
 * A question about one session, or about a whole project.
 *
 * The same investigator answers both — the product rule is that intelligence
 * does not fork — but what it is handed to start from genuinely differs. A
 * session question begins from that session's task and interpreted windows; a
 * project question begins from the repository and a roster of what is running
 * in it, and reaches any individual session through search rather than through
 * having been given all of them.
 */
export type InvestigationInput =
  | (InvestigationBase & {
      sessionId: string;
      task: string | null;
      cwd: string | null;
      /** Recent L1 understanding, oldest first. */
      recentNotes: WindowNote[];
    })
  | (InvestigationBase & {
      projectId: string;
      projectName: string;
      /** The repository root, which is where a project's diff is taken. */
      repoRoot: string | null;
      /** What is running in this project, newest first. */
      sessions: ProjectSessionLine[];
    });

/**
 * The two representations of an answer.
 *
 * Voice and text want different things. `spokenAnswer` is what a colleague
 * would actually say out loud — short enough to interrupt, and the only part
 * sent to the live model. `fullAnswer` is the grounded technical account, which
 * is persisted and rendered where it can be read at leisure.
 *
 * This is a deliberate rule rather than a workaround for a token limit: a long
 * answer is never chunked across appends to make it all get spoken. If the
 * developer wants more, they ask, and the next turn investigates again.
 */
export interface DelegatedAnswer {
  spokenAnswer: string;
  fullAnswer: string;
  refs: ContextRef[];
}
