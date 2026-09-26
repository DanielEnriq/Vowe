import { jsonlEvidenceSource } from '@vowe/adapter-kit';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { firstLine, truncate } from '@vowe/adapter-kit';
import {
  CapabilityUnsupportedError,
  type AdapterEvent,
  type AgentAdapter,
  type AgentSession,
  type InstructionResult,
  type LaunchOptions,
  type SessionCapabilities,
  type Unsubscribe,
} from '@vowe/core';

import { PiControlChannel, type PiControlOptions } from './control.js';
import { PiSessionNormalizer, textOf } from './normalize.js';
import { decodeCwd, defaultPaths, encodeCwd, type PiPaths } from './paths.js';
import { IncrementalPiSessionReader, type PiLine } from './session-file.js';

export const PROVIDER = 'pi';

interface SessionMeta {
  file: string;
  dir: string;
  reader: IncrementalPiSessionReader;
  cwd: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  task: string | null;
  providerName: string | null;
}

interface EventStream {
  reader: IncrementalPiSessionReader;
  normalizer: PiSessionNormalizer;
  subscribers: Set<(event: AdapterEvent) => void>;
}

export interface PiAdapterOptions extends PiControlOptions {
  paths?: PiPaths;
  /** Ignore sessions older than this. Default 2 days. */
  recentWindowMs?: number;
  /** How often to pull new session-file bytes. Default 750ms. */
  pollIntervalMs?: number;
}

/**
 * pi provider adapter.
 *
 * ## What this adapter can and cannot know
 *
 * Observation is complete: every pi session writes a full JSONL history to a
 * documented location, so history, tool calls, commands, file edits and the
 * worker's plaintext reasoning are all available for any session, however it
 * was started.
 *
 * Liveness is *not* available, and this adapter does not pretend otherwise.
 * pi writes no lock file, pid file or socket that would say whether a
 * discovered session is currently running — verified against an installed
 * 0.85.1 — so a session Vowe did not start reports `unknown` rather than a
 * status inferred from how recently its file was touched. A quiet file means a
 * quiet file: it could be a finished session, or a worker thinking hard. Those
 * are different, and guessing between them would put a confident wrong answer
 * in front of someone who trusts it.
 */
export class PiAdapter implements AgentAdapter {
  readonly provider = PROVIDER;

