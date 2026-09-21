import { randomUUID } from 'node:crypto';

import type { RunHandle, VoweRunRecorder } from '../execution/run-recorder.js';
import type { EventStore } from '../store/event-store.js';
import type {
  ConversationEntry,
  ConversationRole,
} from '../types/conversation.js';

/** What the renderer measured about the audio it actually played. */
export type PlaybackReport =
  | { kind: 'started'; at: string }
  /** Playback ended. `audioMs` is how long was audible, as measured. */
  | { kind: 'stopped'; at: string; audioMs?: number }
  /** The connection went away while audio was in flight. */
  | { kind: 'lost'; at: string };

export interface LiveConversationRecorderOptions {
  store: EventStore;
  /** The Vowe session this conversation belongs to. */
  sessionId: string;
  /** The provider's session id. Half of a turn's stable identity. */
  liveSessionId: string;
  provider: string;
  model?: string;
  /** Vo's standing instructions, recorded as the run's input. */
  instructions?: string;
  runs?: VoweRunRecorder;
  /** How long a speaker may be silent before their turn is considered over. */
  turnSilenceMs?: number;
  onError?: (scope: string, error: unknown) => void;
}

interface OpenTurn {
  speaker: 'user' | 'vo';
  text: string;
  firstStartMs: number;
  lastEndMs: number;
  /** Set when this turn is Vo speaking an answer that is already persisted. */
  deliversEntryId: string | null;
  run: RunHandle | null;
  playbackStartedAt: string | null;
  playbackEndedAt: string | null;
  audioMs: number | undefined;
  lost: boolean;
  /** The user began speaking here, on the provider's session timeline. */
  talkedOverAtMs: number | undefined;
}

/** A spoken turn already written, still able to learn how its audio ended. */
interface RecentDelivery {
  deliveryId: string;
  interrupted: boolean;
}

const VOWE_TURN: ConversationRole = 'companion_message';
const USER_TURN: ConversationRole = 'user_message';

/**
 * Where a live voice conversation becomes durable history.
 *
 * One component rather than a database write in every event handler, because
 * the hard parts are not the writes — they are the correlations between them:
 * which fragments are one turn, which turn is the delivery of an answer that is
 * already persisted, and which turn cut off the one before it. Scattering that
 * across handlers is how a conversation ends up stored twice, or half-stored.
 *
 * **Turns are assembled, not received.** The provider streams transcript
 * fragments and says plainly that they "do not define complete turns or include
 * a transcript-done event", so a turn is closed here: when the other speaker
 * starts, when the session ends, when playback of a spoken turn finishes, or
 * after a silence. Nothing high-frequency is persisted — the deltas are
 * assembled and the assembled turn is what is written.
 *
 * **Every turn is stored exactly once**, enforced by the database rather than
 * by comparing text. A turn's identity is the provider's session id, the
 * speaker and the provider-assigned start offset of its first fragment, all of
 * which a replayed or retried stream reproduces exactly.
 *
 * **An answer Vowe already wrote is never written again.** When Vo speaks a
 * grounded answer, the entry exists already; what this adds is a delivery
 * against it. There is deliberately no path here that writes a second copy of
 * an answer.
 */
export class LiveConversationRecorder {
  private readonly options: LiveConversationRecorderOptions;
  private readonly silenceMs: number;
  private readonly onError: (scope: string, error: unknown) => void;

  private open: OpenTurn | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The next spoken turn is the delivery of this already-persisted answer. */
  private expectedDelivery: string | null = null;
  /**
   * The spoken turn most recently written.
   *
   * Two facts arrive after a turn is over and both belong to it: how long its
   * audio actually lasted, which the renderer measures and reports a moment
   * later, and which turn cut it off, which is not transcribed until the user
   * has finished saying it. Neither is worth delaying the turn for, so the turn
   * is written when it ends and these are attached when they arrive.
   */
  private recent: RecentDelivery | null = null;
  /** Audio began before the first fragment of the turn it belongs to. */
  private pendingPlaybackStart: string | null = null;
  private lastUserEntry: string | null = null;
  /** Writes stay in conversation order without a lock. */
  private writing: Promise<void> = Promise.resolve();
  /** What has been said so far, for a run's recorded input. */
  private readonly said: { speaker: 'user' | 'vo'; text: string }[] = [];

  constructor(options: LiveConversationRecorderOptions) {
    this.options = options;
    this.silenceMs = options.turnSilenceMs ?? 1500;
    this.onError = options.onError ?? (() => undefined);
  }

  /** The user's most recent persisted turn, if there is one. */
  get lastUserEntryId(): string | null {
    return this.lastUserEntry;
  }

  /**
   * The next spoken turn delivers this entry rather than being a new one.
   *
   * Set from the execution path — the bridge has just handed a grounded answer
   * over to be spoken — and never by recognizing the text when it comes back.
   * Text is the wrong test: Vo rephrases what it is given, and a person may
   * legitimately say the same sentence twice.
   */
  expectDeliveryOf(entryId: string): void {
    this.expectedDelivery = entryId;
  }

