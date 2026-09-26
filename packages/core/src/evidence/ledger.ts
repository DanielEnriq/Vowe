import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import {
  candidateBlob,
  captureMetadata,
  decodeCandidates,
  decodeRaw,
  rawBlob,
  rawText,
  type StoredCandidate,
} from './capture-codec.js';
import { admit, fingerprint } from './reconcile.js';
import {
  EvidenceContinuityError,
  type EvidenceBatch,
  type EvidenceCandidate,
  type EvidenceChange,
  type EvidenceCoverage,
  type EvidenceStatus,
} from './types.js';

export const EVIDENCE_SCHEMA = `
ALTER TABLE events ADD COLUMN logical_key TEXT;
ALTER TABLE events ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN evidence_json TEXT;
DROP INDEX events_raw_ref;
CREATE UNIQUE INDEX events_raw_ref ON events(session_id,raw_source,raw_byte_offset,raw_ordinal) WHERE logical_key IS NULL;
CREATE TABLE evidence_captures(session_id TEXT NOT NULL, source_id TEXT NOT NULL, capture_id TEXT NOT NULL,
  digest TEXT NOT NULL, payload TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,source_id,capture_id)) STRICT;
CREATE TABLE evidence_sources(session_id TEXT NOT NULL, source_id TEXT NOT NULL, state TEXT NOT NULL,
  coverage TEXT NOT NULL, observed_at TEXT NOT NULL, checkpoint TEXT,
  PRIMARY KEY(session_id,source_id)) STRICT;
CREATE TABLE evidence_supports(session_id TEXT NOT NULL, source_id TEXT NOT NULL, record_id TEXT NOT NULL,
  slot TEXT NOT NULL, fact_key TEXT NOT NULL, candidate TEXT NOT NULL, capture_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(session_id,source_id,record_id,slot)) STRICT;
CREATE TABLE evidence_heads(session_id TEXT NOT NULL, fact_key TEXT NOT NULL, event_id TEXT NOT NULL,
  digest TEXT NOT NULL, PRIMARY KEY(session_id,fact_key)) STRICT;
CREATE TABLE evidence_changes(session_id TEXT NOT NULL, revision INTEGER NOT NULL, change_json TEXT NOT NULL,
  PRIMARY KEY(session_id,revision)) STRICT;
ALTER TABLE windows ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE windows ADD COLUMN event_ids_json TEXT;
DROP INDEX window_notes_window;
`;

export const EVIDENCE_SUPPORT_SCHEMA = `
CREATE TABLE evidence_event_support(event_id TEXT NOT NULL,session_id TEXT NOT NULL,source_id TEXT NOT NULL,
  capture_id TEXT NOT NULL,record_id TEXT NOT NULL,slot TEXT NOT NULL,
  PRIMARY KEY(event_id,source_id,capture_id,record_id,slot)) STRICT;
`;

/**
 * Record-level immutable evidence.
 *
 * - `evidence_blobs`: content-addressed bodies, stored once. Storage identity
 *   only; it never decides that two occurrences are the same record.
 * - `evidence_journal`: one row per physical observation of a record at a
 *   position. Repeated identical records are repeated rows sharing a blob.
 *   Extents (`span`, `lines`) derive a row's location from its range start;
 *   `location` is kept explicitly when they cannot.
 * - `evidence_capture_ranges`: a capture is at most MAX_RANGES runs of journal
 *   rows. Reconstruction never follows a chain of earlier captures.
 * - `evidence_view` / `evidence_catalog`: the current source view and every
 *   record identity ever seen, indexed so admission touches only what changed.
 */
export const EVIDENCE_RECORDS_SCHEMA = `
CREATE TABLE evidence_blobs(hash TEXT PRIMARY KEY, kind TEXT NOT NULL, body BLOB NOT NULL) STRICT;
CREATE TABLE evidence_journal(session_id TEXT NOT NULL, source_id TEXT NOT NULL, obs INTEGER NOT NULL,
  raw_hash TEXT NOT NULL, cand_hash TEXT NOT NULL, record_key TEXT, digest TEXT NOT NULL, norm_digest TEXT NOT NULL,
  span INTEGER, lines INTEGER, location TEXT, PRIMARY KEY(session_id,source_id,obs)) STRICT;
CREATE TABLE evidence_capture_ranges(session_id TEXT NOT NULL, source_id TEXT NOT NULL, capture_id TEXT NOT NULL,
  idx INTEGER NOT NULL, pos INTEGER NOT NULL, from_obs INTEGER NOT NULL, to_obs INTEGER NOT NULL,
  byte_start INTEGER, line_start INTEGER, byte_end INTEGER, line_end INTEGER,
  PRIMARY KEY(session_id,source_id,capture_id,idx)) STRICT;
CREATE TABLE evidence_view(session_id TEXT NOT NULL, source_id TEXT NOT NULL, pos INTEGER NOT NULL,
  record_id TEXT NOT NULL, record_key TEXT, digest TEXT NOT NULL, norm_digest TEXT, obs INTEGER,
  PRIMARY KEY(session_id,source_id,pos)) STRICT;
CREATE INDEX evidence_view_record ON evidence_view(session_id,source_id,record_id);
CREATE TABLE evidence_catalog(session_id TEXT NOT NULL, source_id TEXT NOT NULL, record_id TEXT NOT NULL,
  record_key TEXT, digest TEXT NOT NULL, PRIMARY KEY(session_id,source_id,record_id)) STRICT;
CREATE INDEX evidence_catalog_key ON evidence_catalog(session_id,source_id,record_key) WHERE record_key IS NOT NULL;
CREATE INDEX evidence_catalog_digest ON evidence_catalog(session_id,source_id,digest) WHERE record_key IS NULL;
CREATE TABLE evidence_staging(session_id TEXT NOT NULL, source_id TEXT NOT NULL, snapshot TEXT NOT NULL,
  pos INTEGER NOT NULL, raw_hash TEXT NOT NULL, cand_hash TEXT NOT NULL, record_key TEXT, digest TEXT NOT NULL,
  norm_digest TEXT NOT NULL, byte_offset INTEGER NOT NULL, line INTEGER NOT NULL, source TEXT NOT NULL,
  span INTEGER, lines INTEGER, obs INTEGER, PRIMARY KEY(session_id,source_id,snapshot,pos)) STRICT;
CREATE TABLE evidence_gaps(session_id TEXT NOT NULL, source_id TEXT NOT NULL, coverage TEXT NOT NULL,
  first_observed TEXT NOT NULL, PRIMARY KEY(session_id,source_id,coverage)) STRICT;
CREATE INDEX evidence_supports_fact ON evidence_supports(session_id,fact_key,active);
ALTER TABLE evidence_changes ADD COLUMN invalidated_from_seq INTEGER;
ALTER TABLE evidence_changes ADD COLUMN through_seq INTEGER;
ALTER TABLE evidence_sources ADD COLUMN current_capture TEXT;
ALTER TABLE evidence_captures ADD COLUMN format TEXT;
ALTER TABLE evidence_supports ADD COLUMN obs INTEGER;
ALTER TABLE evidence_event_support ADD COLUMN obs INTEGER;
`;

