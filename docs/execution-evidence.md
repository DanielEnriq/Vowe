# Execution evidence and local Cursor

Implemented slice, 2026-09-25. This replaces the earlier Cursor implementation gate; it does not introduce a Project Understanding claim store or another observer.

## Boundary

```
Claude / Pi / Codex / Cursor
  → adapter acquisition + candidate interpretation
  → acknowledged EvidenceBatch
  → durable raw capture
  → shared identity / support reconciliation / admission
  → immutable NormalizedEvent revisions + current-support projection
  → existing Registry → Session Observer / interpretation / Project views
```

`AgentAdapter.evidenceSources()` composes `read`, `subscribe`, and optional `resumeAfter` operations independently of worker control. A session can have several sources. Batches declare a snapshot or delta, occurrence keys where available, physical locations, candidate output slots, scoped coverage and optional opaque checkpoints. There are no provider classes in the evidence layer.

Acquisition records the provider's report. Candidate interpretation is adapter-owned. Admission is core-owned. A captured batch contains original data and proposed normalization; its raw capture commits **before** admission, and admission reads the capture back rather than caller memory. Interpretation failures and transaction rollback cannot acknowledge that capture. Startup retries unadmitted captures from SQLite without requiring the external source. The Cursor collector also persists the original hook input before Vowe is involved.

Code: `core/src/evidence/{types,reconcile,ledger,support}.ts`, `adapter-kit/src/evidence-source.ts`, `core/src/store/sqlite-event-store.ts`, `core/src/registry/session-registry.ts`.

## Scale: what work costs

The operational rule is that work is proportional to what changed where the source's semantics allow it, and memory is bounded by a segment, never by a history.

### Source continuity contract

`EvidenceSource.continuity` declares what the source guarantees; it is not a provider class.

| Continuity | Guarantee | Catch-up cost | Used by |
|---|---|---|---|
| `append-log` | Records are only appended | New bytes plus ≤128 KiB of anchors; an unchanged file is one `stat` | Claude, Pi, Codex logs |
| `delivery-cursor` | Keyed deliveries, resumable from an opaque checkpoint; redelivery is harmless | New deliveries (a directory listing, then only unseen receipt files) | Cursor hooks, remote runs |
| `mutable-snapshot` | Only whole views are observable | The whole view in I/O and CPU, in bounded memory, as background work. **Not O(change)**; storage is still O(new content) | Cursor transcript |

An `append-log` checkpoint records file identity (dev/inode), the consumed offset, line and record count, a head anchor (sha256 of the first ≤64 KiB), a boundary anchor (sha256 of the 64 KiB before the offset), the normalizer version, the admitted capture, and the normalizer's carried state (tool calls awaiting their result), so a resumed read normalizes exactly as a read from the start. A shrink, a new inode, an anchor mismatch or a normalizer change falls back to a whole-snapshot read, with "rewritten in place" in coverage. An in-place rewrite that preserves length and both anchors is not detected without a full read: that is a stated limit of trusting the append contract.

A whole read is streamed in parts (≤250 records or ≤1 MiB, and at least one record, so a single 11 MiB record is one part). When nothing is yet known of a source, its parts are admitted as they arrive; otherwise they are staged and the snapshot is captured and reconciled with its final part. A read that changed underneath it (or a crash mid-read) leaves only discarded staging; the checkpoint did not advance, so the source re-reads.

### Record-level immutable storage

```
evidence_blobs            content-addressed bodies (sha256, domain-separated kinds)
evidence_journal          one row per physical observation of a record at a position
evidence_capture_ranges   a capture = ≤64 runs of journal rows (reconstruction depth 1)
evidence_view / _catalog  current source view and every identity seen, indexed
evidence_staging          parts of an in-flight snapshot; discarded at startup
```

Identity is layered and never collapsed:

| Layer | Identity | Scope |
|---|---|---|
| Blob | `sha256("raw:line"‖bytes)` (exact source line) or `raw:json`; `sha256("candidates:<normalizer@version>"‖json)` for derived candidates | Storage dedup only |
| Physical observation | journal row `(session, source, obs)` | One per acquired position; identical content = two rows, one blob |
| Source record occurrence | `record_id` from provider key, positional continuity, or the sole unclaimed occurrence of that content | Repeats stay distinct; genuinely ambiguous ones are labeled |
| Event | event id per fact head; corrections supersede | Unchanged |

