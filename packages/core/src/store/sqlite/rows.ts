import { formatRef, parseRef, type ContextRef } from '../../context/refs.js';
import type {
  ConversationDelivery,
  ConversationEntry,
  ProjectConversationEntry,
  DeliveryModality,
  DeliveryStatus,
} from '../../types/conversation.js';
import type { NormalizedEvent } from '../../types/events.js';
import type {
  ModelUsage,
  VoweRun,
  VoweTraceItem,
} from '../../types/execution.js';
import type {
  PersistedWorkbench,
  PersistedWorkbenchTab,
} from '../../workbench/persisted.js';
import type {
  AgentSession,
  MeaningfulUpdate,
  SemanticProvenance,
  SemanticState,
  SessionCapabilities,
} from '../../types/session.js';
import type { Project } from '../../projects/project.js';
import type {
  CommunicationDecision,
  ObservationState,
  SurfaceUpdate,
  TraceWindow,
  WindowNote,
} from '../../observation/trace-window.js';

/**
 * Row ⇄ domain mapping, in one file, by hand.
 *
 * There is no generic mapper here on purpose. SQL `NULL` means two different
 * things in this schema and only a human reading the domain type knows which:
 *
 *   `Project.remoteUrl?: string`        NULL  =>  the key must be ABSENT
 *   `AgentSession.cwd: string | null`   NULL  =>  the key must be PRESENT, null
 *
 * Tests pin the difference — `project-service.test.ts` asserts the exact key
 * list of a stored project, and an old conversation entry must come back with
 * no `investigation` key at all rather than one set to undefined. A clever
 * generic mapper would collapse the two cases and quietly break both, so the
 * two shapes are written differently here and are meant to look different.
 */

/** A row as `node:sqlite` hands it back: null-prototype, NULL reads as null. */
export type Row = Record<string, unknown>;

// ------------------------------------------------------------------- binding

/**
 * `undefined` is not bindable — `node:sqlite` throws rather than treating it as
 * NULL — and neither is `boolean`. Every optional domain field goes through one
 * of these on its way into a statement, and none is ever bound raw.
 */
export const text = (value: string | null | undefined): string | null =>
  value ?? null;

export const num = (value: number | null | undefined): number | null =>
  value ?? null;

export const bool = (value: boolean): number => (value ? 1 : 0);

/** `undefined` becomes NULL; `null` is a value worth keeping and is stored. */
export const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

// ------------------------------------------------------------------ reading

const str = (value: unknown): string => value as string;
const int = (value: unknown): number => Number(value);
const strOrNull = (value: unknown): string | null =>
  value === null ? null : (value as string);
const intOrNull = (value: unknown): number | null =>
  value === null ? null : Number(value);

/**
 * Parse a JSON column, saying which row failed when it cannot.
 *
 * A store that reports "unexpected token" without naming the table and the id
 * is a store nobody can debug from a user's machine.
 */
function parse<T>(value: unknown, table: string, id: string): T {
  try {
    return JSON.parse(value as string) as T;
  } catch (cause) {
    throw new Error(`vowe: ${table} ${id} holds unreadable JSON`, { cause });
  }
}

// ------------------------------------------------------------------ projects

export function toProject(row: Row): Project {
  const project: Project = {
    id: str(row['id']),
    name: str(row['name']),
    repoRoot: str(row['repo_root']),
    createdAt: str(row['created_at']),
  };
  // Optional keys: present only when there is something to say.
  if (row['git_common_dir'] !== null) {
    project.gitCommonDir = str(row['git_common_dir']);
  }
  if (row['remote_url'] !== null) project.remoteUrl = str(row['remote_url']);
  return project;
}

// ------------------------------------------------------------------ sessions

