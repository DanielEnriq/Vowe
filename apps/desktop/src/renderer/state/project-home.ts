import type { ContextRef, ProjectBrief, ProjectMemoryRecord } from '@vowe/core';

/** Display rows only. Their original records remain the source of truth. */
export interface ProjectChange {
  id: string;
  title: string;
  text: string;
  at: string;
  ref: ContextRef | null;
  sessionId: string | null;
}

// Exact lifecycle placeholders from core's workerMilestones fallback. They
// describe motion, already visible in Current Work, rather than a development.
const ROUTINE_STARTS = new Set(['started work', 'started the test suite']);

export function projectChanges(
  brief: ProjectBrief | null,
  memories: readonly ProjectMemoryRecord[],
): ProjectChange[] {
  const sessions = [...(brief?.active ?? []), ...(brief?.recent ?? [])];
  const rows: ProjectChange[] = [];
  for (const session of sessions) {
    const update = session.latestDevelopment;
    if (!update?.text.trim() || ROUTINE_STARTS.has(update.text.trim())) continue;
    rows.push({
      id: `development:${session.sessionId}:${update.id}`,
      title: session.title,
      text: update.text,
      at: update.at,
      ref: update.refs[0] ?? null,
      sessionId: session.sessionId,
    });
  }
  const signal = brief?.latestSignal;
  if (signal?.text.trim()) {
    rows.push({
      id: `signal:${signal.sessionId}:${signal.at}`,
      title: sessions.find((session) => session.sessionId === signal.sessionId)?.title ?? 'Observed work',
      text: signal.text,
      at: signal.at,
      ref: signal.refs[0] ?? null,
      sessionId: signal.sessionId,
    });
  }
  const superseded = new Set(memories.flatMap((record) => record.supersedes ? [record.supersedes] : []));
  for (const record of memories) {
    if (record.outcome === 'dead_end' || superseded.has(record.id)) continue;
    rows.push({
      id: `memory:${record.id}`,
      title: record.question,
      text: record.correction || record.answer,
      at: record.at,
      ref: { kind: 'lesson', projectId: record.projectId, recordId: record.id },
      sessionId: null,
    });
  }
  const seen = new Set<string>();
  const seenSessions = new Set<string>();
  return rows.sort((a, b) => b.at.localeCompare(a.at)).filter((row) => {
    const key = row.text.trim().replace(/\s+/g, ' ');
    if (!key || seen.has(key) || (row.sessionId && seenSessions.has(row.sessionId))) return false;
    seen.add(key);
    if (row.sessionId) seenSessions.add(row.sessionId);
    return true;
  }).slice(0, 3);
}

/** Relative source addresses in observer records belong to this repository. */
export function projectRef(ref: ContextRef, repoRoot: string): ContextRef {
  if (ref.kind !== 'repo' || /^(?:\/|[A-Za-z]:[\\/])/.test(ref.path)) return ref;
  return { ...ref, path: `${repoRoot.replace(/\/$/, '')}/${ref.path}` };
}
