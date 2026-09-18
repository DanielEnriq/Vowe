import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { ClaudeCodePaths } from './paths.js';

/**
 * A record Claude Code writes for each running session process.
 * Only the fields we rely on are typed; the file carries more.
 */
export interface LiveSessionRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt?: number;
  /** Process start time, used to detect a recycled pid. */
  procStart?: string;
  /** Display name the CLI derived or the user set. */
  name?: string;
  kind?: string;
  status?: string;
  statusUpdatedAt?: number;
}

/**
 * Read the live-session registry.
 *
 * A record only means a session *was* running: the process may have died
 * without cleaning up. We verify the pid is still alive before trusting it,
 * because treating a dead session as live would wrongly deny the developer
 * the ability to send it an instruction.
 */
export async function readLiveSessions(
  paths: ClaudeCodePaths,
): Promise<Map<string, LiveSessionRecord>> {
  const bySessionId = new Map<string, LiveSessionRecord>();
  let entries: string[];
  try {
    entries = await readdir(paths.liveSessions);
  } catch {
    return bySessionId;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    let record: LiveSessionRecord;
    try {
      record = JSON.parse(
        await readFile(path.join(paths.liveSessions, entry), 'utf8'),
      ) as LiveSessionRecord;
    } catch {
      continue;
    }
    if (!record.sessionId || !record.pid) continue;
    if (!isProcessAlive(record.pid)) continue;

    const existing = bySessionId.get(record.sessionId);
    if (!existing || (record.statusUpdatedAt ?? 0) > (existing.statusUpdatedAt ?? 0)) {
      bySessionId.set(record.sessionId, record);
    }
  }
  return bySessionId;
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
