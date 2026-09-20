import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { formatRef, parseRef, type ContextRef } from '../context/refs.js';
import type {
  ProjectKnowledgeHit,
  ProjectMemoryMirror,
  ProjectMemoryRecord,
  SourceLocation,
} from './project-knowledge.js';

export interface ProjectMemoryStoreOptions {
  /** `<storeRoot>/projects/<safeId>` — handed over by the store. */
  dataDirFor: (projectId: string) => string;
  /**
   * An optional second home for these records, kept in step for whatever else
   * reads it. Never read back, and never allowed to fail a write.
   */
  mirror?: ProjectMemoryMirror;
  /** Reflect after this many new records. Corrections always reflect at once. */
  reflectEvery?: number;
  onError?: (scope: string, error: unknown) => void;
}

const DEFAULT_REFLECT_EVERY = 3;

/**
 * What Vowe has learned about a repository. **Vowe owns this.**
 *
 * The distinction from the code graph is the point of the whole design. The
 * graph records what the repository *contains*, and a tool outside Vowe builds
 * it. This records what Vowe *worked out*, and nothing outside Vowe is needed to
 * keep it or to read it back. Disable the indexer tomorrow and everything here
 * still answers: only graph-shaped retrieval goes away.
 *
 * That is also why the file sits beside `knowledge/graphify-out/` rather than
 * inside it. Deleting that directory to force a rebuild — or dropping the
 * indexer entirely — must not throw away the understanding.
 *
 * Append-only NDJSON, the same idiom as every other Vowe store file: a
 * correction is a new record that supersedes an old one, never an edit. What
 * Vowe believed in March is part of the record of how it came to believe what it
 * believes now.
 */
export class ProjectMemoryStore {
  private readonly dataDirFor: (projectId: string) => string;
  private readonly mirror: ProjectMemoryMirror | null;
  private readonly reflectEvery: number;
  private readonly onError: (scope: string, error: unknown) => void;

