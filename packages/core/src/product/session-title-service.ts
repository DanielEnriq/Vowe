import type { EventStore } from '../store/event-store.js';
import { conciseTitle, normalizeGeneratedTitle, titleSignal } from './session-title.js';

/**
 * A model that can name a piece of work.
 *
 * Its own tiny interface rather than a method on the main client, for the same
 * reason `DecisionRouter` is its own: naming is a different job with different
 * economics, it wants the cheapest model available rather than the best one,
 * and core must not know which that is.
 *
 * `null` means the model said nothing usable — unavailable, refused, or a call
 * that failed. It is never an error the caller has to handle, because a session
 * without a generated title already renders perfectly well. A string means the
 * model answered, whether or not the answer is a title.
 */
export interface SessionTitleModel {
  readonly available: boolean;
  /**
   * `stricter` asks again after a first answer broke the length contract.
   *
   * One retry, with the limits restated, because the usual failure is a model
   * being helpful rather than a model being wrong — and a second ask is much
   * cheaper than showing a sentence where a name belongs.
   */
  title(task: string, options?: { stricter?: boolean }): Promise<string | null>;
}

export interface SessionTitleServiceOptions {
  store: EventStore;
  model: SessionTitleModel;
  onTitled?: (sessionId: string, title: string) => void;
  onError?: (scope: string, error: unknown) => void;
}

/**
 * Names a session once, when something a person did asks for a name.
 *
 * A title is durable metadata, and `generated_title` is the delimiter that
 * says so: **if the column has a value, nothing here ever runs again for that
 * session.** Not on a tighter contract, not on a new reading of the task, not
 * on a restart. Naming is what happens the first time a session exists or the
 * first time someone opens one; it is not a state the application converges on
 * in the background.
 *
 * What this replaces was the opposite of that in every respect. Discovery
 * called `consider(registry.list())` on every `session:added` and every
 * `session:updated` — which is every few seconds, for every session on the
 * machine — and the keying was per *task signal*, so each time the interpreter
 * revised its reading of a session it became eligible for renaming again. A
 * week of history was a burst of model calls at launch and a slow drip
 * afterwards, for names that were already written and already fine.
 *
 * So there is one entry point, `ensure`, and three things guard it:
 *
 *  - **The column.** A stored title ends it, read from the store rather than
 *    from anything held in memory.
 *  - **`attempted`.** One attempt per session per run, recorded *before* the
 *    first await. Re-renders, concurrent loads and a transient 429 all get the
 *    same one attempt — a failed naming is retried on some later run, never in
 *    a loop inside this one.
 *  - **`inFlight`.** Concurrent callers share the one promise rather than
 *    starting a second call, so a caller that waits gets a real completion.
 *
 * And it cannot fail anything. `ensure` resolves whatever happens; the caller
 * is opening a session, and what that session is called is not a precondition
 * of opening it.
 */
export class SessionTitleService {
  private readonly store: EventStore;
  private readonly model: SessionTitleModel;
  private readonly onTitled: (sessionId: string, title: string) => void;
  private readonly onError: (scope: string, error: unknown) => void;

  /** Sessions a model has been asked about during this run of the process. */
  private readonly attempted = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(options: SessionTitleServiceOptions) {
    this.store = options.store;
    this.model = options.model;
    this.onTitled = options.onTitled ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
  }

  /**
   * Name this session if it has never been named. Never throws.
   *
   * Called from the two places a name is genuinely wanted: a session Vowe has
   * just created, and a session a person has just opened for the first time.
   * Nothing on the discovery or listing path may call this.
   */
  async ensure(sessionId: string): Promise<void> {
    const existing = this.inFlight.get(sessionId);
    if (existing) return existing;

    if (this.stopped || !this.model.available) return;
    if (this.attempted.has(sessionId)) return;

    /*
     * The durable answer, not a cached one.
     *
     * Read here rather than taken from a session object a caller happened to
     * have, because the column is the delimiter and an in-memory copy of a
     * session is exactly the thing that can be missing it.
     */
    const session = this.store.getSession(sessionId);
    if (!session) return;

    const signal = titleSignal(session);
    /*
     * Nothing to name from yet, and no attempt spent on it.
     *
     * A session opened before its first real instruction has only a paste
     * wrapper for a task. No model was called, so nothing is recorded — the
     * next time it is opened there may be something to work with.
     */
    if (!signal) return;

    this.attempted.add(sessionId);
    const work = this.name(sessionId, signal)
      .catch((error) => this.onError('title', error))
      .finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, work);
    return work;
  }

  stop(): void {
    this.stopped = true;
  }

  private async name(sessionId: string, signal: string): Promise<void> {
    /*
     * Ask; ask once more only if there was an answer to improve on.
     *
     * A model that answers with a sentence has not given us a title, and one
     * stricter retry usually fixes it — the usual failure is a model being
     * helpful. A model that answers with *nothing* is a different thing: it
     * was unavailable, or the call failed, and asking a second time is how one
     * transient 429 becomes two. So the retry is conditional on there having
     * been an answer at all.
     */
    const answered = await this.model.title(signal);
    if (answered === null) return;

    const title =
      normalizeGeneratedTitle(answered) ??
      normalizeGeneratedTitle(await this.model.title(signal, { stricter: true })) ??
      // The model answered twice outside the contract. Its words are not
      // usable, but the signal is, and a deterministic cut of it is inside the
      // contract by construction. Something inside always beats something out.
      conciseTitle(signal);

    if (!title || this.stopped) return;

    /*
     * Conditional, because the column is the delimiter.
     *
     * Two processes, a restart mid-call, or any future caller cannot produce a
     * second name for a session that already has one: the write is the check.
     * Nothing is announced unless something was actually written.
     */
    const written = await this.store.setGeneratedTitle(sessionId, title);
    if (written) this.onTitled(sessionId, title);
  }
}
