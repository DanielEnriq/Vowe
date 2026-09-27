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
 * actually under discussion — a responsibility that belongs to a part. A part
 * may say what kind of thing it is from a closed set of six, which technology
 * it is, and which boundary it sits inside. That is the whole grammar: enough
 * for a SaaS product, an AI pipeline or Vowe itself to read as a system, and
 * nothing that describes code. No confidence, no decision objects, no project
 * graph. This is a Studio model, not the universal Vowe ontology, and none of
 * it is project truth.
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

/**
 * What kind of thing a part is, at whiteboard altitude. Absent: unspecified.
 *
 * - `client`: where people use the system, on their device — web app, mobile, CLI.
 * - `service`: code you run — API, backend, gateway, worker, function, agent.
 * - `store`: state you keep — database, cache, object storage, search index.
 * - `queue`: an asynchronous hand-off — queue, topic, stream, event bus.
 * - `external`: a system you use but do not run — Stripe, a model provider, a coding harness.
 * - `group`: a boundary with no behaviour of its own — Frontend, Backend, Supabase.
 *   Parts sit inside it with `within`; a group never sits inside another.
 *
 * Deliberately closed and short. A worker is a service, a cache is a store, a
 * model provider is external: the name, the technology and the links say the
 * rest. A kind exists only where it changes how a part is drawn, reasoned
 * about or eventually built.
 */
export type DesignPartKind = 'client' | 'service' | 'store' | 'queue' | 'external' | 'group';

export const PART_KINDS: readonly DesignPartKind[] = ['client', 'service', 'store', 'queue', 'external', 'group'];

/**
 * A recognisable technology — PostgreSQL, Stripe, Vercel. Design vocabulary,
 * not an account or a resource.
 *
 * `name` is what the design says. `key` is presentation metadata — a
 * lowercase slug a renderer may map to an icon — and never identity: it is
 * optional, may be corrected or canonicalised later, and a change to it alone
 * is not a change to the design.
 */
export interface DesignTechnology {
  name: string;
  key?: string;
}

/**
 * A part as the repository has it now. `kind` and `technology` are recorded
 * when the part was grounded with them; absent means not recorded, not "none",
 * so an older record never reads as a difference. Boundaries are the design's
 * own idea and are not recorded.
 */
export interface DesignPartToday {
  name: string;
  role: string;
  kind?: DesignPartKind;
  technology?: DesignTechnology;
  basis?: RepositoryBasis;
}