/** Move development-era JSON state into the indexed tables. Captures are untouched. */
export function migrateEvidenceState(db: DatabaseSync): void {
  const list = (field: string) =>
    `json_each(CASE WHEN json_type(s.state)='array' THEN s.state ELSE json_extract(s.state,'$.${field}') END)`;
  db.exec(`
    INSERT INTO evidence_view SELECT s.session_id,s.source_id,CAST(v.key AS INTEGER),json_extract(v.value,'$.id'),
      json_extract(v.value,'$.key'),json_extract(v.value,'$.digest'),json_extract(v.value,'$.normalizationDigest'),NULL
      FROM evidence_sources s, ${list('view')} v;
    INSERT OR REPLACE INTO evidence_catalog SELECT s.session_id,s.source_id,json_extract(v.value,'$.id'),
      json_extract(v.value,'$.key'),json_extract(v.value,'$.digest') FROM evidence_sources s, ${list('catalog')} v;
    UPDATE evidence_sources SET state='{}';
    UPDATE evidence_changes SET invalidated_from_seq=json_extract(change_json,'$.invalidatedFromSeq'),
      through_seq=(SELECT MAX(seq) FROM events e WHERE e.session_id=evidence_changes.session_id);
    INSERT OR IGNORE INTO evidence_gaps SELECT session_id,source_id,json_extract(payload,'$.coverage'),
      MIN(json_extract(payload,'$.observedAt')) FROM evidence_captures
      WHERE json_extract(payload,'$.coverage.status')='unavailable'
      GROUP BY session_id,source_id,json_extract(payload,'$.coverage');
  `);
}

/** Reconstruction depth is one: a capture is at most this many journal runs. */
export const MAX_RANGES = 64;

type Row = Record<string, SQLInputValue>;
type CaptureMeta = Omit<EvidenceBatch, 'records' | 'rawText'> & { locationSource?: string };
const CHUNK = 256;

