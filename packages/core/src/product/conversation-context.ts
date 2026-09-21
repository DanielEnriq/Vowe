import type { EventStore } from '../store/event-store.js';
import type {
  ConversationEntry,
  ConversationDelivery,
} from '../types/conversation.js';

/**
 * One past turn, with what became of it.
 *
 * The entry says what Vowe meant; the delivery says what the person got. A
 * model given only the first will reason as though a whole answer was heard,
 * and will say "as I explained" about something that was cut off after a
 * sentence. Keeping both is the difference between remembering a conversation
 * and remembering a transcript of one side of it.
 */
export interface ConversationTurn {
  speaker: 'user' | 'vo';
  /** The complete semantic content, never the audible part. */
  text: string;
  /** How the last attempt to convey it went. Absent when it was only stored. */
  delivery?: {
    status: ConversationDelivery['status'];
    audioEndMs?: number;
    deliveredText?: string;
  };
}

const VOWE_ROLES = new Set<ConversationEntry['role']>([
  'companion_answer',
  'companion_message',
  'instruction_result',
]);

/**
 * What was said, from the durable record rather than from a live session.
 *
 * Instructions to the worker and their results are left out: this is the
 * conversation between the developer and Vowe, and an instruction crossed a
 * different boundary. Everything else on the near side of it counts — a spoken
 * remark, a typed question, a grounded answer, `On it.` — because a
 * conversation is not only its important parts.
 *
 * Reading only. Nothing here writes, which is what makes it safe to use for
 * seeding a new voice session: hydrating context must never re-persist history
 * it is merely reading.
 */
export function recentConversation(
  store: EventStore,
  sessionId: string,
  limit = 20,
): ConversationTurn[] {
  const entries = store.getConversation(sessionId, limit);
  return entries
    .filter(
      (entry) =>
        entry.role !== 'user_instruction' && entry.role !== 'instruction_result',
    )
    .map((entry) => {
      const turn: ConversationTurn = {
        speaker: VOWE_ROLES.has(entry.role) ? 'vo' : 'user',
        text: entry.text,
      };
      // The last attempt is the one that describes the state the conversation
      // is actually in — an answer re-read as text after being cut off out loud
      // was, in the end, delivered.
      const deliveries = store.getDeliveries(entry.id);
      const last = deliveries[deliveries.length - 1];
      if (last) {
        turn.delivery = {
          status: last.status,
          ...(last.audioEndMs === undefined ? {} : { audioEndMs: last.audioEndMs }),
          ...(last.deliveredText === undefined
            ? {}
            : { deliveredText: last.deliveredText }),
        };
      }
      return turn;
    });
}

/**
 * The same history, in the shape a model call takes.
 *
 * An interrupted turn carries its full text *and* a plain statement that the
 * person did not hear all of it. Both facts, together, in the model's own
 * input — because either one alone produces a wrong next turn: the full text
 * alone invites "as I said", and the audible fragment alone throws away what
 * Vowe had actually worked out.
 *
 * This is internal model context. It is not UI copy and is not shown anywhere.
 */
export function asModelContext(
  turns: ConversationTurn[],
): { speaker: 'user' | 'vo'; text: string }[] {
  return turns.map((turn) => ({
    speaker: turn.speaker,
    text: turn.text + deliveryNote(turn),
  }));
}

function deliveryNote(turn: ConversationTurn): string {
  const delivery = turn.delivery;
  if (!delivery) return '';
  switch (delivery.status) {
    case 'interrupted':
      return `\n[Interrupted${heard(delivery.audioEndMs)}. The user did not hear all of this.${
        delivery.deliveredText ? ` They heard: "${delivery.deliveredText}"` : ''
      }]`;
    case 'cancelled':
      return '\n[Never delivered — the attempt to say this was cancelled.]';
    case 'started':
      // Still reading `started` long after the fact means Vowe stopped while
      // saying it. Honest, and different from either of the two above.
      return '\n[Delivery never finished; it is not known how much the user heard.]';
    case 'completed':
      return '';
  }
}

function heard(audioEndMs: number | undefined): string {
  if (audioEndMs === undefined) return '';
  return ` after about ${(audioEndMs / 1000).toFixed(1)}s`;
}
