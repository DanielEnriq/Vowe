/**
 * References into observed material.
 *
 * A ref is the unit of provenance in the observation harness: every L1 note,
 * every surface-update candidate and every delegated answer carries refs back
 * to the material it was derived from. Refs are addresses, never copies.
 *
 * Each ref has a compact string form so a model can read one out of a search
 * result and hand it straight back to `open_context` without the application
 * having to maintain a side table of handles.
 *
 * **This module imports nothing, and must keep importing nothing.** It is
 * published as the `@vowe/core/refs` subpath so the renderer can format a ref
 * for display, and the renderer is a browser context: every other runtime value
 * in `@vowe/core` reaches a filesystem or a process sooner or later, which is
 * why the UI imports only types from the package root. A single import added
 * here would drag `node:fs` into that bundle.
 */

export type ContextSource = 'windows' | 'trace' | 'transcript' | 'repo';

export type ContextRef =
  /** An interpreted window: its L1 note plus the L0 range beneath it. */
  | { kind: 'window'; sessionId: string; windowId: string }
  /** A range of the native trace, addressed by normalized event sequence. */
  | { kind: 'trace'; sessionId: string; startSeq: number; endSeq: number }
  /** One normalized event, and through it one raw provider record. */
  | { kind: 'event'; sessionId: string; eventId: string }
  /** A point in the worker/user exchange. */
  | { kind: 'transcript'; sessionId: string; eventId: string }
  /** A location in the working tree. */
  | { kind: 'repo'; path: string; line?: number }
  /** The current diff, optionally narrowed to one path. */
  | { kind: 'diff'; sessionId: string; path?: string }
  /** A node in a project's code graph: orientation, not truth. */
  | { kind: 'symbol'; projectId: string; nodeId: string }
  /** Something Vowe worked out about this project and kept. */
  | { kind: 'lesson'; projectId: string; recordId: string };

/**
 * The string form. Kept terse because these travel through model context, and
 * unambiguous because they travel back.
 */
export function formatRef(ref: ContextRef): string {
  switch (ref.kind) {
    case 'window':
      return `window:${ref.sessionId}:${ref.windowId}`;
    case 'trace':
      return `trace:${ref.sessionId}:${ref.startSeq}-${ref.endSeq}`;
    case 'event':
      return `event:${ref.sessionId}:${ref.eventId}`;
    case 'transcript':
      return `transcript:${ref.sessionId}:${ref.eventId}`;
    case 'repo':
      return ref.line === undefined ? `repo:${ref.path}` : `repo:${ref.path}#${ref.line}`;
    case 'diff':
      // `#` separates the path, not `:`. A session id contains a colon of its
      // own, so `diff:a:b` cannot be told apart from a session id with a path.
      return ref.path ? `diff:${ref.sessionId}#${ref.path}` : `diff:${ref.sessionId}`;
    case 'symbol':
      // `#` again, and for a second reason on top of the colon in a project
      // id: a graph node id is the provider's own string, and Vowe does not
      // get to assume what is in it.
      return `symbol:${ref.projectId}#${ref.nodeId}`;
    case 'lesson':
      return `lesson:${ref.projectId}#${ref.recordId}`;
  }
}

/** Returns `null` rather than throwing: a model can and will produce nonsense. */
export function parseRef(value: string | ContextRef): ContextRef | null {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const separator = trimmed.indexOf(':');
  if (separator === -1) return null;
  const kind = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1);

  switch (kind) {
    case 'window': {
      const [sessionId, windowId] = splitLast(rest);
      if (!sessionId || !windowId) return null;
      return { kind: 'window', sessionId, windowId };
    }
    case 'trace': {
      const [sessionId, range] = splitLast(rest);
      if (!sessionId || !range) return null;
      const match = /^(\d+)-(\d+)$/.exec(range);
      if (!match) return null;
      return {
        kind: 'trace',
        sessionId,
        startSeq: Number(match[1]),
        endSeq: Number(match[2]),
      };
    }
    case 'event':
    case 'transcript': {
      const [sessionId, eventId] = splitLast(rest);
      if (!sessionId || !eventId) return null;
      return { kind, sessionId, eventId };
    }
    case 'repo': {
      const hash = rest.lastIndexOf('#');
      if (hash === -1) return rest ? { kind: 'repo', path: rest } : null;
      const path = rest.slice(0, hash);
      const line = Number(rest.slice(hash + 1));
      if (!path) return null;
      return Number.isFinite(line) ? { kind: 'repo', path, line } : { kind: 'repo', path };
    }
    case 'diff': {
      const hash = rest.indexOf('#');
      if (hash === -1) return rest ? { kind: 'diff', sessionId: rest } : null;
      const sessionId = rest.slice(0, hash);
      const path = rest.slice(hash + 1);
      if (!sessionId) return null;
      return path
        ? { kind: 'diff', sessionId, path }
        : { kind: 'diff', sessionId };
    }
    case 'symbol': {
      const hash = rest.indexOf('#');
      if (hash === -1) return null;
      const projectId = rest.slice(0, hash);
      const nodeId = rest.slice(hash + 1);
      if (!projectId || !nodeId) return null;
      return { kind: 'symbol', projectId, nodeId };
    }
    case 'lesson': {
      const hash = rest.indexOf('#');
      if (hash === -1) return null;
      const projectId = rest.slice(0, hash);
      const recordId = rest.slice(hash + 1);
      if (!projectId || !recordId) return null;
      return { kind: 'lesson', projectId, recordId };
    }
    default:
      return null;
  }
}

/**
 * Session ids are `${provider}:${providerSessionId}` and therefore contain a
 * colon themselves, so the trailing component is what gets split off.
 */
function splitLast(value: string): [string | null, string | null] {
  const index = value.lastIndexOf(':');
  if (index === -1) return [value || null, null];
  return [value.slice(0, index) || null, value.slice(index + 1) || null];
}

export function dedupeRefs(refs: ContextRef[]): ContextRef[] {
  const seen = new Set<string>();
  const out: ContextRef[] = [];
  for (const ref of refs) {
    const key = formatRef(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}
