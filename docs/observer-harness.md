# The observation harness

Vowe follows a coding agent's work continuously, keeps an understanding of it
that can be traced back to evidence, and decides — against what the developer
actually asked for — whether any of it is worth interrupting them about.

```
coding-agent trace
      ↓
L0 native trace            the provider's own record, never copied
      ↓
WindowBuilder              bounded, ordered slices
      ↓
ObserverRunner             one at a time, in order, with a persisted cursor
      ↓
L1 window notes            what was understood, with pointers back down
      ↓
CommunicationPolicy        is this worth saying, given what they asked for?
      ↓
Vo / GPT Live
      ↕
user
```

## Two levels, and only two

**L0 — the native trace.** Whatever the coding agent itself records: messages,
tool calls, command output, edits, diffs, test runs. Vowe does not own it and
does not re-encode it. `NormalizedEvent` carries the provider's record verbatim
in `raw`, plus a `rawRef` giving its source file, byte offset and line.

There is deliberately no typed `Evidence` ontology. The trace *is* the evidence;
the job is to keep it reachable, not to re-describe it.

**L1 — interpreted windows.** The trace divided into bounded slices, each with a
note saying what happened in it. L1 is an orientation layer — an index with
pointers down — not a replacement. Every question that needs more detail
descends:

```
L1 window  →  trace range  →  normalized events  →  the provider's own record
```

There is no level above L1 in this slice. No episodes, no summaries of
summaries, no long-term memory.

## WindowBuilder

`packages/core/src/observation/window-builder.ts`

Takes a session's normalized event stream and produces ordered windows. A window
stores *ranges*, never material: a `seq` range (the logical handle) and a
`source` plus byte offsets (the physical address, so the original transcript can
be re-read without going through Vowe at all).

Sizing is one configurable object, threaded in from the application wiring:

| Bound | Default | Closes a window when |
|---|---|---|
| `maxEvents` | 40 | it holds this many events |
| `maxApproxTokens` | 6000 | the estimated size reaches this |
| `maxElapsedMs` | 120s | this much *trace* time has passed inside it |
| `idleGapMs` | 180s | the trace goes quiet — a natural boundary |
| `closeOnUserTurn` | true | a new developer turn begins — also natural |

**Time is measured from event timestamps, never the wall clock.** This is what
makes windowing a pure function of `(events, policy)`: replaying a recorded
session tomorrow produces exactly the windows it produced today. A builder that
read the clock would make replay-based tuning meaningless.

Invariants, in order of importance:

1. **Nothing is skipped.** Every event lands in exactly one window.
2. **Windows are ordered and contiguous.** `windows[n+1].startSeq` is always
   `windows[n].endSeq + 1`.
3. **The source range is recoverable**, logically and physically.
4. **Changing the sizing changes only the sizing.** Nothing downstream depends
   on how windows were cut.

`flush()` closes the open tail. It is used for a finished trace — replay, or
catching up to the head — and never mid-stream on a live session, because
closing a window early just because nothing has arrived yet would make the same
trace produce different windows depending on how fast it was read.

## ObserverRunner

`packages/core/src/observation/observer-runner.ts`

One per observed session. A single serialized loop:

```
new trace → WindowBuilder → next closed window → observer → L1 note → cursor → continue
```

**Windows are interpreted strictly in order.** The observer's whole value is
that note N+1 was written by something that had already read note N; process
them concurrently and that continuity is gone.

The instruction is not "summarize this chunk". It is: *given your recent
understanding and this new portion of the trace, update your understanding of
what happened, what changed, what the worker appears to be doing now, and
whether anything notable occurred.*

Continuity is bounded — the task, the last four notes, the recent messages, the
current window, and optionally one older window judged relevant. Appending every
historical window would grow without limit and drown the current one.

**The cursor is persisted after every note.** That is what makes restarting
cheap rather than destructive: a session with a thousand windows behind it
resumes at window 1001, and a crash mid-window costs exactly one window of
repeated work.

Two high-water marks, deliberately separate: how far the *builder* has consumed,
and how far *interpretation* has got. Conflating them re-windows trace that
arrives while a window is in flight.

A window that cannot be interpreted still advances the cursor. Retrying forever
would stall observation permanently, and the trace is not lost — it stays
addressable in L0.

## Three different things

This is the distinction the whole design exists to maintain.

### Observation

Following the work. Produces L1 notes. Never speaks. Runs whether or not anyone
is listening, and whether or not voice is configured at all.

### Proactive communication

The observer calls `surface_update` when it thinks a development may be worth a
human's attention. **That call does not speak.** It records a candidate.

`CommunicationPolicy` then evaluates the candidate against the session's one
plain-language preference — "only tell me when something weird happens", "keep
me closely updated on this one" — and returns one of four actions:

| Action | Meaning |
|---|---|
| `ignore` | Recorded, and nothing more |
| `quiet_context` | Given to Vo silently, so it can answer if asked |
| `speak_now` | Worth interrupting for, right now |
| `queue` | Worth saying, held until the developer next speaks |

Resolution order: the decision model, then a cheap model call, then a
deterministic floor. The floor errs quiet, because an assistant that interrupts
wrongly is worse than one that stays silent and can answer when asked.

Deciding to speak and having spoken are recorded separately, so "approved but
never said" is visible rather than invisible.

### Delegated questions

The developer asks Vo something Vo cannot answer from its background updates.
`DelegatedQuestionRunner` investigates with the same three read tools the
observer has, and returns a grounded answer.

It is read-only by construction: no `surface_update`, no control path, no
adapter or registry anywhere in its object graph.

## Concurrency

Two independent loops. This is load-bearing.

```
LOOP A                          LOOP B
trace → window → note           user speech → Vo → delegated question
  → next window                   → ContextNavigator → answer
```

- The observer has a per-session queue with a coalescing re-drain. New trace is
  accepted synchronously and never waits behind a model call.
- A delegated question never touches that queue. A long investigation cannot
  pause ingestion, and a slow window cannot delay an answer.
- A window that closes mid-conversation is persisted and becomes available to
  the next turn naturally.

The only shared resource is the store, whose writes are already serialized.

## Degrading

| Missing | What still works |
|---|---|
| Decision model | Everything. Every call site has a deterministic fallback; `null` means "decide this yourself" |
| Voice credential | Observation, windows, notes, candidates, decisions, the whole text view. The UI says Vo is unavailable |
| Observation model | Windows are still built and recorded; notes say plainly that nothing interpreted them |

## Replay

`packages/replay/` runs a recorded trace through the real harness — real store,
real window builder, real observer runner, real navigator — varying only the
observation model. It is how window sizes, observer prompts, decision-model use
and surfacing behaviour get tuned.

```bash
pnpm replay packages/replay/fixtures/repeated-failures.synthetic.jsonl
pnpm replay packages/replay/fixtures/vowe-session.sanitized.jsonl --max-events 12
```

Fixture provenance is documented in
[`packages/replay/fixtures/README.md`](../packages/replay/fixtures/README.md).
No test reads `~/.claude`, and nothing in the replay path starts a coding agent.
