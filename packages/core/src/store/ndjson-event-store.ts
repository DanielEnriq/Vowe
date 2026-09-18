import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

import type { AdapterEvent, NormalizedEvent } from '../types/events.js';
import type { AgentSession, SemanticState } from '../types/session.js';
import type { ConversationEntry } from '../types/conversation.js';
import type { EventQuery, EventStore } from './event-store.js';

interface SessionRecords {
  events: NormalizedEvent[];
  eventsById: Map<string, NormalizedEvent>;
  /** `${source}#${byteOffset}` for every stored event, for idempotent append. */
  rawKeys: Set<string>;
  semantic: SemanticState[];
  conversation: ConversationEntry[];
  lastSeq: number;
}

function rawKey(event: AdapterEvent): string {
  return `${event.rawRef.source}#${event.rawRef.byteOffset}`;
}

/**
 * Append-only NDJSON store, rebuilt into memory at startup.
 *
 * Layout under <root>:
 *   sessions.json                       session index
 *   adapters/<provider>.json            opaque adapter state
 *   sessions/<safeId>/events.ndjson     normalized events, raw payload included
 *   sessions/<safeId>/semantic.ndjson   semantic state history
 *   sessions/<safeId>/conversation.ndjson
 *
 * Sized for an MVP: whole streams live in memory. The `EventStore` interface
 * exists so this can become SQLite when that stops being true.
 */
