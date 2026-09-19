import { readFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';

import type { EventStore } from '../store/event-store.js';
import type { NormalizedEvent } from '../types/events.js';
import type { TraceWindow, WindowNote } from '../observation/trace-window.js';
import { getGitDiff, gitGrep, type DiffResult } from './git-diff.js';
import { formatRef, parseRef, type ContextRef, type ContextSource } from './refs.js';

export interface SearchContextInput {
  sessionId: string;
  query: string;
  sources?: ContextSource[];
  limit?: number;
}

export interface SearchHit {
  ref: ContextRef;
  /** Stable string form of `ref`, for handing straight back to open_context. */
  refId: string;
  source: ContextSource;
  /** One line of orientation: what this hit is. */
  label: string;
  /** Bounded excerpt of the matching material. */
  snippet: string;
  at?: string;
}

export interface OpenContextInput {
  ref: string | ContextRef;
  depth?: OpenDepth;
}

/**
 * How far down to go.
 *
 * `summary` orients, `full` gives the normalized material, `raw` reaches past
 * Vowe entirely and re-reads the provider's own record from its own file. The
 * last one exists so that "what did the command actually print?" is always
 * answerable, even when the normalizer truncated it.
 */
export type OpenDepth = 'summary' | 'full' | 'raw';

export interface OpenResult {
  ref: ContextRef;
  refId: string;
  kind: ContextRef['kind'];
  /** Human-readable rendering, already bounded. */
  content: string;
  /** Refs worth opening next, for stepwise descent. */
  related: ContextRef[];
  truncated: boolean;
  notFound?: string;
}

export interface GetDiffInput {
  sessionId: string;
  path?: string;
  /** A ref to take the path from, when the caller has one but not a filename. */
  around?: string | ContextRef;
}

export interface ContextNavigatorOptions {
  store: EventStore;
  /** Resolves a session's working directory. Kept as a function so the
   *  navigator does not need the registry. */
  resolveCwd?: (sessionId: string) => string | null;
  defaultLimit?: number;
  /** Per-hit snippet ceiling. */
  maxSnippetBytes?: number;
  /** Ceiling on a single `open_context` payload. */
  maxOpenBytes?: number;
}

const DEFAULT_LIMIT = 12;
const MAX_SNIPPET_BYTES = 600;
const MAX_OPEN_BYTES = 12_000;

const TRANSCRIPT_KINDS = new Set<NormalizedEvent['kind']>([
  'agent_message',
  'user_instruction',
  'session_started',
]);

/**
 * The one read-only interface onto everything Vowe can see.
 *
 * Shared, deliberately and without variation, by the observer following the
 * work and by the runner answering a user's question. If the two had different
 * views, an answer could contradict an observation and neither would be
 * checkable.
 *
 * The toolset is kept small on purpose: search, then zoom in, plus diffs. It
 * returns references and bounded snippets rather than dumping material into a
 * model's context — descending is a decision the caller makes explicitly.
 *
 * Note what is *not* here: `surface_update`. Proposing to interrupt the human
 * is not a read, and the delegated-question path must not be able to do it.
 * That capability is a separate sink handed only to the observer.
 */
export class ContextNavigator {
  private readonly store: EventStore;
  private readonly resolveCwd: (sessionId: string) => string | null;
  private readonly defaultLimit: number;
  private readonly maxSnippetBytes: number;
  private readonly maxOpenBytes: number;

  constructor(options: ContextNavigatorOptions) {
    this.store = options.store;
    this.resolveCwd =
      options.resolveCwd ?? ((sessionId) => this.store.getSession(sessionId)?.cwd ?? null);
    this.defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
    this.maxSnippetBytes = options.maxSnippetBytes ?? MAX_SNIPPET_BYTES;
    this.maxOpenBytes = options.maxOpenBytes ?? MAX_OPEN_BYTES;
  }

  // ---------------------------------------------------------- search_context

  async searchContext(input: SearchContextInput): Promise<SearchHit[]> {
    const limit = input.limit ?? this.defaultLimit;
    const sources = input.sources?.length
      ? input.sources
      : (['windows', 'trace', 'transcript'] as ContextSource[]);
    const terms = tokenize(input.query);
    if (!terms.length) return [];

    const hits: SearchHit[] = [];
    // Allocate the budget across the requested sources rather than letting one
    // noisy source crowd the others out.
    const perSource = Math.max(2, Math.ceil(limit / sources.length));

    for (const source of sources) {
      switch (source) {
        case 'windows':
          hits.push(...this.searchWindows(input.sessionId, terms, perSource));
          break;
        case 'trace':
          hits.push(...this.searchTrace(input.sessionId, terms, perSource, false));
          break;
        case 'transcript':
          hits.push(...this.searchTrace(input.sessionId, terms, perSource, true));
          break;
        case 'repo':
          hits.push(...(await this.searchRepo(input.sessionId, input.query, perSource)));
          break;
      }
    }

    return hits.slice(0, limit);
  }

  private searchWindows(
    sessionId: string,
    terms: string[],
    limit: number,
  ): SearchHit[] {
    const notes = this.store.getWindowNotes(sessionId);
    const scored: { score: number; note: WindowNote }[] = [];
    for (const note of notes) {
      const haystack = [note.summary, note.currentActivity, note.notableChange]
        .filter(Boolean)
        .join(' ');
      const score = scoreOf(haystack, terms);
      if (score > 0) scored.push({ score, note });
    }
    scored.sort((a, b) => b.score - a.score || b.note.windowIndex - a.note.windowIndex);

    return scored.slice(0, limit).map(({ note }) => {
      const ref: ContextRef = {
        kind: 'window',
        sessionId,
        windowId: note.windowId,
      };
      return {
        ref,
        refId: formatRef(ref),
        source: 'windows' as const,
        label: `Window ${note.windowIndex}`,
        snippet: this.snippet(
          [note.summary, note.currentActivity, note.notableChange]
            .filter(Boolean)
            .join('\n'),
        ),
        at: note.createdAt,
      };
    });
  }

  private searchTrace(
    sessionId: string,
    terms: string[],
    limit: number,
    transcriptOnly: boolean,
  ): SearchHit[] {
    const events = this.store.getEvents(sessionId);
    const scored: { score: number; event: NormalizedEvent }[] = [];

    for (const event of events) {
      if (transcriptOnly && !TRANSCRIPT_KINDS.has(event.kind)) continue;
      const haystack = `${event.summary}\n${detailText(event)}`;
      const score = scoreOf(haystack, terms);
      if (score > 0) scored.push({ score, event });
    }
    // Ties go to later events: in a long session, recent evidence usually wins.
    scored.sort((a, b) => b.score - a.score || b.event.seq - a.event.seq);

    return scored.slice(0, limit).map(({ event }) => {
      const kind = transcriptOnly ? ('transcript' as const) : ('event' as const);
      const ref: ContextRef = { kind, sessionId, eventId: event.id };
      return {
        ref,
        refId: formatRef(ref),
        source: transcriptOnly ? ('transcript' as const) : ('trace' as const),
        label: `[${event.seq}] ${event.kind}`,
        snippet: this.snippet(`${event.summary}\n${detailText(event)}`),
        at: event.at,
      };
    });
  }

  private async searchRepo(
    sessionId: string,
    query: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const cwd = this.resolveCwd(sessionId);
    const found = await gitGrep(cwd, query, limit);
    return found.map((hit) => {
      const ref: ContextRef = { kind: 'repo', path: hit.path, line: hit.line };
      return {
        ref,
        refId: formatRef(ref),
        source: 'repo' as const,
        label: `${hit.path}:${hit.line}`,
        snippet: this.snippet(hit.text),
      };
    });
  }

  // ------------------------------------------------------------ open_context

  async openContext(input: OpenContextInput): Promise<OpenResult> {
    const ref = parseRef(input.ref);
    if (!ref) {
      return {
        ref: { kind: 'repo', path: String(input.ref) },
        refId: String(input.ref),
        kind: 'repo',
        content: '',
        related: [],
        truncated: false,
        notFound: `Not a reference this system recognizes: ${String(input.ref)}`,
      };
    }
    const depth = input.depth ?? 'full';

    switch (ref.kind) {
      case 'window':
        return this.openWindow(ref, depth);
      case 'trace':
        return this.openTrace(ref, depth);
      case 'event':
      case 'transcript':
        return this.openEvent(ref, depth);
      case 'repo':
        return this.openRepo(ref);
      case 'diff': {
        const diff = await this.getDiff({ sessionId: ref.sessionId, path: ref.path });
        return this.result(ref, renderDiff(diff), []);
      }
    }
  }

  private openWindow(
    ref: Extract<ContextRef, { kind: 'window' }>,
    depth: OpenDepth,
  ): OpenResult {
    const window = this.store.getWindow(ref.sessionId, ref.windowId);
    if (!window) return this.missing(ref, 'No such window.');
    const note = this.store.getWindowNoteForWindow(ref.sessionId, ref.windowId);

    const traceRef: ContextRef = {
      kind: 'trace',
      sessionId: ref.sessionId,
      startSeq: window.startSeq,
      endSeq: window.endSeq,
    };

    const lines: string[] = [
      `Window ${window.index} — events ${window.startSeq}..${window.endSeq} (${window.eventCount} events)`,
      `Trace time ${window.startedAt} → ${window.endedAt}, closed by ${window.closedBy}`,
      window.source
        ? `Source ${window.source} bytes ${window.startOffset}..${window.endOffset}`
        : 'Source unknown',
      '',
    ];
    if (note) {
      lines.push(note.summary);
      if (note.currentActivity) lines.push(`Now: ${note.currentActivity}`);
      if (note.notableChange) lines.push(`Notable: ${note.notableChange}`);
    } else {
      lines.push('This window has not been interpreted yet.');
    }

    if (depth !== 'summary') {
      lines.push('', 'Underlying trace:');
      for (const event of this.eventsInRange(ref.sessionId, window.startSeq, window.endSeq)) {
        lines.push(`  [${event.seq}] ${event.kind}: ${event.summary}`);
      }
    }

    return this.result(ref, lines.join('\n'), [traceRef]);
  }

  private openTrace(
    ref: Extract<ContextRef, { kind: 'trace' }>,
    depth: OpenDepth,
  ): OpenResult {
    const events = this.eventsInRange(ref.sessionId, ref.startSeq, ref.endSeq);
    if (!events.length) return this.missing(ref, 'No events in that range.');

    const lines: string[] = [];
    for (const event of events) {
      lines.push(`[${event.seq}] ${event.at} ${event.kind}: ${event.summary}`);
      if (depth !== 'summary') {
        const detail = detailText(event);
        if (detail) lines.push(indent(detail));
      }
    }
    const related: ContextRef[] = events
      .slice(0, 10)
      .map((event) => ({ kind: 'event', sessionId: ref.sessionId, eventId: event.id }));

    return this.result(ref, lines.join('\n'), related);
  }

  private async openEvent(
    ref: Extract<ContextRef, { kind: 'event' | 'transcript' }>,
    depth: OpenDepth,
  ): Promise<OpenResult> {
    const [event] = this.store.getEventsByIds(ref.sessionId, [ref.eventId]);
    if (!event) return this.missing(ref, 'No such event.');

    const lines: string[] = [
      `[${event.seq}] ${event.at} ${event.kind}: ${event.summary}`,
    ];

    if (ref.kind === 'transcript') {
      // A single message is rarely the answer; the exchange around it is.
      const neighbours = this.store
        .getEvents(ref.sessionId)
        .filter(
          (candidate) =>
            TRANSCRIPT_KINDS.has(candidate.kind) &&
            Math.abs(candidate.seq - event.seq) <= 6,
        );
      lines.push('', 'Surrounding exchange:');
      for (const neighbour of neighbours) {
        const marker = neighbour.seq === event.seq ? '>' : ' ';
        lines.push(`${marker} [${neighbour.seq}] ${neighbour.kind}: ${neighbour.summary}`);
        const text = stringField(neighbour.detail, 'text');
        if (text) lines.push(indent(text));
      }
    } else if (depth !== 'summary') {
      const detail = detailText(event);
      if (detail) lines.push('', detail);
    }

    if (depth === 'raw') {
      // The normalizer truncates command output, so the answer to "what did it
      // actually print?" lives in the provider's file, not in our copy.
      const raw = await this.readRawLine(event);
      lines.push(
        '',
        `Raw record (${event.rawRef.source}:${event.rawRef.line}, byte ${event.rawRef.byteOffset}):`,
        raw ?? '  unavailable — the source file could not be re-read',
      );
    }

    return this.result(ref, lines.join('\n'), []);
  }

  private async openRepo(
    ref: Extract<ContextRef, { kind: 'repo' }>,
  ): Promise<OpenResult> {
    try {
      const text = await readFile(ref.path, 'utf8');
      const lines = text.split('\n');
      if (ref.line === undefined) {
        return this.result(ref, lines.slice(0, 200).join('\n'), []);
      }
      const from = Math.max(0, ref.line - 30);
      const to = Math.min(lines.length, ref.line + 30);
      const numbered = lines
        .slice(from, to)
        .map((line, offset) => `${String(from + offset + 1).padStart(5)} ${line}`);
      return this.result(ref, numbered.join('\n'), []);
    } catch (error) {
      return this.missing(
        ref,
        `Could not read ${ref.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------- get_diff

  async getDiff(input: GetDiffInput): Promise<DiffResult> {
    let path = input.path;
    if (!path && input.around) {
      path = this.pathFromRef(input.around) ?? undefined;
    }
    const options: Parameters<typeof getGitDiff>[0] = {
      cwd: this.resolveCwd(input.sessionId),
    };
    if (path) options.path = path;
    return getGitDiff(options);
  }

  // ----------------------------------------------------------------- private

  /**
   * Re-read the provider's own record from its own file.
   *
   * This is the bottom of the descent. Everything above it is Vowe's view of
   * the work; this is the work's own record, addressed by the byte offset the
   * adapter captured when it first read the line.
   */
  private async readRawLine(event: NormalizedEvent): Promise<string | null> {
    const { source, byteOffset } = event.rawRef;
    if (!source) return null;
    try {
      const handle = await open(source, 'r');
      try {
        const buffer = Buffer.alloc(this.maxOpenBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, byteOffset);
        const text = buffer.subarray(0, bytesRead).toString('utf8');
        const newline = text.indexOf('\n');
        return newline === -1 ? text : text.slice(0, newline);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  private eventsInRange(
    sessionId: string,
    startSeq: number,
    endSeq: number,
  ): NormalizedEvent[] {
    return this.store
      .getEvents(sessionId, { sinceSeq: startSeq - 1 })
      .filter((event) => event.seq <= endSeq);
  }

  private pathFromRef(value: string | ContextRef): string | null {
    const ref = parseRef(value);
    if (!ref) return null;
    if (ref.kind === 'repo') return ref.path;
    if (ref.kind === 'diff') return ref.path ?? null;
    if (ref.kind === 'event' || ref.kind === 'transcript') {
      const [event] = this.store.getEventsByIds(ref.sessionId, [ref.eventId]);
      if (!event) return null;
      const direct = stringField(event.detail, 'file_path');
      if (direct) return direct;
      const input = event.detail?.['input'];
      if (input && typeof input === 'object') {
        return stringField(input as Record<string, unknown>, 'file_path');
      }
    }
    return null;
  }

  private result(
    ref: ContextRef,
    content: string,
    related: ContextRef[],
  ): OpenResult {
    const truncated = content.length > this.maxOpenBytes;
    const bounded = truncated
      ? `${content.slice(0, this.maxOpenBytes)}\n… truncated …`
      : content;
    const out: OpenResult = {
      ref,
      refId: formatRef(ref),
      kind: ref.kind,
      content: bounded,
      related,
      truncated,
    };
    return out;
  }

  private missing(ref: ContextRef, why: string): OpenResult {
    return {
      ref,
      refId: formatRef(ref),
      kind: ref.kind,
      content: '',
      related: [],
      truncated: false,
      notFound: why,
    };
  }

  private snippet(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > this.maxSnippetBytes
      ? `${collapsed.slice(0, this.maxSnippetBytes)}…`
      : collapsed;
  }
}

// -------------------------------------------------------------------- helpers

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}

/** Count of matching terms, so a hit on two terms outranks a hit on one. */
function scoreOf(haystack: string, terms: string[]): number {
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lower.includes(term)) score += 1;
  }
  return score;
}

function detailText(event: NormalizedEvent): string {
  if (!event.detail) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(event.detail)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') {
      try {
        parts.push(`${key}: ${JSON.stringify(value)}`);
      } catch {
        continue;
      }
    } else {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.join('\n');
}

function stringField(
  detail: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = detail?.[key];
  return typeof value === 'string' && value ? value : null;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export function renderDiff(diff: DiffResult): string {
  if (diff.unavailable) return `No diff available: ${diff.unavailable}`;
  if (!diff.stat && !diff.patch) return 'The working tree is clean.';
  return [diff.stat, '', diff.patch].join('\n').trim();
}
