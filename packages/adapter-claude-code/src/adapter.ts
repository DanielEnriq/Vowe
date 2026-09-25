import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  CapabilityUnsupportedError,
  type AdapterEvent,
  type AgentAdapter,
  type AgentSession,
  type InstructionResult,
  type LaunchOptions,
  type SessionCapabilities,
  type SessionStatus,
  type Unsubscribe,
} from '@vowe/core';

import { ControlChannel, type ControlChannelOptions } from './control.js';
import { readLiveSessions, type LiveSessionRecord } from './live-sessions.js';
import {
  TranscriptNormalizer,
  firstLine,
  stripNoise,
  textOf,
  truncate,
} from './normalize.js';
import { defaultPaths, type ClaudeCodePaths } from './paths.js';
import { IncrementalTranscriptReader, type TranscriptLine } from './transcript.js';

export const PROVIDER = 'claude-code';

/** Placeholder path for a stream attached before its transcript exists. */
const UNRESOLVED = '';

/** Session facts derived by scanning the transcript, updated incrementally. */
interface TranscriptMeta {
  file: string;
  reader: IncrementalTranscriptReader;
  cwd: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  task: string | null;
  providerTitle: string | null;
}

interface EventStream {
  reader: IncrementalTranscriptReader;
  normalizer: TranscriptNormalizer;
  subscribers: Set<(event: AdapterEvent) => void>;
}

export interface ClaudeCodeAdapterOptions extends ControlChannelOptions {
  paths?: ClaudeCodePaths;
  /** Ignore transcripts older than this. Default 2 days. */
  recentWindowMs?: number;
  /** How often to pull new transcript bytes. Default 750ms. */
  pollIntervalMs?: number;
}