/** A component of the system. */
export interface DesignPart {
  /** Stable for the part's life: a rename never changes it. */
  id: string;
  name: string;
  /** One line: what it is for. */
  role: string;
  kind?: DesignPartKind;
  technology?: DesignTechnology;
  /** The id of the `group` this part sits inside. */
  within?: string;
  /** Why it is here, what is open or assumed. Markdown; shown only when asked. */
  detail?: string;
  /** Grounded `repo:` refs for where it lives in the code, formatted. */
  refs?: string[];
  /** The part as the repository has it now; null when it does not exist yet. */
  today: DesignPartToday | null;
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
  | {
      op: 'part'; id: string; name?: string; role?: string; detail?: string; refs?: string[];
      /** `null` clears; so does it for `technology` and `within`. */
      kind?: DesignPartKind | null;
      technology?: DesignTechnology | null;
      within?: string | null;
      today?: true | null;
    }
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
const TECHNOLOGY_KEY = /^[a-z0-9][a-z0-9.-]{0,39}$/;

/**
 * A slug for a technology name — "AWS S3" → "aws-s3" — for a renderer to fall
 * back on when a part's technology carries no key. Derived on read, never
 * stored: a stored key is only ever one somebody chose.
 */
export function technologyKey(technology: DesignTechnology): string {
  if (technology.key) return technology.key;
  return technology.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

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
      const kind = raw['kind'];
      const within = raw['within'];
      const technology = parseTechnology(raw['technology']);
      return {
        op: 'part', id,
        ...opt('name', str('name')), ...opt('role', str('role')), ...opt('detail', str('detail')),
        ...(refs ? { refs } : {}),
        // An unknown kind is not a broken op: the part simply stays unspecified.
        ...(kind === null || (typeof kind === 'string' && (PART_KINDS as readonly string[]).includes(kind)) ? { kind: kind as DesignPartKind | null } : {}),
        ...(technology !== undefined ? { technology } : {}),
        ...(within === null || typeof within === 'string' ? { within: within || null } : {}),
        ...today(),
      };
    }
    case 'link': {
      const from = str('from');
      const to = str('to');
      if (!from || !to) return null;
      return { op: 'link', from, to, ...opt('label', str('label')), ...today() };
    }
    // "Responsibility" is the product's word; `duty` is the model's.
    case 'responsibility':
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

/** A technology from untrusted JSON: an object with a name, a bare name, `null` to clear, or nothing. */
function parseTechnology(value: unknown): DesignTechnology | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value.trim() ? { name: value } : null;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['name'] !== 'string' || !raw['name'].trim()) return undefined;
  const key = typeof raw['key'] === 'string' ? raw['key'].trim().toLowerCase() : '';
  return { name: raw['name'], ...(TECHNOLOGY_KEY.test(key) ? { key } : {}) };
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
      const boundary = boundaryRefusal(model, part, op);
      if (boundary) return boundary;
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
      if (op.kind === null) delete part.kind;
      else if (op.kind) part.kind = op.kind;
      if (op.within === null) delete part.within;
      else if (op.within) part.within = op.within;
      if (op.technology === null) delete part.technology;
      else if (op.technology) {
        const name = clip(op.technology.name, 40);
        if (name) part.technology = { name, ...(op.technology.key ? { key: op.technology.key } : {}) };
      }
      if (op.today === null) part.today = null;
      else if (op.today === true) {
        part.today = {
          name: part.name,
          role: part.role,
          ...(part.kind ? { kind: part.kind } : {}),
          ...(part.technology ? { technology: { ...part.technology } } : {}),
          ...(basis ? stamp : part.today?.basis ? { basis: part.today.basis } : {}),
        };
      }
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

/**
 * Whether a part op keeps boundaries coherent: a part sits only inside a live
 * group, a group sits inside nothing, and a group that still holds parts stays
 * a group. Checked before anything changes, so a refused op leaves no trace.
 */
function boundaryRefusal(model: DesignModel, part: DesignPart | undefined, op: Extract<DesignOp, { op: 'part' }>): string | null {
  const kind = op.kind === undefined ? part?.kind : op.kind ?? undefined;
  if (part?.kind === 'group' && kind !== 'group' && members(model, part.id).length) {
    return `${part.name} still holds parts; take them out before it stops being a group.`;
  }
  const within = op.within === undefined ? part?.within : op.within ?? undefined;
  if (within === undefined) return null;
  if (within === op.id || kind === 'group') return 'A group does not sit inside another part.';
  const group = livePart(model, within);
  if (!group || group.kind !== 'group') return `No group ${within} to put ${op.id} inside.`;
  return null;
}

function members(model: DesignModel, groupId: string): DesignPart[] {
  return model.parts.filter((part) => !part.retired && part.within === groupId);
}

/** Existing today: retire it, so today can still be shown. Proposed only: gone. */
function drop(model: DesignModel, kind: DesignElementKind, element: DesignElement): void {
  // A boundary goes; what was inside it stays, outside.
  if (kind === 'part') for (const part of model.parts) if (part.within === element.id) delete part.within;
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
    // A boundary is restored before the parts that go back inside it.
    const inside = (id: string): boolean => !!before.parts.find((part) => part.id === id)?.within;
    const sequence = kind === 'part' ? [...ids].sort((a, b) => Number(inside(a)) - Number(inside(b))) : [...ids];
    for (const id of sequence) {
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
    model.duties.some((duty) => !duty.retired && duty.part === partId) ||
    members(model, partId).length > 0
  );
}

