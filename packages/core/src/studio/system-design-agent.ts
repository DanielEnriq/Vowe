import type { ModelTrace } from '../llm/model-trace.js';
import type { InvestigationAttachment } from '../llm/observation-llm.js';
import type { ConsultationFinding } from './consultation.js';
import type { DesignElementKind, DesignModel, DesignMove, DesignOp } from './model.js';

/**
 * Vowe's system-design intelligence, as a boundary Vowe owns.
 *
 * Coding harnesses are the experts on a repository: exploring it, planning
 * exact changes, editing, testing. This is the part Vowe is expert at — what
 * the developer is trying to design, keeping the design coherent as their
 * thinking moves, telling proposal from fact and uncertainty from settled
 * direction, and recognising when a design question depends on what the code
 * actually does.
 *
 * Every design decision lives behind this interface: whether to consult, what
 * to say, whether the design should change and how — and, when the developer
 * changes the design by hand, whether that move has a consequence worth
 * pointing out. `StudioService` only loads
 * state, hands over capabilities, records and commits. An implementation is a
 * model and a prompt; the interface is the product.
 *
 * Stateless between turns on purpose. Everything the agent knows arrives in
 * `DesignTurn`, which is what lets a later context source — what Vowe has come
 * to understand about the project, related past designs — be a new field
 * rather than a rewrite.
 */
export interface SystemDesignAgent {
  turn(
    input: DesignTurn,
    capabilities: DesignCapabilities,
    trace?: ModelTrace,
    stream?: DesignStream,
  ): Promise<DesignTurnResult>;

  /**
   * The developer changed the design on the canvas. Say nothing — unless the
   * move leaves something unresolved or breaks something the design relied
   * on, and then one short note on the element it concerns. Null is the usual
   * answer. No capabilities: this is a glance, not a turn.
   */
  consider(input: DesignConsideration, trace?: ModelTrace): Promise<DesignNote | null>;
}

export interface DesignConsideration {
  projectName: string;
  before: DesignModel;
  after: DesignModel;
  move: DesignMove;
  conversation: DesignTurn['conversation'];
  signal: AbortSignal;
}

/** A consequence noticed, anchored to an element id in `after`. */
export interface DesignNote {
  on: string;
  text: string;
}

/** What the developer is pointing at: what "this" means. */
export interface DesignFocus {
  kind: DesignElementKind;
  id: string;
  /** How it reads on the canvas, resolved from the model — never from the renderer. */
  label: string;
}

export interface DesignTurn {
  projectName: string;
  /** What the developer just said. */
  message: string;
  /**
   * The design as it stands, or null before the first revision. A Studio 0
   * design has an empty model and its old document as `legacyDocument`,
   * which this turn's move should draw.
   */
  design: { model: DesignModel; revision: number; legacyDocument?: string } | null;
  /** Recent moves, oldest first — what "revert that" can name. */
  moves: { id: string; author: DesignMove['author']; via: DesignMove['via']; summary: string }[];
  /** The element the developer selected, if any. */
  focus?: DesignFocus;
  /** How the developer chose to begin, on a design's first message only. */
  start?: 'code' | 'idea';
  /** Recent turns, oldest first, excluding `message`. */
  conversation: { speaker: 'developer' | 'vowe'; text: string }[];
  /** Earlier repository findings in this design, oldest first. */
  findings: DesignFinding[];
  /** What the developer attached, already opened. */
  attachments?: InvestigationAttachment[];
  /** How the developer asked Vowe to talk. */
  guidance?: string;
  /** Stop: the developer cancelled the turn. */
  signal: AbortSignal;
}

/** A grounded fact from an earlier consultation, as the agent is shown it. */
export interface DesignFinding {
  question: string;
  answer: string;
  /** Formatted refs the agent may cite as `ref:` links. */
  refs: string[];
  at: string;
}

/**
 * What the agent may do to the world during a turn. Nothing else.
 *
 * Handed in per turn by `StudioService`, which wraps each capability so that
 * it is traced where it actually runs, receipted, capped and cancellable. The
 * agent never holds the consultant itself, the session registry, an adapter,
 * the navigator or project memory — so a design turn cannot instruct a worker,
 * edit a file or change what Vowe believes about the project.
 */
export interface DesignCapabilities {
  /** `part`: the id of the part the question is about, so the canvas can show it being checked. */
  consultRepository(request: { question: string; why: string; part?: string }): Promise<ConsultationFinding>;
}

/**
 * The turn as it is written. Best-effort and never awaited.
 *
 * A view, exactly as `InvestigationStream` is: what is committed comes from the
 * agent's result, never from whatever deltas somebody happened to be watching.
 */
export interface DesignStream {
  /** Reply text, from every round of the turn. */
  message?(delta: string): void;
  /** Exposed reasoning only; silent where a provider exposes none. */
  reasoning?(delta: string): void;
  /** Every complete op of the move so far, as it is written. */
  move?(ops: DesignOp[]): void;
}

export interface DesignTurnResult {
  /** Everything Vowe said this turn, in order. */
  reply: string;
  /**
   * A change to the design. Absent means the design did not change, which is
   * most turns.
   */
  move?: {
    ops: DesignOp[];
    /** Why the design changed — not a paraphrase of the ops. */
    summary: string;
  };
}
