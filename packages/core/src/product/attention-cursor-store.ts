import path from 'node:path';

import { LocalSettingsFile } from './local-settings.js';
import type { SessionAttentionCursor } from './return-checkpoint.js';

/**
 * `<storeRoot>/attention.json` — one mark per session.
 *
 * A settings file rather than a table, on purpose. These marks are not history:
 * there is nothing worth keeping about where someone's attention used to be,
 * and losing the file costs one checkpoint rather than any record of the work.
 * Keeping it out of the database also means no migration for a feature that
 * stores a timestamp and an integer.
 */
export type SessionAttentionCursors = Record<string, SessionAttentionCursor>;

/**
 * Bounded, because sessions accumulate and this file never gets a sweep.
 *
 * Oldest marks fall off first: a session nobody has looked at since the last
 * three hundred is not one whose checkpoint anybody is waiting for.
 */
export const MAX_TRACKED_SESSIONS = 300;

export function normalizeAttentionCursors(value: unknown): SessionAttentionCursors {
  if (!value || typeof value !== 'object') return {};

  const entries: SessionAttentionCursor[] = [];
  for (const [sessionId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionId || !raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;

    const at = typeof record['lastMeaningfullyViewedAt'] === 'string'
      ? record['lastMeaningfullyViewedAt']
      : '';
    if (!Number.isFinite(Date.parse(at))) continue;

    const seq = record['lastViewedSeq'];
    entries.push({
      sessionId,
      lastMeaningfullyViewedAt: at,
      lastViewedSeq: typeof seq === 'number' && Number.isFinite(seq) ? Math.max(0, Math.trunc(seq)) : 0,
    });
  }

  entries.sort((a, b) =>
    a.lastMeaningfullyViewedAt < b.lastMeaningfullyViewedAt ? 1 : -1,
  );

  const kept: SessionAttentionCursors = {};
  for (const cursor of entries.slice(0, MAX_TRACKED_SESSIONS)) {
    kept[cursor.sessionId] = cursor;
  }
  return kept;
}

export class AttentionCursorStore {
  private readonly file: LocalSettingsFile<SessionAttentionCursors>;

  constructor(options: { root: string; onError?: (scope: string, error: unknown) => void }) {
    this.file = new LocalSettingsFile<SessionAttentionCursors>({
      file: path.join(options.root, 'attention.json'),
      normalize: normalizeAttentionCursors,
      ...(options.onError ? { onError: options.onError } : {}),
    });
  }

  async get(sessionId: string): Promise<SessionAttentionCursor | null> {
    return (await this.file.get())[sessionId] ?? null;
  }

  async all(): Promise<SessionAttentionCursors> {
    return this.file.get();
  }

  /**
   * Record that the developer has seen this session up to here.
   *
   * Monotonic: a mark never moves backwards. Two windows open on one session,
   * or a stale renderer reporting late, must not be able to make Vowe think
   * someone saw less than they did — that would resurrect a checkpoint they
   * already dismissed.
   */
  async mark(
    sessionId: string,
    viewed: { at?: string; seq: number },
  ): Promise<SessionAttentionCursor> {
    const current = await this.file.get();
    const previous = current[sessionId];
    const at = viewed.at ?? new Date().toISOString();

    const next: SessionAttentionCursor = {
      sessionId,
      lastMeaningfullyViewedAt:
        previous && previous.lastMeaningfullyViewedAt > at
          ? previous.lastMeaningfullyViewedAt
          : at,
      lastViewedSeq: Math.max(previous?.lastViewedSeq ?? 0, viewed.seq),
    };

    const stored = await this.file.set({ ...current, [sessionId]: next });
    return stored[sessionId] ?? next;
  }
}