function endpointsLive(model: DesignModel, kind: DesignElementKind, element: DesignElement): boolean {
  if (kind === 'link') {
    const link = element as DesignLink;
    return !!livePart(model, link.from) && !!livePart(model, link.to);
  }
  if (kind === 'duty') return !!livePart(model, (element as DesignDuty).part);
  const within = (element as DesignPart).within;
  return !within || livePart(model, within)?.kind === 'group';
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
  /**
   * What a part or responsibility was before: its name or text, a
   * responsibility's part, a part's technology name, or the group a part sat
   * in (`null`: none).
   */
  was?: { name?: string; text?: string; part?: string; technology?: string | null; within?: string | null };
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
        if (kind === 'part') {
          const part = previous as DesignPart;
          const was = {
            ...(fields.includes('name') ? { name: part.name } : {}),
            ...(fields.includes('technology') ? { technology: part.technology?.name ?? null } : {}),
            ...(fields.includes('within') ? { within: part.within ?? null } : {}),
          };
          if (Object.keys(was).length) entry.was = was;
        }
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
  return [...keys].filter((key) => !same(semantic(a, key), semantic(b, key)));
}

/**
 * A field as the design means it. A technology is its name: its key is
 * presentation, so correcting one is not a change to the design — here or in
 * `today`.
 */
function semantic(element: DesignElement, key: string): unknown {
  const value = (element as unknown as Record<string, unknown>)[key];
  if (key === 'technology') return (value as DesignTechnology | undefined)?.name;
  if (key === 'today' && value && typeof value === 'object' && 'technology' in value) {
    const today = value as DesignPartToday;
    return { ...today, technology: today.technology?.name };
  }
  return value;
}

// ------------------------------------------------------------------- views

/** The system as the repository has it now, as far as this design knows. */
export function todayModel(model: DesignModel): DesignModel {
  const present = new Set(model.parts.filter((part) => part.today).map((part) => part.id));
  const parts = model.parts
    .filter((part) => part.today)
    .map((part): DesignPart => {
      const today = part.today!;
      // What today did not record is not a difference: it reads as the design says.
      const kind = today.kind ?? part.kind;
      const technology = today.technology ?? part.technology;
      return {
        id: part.id,
        name: today.name,
        role: today.role,
        ...(kind ? { kind } : {}),
        ...(technology ? { technology } : {}),
        ...(part.within && present.has(part.within) ? { within: part.within } : {}),
        today,
      };
    });
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

/**
 * The design as a document: the export, what Studio 0's `document` column
 * still holds, and a brief a coding harness could read without the
 * conversation — every part with its kind and technology, inside the boundary
 * it belongs to, what it is responsible for, how parts connect, why, and what
 * it changes about today.
 */
export function projectMarkdown(model: DesignModel): string {
  const parts = live(model.parts);
  const name = new Map(model.parts.map((part) => [part.id, part.name]));
  const lines: string[] = [`# ${model.title || 'Untitled design'}`];
  if (model.intent) lines.push('', model.intent);
  const entry = (part: DesignPart): void => {
    const facets = [part.kind && part.kind !== 'group' ? part.kind : null, part.technology && part.technology.name !== part.name ? part.technology.name : null];
    const said = facets.filter(Boolean).map((facet) => ` · ${facet}`).join('');
    lines.push(`- **${part.name}**${said}${part.role ? ` — ${part.role}` : ''}`);
    for (const duty of live(model.duties).filter((candidate) => candidate.part === part.id)) lines.push(`  - ${duty.text}`);
  };
  const groups = parts.filter((part) => part.kind === 'group');
  const outside = parts.filter((part) => part.kind !== 'group' && !part.within);
  if (outside.length) {
    lines.push('', '## System');
    outside.forEach(entry);
  }
  for (const group of groups) {
    const technology = group.technology && group.technology.name !== group.name ? ` · ${group.technology.name}` : '';
    lines.push('', `## ${group.name}${technology}`);
    if (group.role) lines.push('', group.role);
    for (const duty of live(model.duties).filter((candidate) => candidate.part === group.id)) lines.push('', `Responsible for: ${duty.text}`);
    const inside = parts.filter((part) => part.within === group.id);
    if (inside.length) lines.push('');
    inside.forEach(entry);
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
  if (entry.was && 'within' in entry.was) {
    const within = model.parts.find((part) => part.id === entry.id)?.within;
    if (within) return `Moves ${label} into ${partName(model, within)}`;
    return `Moves ${label} out of ${partName(model, entry.was.within!)}`;
  }
  if (entry.was && 'technology' in entry.was) {
    const now = model.parts.find((part) => part.id === entry.id)?.technology?.name;
    if (now) return entry.was.technology ? `Changes ${label} from ${entry.was.technology} to ${now}` : `Changes ${label} to ${now}`;
  }
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