  private readonly paths: PiPaths;
  private readonly recentWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly control: PiControlChannel;
  private readonly meta = new Map<string, SessionMeta>();
  private readonly streams = new Map<string, EventStream>();
  private readonly onError: (scope: string, error: unknown) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: PiAdapterOptions = {}) {
    this.paths = options.paths ?? defaultPaths();
    this.recentWindowMs = options.recentWindowMs ?? 2 * 24 * 60 * 60 * 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.onError = options.onError ?? (() => undefined);
    this.control = new PiControlChannel({
      // Forwarded whenever the caller supplied the key at all, including as
      // an empty string, which is how a caller says "treat it as missing".
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      onError: this.onError,
    });
  }

  canLaunch(): boolean {
    return this.control.available;
  }

  // --------------------------------------------------------------- discovery

  async discoverSessions(): Promise<AgentSession[]> {
    const files = await this.findSessionFiles();
    const sessions: AgentSession[] = [];
    for (const [sessionId, located] of files) {
      const meta = await this.pumpMeta(sessionId, located.file, located.dir);
      sessions.push(this.toSession(sessionId, meta));
    }
    this.ensurePolling();
    return sessions;
  }

  async getSession(providerSessionId: string): Promise<AgentSession | null> {
    const existing = this.meta.get(providerSessionId);
    if (existing) {
      const meta = await this.pumpMeta(providerSessionId, existing.file, existing.dir);
      return this.toSession(providerSessionId, meta);
    }
    const files = await this.findSessionFiles();
    const located = files.get(providerSessionId);
    if (!located) return null;
    const meta = await this.pumpMeta(providerSessionId, located.file, located.dir);
    return this.toSession(providerSessionId, meta);
  }

  evidenceSources(providerSessionId: string) {
    return [jsonlEvidenceSource({
      id: 'conversation-log',
      // The provider only appends to a session log, so catching up reads new bytes.
      continuity: 'append-log',
      // This normalizer emits completions from the provider's canonical tool
      // result records. Preserve that interpretation explicitly on migration.
      interpret: event => ['command_finished','test_finished'].includes(event.kind) ? {execution:'executed'} : {},
      file: () => this.meta.get(providerSessionId)?.file ?? '',
      normalizer: (source) => new PiSessionNormalizer({sessionId: `${PROVIDER}:${providerSessionId}`,source}),
      recordKey: (record) => typeof record.id === 'string' ? record.id as string : undefined,
      pollMs: this.pollIntervalMs,
      onError: (error) => this.onError(`evidence:${providerSessionId}`,error),
    })];
  }

  // ------------------------------------------------------------- observation

  subscribeToEvents(
    providerSessionId: string,
    onEvent: (event: AdapterEvent) => void,
  ): Unsubscribe {
    let stream = this.streams.get(providerSessionId);
    if (!stream) {
      const file = this.meta.get(providerSessionId)?.file ?? '';
      stream = {
        reader: new IncrementalPiSessionReader(file),
        normalizer: new PiSessionNormalizer({
          sessionId: `${PROVIDER}:${providerSessionId}`,
          source: file,
        }),
        subscribers: new Set(),
      };
      this.streams.set(providerSessionId, stream);
    }
    stream.subscribers.add(onEvent);
    this.ensurePolling();
    void this.pumpStream(providerSessionId).catch((error) =>
      this.onError(`pump:${providerSessionId}`, error),
    );

    return () => {
      const current = this.streams.get(providerSessionId);
      if (!current) return;
      current.subscribers.delete(onEvent);
      if (current.subscribers.size === 0) this.streams.delete(providerSessionId);
    };
  }

  // ----------------------------------------------------------------- control

  async sendInstruction(
    providerSessionId: string,
    text: string,
  ): Promise<InstructionResult> {
    const voweId = `${PROVIDER}:${providerSessionId}`;

    if (!this.control.available) {
      throw new CapabilityUnsupportedError(
        voweId,
        'sendInstruction',
        'the pi command-line tool was not found on this machine, so there is no way to reach this session',
      );
    }

    const meta = this.meta.get(providerSessionId);
    if (!meta?.cwd) {
      throw new CapabilityUnsupportedError(
        voweId,
        'sendInstruction',
        'no session file is known for this session, so it cannot be resumed',
      );
    }

    this.control.run(providerSessionId, meta.cwd, this.paths.sessions, text);

    return {
      delivered: true,
      via: 'pi --session-id --print',
      /*
       * Said plainly rather than hidden, because it is the one thing about
       * this path a person could be surprised by. pi exposes no way to tell
       * whether a session is already open somewhere, so this resumes it either
       * way, and two writers on one session file would branch its history.
       */
      note: 'The session was resumed to receive this instruction. Vowe cannot tell whether pi already has this session open elsewhere; if it does, the session will branch.',
    };
  }

  async interrupt(providerSessionId: string): Promise<void> {
    if (!this.control.interrupt(providerSessionId)) {
      throw new CapabilityUnsupportedError(
        `${PROVIDER}:${providerSessionId}`,
        'interrupt',
        'only sessions Vowe started can be interrupted',
      );
    }
  }

  async launchSession(options: LaunchOptions): Promise<AgentSession> {
    if (!this.control.available) {
      throw new CapabilityUnsupportedError(
        PROVIDER,
        'launchSession',
        'the pi command-line tool was not found on this machine',
      );
    }
    const sessionId = randomUUID();
    this.control.run(sessionId, options.cwd, this.paths.sessions, options.prompt);

    const session = this.toSession(sessionId, null);
    return {
      ...session,
      cwd: options.cwd,
      task: firstLine(options.prompt),
      displayLabel: firstLine(options.prompt),
      status: 'starting',
    };
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.streams.clear();
    await this.control.dispose();
  }

  // ----------------------------------------------------------------- private

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pumpAllStreams();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  private async pumpAllStreams(): Promise<void> {
    for (const sessionId of [...this.streams.keys()]) {
      try {
        await this.pumpStream(sessionId);
      } catch (error) {
        this.onError(`pump:${sessionId}`, error);
      }
    }
  }

  private async pumpStream(providerSessionId: string): Promise<void> {
    const stream = this.streams.get(providerSessionId);
    if (!stream) return;

    const known = this.meta.get(providerSessionId)?.file ?? null;
    if (known && known !== stream.reader.file) {
      stream.reader = new IncrementalPiSessionReader(known);
      stream.normalizer = new PiSessionNormalizer({
        sessionId: `${PROVIDER}:${providerSessionId}`,
        source: known,
      });
    }

    const { lines } = await stream.reader.read();
    for (const line of lines) {
      for (const event of stream.normalizer.normalize(line)) {
        for (const subscriber of stream.subscribers) subscriber(event);
      }
    }
  }

  /** sessionId -> its file, for sessions touched recently. */
  private async findSessionFiles(): Promise<
    Map<string, { file: string; dir: string }>
  > {
    const found = new Map<string, { file: string; dir: string }>();
    const cutoff = Date.now() - this.recentWindowMs;

    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.paths.sessions);
    } catch {
      return found;
    }

    for (const dir of projectDirs) {
      const dirPath = path.join(this.paths.sessions, dir);
      let entries: string[];
      try {
        entries = await readdir(dirPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const file = path.join(dirPath, entry);
        try {
          const info = await stat(file);
          if (info.mtimeMs < cutoff) continue;
        } catch {
          continue;
        }
        // The header carries the authoritative id; the file name is only a
        // hint, so the id is settled when the header is read in `pumpMeta`.
        const meta = await this.pumpMeta(entry, file, dir);
        const sessionId = meta.providerName ?? entry;
        found.set(sessionId, { file, dir });
      }
    }
    return found;
  }

  private async pumpMeta(
    key: string,
    file: string,
    dir: string,
  ): Promise<SessionMeta> {
    let meta = this.meta.get(key);
    if (!meta || meta.file !== file) {
      meta = {
        file,
        dir,
        reader: new IncrementalPiSessionReader(file),
        cwd: decodeCwd(dir),
        createdAt: null,
        lastActivityAt: null,
        task: null,
        providerName: null,
      };
      this.meta.set(key, meta);
    }

    // Streamed: metadata needs a few fields, never the whole history at once.
    for await (const line of meta.reader.drain()) this.applyMeta(meta, line);

    // Once the header names the session, file it under that id too, so a
    // later lookup by session id finds the same cursor rather than restarting.
    if (meta.providerName && !this.meta.has(meta.providerName)) {
      this.meta.set(meta.providerName, meta);
    }
    return meta;
  }

  private applyMeta(meta: SessionMeta, line: PiLine): void {
    const { record } = line;
    if (record.type === 'session') {
      if (typeof record.id === 'string') meta.providerName = record.id;
      // The header's own cwd beats the one decoded from the directory name,
      // which cannot tell a path separator from a literal dash.
      if (typeof record.cwd === 'string' && record.cwd) meta.cwd = record.cwd;
    }
    if (typeof record.timestamp === 'string') {
      if (!meta.createdAt) meta.createdAt = record.timestamp;
      meta.lastActivityAt = record.timestamp;
    }
    if (!meta.task && record.type === 'message' && record.message?.role === 'user') {
      const text = textOf(record.message.content).trim();
      if (text) meta.task = firstLine(text);
    }
  }

  private toSession(
    providerSessionId: string,
    meta: SessionMeta | null,
  ): AgentSession {
    const isManaged = this.control.isManaged(providerSessionId);
    const attachMode = isManaged ? 'managed' : 'external-idle';
    const cwd = meta?.cwd ?? this.control.getManaged(providerSessionId)?.cwd ?? null;
    const task = meta?.task ?? null;
    const now = new Date().toISOString();

    return {
      id: `${PROVIDER}:${providerSessionId}`,
      provider: PROVIDER,
      providerSessionId,
      attachMode,
      task,
      displayLabel: labelFor(task, cwd, providerSessionId),
      cwd,
      projectId: null,
      /*
       * A session Vowe started is working, because Vowe is holding the
       * process. Anything else is `unknown`, and deliberately so: pi publishes
       * no liveness artifact, so there is nothing here to read. Idleness
       * inferred from file recency would be a guess wearing the clothes of an
       * observation.
       */
      status: isManaged ? 'working' : 'unknown',
      createdAt: meta?.createdAt ?? now,
      lastActivityAt: meta?.lastActivityAt ?? now,
      capabilities: this.capabilitiesFor(attachMode, meta !== null),
      semanticState: null,
    };
  }

  private capabilitiesFor(
    attachMode: AgentSession['attachMode'],
    hasSessionFile: boolean,
  ): SessionCapabilities {
    const cli = this.control.available;
    return {
      // The session file is on disk either way, so history always reads.
      observe: true,
      // pi records thinking as plain text, so this is one of the few
      // providers where the worker's reasoning is genuinely ours to show.
      reasoning: true,
      // Every control affordance needs the CLI. None of them is a property of
      // the session alone.
      sendInstruction: cli && hasSessionFile,
      resume: cli && hasSessionFile,
      launch: cli,
      interrupt: cli && attachMode === 'managed',
    };
  }
}

function labelFor(
  task: string | null,
  cwd: string | null,
  providerSessionId: string,
): string {
  if (task) return truncate(task, 120);
  if (cwd) return path.basename(cwd);
  return `pi session ${providerSessionId.slice(0, 8)}`;
}

export { encodeCwd };