/**
 * Claude Code provider adapter.
 *
 * Observation and control are deliberately separate mechanisms here, because
 * they are separate in the provider:
 *
 *  - Every session — ours, someone else's, running or finished — writes a
 *    complete transcript to disk. That is the single observation path, used
 *    identically for all three attach modes, so there is exactly one
 *    normalization pipeline to trust.
 *  - Control comes from the Agent SDK, and only reaches sessions we launched
 *    or sessions that are not currently running. Capabilities say so per
 *    session rather than the adapter pretending otherwise.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly provider = PROVIDER;

  private readonly paths: ClaudeCodePaths;
  private readonly recentWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly control: ControlChannel;
  private readonly meta = new Map<string, TranscriptMeta>();
  private readonly streams = new Map<string, EventStream>();
  private readonly live = new Map<string, LiveSessionRecord>();
  private readonly onError: (scope: string, error: unknown) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.paths = options.paths ?? defaultPaths();
    this.recentWindowMs = options.recentWindowMs ?? 2 * 24 * 60 * 60 * 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.onError = options.onError ?? (() => undefined);
    this.control = new ControlChannel({
      permissionMode: options.permissionMode,
      onError: this.onError,
    });
  }

  // --------------------------------------------------------------- discovery

  async discoverSessions(): Promise<AgentSession[]> {
    await this.refreshLiveSessions();
    const transcripts = await this.findTranscripts();

    const sessions: AgentSession[] = [];
    for (const [sessionId, file] of transcripts) {
      const meta = await this.pumpMeta(sessionId, file);
      sessions.push(this.toSession(sessionId, meta));
    }

    // A session Vowe just launched may not have a transcript on disk yet.
    for (const sessionId of this.control.managedSessionIds()) {
      if (transcripts.has(sessionId)) continue;
      sessions.push(this.toSession(sessionId, this.meta.get(sessionId) ?? null));
    }

    this.ensurePolling();
    return sessions;
  }

  async getSession(providerSessionId: string): Promise<AgentSession | null> {
    await this.refreshLiveSessions();
    const existing = this.meta.get(providerSessionId);
    if (existing) {
      const meta = await this.pumpMeta(providerSessionId, existing.file);
      return this.toSession(providerSessionId, meta);
    }
    const transcripts = await this.findTranscripts();
    const file = transcripts.get(providerSessionId);
    if (file) {
      const meta = await this.pumpMeta(providerSessionId, file);
      return this.toSession(providerSessionId, meta);
    }
    if (this.control.isManaged(providerSessionId)) {
      return this.toSession(providerSessionId, null);
    }
    return null;
  }

  // ------------------------------------------------------------- observation

  subscribeToEvents(
    providerSessionId: string,
    onEvent: (event: AdapterEvent) => void,
  ): Unsubscribe {
    let stream = this.streams.get(providerSessionId);
    if (!stream) {
      // May be unresolved for a session we just launched; `pumpStream` binds
      // the real file as soon as it can find it.
      const file = this.meta.get(providerSessionId)?.file ?? UNRESOLVED;
      stream = {
        reader: new IncrementalTranscriptReader(file),
        normalizer: new TranscriptNormalizer({
          sessionId: `${PROVIDER}:${providerSessionId}`,
          source: file,
        }),
        subscribers: new Set(),
      };
      this.streams.set(providerSessionId, stream);
    }
    stream.subscribers.add(onEvent);
    this.ensurePolling();
    // Deliver the backlog immediately so a newly attached session arrives with
    // its history, not just whatever happens next.
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

    if (this.control.sendToManaged(providerSessionId, text)) {
      return { delivered: true, via: 'agent-sdk streaming input' };
    }

    const liveRecord = this.live.get(providerSessionId);
    if (liveRecord) {
      throw new CapabilityUnsupportedError(
        voweId,
        'sendInstruction',
        `the session is running as pid ${liveRecord.pid} in a terminal Vowe does not own, and Claude Code exposes no public channel for messaging a live foreign session`,
      );
    }

    const meta = this.meta.get(providerSessionId);
    if (!meta) {
      throw new CapabilityUnsupportedError(
        voweId,
        'sendInstruction',
        'no transcript is known for this session, so it cannot be resumed',
      );
    }

    await this.control.resumeWithInstruction(providerSessionId, meta.cwd, text);
    return {
      delivered: true,
      via: 'agent-sdk resume',
      note: 'The session was not running, so it was resumed to receive this instruction.',
    };
  }

  async interrupt(providerSessionId: string): Promise<void> {
    const interrupted = await this.control.interrupt(providerSessionId);
    if (!interrupted) {
      throw new CapabilityUnsupportedError(
        `${PROVIDER}:${providerSessionId}`,
        'interrupt',
        'only sessions Vowe launched can be interrupted',
      );
    }
  }

  async launchSession(options: LaunchOptions): Promise<AgentSession> {
    const managed = await this.control.launch(options.cwd, options.prompt);
    const session = this.toSession(managed.sessionId, null);
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

    // A stream created before the transcript existed points nowhere useful.
    // Rebind it as soon as the file can be located, so a session Vowe just
    // launched is observed without waiting for the next discovery pass.
    const known =
      this.meta.get(providerSessionId)?.file ??
      (await this.locateTranscript(providerSessionId));
    if (known && known !== stream.reader.file) {
      stream.reader = new IncrementalTranscriptReader(known);
      stream.normalizer = new TranscriptNormalizer({
        sessionId: `${PROVIDER}:${providerSessionId}`,
        source: known,
      });
    }

    const { lines } = await stream.reader.read();
    if (!lines.length) return;

    for (const line of lines) {
      for (const event of stream.normalizer.normalize(line)) {
        for (const subscriber of stream.subscribers) subscriber(event);
      }
    }
  }

  /** Find one session's transcript without scanning every file's metadata. */
  private async locateTranscript(sessionId: string): Promise<string | null> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.paths.projects);
    } catch {
      return null;
    }
    for (const dir of projectDirs) {
      const file = path.join(this.paths.projects, dir, `${sessionId}.jsonl`);
      try {
        await stat(file);
        return file;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async refreshLiveSessions(): Promise<void> {
    const live = await readLiveSessions(this.paths);
    this.live.clear();
    for (const [sessionId, record] of live) this.live.set(sessionId, record);
  }

  /** sessionId -> transcript path, for transcripts touched recently. */
  private async findTranscripts(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const cutoff = Date.now() - this.recentWindowMs;

    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.paths.projects);
    } catch {
      return found;
    }

    for (const dir of projectDirs) {
      const dirPath = path.join(this.paths.projects, dir);
      let entries: string[];
      try {
        entries = await readdir(dirPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const file = path.join(dirPath, entry);
        const sessionId = entry.slice(0, -'.jsonl'.length);
        try {
          const info = await stat(file);
          const isLive = this.live.has(sessionId);
          if (!isLive && info.mtimeMs < cutoff) continue;
          found.set(sessionId, file);
        } catch {
          continue;
        }
      }
    }
    return found;
  }

  /** Read whatever is new in a transcript and fold it into the session facts. */
  private async pumpMeta(
    sessionId: string,
    file: string,
  ): Promise<TranscriptMeta> {
    let meta = this.meta.get(sessionId);
    if (!meta || meta.file !== file) {
      meta = {
        file,
        reader: new IncrementalTranscriptReader(file),
        cwd: null,
        createdAt: null,
        lastActivityAt: null,
        task: null,
        providerTitle: null,
      };
      this.meta.set(sessionId, meta);
    }

    const { lines } = await meta.reader.read();
    for (const line of lines) this.applyMeta(meta, line);
    return meta;
  }

  private applyMeta(meta: TranscriptMeta, line: TranscriptLine): void {
    const { record } = line;
    if (typeof record.cwd === 'string' && record.cwd) meta.cwd = record.cwd;
    if (typeof record.timestamp === 'string') {
      if (!meta.createdAt) meta.createdAt = record.timestamp;
      meta.lastActivityAt = record.timestamp;
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      meta.providerTitle = record.aiTitle;
    }
    if (
      !meta.task &&
      record.type === 'user' &&
      !record.isMeta &&
      !record.isSidechain
    ) {
      // Tool results are user-role records too, but they carry no text
      // blocks, so they never produce a task here.
      const text = stripNoise(textOf(record.message?.content));
      if (text) meta.task = firstLine(text);
    }
  }

  private toSession(
    providerSessionId: string,
    meta: TranscriptMeta | null,
  ): AgentSession {
    const liveRecord = this.live.get(providerSessionId);
    const isManaged = this.control.isManaged(providerSessionId);
    const attachMode = isManaged
      ? 'managed'
      : liveRecord
        ? 'external-live'
        : 'external-idle';

    const capabilities = capabilitiesFor(attachMode, meta !== null);
    const cwd = meta?.cwd ?? liveRecord?.cwd ?? this.control.getManaged(providerSessionId)?.cwd ?? null;
    const task = meta?.task ?? null;
    const now = new Date().toISOString();

    return {
      id: `${PROVIDER}:${providerSessionId}`,
      provider: PROVIDER,
      providerSessionId,
      attachMode,
      task,
      displayLabel: labelFor(task, meta?.providerTitle ?? null, liveRecord, cwd, providerSessionId),
      cwd,
      // Adapters report where a session is, not what that means. The project
      // layer derives the repository from `cwd` and fills this in.
      projectId: null,
      status: statusFor(attachMode, liveRecord),
      createdAt:
        meta?.createdAt ??
        (liveRecord?.startedAt ? new Date(liveRecord.startedAt).toISOString() : now),
      lastActivityAt: meta?.lastActivityAt ?? now,
      capabilities,
      semanticState: null,
    };
  }
}