  userSaid(delta: string, startMs: number, endMs: number): void {
    this.accumulate('user', delta, startMs, endMs);
  }

  voSaid(delta: string, startMs: number, endMs: number): void {
    this.accumulate('vo', delta, startMs, endMs);
  }

  /**
   * What the renderer measured about the audio it played.
   *
   * The provider declares no playback lifecycle at all — there is no response
   * event, no turn-done event and no barge-in event anywhere in its vocabulary
   * — so the only honest account of what a person heard is the audio that was
   * actually played, measured where it was played. That is the renderer, and
   * this is where what it measured meets the conversation.
   */
  playback(report: PlaybackReport): void {
    const turn = this.open?.speaker === 'vo' ? this.open : null;

    if (report.kind === 'started') {
      if (turn) turn.playbackStartedAt = report.at;
      // Audio routinely begins before the first transcript fragment arrives.
      else this.pendingPlaybackStart = report.at;
      return;
    }

    if (!turn) {
      // The turn is already written — which is the usual order when the user
      // talks over it, because their first words reach us before the silence
      // that ends the audio does. Measured duration still belongs to it.
      void this.attachMeasurement(report).catch((error) =>
        this.onError('live:playback', error),
      );
      return;
    }

    turn.playbackEndedAt = report.at;
    if (report.kind === 'lost') turn.lost = true;
    else turn.audioMs = report.audioMs;
    // Playback ending is the end of the turn, and a better signal than any
    // silence timer: it is the moment the person stopped hearing it.
    void this.close().catch((error) => this.onError('live:close-turn', error));
  }

  /**
   * How long the audio of the turn just written actually lasted.
   *
   * Measured where it was played, and written as `audioEndMs` — never derived
   * from where two transcripts overlap, which says when someone started
   * talking and nothing at all about how much audio came out of the speaker.
   */
  private async attachMeasurement(
    report: Extract<PlaybackReport, { kind: 'stopped' | 'lost' }>,
  ): Promise<void> {
    const recent = this.recent;
    if (!recent) return;
    if (report.kind === 'lost') return;
    if (report.audioMs === undefined) return;
    await this.options.store.updateDelivery(recent.deliveryId, {
      audioEndMs: report.audioMs,
    });
  }

  /** Close whatever is open. Used before delegating, and when a call ends. */
  async flush(): Promise<void> {
    await this.close();
    await this.writing;
  }

  private accumulate(
    speaker: 'user' | 'vo',
    delta: string,
    startMs: number,
    endMs: number,
  ): void {
    if (this.open && this.open.speaker !== speaker) {
      // A user fragment that begins before Vo's audio was done is the user
      // talking over it. Both offsets are the provider's own, on one session
      // timeline, so this is a comparison of two recorded times rather than a
      // guess — and it decides only *that* the turn was cut off. How much was
      // heard is measured elsewhere, and is not inferred from this.
      if (speaker === 'user' && startMs < this.open.lastEndMs) {
        this.open.talkedOverAtMs = startMs;
      }
      void this.close().catch((error) => this.onError('live:close-turn', error));
    }
    if (!this.open) {
      this.open = {
        speaker,
        text: '',
        firstStartMs: startMs,
        lastEndMs: endMs,
        deliversEntryId: speaker === 'vo' ? this.takeExpectedDelivery() : null,
        run: speaker === 'vo' ? this.beginResponseRun() : null,
        playbackStartedAt:
          speaker === 'vo' ? this.takePendingPlaybackStart() : null,
        playbackEndedAt: null,
        audioMs: undefined,
        lost: false,
        talkedOverAtMs: undefined,
      };
    }
    this.open.text += delta;
    this.open.lastEndMs = Math.max(this.open.lastEndMs, endMs);
    this.armSilence();
  }

  private takeExpectedDelivery(): string | null {
    const expected = this.expectedDelivery;
    this.expectedDelivery = null;
    return expected;
  }

  private takePendingPlaybackStart(): string | null {
    const started = this.pendingPlaybackStart;
    this.pendingPlaybackStart = null;
    return started;
  }

  private beginResponseRun(): RunHandle | null {
    const run = this.options.runs?.begin({
      kind: 'live_response',
      sessionId: this.options.sessionId,
      provider: this.options.provider,
      ...(this.options.model ? { model: this.options.model } : {}),
    });
    if (!run) return null;
    // Normalized conversation and the standing instructions — never audio, and
    // never anything Vowe would not have sent the provider in the first place.
    run.input(
      {
        instructions: this.options.instructions ?? null,
        conversation: this.said.slice(-12),
      },
      {
        provider: this.options.provider,
        ...(this.options.model ? { model: this.options.model } : {}),
      },
    );
    return run;
  }

