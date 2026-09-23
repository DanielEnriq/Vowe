import { randomUUID } from 'node:crypto';

import type { ContextNavigator } from '../context/context-navigator.js';
import { dedupeRefs, parseRef, type ContextRef } from '../context/refs.js';
import type {
  DelegatedAnswer,
  InvestigationAttachment,
  InvestigationInput,
  InvestigationStream,
  ObservationLlm,
  ProjectSessionLine,
  ReadOnlyToolset,
} from '../llm/observation-llm.js';
import type { EventStore } from '../store/event-store.js';
import type {
  ConversationEntry,
  InvestigationCheck,
  ProjectConversationEntry,
} from '../types/conversation.js';
import type { RunHandle, VoweRunRecorder } from '../execution/run-recorder.js';
import { tracedTool } from '../execution/traced-tools.js';
import { asModelContext, recentConversation } from '../product/conversation-context.js';
import { temperamentGuidance, type TemperamentProfile } from '../product/temperament.js';
import { InvestigationRecorder } from './investigation-recorder.js';

export interface DelegatedQuestionRunnerOptions {
  store: EventStore;
  navigator: ContextNavigator;
  investigator: ObservationLlm;
  /** How much recent L1 understanding to hand over. */
  recentNotes?: number;
  /**
   * Where this investigation's execution is recorded, when anywhere.
   *
   * Optional in the way everything else here is optional: without it the
   * investigation runs exactly as before and leaves a receipt but no audit
   * trail. With it, the model call, what it looked up and any reasoning the
   * provider exposed end up in the execution lane, linked to the answer.
   */
  runs?: VoweRunRecorder;
  /** How much durable conversation to hand over when none is supplied. */
  recentTurns?: number;
  /**
   * The developer's current temperament, read per question.
   *
   * A getter rather than a value because this is a live setting: someone who
   * moves a dial in Presence Studio expects their next question to land
   * differently, not their next launch. Returning `undefined` leaves the
   * shipped prompt exactly as written.
   */
  temperament?: () => TemperamentProfile | undefined;
  /**
   * Called as an investigation proceeds. Never awaited.
   *
   * A developer watching an answer arrive must not be able to slow it down, so
   * this is fire-and-forget in exactly the way `onAnswer` is.
   */
  onProgress?: (progress: InvestigationProgress) => void;
  onError?: (scope: string, error: unknown) => void;
  /**
   * A grounded answer has been produced and persisted.
   *
   * Matches the `onNote` / `onSurfaceUpdate` convention on `ObserverRunner`.
   * Called after the answer is already delivered, and deliberately not awaited:
   * whatever a listener decides to do with the result must not be able to delay
   * an answer somebody is waiting to hear.
   */
  onAnswer?: (result: DelegatedResult) => void;
}

/**
 * What an investigation is about: one session, or one project.
 *
 * The same shape the navigator takes, so a scope travels from the question
 * straight through to every tool call without being reinterpreted on the way.
 */
export type InvestigationScope = { sessionId: string } | { projectId: string };

/**
 * An investigation, as it happens.
 *
 * Emitted so the room a developer is waiting in can show the work proceeding
 * instead of a frozen column. Every `check` here is the same object that ends
 * up in the persisted `InvestigationReceipt`, so the live trail and the record
 * agree by construction rather than by convention — nothing appears live that
 * later turns out not to have been done.
 *
 * Not durable, and not meant to be: an investigation in flight has not
 * happened yet. The durable account is the receipt, written with the answer.
 */
export type InvestigationProgress =
  | { phase: 'started'; scope: InvestigationScope; at: string }
  | { phase: 'check'; scope: InvestigationScope; check: InvestigationCheck; at: string }
  /**
   * Vowe's own working, as the provider exposes it.
   *
   * Two provenances, one lane, because on screen they are one thing: the
   * model's exposed reasoning summaries, and any prose it emits while it is
   * still looking. Neither is the answer. The durable trace keeps them apart —
   * `reasoning_summary` and `model_output` are different rows — and this does
   * not, because a developer watching Vowe think does not need the distinction
   * and would be worse served by two columns of it.
   *
   * Absent where a provider exposes nothing. Private reasoning stays private
   * rather than being approximated.
   */
  | { phase: 'reasoning'; scope: InvestigationScope; delta: string; at: string }
  /** The written answer, as it is written. The same text the entry will hold. */
  | { phase: 'answer'; scope: InvestigationScope; delta: string; at: string }
  | {
      phase: 'finished';
      scope: InvestigationScope;
      /** The persisted answer, so a listener stops waiting on the right one. */
      entryId: string;
      failed: boolean;
      at: string;
    };

