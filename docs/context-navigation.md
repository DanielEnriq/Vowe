# Context navigation

One lean, read-only interface onto everything Vowe can see, shared without
variation by the observer following the work and by the runner answering the
developer's questions.

If those two had different views, an answer could contradict an observation and
neither would be checkable. So they get the same tools, the same results, and
the same limits.

The toolset is deliberately small: **search, then zoom in**, plus diffs.

## References

Every result is a reference, not a payload. A reference is an address into
observed material, with a compact string form so a model can read one out of a
search result and hand it straight back.

| Kind | String form | Points at |
|---|---|---|
| `window` | `window:<sessionId>:<windowId>` | An interpreted window: its note, and the L0 range beneath it |
| `trace` | `trace:<sessionId>:<start>-<end>` | A range of the native trace, by event sequence |
| `event` | `event:<sessionId>:<eventId>` | One normalized event, and through it one raw provider record |
| `transcript` | `transcript:<sessionId>:<eventId>` | A point in the worker/developer exchange |
| `repo` | `repo:<path>#<line>` | A location in the working tree |
| `diff` | `diff:<sessionId>#<path>` | The current diff, optionally narrowed |

Session ids contain a colon of their own (`claude-code:abc123`), which is why
`repo` and `diff` separate their path with `#` rather than another colon.

`parseRef` returns `null` for anything it does not recognize rather than
throwing. A model will produce nonsense occasionally, and a thrown error
mid-observation would cost a window.

Every L1 note, every surface candidate and every delegated answer carries the
references to the material it was derived from. That is what makes "show me why
you think that" a button rather than a promise.

## `search_context`

```ts
search_context({ sessionId, query, sources?, limit? })
```

| Source | Searches |
|---|---|
| `windows` | L1 note summaries, current activity, notable changes |
| `trace` | Normalized event summaries and their detail, which already carries truncated command output and file paths |
| `transcript` | Only what was actually said — agent messages, developer instructions, the opening prompt |
| `repo` | The working tree |

Defaults to `windows`, `trace` and `transcript`. The budget is allocated across
the requested sources so one noisy source cannot crowd out the others.

Returns references and **bounded snippets** — roughly 600 characters each, about
a dozen hits. Not material. Descending is a decision the caller makes
explicitly, which is the entire point of having two tools instead of one.

### `repo` needs no index

It shells out to `git grep`, and it still does — but it is no longer all.

**This is the contract future work improves behind.** A repository index, a
semantic code graph or an embedding store would change what `repo` searches and
how well it ranks — and would change nothing about the signature, the result
shape, or any caller. Same for `windows`: today it is substring matching over
note text; tomorrow it could be a vector search. The seam is the point.

### What went through that seam

A code graph and a durable project memory, and the claim held: `searchContext`
kept its signature, `SearchHit` kept its shape, no caller changed, and the
model-facing toolset was not touched. `repo` results now carry two new ref
kinds, `symbol:` and `lesson:`, which `open_context` descends from in the
ordinary way.

The one thing worth knowing is the ordering. **Graph and memory hits augment
`git grep`; they never replace it.** Grep keeps half the budget unconditionally,
so an index that is stale, still building or absent can only ever add nothing —
it can never hide a file that is on disk right now. `repo` still needs no index
to work at all, which is what makes the whole feature optional.

See [project knowledge](project-knowledge.md).

## `open_context`

```ts
open_context({ ref, depth? })
```

Descends into something a search returned.

| Ref | What comes back | What it hands you next |
|---|---|---|
| `window` | Its L1 note, plus the window's range and byte offsets | The trace range beneath it |
| `trace` | The normalized events in that range | The individual events |
| `event` | The event, with its detail | — |
| `transcript` | The surrounding exchange, not just the one message | — |
| `repo` | The file, or a numbered slice around the line | — |
| `diff` | The current diff | — |

Three depths:

- `summary` — orientation only.
- `full` — the normalized material. The default.
- `raw` — **re-reads the provider's own record from its own file**, at the byte
  offset the adapter captured. This is the bottom of the descent, and it exists
  because the normalizer truncates command output: "what did it actually print?"
  must always be answerable.

A single message is rarely the answer, so a `transcript` ref returns the
exchange around it rather than the message alone.

## `get_diff`

```ts
get_diff({ sessionId, path?, around? })
```

Diffs stay first-class because "what did it actually change?" is the question
that most often cannot be answered from the trace at all — the trace records
that an edit happened, not what the file looks like now.

Shells `git diff HEAD` in the session's working directory, staged changes
included, with `--stat` alongside the patch. `around` takes a path from a
reference when the caller has one but not a filename.

Current state only. Historical diff reconstruction would mean keeping our own
copies of the tree or replaying edits, and neither is justified yet.

## `surface_update`

```ts
surface_update({ sessionId, message, whyNow, refs, urgency? })
```

The observer's communication primitive: *I think this development may be worth
bringing to the human's attention.*

**Calling it does not speak.** It records a candidate and returns. What happens
next is `CommunicationPolicy`'s decision, and delivery is the `LiveBridge`'s.
Keeping those three apart is why "only tell me when something is weird" can be
honoured at all — and why the tool's own description says so, because a model
that believes it is interrupting someone will use it far more sparingly than it
should.

### Why it is not on the ContextNavigator

The navigator is read-only, and its three tools go to both the observer and the
delegated-question runner. Proposing to interrupt a human is not a read, and the
question-answering path must not be able to do it.

So `surface_update` lives on a separate `SurfaceUpdateSink`, handed only to the
observer. It is documented here because it belongs to the same toolset from the
model's point of view — but in the object graph it is deliberately elsewhere.

**It is available on every observer pass, without exception.** The decision
router gates whether a window gets the *read* tools, which is a question about
cost. Whether a window may raise something is not a question anyone gets to gate.

## Limits

Every result is bounded before it is returned: snippets to ~600 bytes, a single
`open_context` payload to ~12KB, `git diff` to ~24KB, all with explicit
truncation markers. The tools return references so that context stays small; a
tool that quietly returned a megabyte would defeat its own purpose.
