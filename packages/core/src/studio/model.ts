/**
 * The Studio design model: the system being designed, as something you can
 * point at.
 *
 * A design used to be a Markdown document rewritten every turn. Paragraphs are
 * not design units — "this", "revert that", "why is that here" had nothing to
 * refer to — so the design is now a small structured model with stable ids,
 * changed in **moves**. Conversation and the canvas speak the same language:
 * a sentence to Vowe and a gesture on the canvas both end as a `DesignMove`
 * applied here.
 *
 * Deliberately small. Parts, the links between them, and — only where one is
 * actually under discussion — a responsibility that belongs to a part. No
 * component taxonomy, no confidence, no decision objects, no project graph.
 * This is a Studio model, not the universal Vowe ontology, and none of it is
 * project truth.
 *
 * Two worlds live in one model. The fields of an element are the **proposed**
 * system — what the canvas draws. `today` is what the repository has now, with
 * the checkout that established it, so a proposal can later be reconciled with
 * the implementation: when work lands, today becomes the proposal; when a
 * finding contradicts today, the design has diverged. Neither is built yet;
 * the model only keeps enough to make them possible.
 *
 * Imports nothing, so the renderer can use it at runtime (`@vowe/core/studio-model`).
 */

/** Which checkout said so: the repository state a consultation read. */
export interface RepositoryBasis {
  /** The directory the harness read. */
  worktree: string;
  /** `HEAD` at the time, or null outside Git. */
  head: string | null;
  branch?: string;
  /** Uncommitted changes were present, so `head` alone does not reproduce it. */
  dirty: boolean;
  at: string;
}

export interface DesignModel {
  title: string;
  /** A few sentences: what this design is for. */
  intent: string;
  parts: DesignPart[];
  links: DesignLink[];
  duties: DesignDuty[];
}

/** A component of the system. */
export interface DesignPart {
  /** Stable for the part's life: a rename never changes it. */
  id: string;
  name: string;
  /** One line: what it is for. */
  role: string;
  /** Why it is here, what is open or assumed. Markdown; shown only when asked. */
  detail?: string;
  /** Grounded `repo:` refs for where it lives in the code, formatted. */
  refs?: string[];
  /** The part as the repository has it now; null when it does not exist yet. */
  today: { name: string; role: string; basis?: RepositoryBasis } | null;
  /** Exists today; the design removes it. Kept so today can still be drawn. */
  retired?: true;
}

/** A relationship: `from` feeds, calls or owns `to`. */
export interface DesignLink {
  /** `${from}->${to}`: one link per ordered pair. */
  id: string;
  from: string;
  to: string;
  label?: string;
  today: { label?: string; basis?: RepositoryBasis } | null;
  retired?: true;
}

/**
 * A responsibility a part holds — "durable across restarts".
 *
 * Optional and sparse: it exists when the responsibility itself is being
 * discussed, so that moving it from one part to another is a visible,
 * addressable change rather than a rewritten sentence.
 */
export interface DesignDuty {
  id: string;
  part: string;
  text: string;
  today: { part: string; text: string; basis?: RepositoryBasis } | null;
  retired?: true;
}

export type DesignElement = DesignPart | DesignLink | DesignDuty;
export type DesignElementKind = 'part' | 'link' | 'duty';

/**
 * The closed set of changes. Upserts are keyed by stable id, so the same op
 * both adds and changes; `today: true` records the element as the repository
 * has it (its current fields), `today: null` says it does not exist there.
 */
export type DesignOp =
  | { op: 'design'; title?: string; intent?: string }
  | { op: 'part'; id: string; name?: string; role?: string; detail?: string; refs?: string[]; today?: true | null }
  | { op: 'link'; from: string; to: string; label?: string; today?: true | null }
  | { op: 'duty'; id: string; part?: string; text?: string; today?: true | null }
  | { op: 'remove'; id: string }
  | { op: 'revert'; move: string };

