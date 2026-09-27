import { randomUUID } from 'node:crypto';

import type { ContextNavigator } from '../context/context-navigator.js';
import { dedupeRefs, formatRef, type ContextRef } from '../context/refs.js';
import { openAttachments } from '../delegation/attachments.js';
import { consultedQuestion, InvestigationRecorder } from '../delegation/investigation-recorder.js';
import type { RunHandle, VoweRunRecorder } from '../execution/run-recorder.js';
import { tracedTool } from '../execution/traced-tools.js';
import { temperamentGuidance, type TemperamentProfile } from '../product/temperament.js';
import type { EventStore } from '../store/event-store.js';
import type { InvestigationCheck } from '../types/conversation.js';
import { readRepositoryBasis } from '../projects/repository-basis.js';
import type { ConsultationFinding, RepositoryConsultant } from './consultation.js';
import { groundDesignLinks } from './design-links.js';
import { placeParts, tidyLayout, type DesignLayout } from './layout.js';
import {
  applyOps,
  describeCanvasMove,
  diffModels,
  elementLabel,
  EMPTY_MODEL,
  find,
  newMoveId,
  projectMarkdown,
  same,
  type DesignElementKind,
  type DesignModel,
  type DesignMove,
  type DesignOp,
  type RepositoryBasis,
} from './model.js';
import type {
  DesignCapabilities,
  DesignFinding,
  DesignFocus,
  DesignStream,
  DesignTurn,
  DesignTurnResult,
  SystemDesignAgent,
} from './system-design-agent.js';
import type {
  Design,
  DesignEntry,
  DesignRevision,
  DesignStore,
  DesignSummary,
} from './types.js';

/**
 * A Studio turn, as it happens.
 *
 * Not durable, and not meant to be — exactly as `InvestigationProgress` is not.
 * The durable account is the reply, its receipt and the revision, committed
 * together when the turn ends. Every `check` here is the same object that ends
 * up in that receipt, so what was shown live and what was kept agree by
 * construction.
 *
 * Its own union rather than new phases on `InvestigationProgress`: Session and
 * Project rooms never need to learn to ignore a design being rewritten, and a
 * Studio turn ends in a revision, which an investigation never does.
 */
export type StudioProgress = { designId: string; at: string } & (
  | { phase: 'started'; entryId: string }
  | { phase: 'message'; delta: string }
  | { phase: 'reasoning'; delta: string }
  /**
   * A consultation is under way; `activity` is what the harness is doing now,
   * `partId` the part it is checking, when the agent or the focus says.
   */
  | { phase: 'consulting'; question: string; activity?: string; partId?: string }
  | { phase: 'check'; check: InvestigationCheck }
  /** The design with the move so far applied, and where its parts would sit. */
  | { phase: 'model'; model: DesignModel; layout: DesignLayout }
  | {
      phase: 'finished';
      /** The persisted reply, absent when the turn was cancelled. */
      entryId: string | null;
      revisionId: string | null;
      failed: boolean;
      cancelled: boolean;
    }
);

export interface StudioServiceOptions {
  store: DesignStore & Pick<EventStore, 'getProject'>;
  agent: SystemDesignAgent;
  consultant: RepositoryConsultant;
  /** Only to open what the developer attached. Studio has no search tools. */
  attachments: Pick<ContextNavigator, 'openContext'>;
  runs?: VoweRunRecorder;
  temperament?: () => TemperamentProfile | undefined;
  onProgress?: (progress: StudioProgress) => void;
  onError?: (scope: string, error: unknown) => void;
  /** Consultations one turn may make. Beyond it, the capability refuses. */
  consultationsPerTurn?: number;
  /** How much recent conversation the agent is handed. */
  recentTurns?: number;
  /** Which checkout a consultation reads. Injected for tests. */
  repositoryBasis?: (repoRoot: string) => Promise<RepositoryBasis>;
}

export interface DesignView {
  design: Design;
  entries: DesignEntry[];
  revisions: DesignRevision[];
  /** Where each part sits; view state, not history. */
  layout: DesignLayout;
  /** A turn is running right now, in this process. */
  inFlight: boolean;
}

export interface DesignTurnOutcome {
  entry: DesignEntry | null;
  revision: DesignRevision | null;
  failed: boolean;
  cancelled: boolean;
}