/**
 * Ceilings, because both of these reach a prompt.
 *
 * A composer that let someone attach forty files would produce a question no
 * model could answer well, and a roster of every session a repository ever ran
 * would crowd out the question itself.
 */
const MAX_ATTACHMENTS = 4;
const MAX_ROSTER = 12;

export interface DelegatedQuestion {
  sessionId: string;
  question: string;
  /**
   * References the developer attached to the question.
   *
   * Opened before the investigation starts, so they are genuinely part of the
   * answer rather than a decoration on the composer: their content reaches the
   * prompt and each one appears in the receipt as the first thing checked. A
   * ref that cannot be opened is reported as such and does not stop the
   * question.
   */
  contextRefs?: ContextRef[];
  /** What has been said out loud so far, oldest first. */
  liveConversation?: { speaker: 'user' | 'vo'; text: string }[];
  /**
   * The turn that asked this, when it is already in the conversation.
   *
   * Voice persists the user's utterance as it happens, so by the time the
   * assistant delegates it, the question is already a turn. Writing it again
   * here would be the same question twice in one conversation — so the caller
   * says which entry it is, and this writes none.
   */
  questionEntryId?: string;
}

/** A question about a repository and the work going on in it. */
export interface ProjectQuestion {
  projectId: string;
  question: string;
  /** See `DelegatedQuestion.contextRefs`. */
  contextRefs?: ContextRef[];
}

export interface ProjectDelegatedResult extends DelegatedAnswer {
  question: string;
  /** The persisted answer, as it appears in the project conversation. */
  entry: ProjectConversationEntry;
  failed: boolean;
}

export interface DelegatedResult extends DelegatedAnswer {
  /** What was asked, so a listener need not go back to the conversation for it. */
  question: string;
  /** The persisted full answer, as it appears in the session conversation. */
  entry: ConversationEntry;
  /**
   * The investigation could not be carried out, and the answer says so.
   *
   * Still a perfectly ordinary answer: it was persisted like any other and a
   * caller may render it as one. This is here so a caller that wants to show a
   * failure state does not have to match on the text of the message.
   */
  failed: boolean;
}

/**
 * Answers a technical question about a session by going and looking.
 *
 * This is the other consumer of the `ContextNavigator`, and it holds exactly
 * the same three read tools the observer does — no more. Two constraints make
 * that literal rather than aspirational:
 *
 *  - It is **read-only**. There is no `surface_update` here, and no control
 *    path of any kind. Asking Vowe a question still cannot reach the worker.
 *  - It is **independent**. Nothing here touches the observer's queue, so a
 *    long investigation never pauses trace ingestion, and a slow window never
 *    delays an answer.
 *
 * The answer comes back in two forms; see `DelegatedAnswer` for why.
 */
export class DelegatedQuestionRunner {
  private readonly store: EventStore;
  private readonly navigator: ContextNavigator;
  private readonly investigator: ObservationLlm;
  private readonly recentNotes: number;
  private readonly recentTurns: number;
  private readonly runs: VoweRunRecorder | null;
  private readonly onError: (scope: string, error: unknown) => void;
  private readonly onAnswer: (result: DelegatedResult) => void;
  private readonly temperament: () => TemperamentProfile | undefined;
  private readonly onProgress: (progress: InvestigationProgress) => void;

  constructor(options: DelegatedQuestionRunnerOptions) {
    this.store = options.store;
    this.navigator = options.navigator;
    this.investigator = options.investigator;
    this.recentNotes = options.recentNotes ?? 6;
    this.recentTurns = options.recentTurns ?? 12;
    this.runs = options.runs ?? null;
    this.onError = options.onError ?? (() => undefined);
    this.onAnswer = options.onAnswer ?? (() => undefined);
    this.temperament = options.temperament ?? (() => undefined);
    this.onProgress = options.onProgress ?? (() => undefined);
  }