  private readonly loaded = new Map<string, Promise<ProjectMemoryRecord[]>>();
  private readonly records = new Map<string, ProjectMemoryRecord[]>();
  private readonly sinceReflect = new Map<string, number>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: ProjectMemoryStoreOptions) {
    this.dataDirFor = options.dataDirFor;
    this.mirror = options.mirror ?? null;
    this.reflectEvery = options.reflectEvery ?? DEFAULT_REFLECT_EVERY;
    this.onError = options.onError ?? (() => undefined);
  }

  // ---------------------------------------------------------------- writing

  /** Record something worth keeping. Admission is decided before this. */
  async remember(input: {
    projectId: string;
    question: string;
    answer: string;
    refs: ContextRef[] | string[];
    outcome?: 'useful' | 'dead_end';
  }): Promise<ProjectMemoryRecord> {
    const refs = input.refs.map((ref) =>
      typeof ref === 'string' ? ref : formatRef(ref),
    );
    return this.append({
      id: randomUUID(),
      projectId: input.projectId,
      at: new Date().toISOString(),
      question: input.question,
      answer: input.answer,
      refs,
      nodeIds: nodeIdsFrom(refs),
      locations: locationsFrom(refs),
      outcome: input.outcome ?? 'useful',
    });
  }

  /**
   * Record that something Vowe believed was wrong.
   *
   * Corrections bypass admission entirely — somebody has told Vowe it was
   * wrong, and there is no version of "is that worth keeping?" worth asking.
   * They also reflect immediately: a correction that has not propagated leaves
   * the superseded answer standing, which is worse than never having recorded
   * either.
   */
  async correct(input: {
    projectId: string;
    correction: string;
    /** The record being replaced, when it is known. */
    supersedes?: string;
    question?: string;
    refs?: ContextRef[] | string[];
  }): Promise<ProjectMemoryRecord> {
    const previous = input.supersedes
      ? await this.get(input.projectId, input.supersedes)
      : null;
    const refs = (input.refs ?? previous?.refs ?? []).map((ref) =>
      typeof ref === 'string' ? ref : formatRef(ref),
    );
    const question = input.question ?? previous?.question ?? '';

    const record: ProjectMemoryRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      at: new Date().toISOString(),
      question,
      answer: input.correction,
      refs,
      nodeIds: nodeIdsFrom(refs),
      locations: locationsFrom(refs),
      outcome: 'corrected',
      correction: input.correction,
    };
    if (input.supersedes) record.supersedes = input.supersedes;

    const stored = await this.append(record);
    await this.reflect(input.projectId);
    return stored;
  }

  private async append(record: ProjectMemoryRecord): Promise<ProjectMemoryRecord> {
    const all = await this.load(record.projectId);
    all.push(record);

    const file = this.memoryFile(record.projectId);
    await this.queue(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    });

    // Best-effort, and after the canonical write. A mirror that throws, hangs
    // or is not there at all changes nothing about what Vowe remembers.
    if (this.mirror?.available) {
      try {
        await this.mirror.mirror(record);
      } catch (error) {
        this.onError('memory:mirror', error);
      }
    }

    const pending = (this.sinceReflect.get(record.projectId) ?? 0) + 1;
    this.sinceReflect.set(record.projectId, pending);
    if (pending >= this.reflectEvery) await this.reflect(record.projectId);

    return record;
  }

  private async reflect(projectId: string): Promise<void> {
    this.sinceReflect.set(projectId, 0);
    if (!this.mirror?.available) return;
    try {
      await this.mirror.reflect(projectId);
    } catch (error) {
      this.onError('memory:reflect', error);
    }
  }

  // ---------------------------------------------------------------- reading

  /**
   * What Vowe has learned that bears on this question.
   *
   * A correction outranks everything, and the record it replaced is suppressed
   * outright — the whole purpose of recording a correction is that the old
   * answer stops coming back.
   */
  async search(input: {
    projectId: string;
    query: string;
    limit?: number;
  }): Promise<ProjectKnowledgeHit[]> {
    const terms = tokenize(input.query);
    if (!terms.length) return [];

    const all = await this.load(input.projectId);
    const superseded = new Set(
      all.map((record) => record.supersedes).filter((id): id is string => Boolean(id)),
    );

    const scored: { score: number; record: ProjectMemoryRecord }[] = [];
    for (const record of all) {
      if (superseded.has(record.id)) continue;
      const haystack = [
        record.question,
        record.answer,
        record.correction ?? '',
        record.nodeIds.join(' '),
        record.locations.map((location) => location.path).join(' '),
      ]
        .join('\n')
        .toLowerCase();

      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      if (!score) continue;
      // A correction is the most valuable thing in here: it is the one kind of
      // record that exists because the obvious answer was wrong.
      if (record.outcome === 'corrected') score += 2;
      if (record.outcome === 'dead_end') score -= 1;
      scored.push({ score, record });
    }

    scored.sort(
      (a, b) => b.score - a.score || Date.parse(b.record.at) - Date.parse(a.record.at),
    );

    return scored.slice(0, Math.max(1, input.limit ?? 4)).map(({ record }) => ({
      id: record.id,
      label: labelFor(record),
      kind: record.outcome,
      summary: record.correction
        ? `Corrected: ${record.correction}`
        : record.answer,
      locations: record.locations,
      origin: 'memory' as const,
    }));
  }

  async get(projectId: string, recordId: string): Promise<ProjectMemoryRecord | null> {
    const all = await this.load(projectId);
    return all.find((record) => record.id === recordId) ?? null;
  }

  async list(projectId: string): Promise<ProjectMemoryRecord[]> {
    return [...(await this.load(projectId))];
  }

  // --------------------------------------------------------------- private

  private memoryFile(projectId: string): string {
    // Outside `graphify-out/` on purpose: see the class comment.
    return path.join(this.dataDirFor(projectId), 'knowledge', 'memory.ndjson');
  }

  private load(projectId: string): Promise<ProjectMemoryRecord[]> {
    let pending = this.loaded.get(projectId);
    if (!pending) {
      pending = this.readFile(projectId).then((records) => {
        this.records.set(projectId, records);
        return records;
      });
      this.loaded.set(projectId, pending);
    }
    // After the first read the in-memory array is the live one, appended in
    // place, so later callers must see it rather than the resolved snapshot.
    return pending.then(() => this.records.get(projectId) ?? []);
  }

  private async readFile(projectId: string): Promise<ProjectMemoryRecord[]> {
    const records: ProjectMemoryRecord[] = [];
    try {
      const text = await readFile(this.memoryFile(projectId), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as ProjectMemoryRecord;
          if (record && typeof record.id === 'string') records.push(record);
        } catch {
          // A truncated final line from an interrupted write. Ignore it.
        }
      }
    } catch {
      // Nothing remembered yet.
    }
    return records;
  }

  /** All writes in order; a failure never breaks the chain. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(work, work);
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}

// -------------------------------------------------------------------- helpers

function labelFor(record: ProjectMemoryRecord): string {
  const question = record.question.trim();
  if (!question) return 'Remembered';
  return question.length > 80 ? `${question.slice(0, 80)}…` : question;
}

/**
 * Graph node ids among a set of refs.
 *
 * These are what a mirror wants — it indexes by node — and they are also the
 * structural half of what made this answer worth keeping.
 */
function nodeIdsFrom(refs: string[]): string[] {
  const ids: string[] = [];
  for (const raw of refs) {
    const ref = parseRef(raw);
    if (ref?.kind === 'symbol') ids.push(ref.nodeId);
  }
  return ids;
}

function locationsFrom(refs: string[]): SourceLocation[] {
  const locations: SourceLocation[] = [];
  for (const raw of refs) {
    const ref = parseRef(raw);
    if (ref?.kind !== 'repo') continue;
    locations.push(
      ref.line === undefined ? { path: ref.path } : { path: ref.path, line: ref.line },
    );
  }
  return locations;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
}