/**
 * One coherent change, whoever made it.
 *
 * `id` is stable and is what "revert that" names; the revision's ord is only
 * where it sits in history.
 */
export interface DesignMove {
  id: string;
  ops: DesignOp[];
  /** Why, as the agent gave it, or a plain account of a canvas gesture. */
  summary: string;
  author: 'developer' | 'vowe';
  via: 'conversation' | 'canvas';
}

export const EMPTY_MODEL: DesignModel = { title: '', intent: '', parts: [], links: [], duties: [] };

/** Live parts a design may hold. A working set, never the whole system. */
export const MAX_PARTS = 20;

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function linkId(from: string, to: string): string {
  return `${from}->${to}`;
}

export function newMoveId(random: () => number = Math.random): string {
  let id = 'mv-';
  for (let i = 0; i < 8; i += 1) id += Math.floor(random() * 16).toString(16);
  return id;
}

// ------------------------------------------------------------------ parsing

/** One op from untrusted JSON, or null. Never throws. */
export function parseOp(value: unknown): DesignOp | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const str = (key: string): string | undefined => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  const today = (): { today?: true | null } =>
    raw['today'] === true ? { today: true } : raw['today'] === null || raw['today'] === false ? { today: null } : {};
  switch (raw['op']) {
    case 'design':
      return { op: 'design', ...opt('title', str('title')), ...opt('intent', str('intent')) };
    case 'part': {
      const id = str('id');
      if (!id) return null;
      const refs = Array.isArray(raw['refs']) ? raw['refs'].filter((ref): ref is string => typeof ref === 'string') : undefined;
      return {
        op: 'part', id,
        ...opt('name', str('name')), ...opt('role', str('role')), ...opt('detail', str('detail')),
        ...(refs ? { refs } : {}), ...today(),
      };
    }
    case 'link': {
      const from = str('from');
      const to = str('to');
      if (!from || !to) return null;
      return { op: 'link', from, to, ...opt('label', str('label')), ...today() };
    }
    case 'duty': {
      const id = str('id');
      if (!id) return null;
      return { op: 'duty', id, ...opt('part', str('part')), ...opt('text', str('text')), ...today() };
    }
    case 'remove': {
      const id = str('id');
      return id ? { op: 'remove', id } : null;
    }
    case 'revert': {
      const move = str('move');
      return move ? { op: 'revert', move } : null;
    }
    default:
      return null;
  }
}

function opt<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

// ----------------------------------------------------------------- applying

export interface ApplyOptions {
  /** Stamped on every `today` this move establishes. Absent: none is claimed. */
  basis?: RepositoryBasis;
  /** The model before and after an earlier move, for `revert`. */
  resolveMove?: (moveId: string) => { before: DesignModel; after: DesignModel } | null;
}

export interface ApplyResult {
  model: DesignModel;
  /** Ops that could not apply, and why. The rest still did. */
  rejected: { op: DesignOp; reason: string }[];
  /** Elements a revert could not restore because something later changed them. */
  conflicts: string[];
}

/**
 * Apply a move's ops in order. Never throws on bad input: a model can write an
 * op that names a part that does not exist, and the right outcome is that op
 * is refused and the rest of the move still lands.
 */
export function applyOps(model: DesignModel, ops: readonly DesignOp[], options: ApplyOptions = {}): ApplyResult {
  let next = clone(model);
  const rejected: ApplyResult['rejected'] = [];
  const conflicts: string[] = [];
  for (const op of ops) {
    if (op.op === 'revert') {
      const move = options.resolveMove?.(op.move);
      if (!move) {
        rejected.push({ op, reason: `No move ${op.move} in this design.` });
        continue;
      }
      const reverted = revertModel(move.before, move.after, next);
      next = reverted.model;
      conflicts.push(...reverted.conflicts);
      continue;
    }
    const reason = applyOne(next, op, options.basis);
    if (reason) rejected.push({ op, reason });
  }
  return { model: next, rejected, conflicts };
}