Raw evidence and derived candidates are separate namespaces, and candidates name the normalizer version that produced them, so re-normalizing later never masquerades as new or identical raw evidence. Candidates reference their record's raw body rather than embedding it; an event row copies the raw text when it is written.

A journal row stores its extent (`span`, `lines`) instead of an absolute location when the source is a contiguous file, so an unchanged record that merely shifted is reused. Reuse is only of leading and trailing runs of the previous view with identical bytes, derivation and extent. An append adds one run; a local rewrite adds three. If a capture would need more than 64 runs it is re-anchored: new contiguous journal rows referencing existing blobs (≈100 bytes each, no content copied). Reconstruction (`EvidenceLedger.reconstruct`) reads at most 64 range scans regardless of revision count.

Reconciliation of a whole snapshot runs in SQL over connection-local temp tables (`ev_next`, `ev_prev`), with the array implementation in `reconcile.ts` kept as the differential-tested reference. Only records whose bytes or derivation changed are re-admitted; unchanged records keep their support and their citation to the capture that introduced them.

### Scheduling and startup

`SessionRegistry.start()` rehydrates stored sessions and runs discovery, then subscribes evidence sources: opening Vowe does not replay provider history first. Acquisition takes a turn from the registry (two at once, held until admitted, so at most two segments are in memory). Live or recently active sessions get turns first; waiting background catch-up is served at least one turn in four. Admission is one SQLite writer, yielding to the event loop between segments.

### Freshness

`AgentSession.evidenceFreshness` is derived on read: `catching-up` until every source of the session has delivered what it can observe in this process; `behind` when the Session Observer's processed sequence is below the latest revision's events (`evidence_changes.through_seq`); otherwise `current`. Stored understanding is usable immediately and is labeled rather than presented as current. The `{evidenceRevision, derivedThroughRevision}` shape is the watermark a later consumer (Project Understanding) can reuse. No UI change is part of this slice.

### Compaction (not performed)

Development databases created before migration 015 keep whole-batch captures (`evidence_captures.body`, `format IS NULL`); they remain readable and their provenance is filtered to the cited record. A future compactor must be an explicit, resumable operation: convert a legacy capture to journal rows and ranges → verify reconstruction by digest → mark it migrated → remove the redundant body → `VACUUM` later. Nothing is deleted silently. Migrations 011–015 were never released, so only development databases carry legacy captures.

## Identity, order and provenance

There are distinct addresses:

- **Capture ID**: one acquisition/delivery, stable across its retries. It is not a content hash. A→B→A must admit the later A.
- **Source record identity**: explicit provider record key, or a recorded source-local snapshot correspondence. A delta must supply an occurrence key; a stream resume token is not automatically such a key.
- **Output slot**: stable normalized sibling within a record, normally the existing ordinal.
- **Fact key**: optional, explicitly justified cross-source identity. Equal text is never sufficient to merge sources.
- **Vowe event ID/sequence**: an immutable admitted revision and monotonic admission order. Sequence is not a universal execution clock.
- **Physical location**: file/path, byte offset, line or transport address of the captured observation. It remains provenance, not logical identity.

Explicit keys survive moves and content corrections. ID-less snapshots match unchanged prefixes/suffixes (including repeated occurrences), then unique content anchors. The catalog survives truncation. Ambiguous repeated remnants become qualified `operation_reported` observations rather than invented additional semantic actions. Source reordering invalidates downstream continuity and exposes the chronology limitation in coverage. Raw snapshots retain their actual order. This deliberately does not build a universal partial-order execution graph.

Every capture is immutable. Event bodies, original raw objects and old belief records are retained. `evidence_event_support` pins the physical captures considered for each event revision, including corroborating or conflicting observations; it does not silently redirect an old citation to the newest report. Mutable heads, active flags and support indexes are current projections. `getEvents()` reads that projection, `audit:true` reads history, and ID-based citations can always open superseded events. Raw context reads use captured data rather than rereading a mutable provider file.

Legacy rows are adopted only at their old physical address with equal normalized content. Their IDs and sequence numbers remain intact. Raw-address uniqueness remains only for the compatibility ingestion path.

## Corrections and coverage

A changed keyed record, explicit retraction, or competing explicitly linked observation updates support. Established evidence outranks a report for the same explicit fact; equally ranked disagreements yield an explicit conflict report. These categories are assertions of the adapter's reviewed interpretation policy, never flags trusted from a provider payload.

