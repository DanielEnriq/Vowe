import { readFile } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectKnowledgeService } from '../knowledge/project-knowledge-service.js';
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

/** A window of a file, as something that draws its own gutter wants it. */
export interface SourceSlice {
  path: string;
  /** The lines themselves, unnumbered. */
  text: string;
  /** 1-based and inclusive, so a viewer can label the gutter truthfully. */
  startLine: number;
  endLine: number;
  truncated: boolean;
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
  /**
   * Resolves a session's project. Same convention as `resolveCwd`: a function,
   * so the navigator does not have to hold the project service.
   */
  resolveProject?: (sessionId: string) => string | null;
  /**
   * Persistent repository knowledge. Absent, `repo` search is `git grep` and
   * nothing else — which is exactly what it was before this existed.
   */
  knowledge?: ProjectKnowledgeService;
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
  private readonly resolveProject: (sessionId: string) => string | null;
  private readonly knowledge: ProjectKnowledgeService | null;
  private readonly defaultLimit: number;
  private readonly maxSnippetBytes: number;
  private readonly maxOpenBytes: number;

  constructor(options: ContextNavigatorOptions) {
    this.store = options.store;
    this.resolveCwd =
      options.resolveCwd ?? ((sessionId) => this.store.getSession(sessionId)?.cwd ?? null);
    this.resolveProject =
      options.resolveProject ??
      ((sessionId) => this.store.getSession(sessionId)?.projectId ?? null);
    this.knowledge = options.knowledge ?? null;
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

  /**
   * The working tree, through whatever Vowe knows about it.
   *
   * Graph knowledge **augments** `git grep`; it never replaces it. That
   * ordering is the safety property: an index that is stale, still building or
   * absent can only ever add nothing, and can never hide a file that exists on
   * disk right now.
   */
  private async searchRepo(
    sessionId: string,
    query: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const hits: SearchHit[] = [];
    const projectId = this.resolveProject(sessionId);

    if (projectId && this.knowledge?.available) {
      const known = await this.knowledge.search({
        projectId,
        query,
        limit: Math.ceil(limit / 2),
      });
      for (const hit of known) {
        // `origin` is the only thing that decides which kind of ref this is.
        // The model asked the repository a question and is handed addresses; it
        // never has to know that two different stores answered.
        const ref: ContextRef =
          hit.origin === 'memory'
            ? { kind: 'lesson', projectId, recordId: hit.id }
            : { kind: 'symbol', projectId, nodeId: hit.id };
        hits.push({
          ref,
          refId: formatRef(ref),
          source: 'repo' as const,
          label:
            hit.origin === 'memory'
              ? `Known: ${hit.label}`
              : hit.kind
                ? `${hit.label} (${hit.kind})`
                : hit.label,
          snippet: this.snippet(hit.summary),
        });
      }
    }

    hits.push(...(await this.grepHits(sessionId, query, limit - hits.length)));
    return hits;
  }

  private async grepHits(
    sessionId: string,
    query: string,
    limit: number,
  ): Promise<SearchHit[]> {
    if (limit <= 0) return [];
    const cwd = this.resolveCwd(sessionId);
    const found = await gitGrep(cwd, query, limit);
    return found.map((hit) => {
      // `git grep` prints repository-relative paths, but a ref travels through
      // model context and comes back to a process whose working directory is
      // not the repository. Absolute here, at the one place that still knows
      // which tree it came from.
      const absolute = cwd ? path.resolve(cwd, hit.path) : hit.path;
      const ref: ContextRef = { kind: 'repo', path: absolute, line: hit.line };
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
      case 'symbol':
        return this.openSymbol(ref);
      case 'lesson':
        return this.openLesson(ref);
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
    const slice = await this.readSlice(ref.path, ref.line);
    if (slice === null) {
      return this.missing(ref, `Could not read ${ref.path}.`);
    }
    return this.result(ref, slice, []);
  }

  /**
   * A node in the code graph, and then the source it points at.
   *
   * The graph is orientation, never an answer. So this does not stop at what
   * the graph says about a symbol — it goes on to read the file, because the
   * graph was built at some point in the past and the file is true now. A
   * caller that only ever saw the graph's own description could repeat a claim
   * the source stopped supporting three commits ago.
   */
  private async openSymbol(
    ref: Extract<ContextRef, { kind: 'symbol' }>,
  ): Promise<OpenResult> {
    if (!this.knowledge?.available) {
      return this.missing(ref, 'Repository knowledge is not available.');
    }
    const node = await this.knowledge.open(ref.projectId, ref.nodeId);
    if (!node) return this.missing(ref, 'No such symbol in the code graph.');

    const lines: string[] = [
      node.kind ? `${node.label} — ${node.kind}` : node.label,
    ];
    if (node.summary) lines.push(node.summary);

    if (node.related.length) {
      lines.push('', 'Connected to:');
      for (const edge of node.related.slice(0, 12)) {
        lines.push(`  ${edge.relation}`);
      }
    }

    const related: ContextRef[] = [];
    for (const location of node.locations) {
      const repoRef: ContextRef = {
        kind: 'repo',
        path: location.path,
        ...(location.line === undefined ? {} : { line: location.line }),
      };
      related.push(repoRef);
      const slice = await this.readSlice(location.path, location.line);
      lines.push(
        '',
        `Source — ${formatRef(repoRef)}:`,
        slice ?? '  unavailable — the file could not be read',
      );
    }
    if (!node.locations.length) {
      lines.push(
        '',
        'The graph records no source location for this. Search the repository by name to find it.',
      );
    }

    for (const edge of node.related.slice(0, 6)) {
      related.push({ kind: 'symbol', projectId: ref.projectId, nodeId: edge.nodeId });
    }

    return this.result(ref, lines.join('\n'), related);
  }

  /**
   * Something Vowe worked out earlier, and the material it worked it out from.
   *
   * A lesson is not evidence; it is a previous conclusion. So it comes back with
   * the refs it was built from attached, and a reader who wants to rely on it
   * can go and check the same places. A remembered claim that could not be
   * re-derived would be exactly the kind of thing that makes a memory worse
   * than no memory.
   */
  private async openLesson(
    ref: Extract<ContextRef, { kind: 'lesson' }>,
  ): Promise<OpenResult> {
    const record = await this.knowledge?.openMemory(ref.projectId, ref.recordId);
    if (!record) return this.missing(ref, 'No such remembered result.');

    const lines: string[] = [
      `Remembered ${record.at} — ${record.outcome}`,
      '',
      `Question: ${record.question}`,
      `Answer: ${record.answer}`,
    ];
    if (record.correction) {
      lines.push('', `Correction: ${record.correction}`);
    }
    if (record.supersedes) {
      lines.push(`Supersedes: ${formatRef({
        kind: 'lesson',
        projectId: ref.projectId,
        recordId: record.supersedes,
      })}`);
    }

    const related = record.refs
      .map((raw) => parseRef(raw))
      .filter((candidate): candidate is ContextRef => candidate !== null);
    if (related.length) {
      lines.push('', 'Worked out from:', ...related.map((entry) => `  ${formatRef(entry)}`));
    }

    return this.result(ref, lines.join('\n'), related);
  }

  /**
   * The same window of a file, unnumbered and with its bounds.
   *
   * A model reads a gutter; a code viewer draws one. This is the shape for
   * anything that is going to render the source itself, and `readSlice` is the
   * numbering wrapper the model-facing paths keep using.
   */
  async readSource(
    ref: Extract<ContextRef, { kind: 'repo' }>,
  ): Promise<SourceSlice | null> {
    const slice = await this.sliceOf(ref.path, ref.line);
    if (!slice) return null;
    const joined = slice.lines.join('\n');
    const truncated = joined.length > this.maxOpenBytes;
    return {
      path: ref.path,
      text: truncated ? `${joined.slice(0, this.maxOpenBytes)}\n… truncated …` : joined,
      startLine: slice.startLine,
      endLine: slice.endLine,
      truncated,
    };
  }

  /** A numbered window around a line, or the head of the file without one. */
  private async readSlice(
    file: string,
    line: number | undefined,
  ): Promise<string | null> {
    const slice = await this.sliceOf(file, line);
    if (!slice) return null;
    if (line === undefined) return slice.lines.join('\n');
    return slice.lines
      .map(
        (text, offset) =>
          `${String(slice.startLine + offset).padStart(5)} ${text}`,
      )
      .join('\n');
  }

  /** The window itself: which lines, and where they start. 1-based, inclusive. */
  private async sliceOf(
    file: string,
    line: number | undefined,
  ): Promise<{ lines: string[]; startLine: number; endLine: number } | null> {
    try {
      const lines = (await readFile(file, 'utf8')).split('\n');
      if (line === undefined) {
        const head = lines.slice(0, 200);
        return { lines: head, startLine: 1, endLine: head.length };
      }
      const from = Math.max(0, line - 30);
      const to = Math.min(lines.length, line + 30);
      return { lines: lines.slice(from, to), startLine: from + 1, endLine: to };
    } catch {
      return null;
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