/** Mutates `model`; returns why the op was refused, or null. */
function applyOne(model: DesignModel, op: Exclude<DesignOp, { op: 'revert' }>, basis: RepositoryBasis | undefined): string | null {
  const stamp = basis ? { basis } : {};
  switch (op.op) {
    case 'design': {
      if (op.title !== undefined) model.title = clip(op.title, 80);
      if (op.intent !== undefined) model.intent = clip(op.intent, 600);
      return null;
    }
    case 'part': {
      if (!ID.test(op.id)) return `"${op.id}" is not a valid id.`;
      if (model.duties.some((duty) => duty.id === op.id)) return `"${op.id}" is already a responsibility.`;
      let part = model.parts.find((candidate) => candidate.id === op.id);
      if (!part) {
        if (!op.name?.trim()) return `A new part needs a name.`;
        if (live(model.parts).length >= MAX_PARTS) return `A design holds at most ${MAX_PARTS} parts.`;
        part = { id: op.id, name: '', role: '', today: null };
        model.parts.push(part);
      } else if (part.retired) {
        if (live(model.parts).length >= MAX_PARTS) return `A design holds at most ${MAX_PARTS} parts.`;
        delete part.retired;
      }
      if (op.name?.trim()) part.name = clip(op.name, 60);
      if (op.role !== undefined) part.role = clip(op.role, 160);
      if (op.detail !== undefined) {
        const detail = clip(op.detail, 4000);
        if (detail) part.detail = detail;
        else delete part.detail;
      }
      if (op.refs) {
        if (op.refs.length) part.refs = [...new Set(op.refs)];
        else delete part.refs;
      }
      if (op.today === null) part.today = null;
      else if (op.today === true) part.today = { name: part.name, role: part.role, ...(basis ? stamp : part.today?.basis ? { basis: part.today.basis } : {}) };
      return null;
    }
    case 'link': {
      const from = livePart(model, op.from);
      const to = livePart(model, op.to);
      if (!from || !to) return `A link needs two parts on the canvas (${op.from} → ${op.to}).`;
      if (op.from === op.to) return 'A part cannot link to itself.';
      const id = linkId(op.from, op.to);
      let link = model.links.find((candidate) => candidate.id === id);
      if (!link) {
        link = { id, from: op.from, to: op.to, today: null };
        model.links.push(link);
      }
      delete link.retired;
      if (op.label !== undefined) {
        const label = clip(op.label, 40);
        if (label) link.label = label;
        else delete link.label;
      }
      if (op.today === null) link.today = null;
      else if (op.today === true) {
        link.today = { ...(link.label ? { label: link.label } : {}), ...(basis ? stamp : link.today?.basis ? { basis: link.today.basis } : {}) };
      }
      return null;
    }
    case 'duty': {
      if (!ID.test(op.id)) return `"${op.id}" is not a valid id.`;
      if (model.parts.some((part) => part.id === op.id)) return `"${op.id}" is already a part.`;
      let duty = model.duties.find((candidate) => candidate.id === op.id);
      if (op.part !== undefined && !livePart(model, op.part)) return `No part ${op.part} to hold that responsibility.`;
      if (!duty) {
        if (!op.part || !op.text?.trim()) return 'A new responsibility needs a part and a text.';
        duty = { id: op.id, part: op.part, text: '', today: null };
        model.duties.push(duty);
      } else if (duty.retired) {
        if (!livePart(model, op.part ?? duty.part)) return `No part ${duty.part} to hold that responsibility.`;
        delete duty.retired;
      }
      if (op.part !== undefined) duty.part = op.part;
      if (op.text?.trim()) duty.text = clip(op.text, 100);
      if (op.today === null) duty.today = null;
      else if (op.today === true) {
        duty.today = { part: duty.part, text: duty.text, ...(basis ? stamp : duty.today?.basis ? { basis: duty.today.basis } : {}) };
      }
      return null;
    }
    case 'remove': {
      const found = find(model, op.id);
      if (!found || found.element.retired) return `Nothing called ${op.id} is on the canvas.`;
      if (found.kind === 'part') {
        // What hangs off a part goes with it.
        for (const link of model.links) if (!link.retired && (link.from === op.id || link.to === op.id)) drop(model, 'link', link);
        for (const duty of model.duties) if (!duty.retired && duty.part === op.id) drop(model, 'duty', duty);
      }
      drop(model, found.kind, found.element);
      return null;
    }
  }
}