An effective change appends an event revision and an audit change. It marks superseded events inactive, invalidates affected windows and their later continuity, clears current session understanding, and rewinds the observer cursor to the first affected window. Unaffected earlier notes remain eligible. Followed sessions recompute through the ordinary observer. Interpretation is refreshed through its existing runner. Generation fences prevent stale in-flight model results from restoring invalidated state.

Historical windows pin their event IDs. Sparse recomputed windows cite those members via a window ref, not a sequence range containing old superseded rows. Window notes append rather than overwrite. On restart, a durable unfinished window is reused; a committed note is reused if the process died before cursor advancement. Dependent memories are excluded from current retrieval transitively through lesson references, but historical records remain readable with an invalidation label. Surface updates and pending communication decisions lose eligibility when their evidence is invalidated. Already delivered conversation text is historical communication, not rewritten.

Normal history omission is **not retraction**: compaction, truncation and source loss do not assert that an execution never happened. A source describing a genuinely mutable current view may explicitly declare `membership: current-view`, but only with a complete snapshot of its named scope. Its omissions withdraw current support and preserve the audit. ID-less changed statements without a correspondence cannot be confidently labeled a correction; they remain separate reports under partial coverage.

Coverage is scoped, never a blanket session completeness claim. Missing sources emit unavailable batches. Recorded interruptions remain visible after reconnect: later availability does not prove reconstruction of a missing interval. The implementation currently underclaims coverage rather than automatically retiring gaps. The observer receives coverage and the desktop header exposes partial history. Discovery loss means unknown liveness, not finished execution.

## Provider migration

| Provider | Acquisition and identity | Behavior retained |
|---|---|---|
| Claude Code | `append-log` JSONL; `uuid` when present; otherwise source-local correspondence | Existing normalizer, sibling ordinals, tool/input correlation, discovery and SDK control |
| Pi | `append-log` JSONL; record `id` | Existing message-tree/raw metadata, readable reasoning, discovery and control. No new active-branch claim |
| Codex | `append-log` rollout; source-local correspondence where no stable record ID exists | Existing normalization, encrypted-reasoning treatment, attention and observe-only capabilities |
| Cursor | `delivery-cursor` hook receipts plus `mutable-snapshot` conversation transcript | New observation-only adapter feeding the same downstream path |

The retained-file reader relies on an append guarantee only where the adapter declares it, and verifies it (see *Scale*). It preserves undecodable lines as raw records, names an incomplete trailing line in coverage and captures it once complete, and discards a whole read that changed underneath it. Provider normalizers expose their carried state (`state()`/`restore()`) so a resumed read is identical to a full one.

Existing providers explicitly retain their interpretation of canonical command/tool-result records. New completion candidates without execution evidence are downgraded to reports. This slice does not re-audit every old provider's outcome heuristic. Cursor never adopts those legacy outcome assumptions.

## Cursor installation and exact mapping

Build packages, then run `pnpm --filter @vowe/adapter-cursor run setup`. This explicit installer merges user-level `~/.cursor/hooks.json`, preserving unrelated hooks. It copies a standalone collector to `~/.local/share/vowe/cursor/vowe-collector.mjs`; receipts are private files published atomically after fsync. Hook processes return `{}` and never inject instructions, permissions or context. No project configuration or private Cursor database is used. Capture continues while Vowe is closed. Node must remain available at the installed absolute path.

Session identity is `cursor:<conversation_id>`. Roots require an observed parent/root lifecycle or prompt hook; an unlinked child with only tool/thought/history evidence is retained in the spool and not automatically promoted. Explicit `parent_conversation_id`, when supplied, places actor-tagged evidence in the parent; that synthetic case is supported without inventing a parent link for the real unlinked child.

