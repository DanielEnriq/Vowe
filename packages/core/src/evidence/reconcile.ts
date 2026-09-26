import { createHash, randomUUID } from 'node:crypto';
import type { EvidenceCandidate, EvidenceRecord } from './types.js';

/** Canonical JSON for equality, never an identity for repeated occurrences. */
export function fingerprint(value: unknown): string {
  const hash=createHash('sha256');
  const visit=(v:unknown):void=>{
    if(Array.isArray(v)) {hash.update('[');v.forEach((item,i)=>{if(i)hash.update(',');visit(item===undefined?null:item);});hash.update(']');}
    else if(v && typeof v==='object') {
      hash.update('{');const entries=Object.entries(v).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b));
      entries.forEach(([key,item],i)=>{if(i)hash.update(',');hash.update(JSON.stringify(key));hash.update(':');visit(item);});hash.update('}');
    } else hash.update(JSON.stringify(v) ?? 'undefined');
  };
  visit(value);return hash.digest('hex');
}

export interface RecordIdentity {
  id: string;
  key?: string;
  digest: string;
  normalizationDigest?: string;
  correspondence?: 'provider-key' | 'ordered-snapshot' | 'unique-snapshot' | 'new' | 'ambiguous';
}

/**
 * Source-local snapshot correspondence, not cross-source semantic identity.
 * Prefix/suffix continuity preserves repeated occurrences. Unique anchors can
 * survive insertion/reordering; ambiguous repeated remnants stay unclaimed.
 * The retained catalog recovers records after a truncate/restore cycle.
 *
 * The ledger applies the same rules in SQL over its indexed view; this array
 * form is the reference its differential tests compare against.
 */
export function reconcileRecords(
  previous: RecordIdentity[],
  records: EvidenceRecord[],
  catalog = previous,
): RecordIdentity[] {
  const next = records.map((r) => ({
    ...(r.key === undefined ? {} : { key: r.key }),
    digest: fingerprint(r.raw),
  }));
  const explicit = new Map(catalog.filter((r) => r.key !== undefined).map((r) => [r.key!, r]));
  const seenKeys = new Set<string>();
  for (const r of next)
    if (r.key !== undefined) {
      if (seenKeys.has(r.key)) throw new Error(`Duplicate record identity: ${r.key}`);
      seenKeys.add(r.key);
    }
  const equal = (a: (typeof next)[number] | undefined, b: RecordIdentity | undefined) =>
    !!a && !!b && a.digest === b.digest && a.key === b.key;
  let prefix = 0,
    suffix = 0;
  while (equal(next[prefix], previous[prefix])) prefix++;
  while (
    suffix < Math.min(next.length, previous.length) - prefix &&
    equal(next[next.length - 1 - suffix], previous[previous.length - 1 - suffix])
  )
    suffix++;
  const positional = (i: number) =>
    next[i]!.key === undefined
      ? i < prefix
        ? previous[i]
        : i >= next.length - suffix
          ? previous[previous.length - next.length + i]
          : undefined
      : undefined;
  // Identical content is not the same occurrence. Occurrences already
  // continuing in order are claimed; a remaining record keeps an earlier
  // identity only when it is the sole unclaimed occurrence on both sides.
  const claimed = new Set(next.map((_, i) => positional(i)?.id).filter((id) => id !== undefined));
  const counts = new Map<string, number>();
  next.forEach((r, i) => {
    if (r.key === undefined && !positional(i)) counts.set(r.digest, (counts.get(r.digest) ?? 0) + 1);
  });
  const anchors = new Map<string, RecordIdentity[]>();
  for (const r of catalog)
    if (r.key === undefined && !claimed.has(r.id))
      anchors.set(r.digest, [...(anchors.get(r.digest) ?? []), r]);
  const used = new Set<string>();
  return next.map((r, i) => {
    let old = r.key === undefined ? undefined : explicit.get(r.key);
    let correspondence: RecordIdentity['correspondence'] =
      r.key !== undefined ? 'provider-key' : 'new';
    if (r.key === undefined) {
      old = positional(i);
      if (old) correspondence = 'ordered-snapshot';
      else {
        const matches = anchors.get(r.digest) ?? [];
        if (matches.length === 1 && counts.get(r.digest) === 1) {
          old = matches[0];
          correspondence = 'unique-snapshot';
        } else if (matches.length) correspondence = 'ambiguous';
      }
    }
    const id = old && !used.has(old.id) ? old.id : randomUUID();
    used.add(id);
    return { ...r, id, correspondence };
  });
}

/** Admission is independent of the provider. Raw reports remain inspectable. */
export function admit(candidate: EvidenceCandidate): EvidenceCandidate {
  const event = candidate.event;
  if (
    candidate.execution !== 'executed' &&
    (['command_finished', 'test_finished'].includes(event.kind) ||
      (candidate.execution && ['command_started', 'test_started'].includes(event.kind)))
  ) {
    return {
      ...candidate,
      execution: candidate.execution ?? 'unknown',
      event: {
        ...event,
        kind: 'operation_reported',
        summary:
          candidate.execution === 'rejected'
            ? 'Operation was rejected'
            : 'Provider reported an operation; execution is unverified',
        detail: {
          ...event.detail,
          failed: undefined,
          execution: candidate.execution ?? 'unknown',
          reportedKind: event.kind,
          reportedSummary: event.summary,
        },
      },
    };
  }
  return candidate;
}