/** Existing today: retire it, so today can still be shown. Proposed only: gone. */
function drop(model: DesignModel, kind: DesignElementKind, element: DesignElement): void {
  if (element.today) {
    element.retired = true;
    return;
  }
  if (kind === 'part') model.parts = model.parts.filter((part) => part !== element);
  if (kind === 'link') model.links = model.links.filter((link) => link !== element);
  if (kind === 'duty') model.duties = model.duties.filter((duty) => duty !== element);
}

// --------------------------------------------------------------- reverting

/**
 * Undo one move against the design as it is now.
 *
 * Element by element: whatever that move changed goes back to how it was, but
 * only where nothing later has touched it since. An element changed again
 * afterwards is left alone and reported — reverting move 3 must never quietly
 * undo move 5.
 */
export function revertModel(
  before: DesignModel,
  after: DesignModel,
  current: DesignModel,
): { model: DesignModel; conflicts: string[] } {
  const next = clone(current);
  const conflicts: string[] = [];
  const kinds: DesignElementKind[] = ['part', 'link', 'duty'];
  // Restore parts before what hangs off them; take away what hangs off before parts.
  const order = [...kinds, ...[...kinds].reverse()];
  const done = new Set<string>();
  order.forEach((kind, pass) => {
    const restoring = pass < kinds.length;
    const ids = new Set([...listOf(before, kind), ...listOf(after, kind)].map((element) => element.id));
    for (const id of ids) {
      if (done.has(`${kind}:${id}`)) continue;
      const was = listOf(before, kind).find((element) => element.id === id);
      const became = listOf(after, kind).find((element) => element.id === id);
      if (same(was, became)) {
        done.add(`${kind}:${id}`);
        continue;
      }
      // Restoring something that was live before; removing something that was not.
      const wasLive = !!was && !was.retired;
      if (restoring !== wasLive) continue;
      done.add(`${kind}:${id}`);
      const now = listOf(next, kind).find((element) => element.id === id);
      if (!same(now, became)) {
        conflicts.push(id);
        continue;
      }
      if (!restoring && kind === 'part' && hangsOff(next, id)) {
        conflicts.push(id);
        continue;
      }
      if (restoring && !endpointsLive(next, kind, was!)) {
        conflicts.push(id);
        continue;
      }
      setElement(next, kind, id, was ? clone(was) : undefined);
    }
  });
  if (current.title === after.title) next.title = before.title;
  if (current.intent === after.intent) next.intent = before.intent;
  return { model: next, conflicts };
}

function hangsOff(model: DesignModel, partId: string): boolean {
  return (
    model.links.some((link) => !link.retired && (link.from === partId || link.to === partId)) ||
    model.duties.some((duty) => !duty.retired && duty.part === partId)
  );
}

function endpointsLive(model: DesignModel, kind: DesignElementKind, element: DesignElement): boolean {
  if (kind === 'link') {
    const link = element as DesignLink;
    return !!livePart(model, link.from) && !!livePart(model, link.to);
  }
  if (kind === 'duty') return !!livePart(model, (element as DesignDuty).part);
  return true;
}

function setElement(model: DesignModel, kind: DesignElementKind, id: string, element: DesignElement | undefined): void {
  const list = listOf(model, kind) as DesignElement[];
  const index = list.findIndex((candidate) => candidate.id === id);
  if (element && index >= 0) list[index] = element;
  else if (element) list.push(element);
  else if (index >= 0) list.splice(index, 1);
}

// ----------------------------------------------------------------- diffing