| Surface | Normalized mapping | Truth boundary |
|---|---|---|
| `sessionStart` | `session_started` | Historical creation/observation, not current liveness |
| `sessionEnd`, `stop` | `session_waiting` | Run ended; no `awaitingHuman`, no permanent completion |
| Readable `afterAgentThought` | `agent_reasoning` | Enables reasoning only for a session with actual text |
| Non-shell `preToolUse` | `tool_started` | Requested operation, input retained |
| Non-shell `postToolUse` | `tool_finished` | Reported result/output; no fabricated file contents |
| Non-shell `postToolUseFailure` | `tool_finished`, reported failure | Error preserved; no fabricated approval request |
| Generic Shell hooks | `operation_reported`, execution unknown | Neither command/test completion nor a successful run, even with exit code 0 |
| `afterFileEdit` | `file_changed`, qualified “Reported edit” | Path and edits; no second edit for Write start/result or transcript tool-use block |
| Specialized shell hooks | Raw supplemental evidence | No duplicate shell lifecycle without a verified join |
| Prompt/response hooks | Raw supplemental evidence | Transcript owns conversation text; these hooks were absent in local probes |
| Transcript user/assistant text | `user_instruction` / `agent_message` | Text-block ordinal; time unknown, not ingestion time presented as execution time |
| Transcript tool-use blocks / end marker | Raw supplemental evidence | Not tool results or additional semantic edits |
| Subagent lifecycle / unknown hooks | Raw metadata plus `unknown` | No invented hierarchy or control handle |
| Human input / approval | No mapped request from these captures | Pre-hooks and denials are not pending approvals |

Hook timestamps are receipt times. Model/version, roots, generation, provider IDs and unexpected fields remain raw. Correlation IDs are opaque and scoped by actor + tool name + tool-use ID; they are not logical occurrence keys. A single root is assigned as cwd; multiple roots remain unassigned and preserved as evidence. Source locations currently follow the latest reported parent transcript path; simultaneous divergent transcript locations are not merged. This is a documented limit, not an assumption that source paths are immutable.

Hook and transcript sources are intentionally complementary where no explicit cross-source operation identity is verified. There is no fuzzy semantic deduplication. Retrying a captured receipt is idempotent. Separate provider deliveries without a stable delivery identity remain separate observations; the adapter cannot prove that identical payloads represent retransmission rather than repeated work.

Capabilities: observe when a discoverable session has captured evidence; reasoning only after readable thought text; sendInstruction, interrupt, resume and launch all false. Session liveness stays unknown. The existing small Cursor SVG/name remains in the shared glyph component with `currentColor` sizing and no new asset system.

## What falsification changed

1. Real transcript resume rewrote the old byte prefix and inserted a prompt before the old cursor. All four observation paths now use captured snapshots instead of extending the append-reader assumption.
2. Real rejected shell calls produced exit-zero hooks. Core admission distinguishes reports from execution, and Cursor shell results stay unverified.
3. Repeated identical messages defeated content-only deduplication. Matching now preserves occurrences with context, with explicit ambiguity when that context is insufficient.
4. A→B→A defeated content-hash capture IDs. Capture occurrence and record correspondence are distinct.
5. Truncate/restore required a retained identity catalog, not just the last snapshot's positions.
6. Correction tests exposed stale in-flight observer results, historical support redirection, checkpoint/memory eligibility and sparse-window range citations. Each now has a regression test.
7. Actual process termination after capture and before admission required startup recovery from captured bytes independently of source availability.
8. Reconnection could hide an earlier gap. Interruption history is now part of current coverage.
9. A running development preview had older migrations than rebuilt modules. Its captured-but-unadmitted data remained durable; refreshing the process applies migration/recovery. Do not mix live old processes with partially rebuilt packages during development.
10. Replaying real local histories exhausted the desktop heap at startup (peak RSS 1.5 GB on a fresh store, 2.9 GB against the 8.7 GB development database; one Codex session held 238 whole captures, 1.9 GB). Every stat change re-captured the whole file, admission held five representations of it, restart re-captured everything, and state JSON, support links and supports' embedded raw payloads grew per capture. Acquisition is now streamed and checkpointed, storage record-level, and admission indexed (see *Scale*).

## Concrete future-source pressure tests and limits

Remote streams use source-local occurrence keys and opaque acknowledged checkpoints. Replay deliveries are idempotent; cursor expiration emits a retained gap. An SSE event ID used on several event types is not by itself a record key. ID-less sticky status should be represented as a mutable view, not pretended to be a unique append event. Live-only sources remain partial across offline intervals. Complete mutable views can withdraw support. Nested workers remain actors unless independently justified as sessions.

Cursor Cloud's documented per-run streams/control APIs were researched separately; no cloud adapter or cloud control was enabled. CLI behavior has been exercised, desktop IDE Agent hook behavior has not. No private SQLite fallback was needed. Prompt/response/subagent hook delivery, approval requests, multi-root project assignment, arbitrary cross-source identity and multi-location divergent histories remain limitations. Observation still follows Vowe's existing interest/follow policy; recording evidence does not automatically buy model understanding for every discovered session.