/**
 * The most useful short name we can justify from evidence.
 *
 * The developer's own opening words win, unless they are a wall of text and
 * the provider has already titled the session — a long prompt makes a poor
 * list row.
 */
function labelFor(
  task: string | null,
  providerTitle: string | null,
  liveRecord: LiveSessionRecord | undefined,
  cwd: string | null,
  providerSessionId: string,
): string {
  if (task && (task.length <= 90 || !providerTitle)) return truncate(task, 120);
  if (providerTitle) return providerTitle;
  if (liveRecord?.name) return liveRecord.name;
  if (cwd) return path.basename(cwd);
  return `claude-code session ${providerSessionId.slice(0, 8)}`;
}

function capabilitiesFor(
  attachMode: AgentSession['attachMode'],
  hasTranscript: boolean,
): SessionCapabilities {
  /**
   * Constant across attach modes, and true of the provider rather than of one
   * session: the Agent SDK is a dependency of this package, so launching
   * always works wherever Vowe itself runs.
   */
  const launch = true;
  /**
   * Claude Code records thinking blocks, and this adapter deliberately does
   * not carry them (see `normalize.ts`). From the product's side that is
   * indistinguishable from a provider that records nothing, and it should be:
   * either way a surface must not claim the worker did not think.
   */
  const reasoning = false;

  switch (attachMode) {
    case 'managed':
      return {
        observe: true,
        sendInstruction: true,
        interrupt: true,
        resume: true,
        launch,
        reasoning,
      };
    case 'external-live':
      // Observable in full, but Claude Code offers no public way to message a
      // session running under a process we do not own.
      return {
        observe: true,
        sendInstruction: false,
        interrupt: false,
        resume: false,
        launch,
        reasoning,
      };
    case 'external-idle':
      return {
        observe: true,
        sendInstruction: hasTranscript,
        interrupt: false,
        resume: hasTranscript,
        launch,
        reasoning,
      };
  }
}

function statusFor(
  attachMode: AgentSession['attachMode'],
  liveRecord: LiveSessionRecord | undefined,
): SessionStatus {
  if (liveRecord) {
    if (liveRecord.status === 'busy') return 'working';
    if (liveRecord.status === 'idle') return 'waiting';
    return 'unknown';
  }
  return attachMode === 'managed' ? 'working' : 'idle';
}