export class NdjsonEventStore implements EventStore {
  private readonly root: string;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly records = new Map<string, SessionRecords>();
  private readonly adapterState = new Map<string, unknown>();
  /** Serializes writes per file so concurrent appends cannot interleave. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.root, 'sessions'), { recursive: true });
    await mkdir(path.join(this.root, 'adapters'), { recursive: true });

    const index = await this.readJson<AgentSession[]>(this.indexPath());
    for (const session of index ?? []) {
      this.sessions.set(session.id, session);
      await this.loadSessionRecords(session.id);
    }
  }

  // ---------------------------------------------------------------- sessions

  async upsertSession(session: AgentSession): Promise<void> {
    this.sessions.set(session.id, session);
    this.ensureRecords(session.id);
    await this.persistIndex();
  }

  listSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  // ------------------------------------------------------------------ events

  async appendEvent(
    sessionId: string,
    event: AdapterEvent,
  ): Promise<NormalizedEvent | null> {
    const records = this.ensureRecords(sessionId);
    const key = rawKey(event);
    if (records.rawKeys.has(key)) return null;

    const normalized: NormalizedEvent = {
      ...event,
      id: randomUUID(),
      sessionId,
      seq: ++records.lastSeq,
    };
    records.events.push(normalized);
    records.eventsById.set(normalized.id, normalized);
    records.rawKeys.add(key);
    await this.appendLine(this.sessionFile(sessionId, 'events'), normalized);
    return normalized;
  }

  getEvents(sessionId: string, query: EventQuery = {}): NormalizedEvent[] {
    const all = this.records.get(sessionId)?.events ?? [];
    const filtered =
      query.sinceSeq === undefined
        ? all
        : all.filter((e) => e.seq > query.sinceSeq!);
    if (query.limit === undefined || filtered.length <= query.limit) {
      return [...filtered];
    }
    return filtered.slice(filtered.length - query.limit);
  }

  getEventsByIds(sessionId: string, ids: string[]): NormalizedEvent[] {
    const byId = this.records.get(sessionId)?.eventsById;
    if (!byId) return [];
    const out: NormalizedEvent[] = [];
    for (const id of ids) {
      const found = byId.get(id);
      if (found) out.push(found);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  lastSeq(sessionId: string): number {
    return this.records.get(sessionId)?.lastSeq ?? 0;
  }

  // ---------------------------------------------------------------- semantic

  async appendSemanticState(
    sessionId: string,
    state: SemanticState,
  ): Promise<void> {
    const records = this.ensureRecords(sessionId);
    records.semantic.push(state);
    const session = this.sessions.get(sessionId);
    if (session) {
      session.semanticState = state;
      await this.persistIndex();
    }
    await this.appendLine(this.sessionFile(sessionId, 'semantic'), state);
  }

  getSemanticHistory(sessionId: string, limit?: number): SemanticState[] {
    const all = this.records.get(sessionId)?.semantic ?? [];
    if (limit === undefined || all.length <= limit) return [...all];
    return all.slice(all.length - limit);
  }

  // ------------------------------------------------------------ conversation

  async appendConversationEntry(entry: ConversationEntry): Promise<void> {
    const records = this.ensureRecords(entry.sessionId);
    records.conversation.push(entry);
    await this.appendLine(
      this.sessionFile(entry.sessionId, 'conversation'),
      entry,
    );
  }

  getConversation(sessionId: string, limit?: number): ConversationEntry[] {
    const all = this.records.get(sessionId)?.conversation ?? [];
    if (limit === undefined || all.length <= limit) return [...all];
    return all.slice(all.length - limit);
  }

  // --------------------------------------------------------- adapter scratch

  getAdapterState(provider: string): unknown {
    return this.adapterState.get(provider) ?? null;
  }

  async setAdapterState(provider: string, state: unknown): Promise<void> {
    this.adapterState.set(provider, state);
    await this.queue(() =>
      this.writeJsonAtomic(this.adapterPath(provider), state),
    );
  }

  // ----------------------------------------------------------------- private

  private ensureRecords(sessionId: string): SessionRecords {
    let records = this.records.get(sessionId);
    if (!records) {
      records = {
        events: [],
        eventsById: new Map(),
        rawKeys: new Set(),
        semantic: [],
        conversation: [],
        lastSeq: 0,
      };
      this.records.set(sessionId, records);
    }
    return records;
  }

  private async loadSessionRecords(sessionId: string): Promise<void> {
    const records = this.ensureRecords(sessionId);

    await this.readLines(this.sessionFile(sessionId, 'events'), (value) => {
      const event = value as NormalizedEvent;
      records.events.push(event);
      records.eventsById.set(event.id, event);
      records.rawKeys.add(rawKey(event));
      if (event.seq > records.lastSeq) records.lastSeq = event.seq;
    });
    await this.readLines(this.sessionFile(sessionId, 'semantic'), (value) => {
      records.semantic.push(value as SemanticState);
    });
    await this.readLines(
      this.sessionFile(sessionId, 'conversation'),
      (value) => {
        records.conversation.push(value as ConversationEntry);
      },
    );

    const provider = this.sessions.get(sessionId)?.provider;
    if (provider && !this.adapterState.has(provider)) {
      const state = await this.readJson<unknown>(this.adapterPath(provider));
      if (state !== null) this.adapterState.set(provider, state);
    }
  }

  private indexPath(): string {
    return path.join(this.root, 'sessions.json');
  }

  private adapterPath(provider: string): string {
    return path.join(this.root, 'adapters', `${safeName(provider)}.json`);
  }

  private sessionFile(
    sessionId: string,
    kind: 'events' | 'semantic' | 'conversation',
  ): string {
    return path.join(
      this.root,
      'sessions',
      safeName(sessionId),
      `${kind}.ndjson`,
    );
  }

  private async persistIndex(): Promise<void> {
    await this.queue(() =>
      this.writeJsonAtomic(this.indexPath(), [...this.sessions.values()]),
    );
  }

  private async appendLine(file: string, value: unknown): Promise<void> {
    await this.queue(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
    });
  }

  /** All disk writes run in order; a failure never breaks the chain. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(work, work);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async writeJsonAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file);
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** Tolerates a truncated final line from an interrupted write. */
  private async readLines(
    file: string,
    onValue: (value: unknown) => void,
  ): Promise<void> {
    try {
      const reader = createInterface({
        input: createReadStream(file, 'utf8'),
        crlfDelay: Infinity,
      });
      for await (const line of reader) {
        if (!line.trim()) continue;
        try {
          onValue(JSON.parse(line));
        } catch {
          // Partial trailing line; ignore.
        }
      }
    } catch {
      // No file yet.
    }
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}
