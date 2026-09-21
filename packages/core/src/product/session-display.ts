import type { AgentSession } from '../types/session.js';

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
 * A provider's last-resort label, e.g. `claude-code session 1a2b3c4d`.
 *
 * That is an internal identifier wearing a sentence, and showing it to the
 * developer tells them nothing they can use. Recognised so it can be skipped.
 */
const GENERATED_LABEL = /\bsession\s+[0-9a-f][0-9a-f-]{5,}$/i;

const DEFAULT_TITLE_LIMIT = 80;
const DEFAULT_ACTIVITY_LIMIT = 120;

/** First meaningful line, wrappers removed, whitespace collapsed, truncated. */
export function plainText(
  value: string | null | undefined,
  limit = DEFAULT_TITLE_LIMIT,
): string {
  if (!value) return '';
  let out = value;
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, ' ');

  const line = out.split('\n').find((candidate) => candidate.trim()) ?? '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * The best short name for a session that is justified by evidence.
 *
 * What the worker is understood to be doing beats what it was asked to do,
 * which beats whatever the provider called it. An id-shaped label is passed
 * over, and the working directory is a better last resort than an opaque one.
 */
export function sessionTitle(session: AgentSession): string {
  const candidates = [
    session.semanticState?.task,
    session.task,
    session.displayLabel,
  ];

  for (const candidate of candidates) {
    const text = plainText(candidate);
    if (text && !GENERATED_LABEL.test(text)) return text;
  }

  const directory = lastSegment(session.cwd);
  if (directory) return directory;
  return 'Untitled session';
}

/** What this session is doing right now, or `null` when nothing observed it. */
export function sessionActivity(session: AgentSession): string | null {
  const text = plainText(
    session.semanticState?.currentActivity,
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
