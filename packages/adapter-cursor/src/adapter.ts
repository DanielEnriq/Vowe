import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { jsonlEvidenceSource } from '@vowe/adapter-kit';
import {
  CapabilityUnsupportedError,
  type AgentAdapter,
  type AgentSession,
  type AdapterEvent,
  type EvidenceSource,
  type EvidenceBatch,
  type EvidenceSubscription,
} from '@vowe/core';
import { defaultCaptureDir } from './collector.js';
import { CursorTranscriptNormalizer, hookRecord, type CursorPayload } from './normalize.js';

/** What discovery needs from a receipt. Payloads are read only when delivered. */
interface Receipt {
  id: string;
  receivedAt: string;
  file: string;
  payload: Pick<
    CursorPayload,
    'conversation_id' | 'parent_conversation_id' | 'hook_event_name' | 'workspace_roots' | 'transcript_path'
  > & { text?: string };
}
export interface CursorAdapterOptions {
  captureDir?: string;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

/** Deliveries may be published slightly out of receipt order; resume a little early. */
const REDELIVERY_WINDOW_MS = 60_000;
const DELIVERY_BATCH = 500;

export class CursorAdapter implements AgentAdapter {
  readonly provider = 'cursor';
  private receipts: Receipt[] = [];
  /** Receipt files are immutable once published, so each is read once. */
  private readonly indexed = new Map<string, Receipt | null>();
  private stops = new Set<() => void>();
  private root: string;
  private available = false;
  constructor(private options: CursorAdapterOptions = {}) {
    this.root = options.captureDir ?? defaultCaptureDir();
  }

