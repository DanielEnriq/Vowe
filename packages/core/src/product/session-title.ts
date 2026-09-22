import type { AgentSession } from '../types/session.js';

/**
 * What a session is called, and how that is decided.
 *
 * A provider's `displayLabel` is an identifier, not a name — often the
 * transcript's filename stem — and a raw `task` is whatever the developer
 * happened to paste, wrappers and all. Neither is something to read down a
 * sidebar. This is the one place that turns both into a title.
 */

/**
 * Transport and UI wrappers that carry no meaning about the work.
 *
 * Stripped rather than escaped, and only the tags: the developer's actual
 * words are usually *inside* one of these, and throwing the content away with
 * the wrapper would discard the only real naming signal there is.
 */
const WRAPPER_TAGS =
  /<\/?\s*(?:pasted[_-]?content|paste|document|documents|attachment|attachments|system-reminder|local-command-[a-z-]+|command-[a-z]+|bash-(?:input|stdout|stderr)|user[_-]?prompt|user-prompt-submit-hook|userStyle|file[_-]?contents?|context|instructions?)\b[^>]*>/gi;

/** A bare opaque identifier is never what a task is about. */
const OPAQUE_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})\b/gi;

/** Enough for a model to name the work; not enough to be a cost. */
export const MAX_TASK_SIGNAL = 1200;

/**
 * The task, as a naming signal.
 *
 * Total: anything at all, including `null`, yields a string. An empty result
 * means there is nothing worth naming from, which callers check rather than
 * sending emptiness to a model.
 */
export function sanitizeTask(task: string | null | undefined): string {
  if (typeof task !== 'string') return '';
  return task
    .replace(WRAPPER_TAGS, ' ')
    .replace(OPAQUE_ID, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TASK_SIGNAL)
    .trim();
}

/**
 * Titles are short. Anything longer is a description.
 *
 * Tightened deliberately: the first generated titles were accurate and too
 * long to scan down a sidebar. Three to six words of verb and object fit the
 * column at every window width, and the activity line underneath carries the
 * detail that used to be crammed in here.
 */
export const MAX_TITLE_WORDS = 6;
export const MAX_TITLE_CHARS = 42;

/**
 * A model's answer, taken at its word but not on trust.
 *
 * Models wrap titles in quotes, end them with a period, and occasionally
 * explain themselves. Strip all three, and refuse anything that survived as
 * nothing — an empty title is worse than the deterministic fallback.
 */
export function normalizeGeneratedTitle(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;

  const firstLine = text.split('\n').find((line) => line.trim().length) ?? '';
  const cleaned = firstLine
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .replace(/[.。]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;
  // A sentence is not a title: something went wrong, and the fallback is
  // better than a paragraph down the side of the window.
  if (cleaned.split(' ').length > MAX_TITLE_WORDS) return null;
  if (cleaned.length > MAX_TITLE_CHARS) return null;
  return cleaned;
}

/**
 * Whether this session still needs a title, and from what.
 *
 * `null` when there is nothing to name from or nothing to do — which is most
 * sessions, most of the time, and is why this is asked before a model is.
 *
 * **A stored title is final.** Any non-empty `generatedTitle` ends this, and
 * the length contract is not re-applied to it. That used to be the opposite:
 * a title generated under a looser rule was re-offered for naming, so
 * tightening the contract silently re-named history, and every change to the
 * interpreter's reading of a session bought another model call for a session
 * that already had a perfectly good name. A title is durable metadata written
 * once. If it is there, it stays.
 */
export function titleSignal(
  session: Pick<AgentSession, 'task' | 'semanticState' | 'generatedTitle'>,
): string | null {
  if (typeof session.generatedTitle === 'string' && session.generatedTitle.trim()) {
    return null;
  }

  /*
   * What the worker is understood to be doing beats what it was asked to do.
   *
   * A provider's `task` is the developer's opening words verbatim, and those
   * are routinely nothing but a paste wrapper — `<pasted_content id="…">` and
   * no more, with the real content stripped before it ever reached the store.
   * The interpreter's reading of the session is the signal that survives that.
   */
  const candidates = [session.semanticState?.task, session.task];
  for (const candidate of candidates) {
    const signal = sanitizeTask(candidate);
    // Below this there is no sentence to name — a word or two is a title.
    if (signal.length >= 12) return signal;
  }
  return null;
}

/**
 * A concise title from a long signal, without a model.
 *
 * The contract has to hold for what is *shown*, not merely for what a model is
 * allowed to return. Tightening the limits without this made things worse: a
 * rejected title left the session falling back to the interpreter's full
 * sentence, so stricter validation produced longer names on screen. This is
 * the floor under that — every path now ends somewhere inside the contract.
 *
 * Deterministic and lossy on purpose. It takes whole words from the front
 * until the next one would break the limits, which is where the useful part of
 * a task description almost always is, and never invents a word that was not
 * there. `null` when there is nothing usable to cut down.
 */
export function conciseTitle(signal: string | null | undefined): string | null {
  const cleaned = sanitizeTask(signal)
    // A parenthetical is an aside about the work, not its name.
    .replace(/\([^)]*\)?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;

  const words: string[] = [];
  let length = 0;
  for (const word of cleaned.split(' ')) {
    if (words.length >= MAX_TITLE_WORDS) break;
    const next = length === 0 ? word.length : length + 1 + word.length;
    if (next > MAX_TITLE_CHARS) break;
    words.push(word);
    length = next;
  }

  // A first word already past the limit is cut mid-word rather than dropped:
  // something recognisable beats "Untitled session".
  if (!words.length) return cleaned.slice(0, MAX_TITLE_CHARS).trim() || null;

  // A cut that lands after "and" or "to" reads as a sentence someone stopped
  // writing. Dropping the dangling word costs nothing and ends on the noun.
  while (words.length > 1 && DANGLING.has(words[words.length - 1]!.toLowerCase())) {
    words.pop();
  }

  const title = words
    .join(' ')
    // Trailing punctuation left by the cut reads as a truncation artefact.
    .replace(/[\s,;:.\-–—/]+$/, '')
    .trim();
  return title ? capitalize(title) : null;
}

/** Words no name should end on. */
const DANGLING = new Set([
  'and', 'or', 'but', 'then', 'plus', 'with', 'without', 'for', 'to', 'of', 'in',
  'on', 'at', 'by', 'from', 'into', 'onto', 'the', 'a', 'an', 'its', 'their', 'that',
]);

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
