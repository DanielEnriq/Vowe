/**
 * What Vowe itself did, as distinct from what Vowe said.
 *
 * Four lanes of history meet in this database and they answer four different
 * questions. Conversation answers *what was communicated*; delivery answers
 * *what the person actually received*; worker events answer *what the coding
 * agent did*. This one answers *what happened inside Vowe* — which model was
 * called, with what, what it looked up, what reasoning it exposed, what came
 * back, and whether it finished.
 *
 * They stay separate because collapsing them loses the distinction that makes
 * each useful. A tool call is not a conversational turn; an `InvestigationReceipt`
 * is the short, human-facing account of a lookup — `Checked 3 things · 4s` —
 * and remains exactly that. This is the detailed layer underneath it, and it
 * does not replace it.
 */

/** What a model reported it spent. Only ever what a provider actually said. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Cache and other provider-specific counters, as reported. */
  detail?: Record<string, number>;
}

export type VoweRunStatus = 'started' | 'completed' | 'cancelled' | 'error';

/**
 * One execution Vowe performed on its own behalf.
 *
 * `kind` is a plain string rather than a union because the set grows with the
 * application and an unrecognized kind is still a truthful row. What the
 * shipped code actually writes today: `investigation`, `observation`,
 * `interpretation`, `communication_decision`, `live_response`.
 */
export interface VoweRun {
  id: string;
  sessionId?: string;
  projectId?: string;
  kind: string;

  provider?: string;
  model?: string;

  status: VoweRunStatus;

  /**
   * The conversational turn that caused this run, and the turn it produced.
   *
   * Explicit ids rather than timing or text: "which execution produced this
   * answer?" and "which question caused this execution?" should be a join, not
   * an inference.
   */
  triggerEntryId?: string;
  outputEntryId?: string;

  startedAt: string;
  /** Absent while the run is still in flight. */
  completedAt?: string;

  usage?: ModelUsage;
  /** Extensible, provider-shaped, and never part of the domain API. */
  metadata?: Record<string, unknown>;
}

/**
 * What happened inside one run, in the order it happened.
 *
 * Only kinds something real produces. There is no `retrieval`: the
 * investigator's three read tools *are* tool calls, and they are recorded where
 * they actually execute rather than described a second time under another name.
 *
 * `reasoning` and `reasoning_summary` are deliberately two things. A provider
 * that hands back the reasoning text gives us `reasoning`; one that hands back
 * a summary of it — which is what Anthropic's adaptive thinking returns — gives
 * us `reasoning_summary`, labelled as the summary it is. A provider that
 * exposes nothing gives us neither, and nothing here is reconstructed after the
 * fact.
 */
export type VoweTraceKind =
  | 'model_input'
  | 'reasoning'
  | 'reasoning_summary'
  | 'model_output'
  | 'tool_call'
  | 'tool_result'
  | 'error';

export interface VoweTraceItem {
  id: string;
  runId: string;
  /** Execution order within the run. `run_id + ord` is the ordering key. */
  ord: number;

  kind: VoweTraceKind;

  /** The prose of this item, when it has any. */
  text?: string;
  /** The structured part: a resolved request, tool arguments, a result. */
  payload?: unknown;

  /** The provider's own id for this item, when it gives one. */
  providerItemId?: string;

  at: string;
}

/** What may change once a run is under way. Identity and kind may not. */
export interface RunCompletion {
  status: VoweRunStatus;
  completedAt: string;
  usage?: ModelUsage;
  outputEntryId?: string;
  metadata?: Record<string, unknown>;
  /** Learned during the run, when only the adapter knew them. */
  provider?: string;
  model?: string;
}