  private async refresh() {
    let files: string[];
    try {
      files = await readdir(this.root);
      this.available = true;
    } catch (error) {
      this.available = false;
      this.receipts = [];
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onError?.(error);
      return;
    }
    const present = new Set(files.filter((f) => f.endsWith('.json')));
    for (const name of this.indexed.keys()) if (!present.has(name)) this.indexed.delete(name);
    for (const name of present) {
      if (this.indexed.has(name)) continue;
      try {
        const file = path.join(this.root, name);
        const r = JSON.parse(await readFile(file, 'utf8')) as {
          id?: unknown;
          receivedAt?: unknown;
          payload?: CursorPayload;
        };
        const p = r.payload;
        this.indexed.set(
          name,
          typeof r.id === 'string' && typeof r.receivedAt === 'string' && typeof p?.conversation_id === 'string'
            ? {
                id: r.id,
                receivedAt: r.receivedAt,
                file,
                payload: {
                  conversation_id: p.conversation_id,
                  parent_conversation_id: p.parent_conversation_id,
                  hook_event_name: p.hook_event_name,
                  workspace_roots: p.workspace_roots,
                  transcript_path: p.transcript_path,
                  ...(p.hook_event_name === 'afterAgentThought' && typeof p.text === 'string'
                    ? { text: p.text.trim() ? 'present' : '' }
                    : {}),
                },
              }
            : null,
        );
      } catch (error) {
        this.options.onError?.(error);
      }
    }
    this.receipts = [...this.indexed.values()]
      .filter((r): r is Receipt => r !== null)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  }
  private roots(): string[] {
    // A bare child ID is insufficient to create a user-facing session.
    return [
      ...new Set(
        this.receipts
          .filter(
            (r) =>
              ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt'].includes(
                String(r.payload.hook_event_name),
              ) && !r.payload.parent_conversation_id,
          )
          .map((r) => String(r.payload.conversation_id)),
      ),
    ];
  }
  private forSession(id: string) {
    return this.receipts.filter(
      (r) => r.payload.conversation_id === id || r.payload.parent_conversation_id === id,
    );
  }
  async discoverSessions(): Promise<AgentSession[]> {
    await this.refresh();
    return this.roots().map((id) => this.session(id));
  }
  async getSession(id: string) {
    await this.refresh();
    return this.roots().includes(id) ? this.session(id) : null;
  }
  private session(id: string): AgentSession {
    const receipts = this.forSession(id),
      first = receipts[0]!,
      last = receipts.at(-1)!;
    const roots = receipts.filter(r=>r.payload.conversation_id===id && Array.isArray(r.payload.workspace_roots)).at(-1)?.payload.workspace_roots;
    const cwd =
      Array.isArray(roots) && roots.length === 1 && typeof roots[0] === 'string' ? roots[0] : null;
    return {
      id: `cursor:${id}`,
      provider: 'cursor',
      providerSessionId: id,
      attachMode: 'external-idle',
      task: null,
      displayLabel: cwd ? path.basename(cwd) : `Cursor ${id.slice(0, 8)}`,
      cwd,
      projectId: null,
      status: 'unknown',
      createdAt: first.receivedAt,
      lastActivityAt: last.receivedAt,
      semanticState: null,
      capabilities: {
        observe: true,
        reasoning: receipts.some(
          (r) =>
            r.payload.hook_event_name === 'afterAgentThought' &&
            typeof r.payload.text === 'string' &&
            r.payload.text.trim().length > 0,
        ),
        sendInstruction: false,
        interrupt: false,
        resume: false,
        launch: false,
      },
    };
  }
  evidenceSources(id: string): EvidenceSource[] {
    const coverage = () => ({
      scope: 'delivered hooks',
      status: this.available ? ('partial' as const) : ('unavailable' as const),
      reason: this.available
        ? 'Only durably captured hook deliveries are available; omissions and earlier activity cannot be enumerated'
        : 'Hook capture directory is unavailable; previous captures remain in Vowe',
    });
    /** Receipts after `since` (minus the redelivery window) not yet delivered here. */
    const deliveries = async (since: string | undefined, delivered: Set<string>) => {
      await this.refresh();
      const from = since ? new Date(Date.parse(since) - REDELIVERY_WINDOW_MS).toISOString() : '';
      return this.forSession(id).filter((r) => r.receivedAt >= from && !delivered.has(r.id));
    };
    const batchOf = async (receipts: Receipt[], checkpoint?: string): Promise<EvidenceBatch> => {
      const records = [];
      for (const r of receipts) {
        const full = JSON.parse(await readFile(r.file, 'utf8')) as { payload: CursorPayload; raw?: unknown };
        const record = hookRecord(full.payload, r.id, r.file, r.receivedAt, `cursor:${id}`);
        records.push(typeof full.raw === 'string' ? { ...record, text: full.raw } : record);
      }
      return {
        sourceId: 'hooks',
        captureId: randomUUID(),
        observedAt: new Date().toISOString(),
        mode: 'delta',
        normalizer: 'cursor-hooks@1',
        records,
        coverage: coverage(),
        ...(checkpoint === undefined ? {} : { checkpoint }),
      };
    };
    const run = (
      since: string | undefined,
      accept: (batch: EvidenceBatch) => Promise<void>,
      subscription: EvidenceSubscription = {},
      recent: string[] = [],
    ) => {
      let stopped = false,
        timer: NodeJS.Timeout | undefined,
        through = since,
        reported: boolean | undefined;
      const delivered = new Set<string>(recent);
      const pump = async () => {
        try {
          const pending = await deliveries(through, delivered);
          if (!this.available && reported !== false) {
            // Loss of the capture directory is recorded once, not per poll.
            if (!stopped) await accept({ ...(await batchOf([])), mode: 'delta' });
            reported = false;
          } else if (this.available) reported = true;
          for (let i = 0; i < pending.length && !stopped; i += DELIVERY_BATCH) {
            const release = await (subscription.turn?.() ?? Promise.resolve(() => undefined));
            try {
              const chunk = pending.slice(i, i + DELIVERY_BATCH);
              const last = chunk.at(-1)!.receivedAt;
              const next = through && through > last ? through : last;
              // Deliveries already admitted inside the redelivery window are
              // named, so a restart resumes without re-sending them.
              const window = new Date(Date.parse(next) - REDELIVERY_WINDOW_MS).toISOString();
              const recentIds = this.forSession(id)
                .filter((r) => r.receivedAt >= window && (delivered.has(r.id) || chunk.includes(r)))
                .map((r) => r.id);
              await accept(await batchOf(chunk, JSON.stringify({ v: 1, through: next, recent: recentIds })));
              for (const r of chunk) delivered.add(r.id);
              through = next;
            } finally {
              release();
            }
          }
          if (!stopped) subscription.idle?.();
        } catch (error) {
          this.options.onError?.(error);
        } finally {
          if (!stopped) {
            timer = setTimeout(() => void pump(), this.options.pollMs ?? 750);
            timer.unref?.();
          }
        }
      };
      void pump();
      const stop = () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        this.stops.delete(stop);
      };
      this.stops.add(stop);
      return stop;
    };
    const source: EvidenceSource = {
      id: 'hooks',
      continuity: 'delivery-cursor',
      read: async () => batchOf(await deliveries(undefined, new Set())),
      subscribe: (accept, subscription) => run(undefined, accept, subscription),
      resumeAfter: (checkpoint, accept, subscription) => {
        let through: string | undefined;
        let recent: string[] = [];
        try {
          const value = JSON.parse(checkpoint) as { v?: number; through?: unknown; recent?: unknown };
          if (value.v === 1 && typeof value.through === 'string') {
            through = value.through;
            if (Array.isArray(value.recent)) recent = value.recent.filter((r) => typeof r === 'string');
          }
        } catch {
          // Unknown checkpoint form: deliver everything; redelivery is harmless.
        }
        return run(through, accept, subscription, recent);
      },
    };
    // Bind late transcript paths through the getter, so a null initial path does not lose catch-up.
    const transcript = jsonlEvidenceSource({
      id: 'conversation-transcript',
      // Cursor rewrites its transcript, so each change is reconciled whole.
      continuity: 'mutable-snapshot',
      file: () => {
        const paths = this.forSession(id).filter(
          (r) => r.payload.conversation_id === id && typeof r.payload.transcript_path === 'string',
        );
        return String(paths.at(-1)?.payload.transcript_path ?? '');
      },
      normalizer: (source) => new CursorTranscriptNormalizer({ sessionId: `cursor:${id}`, source }),
      pollMs: this.options.pollMs ?? 750,
      onError: this.options.onError,
    });
    const tracked =
      <A extends unknown[]>(start: (...args: A) => () => void) =>
      (...args: A) => {
        const unsubscribe = start(...args);
        const stop = () => {
          unsubscribe();
          this.stops.delete(stop);
        };
        this.stops.add(stop);
        return stop;
      };
    return [
      source,
      { ...transcript, subscribe: tracked(transcript.subscribe!), resumeAfter: tracked(transcript.resumeAfter!) },
    ];
  }
  subscribeToEvents(id: string, onEvent: (event: AdapterEvent) => void) {
    // Compatibility only. Production registry consumes acknowledged evidence sources.
    const stops = this.evidenceSources(id).map(
      (s) =>
        s.subscribe?.(async (b) => {
          for (const r of b.records) for (const c of r.events) onEvent(c.event);
        }) ?? (() => undefined),
    );
    return () => stops.forEach((stop) => stop());
  }
  async sendInstruction(id: string, _text: string): Promise<never> {
    throw new CapabilityUnsupportedError(
      `cursor:${id}`,
      'sendInstruction',
      'Cursor is an observation-only provider',
    );
  }
  async dispose() {
    for (const stop of this.stops) stop();
  }
}
