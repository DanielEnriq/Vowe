import type { AgentSession } from '@vowe/core';

/**
 * Who the developer is talking to.
 *
 * A destination, not a mode. The distinction is load-bearing: talking *about*
 * the worker and talking *to* it are different acts with different
 * consequences, and the UI unifies their presentation without ever unifying
 * their execution.
 */
export type Destination = 'vowe' | 'worker';

export interface DestinationState {
  /** What the developer chose. */
  requested: Destination;
  /** What will actually happen. Never armed when the worker cannot be reached. */
  effective: Destination;
  workerAvailable: boolean;
  /** Why the worker cannot be instructed, in words to show. Null when it can. */
  workerUnavailableReason: string | null;
}

/**
 * Worker control is routinely unavailable, and the reason matters.
 *
 * Any session running in a terminal Vowe does not own is observable but not
 * instructable, and a finished one can receive nothing at all. The UI says
 * which, because "disabled" without a reason reads as a bug.
 */
export function workerUnavailableReason(session: AgentSession | null): string | null {
  if (!session) return 'No session is open.';
  if (session.capabilities.sendInstruction) return null;
  if (session.attachMode === 'external-live') {
    return 'This session runs in a terminal Vowe does not own, so it cannot be sent instructions.';
  }
  if (session.status === 'finished') return 'This session has finished.';
  return 'This session cannot receive instructions right now.';
}

/**
 * Resolve what the composer will actually do.
 *
 * A destination that cannot be reached never stays armed: a developer who
 * selected the worker before it became unreachable must not press send and
 * have the message go somewhere else silently — it falls back to Vowe, and the
 * UI shows the reason.
 */
export function resolveDestination(
  requested: Destination,
  session: AgentSession | null,
): DestinationState {
  const reason = workerUnavailableReason(session);
  const available = reason === null;
  return {
    requested,
    effective: requested === 'worker' && !available ? 'vowe' : requested,
    workerAvailable: available,
    workerUnavailableReason: reason,
  };
}

/**
 * Does this draft read as an instruction for the worker?
 *
 * A heuristic over the developer's own words, and nothing more. It never
 * forwards anything: at most it offers, and only when the worker can actually
 * be reached. Talking about the worker must never silently become talking to
 * it, so the answer here changes what is *offered* and never what is *sent*.
 */
const IMPERATIVE =
  /^(don'?t|do not|stop|use |add |revert|keep |rename|refactor|find another|try |make |remove |fix |change |undo )/i;
const ADDRESSED = /\b(tell|ask) (it|claude|the worker|the agent)\b/i;

export function looksLikeInstruction(draft: string): boolean {
  const text = draft.trim();
  if (!text) return false;
  return IMPERATIVE.test(text) || ADDRESSED.test(text);
}

/** Offer only when it would actually be actionable. */
export function shouldOfferWorker(
  draft: string,
  destination: DestinationState,
): boolean {
  return (
    destination.effective === 'vowe' &&
    destination.workerAvailable &&
    looksLikeInstruction(draft)
  );
}

/**
 * What a key press in a composer means.
 *
 * Enter sends and Shift+Enter inserts a newline, which is what every messaging
 * surface a developer uses already does — the previous ⌘↩ made the common act
 * the awkward one. ⌘↩ and Ctrl+↩ keep working, because people who learned them
 * here should not have them taken away.
 *
 * The composition guard is not a nicety. While an IME is open, Enter commits
 * the candidate the person is choosing; treating that as "send" would post a
 * half-written word in Japanese, Chinese or Korean and lose the rest. A
 * composing Enter therefore does nothing here and belongs to the IME.
 *
 * Pure, and takes only the four fields it reads, so the rule can be stated
 * once and tested without a DOM.
 */
export interface ComposerKey {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** React re-exposes the DOM's own composition flag under `nativeEvent`. */
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}

export type ComposerAction = 'send' | 'newline' | 'none';

export function composerKeyAction(event: ComposerKey): ComposerAction {
  if (event.key !== 'Enter') return 'none';
  if (event.isComposing === true || event.nativeEvent?.isComposing === true) return 'none';
  if (event.shiftKey === true) return 'newline';
  if (event.altKey === true) return 'newline';
  return 'send';
}
