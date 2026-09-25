import type { ContextRef } from '../context/refs.js';
import { formatRef } from '../context/refs.js';

/**
 * What an answer actually stands on, named the way a person would name it.
 *
 * A grounded answer carries every ref it was derived from, and a ref is an
 * address. Rendering addresses directly produced the defect this module exists
 * to remove: three rows reading `worker activity` under a line claiming four
 * supporting items, because "what kind of ref is this" was the only question
 * being asked of each one.
 *
 * Two rules make the difference:
 *
 *  - **One item per distinct piece of evidence.** The count is the number of
 *    items, so the number and the rows cannot disagree; there is no cap that
 *    shows three of twenty-one.
 *  - **The name comes from the thing, not from its address.** An event ref is
 *    named from the event it points at — `Task instruction`, `Test run` — which
 *    means the caller has to hand over the events it already holds. Where it
 *    cannot, the name falls back to something honest and general rather than to
 *    the provider's own vocabulary.
 *
 * Items that end up with the same name are grouped under it with a count, which
 * is what keeps fourteen worker updates from being fourteen identical rows. The
 * raw address stays on each member, because "which one was it" is a real
 * question one level down.
 *
 * Pure and deterministic: this is a projection of refs the investigation
 * already recorded, and nothing here asks a model to phrase anything.
 */
export interface EvidenceItem {
  /** `formatRef(ref)`. Stable, and the key a list can render by. */
  id: string;
  ref: ContextRef;
  /** Human-facing, and shared with the other members of its group. */
  title: string;
  /**
   * Which one of them this is — a sequence number, a line, a path.
   *
   * Deliberately the place raw identifiers are allowed to live: the primary
   * label is prose, and the address is available beside it.
   */
  detail?: string;
}

export interface EvidenceGroup {
  /** The shared title, which is also the group's identity. */
  title: string;
  items: EvidenceItem[];
}

export interface Evidence {
  /** Distinct pieces of evidence. Always equal to the items rendered. */
  total: number;
  /** In the order the investigation first touched each kind of thing. */
  groups: EvidenceGroup[];
}

/**
 * The few fields naming an event needs.
 *
 * Structural so a caller can pass the `NormalizedEvent`s it already loaded
 * without this module importing the event types — and so a test can pass three
 * object literals.
 */
export interface EvidenceEvent {
  id: string;
  seq: number;
  kind: string;
  summary?: string;
}

export interface EvidenceContext {
  /** Whatever events the caller has. A ref to one it lacks is still named. */
  events?: readonly EvidenceEvent[];
}

export function evidenceFor(
  refs: readonly ContextRef[],
  context: EvidenceContext = {},
): Evidence {
  const events = new Map<string, EvidenceEvent>();
  for (const event of context.events ?? []) events.set(event.id, event);

  const groups: EvidenceGroup[] = [];
  const byTitle = new Map<string, EvidenceGroup>();
  const seen = new Set<string>();
  let total = 0;

  for (const ref of refs) {
    const id = formatRef(ref);
    // The same address twice is one piece of evidence. `dedupeRefs` already
    // does this upstream; doing it here too means the count is right whatever
    // the caller hands over.
    if (seen.has(id)) continue;
    seen.add(id);

    const named = describeRef(ref, events);
    const item: EvidenceItem = {
      id,
      ref,
      title: named.title,
      ...(named.detail ? { detail: named.detail } : {}),
    };
    total += 1;

    const existing = byTitle.get(named.title);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const group: EvidenceGroup = { title: named.title, items: [item] };
    byTitle.set(named.title, group);
    groups.push(group);
  }

  return { total, groups };
}

/**
 * One ref, named and placed.
 *
 * Total over `ContextRef`, so a new ref kind arrives here as a case to name
 * rather than as a blank row.
 */