export interface DesignChangeEntry {
  id: string;
  kind: DesignElementKind;
  change: 'added' | 'removed' | 'changed';
  /** Which fields changed, for `changed`. */
  fields?: string[];
  /** A part's or responsibility's earlier name/text, or a responsibility's earlier part. */
  was?: { name?: string; text?: string; part?: string };
}

export interface DesignDiff {
  entries: DesignChangeEntry[];
  /** Changes you would see on the canvas; detail, refs and today are not drawn. */
  visible: number;
}

const INVISIBLE = new Set(['detail', 'refs', 'today']);

/** What changed between two versions of the proposed system. */
export function diffModels(before: DesignModel | null, after: DesignModel): DesignDiff {
  const base = before ?? EMPTY_MODEL;
  const entries: DesignChangeEntry[] = [];
  for (const kind of ['part', 'link', 'duty'] as const) {
    const was = new Map(live(listOf(base, kind)).map((element) => [element.id, element]));
    const now = new Map(live(listOf(after, kind)).map((element) => [element.id, element]));
    for (const [id, element] of now) {
      const previous = was.get(id);
      if (!previous) {
        entries.push({ id, kind, change: 'added' });
        continue;
      }
      const fields = changedFields(previous, element);
      if (fields.length) {
        const entry: DesignChangeEntry = { id, kind, change: 'changed', fields };
        if (kind === 'part' && fields.includes('name')) entry.was = { name: (previous as DesignPart).name };
        if (kind === 'duty') {
          const duty = previous as DesignDuty;
          entry.was = {
            ...(fields.includes('text') ? { text: duty.text } : {}),
            ...(fields.includes('part') ? { part: duty.part } : {}),
          };
        }
        entries.push(entry);
      }
    }
    for (const id of was.keys()) if (!now.has(id)) entries.push({ id, kind, change: 'removed' });
  }
  return { entries, visible: visibleEntries({ entries, visible: 0 }).length };
}

/** The changes you would see on the canvas. */
export function visibleEntries(diff: DesignDiff): DesignChangeEntry[] {
  return diff.entries.filter((entry) => entry.change !== 'changed' || entry.fields!.some((field) => !INVISIBLE.has(field)));
}

function changedFields(a: DesignElement, b: DesignElement): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('id');
  keys.delete('retired');
  return [...keys].filter((key) => !same((a as unknown as Record<string, unknown>)[key], (b as unknown as Record<string, unknown>)[key]));
}

// ------------------------------------------------------------------- views

/** The system as the repository has it now, as far as this design knows. */
export function todayModel(model: DesignModel): DesignModel {
  const parts = model.parts
    .filter((part) => part.today)
    .map((part) => ({ id: part.id, name: part.today!.name, role: part.today!.role, today: part.today }));
  const present = new Set(parts.map((part) => part.id));
  return {
    title: model.title,
    intent: model.intent,
    parts,
    links: model.links
      .filter((link) => link.today && present.has(link.from) && present.has(link.to))
      .map((link) => ({ id: link.id, from: link.from, to: link.to, ...(link.today!.label ? { label: link.today!.label } : {}), today: link.today })),
    duties: model.duties
      .filter((duty) => duty.today && present.has(duty.today.part))
      .map((duty) => ({ id: duty.id, part: duty.today!.part, text: duty.today!.text, today: duty.today })),
  };
}