export function toSession(row: Row): AgentSession {
  const id = str(row['id']);
  const session: AgentSession = {
    id,
    provider: str(row['provider']),
    providerSessionId: str(row['provider_session_id']),
    attachMode: str(row['attach_mode']) as AgentSession['attachMode'],
    // Required keys that are nullable in the domain: always assigned.
    task: strOrNull(row['task']),
    displayLabel: str(row['display_label']),
    ...(row['generated_title'] === null || row['generated_title'] === undefined
      ? {}
      : { generatedTitle: str(row['generated_title']) }),
    ...(row['archived_at'] === null || row['archived_at'] === undefined
      ? {}
      : { archivedAt: str(row['archived_at']) }),
    cwd: strOrNull(row['cwd']),
    projectId: strOrNull(row['project_id']),
    status: str(row['status']) as AgentSession['status'],
    createdAt: str(row['created_at']),
    lastActivityAt: str(row['last_activity_at']),
    capabilities: parse<SessionCapabilities>(
      row['capabilities_json'],
      'sessions',
      id,
    ),
    semanticState:
      row['semantic_state_json'] === null
        ? null
        : parse<SemanticState>(row['semantic_state_json'], 'sessions', id),
  };
  if (row['worktree'] !== null) session.worktree = str(row['worktree']);
  if (row['branch'] !== null) session.branch = str(row['branch']);
  return session;
}

// -------------------------------------------------------------------- events

export function toEvent(row: Row): NormalizedEvent {
  const id = str(row['id']);
  const event: NormalizedEvent = {
    id,
    sessionId: str(row['session_id']),
    seq: int(row['seq']),
    at: str(row['at']),
    kind: str(row['kind']) as NormalizedEvent['kind'],
    summary: str(row['summary']),
    // `raw` is required but may legitimately be any value, including null.
    raw:
      row['raw_json'] === null
        ? undefined
        : parse<unknown>(row['raw_json'], 'events', id),
    rawRef: {
      source: str(row['raw_source']),
      byteOffset: int(row['raw_byte_offset']),
      line: int(row['raw_line']),
    },
  };
  if (row['detail_json'] !== null) {
    event.detail = parse<Record<string, unknown>>(
      row['detail_json'],
      'events',
      id,
    );
  }
  return event;
}

// ------------------------------------------------------------------ semantic

export function toSemanticState(row: Row): SemanticState {
  const key = `${str(row['session_id'])}#${int(row['ord'])}`;
  return {
    task: strOrNull(row['task']),
    phase: str(row['phase']),
    currentActivity: str(row['current_activity']),
    recentProgress: parse<string[]>(
      row['recent_progress_json'],
      'semantic_states',
      key,
    ),
    lastMeaningfulUpdate: str(row['last_meaningful_update']),
    // Nullable since v8; a row written before it genuinely had neither.
    currentUnderstanding: strOrNull(row['current_understanding'] ?? null),
    meaningfulUpdates:
      row['meaningful_updates_json'] === null ||
      row['meaningful_updates_json'] === undefined
        ? []
        : parse<MeaningfulUpdate[]>(
            row['meaningful_updates_json'],
            'semantic_states',
            key,
          ),
    source: str(row['source']) as SemanticState['source'],
    provenance: parse<SemanticProvenance>(
      row['provenance_json'],
      'semantic_states',
      key,
    ),
    updatedAt: str(row['updated_at']),
  };
}

// -------------------------------------------------------------- conversation

export function toConversationEntry(row: Row): ConversationEntry {
  const id = str(row['id']);
  const entry: ConversationEntry = {
    id,
    sessionId: str(row['session_id']),
    at: str(row['at']),
    role: str(row['role']) as ConversationEntry['role'],
    text: str(row['text']),
  };
  // All three are optional. An entry written before receipts existed has no
  // `investigation` key, and must not grow one.
  if (row['refs_json'] !== null) {
    entry.refs = parse<ContextRef[]>(row['refs_json'], 'conversation_entries', id);
  }
  if (row['provenance_json'] !== null) {
    entry.provenance = parse<ConversationEntry['provenance']>(
      row['provenance_json'],
      'conversation_entries',
      id,
    );
  }
  if (row['investigation_json'] !== null) {
    entry.investigation = parse<ConversationEntry['investigation']>(
      row['investigation_json'],
      'conversation_entries',
      id,
    );
  }
  // All three or none: a provider identity is one fact in three columns, and
  // the schema only ever writes them together.
  if (row['origin_provider'] !== null) {
    entry.origin = {
      provider: str(row['origin_provider']),
      kind: str(row['origin_kind']),
      id: str(row['origin_id']),
    };
  }
  return entry;
}

