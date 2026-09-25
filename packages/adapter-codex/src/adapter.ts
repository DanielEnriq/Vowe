import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { firstLine, truncate } from '@vowe/adapter-kit';
import {
  CapabilityUnsupportedError,
  type AdapterEvent,
  type AgentAdapter,
  type AgentSession,
  type InstructionResult,
  type SessionCapabilities,
  type Unsubscribe,
} from '@vowe/core';

import { CodexRolloutNormalizer, stripHarnessContext, textOf } from './normalize.js';
import { defaultPaths, sessionIdFromFileName, type CodexPaths } from './paths.js';
import { IncrementalRolloutReader, type CodexLine } from './rollout.js';

export const PROVIDER = 'codex';

interface SessionMeta {
  file: string;
  reader: IncrementalRolloutReader;
  cwd: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  task: string | null;
  originator: string | null;
  /** Whether a turn is open, from Codex's own task lifecycle records. */
  turnOpen: boolean;
  sawAnyTurn: boolean;
  /** Whether any reasoning record in this file turned out to be readable. */
  sawReadableReasoning: boolean;
}

interface EventStream {
  reader: IncrementalRolloutReader;
  normalizer: CodexRolloutNormalizer;
  subscribers: Set<(event: AdapterEvent) => void>;
}

export interface CodexAdapterOptions {
  paths?: CodexPaths;
  recentWindowMs?: number;
  pollIntervalMs?: number;
  onError?: (scope: string, error: unknown) => void;
}

/**
 * Codex provider adapter — observation only.
 *
 * ## Why this one cannot do anything but watch
 *
 * Codex writes a complete, richly structured rollout file for every session,
 * so observation is excellent: messages, tool calls, shell commands, file
 * edits, an explicit turn lifecycle, and a real signal for when the worker is
 * asking the developer something.
 *
 * There is no control path, and this adapter says so rather than offering a
 * button that would fail. In this environment every session was produced by
 * the Codex desktop application, no `codex` executable is on PATH, and Codex
 * publishes no documented local channel for delivering a message to a session.
 * Guessing at one — writing into the rollout file, driving the app's UI —
 * would be inventing a capability.
 *
 * Reasoning is recorded but encrypted, so it is retained as raw evidence and
 * reported as unavailable. That is a different statement from "this worker did
 * not think", and the product depends on the difference.
 *
 * A provider that can only be observed is a first-class provider here. That is
 * the point of capabilities being per session rather than assumed.
 */
export class CodexAdapter implements AgentAdapter {
  readonly provider = PROVIDER;

