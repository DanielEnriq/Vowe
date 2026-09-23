import type {
  ContextRef,
  NormalizedEvent,
  ProjectMemoryRecord,
  WindowNote,
  WorkerMilestone,
} from '@vowe/core';

/**
 * What the `+` can open.
 *
 * Objects, not capabilities. Every entry names the thing it actually opens —
 * where the honest name is duller than a nicer one, the duller one wins, because
 * a menu item that means something other than it says is worse than a missing
 * one. Nothing here is invented: an entry whose source is absent is omitted,
 * and there are no placeholder rows for things Vowe cannot address yet.
 */
export type LauncherSection = 'current' | 'repository' | 'vowe';

export interface LauncherEntry {
  id: string;
  section: LauncherSection;
  label: string;
  /** A quiet second line, only where one is actually known. */
  detail?: string;
  ref: ContextRef;
}

export const SECTION_LABELS: Record<LauncherSection, string> = {
  current: 'Current work',
  repository: 'Repository',
  vowe: 'Vowe',
};

/** Enough to be useful, few enough that the menu stays a menu. */
const MAX_MEMORIES = 5;

export interface LauncherInput {
  sessionId: string;
  projectId: string | null;
  events: readonly NormalizedEvent[];
  milestones: readonly WorkerMilestone[];
  notes: readonly WindowNote[];
  memories: readonly ProjectMemoryRecord[];
}

export function launcherEntries(input: LauncherInput): LauncherEntry[] {
  const entries: LauncherEntry[] = [];

  /*
   * Offered whether or not the tree is dirty.
   *
   * The renderer cannot ask git, and the nearest proxy — "this worker has
   * edited something" — is a different claim that stays true after a commit
   * lands. The resolver already distinguishes an empty diff from an
   * unavailable one, so the honest move is to offer it and let the artifact
   * say "nothing has changed".
   */
  entries.push({
    id: 'current-diff',
    section: 'current',
    label: 'Current diff',
    ref: { kind: 'diff', sessionId: input.sessionId },
  });

  /*
   * A `WindowNote` is Vowe's reading of a stretch of the worker's activity,
   * not a message the worker wrote. "Latest worker update" would name an
   * object this does not open.
   */
  const note = input.notes.at(-1);
  if (note) {
    entries.push({
      id: 'latest-observed-work',
      section: 'current',
      label: 'Latest observed work',
      detail: note.summary,
      ref: { kind: 'window', sessionId: input.sessionId, windowId: note.windowId },
    });
  }

  const instruction = lastOfKind(input.events, 'user_instruction');
  if (instruction) {
    entries.push({
      id: 'latest-instruction',
      section: 'current',
      label: 'Latest instruction',
      detail: instruction.summary,
      ref: { kind: 'transcript', sessionId: input.sessionId, eventId: instruction.id },
    });
  }

  const changed = lastChangedFile(input.milestones);
  if (changed) {
    /*
     * Named for the role, with the file as the quiet line — the same shape as
     * the three above it. The other way round, a long path took the whole row
     * and faded out the one word that said why it was being offered.
     */
    entries.push({
      id: `changed:${changed.path}`,
      section: 'current',
      label: 'Last changed file',
      detail: basename(changed.path),
      ref: changed,
    });
  }

  if (input.projectId) {
    for (const record of newestMemories(input.memories)) {
      entries.push({
        id: `lesson:${record.id}`,
        section: 'vowe',
        label: record.question,
        ref: { kind: 'lesson', projectId: input.projectId, recordId: record.id },
      });
    }
  }

  return entries;
}

/**
 * The newest edit run that names one file.
 *
 * A run that touched several files records only the session's diff, so there
 * is no single file to open and the entry is omitted rather than quietly
 * degraded into a second "Current diff".
 */
function lastChangedFile(
  milestones: readonly WorkerMilestone[],
): Extract<ContextRef, { kind: 'repo' }> | null {
  for (let index = milestones.length - 1; index >= 0; index -= 1) {
    const milestone = milestones[index]!;
    if (milestone.kind !== 'edits') continue;
    const ref = milestone.refs.find((candidate) => candidate.kind === 'repo');
    if (ref) return ref;
  }
  return null;
}

function lastOfKind(
  events: readonly NormalizedEvent[],
  kind: NormalizedEvent['kind'],
): NormalizedEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === kind) return events[index]!;
  }
  return null;
}

function newestMemories(memories: readonly ProjectMemoryRecord[]): ProjectMemoryRecord[] {
  return [...memories].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_MEMORIES);
}

function basename(path: string): string {
  return path.split('/').pop() || path;
}

export interface LauncherGroup {
  section: LauncherSection;
  label: string;
  entries: LauncherEntry[];
}

/** Fixed section order. A section with nothing in it is not a section. */
const SECTION_ORDER: LauncherSection[] = ['current', 'repository', 'vowe'];

export function groupEntries(entries: readonly LauncherEntry[]): LauncherGroup[] {
  return SECTION_ORDER.map((section) => ({
    section,
    label: SECTION_LABELS[section],
    entries: entries.filter((entry) => entry.section === section),
  })).filter((group) => group.entries.length > 0);
}

export function flattenEntries(groups: readonly LauncherGroup[]): LauncherEntry[] {
  return groups.flatMap((group) => group.entries);
}

/** Matched on what the developer can see: the label, then the quiet line. */
export function filterEntries(
  entries: readonly LauncherEntry[],
  query: string,
): LauncherEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (entry) =>
      entry.label.toLowerCase().includes(needle) ||
      (entry.detail?.toLowerCase().includes(needle) ?? false),
  );
}

/**
 * The few entries the empty state shows.
 *
 * One from each section before filling the rest in order, so a repository with
 * a lot of remembered lessons does not hand back four of them and hide the
 * diff.
 */
export function quickOpen(entries: readonly LauncherEntry[], limit = 4): LauncherEntry[] {
  const groups = groupEntries(entries);
  const picked: LauncherEntry[] = [];
  for (const group of groups) {
    const first = group.entries[0];
    if (first && picked.length < limit) picked.push(first);
  }
  for (const entry of flattenEntries(groups)) {
    if (picked.length >= limit) break;
    if (!picked.includes(entry)) picked.push(entry);
  }
  return picked;
}

export function moveCursor(
  ids: readonly string[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  if (!ids.length) return null;
  const at = currentId ? ids.indexOf(currentId) : -1;
  const next = at === -1 ? (delta === 1 ? 0 : ids.length - 1) : (at + delta + ids.length) % ids.length;
  return ids[next] ?? null;
}
