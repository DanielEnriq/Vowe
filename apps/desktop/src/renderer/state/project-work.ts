import type { PresenceState, ProjectBrief, ProjectSessionSummary } from '@vowe/core';

/**
 * How one piece of work reads in the Project Room.
 *
 * The room's only translation from session state into what a person sees, and
 * the one place the room will read richer observer state from. Everything here
 * is a field of `ProjectSessionSummary` or a fixed phrase for a real status —
 * no progress, no inferred blocker, nothing a session did not report.
 *
 * The seam, for when the observer publishes more than an activity line: the
 * new field is projected onto `ProjectSessionSummary` in `project-brief.ts`
 * (`summarize`), and read here. An understanding of the work becomes a second
 * line under `line`; an observer's own attention reading decides `presence`.
 * Nothing in `ProjectRoom.tsx` needs to learn a new field.
 */
export interface WorkItem {
  sessionId: string;
  title: string;
  /** What the worker is doing, or, before anything has read it, its status. */
  line: string;
  understanding: string | null;
  /** Whether the line is the interpreter's reading or only the status. */
  interpreted: boolean;
  /** The presence state its mark is drawn in. */
  presence: PresenceState;
  needsYou: boolean;
}

/**
 * Only the three live statuses reach Current Work, and each says only what the
 * status means. `waiting` is between turns — not waiting on the developer,
 * which is what `needsAttention` is for.
 */
const LIVE_PHRASE: Partial<Record<ProjectSessionSummary['status'], string>> = {
  working: 'Working',
  waiting: 'Waiting for its next turn',
  starting: 'Starting up',
};

export function workItemFor(summary: ProjectSessionSummary): WorkItem {
  const interpreted = summary.currentActivity !== null && summary.currentActivity !== '';
  return {
    sessionId: summary.sessionId,
    title: summary.title,
    understanding: summary.currentUnderstanding,
    line: summary.needsAttention
      ? 'Needs you'
      : interpreted
        ? (summary.currentActivity as string)
        : (LIVE_PHRASE[summary.status] ?? 'Working'),
    interpreted: interpreted && !summary.needsAttention,
    presence: presenceFor(summary),
    needsYou: summary.needsAttention,
  };
}

/**
 * The mark's state, from status alone.
 *
 * A working session is one Vowe is following, so its mark observes. Between
 * turns or starting up it is still — present, not moving. How much it moves
 * while observing comes from the worker's own events, measured by the caller,
 * not from here.
 */
function presenceFor(summary: ProjectSessionSummary): PresenceState {
  if (summary.needsAttention) return 'attention';
  if (summary.status === 'working') return 'observing';
  return 'idle';
}

/**
 * Settled work, said accurately: `recent` holds every non-active session, and
 * only a finished one has finished. Unknown liveness makes no claim.
 */
export function settledAs(summary: ProjectSessionSummary): 'finished' | 'idle' | 'recent' {
  if (summary.status === 'finished') return 'finished';
  return summary.status === 'waiting' || summary.status === 'idle' ? 'idle' : 'recent';
}

/** The room's identity line: how many workers are moving, and what is behind them. */
export function workersLine(brief: ProjectBrief): string {
  const active = brief.active.length;
  const parts = [
    active === 0 ? 'No workers active' : `${active} worker${active === 1 ? '' : 's'} active`,
  ];
  if (brief.recent.length > 0) parts.push(`${brief.recent.length} recent`);
  return parts.join(' · ');
}