/**
 * Studio's orchestration and persistence. No design judgement lives here.
 *
 * It loads a design's state, opens attachments, hands the `SystemDesignAgent`
 * its one capability, records the run, checks what the agent proposes and
 * commits the reply and revision together. What to say, whether to consult and
 * how the design should change are the agent's alone.
 *
 * What it can reach is the point. It holds a design store, a project lookup, a
 * way to open an attached ref, and a repository consultant — no session
 * registry, no adapter, no control channel, no project memory, no live bridge.
 * A design conversation therefore cannot instruct a worker, and exploring an
 * idea here cannot become something Vowe believes about the project.
 */
export class StudioService {
  private readonly store: StudioServiceOptions['store'];
  private readonly agent: SystemDesignAgent;
  private readonly consultant: RepositoryConsultant;
  private readonly navigator: Pick<ContextNavigator, 'openContext'>;
  private readonly runs: VoweRunRecorder | null;
  private readonly temperament: () => TemperamentProfile | undefined;
  private readonly onProgress: (progress: StudioProgress) => void;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly consultationsPerTurn: number;
  private readonly recentTurns: number;
  private readonly repositoryBasis: (repoRoot: string) => Promise<RepositoryBasis>;
  /** Designs with a turn running, and how to stop it. */
  private readonly turns = new Map<string, AbortController>();
  /** A glance at a canvas move in flight; superseded by anything newer. */
  private readonly considering = new Map<string, AbortController>();

  constructor(options: StudioServiceOptions) {
    this.store = options.store;
    this.agent = options.agent;
    this.consultant = options.consultant;
    this.navigator = options.attachments;
    this.runs = options.runs ?? null;
    this.temperament = options.temperament ?? (() => undefined);
    this.onProgress = options.onProgress ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.consultationsPerTurn = options.consultationsPerTurn ?? 2;
    this.recentTurns = options.recentTurns ?? 12;
    this.repositoryBasis = options.repositoryBasis ?? ((root) => readRepositoryBasis(root));
  }

  async createDesign(projectId: string): Promise<Design> {
    if (!this.store.getProject(projectId)) throw new Error(`No project ${projectId}.`);
    return this.store.createDesign({
      id: randomUUID(),
      projectId,
      createdAt: new Date().toISOString(),
    });
  }