/** The design as a document: the export, and what Studio 0's `document` column still holds. */
export function projectMarkdown(model: DesignModel): string {
  const parts = live(model.parts);
  const name = new Map(model.parts.map((part) => [part.id, part.name]));
  const lines: string[] = [`# ${model.title || 'Untitled design'}`];
  if (model.intent) lines.push('', model.intent);
  if (parts.length) {
    lines.push('', '## System');
    for (const part of parts) {
      lines.push(`- **${part.name}**${part.role ? ` — ${part.role}` : ''}`);
      for (const duty of live(model.duties).filter((candidate) => candidate.part === part.id)) lines.push(`  - ${duty.text}`);
    }
  }
  const links = live(model.links);
  if (links.length) {
    lines.push('', '## Connections');
    for (const link of links) lines.push(`- ${name.get(link.from)} → ${name.get(link.to)}${link.label ? ` (${link.label})` : ''}`);
  }
  const explained = parts.filter((part) => part.detail);
  if (explained.length) {
    lines.push('', '## Reasoning');
    for (const part of explained) lines.push('', `### ${part.name}`, '', part.detail!);
  }
  const changes = visibleEntries(diffModels(todayModel(model), model));
  if (model.parts.some((part) => part.today) && changes.length) {
    lines.push('', "## Compared with today's code");
    for (const entry of changes) lines.push(`- ${describeEntry(entry, model)}`);
  }
  return lines.join('\n');
}

/** One change in plain words. */
export function describeEntry(entry: DesignChangeEntry, model: DesignModel): string {
  const label = elementLabel(model, entry.kind, entry.id);
  if (entry.change === 'added') return `Adds ${label}`;
  if (entry.change === 'removed') return `Removes ${label}`;
  if (entry.was?.name) return `Renames ${entry.was.name} to ${label}`;
  if (entry.was?.part) {
    const from = model.parts.find((part) => part.id === entry.was!.part)?.name ?? entry.was.part;
    return `Moves ${label} from ${from} to ${partName(model, (model.duties.find((duty) => duty.id === entry.id)?.part) ?? '')}`;
  }
  return `Changes ${label}`;
}

export function elementLabel(model: DesignModel, kind: DesignElementKind, id: string): string {
  if (kind === 'part') return partName(model, id);
  if (kind === 'duty') {
    const duty = model.duties.find((candidate) => candidate.id === id);
    return duty ? `“${duty.text}”` : id;
  }
  const link = model.links.find((candidate) => candidate.id === id);
  return link ? `${partName(model, link.from)} → ${partName(model, link.to)}` : id;
}

function partName(model: DesignModel, id: string): string {
  return model.parts.find((part) => part.id === id)?.name ?? id;
}

/**
 * A plain account of a canvas gesture, as the history and the thread show it.
 * Derived from what the ops did to the model, never from UI vocabulary.
 */
export function describeCanvasMove(before: DesignModel, after: DesignModel, revertedSummary?: string): string {
  if (revertedSummary !== undefined) return `Reverted: ${revertedSummary || 'an earlier change'}`;
  const diff = diffModels(before, after);
  const said = diff.entries.map((entry) => describeEntry(entry, entry.change === 'removed' ? before : after));
  if (!said.length) return 'No change';
  const first = said[0]!.replace(/^Adds /, 'Added ').replace(/^Removes /, 'Removed ').replace(/^Renames /, 'Renamed ').replace(/^Moves /, 'Moved ').replace(/^Changes /, 'Changed ');
  return said.length === 1 ? first : `${first}, and ${said.length - 1} more`;
}

// ----------------------------------------------------------------- helpers

export function live<T extends { retired?: true }>(list: readonly T[]): T[] {
  return list.filter((element) => !element.retired);
}

export function find(model: DesignModel, id: string): { kind: DesignElementKind; element: DesignElement } | null {
  const part = model.parts.find((candidate) => candidate.id === id);
  if (part) return { kind: 'part', element: part };
  const link = model.links.find((candidate) => candidate.id === id);
  if (link) return { kind: 'link', element: link };
  const duty = model.duties.find((candidate) => candidate.id === id);
  if (duty) return { kind: 'duty', element: duty };
  return null;
}

function livePart(model: DesignModel, id: string): DesignPart | undefined {
  return model.parts.find((part) => part.id === id && !part.retired);
}

function listOf(model: DesignModel, kind: DesignElementKind): DesignElement[] {
  return kind === 'part' ? model.parts : kind === 'link' ? model.links : model.duties;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Structural equality, independent of key order; `undefined` fields count as absent. */
export function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`;
}
