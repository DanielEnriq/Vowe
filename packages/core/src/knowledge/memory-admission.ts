import { parseRef, type ContextRef } from '../context/refs.js';
import type { DecisionRouter } from '../decision/decision-router.js';

export interface MemoryAdmissionInput {
  question: string;
  answer: string;
  refs: (ContextRef | string)[];
}

export interface MemoryAdmissionPolicy {
  shouldRemember(input: MemoryAdmissionInput): Promise<boolean>;
}

/**
 * The threshold, and the only tunable here.
 *
 * Higher than the `0.5` used to decide whether a window is worth exploring,
 * because the two decisions are not symmetric: exploring one window too many
 * costs a few tokens once, while remembering one thing too many costs every
 * future search in this repository, for as long as the project exists.
 */
const DEFAULT_THRESHOLD = 0.7;

const INSTRUCTIONS =
  'A question about a codebase has been answered from the repository itself. Would this answer still plausibly help an engineer understand this repository in a future, unrelated coding session?';

/**
 * Whether a grounded answer is worth keeping.
 *
 * **Conservative, and it fails closed.** Two gates, in order, and the default at
 * every step is no.
 *
 * The first gate is structural rather than linguistic: the answer has to be
 * grounded in the repository — at least one `symbol:` or `repo:` ref. An answer
 * built only from the trace, an event, the transcript or the diff is about
 * *this worker, right now*. "What command is it running?" is answerable, useful,
 * and worthless tomorrow. Testing the refs rather than the wording means the
 * rule holds however the question happened to be phrased.
 *
 * The second gate is the decision model. Being grounded in the repository says
 * an answer came from the code; it says nothing about whether anyone will want
 * it in six months. Something has to judge that, and if nothing can, the answer
 * is no.
 *
 * That last part is a deliberate departure from the `DecisionRouter` convention
 * that every call site carries its own deterministic fallback. The deterministic
 * fallback here *is* "do not remember". The consequence is worth stating
 * plainly: **with no decision model configured, Vowe records corrections and
 * nothing else.** A sparse memory is a cost you pay once per rediscovery. A
 * polluted one is a cost you pay on every search, and there is no way back out
 * of it.
 */
export class ConservativeMemoryAdmission implements MemoryAdmissionPolicy {
  private readonly router: DecisionRouter | null;
  private readonly threshold: number;
  private readonly onError: (scope: string, error: unknown) => void;

  constructor(
    options: {
      router?: DecisionRouter;
      threshold?: number;
      onError?: (scope: string, error: unknown) => void;
    } = {},
  ) {
    this.router = options.router ?? null;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.onError = options.onError ?? (() => undefined);
  }

  async shouldRemember(input: MemoryAdmissionInput): Promise<boolean> {
    if (!isRepositoryGrounded(input.refs)) return false;
    if (!this.router?.available) return false;

    try {
      const result = await this.router.noul({
        instructions: INSTRUCTIONS,
        criteria: {
          true: 'Durable knowledge about the repository: an architectural responsibility, a relationship between modules, a non-obvious convention, an implementation constraint, or why an interface is shaped the way it is.',
          false: 'Information about the current run: what a worker is doing now, what a command printed, whether something is finished, or anything that a later session would have to check again anyway.',
        },
        state: {
          question: input.question,
          answer: input.answer,
          groundedIn: input.refs
            .map((ref) => (typeof ref === 'string' ? ref : ref.kind))
            .slice(0, 20),
        },
      });
      // No answer is not a reason to keep something.
      if (!result) return false;
      return result.noul >= this.threshold;
    } catch (error) {
      this.onError('memory:admission', error);
      return false;
    }
  }
}

/**
 * Did this answer come out of the repository, or out of the session?
 *
 * Exported because it is the load-bearing half of the policy, and it is worth
 * being able to test and read on its own.
 */
export function isRepositoryGrounded(refs: (ContextRef | string)[]): boolean {
  for (const raw of refs) {
    const ref = typeof raw === 'string' ? parseRef(raw) : raw;
    if (ref?.kind === 'symbol' || ref?.kind === 'repo') return true;
  }
  return false;
}