function describeRef(
  ref: ContextRef,
  events: Map<string, EvidenceEvent>,
): { title: string; detail?: string } {
  switch (ref.kind) {
    case 'repo': {
      const where = ref.line === undefined ? dirname(ref.path) : `line ${ref.line}`;
      return { title: basename(ref.path), ...(where ? { detail: where } : {}) };
    }

    case 'diff':
      return ref.path
        ? { title: `${basename(ref.path)} diff`, detail: ref.path }
        : { title: 'Current diff' };

    case 'symbol':
      // A graph node id is the provider's own string, and its last segment is
      // the symbol's name — which is a name, so it leads.
      return { title: lastSegment(ref.nodeId), detail: ref.nodeId };

    case 'lesson':
      return { title: 'Project knowledge', detail: ref.recordId };

    case 'window':
      return { title: 'Observed work', detail: ref.windowId };

    case 'trace':
      // A range of the worker's timeline, which is a different thing from one
      // record in it. Named as the span it is.
      return {
        title: 'Worker timeline',
        detail: `${ref.startSeq}–${ref.endSeq}`,
      };

    case 'event':
    case 'transcript': {
      const event = events.get(ref.eventId);
      if (!event) {
        /*
         * A ref into material this caller did not load — an older event, or a
         * project answer citing a session's trace. The kind is the only thing
         * known for certain, so the name says that and no more. Inventing a
         * specific label here is exactly the failure this module removes.
         */
        return {
          title: ref.kind === 'transcript' ? 'Exchange with the worker' : 'Worker record',
          detail: ref.eventId,
        };
      }
      return { title: eventTitle(event), detail: eventDetail(event) };
    }
  }
}

/**
 * What an event is, in the product's own words.
 *
 * `[539] agent_message` is two implementation details and no meaning: a
 * sequence number the developer has no use for and the provider's own name for
 * a record. Both survive as the detail, and in the raw descent; the thing on
 * screen is named for what it is.
 *
 * Deliberately a total map with a stated default rather than a lookup that can
 * miss: a new event kind should show up here as a case to name, not as a blank
 * title.
 */
export function eventTitle(event: { kind: string; summary?: string }): string {
  switch (event.kind) {
    case 'user_instruction':
      return 'Task instruction';
    case 'agent_message':
      return 'Worker update';
    case 'agent_reasoning':
      return 'Worker reasoning';
    case 'file_changed':
      return 'File change';
    case 'test_started':
    case 'test_finished':
      return 'Test run';
    case 'command_started':
    case 'command_finished':
      return 'Command';
    case 'tool_started':
    case 'tool_finished':
      return 'Worker step';
    case 'permission_requested':
      return 'Permission request';
    case 'session_started':
      return 'Session start';
    case 'session_waiting':
      return 'Worker stopped';
    case 'session_finished':
      return 'Session end';
    default: {
      // An unrecognised kind still has the adapter's own one-line description,
      // which is a better name than the kind string it came with.
      const summary = event.summary?.trim();
      return summary || 'Worker activity';
    }
  }
}

/**
 * The provider's own label for the record, kept where it belongs.
 *
 * Underneath the name rather than instead of it — somebody reading an event
 * closely does want to know it was `agent_message` number 539, and the raw
 * record is one descent further down at `open_context` depth `raw`.
 */
export function eventSubtitle(event: { seq: number; kind: string; summary?: string }): string {
  const summary = event.summary?.trim();
  const provenance = `[${event.seq}] ${event.kind}`;
  return summary && summary !== eventTitle(event) ? `${summary} · ${provenance}` : provenance;
}

/** Shorter than the workbench's subtitle: one line in a list, not a header. */
function eventDetail(event: EvidenceEvent): string {
  const summary = event.summary?.trim();
  return summary && summary !== eventTitle(event) ? summary : `${event.seq} · ${event.kind}`;
}

const basename = (path: string): string => path.split('/').pop() ?? path;

function dirname(path: string): string | undefined {
  const parts = path.split('/');
  parts.pop();
  return parts.length ? parts.join('/') : undefined;
}

/** A graph node id is opaque, so only its trailing name is used for display. */
function lastSegment(nodeId: string): string {
  const parts = nodeId.split(/[#:/.]/).filter(Boolean);
  return parts[parts.length - 1] ?? nodeId;
}