  private armSilence(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.close().catch((error) => this.onError('live:close-turn', error));
    }, this.silenceMs);
    this.timer.unref?.();
  }

  /**
   * Close the open turn and write it.
   *
   * The turn is taken out of the field before anything is awaited, so a second
   * close — a silence timer firing while playback is being handled — has
   * nothing left to write.
   */
  private async close(): Promise<void> {
    const turn = this.open;
    this.open = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!turn || !turn.text.trim()) return;

    this.said.push({ speaker: turn.speaker, text: turn.text.trim() });
    this.writing = this.writing
      .then(() =>
        turn.speaker === 'user' ? this.writeUserTurn(turn) : this.writeVoTurn(turn),
      )
      .catch((error) => this.onError('live:persist', error));
    await this.writing;
  }

  private async writeUserTurn(turn: OpenTurn): Promise<void> {
    const entry = this.entryFor(turn, USER_TURN, turn.text.trim());
    const stored = await this.options.store.appendConversationEntry(entry);
    if (!stored) return;
    this.lastUserEntry = stored.id;

    // The turn that cut Vo off, now that it exists. The interruption itself was
    // persisted the moment it happened; this is the part that had to wait for a
    // transcript, and waiting for it never held up the rest.
    const cutOff = this.recent;
    if (cutOff?.interrupted) {
      this.recent = { ...cutOff, interrupted: false };
      await this.options.store.updateDelivery(cutOff.deliveryId, {
        interruptedByEntryId: stored.id,
      });
    }
  }

  private async writeVoTurn(turn: OpenTurn): Promise<void> {
    const text = turn.text.trim();
    const status = this.deliveryStatus(turn);
    const startedAt = turn.playbackStartedAt ?? new Date().toISOString();
    const delivery = {
      modality: 'voice' as const,
      status,
      startedAt,
      ...(turn.audioMs === undefined ? {} : { audioEndMs: turn.audioMs }),
      // A turn is written when it is over, so its delivery is never left in
      // flight: `started` is a state a crash leaves behind, not one this
      // writes. What ended it is in `status`.
      completedAt: turn.playbackEndedAt ?? new Date().toISOString(),
    };

    if (turn.deliversEntryId) {
      // The grounded answer is already the conversation's copy of this. What
      // was spoken is the short form of it, and belongs to the delivery.
      await this.options.store.recordDelivery({
        id: randomUUID(),
        entryId: turn.deliversEntryId,
        sessionId: this.options.sessionId,
        deliveredText: text,
        ...delivery,
      });
      await this.finishRun(turn, status, null);
      this.remember(status, turn.deliversEntryId);
      return;
    }

    const entry = this.entryFor(turn, VOWE_TURN, text);
    const stored = await this.options.store.appendConversationEntry(entry, delivery);
    // Already stored: the provider redelivered a turn, and nothing about that
    // is new history. No second entry, and no second delivery either.
    if (!stored) {
      await this.finishRun(turn, status, null);
      return;
    }
    await this.finishRun(turn, status, stored.id);
    this.remember(status, stored.id);
  }

  /**
   * Which delivery this was, on the evidence there is.
   *
   * Positive evidence only. The user beginning to speak before this turn's
   * audio had finished is an interruption; a connection that went away mid-audio
   * is a cancellation. Absent either, there is nothing suggesting the person did
   * not hear the turn, and `completed` is the honest reading of the evidence
   * there is rather than an assumption dressed up as one.
   *
   * Note what this does *not* claim. It says the turn was cut off; it does not
   * say where. How much audio was actually heard is measured by the renderer
   * and lands as `audioEndMs`, and if no measurement arrives the delivery says
   * it was interrupted and stops there.
   */
  private deliveryStatus(turn: OpenTurn): 'completed' | 'interrupted' | 'cancelled' {
    if (turn.lost) return 'cancelled';
    if (turn.talkedOverAtMs !== undefined) return 'interrupted';
    return 'completed';
  }

  private remember(status: string, entryId: string): void {
    const deliveries = this.options.store.getDeliveries(entryId);
    const last = deliveries[deliveries.length - 1];
    this.recent = last
      ? { deliveryId: last.id, interrupted: status === 'interrupted' }
      : null;
  }

  /**
   * How the response itself ended, which is not the same fact as delivery.
   *
   * With this provider they coincide: barge-in stops the model speaking, so a
   * turn the user talked over is a response that stopped early rather than one
   * that finished and went unheard. Nothing in the provider's vocabulary would
   * distinguish the two, so the run says `cancelled` and does not pretend to
   * know more than that.
   */
  private async finishRun(
    turn: OpenTurn,
    status: string,
    outputEntryId: string | null,
  ): Promise<void> {
    const run = turn.run;
    if (!run) return;
    run.output({ text: turn.text.trim() });
    const produced = outputEntryId ? { outputEntryId } : {};
    if (status === 'completed') await run.complete(produced);
    else await run.cancel({ ...produced, metadata: { delivery: status } });
  }

  private entryFor(
    turn: OpenTurn,
    role: ConversationRole,
    text: string,
  ): ConversationEntry {
    return {
      id: randomUUID(),
      sessionId: this.options.sessionId,
      at: new Date().toISOString(),
      role,
      text,
      origin: {
        provider: this.options.provider,
        kind: 'live_turn',
        // Provider-assigned, on the provider's own session timeline, and
        // therefore identical when the same fragments arrive again.
        id: `${this.options.liveSessionId}:${turn.speaker}:${turn.firstStartMs}`,
      },
    };
  }
}