  private readonly paths: CodexPaths;
  private readonly recentWindowMs: number;
  private readonly pollIntervalMs: number;
  private readonly meta = new Map<string, SessionMeta>();
  private readonly streams = new Map<string, EventStream>();
  private readonly onError: (scope: string, error: unknown) => void;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    this.paths = options.paths ?? defaultPaths();
    this.recentWindowMs = options.recentWindowMs ?? 2 * 24 * 60 * 60 * 1000;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.onError = options.onError ?? (() => undefined);
  }

  // --------------------------------------------------------------- discovery

  async discoverSessions(): Promise<AgentSession[]> {
    const files = await this.findRollouts();
    const sessions: AgentSession[] = [];
    for (const [sessionId, file] of files) {
      const meta = await this.pumpMeta(sessionId, file);
      sessions.push(this.toSession(sessionId, meta));
    }
    this.ensurePolling();
    return sessions;
  }

  async getSession(providerSessionId: string): Promise<AgentSession | null> {
    const existing = this.meta.get(providerSessionId);
    if (existing) {
      const meta = await this.pumpMeta(providerSessionId, existing.file);
      return this.toSession(providerSessionId, meta);
    }
    const files = await this.findRollouts();
    const file = files.get(providerSessionId);
    if (!file) return null;
    return this.toSession(providerSessionId, await this.pumpMeta(providerSessionId, file));
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
        reader: new IncrementalRolloutReader(file),
        normalizer: new CodexRolloutNormalizer({
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
    _text: string,
  ): Promise<InstructionResult> {
    throw new CapabilityUnsupportedError(
      `${PROVIDER}:${providerSessionId}`,
      'sendInstruction',
      'Codex sessions can be watched but not written to: they run under the Codex application, which exposes no local channel for delivering a message to a session',
    );
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.streams.clear();
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
      stream.reader = new IncrementalRolloutReader(known);
      stream.normalizer = new CodexRolloutNormalizer({
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

  /** sessionId -> rollout path, for rollouts touched recently. */
  private async findRollouts(): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    const cutoff = Date.now() - this.recentWindowMs;

    for await (const file of walk(this.paths.sessions)) {
      const name = path.basename(file);
      const sessionId = sessionIdFromFileName(name);
      if (!sessionId) continue;
      try {
        const info = await stat(file);
        if (info.mtimeMs < cutoff) continue;
      } catch {
        continue;
      }
      found.set(sessionId, file);
    }
    return found;
  }

  private async pumpMeta(sessionId: string, file: string): Promise<SessionMeta> {
    let meta = this.meta.get(sessionId);
    if (!meta || meta.file !== file) {
      meta = {
        file,
        reader: new IncrementalRolloutReader(file),
        cwd: null,
        createdAt: null,
        lastActivityAt: null,
        task: null,
        originator: null,
        turnOpen: false,
        sawAnyTurn: false,
        sawReadableReasoning: false,
      };
      this.meta.set(sessionId, meta);
    }
    const { lines } = await meta.reader.read();
    for (const line of lines) this.applyMeta(meta, line);
    return meta;
  }

  private applyMeta(meta: SessionMeta, line: CodexLine): void {
    const { record } = line;
    const payload = record.payload ?? {};

    if (typeof record.timestamp === 'string') {
      if (!meta.createdAt) meta.createdAt = record.timestamp;
      meta.lastActivityAt = record.timestamp;
    }
    if (record.type === 'session_meta') {
      if (typeof payload.cwd === 'string') meta.cwd = payload.cwd;
      if (typeof payload.originator === 'string') meta.originator = payload.originator;
    }
    // A turn restates the working directory, and it is the more current one.
    if (record.type === 'turn_context' && typeof payload.cwd === 'string') {
      meta.cwd = payload.cwd;
    }
    if (record.type === 'event_msg') {
      if (payload.type === 'task_started') {
        meta.turnOpen = true;
        meta.sawAnyTurn = true;
      } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
        meta.turnOpen = false;
        meta.sawAnyTurn = true;
      }
    }
    /*
     * Whether this session's reasoning is readable is a fact about the file,
     * not about the provider — see the note on `CODEX_CAPABILITIES`.
     */
    if (
      record.type === 'response_item' &&
      payload.type === 'reasoning' &&
      hasReadableSummary(payload.summary)
    ) {
      meta.sawReadableReasoning = true;
    }
    if (
      !meta.task &&
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user'
    ) {
      const text = stripHarnessContext(textOf(payload.content));
      if (text) meta.task = firstLine(text);
    }
  }

  private toSession(providerSessionId: string, meta: SessionMeta | null): AgentSession {
    const now = new Date().toISOString();
    return {
      id: `${PROVIDER}:${providerSessionId}`,
      provider: PROVIDER,
      providerSessionId,
      /*
       * Never `managed`: Vowe cannot start a Codex session, so it can only
       * ever have found this one. `external-idle` rather than `external-live`
       * because the process belongs to the Codex application and we hold no
       * handle on it.
       */
      attachMode: 'external-idle',
      task: meta?.task ?? null,
      displayLabel: labelFor(meta?.task ?? null, meta?.cwd ?? null, providerSessionId),
      cwd: meta?.cwd ?? null,
      projectId: null,
      /*
       * Codex records its own turn lifecycle, so unlike pi this is read rather
       * than guessed. Still `unknown` until a turn record has actually been
       * seen — a file we have only partly read says nothing yet.
       */
      status: meta?.sawAnyTurn ? (meta.turnOpen ? 'working' : 'waiting') : 'unknown',
      createdAt: meta?.createdAt ?? now,
      lastActivityAt: meta?.lastActivityAt ?? now,
      capabilities: {
        ...CODEX_CAPABILITIES,
        reasoning: meta?.sawReadableReasoning ?? false,
      },
      semanticState: null,
    };
  }
}

/**
 * What is true of every Codex session, whatever is in its file.
 *
 * `reasoning` is the exception and is overridden per session, because it is
 * the one answer the file decides. Codex reasoning records carry an encrypted
 * blob and *sometimes* a plaintext `summary`, and which you get varies within
 * a single session — one real session here had 16 readable records and 21
 * unreadable ones. Declaring the provider "has no reasoning" would have made
 * Vowe hide reasoning it was already holding, so the adapter reports what it
 * has actually seen rather than what the provider is supposed to do.
 */
const CODEX_CAPABILITIES: SessionCapabilities = {
  observe: true,
  sendInstruction: false,
  interrupt: false,
  resume: false,
  launch: false,
  reasoning: false,
};

/** A reasoning record is readable only if its summary carries real text. */
function hasReadableSummary(summary: unknown): boolean {
  if (typeof summary === 'string') return summary.trim().length > 0;
  if (!Array.isArray(summary)) return false;
  return summary.some((entry) =>
    typeof entry === 'string'
      ? entry.trim().length > 0
      : typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).text === 'string' &&
        ((entry as Record<string, unknown>).text as string).trim().length > 0,
  );
}

async function* walk(root: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.jsonl')) {
      yield full;
    }
  }
}

function labelFor(
  task: string | null,
  cwd: string | null,
  providerSessionId: string,
): string {
  if (task) return truncate(task, 120);
  if (cwd) return path.basename(cwd);
  return `codex session ${providerSessionId.slice(0, 8)}`;
}
