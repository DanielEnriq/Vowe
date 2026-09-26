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
import type { ConsultationFinding, RepositoryConsultant } from './consultation.js';
import { groundDesignLinks } from './design-links.js';
import type {
  DesignCapabilities,
  DesignFinding,
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
  /** A consultation is under way; `activity` is what the harness is doing now. */
  | { phase: 'consulting'; question: string; activity?: string }
  | { phase: 'check'; check: InvestigationCheck }
  /** The whole revised document so far. */
  | { phase: 'design'; document: string }
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
}

export interface DesignView {
  design: Design;
  entries: DesignEntry[];
  revisions: DesignRevision[];
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
  /** Designs with a turn running, and how to stop it. */
  private readonly turns = new Map<string, AbortController>();

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
      .map((design) => summarize(design, this.store.getDesignEntries(design.id), this.store.getDesignRevisions(design.id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getDesign(designId: string): DesignView | null {
    const design = this.store.getDesign(designId);
    if (!design) return null;
    return {
      design,
      entries: this.store.getDesignEntries(designId),
      revisions: this.store.getDesignRevisions(designId),
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
    try {
      // What came before this turn, read before the turn itself is written.
      const history = this.store.getDesignEntries(designId);
      const revisions = this.store.getDesignRevisions(designId);
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

      const input: DesignTurn = {
        projectName: project.name,
        message,
        design: current ? { document: current.document, revision: current.ord } : null,
        conversation: history.slice(-this.recentTurns).map((entry) => ({
          speaker: entry.role === 'user_message' ? 'developer' : 'vowe',
          text: entry.text,
        })),
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

      let result: DesignTurnResult;
      try {
        result = await this.agent.turn(
          input,
          this.capabilities(designId, project.repoRoot, abort.signal, recorder, run),
          run,
          this.stream(designId),
        );
        if (!result.reply.trim() && !result.revision) {
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
      const document = result.revision?.document.trim();
      // The reason as the agent gave it, or none — never a stand-in. A missing
      // reason is itself part of the record of how the design changed.
      const summary = result.revision?.summary.trim() ?? '';
      const entry: DesignEntry = {
        id: randomUUID(),
        designId,
        at: new Date().toISOString(),
        role: 'companion_message',
        text: groundDesignLinks(result.reply.trim() || summary || 'I revised the design.', allowed),
        ...receipt(),
      };
      const committed = await this.store.commitDesignTurn(
        entry,
        document
          ? {
              id: randomUUID(),
              designId,
              at: entry.at,
              document: groundDesignLinks(document, allowed),
              summary,
              entryId: entry.id,
            }
          : undefined,
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
   * The agent's one way to touch the world, wrapped where it actually runs.
   *
   * Traced into the run and receipted as it completes — not from the agent's
   * account of what it did — capped per turn, and bound to the turn's abort.
   */
  private capabilities(
    designId: string,
    repoRoot: string,
    signal: AbortSignal,
    recorder: InvestigationRecorder,
    run: RunHandle | undefined,
  ): DesignCapabilities {
    let used = 0;
    return {
      consultRepository: async ({ question, why }) => {
        if (used >= this.consultationsPerTurn) {
          return {
            status: 'failed',
            reason: `This turn has already checked the repository ${this.consultationsPerTurn} times; continue with what is known and say what remains unchecked.`,
            provider: this.consultant.provider,
            durationMs: 0,
          } satisfies ConsultationFinding;
        }
        used += 1;
        this.report(designId, { phase: 'consulting', question });
        const finding = await tracedTool(run, 'consult_repository', { question, why }, () =>
          this.consultant.consult({
            repoRoot,
            question,
            context: why,
            signal,
            onActivity: ({ label }) =>
              this.report(designId, { phase: 'consulting', question, activity: label }),
          }),
        );
        recorder.consulted(question, finding);
        return finding;
      },
    };
  }

  private stream(designId: string): DesignStream {
    return {
      message: (delta) => this.report(designId, { phase: 'message', delta }),
      reasoning: (delta) => this.report(designId, { phase: 'reasoning', delta }),
      design: (document) => this.report(designId, { phase: 'design', document }),
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

/** Every ref this design's earlier turns were grounded in. */
function refsOf(entries: readonly DesignEntry[]): ContextRef[] {
  return entries.flatMap((entry) => entry.investigation?.checks.flatMap((check) => check.refs) ?? []);
}

function summarize(design: Design, entries: DesignEntry[], revisions: DesignRevision[]): DesignSummary {
  const current = revisions[revisions.length - 1];
  const heading = current?.document.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const opening = entries.find((entry) => entry.role === 'user_message')?.text.trim();
  const title = heading || (opening ? firstLine(opening) : 'New design');
  const last = entries[entries.length - 1]?.at ?? design.createdAt;
  return { ...design, title, updatedAt: last, revisions: revisions.length };
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line;
}
