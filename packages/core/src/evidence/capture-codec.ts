import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { EvidenceBatch, EvidenceCandidate, EvidenceRecord } from './types.js';

/** Lossless storage encoding, not a revision of the observation. */
export function captureMetadata(batch: EvidenceBatch): string {
  const { records, rawText, ...metadata } = batch;
  return JSON.stringify({ ...metadata, encoding: 'gzip-json', recordCount: records.length });
}
export function encodeCapture(batch: EvidenceBatch): Uint8Array {
  // Normalizers normally point event.raw at record.raw. Avoid serializing that
  // same object again for every sibling; restore it on decode without loss.
  const packed = {
    ...batch,
    recordRawShared: true,
    records: batch.records.map((record) => ({
      ...record,
      events: record.events.map((candidate) =>
        candidate.event.raw === record.raw
          ? { ...candidate, event: { ...candidate.event, raw: undefined }, rawFromRecord: true }
          : candidate,
      ),
    })),
  };
  return gzipSync(JSON.stringify(packed), { level: 1 });
}
/** Development-era whole-batch captures. New captures are record manifests. */
export function decodeCapture(row: { payload: unknown; body?: unknown }): EvidenceBatch {
  const decoded = JSON.parse(
    row.body instanceof Uint8Array ? gunzipSync(row.body).toString('utf8') : String(row.payload),
  );
  if (decoded.recordRawShared) {
    for (const record of decoded.records)
      for (const candidate of record.events)
        if (candidate.rawFromRecord) {
          candidate.event.raw = record.raw;
          delete candidate.rawFromRecord;
        }
    delete decoded.recordRawShared;
  }
  return decoded as EvidenceBatch;
}

/**
 * A content-addressed blob. The hash is storage identity only: identical bytes
 * observed twice are two occurrences sharing one body. Kinds are separate
 * namespaces, and derived candidates also name the normalizer that produced
 * them, so a new derivation never masquerades as the same evidence.
 */
export interface EvidenceBlob {
  hash: string;
  kind: string;
  body: Uint8Array;
}

function blob(kind: string, text: string): EvidenceBlob {
  return {
    hash: createHash('sha256').update(kind).update('\0').update(text).digest('hex'),
    kind,
    body: gzipSync(text, { level: 1 }),
  };
}

/** Exact source bytes when the source has them; canonical JSON otherwise. */
export function rawBlob(record: EvidenceRecord): EvidenceBlob {
  return record.text !== undefined
    ? blob('raw:line', record.text)
    : blob('raw:json', JSON.stringify(record.raw) ?? 'null');
}

/** Both kinds are JSON text; `raw:line` is additionally the exact source bytes. */
export function rawText(body: Uint8Array): string {
  return gunzipSync(body).toString('utf8');
}

export function decodeRaw(body: Uint8Array): unknown {
  return JSON.parse(rawText(body));
}

type Location = EvidenceRecord['location'];

/**
 * Candidates without their position: a raw reference that points at the
 * record's own location is stored relative, so an unchanged record that moved
 * within its source still shares one body.
 */
export function candidateBlob(record: EvidenceRecord, normalizer: string): EvidenceBlob {
  const at = record.location;
  const packed = record.events.map((candidate) => {
    const { raw, rawRef, ...event } = candidate.event;
    const relative =
      rawRef.source === at.source && rawRef.byteOffset === at.byteOffset && rawRef.line === at.line;
    return {
      ...candidate,
      event: {
        ...event,
        ...(raw === record.raw ? {} : { raw }),
        rawRef: relative ? { ordinal: rawRef.ordinal } : rawRef,
      },
      ...(raw === record.raw ? { rawFromRecord: true } : {}),
      ...(relative ? { rawRefAtRecord: true } : {}),
    };
  });
  return blob(`candidates:${normalizer}`, JSON.stringify(packed));
}

/**
 * A candidate whose raw payload is its record's own. Admission keeps the
 * marker instead of the payload, which is read from the journal only when an
 * event row is written.
 */
export type StoredCandidate = EvidenceCandidate & { rawFromRecord?: boolean };

export function decodeCandidates(body: Uint8Array, location: Location): StoredCandidate[] {
  const packed = JSON.parse(gunzipSync(body).toString('utf8')) as Array<
    StoredCandidate & { rawRefAtRecord?: boolean }
  >;
  return packed.map(({ rawRefAtRecord, ...candidate }) => {
    const event = candidate.event;
    if (rawRefAtRecord)
      event.rawRef = {
        ...location,
        ...(event.rawRef.ordinal === undefined ? {} : { ordinal: event.rawRef.ordinal }),
      };
    return candidate;
  });
}