  /** Progress reporting is a view concern and never fails the work. */
  private report(progress: InvestigationProgress): void {
    try {
      this.onProgress(progress);
    } catch (error) {
      this.onError('onProgress', error);
    }
  }

  private progressRecorder(scope: InvestigationScope): InvestigationRecorder {
    return new InvestigationRecorder({
      onCheck: (check) =>
        this.report({ phase: 'check', scope, check, at: new Date().toISOString() }),
    });
  }

  /**
   * The model's own output, on the same channel as its lookups.
   *
   * One progress stream rather than a second transport, because these are the
   * same event in the developer's terms — Vowe is working, and here is what it
   * is doing now. It stays as undurable as the rest of it: what lasts is the
   * `ConversationEntry` and its receipt, written once when the work is done.
   */
  private progressStream(scope: InvestigationScope): InvestigationStream {
    return {
      reasoning: (delta) =>
        this.report({ phase: 'reasoning', scope, delta, at: new Date().toISOString() }),
      answer: (delta) =>
        this.report({ phase: 'answer', scope, delta, at: new Date().toISOString() }),
    };
  }

  async answer(question: DelegatedQuestion): Promise<DelegatedResult> {
    const session = this.store.getSession(question.sessionId);
    const scope: InvestigationScope = { sessionId: question.sessionId };
    // The refs the investigation touches, and the order it touched them in.
    const recorder = this.progressRecorder(scope);
    this.report({ phase: 'started', scope, at: new Date().toISOString() });

    const temperament = this.temperament();
    const attachments = await this.openAttachments(question.contextRefs, recorder);

    const input: InvestigationInput = {
      sessionId: question.sessionId,
      question: question.question,
      task: session?.task ?? null,
      cwd: session?.cwd ?? null,
      ...(temperament ? { guidance: temperamentGuidance(temperament) } : {}),
      ...(attachments.length ? { attachments } : {}),
      recentNotes: this.store.getWindowNotes(question.sessionId, this.recentNotes),
      // What was actually said before, from the durable record — including
      // which of Vowe's own answers the developer never finished hearing. A
      // caller may override it, which is how a live session hands over the
      // turns of the call it is in the middle of.
      liveConversation:
        question.liveConversation ??
        asModelContext(
          recentConversation(this.store, question.sessionId, this.recentTurns),
        ),
    };

    let questionEntryId = question.questionEntryId ?? null;
    if (!questionEntryId) {
      const asked: ConversationEntry = {
        id: randomUUID(),
        sessionId: question.sessionId,
        at: new Date().toISOString(),
        role: 'user_question',
        text: question.question,
      };
      await this.store.appendConversationEntry(asked);
      questionEntryId = asked.id;
    }

    const run = this.runs?.begin({
      kind: 'investigation',
      sessionId: question.sessionId,
      ...(session?.projectId ? { projectId: session.projectId } : {}),
      ...(questionEntryId ? { triggerEntryId: questionEntryId } : {}),
    });

    let answer: DelegatedAnswer;
    let failed = false;
    let investigationFailure: unknown = null;
    // Measured around the investigation itself, so an answer can truthfully say
    // how long it took to go and look. Not telemetry: one number, one answer.
    const startedAt = Date.now();
    let durationMs = 0;
    try {
      answer = await this.investigator.investigate(
        input,
        this.readTools({ sessionId: question.sessionId }, recorder, run),
        run,
        this.progressStream(scope),
      );
    } catch (error) {
      this.onError('investigate', error);
      investigationFailure = error;
      failed = true;
      // Saying "I could not find out" is a usable answer. Saying nothing, in a
      // voice conversation, is not.
      const message =
        error instanceof Error ? error.message : String(error);
      answer = {
        spokenAnswer:
          'I could not look that up just now — something went wrong on my side.',
        fullAnswer: `The investigation failed before it could answer the question.\n\n${message}`,
        refs: [],
      };
    } finally {
      durationMs = Date.now() - startedAt;
    }

    const refs = dedupeRefs([...answer.refs, ...recorder.refs()]);
    const entry: ConversationEntry = {
      id: randomUUID(),
      sessionId: question.sessionId,
      at: new Date().toISOString(),
      role: 'companion_answer',
      text: answer.fullAnswer,
      refs,
      provenance: {
        eventIds: eventIdsFrom(refs),
      },
      // Only when something was actually looked at. An answer that opened
      // nothing — because no model is configured, or because the investigation
      // fell over before its first tool call — carries no receipt rather than
      // an empty one. There is nothing to show, and `Checked 0 things` is not a
      // thing to say.
      ...(recorder.length ? { investigation: recorder.receipt(durationMs) } : {}),
    };
    await this.store.appendConversationEntry(entry);
    // After the entry exists, so "which execution produced this answer?" is a
    // join rather than a guess. An investigation that fell over still produced
    // an answer the developer can read — it says so — and the run still ends
    // in `error`, because those are two different facts.
    if (run) {
      if (failed) {
        await run.failed(investigationFailure, { outputEntryId: entry.id });
      } else {
        await run.complete({ outputEntryId: entry.id });
      }
    }

    this.report({
      phase: 'finished',
      scope,
      entryId: entry.id,
      failed,
      at: new Date().toISOString(),
    });

    const result: DelegatedResult = {
      ...answer,
      question: question.question,
      refs,
      entry,
      failed,
    };
    try {
      this.onAnswer(result);
    } catch (error) {
      this.onError('onAnswer', error);
    }
    return result;
  }