  /** Most recently active first. */
  listDesigns(projectId: string): DesignSummary[] {
    return this.store
      .listDesigns(projectId)
      .map((design) =>
        summarize(design, this.store.getDesignEntries(design.id), this.store.getDesignRevisions(design.id), this.store.getDesignLayout(design.id)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getDesign(designId: string): DesignView | null {
    const design = this.store.getDesign(designId);
    if (!design) return null;
    return {
      design,
      entries: this.store.getDesignEntries(designId),
      revisions: this.store.getDesignRevisions(designId),
      layout: this.store.getDesignLayout(designId),
      inFlight: this.turns.has(designId),
    };
  }

  /** Stop a running turn. False when nothing was running. */
  cancel(designId: string): boolean {
    const turn = this.turns.get(designId);
    if (!turn) return false;
    turn.abort();
    return true;
  }

  async converse(request: {
    designId: string;
    message: string;
    contextRefs?: ContextRef[];
    /** What the developer has selected on the canvas. */
    focus?: { kind: DesignElementKind; id: string };
    /** How the developer chose to begin; honoured on a design's first message. */
    start?: 'code' | 'idea';
  }): Promise<DesignTurnOutcome> {
    const { designId } = request;
    const message = request.message.trim();
    if (!message) throw new Error('Nothing to say.');
    const design = this.store.getDesign(designId);
    if (!design) throw new Error(`No design ${designId}.`);
    const project = this.store.getProject(design.projectId);
    if (!project) throw new Error(`No project ${design.projectId}.`);
    if (this.turns.has(designId)) {
      throw new Error('Vowe is still working on the last message in this design.');
    }

    const abort = new AbortController();
    this.turns.set(designId, abort);
    this.considering.get(designId)?.abort();
    try {
      // What came before this turn, read before the turn itself is written.
      const history = this.store.getDesignEntries(designId);
      const revisions = this.store.getDesignRevisions(designId);
      const layout = this.store.getDesignLayout(designId);
      const asked = await this.store.appendDesignEntry({
        id: randomUUID(),
        designId,
        at: new Date().toISOString(),
        role: 'user_message',
        text: message,
      });
      this.report(designId, { phase: 'started', entryId: asked.id });

      const run = this.runs?.begin({
        kind: 'studio',
        projectId: design.projectId,
        triggerEntryId: asked.id,
        metadata: { designId },
      });
      const recorder = new InvestigationRecorder({
        onCheck: (check) => this.report(designId, { phase: 'check', check }),
      });
      const temperament = this.temperament();
      const attachments = await openAttachments(this.navigator, request.contextRefs, recorder, this.onError);
      const current = revisions[revisions.length - 1] ?? null;
      const base = current?.model ?? EMPTY_MODEL;
      const focus = request.focus ? focusIn(base, request.focus) : undefined;
      const start = request.start && history.length === 0 ? request.start : undefined;

      const input: DesignTurn = {
        projectName: project.name,
        message,
        design: current
          ? { model: base, revision: current.ord, ...(current.model ? {} : { legacyDocument: current.document }) }
          : null,
        moves: movesIn(revisions).slice(-this.recentTurns),
        ...(focus ? { focus } : {}),
        ...(start ? { start } : {}),
        conversation: conversationOf(history).slice(-this.recentTurns),
        findings: findingsIn(history),
        ...(attachments.length ? { attachments } : {}),
        ...(temperament ? { guidance: temperamentGuidance(temperament) } : {}),
        signal: abort.signal,
      };

      const startedAt = Date.now();
      const receipt = () =>
        recorder.length
          ? { refs: dedupeRefs(recorder.refs()), investigation: recorder.receipt(Date.now() - startedAt) }
          : {};
      // The checkout the latest consultation read: what today is established against.
      const checked: { basis?: RepositoryBasis } = {};
      const resolveMove = moveResolver(revisions);

      let result: DesignTurnResult;
      try {
        result = await this.agent.turn(
          input,
          this.capabilities(designId, project.repoRoot, abort.signal, recorder, run, focus, checked),
          run,
          this.stream(designId, (ops) => {
            const preview = applyOps(base, ops, { resolveMove, ...checked }).model;
            return { model: preview, layout: placeParts(layout, preview) };
          }),
        );
        if (!result.reply.trim() && !result.move) {
          throw new Error('The design agent returned an empty turn.');
        }
      } catch (error) {
        if (abort.signal.aborted) {
          await run?.cancel();
          this.report(designId, { phase: 'finished', entryId: null, revisionId: null, failed: false, cancelled: true });
          return { entry: null, revision: null, failed: false, cancelled: true };
        }
        // Saying "I could not finish" is a usable turn; silence is not. The
        // design is left exactly as it was.
        this.onError('studio:turn', error);
        const reason = error instanceof Error ? error.message : String(error);
        const committed = await this.store.commitDesignTurn({
          id: randomUUID(),
          designId,
          at: new Date().toISOString(),
          role: 'companion_message',
          text: `I couldn't finish thinking that through — something went wrong on my side. The design is unchanged.\n\n${reason}`,
          ...receipt(),
        });
        await run?.failed(error, { outputEntryId: committed.entry.id });
        this.report(designId, { phase: 'finished', entryId: committed.entry.id, revisionId: null, failed: true, cancelled: false });
        return { entry: committed.entry, revision: null, failed: true, cancelled: false };
      }

      // Only what this design actually checked may be cited as evidence.
      const allowed = dedupeRefs([...refsOf(history), ...recorder.refs()]);
      // The reason as the agent gave it, or none — never a stand-in. A missing
      // reason is itself part of the record of how the design changed.
      const summary = result.move?.summary.trim() ?? '';
      const entry: DesignEntry = {
        id: randomUUID(),
        designId,
        at: new Date().toISOString(),
        role: 'companion_message',
        text: groundDesignLinks(result.reply.trim() || summary || 'I revised the design.', allowed),
        ...receipt(),
      };
      const changed = result.move?.ops.length
        ? this.changeFrom(base, result.move.ops, { resolveMove, ...checked }, allowed)
        : null;
      const move: DesignMove | null = changed
        ? { id: newMoveId(), ops: changed.ops, summary, author: 'vowe', via: 'conversation' }
        : null;
      const committed = await this.store.commitDesignTurn(
        entry,
        changed && move
          ? {
              id: randomUUID(),
              designId,
              at: entry.at,
              document: projectMarkdown(changed.model),
              summary,
              entryId: entry.id,
              model: changed.model,
              move,
            }
          : undefined,
        changed ? placeParts(layout, changed.model) : undefined,
      );
      await run?.complete({ outputEntryId: committed.entry.id });
      this.report(designId, {
        phase: 'finished',
        entryId: committed.entry.id,
        revisionId: committed.revision?.id ?? null,
        failed: false,
        cancelled: false,
      });
      return { entry: committed.entry, revision: committed.revision ?? null, failed: false, cancelled: false };
    } finally {
      this.turns.delete(designId);
    }
  }

  /**
   * The developer changed the design on the canvas: the same ops Vowe would
   * emit for the same intent, committed as a move of their own.
   *
   * No model turn. The thread records it in plain words, the next turn sees
   * it, and — if the move means something rather than renaming a part — Vowe
   * takes a quiet look and may leave one note on the canvas. It never replies
   * in the conversation.
   */
  async manipulate(designId: string, ops: DesignOp[]): Promise<DesignTurnOutcome> {
    const design = this.store.getDesign(designId);
    if (!design) throw new Error(`No design ${designId}.`);
    const project = this.store.getProject(design.projectId);
    if (!project) throw new Error(`No project ${design.projectId}.`);
    if (this.turns.has(designId)) throw new Error('Vowe is still working on the last message in this design.');
    if (!ops.length) throw new Error('Nothing to change.');

    const revisions = this.store.getDesignRevisions(designId);
    const current = revisions[revisions.length - 1];
    if (!current?.model) throw new Error('There is no system drawn to change yet.');
    const history = this.store.getDesignEntries(designId);
    const resolveMove = moveResolver(revisions);
    const changed = this.changeFrom(current.model, ops, { resolveMove }, dedupeRefs(refsOf(history)));
    if (!changed) return { entry: null, revision: null, failed: false, cancelled: false };

    const reverted = ops.length === 1 && ops[0]!.op === 'revert'
      ? revisions.find((revision) => revision.move?.id === (ops[0] as { move: string }).move)?.move?.summary
      : undefined;
    const summary = describeCanvasMove(current.model, changed.model, reverted);
    const at = new Date().toISOString();
    const entry: DesignEntry = { id: randomUUID(), designId, at, role: 'developer_move', text: summary };
    const move: DesignMove = { id: newMoveId(), ops: changed.ops, summary, author: 'developer', via: 'canvas' };
    this.considering.get(designId)?.abort();
    const committed = await this.store.commitDesignTurn(
      entry,
      { id: randomUUID(), designId, at, document: projectMarkdown(changed.model), summary, entryId: entry.id, model: changed.model, move },
      placeParts(this.store.getDesignLayout(designId), changed.model),
    );

    const diff = diffModels(current.model, changed.model);
    const cosmetic = diff.entries.every((entry) => entry.change === 'changed' && entry.fields!.every((field) => field === 'name'));
    if (!cosmetic) void this.consider(designId, project.name, current.model, changed.model, move, history);
    return { entry: committed.entry, revision: committed.revision ?? null, failed: false, cancelled: false };
  }

  /** The developer placed a part by hand. View state: no move, no history. */
  async setLayout(designId: string, layout: DesignLayout): Promise<void> {
    if (!this.store.getDesign(designId)) throw new Error(`No design ${designId}.`);
    const clean: DesignLayout = {};
    for (const [id, slot] of Object.entries(layout)) {
      if (!Number.isInteger(slot.row) || !Number.isInteger(slot.col)) continue;
      clean[id] = { row: slot.row, col: slot.col, ...(slot.pinned ? { pinned: true as const } : {}) };
    }
    await this.store.saveDesignLayout(designId, clean);
  }

  /** Lay out everything the developer has not pinned, again. */
  async tidy(designId: string): Promise<void> {
    const revisions = this.store.getDesignRevisions(designId);
    const model = revisions[revisions.length - 1]?.model;
    if (!model) return;
    await this.store.saveDesignLayout(designId, tidyLayout(this.store.getDesignLayout(designId), model));
  }

  /**
   * Apply ops and keep what landed, with citations checked: a part's reasoning
   * and refs may only point at what this design actually looked at. Null when
   * nothing changed.
   */
  private changeFrom(
    base: DesignModel,
    ops: readonly DesignOp[],
    options: Parameters<typeof applyOps>[2],
    allowed: readonly ContextRef[],
  ): { model: DesignModel; ops: DesignOp[] } | null {
    const applied = applyOps(base, ops, options);
    if (applied.rejected.length) {
      this.onError('studio:move', new Error(`Refused ${applied.rejected.length} op(s): ${applied.rejected.map((item) => item.reason).join(' ')}`));
    }
    const refused = new Set(applied.rejected.map((item) => item.op));
    const model = groundModel(applied.model, allowed);
    if (same(model, base)) return null;
    return { model, ops: ops.filter((op) => !refused.has(op)) };
  }

  /** A glance at a canvas move. Best-effort: a failure is logged, never shown. */
  private async consider(
    designId: string,
    projectName: string,
    before: DesignModel,
    after: DesignModel,
    move: DesignMove,
    history: readonly DesignEntry[],
  ): Promise<void> {
    const abort = new AbortController();
    this.considering.set(designId, abort);
    try {
      const note = await this.agent.consider({
        projectName,
        before,
        after,
        move,
        conversation: conversationOf(history).slice(-this.recentTurns),
        signal: abort.signal,
      });
      if (!note || abort.signal.aborted || !note.text.trim()) return;
      const on = find(after, note.on);
      if (!on || on.element.retired) return;
      const entry: DesignEntry = {
        id: randomUUID(),
        designId,
        at: new Date().toISOString(),
        role: 'companion_note',
        text: note.text.trim().slice(0, 240),
        anchor: { moveId: move.id, on: note.on },
      };
      await this.store.commitDesignTurn(entry);
    } catch (error) {
      if (!abort.signal.aborted) this.onError('studio:consider', error);
    } finally {
      if (this.considering.get(designId) === abort) this.considering.delete(designId);
    }
  }

  /**
   * The agent's one way to touch the world, wrapped where it actually runs.
   *
   * Traced into the run and receipted as it completes — not from the agent's
   * account of what it did — capped per turn, and bound to the turn's abort.
   * Each consultation also records which checkout it read, so what the design
   * then says exists today says when and where.
   */
  private capabilities(
    designId: string,
    repoRoot: string,
    signal: AbortSignal,
    recorder: InvestigationRecorder,
    run: RunHandle | undefined,
    focus: DesignFocus | undefined,
    checked: { basis?: RepositoryBasis },
  ): DesignCapabilities {
    let used = 0;
    return {
      consultRepository: async ({ question, why, part }) => {
        if (used >= this.consultationsPerTurn) {
          return {
            status: 'failed',
            reason: `This turn has already checked the repository ${this.consultationsPerTurn} times; continue with what is known and say what remains unchecked.`,
            provider: this.consultant.provider,
            durationMs: 0,
          } satisfies ConsultationFinding;
        }
        used += 1;
        const partId = part ?? (focus?.kind === 'part' ? focus.id : undefined);
        const where = partId ? { partId } : {};
        this.report(designId, { phase: 'consulting', question, ...where });
        const basis = await this.repositoryBasis(repoRoot).catch(() => undefined);
        const finding = await tracedTool(run, 'consult_repository', { question, why, ...(part ? { part } : {}) }, () =>
          this.consultant.consult({
            repoRoot,
            question,
            context: why,
            signal,
            onActivity: ({ label }) =>
              this.report(designId, { phase: 'consulting', question, activity: label, ...where }),
          }),
        );
        if (finding.status === 'answered' && basis) checked.basis = basis;
        recorder.consulted(question, finding);
        return finding;
      },
    };
  }

  private stream(
    designId: string,
    preview: (ops: DesignOp[]) => { model: DesignModel; layout: DesignLayout },
  ): DesignStream {
    return {
      message: (delta) => this.report(designId, { phase: 'message', delta }),
      reasoning: (delta) => this.report(designId, { phase: 'reasoning', delta }),
      move: (ops) => this.report(designId, { phase: 'model', ...preview(ops) }),
    };
  }

  /** Progress is a view concern and never fails the work. */
  private report(designId: string, progress: DistributiveOmit<StudioProgress, 'designId' | 'at'>): void {
    try {
      this.onProgress({ designId, at: new Date().toISOString(), ...progress } as StudioProgress);
    } catch (error) {
      this.onError('studio:progress', error);
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Earlier grounded repository findings, read back from the receipts that hold them. */
function findingsIn(entries: readonly DesignEntry[]): DesignFinding[] {
  return entries.flatMap((entry) =>
    (entry.investigation?.checks ?? [])
      .filter((check) => check.kind === 'consult' && check.finding)
      .map((check) => ({
        question: consultedQuestion(check),
        answer: check.finding!,
        refs: check.refs.map(formatRef),
        at: entry.at,
      })),
  );
}

/** What "this" means, resolved from the model; an element no longer drawn is no focus. */
function focusIn(model: DesignModel, focus: { kind: DesignElementKind; id: string }): DesignFocus | undefined {
  const found = find(model, focus.id);
  if (!found || found.kind !== focus.kind || found.element.retired) return undefined;
  return { kind: focus.kind, id: focus.id, label: elementLabel(model, focus.kind, focus.id) };
}

function movesIn(revisions: readonly DesignRevision[]): DesignTurn['moves'] {
  return revisions.flatMap((revision) =>
    revision.move ? [{ id: revision.move.id, author: revision.move.author, via: revision.move.via, summary: revision.move.summary }] : [],
  );
}

/** An earlier move by id, as the design before and after it — for revert. */
function moveResolver(revisions: readonly DesignRevision[]) {
  return (moveId: string): { before: DesignModel; after: DesignModel } | null => {
    const index = revisions.findIndex((revision) => revision.move?.id === moveId);
    if (index === -1) return null;
    return { before: revisions[index - 1]?.model ?? EMPTY_MODEL, after: revisions[index]!.model! };
  };
}

/**
 * The thread as the agent reads it. What the developer did on the canvas and
 * what Vowe noted there are part of the conversation, said as what they were.
 */
function conversationOf(entries: readonly DesignEntry[]): DesignTurn['conversation'] {
  return entries.map((entry) => {
    switch (entry.role) {
      case 'user_message':
        return { speaker: 'developer' as const, text: entry.text };
      case 'developer_move':
        return { speaker: 'developer' as const, text: `[Changed the design on the canvas] ${entry.text}` };
      case 'companion_note':
        return { speaker: 'vowe' as const, text: `[Noted on the canvas, on ${entry.anchor?.on ?? 'the design'}] ${entry.text}` };
      default:
        return { speaker: 'vowe' as const, text: entry.text };
    }
  });
}

/**
 * A part's reasoning and refs keep only citations this design checked.
 *
 * A model shortens what it was given — `packages/core/x.ts#36` for
 * `repo:/abs/packages/core/x.ts#36` — so a ref is resolved onto the checked
 * file it names and stored in canonical form. It can only ever resolve to a
 * file a consultation or attachment actually returned; anything else is gone.
 */
function groundModel(model: DesignModel, allowed: readonly ContextRef[]): DesignModel {
  const files = [...new Set(allowed.flatMap((ref) => (ref.kind === 'repo' ? [ref.path] : [])))];
  const exact = new Set(allowed.map(formatRef));
  const resolve = (cited: string): string | null => {
    if (exact.has(cited)) return cited;
    const bare = cited.replace(/^ref:/, '').replace(/^repo:/, '');
    const [target, line] = bare.split('#') as [string, string | undefined];
    const path = files.find((file) => file === target || (target.length > 0 && !target.startsWith('/') && file.endsWith(`/${target}`)));
    if (!path) return null;
    const number = line && /^\d+$/.test(line) ? Number(line) : undefined;
    return formatRef({ kind: 'repo', path, ...(number ? { line: number } : {}) });
  };
  return {
    ...model,
    parts: model.parts.map((part) => {
      const next = { ...part };
      if (part.detail) next.detail = groundDesignLinks(part.detail, allowed);
      if (part.refs) {
        const refs = [...new Set(part.refs.map(resolve).filter((ref): ref is string => ref !== null))];
        if (refs.length) next.refs = refs;
        else delete next.refs;
      }
      return next;
    }),
  };
}

/** Every ref this design's earlier turns were grounded in. */
function refsOf(entries: readonly DesignEntry[]): ContextRef[] {
  return entries.flatMap((entry) => entry.investigation?.checks.flatMap((check) => check.refs) ?? []);
}

function summarize(design: Design, entries: DesignEntry[], revisions: DesignRevision[], layout: DesignLayout): DesignSummary {
  const current = revisions[revisions.length - 1];
  const heading = current?.model?.title.trim() || current?.document.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const opening = entries.find((entry) => entry.role === 'user_message')?.text.trim();
  const title = heading || (opening ? firstLine(opening) : 'New design');
  const last = entries[entries.length - 1]?.at ?? design.createdAt;
  const parts = (current?.model?.parts ?? []).filter((part) => !part.retired);
  const outline = parts.flatMap((part) => (layout[part.id] ? [{ row: layout[part.id]!.row, col: layout[part.id]!.col }] : []));
  return {
    ...design,
    title,
    intent: current?.model?.intent ?? '',
    updatedAt: last,
    revisions: revisions.length,
    parts: parts.length,
    outline,
  };
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
}