export function toProjectConversationEntry(row: Row): ProjectConversationEntry {
  const id = str(row['id']);
  const entry: ProjectConversationEntry = {
    id,
    projectId: str(row['project_id']),
    at: str(row['at']),
    role: str(row['role']) as ProjectConversationEntry['role'],
    text: str(row['text']),
  };
  if (row['refs_json'] !== null) {
    entry.refs = parse<ContextRef[]>(row['refs_json'], 'project_conversation_entries', id);
  }
  if (row['provenance_json'] !== null) {
    entry.provenance = parse<ProjectConversationEntry['provenance']>(
      row['provenance_json'],
      'project_conversation_entries',
      id,
    );
  }
  if (row['investigation_json'] !== null) {
    entry.investigation = parse<ProjectConversationEntry['investigation']>(
      row['investigation_json'],
      'project_conversation_entries',
      id,
    );
  }
  if (row['origin_provider'] !== null) {
    entry.origin = {
      provider: str(row['origin_provider']),
      kind: str(row['origin_kind']),
      id: str(row['origin_id']),
    };
  }
  return entry;
}

export function toDelivery(row: Row): ConversationDelivery {
  const delivery: ConversationDelivery = {
    id: str(row['id']),
    entryId: str(row['entry_id']),
    sessionId: str(row['session_id']),
    modality: str(row['modality']) as DeliveryModality,
    status: str(row['status']) as DeliveryStatus,
    startedAt: str(row['started_at']),
  };
  if (row['delivered_text'] !== null) {
    delivery.deliveredText = str(row['delivered_text']);
  }
  if (row['audio_end_ms'] !== null) delivery.audioEndMs = int(row['audio_end_ms']);
  if (row['interrupted_by_entry_id'] !== null) {
    delivery.interruptedByEntryId = str(row['interrupted_by_entry_id']);
  }
  if (row['completed_at'] !== null) delivery.completedAt = str(row['completed_at']);
  return delivery;
}

// --------------------------------------------------------------- observation

export function toWindow(row: Row): TraceWindow {
  return {
    id: str(row['id']),
    sessionId: str(row['session_id']),
    index: int(row['idx']),
    startSeq: int(row['start_seq']),
    endSeq: int(row['end_seq']),
    eventCount: int(row['event_count']),
    approxTokens: int(row['approx_tokens']),
    // Required, nullable: the keys stay.
    source: strOrNull(row['source']),
    startOffset: intOrNull(row['start_offset']),
    endOffset: intOrNull(row['end_offset']),
    startedAt: str(row['started_at']),
    endedAt: str(row['ended_at']),
    closedBy: str(row['closed_by']) as TraceWindow['closedBy'],
    createdAt: str(row['created_at']),
  };
}

export function toWindowNote(row: Row): WindowNote {
  const id = str(row['id']);
  const note: WindowNote = {
    id,
    sessionId: str(row['session_id']),
    windowId: str(row['window_id']),
    windowIndex: int(row['window_index']),
    summary: str(row['summary']),
    refs: parse<ContextRef[]>(row['refs_json'], 'window_notes', id),
    investigated: int(row['investigated']) === 1,
    createdAt: str(row['created_at']),
  };
  if (row['current_activity'] !== null) {
    note.currentActivity = str(row['current_activity']);
  }
  if (row['notable_change'] !== null) {
    note.notableChange = str(row['notable_change']);
  }
  if (row['understanding'] !== null && row['understanding'] !== undefined) {
    note.understanding = str(row['understanding']);
  }
  return note;
}

export function toSurfaceUpdate(row: Row): SurfaceUpdate {
  const id = str(row['id']);
  const update: SurfaceUpdate = {
    id,
    sessionId: str(row['session_id']),
    windowId: strOrNull(row['window_id']),
    message: str(row['message']),
    whyNow: str(row['why_now']),
    refs: parse<ContextRef[]>(row['refs_json'], 'surface_updates', id),
    urgency: str(row['urgency']) as SurfaceUpdate['urgency'],
    createdAt: str(row['created_at']),
  };
  if (row['decision_json'] !== null) {
    update.decision = parse<CommunicationDecision>(
      row['decision_json'],
      'surface_updates',
      id,
    );
  }
  if (row['decided_at'] !== null) update.decidedAt = str(row['decided_at']);
  if (row['delivered_at'] !== null) update.deliveredAt = str(row['delivered_at']);
  return update;
}

export function toObservationState(row: Row): ObservationState {
  return {
    sessionId: str(row['session_id']),
    lastClosedWindowIndex: int(row['last_closed_window_index']),
    lastProcessedWindowId: strOrNull(row['last_processed_window_id']),
    processedThroughSeq: int(row['processed_through_seq']),
    communicationPreference: strOrNull(row['communication_preference']),
    updatedAt: str(row['updated_at']),
  };
}