  /**
   * Answer a question about a project rather than about one session.
   *
   * Same investigator, same tools, same receipt — the product rule is that
   * intelligence does not fork, and this method exists because what is handed
   * to the model differs, not because the model does.
   *
   * What it can see is deliberately narrower than a session question: the
   * repository, what Vowe has learned about it, and what Vowe understood about
   * each session in it. Not raw trace. A project answer reaches the trace the
   * way a reader does — by following one of its citations into the session it
   * came from.
   */
  async answerProject(question: ProjectQuestion): Promise<ProjectDelegatedResult> {
    const { projectId } = question;
    const project = this.store.getProject(projectId);
    const scope: InvestigationScope = { projectId };
    const recorder = this.progressRecorder(scope);
    this.report({ phase: 'started', scope, at: new Date().toISOString() });

    const asked: ProjectConversationEntry = {
      id: randomUUID(),
      projectId,
      at: new Date().toISOString(),
      role: 'user_question',
      text: question.question,
    };
    await this.store.appendProjectConversationEntry(asked);

    const run = this.runs?.begin({
      kind: 'investigation',
      projectId,
      triggerEntryId: asked.id,
    });

    const temperament = this.temperament();
    const attachments = await this.openAttachments(question.contextRefs, recorder);

    const input: InvestigationInput = {
      projectId,
      projectName: project?.name ?? projectId,
      repoRoot: project?.repoRoot ?? null,
      sessions: this.projectRoster(projectId),
      question: question.question,
      liveConversation: [],
      ...(temperament ? { guidance: temperamentGuidance(temperament) } : {}),
      ...(attachments.length ? { attachments } : {}),
    };

    let answer: DelegatedAnswer;
    let failed = false;
    let investigationFailure: unknown = null;
    const startedAt = Date.now();
    let durationMs = 0;
    try {
      answer = await this.investigator.investigate(
        input,
        this.readTools({ projectId }, recorder, run),
        run,
        this.progressStream(scope),
      );
    } catch (error) {
      this.onError('investigate:project', error);
      investigationFailure = error;
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      answer = {
        spokenAnswer:
          'I could not look that up just now — something went wrong on my side.',
        fullAnswer: `The investigation failed before it could answer the question.\n\n${message}`,
        refs: [],
      };
    } finally {
      durationMs = Date.now() - startedAt;
    }

    const refs = dedupeRefs([...answer.refs, ...recorder.refs()]);
    const entry: ProjectConversationEntry = {
      id: randomUUID(),
      projectId,
      at: new Date().toISOString(),
      role: 'companion_answer',
      text: answer.fullAnswer,
      refs,
      provenance: { eventIds: eventIdsFrom(refs) },
      ...(recorder.length ? { investigation: recorder.receipt(durationMs) } : {}),
    };
    await this.store.appendProjectConversationEntry(entry);

    if (run) {
      if (failed) {
        await run.failed(investigationFailure, { outputEntryId: entry.id });
      } else {
        await run.complete({ outputEntryId: entry.id });
      }
    }

    this.report({
      phase: 'finished',
      scope,
      entryId: entry.id,
      failed,
      at: new Date().toISOString(),
    });

    return { ...answer, question: question.question, refs, entry, failed };
  }

