import type { AgentSession } from '../types/session.js';
import { conciseTitle } from './session-title.js';

/**
 * Human-readable names for observed work.
 *
 * One helper, used everywhere a session needs a title or a line about what it
 * is doing. Deterministic by construction: it picks between values that already
 * exist and cleans them up. **No model generates a title.** A name that changed
 * because an LLM felt differently about the same session would be a name you
 * could not navigate by.
 *
 * This module deliberately imports nothing that touches a filesystem, so the
 * renderer can call it directly once the redesigned rooms land.
 */

/**
 * Wrappers a CLI injects around the developer's own words.
 *
 * The adapter strips these on the way in (`stripNoise`), but a task can also
 * reach us through semantic state, an older transcript, or a provider that does
 * no stripping at all — and a title reading `<system-reminder>` is worse than
 * no title. Cleaning again here costs nothing and cannot regress.
 */
const NOISE_PATTERNS: RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g,
  /<command-(name|message|args|contents)>[\s\S]*?<\/command-\1>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g,
];

/**
 * The same wrappers, unpaired.
 *
 * The patterns above remove a wrapper *and* its contents, which is right when
 * both tags are present. A task that was truncated, or whose closing tag is
 * malformed, leaves an orphan opening tag behind — and that orphan was being
 * shown as a session's name. This strips the tags alone and keeps whatever the
 * developer actually wrote between them.
 */
const ORPHAN_WRAPPER =
  /<\/?\s*(?:pasted[_-]?content|paste|document|documents|attachment|attachments|system-reminder|local-command-[a-z-]+|command-[a-z]+|user[_-]?prompt|user-prompt-submit-hook|userStyle|file[_-]?contents?|context|instructions?)\b[^>]*>/gi;

/**
 * A provider's last-resort label, e.g. `claude-code session 1a2b3c4d`.
 *
 * That is an internal identifier wearing a sentence, and showing it to the
 * developer tells them nothing they can use. Recognised so it can be skipped.
 */
const GENERATED_LABEL = /\bsession\s+[0-9a-f][0-9a-f-]{5,}$/i;

/*
 * Ceilings on what reaches the screen, not marks on what got there.
 *
 * These bound a paste that ran to five thousand characters; they are not how
 * the text is shortened to fit. That is the reader's job and it is done in
 * layout, by fading the line out at the edge of its box — so nothing here
 * appends an ellipsis, and the limits are generous enough that the cut is
 * almost always well past the edge the fade happens at.
 */
const DEFAULT_TITLE_LIMIT = 160;
const DEFAULT_ACTIVITY_LIMIT = 240;

/**
 * First meaningful line, wrappers removed, whitespace collapsed, bounded.
 *
 * The bound falls on a word boundary and leaves no mark. An earlier version
 * ended the string with `…`, which put a second kind of truncation on screen a
 * line away from the first: a name that dissolved at the edge of its column
 * above an activity line that stopped with three dots in the middle of it.
 * One truncation, and it is the one the layout performs.
 */
export function plainText(
  value: string | null | undefined,
  limit = DEFAULT_TITLE_LIMIT,
): string {
  if (!value) return '';
  let out = value;
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, ' ');
  out = out.replace(ORPHAN_WRAPPER, ' ');

  const line = out.split('\n').find((candidate) => candidate.trim()) ?? '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;

  // Cut back to the last whole word, so the string the fade dissolves is
  // words rather than a word broken in half.
  const cut = collapsed.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * The best short name for a session that is justified by evidence.
 *
 * What the worker is understood to be doing beats what it was asked to do,
 * which beats whatever the provider called it. An id-shaped label is passed
 * over, and the working directory is a better last resort than an opaque one.
 */
export function sessionTitle(session: AgentSession): string {
  // A title Vowe generated from the task beats anything derivable, because it
  // was produced from the work rather than from the first line of it.
  const generated = session.generatedTitle?.trim();
  if (generated) return generated;

  const candidates = [
    session.semanticState?.task,
    session.task,
    session.displayLabel,
  ];

  /*
   * Everything below here is a *description* of the work being pressed into
   * service as a name, so it is cut to the same length a name is allowed to
   * be. Without this the title contract only governed the model, and a session
   * the model had not named yet showed a full sentence down the sidebar.
   */
  for (const candidate of candidates) {
    const text = plainText(candidate);
    if (!text || GENERATED_LABEL.test(text)) continue;
    /*
     * The cut is the answer or there isn't one. `?? text` used to sit here,
     * which quietly put the whole 160-character sentence back on screen for
     * exactly the candidates `conciseTitle` could make nothing of — a bare
     * identifier, a line that is all parenthetical — so the one contract the
     * title has held everywhere except where it was least able to cope. A
     * session with no nameable task falls through to the directory below,
     * which is short, true, and reads like a name.
     */
    const concise = conciseTitle(text);
    if (concise) return concise;
  }

  const directory = lastSegment(session.cwd);
  if (directory) return directory;
  return 'Untitled session';
}

/** What this session is doing right now, or `null` when nothing observed it. */
export function sessionActivity(session: AgentSession): string | null {
  const value = session.semanticState?.currentActivity;
  if (value && /^(?:Failed:|Nothing observed yet\.)\s*$/.test(value)) return null;
  // Older persisted heuristics may contain execution residue. Do not promote
  // it into activity while waiting for the next interpretation pass.
  if (value && (/^(?:Ran:|Running (?:[A-Z_]+=|(?:pnpm|npm|python\d*|node|rg|find|git|cat|sed|text\()\b)|Command (?:finished|failed):)/i.test(value)
    || /\$\(|```|\btools\.\w+|\*\*/.test(value))) return null;
  const text = plainText(
    value,
    DEFAULT_ACTIVITY_LIMIT,
  );
  return text || null;
}

/** Path-separator agnostic, and without dragging `node:path` into this file. */
function lastSegment(value: string | null): string | null {
  if (!value) return null;
  const segments = value.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? null;
}