/** SQLite-owned evidence admission. No provider names or transport assumptions. */
export class EvidenceLedger {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {
    // Connection-local working sets. Reconciliation runs here, in SQLite,
    // so a large snapshot never has to exist as a JavaScript array.
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS ev_next(pos INTEGER PRIMARY KEY, obs INTEGER, record_key TEXT, digest TEXT,
        norm_digest TEXT, raw_hash TEXT, cand_hash TEXT, byte_offset INTEGER, line INTEGER, source TEXT,
        record_id TEXT, corr TEXT);
      CREATE INDEX IF NOT EXISTS temp.ev_next_record ON ev_next(record_id);
      CREATE INDEX IF NOT EXISTS temp.ev_next_digest ON ev_next(digest);
      CREATE TEMP TABLE IF NOT EXISTS ev_prev(r INTEGER PRIMARY KEY, record_id TEXT, record_key TEXT, digest TEXT,
        obs INTEGER);
      CREATE INDEX IF NOT EXISTS temp.ev_prev_record ON ev_prev(record_id);
      CREATE TEMP TABLE IF NOT EXISTS ev_counts(digest TEXT PRIMARY KEY, n INTEGER);
      CREATE TEMP TABLE IF NOT EXISTS ev_rebuild AS SELECT * FROM ev_next WHERE 0;
    `);
  }

  private q(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.q(sql).get(...params) as Row | undefined;
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.q(sql).all(...params) as Row[];
  }
  private run(sql: string, ...params: SQLInputValue[]) {
    return this.q(sql).run(...params);
  }
  /**
   * Rows in `pos` order, a page at a time. Paged reads rather than a
   * long-lived iterator: an unfinished statement holds a read snapshot, which
   * stops the write-ahead log from ever restarting and slows every commit.
   */
  private *paged(sql: string, ...params: SQLInputValue[]): Generator<Row> {
    for (let after = -1; ; ) {
      const rows = this.all(`${sql} AND pos>? ORDER BY pos LIMIT ${CHUNK}`, ...params, after);
      if (!rows.length) return;
      after = Number(rows.at(-1)!.pos);
      yield* rows;
    }
  }

  private transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  revision(sessionId: string): number {
    return Number(
      this.one('SELECT COALESCE(MAX(revision),0) AS n FROM evidence_changes WHERE session_id=?', sessionId)
        ?.n ?? 0,
    );
  }

  status(sessionId: string): EvidenceStatus {
    return {
      revision: this.revision(sessionId),
      generation: Number(
        this.one(
          'SELECT COALESCE(MAX(revision),0) AS n FROM evidence_changes WHERE session_id=? AND invalidated_from_seq IS NOT NULL',
          sessionId,
        )?.n ?? 0,
      ),
      sources: this.all('SELECT * FROM evidence_sources WHERE session_id=?', sessionId).map((r) => ({
        sourceId: String(r.source_id),
        coverage: JSON.parse(String(r.coverage)),
        observedAt: String(r.observed_at),
        gaps: this.all(
          'SELECT coverage,first_observed FROM evidence_gaps WHERE session_id=? AND source_id=? ORDER BY first_observed',
          sessionId,
          String(r.source_id),
        ).map((g) => {
          const coverage = JSON.parse(String(g.coverage)) as EvidenceCoverage;
          return {
            ...coverage,
            status: 'partial' as const,
            since: String(g.first_observed),
            reason: `Source interruption observed at ${g.first_observed}; later availability alone does not establish reconstruction of the missing interval. ${coverage.reason}`,
          };
        }),
        ...(r.checkpoint === null ? {} : { checkpoint: String(r.checkpoint) }),
      })),
    };
  }

  /**
   * The latest revision whose events a consumer that has processed through
   * `processedThroughSeq` has seen. Invalidation rewinds that consumer, so a
   * corrected revision is not current until it is re-derived.
   */
  derivedThrough(sessionId: string, processedThroughSeq: number): number {
    return Number(
      this.one(
        'SELECT COALESCE(MAX(revision),0) AS n FROM evidence_changes WHERE session_id=? AND COALESCE(through_seq,0)<=?',
        sessionId,
        processedThroughSeq,
      )?.n ?? 0,
    );
  }

  /** Captures persisted but not admitted, e.g. after a crash between the two. */
  pending(): Array<{ sessionId: string; sourceId: string; captureId: string; legacy: boolean }> {
    return this.all(
      'SELECT session_id,source_id,capture_id,format FROM evidence_captures WHERE processed=0 ORDER BY rowid',
    ).map((r) => ({
      sessionId: String(r.session_id),
      sourceId: String(r.source_id),
      captureId: String(r.capture_id),
      legacy: r.format !== 'manifest',
    }));
  }

  /** Staged segments of snapshots that never completed. Their source re-reads. */
  discardStaging(): void {
    this.run('DELETE FROM evidence_staging');
  }

  ingest(sessionId: string, batch: EvidenceBatch): EvidenceChange {
    if (batch.mode === 'delta' && batch.records.some((r) => r.key === undefined))
      throw new Error('Delta evidence requires record identity');
    if (
      batch.membership === 'current-view' &&
      (batch.mode !== 'snapshot' || batch.coverage.status !== 'complete')
    )
      throw new Error('Current view requires a complete snapshot of its named scope');
    if (batch.extends && batch.mode !== 'snapshot') throw new Error('Only a snapshot can extend a view');
    if (batch.part && batch.mode === 'snapshot' && !batch.extends && this.progressive(sessionId, batch)) {
      // Nothing is known of this source yet, so a snapshot's parts can be
      // admitted as they arrive: each extends the last, exactly as the whole
      // snapshot would reconcile against an empty view and catalog.
      const { part, ...rest } = batch;
      const records = Number(
        this.one('SELECT COALESCE(MAX(pos)+1,0) AS n FROM evidence_view WHERE session_id=? AND source_id=?', sessionId, batch.sourceId)
          ?.n ?? 0,
      );
      return this.ingest(sessionId, {
        ...rest,
        captureId: part.final ? part.snapshot : `${part.snapshot}#${part.index}`,
        ...(part.index ? { extends: { captureId: `${part.snapshot}#${part.index - 1}`, records } } : {}),
      });
    }
    const captureId = batch.part?.snapshot ?? batch.captureId;
    const prior = this.one(
      'SELECT digest,processed,format FROM evidence_captures WHERE session_id=? AND source_id=? AND capture_id=?',
      sessionId,
      batch.sourceId,
      captureId,
    );
    if (prior?.processed) return { sessionId, revision: this.revision(sessionId) };
    if (batch.part && !batch.part.final) {
      if (!prior) this.stage(sessionId, batch, captureId);
      return { sessionId, revision: this.revision(sessionId) };
    }
    if (!prior || prior.format !== 'manifest') {
      try {
        // Staging the last records and persisting the capture commit together;
        // admission is a separate commit so a failed one leaves the capture.
        this.transaction(() => {
          this.stage(sessionId, batch, captureId);
          this.capture(sessionId, batch, captureId, prior !== undefined);
        });
      } catch (error) {
        this.run(
          'DELETE FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=?',
          sessionId,
          batch.sourceId,
          captureId,
        );
        throw error;
      }
    } else {
      const digest = this.digest(batch, this.stagedRowsFromBatch(batch));
      if (prior.digest !== digest)
        throw new Error('Evidence capture identity reused for different content');
      this.reload(sessionId, batch.sourceId, captureId);
    }
    return this.admitCapture(sessionId, batch.sourceId, captureId);
  }

  private progressive(sessionId: string, batch: EvidenceBatch): boolean {
    const { snapshot, index } = batch.part!;
    if (index > 0)
      return !!this.one(
        'SELECT 1 FROM evidence_captures WHERE session_id=? AND source_id=? AND capture_id=?',
        sessionId,
        batch.sourceId,
        `${snapshot}#0`,
      );
    return (
      batch.membership !== 'current-view' &&
      !this.one('SELECT 1 FROM evidence_catalog WHERE session_id=? AND source_id=? LIMIT 1', sessionId, batch.sourceId) &&
      !this.one('SELECT 1 FROM evidence_staging WHERE session_id=? AND source_id=? LIMIT 1', sessionId, batch.sourceId)
    );
  }

  /** Admit a capture that was persisted before a failure. */
  recover(sessionId: string, sourceId: string, captureId: string): EvidenceChange {
    this.reload(sessionId, sourceId, captureId);
    return this.admitCapture(sessionId, sourceId, captureId);
  }

  // ------------------------------------------------------------ acquisition

  private *stagedRowsFromBatch(batch: EvidenceBatch) {
    const normalizer = batch.normalizer ?? batch.sourceId;
    for (let i = 0; i < batch.records.length; i++) {
      const record = batch.records[i]!;
      const next = batch.records[i + 1]?.location ?? batch.through;
      const at = record.location;
      const derivable =
        next !== undefined &&
        (batch.records[i + 1] === undefined || batch.records[i + 1]!.location.source === at.source) &&
        next.byteOffset > at.byteOffset;
      const slots = new Set<string>();
      for (const c of record.events) {
        if (slots.has(c.slot)) throw new Error('Duplicate normalized slot');
        slots.add(c.slot);
      }
      yield {
        record,
        raw: rawBlob(record),
        candidates: candidateBlob(record, normalizer),
        digest: fingerprint(record.raw),
        normDigest: fingerprint(
          record.events.map((c) => ({
            slot: c.slot,
            factKey: c.factKey,
            basis: c.basis,
            execution: c.execution,
            kind: c.event.kind,
            summary: c.event.summary,
            detail: c.event.detail,
          })),
        ),
        span: derivable ? next.byteOffset - at.byteOffset : null,
        lines: derivable ? next.line - at.line : null,
      };
    }
  }

  private stage(sessionId: string, batch: EvidenceBatch, snapshot: string): void {
    this.transaction(() => {
      // One snapshot is in flight per source; a new one abandons the last.
      if (!batch.part || batch.part.index === 0)
        this.run(
          'DELETE FROM evidence_staging WHERE session_id=? AND source_id=?',
          sessionId,
          batch.sourceId,
        );
      let pos = Number(
        this.one(
          'SELECT COALESCE(MAX(pos)+1,0) AS n FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=?',
          sessionId,
          batch.sourceId,
          snapshot,
        )?.n ?? 0,
      );
      for (const row of this.stagedRowsFromBatch(batch)) {
        for (const b of [row.raw, row.candidates])
          this.run('INSERT OR IGNORE INTO evidence_blobs VALUES(?,?,?)', b.hash, b.kind, b.body);
        this.run(
          'INSERT INTO evidence_staging VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
          sessionId,
          batch.sourceId,
          snapshot,
          pos++,
          row.raw.hash,
          row.candidates.hash,
          row.record.key ?? null,
          row.digest,
          row.normDigest,
          row.record.location.byteOffset,
          row.record.location.line,
          row.record.location.source,
          row.span,
          row.lines,
        );
      }
    });
  }

  private digest(
    batch: EvidenceBatch,
    rows: Iterable<{
      raw: { hash: string };
      candidates: { hash: string };
      record: { key?: string; location: EvidenceBatch['records'][number]['location'] };
    }>,
  ): string {
    const hash = createHash('sha256').update(
      fingerprint({
        sourceId: batch.sourceId,
        mode: batch.mode,
        membership: batch.membership,
        coverage: batch.coverage,
        checkpoint: batch.checkpoint,
        retract: batch.retract,
        extends: batch.extends,
      }),
    );
    for (const row of rows)
      hash.update(
        JSON.stringify([
          row.record.key ?? null,
          row.raw.hash,
          row.candidates.hash,
          row.record.location.source,
          row.record.location.byteOffset,
          row.record.location.line,
        ]),
      );
    return hash.digest('hex');
  }

  private stagedDigest(sessionId: string, batch: EvidenceBatch, snapshot: string): string {
    const rows = this.paged(
      'SELECT pos,record_key,raw_hash,cand_hash,source,byte_offset,line FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=?',
      sessionId,
      batch.sourceId,
      snapshot,
    );
    function* shaped() {
      for (const r of rows)
        yield {
          raw: { hash: String(r.raw_hash) },
          candidates: { hash: String(r.cand_hash) },
          record: {
            ...(r.record_key === null ? {} : { key: String(r.record_key) }),
            location: { source: String(r.source), byteOffset: Number(r.byte_offset), line: Number(r.line) },
          },
        };
    }
    return this.digest(batch, shaped());
  }

  /**
   * Persist the capture: journal rows for records not already observed at the
   * same place, and the ranges naming its full ordered content. This commits
   * before admission, so a capture survives a reconciliation failure.
   */
  private capture(sessionId: string, batch: EvidenceBatch, captureId: string, legacy: boolean): void {
    const s = batch.sourceId;
    const digest = this.stagedDigest(sessionId, batch, captureId);
    this.transaction(() => {
      const source = this.one(
        'SELECT current_capture FROM evidence_sources WHERE session_id=? AND source_id=?',
        sessionId,
        s,
      );
      const m = Number(
        this.one('SELECT COALESCE(MAX(pos)+1,0) AS n FROM evidence_view WHERE session_id=? AND source_id=?', sessionId, s)?.n ?? 0,
      );
      if (batch.extends && (source?.current_capture !== batch.extends.captureId || m !== batch.extends.records))
        throw new EvidenceContinuityError(
          `Extension of ${batch.extends.captureId} no longer follows the admitted view`,
        );
      const n = Number(
        this.one(
          'SELECT COUNT(*) AS n FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=?',
          sessionId,
          s,
          captureId,
        )?.n ?? 0,
      );
      const base = batch.extends ? m : 0;
      // Reuse rows observed at the same place with identical bytes, derivation
      // and extent. Only the leading and trailing runs are compared: that is
      // what a growing or locally edited snapshot preserves.
      if (batch.mode === 'snapshot' && !batch.extends && m) {
        const previous = this.loadPrevious(sessionId, s);
        const equal = `j.raw_hash=t.raw_hash AND j.cand_hash=t.cand_hash AND j.span IS t.span AND j.lines IS t.lines
          AND (j.location IS NULL) = (t.span IS NOT NULL)
          AND (j.location IS NULL OR j.location=json_object('source',t.source,'byteOffset',t.byte_offset,'line',t.line))`;
        const prefix = Number(
          this.one(
            `SELECT COALESCE(MIN(t.pos),?) AS p FROM evidence_staging t LEFT JOIN ev_prev p ON p.r=t.pos
             LEFT JOIN evidence_journal j ON j.session_id=t.session_id AND j.source_id=t.source_id AND j.obs=p.obs
             WHERE t.session_id=? AND t.source_id=? AND t.snapshot=? AND NOT (p.obs IS NOT NULL AND ${equal})`,
            Math.min(n, previous),
            sessionId,
            s,
            captureId,
          )?.p ?? 0,
        );
        const limit = Math.max(0, Math.min(n, previous) - Math.min(prefix, n, previous));
        const suffix = Number(
          this.one(
            `SELECT COALESCE(MIN(?-1-t.pos),?) AS k FROM evidence_staging t LEFT JOIN ev_prev p ON p.r=?-?+t.pos
             LEFT JOIN evidence_journal j ON j.session_id=t.session_id AND j.source_id=t.source_id AND j.obs=p.obs
             WHERE t.session_id=? AND t.source_id=? AND t.snapshot=? AND t.pos>=?-?
             AND NOT (p.obs IS NOT NULL AND ${equal})`,
            n,
            limit,
            previous,
            n,
            sessionId,
            s,
            captureId,
            n,
            limit,
          )?.k ?? 0,
        );
        this.run(
          `UPDATE evidence_staging SET obs=(SELECT p.obs FROM ev_prev p WHERE p.r=CASE WHEN evidence_staging.pos<? THEN evidence_staging.pos ELSE ?-?+evidence_staging.pos END)
           WHERE session_id=? AND source_id=? AND snapshot=? AND (pos<? OR pos>=?-?)`,
          prefix,
          previous,
          n,
          sessionId,
          s,
          captureId,
          prefix,
          n,
          suffix,
        );
      }
      this.appendJournal(sessionId, s, captureId);
      let ranges = this.ranges(sessionId, s, captureId, base, batch.extends?.captureId);
      let shift = base;
      if (ranges.length > MAX_RANGES) {
        // Fragmented beyond the bound: re-anchor as one contiguous run. New
        // rows reference existing blobs, so no content is copied.
        if (batch.extends) {
          this.restageView(sessionId, s, captureId, batch.extends.captureId);
          shift = 0;
        }
        this.run(
          'UPDATE evidence_staging SET obs=NULL WHERE session_id=? AND source_id=? AND snapshot=?',
          sessionId,
          s,
          captureId,
        );
        this.appendJournal(sessionId, s, captureId);
        ranges = this.ranges(sessionId, s, captureId, 0, undefined);
      }
      ranges.forEach((r, idx) =>
        this.run(
          'INSERT INTO evidence_capture_ranges VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          sessionId,
          s,
          captureId,
          idx,
          r.pos,
          r.from,
          r.to,
          r.byteStart,
          r.lineStart,
          r.byteEnd,
          r.lineEnd,
        ),
      );
      const locationSource =
        this.firstSource(sessionId, s, captureId) ??
        (batch.extends ? this.meta(sessionId, s, batch.extends.captureId).locationSource : undefined);
      const meta: CaptureMeta = {
        ...(JSON.parse(captureMetadata({ ...batch, records: [] })) as CaptureMeta),
        captureId,
        ...(locationSource === undefined ? {} : { locationSource }),
      };
      delete (meta as { part?: unknown }).part;
      if (legacy)
        this.run(
          "UPDATE evidence_captures SET format='manifest' WHERE session_id=? AND source_id=? AND capture_id=?",
          sessionId,
          s,
          captureId,
        );
      else
        this.run(
          "INSERT INTO evidence_captures(session_id,source_id,capture_id,digest,payload,processed,body,format) VALUES(?,?,?,?,?,0,NULL,'manifest')",
          sessionId,
          s,
          captureId,
          digest,
          JSON.stringify({ ...meta, recordCount: base + n }),
        );
      this.fillNext(sessionId, s, captureId, shift, base);
      this.run(
        'DELETE FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=?',
        sessionId,
        s,
        captureId,
      );
    });
  }

  private firstSource(sessionId: string, s: string, captureId: string) {
    const row = this.one(
      'SELECT source FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=? AND span IS NOT NULL LIMIT 1',
      sessionId,
      s,
      captureId,
    );
    return row ? String(row.source) : undefined;
  }

  private loadPrevious(sessionId: string, s: string): number {
    this.run('DELETE FROM ev_prev');
    this.run(
      `INSERT INTO ev_prev SELECT ROW_NUMBER() OVER (ORDER BY pos)-1,record_id,record_key,digest,obs
       FROM evidence_view WHERE session_id=? AND source_id=?`,
      sessionId,
      s,
    );
    return Number(this.one('SELECT COUNT(*) AS n FROM ev_prev')?.n ?? 0);
  }

  private appendJournal(sessionId: string, s: string, captureId: string): void {
    const next = Number(
      this.one(
        'SELECT COALESCE(MAX(obs)+1,0) AS n FROM evidence_journal WHERE session_id=? AND source_id=?',
        sessionId,
        s,
      )?.n ?? 0,
    );
    this.run(
      `UPDATE evidence_staging SET obs=?+x.k FROM (SELECT pos AS p,ROW_NUMBER() OVER (ORDER BY pos)-1 AS k
         FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=? AND obs IS NULL) x
       WHERE evidence_staging.session_id=? AND evidence_staging.source_id=? AND evidence_staging.snapshot=?
         AND evidence_staging.pos=x.p`,
      next,
      sessionId,
      s,
      captureId,
      sessionId,
      s,
      captureId,
    );
    this.run(
      `INSERT INTO evidence_journal SELECT session_id,source_id,obs,raw_hash,cand_hash,record_key,digest,norm_digest,span,lines,
         CASE WHEN span IS NULL THEN json_object('source',source,'byteOffset',byte_offset,'line',line) END
       FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=? AND obs>=?`,
      sessionId,
      s,
      captureId,
      next,
    );
  }

  /** Runs of consecutive journal rows whose locations also continue. */
  private ranges(sessionId: string, s: string, captureId: string, base: number, extending?: string) {
    type Range = {
      pos: number;
      from: number;
      to: number;
      byteStart: number | null;
      lineStart: number | null;
      byteEnd: number | null;
      lineEnd: number | null;
    };
    const out: Range[] = extending
      ? this.all(
          'SELECT * FROM evidence_capture_ranges WHERE session_id=? AND source_id=? AND capture_id=? ORDER BY idx',
          sessionId,
          s,
          extending,
        ).map((r) => ({
          pos: Number(r.pos),
          from: Number(r.from_obs),
          to: Number(r.to_obs),
          byteStart: r.byte_start === null ? null : Number(r.byte_start),
          lineStart: r.line_start === null ? null : Number(r.line_start),
          byteEnd: r.byte_end === null ? null : Number(r.byte_end),
          lineEnd: r.line_end === null ? null : Number(r.line_end),
        }))
      : [];
    const rows = this.paged(
      'SELECT pos,obs,byte_offset,line,span,lines FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=?',
      sessionId,
      s,
      captureId,
    );
    for (const row of rows) {
      const obs = Number(row.obs);
      const derived = row.span !== null;
      const last = out.at(-1);
      const continues =
        last !== undefined &&
        obs === last.to + 1 &&
        (!derived || (last.byteEnd !== null && last.byteEnd === Number(row.byte_offset)));
      const byteEnd = derived ? Number(row.byte_offset) + Number(row.span) : null;
      const lineEnd = derived ? Number(row.line) + Number(row.lines) : null;
      if (continues) {
        last.to = obs;
        last.byteEnd = byteEnd;
        last.lineEnd = lineEnd;
      } else
        out.push({
          pos: base + Number(row.pos),
          from: obs,
          to: obs,
          byteStart: Number(row.byte_offset),
          lineStart: Number(row.line),
          byteEnd,
          lineEnd,
        });
    }
    return out;
  }

  /** Bring an extended view's rows into staging so they can be re-anchored. */
  private restageView(sessionId: string, s: string, captureId: string, extended: string): void {
    this.run(
      'UPDATE evidence_staging SET pos=pos+(SELECT COUNT(*) FROM evidence_view WHERE session_id=? AND source_id=?) WHERE session_id=? AND source_id=? AND snapshot=?',
      sessionId,
      s,
      sessionId,
      s,
      captureId,
    );
    this.reload(sessionId, s, extended, true);
    this.run(
      `INSERT INTO evidence_staging SELECT ?,?,?,n.pos,n.raw_hash,n.cand_hash,n.record_key,n.digest,n.norm_digest,n.byte_offset,
         n.line,n.source,j.span,j.lines,NULL FROM ev_next n JOIN evidence_journal j ON j.session_id=? AND j.source_id=? AND j.obs=n.obs`,
      sessionId,
      s,
      captureId,
      sessionId,
      s,
    );
  }

  /** The records admission will read: the capture itself, not caller memory. */
  private fillNext(sessionId: string, s: string, captureId: string, shift: number, from: number): void {
    this.run('DELETE FROM ev_next');
    this.run(
      `INSERT INTO ev_next SELECT pos+?,obs,record_key,digest,norm_digest,raw_hash,cand_hash,byte_offset,line,source,NULL,NULL
       FROM evidence_staging WHERE session_id=? AND source_id=? AND snapshot=? AND pos+?>=?`,
      shift,
      sessionId,
      s,
      captureId,
      shift,
      from,
    );
  }

  /** Reconstruct a persisted capture's records from its ranges. */
  private reload(sessionId: string, s: string, captureId: string, whole = false, into = 'ev_next'): void {
    const meta = this.meta(sessionId, s, captureId);
    const from = whole ? 0 : (meta.extends?.records ?? 0);
    this.run(`DELETE FROM ${into}`);
    this.run(
      `INSERT INTO ${into}
       SELECT r.pos+(j.obs-r.from_obs),j.obs,j.record_key,j.digest,j.norm_digest,j.raw_hash,j.cand_hash,
         COALESCE(json_extract(j.location,'$.byteOffset'),r.byte_start+COALESCE(SUM(j.span) OVER w,0)),
         COALESCE(json_extract(j.location,'$.line'),r.line_start+COALESCE(SUM(j.lines) OVER w,0)),
         COALESCE(json_extract(j.location,'$.source'),?),NULL,NULL
       FROM evidence_capture_ranges r JOIN evidence_journal j ON j.session_id=r.session_id AND j.source_id=r.source_id
         AND j.obs BETWEEN r.from_obs AND r.to_obs
       WHERE r.session_id=? AND r.source_id=? AND r.capture_id=? AND r.pos+(r.to_obs-r.from_obs)>=?
       WINDOW w AS (PARTITION BY r.idx ORDER BY j.obs ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`,
      meta.locationSource ?? '',
      sessionId,
      s,
      captureId,
      from,
    );
    this.run(`DELETE FROM ${into} WHERE pos<?`, from);
  }

  /**
   * A capture's records in order, rebuilt from its ranges: at most MAX_RANGES
   * runs of journal rows, never a chain of earlier captures.
   */
  *reconstruct(
    sessionId: string,
    sourceId: string,
    captureId: string,
  ): Generator<{ key?: string; raw: unknown; location: EvidenceBatch['records'][number]['location'] }> {
    this.reload(sessionId, sourceId, captureId, true, 'ev_rebuild');
    for (let after = -1; ; ) {
      const chunk = this.all(
        `SELECT n.*,b.body FROM ev_rebuild n JOIN evidence_blobs b ON b.hash=n.raw_hash WHERE n.pos>? ORDER BY n.pos LIMIT ${CHUNK}`,
        after,
      );
      if (!chunk.length) return;
      after = Number(chunk.at(-1)!.pos);
      for (const row of chunk)
        yield {
          ...(row.record_key === null ? {} : { key: String(row.record_key) }),
          raw: decodeRaw(row.body as Uint8Array),
          location: { source: String(row.source), byteOffset: Number(row.byte_offset), line: Number(row.line) },
        };
    }
  }

  private meta(sessionId: string, s: string, captureId: string): CaptureMeta {
    const row = this.one(
      'SELECT payload FROM evidence_captures WHERE session_id=? AND source_id=? AND capture_id=?',
      sessionId,
      s,
      captureId,
    );
    if (!row) throw new Error(`Unknown evidence capture ${captureId}`);
    return JSON.parse(String(row.payload)) as CaptureMeta;
  }

  /**
   * The observations supporting an event: each is its capture's metadata and
   * the exact records that capture contributed, located as they were then.
   */
  provenance(sessionId: string, eventId: string): EvidenceBatch[] {
    const out = new Map<string, EvidenceBatch>();
    for (const link of this.all(
      'SELECT DISTINCT source_id,capture_id,obs FROM evidence_event_support WHERE session_id=? AND event_id=? AND obs IS NOT NULL',
      sessionId,
      eventId,
    )) {
      const s = String(link.source_id);
      const captureId = String(link.capture_id);
      const obs = Number(link.obs);
      const meta = this.meta(sessionId, s, captureId);
      const row = this.one(
        `SELECT j.*,b.body,r.byte_start,r.line_start,
           (SELECT COALESCE(SUM(k.span),0) FROM evidence_journal k WHERE k.session_id=j.session_id AND k.source_id=j.source_id
             AND k.obs>=r.from_obs AND k.obs<j.obs) AS byte_skip,
           (SELECT COALESCE(SUM(k.lines),0) FROM evidence_journal k WHERE k.session_id=j.session_id AND k.source_id=j.source_id
             AND k.obs>=r.from_obs AND k.obs<j.obs) AS line_skip
         FROM evidence_journal j JOIN evidence_blobs b ON b.hash=j.raw_hash
         JOIN evidence_capture_ranges r ON r.session_id=j.session_id AND r.source_id=j.source_id AND r.capture_id=?
           AND j.obs BETWEEN r.from_obs AND r.to_obs
         WHERE j.session_id=? AND j.source_id=? AND j.obs=?`,
        captureId,
        sessionId,
        s,
        obs,
      );
      if (!row) continue;
      const location =
        row.location === null
          ? {
              source: meta.locationSource ?? '',
              byteOffset: Number(row.byte_start) + Number(row.byte_skip),
              line: Number(row.line_start) + Number(row.line_skip),
            }
          : (JSON.parse(String(row.location)) as EvidenceBatch['records'][number]['location']);
      const key = `${s}\0${captureId}`;
      const batch = out.get(key) ?? {
        ...(meta as Omit<CaptureMeta, 'locationSource'>),
        sourceId: s,
        captureId,
        records: [],
      };
      batch.records.push({
        ...(row.record_key === null ? {} : { key: String(row.record_key) }),
        raw: decodeRaw(row.body as Uint8Array),
        location,
        events: [],
      });
      out.set(key, batch);
    }
    return [...out.values()];
  }

  // --------------------------------------------------------------- admission

  private admitCapture(sessionId: string, s: string, captureId: string): EvidenceChange {
    const meta = this.meta(sessionId, s, captureId);
    return this.transaction(() => {
      const extending = meta.extends !== undefined;
      const snapshot = meta.mode === 'snapshot';
      const n = Number(this.one('SELECT COUNT(*) AS n FROM ev_next')?.n ?? 0);
      const duplicate = this.one(
        'SELECT record_key FROM ev_next WHERE record_key IS NOT NULL GROUP BY record_key HAVING COUNT(*)>1 LIMIT 1',
      );
      if (duplicate) throw new Error(`Duplicate record identity: ${duplicate.record_key}`);
      if (extending) {
        const again = this.one(
          // CROSS JOIN fixes the order: from the new records, never the view.
          `SELECT n.record_key FROM ev_next n CROSS JOIN evidence_catalog c ON c.session_id=? AND c.source_id=? AND c.record_key=n.record_key
           CROSS JOIN evidence_view v ON v.session_id=c.session_id AND v.source_id=c.source_id AND v.record_id=c.record_id
           WHERE n.record_key IS NOT NULL LIMIT 1`,
          sessionId,
          s,
        );
        if (again) throw new Error(`Duplicate record identity: ${again.record_key}`);
      }
      const m = snapshot && !extending ? this.loadPrevious(sessionId, s) : 0;
      this.assignIdentities(sessionId, s, n, m, snapshot && !extending, extending);

      const slotFacts = new Set<string>();
      const sharedFacts = new Set<string>();
      const added = { from: Infinity, through: 0 };
      let from: number | undefined;
      const invalidate = (seq: number) => {
        from = Math.min(from ?? Infinity, seq);
      };
      const collect = (fact: string) => (fact.startsWith('fact:') ? sharedFacts : slotFacts).add(fact);
      const withdraw = (recordId: string, activeOnly = false) => {
        for (const row of this.all(
          `SELECT fact_key FROM evidence_supports WHERE session_id=? AND source_id=? AND record_id=?${activeOnly ? ' AND active=1' : ''}`,
          sessionId,
          s,
          recordId,
        ))
          collect(String(row.fact_key));
        this.run(
          'UPDATE evidence_supports SET active=0 WHERE session_id=? AND source_id=? AND record_id=?',
          sessionId,
          s,
          recordId,
        );
      };

      // Records whose bytes and derivation are unchanged keep their support
      // untouched: the capture that introduced them still pins their citation.
      for (let after = -1; ; ) {
        const chunk = this.all(
          `SELECT n.*,c.body AS cand_body FROM ev_next n
           LEFT JOIN evidence_view v ON v.session_id=? AND v.source_id=? AND v.record_id=n.record_id
           JOIN evidence_blobs c ON c.hash=n.cand_hash
           WHERE n.pos>? AND NOT (v.record_id IS NOT NULL AND v.digest=n.digest AND v.norm_digest IS n.norm_digest AND n.corr<>'ambiguous')
           ORDER BY n.pos LIMIT ${CHUNK}`,
          sessionId,
          s,
          after,
        );
        if (!chunk.length) break;
        after = Number(chunk.at(-1)!.pos);
        for (const row of chunk) {
          const recordId = String(row.record_id);
          const location = {
            source: String(row.source),
            byteOffset: Number(row.byte_offset),
            line: Number(row.line),
          };
          withdraw(recordId);
          for (const input of decodeCandidates(row.cand_body as Uint8Array, location)) {
            const candidate = admit(
              row.corr === 'ambiguous'
                ? {
                    ...input,
                    event: {
                      ...input.event,
                      kind: 'operation_reported',
                      summary: 'Snapshot contains an ambiguous repeated observation',
                      detail: {
                        identityUncertain: true,
                        reportedKind: input.event.kind,
                        reportedSummary: input.event.summary,
                      },
                    },
                  }
                : input,
            );
            const fact = candidate.factKey
              ? `fact:${candidate.factKey}`
              : JSON.stringify([s, recordId, candidate.slot]);
            collect(fact);
            this.run(
              `INSERT INTO evidence_supports(session_id,source_id,record_id,slot,fact_key,candidate,capture_id,active,obs) VALUES(?,?,?,?,?,?,?,1,?)
               ON CONFLICT(session_id,source_id,record_id,slot) DO UPDATE SET fact_key=excluded.fact_key,candidate=excluded.candidate,
                 capture_id=excluded.capture_id,active=1,obs=excluded.obs`,
              sessionId,
              s,
              recordId,
              candidate.slot,
              fact,
              JSON.stringify(candidate),
              captureId,
              Number(row.obs),
            );
          }
        }
        // A record-local fact has no support outside its record, so it can be
        // settled now; shared facts wait until every record is in place.
        this.settle(sessionId, slotFacts, added, invalidate);
        slotFacts.clear();
      }
      for (const key of meta.retract ?? []) {
        const old = this.one(
          'SELECT record_id FROM evidence_catalog WHERE session_id=? AND source_id=? AND record_key=?',
          sessionId,
          s,
          key,
        );
        if (old) withdraw(String(old.record_id));
      }
      // Withdrawing a report from an explicitly complete view does not erase
      // its historical existence. It only stops that report supporting now.
      if (meta.membership === 'current-view')
        for (const old of this.all(
          `SELECT v.record_id FROM evidence_view v WHERE v.session_id=? AND v.source_id=?
           AND NOT EXISTS(SELECT 1 FROM ev_next n WHERE n.record_id=v.record_id)`,
          sessionId,
          s,
        ))
          withdraw(String(old.record_id), true);
      const reordered =
        snapshot &&
        !extending &&
        !!this.one(
          `SELECT 1 FROM (SELECT p.r, LAG(p.r) OVER (ORDER BY n.pos) AS before FROM ev_next n JOIN ev_prev p ON p.record_id=n.record_id)
           WHERE r<before LIMIT 1`,
        );
      if (reordered) {
        const earliest = this.one(
          `SELECT MIN(e.seq) AS n FROM evidence_heads h JOIN events e ON e.session_id=h.session_id AND e.id=h.event_id JOIN evidence_supports s
           ON s.session_id=h.session_id AND s.fact_key=h.fact_key WHERE s.session_id=? AND s.source_id=?`,
          sessionId,
          s,
        )?.n;
        if (earliest !== null && earliest !== undefined) invalidate(Number(earliest));
      }
      this.settle(sessionId, slotFacts, added, invalidate);
      this.settle(sessionId, sharedFacts, added, invalidate);

      // The current view: a snapshot replaces it, an extension appends to it,
      // and a delta replaces the delivered records wherever they were.
      if (snapshot && !extending) this.run('DELETE FROM evidence_view WHERE session_id=? AND source_id=?', sessionId, s);
      if (!snapshot)
        this.run(
          'DELETE FROM evidence_view WHERE session_id=? AND source_id=? AND record_id IN (SELECT record_id FROM ev_next)',
          sessionId,
          s,
        );
      const offset = snapshot
        ? 0
        : Number(
            this.one(
              'SELECT COALESCE(MAX(pos)+1,0) AS n FROM evidence_view WHERE session_id=? AND source_id=?',
              sessionId,
              s,
            )?.n ?? 0,
          ) - Number(this.one('SELECT COALESCE(MIN(pos),0) AS n FROM ev_next')?.n ?? 0);
      this.run(
        `INSERT INTO evidence_view SELECT ?,?,pos+?,record_id,record_key,digest,norm_digest,obs FROM ev_next`,
        sessionId,
        s,
        offset,
      );
      if (meta.retract?.length)
        this.run(
          'DELETE FROM evidence_view WHERE session_id=? AND source_id=? AND record_key IN (SELECT value FROM json_each(?))',
          sessionId,
          s,
          JSON.stringify(meta.retract),
        );
      this.run(
        'INSERT OR REPLACE INTO evidence_catalog SELECT ?,?,record_id,record_key,digest FROM ev_next',
        sessionId,
        s,
      );
      const ambiguity = !!this.one("SELECT 1 FROM ev_next WHERE corr='ambiguous' LIMIT 1");
      const coverage =
        reordered || ambiguity
          ? {
              ...meta.coverage,
              status: 'partial',
              reason:
                meta.coverage.reason +
                (reordered
                  ? '; source order changed: Vowe sequence numbers are admission order, not execution chronology'
                  : '') +
                (ambiguity
                  ? '; repeated records lack stable occurrence identity: their relationship remains uncertain'
                  : ''),
            }
          : meta.coverage;
      this.run(
        `INSERT INTO evidence_sources(session_id,source_id,state,coverage,observed_at,checkpoint,current_capture) VALUES(?,?,'{}',?,?,?,?)
         ON CONFLICT(session_id,source_id) DO UPDATE SET coverage=excluded.coverage,observed_at=excluded.observed_at,
           checkpoint=excluded.checkpoint,current_capture=excluded.current_capture`,
        sessionId,
        s,
        JSON.stringify(coverage),
        meta.observedAt,
        meta.checkpoint ?? null,
        captureId,
      );
      if (meta.coverage.status === 'unavailable')
        this.run(
          'INSERT OR IGNORE INTO evidence_gaps VALUES(?,?,?,?)',
          sessionId,
          s,
          JSON.stringify(meta.coverage),
          meta.observedAt,
        );
      if (from !== undefined) {
        const affected = this.one(
          'SELECT MIN(start_seq) AS n FROM windows WHERE session_id=? AND end_seq>=? AND stale=0',
          sessionId,
          from,
        )?.n;
        from = Math.min(from, affected === null || affected === undefined ? from : Number(affected));
        this.run('UPDATE windows SET stale=1 WHERE session_id=? AND end_seq>=?', sessionId, from);
        this.run('UPDATE sessions SET semantic_state_json=NULL WHERE id=?', sessionId);
        this.run(
          `UPDATE observation_state SET processed_through_seq=MIN(processed_through_seq,?),last_processed_window_id=NULL,
           last_closed_window_index=COALESCE((SELECT MAX(idx) FROM windows WHERE session_id=?),-1) WHERE session_id=?`,
          from - 1,
          sessionId,
          sessionId,
        );
      }
      const change: EvidenceChange = {
        sessionId,
        revision: this.revision(sessionId) + 1,
        ...(added.through ? { added: { fromSeq: added.from, throughSeq: added.through } } : {}),
        ...(from === undefined ? {} : { invalidatedFromSeq: from }),
      };
      this.run(
        'INSERT INTO evidence_changes VALUES(?,?,?,?,(SELECT MAX(seq) FROM events WHERE session_id=?))',
        sessionId,
        change.revision,
        JSON.stringify(change),
        from ?? null,
        sessionId,
      );
      this.run(
        'UPDATE evidence_captures SET processed=1 WHERE session_id=? AND source_id=? AND capture_id=?',
        sessionId,
        s,
        captureId,
      );
      this.run('DELETE FROM ev_next');
      this.run('DELETE FROM ev_prev');
      return change;
    });
  }

  /**
   * Source-local occurrence identity, computed in SQL (see `reconcileRecords`
   * for the same rules over arrays). Provider keys decide when present.
   * Otherwise the leading and trailing runs that still match keep their
   * occurrences in order; a remaining record keeps an earlier identity only
   * when it is the one unclaimed occurrence of its content on both sides.
   */
  private assignIdentities(sessionId: string, s: string, n: number, m: number, full: boolean, extending: boolean) {
    this.run(
      `UPDATE ev_next SET record_id=(SELECT record_id FROM evidence_catalog c WHERE c.session_id=? AND c.source_id=?
       AND c.record_key=ev_next.record_key), corr='provider-key' WHERE record_key IS NOT NULL`,
      sessionId,
      s,
    );
    if (full && m) {
      const base = Number(this.one('SELECT COALESCE(MIN(pos),0) AS p FROM ev_next')?.p ?? 0);
      const unequal = 'p.r IS NULL OR p.digest IS NOT n.digest OR p.record_key IS NOT n.record_key';
      const prefix = Number(
        this.one(
          `SELECT COALESCE(MIN(n.pos-?),?) AS p FROM ev_next n LEFT JOIN ev_prev p ON p.r=n.pos-? WHERE ${unequal}`,
          base,
          Math.min(n, m),
          base,
        )?.p ?? 0,
      );
      const limit = Math.max(0, Math.min(n, m) - Math.min(prefix, n, m));
      const suffix = Number(
        this.one(
          `SELECT COALESCE(MIN(?-1-(n.pos-?)),?) AS k FROM ev_next n LEFT JOIN ev_prev p ON p.r=?-?+(n.pos-?)
           WHERE n.pos-?>=?-? AND (${unequal})`,
          n,
          base,
          limit,
          m,
          n,
          base,
          base,
          n,
          limit,
        )?.k ?? 0,
      );
      this.run(
        `UPDATE ev_next SET record_id=(SELECT p.record_id FROM ev_prev p WHERE p.r=CASE WHEN ev_next.pos-?<? THEN ev_next.pos-? ELSE ?-?+ev_next.pos-? END),
         corr='ordered-snapshot' WHERE record_key IS NULL AND (pos-?<? OR pos-?>=?-?)`,
        base,
        prefix,
        base,
        m,
        n,
        base,
        base,
        prefix,
        base,
        n,
        suffix,
      );
    }
    this.run("UPDATE ev_next SET corr='pending' WHERE record_key IS NULL AND corr IS NULL");
    this.run('DELETE FROM ev_counts');
    this.run("INSERT INTO ev_counts SELECT digest,COUNT(*) FROM ev_next WHERE corr='pending' GROUP BY digest");
    // Claimed: occurrences already continuing in order, and for an extension,
    // every record of the view it extends.
    const unclaimed = `c.session_id=? AND c.source_id=? AND c.record_key IS NULL AND c.digest=ev_next.digest
      AND NOT EXISTS(SELECT 1 FROM ev_next x WHERE x.record_id=c.record_id)
      ${extending ? 'AND NOT EXISTS(SELECT 1 FROM evidence_view v WHERE v.session_id=c.session_id AND v.source_id=c.source_id AND v.record_id=c.record_id)' : ''}`;
    this.run(
      `UPDATE ev_next SET (record_id,corr)=(SELECT CASE WHEN COUNT(*)=1 AND k.n=1 THEN MIN(c.record_id) END,
         CASE WHEN COUNT(*)=1 AND k.n=1 THEN 'unique-snapshot' WHEN COUNT(*)>0 THEN 'ambiguous' ELSE 'new' END
         FROM evidence_catalog c, ev_counts k WHERE k.digest=ev_next.digest AND ${unclaimed})
       WHERE corr='pending'`,
      sessionId,
      s,
    );
    this.run(
      `UPDATE ev_next SET record_id=NULL WHERE pos IN (SELECT pos FROM (SELECT pos,ROW_NUMBER() OVER (PARTITION BY record_id ORDER BY pos) AS k
       FROM ev_next WHERE record_id IS NOT NULL) WHERE k>1)`,
    );
    for (const row of this.all('SELECT pos FROM ev_next WHERE record_id IS NULL'))
      this.run('UPDATE ev_next SET record_id=? WHERE pos=?', randomUUID(), row.pos!);
  }

  /** A supporting record's raw JSON text, copied rather than re-serialized. */
  private recordText(sessionId: string, support: Row): string | null {
    const row = this.one(
      `SELECT b.body FROM evidence_journal j JOIN evidence_blobs b ON b.hash=j.raw_hash
       WHERE j.session_id=? AND j.source_id=? AND j.obs=?`,
      sessionId,
      String(support.source_id),
      support.obs ?? null,
    );
    return row ? rawText(row.body as Uint8Array) : null;
  }

  /** Resolve facts to their current events: append on change, never rewrite. */
  private settle(
    sessionId: string,
    facts: Set<string>,
    added: { from: number; through: number },
    invalidate: (seq: number) => void,
  ): void {
    for (const fact of facts) {
      const head = this.one(
        'SELECT h.*,e.seq FROM evidence_heads h JOIN events e ON e.session_id=h.session_id AND e.id=h.event_id WHERE h.session_id=? AND h.fact_key=?',
        sessionId,
        fact,
      );
      const support = this.all(
        'SELECT * FROM evidence_supports INDEXED BY evidence_supports_fact WHERE session_id=? AND fact_key=? AND active=1 ORDER BY source_id,record_id,slot',
        sessionId,
        fact,
      );
      if (!support.length) {
        if (head) {
          this.run('UPDATE events SET active=0 WHERE id=?', String(head.event_id));
          invalidate(Number(head.seq));
        }
        this.run('DELETE FROM evidence_heads WHERE session_id=? AND fact_key=?', sessionId, fact);
        continue;
      }
      const candidates = support.map((s) => JSON.parse(String(s.candidate)) as StoredCandidate);
      const established = candidates.filter((c) => c.basis === 'established');
      const eligible = established.length ? established : candidates;
      const semantic = (c: EvidenceCandidate) => ({
        kind: c.event.kind,
        summary: c.event.summary,
        detail: c.event.detail,
      });
      const conflict = new Set(eligible.map((c) => fingerprint(semantic(c)))).size > 1;
      const chosen = eligible[0]!;
      const event = conflict
        ? {
            ...chosen.event,
            kind: 'operation_reported' as const,
            summary: 'Sources disagree about this operation',
            detail: { conflict: true, reports: eligible.map(semantic) },
          }
        : chosen.event;
      const effectiveDigest = fingerprint({
        kind: event.kind,
        summary: event.summary,
        detail: event.detail,
      });
      const linkSupport = (id: string) => {
        for (const row of support)
          this.run(
            'INSERT OR IGNORE INTO evidence_event_support VALUES(?,?,?,?,?,?,?)',
            id,
            sessionId,
            String(row.source_id),
            String(row.capture_id),
            String(row.record_id),
            String(row.slot),
            row.obs ?? null,
          );
      };
      if (head?.digest === effectiveDigest) {
        linkSupport(String(head.event_id));
        continue;
      }
      if (head) {
        this.run('UPDATE events SET active=0 WHERE id=?', String(head.event_id));
        invalidate(Number(head.seq));
      }
      // Preserve existing rows and citation IDs on the first legacy adoption.
      const legacy =
        !head && !chosen.factKey
          ? this.one(
              'SELECT * FROM events WHERE session_id=? AND logical_key IS NULL AND raw_source=? AND raw_byte_offset=? AND raw_ordinal=?',
              sessionId,
              event.rawRef.source,
              event.rawRef.byteOffset,
              event.rawRef.ordinal ?? 0,
            )
          : undefined;
      const chosenSupport = support[candidates.indexOf(chosen)]!;
      const adopt =
        !!legacy &&
        fingerprint({
          kind: legacy.kind,
          summary: legacy.summary,
          detail: legacy.detail_json === null ? undefined : JSON.parse(String(legacy.detail_json)),
        }) === effectiveDigest;
      // A legacy row that the same record now normalizes differently is an
      // earlier reading of this fact: superseded, never left current beside it.
      const supersedes = head ? String(head.event_id) : legacy && !adopt ? String(legacy.id) : undefined;
      if (legacy && !adopt) {
        this.run('UPDATE events SET active=0 WHERE id=?', String(legacy.id));
        invalidate(Number(legacy.seq));
      }
      const evidence = {
        factKey: fact,
        basis: chosen.basis ?? 'reported',
        sourceId: String(chosenSupport.source_id),
        captureId: String(chosenSupport.capture_id),
        ...(chosen.execution ? { execution: chosen.execution } : {}),
        ...(supersedes ? { supersedes } : {}),
        ...(conflict ? { conflict: true } : {}),
      };
      let id: string;
      if (legacy && adopt) {
        id = String(legacy.id);
        this.run('UPDATE events SET logical_key=?,evidence_json=? WHERE id=?', fact, JSON.stringify(evidence), id);
      } else {
        id = randomUUID();
        const inserted = this.one(
          `INSERT INTO events(session_id,seq,id,at,kind,summary,detail_json,raw_json,raw_source,raw_byte_offset,raw_line,raw_ordinal,logical_key,evidence_json)
           SELECT ?,COALESCE(MAX(seq),0)+1,?,?,?,?,?,?,?,?,?,?,?,? FROM events WHERE session_id=? RETURNING seq`,
          sessionId,
          id,
          event.at,
          event.kind,
          event.summary,
          event.detail ? JSON.stringify(event.detail) : null,
          chosen.rawFromRecord ? this.recordText(sessionId, chosenSupport) : (JSON.stringify(event.raw) ?? null),
          event.rawRef.source,
          event.rawRef.byteOffset,
          event.rawRef.line,
          event.rawRef.ordinal ?? 0,
          fact,
          JSON.stringify(evidence),
          sessionId,
        );
        const seq = Number(inserted!.seq);
        added.from = Math.min(added.from, seq);
        added.through = Math.max(added.through, seq);
      }
      this.run(
        'INSERT INTO evidence_heads VALUES(?,?,?,?) ON CONFLICT(session_id,fact_key) DO UPDATE SET event_id=excluded.event_id,digest=excluded.digest',
        sessionId,
        fact,
        id,
        effectiveDigest,
      );
      linkSupport(id);
    }
  }
}
