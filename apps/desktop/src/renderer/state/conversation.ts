import type {
  ConversationDelivery,
  ConversationEntry,
  ConversationRole,
  WorkerMilestone,
} from '@vowe/core';

/**
 * The conversation as it is read, rather than as it is stored.
 *
 * Three things have to share one column and stay legible: what the developer
 * and Vowe said, the few worker events worth a line, and the truth about
 * replies that were cut off. This assembles them; the components only draw.
 */
export type Speaker = 'user' | 'vowe';

export interface SpeakerTurn {
  kind: 'turn';
  id: string;
  speaker: Speaker;
  at: string;
  /**
   * Consecutive entries from one speaker, kept together.
   *
   * The identity treatment is shown once per run rather than per message,
   * which is what stops an editorial conversation turning into chat bubbles.
   */
  entries: ConversationEntry[];
}

export interface MilestoneItem {
  kind: 'milestone';
  id: string;
  at: string;
  milestone: WorkerMilestone;
}

export type TimelineItem = SpeakerTurn | MilestoneItem;

const VOWE_ROLES = new Set<ConversationRole>([
  'companion_answer',
  'companion_message',
  'instruction_result',
]);

export function speakerOf(role: ConversationRole): Speaker {
  return VOWE_ROLES.has(role) ? 'vowe' : 'user';
}

/**
 * An answer asserts an investigation happened; an ordinary turn does not.
 *
 * The receipt is what separates them, and a turn that never investigated must
 * not be dressed as one that did.
 */
export function isGroundedAnswer(entry: ConversationEntry): boolean {
  return entry.role === 'companion_answer' && (entry.investigation?.checks.length ?? 0) > 0;
}

export interface TimelineInput {
  entries: readonly ConversationEntry[];
  milestones?: readonly WorkerMilestone[];
}

export function buildTimeline(input: TimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const entry of [...input.entries].sort(byTime)) {
    const speaker = speakerOf(entry.role);
    const last = items[items.length - 1];
    // Only a run of the same speaker merges, and a milestone between two of
    // Vowe's turns genuinely breaks the run — something happened in between.
    if (last?.kind === 'turn' && last.speaker === speaker) {
      last.entries.push(entry);
      continue;
    }
    items.push({ kind: 'turn', id: entry.id, speaker, at: entry.at, entries: [entry] });
  }

  for (const milestone of input.milestones ?? []) {
    items.push({ kind: 'milestone', id: milestone.id, at: milestone.at, milestone });
  }

  return items.sort(byTime);
}

function byTime(a: { at: string }, b: { at: string }): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

/**
 * How much of a reply was actually heard.
 *
 * `ConversationEntry.text` is the complete turn, which for voice may be more
 * than the developer ever heard. This is the projection that keeps the UI
 * honest about the difference, and it has four genuinely different answers:
 *
 *  - nothing was cut off, so all of it stands;
 *  - it was cut off and the delivered prefix is known, so there is a boundary;
 *  - it was cut off and what was delivered is *not* a prefix — the spoken form
 *    of a grounded answer is a different, shorter text — so the two are shown
 *    as what was said and what was written, not as a truncation;
 *  - it was cut off and nothing measured where, so the cut is reported without
 *    a boundary rather than guessed at.
 */
export interface DeliveredPortion {
  /** Cut off partway through being communicated. */
  interrupted: boolean;
  /** The part the developer actually received, when that is knowable. */
  heard: string | null;
  /** What was generated but never reached them. */
  unheard: string | null;
  /** Interrupted, but where is unknowable. Never fabricate a cutoff. */
  boundaryUnknown: boolean;
  /**
   * What was said out loud is a different rendering of the same answer, not a
   * prefix of it — so it is labelled as spoken rather than as "heard so far".
   */
  spokenFormDiffers: boolean;
}

export function deliveredPortion(
  entry: ConversationEntry,
  delivery: ConversationDelivery | null,
): DeliveredPortion {
  const whole: DeliveredPortion = {
    interrupted: false,
    heard: entry.text,
    unheard: null,
    boundaryUnknown: false,
    spokenFormDiffers: false,
  };

  if (!delivery) return whole;
  if (delivery.status === 'completed' || delivery.status === 'started') return whole;

  const delivered = delivery.deliveredText;
  if (delivered === undefined) {
    // The provider declares no interruption event, and nothing measured where
    // the audio stopped. Saying it was cut off is true; saying where is not.
    return {
      interrupted: true,
      heard: null,
      unheard: null,
      boundaryUnknown: true,
      spokenFormDiffers: false,
    };
  }

  if (entry.text.startsWith(delivered)) {
    const rest = entry.text.slice(delivered.length).trim();
    return {
      interrupted: true,
      heard: delivered,
      unheard: rest.length ? rest : null,
      boundaryUnknown: false,
      spokenFormDiffers: false,
    };
  }

  return {
    interrupted: true,
    heard: delivered,
    unheard: entry.text,
    boundaryUnknown: false,
    spokenFormDiffers: true,
  };
}

/** The newest delivery of one entry, which is the one that decided its fate. */
export function deliveryFor(
  entryId: string,
  deliveries: readonly ConversationDelivery[],
): ConversationDelivery | null {
  let latest: ConversationDelivery | null = null;
  for (const delivery of deliveries) {
    if (delivery.entryId !== entryId) continue;
    if (!latest || delivery.startedAt >= latest.startedAt) latest = delivery;
  }
  return latest;
}
