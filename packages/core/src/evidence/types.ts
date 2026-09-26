import type { AdapterEvent } from '../types/events.js';
import type { Unsubscribe } from '../types/adapter.js';

/** Coverage is about a named surface, never all the work a worker performed. */
export interface EvidenceCoverage {
  scope: string;
  status: 'partial' | 'complete' | 'unavailable';
  reason: string;
  since?: string;
  through?: string;
}

export interface EvidenceCandidate {
  /** Stable output slot within a record; legacy normalizers use their ordinal. */
  slot: string;
  event: AdapterEvent;
  /** Only supply when an explicit identity relates observations across sources. */
  factKey?: string;
  basis?: 'reported' | 'established';
  /** Completion reports without execution evidence cannot become successful runs. */
  execution?: 'unknown' | 'executed' | 'rejected';
}

export interface EvidenceRecord {
  /** A provider record ID, not a tool correlation ID or transport resume token. */
  key?: string;
  raw: unknown;
  /** Exact source bytes when `raw` is `JSON.parse(text)`; retained instead of re-serializing. */
  text?: string;
  location: { source: string; byteOffset: number; line: number };
  events: EvidenceCandidate[];
}

export interface EvidenceBatch {
  sourceId: string;
  /** Stable capture/delivery ID. Idempotence starts at this durable boundary. */
  captureId: string;
  observedAt: string;
  mode: 'snapshot' | 'delta';
  /** A complete current view can withdraw support; retained history cannot. */
  membership?: 'retained-history' | 'current-view';
  records: EvidenceRecord[];
  coverage: EvidenceCoverage;
  /** Original bytes when available. Parsed objects alone are not byte fidelity. */
  rawText?: string;
  /** Identifies the derivation producing candidates, so a changed normalizer is not mistaken for changed evidence. */
  normalizer?: string;
  /**
   * This snapshot is the view established by `captureId` (exactly `records`
   * long) followed by these records. The ledger rejects it with
   * `EvidenceContinuityError` when that is no longer the admitted view.
   */
  extends?: { captureId: string; records: number };
  /**
   * One bounded segment of a snapshot too large to hold at once. Segments are
   * staged; the snapshot is captured and admitted only with its final part.
   */
  part?: { snapshot: string; index: number; final: boolean };
  /** Source position after the last record, so per-record extents can be derived. */
  through?: { byteOffset: number; line: number };
  checkpoint?: string;
  /** Explicit provider retractions. Ordinary history omissions are not retractions. */
  retract?: string[];
}

/**
 * The continuity a source actually guarantees, which decides what catching up
 * can cost. It describes the source's contract, never its provider:
 * - `append-log`: records are only appended; resume reads only new bytes.
 * - `delivery-cursor`: keyed deliveries resumable from an opaque checkpoint;
 *   redelivery is harmless.
 * - `mutable-snapshot`: only whole views are observable, so finding what
 *   changed requires examining the view (bounded memory, not O(change)).
 */
export type EvidenceContinuity = 'append-log' | 'delivery-cursor' | 'mutable-snapshot';

/** What the consumer offers a subscribed source besides admission. */
export interface EvidenceSubscription {
  /** The source has delivered everything it can currently observe. */
  idle?: () => void;
  /**
   * Wait for a turn to acquire (read, parse, normalize) and hold it until the
   * acquired batch is admitted. Bounds acquired-but-unadmitted evidence and
   * lets the consumer decide whose work goes first.
   */
  turn?: () => Promise<() => void>;
}

/** Operations compose; a source is not classified by its provider or transport. */
export interface EvidenceSource {
  id: string;
  continuity?: EvidenceContinuity;
  read?: () => Promise<EvidenceBatch>;
  subscribe?: (
    accept: (batch: EvidenceBatch) => Promise<void>,
    subscription?: EvidenceSubscription,
  ) => Unsubscribe;
  resumeAfter?: (
    checkpoint: string,
    accept: (batch: EvidenceBatch) => Promise<void>,
    subscription?: EvidenceSubscription,
  ) => Unsubscribe;
}

/** A source's extension no longer follows the admitted view; re-read it whole. */
export class EvidenceContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceContinuityError';
  }
}

export interface EvidenceChange {
  sessionId: string;
  revision: number;
  /** Events this change added, as a seq range; read them back in pages. */
  added?: { fromSeq: number; throughSeq: number };
  invalidatedFromSeq?: number;
}

/**
 * Whether derived understanding reflects the admitted evidence. A consumer is
 * current through the latest revision whose events it has processed.
 */
export interface EvidenceFreshness {
  status: 'current' | 'catching-up' | 'behind';
  evidenceRevision: number;
  derivedThroughRevision: number;
}

export interface EvidenceStatus {
  revision: number;
  generation: number;
  sources: Array<{
    sourceId: string;
    coverage: EvidenceCoverage;
    observedAt: string;
    checkpoint?: string;
    /** Past interruptions remain visible even after a new source delivery. */
    gaps?: EvidenceCoverage[];
  }>;
}

/** Flatten the source view for provider-neutral prompts and session UI. */
export function evidenceCoverage(status: EvidenceStatus): EvidenceCoverage[] {
  return status.sources.flatMap((source) => [source.coverage, ...(source.gaps ?? [])]);
}