// ------------------------------------------------------- execution history

export function toRun(row: Row): VoweRun {
  const id = str(row['id']);
  const run: VoweRun = {
    id,
    kind: str(row['kind']),
    status: str(row['status']) as VoweRun['status'],
    startedAt: str(row['started_at']),
  };
  if (row['session_id'] !== null) run.sessionId = str(row['session_id']);
  if (row['project_id'] !== null) run.projectId = str(row['project_id']);
  if (row['provider'] !== null) run.provider = str(row['provider']);
  if (row['model'] !== null) run.model = str(row['model']);
  if (row['trigger_entry_id'] !== null) {
    run.triggerEntryId = str(row['trigger_entry_id']);
  }
  if (row['output_entry_id'] !== null) {
    run.outputEntryId = str(row['output_entry_id']);
  }
  if (row['completed_at'] !== null) run.completedAt = str(row['completed_at']);
  if (row['usage_json'] !== null) {
    run.usage = parse<ModelUsage>(row['usage_json'], 'vowe_runs', id);
  }
  if (row['metadata_json'] !== null) {
    run.metadata = parse<Record<string, unknown>>(
      row['metadata_json'],
      'vowe_runs',
      id,
    );
  }
  return run;
}

export function toTraceItem(row: Row): VoweTraceItem {
  const runId = str(row['run_id']);
  const ord = int(row['ord']);
  const item: VoweTraceItem = {
    id: str(row['id']),
    runId,
    ord,
    kind: str(row['kind']) as VoweTraceItem['kind'],
    at: str(row['at']),
  };
  if (row['text'] !== null) item.text = str(row['text']);
  if (row['payload_json'] !== null) {
    // `payload` may legitimately be any JSON value, including null.
    item.payload = parse<unknown>(
      row['payload_json'],
      'vowe_trace_items',
      `${runId}#${ord}`,
    );
  }
  if (row['provider_item_id'] !== null) {
    item.providerItemId = str(row['provider_item_id']);
  }
  return item;
}

// ----------------------------------------------------------------- workbench

/**
 * A stored desk, made safe to draw.
 *
 * Total, and deliberately unlike every other reader here: the rest of this
 * module throws on a malformed row, because a corrupt event is a fault worth
 * stopping for. A desk is not. It is a record of what someone had open, and
 * the right response to one that no longer makes sense is to draw the part
 * that does — never an exception on the way into a room.
 *
 * What it drops, and why: an address `parseRef` cannot read is an address
 * nothing can be done with. Everything else is kept and repaired — a tab is
 * re-keyed to its canonical spelling, an unrecognised status becomes `durable`
 * (an unclassifiable tab is one the developer keeps, which is the conservative
 * direction), all but the first `preview` are demoted, and an `activeId` left
 * pointing at nothing becomes null.
 *
 * There is no cap on how many tabs survive. The strip scrolls and inactive
 * tabs are resolved lazily, so tab forty costs an entry in an array; silently
 * discarding what somebody left open would break the only promise this makes.
 */
export function toWorkbench(row: Row): PersistedWorkbench | null {
  let document: unknown;
  try {
    document = JSON.parse(str(row['state_json']));
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null) return null;

  const raw = (document as { tabs?: unknown }).tabs;
  if (!Array.isArray(raw)) return null;

  const tabs: PersistedWorkbenchTab[] = [];
  const seen = new Set<string>();
  let preview = false;

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Partial<PersistedWorkbenchTab>;
    if (typeof candidate.ref !== 'string') continue;
    const parsed = parseRef(candidate.ref);
    if (!parsed) continue;

    const ref = formatRef(parsed);
    if (seen.has(ref)) continue;
    seen.add(ref);

    const wantsPreview = candidate.status === 'preview' && !preview;
    if (wantsPreview) preview = true;

    tabs.push({
      ref,
      title:
        typeof candidate.title === 'string' && candidate.title.trim()
          ? candidate.title
          : ref,
      status: wantsPreview ? 'preview' : 'durable',
    });
  }

  if (!tabs.length) return null;

  const activeId = (document as { activeId?: unknown }).activeId;
  return {
    tabs,
    activeId:
      typeof activeId === 'string' && seen.has(activeId) ? activeId : null,
  };
}