  /**
   * What is running in this project, most recently active first.
   *
   * A roster, not a transcript: enough for the model to know which sessions
   * exist and what each is doing, so that it can go and search the one the
   * question is really about.
   */
  private projectRoster(projectId: string): ProjectSessionLine[] {
    return this.store
      .listSessions()
      .filter((session) => session.projectId === projectId)
      .sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1))
      .slice(0, MAX_ROSTER)
      .map((session) => ({
        sessionId: session.id,
        label: session.displayLabel,
        status: session.status,
        currentActivity: session.semanticState?.currentActivity ?? null,
        branch: session.branch ?? null,
      }));
  }

  /**
   * Open what the developer attached, before anything else is looked at.
   *
   * This is what makes an attachment chip honest. The material is opened here,
   * goes into the prompt as material, and lands in the receipt as the first
   * things checked — so "I attached this" and "Vowe looked at this" are the
   * same claim rather than two hopeful ones. A ref that will not open is
   * skipped rather than failing the question.
   */
  private async openAttachments(
    refs: readonly ContextRef[] | undefined,
    recorder: InvestigationRecorder,
  ): Promise<InvestigationAttachment[]> {
    if (!refs?.length) return [];

    const opened: InvestigationAttachment[] = [];
    for (const ref of refs.slice(0, MAX_ATTACHMENTS)) {
      try {
        const result = await this.navigator.openContext({ ref });
        recorder.opened(ref, result);
        opened.push({
          refId: result.refId,
          label: result.kind,
          content: result.notFound ?? result.content,
        });
      } catch (error) {
        // An attachment that cannot be read is not a reason to refuse the
        // question; the answer simply will not be grounded in it.
        this.onError('attachment', error);
      }
    }
    return opened;
  }

  /**
   * The same three tools the observer gets. Nothing else.
   *
   * The recorder sits here rather than anywhere further out because this is the
   * only place that sees a tool call actually happen. Everything above it has
   * the model's account of what it did, which is a different thing.
   */
  private readTools(
    scope: InvestigationScope,
    recorder: InvestigationRecorder,
    run?: RunHandle,
  ): ReadOnlyToolset {
    // The call and its result are recorded beside the receipt, and for the same
    // reason: this is the only place that sees the call actually happen.
    const traced = <T>(
      name: string,
      args: unknown,
      work: () => Promise<T>,
    ): Promise<T> => tracedTool(run, name, args, work);

    return {
      searchContext: async (input) =>
        traced('search_context', input, async () => {
          const hits = await this.navigator.searchContext({
            ...scope,
            query: input.query,
            ...(input.sources ? { sources: input.sources } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          recorder.searched(input.query, input.sources, hits);
          return hits;
        }),
      openContext: async (input) =>
        traced('open_context', input, async () => {
          const result = await this.navigator.openContext({
            ref: input.ref,
            ...(input.depth ? { depth: input.depth } : {}),
          });
          // The address that was asked for, which is what the label describes.
          // A model can hand back nonsense, in which case there is nothing to
          // name and the check says only that a reference was followed.
          recorder.opened(parseRef(input.ref), result);
          return result;
        }),
      getDiff: async (input) =>
        traced('get_diff', input, async () => {
          const diff = await this.navigator.getDiff({
            ...scope,
            ...(input.path ? { path: input.path } : {}),
            ...(input.around ? { around: input.around } : {}),
          });
          recorder.diffed({
            kind: 'diff',
            ...scope,
            ...(input.path ? { path: input.path } : {}),
          });
          return diff;
        }),
    };
  }
}

/**
 * The evidence inspector resolves event ids, so the entry carries a narrowing
 * of its refs alongside the refs themselves. Nothing is lost by it any more.
 */
function eventIdsFrom(refs: ContextRef[]): string[] {
  return refs
    .filter(
      (ref): ref is Extract<ContextRef, { kind: 'event' | 'transcript' }> =>
        ref.kind === 'event' || ref.kind === 'transcript',
    )
    .map((ref) => ref.eventId);
}
