# Project knowledge

Vowe understood the work and not the codebase. When the observer or the
investigator met something it did not understand about the repository, its only
recourse was `git grep` — no structure, no ranking, and nothing kept. Every
session rediscovered the same things.

A Project now has durable knowledge of its own repository, and that knowledge
survives Vowe quitting.

```
                     Project knowledge
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
  Repository structure                      Work memory
  what the code contains                what Vowe worked out
  a code graph, extracted               grounded answers, kept
  Graphify owns it                      ← Vowe owns this
        │                                         │
        └────────────────────┬────────────────────┘
                             │
                    ContextNavigator
                             │
        search_context · open_context · get_diff
                             │
           Observer · DelegatedQuestionRunner
```

## Two kinds of knowledge, two owners

The split is the design, not an implementation detail.

| | Structure | Memory |
|---|---|---|
| Records | What the repository contains and how it connects | What Vowe worked out while working in it |
| Built by | Graphify, from the AST | Vowe, from its own grounded answers |
| Lives in | `knowledge/graphify-out/` | `knowledge/memory.ndjson` |
| Owner | The indexer | **Vowe** |
| Survives the indexer being removed | No | **Yes** |

**Vowe owns memory.** Graphify's `save-result` and `reflect` are called when
available, so its `LESSONS.md` carries Vowe's findings too — useful when a
developer runs `graphify` themselves, or another agent uses its skill. But
nothing reads that back. Remove Graphify tomorrow and `git grep` still works,
every remembered lesson still answers, and only graph-shaped retrieval goes
away.

That is also why `memory.ndjson` sits *beside* `graphify-out/` rather than
inside it. Deleting that directory to force a rebuild must not throw away the
understanding.

## Where it lives

Nothing is ever written inside the user's repository.

```
<storeRoot>/projects/<safeProjectId>/
  knowledge/
    index.json            RepoIndexState, written atomically
    memory.ndjson         ← Vowe's canonical memory, append-only
    graphify-out/         Graphify's own directory, under Vowe's
      graph.json  manifest.json  cache/
      memory/  reflections/LESSONS.md
```

`<storeRoot>` is the existing Vowe data root, alongside `sessions/<safeId>/`.
One data root, not two.

## The model-facing toolset does not change

```
search_context     open_context     get_diff
```

No `graph_query`, no `remember_fact`, no `read_lessons`. **This is checkable
rather than aspirational: `packages/llm/src/observation-tools.ts` was not
touched by this work.** The `sources` enum is unchanged; both kinds of knowledge
arrive under `sources: ["repo"]`, and the caller never decides which store a
fact lives in.

Two new ref kinds carry the results:

| Ref | String form | Points at |
|---|---|---|
| `symbol` | `symbol:<projectId>#<nodeId>` | A node in the code graph |
| `lesson` | `lesson:<projectId>#<recordId>` | Something Vowe worked out and kept |

Both split on `#`. A project id contains a colon of its own, and a graph node id
is the indexer's opaque string — Vowe does not get to assume what is in it.

## Structure is orientation, never truth

```
graph   →  where should I look?
source  →  what is actually implemented?
diff    →  what did this worker change?
trace   →  what did it actually do?
```

`open_context` on a `symbol:` ref does not stop at what the graph says. It reads
the file, because the graph was built at some point in the past and the file is
true now. A caller that only saw the graph's description could repeat a claim
the source stopped supporting three commits ago.

**Graph knowledge augments `git grep`; it never replaces it.** Grep keeps half
the budget unconditionally. That ordering is the safety property: an index that
is stale, still building or absent can only ever add nothing, and can never hide
a file that is on disk right now.

Line numbers come from the graph's `source_location` when it has one. Graphify's
own documentation is explicit that it may not, so when it does not, Vowe looks
for the symbol's name in the file and otherwise returns the file with no line.
**It never invents one** — pointing somebody at the wrong place is worse than
pointing at the whole file.

## Index lifecycle

```
unindexed ──ensureIndexed──▶ indexing ──▶ ready
                                │           │
                              error ◀───────┤
                                            ▼
                              file_changed / HEAD moved
                                            ▼
                                          stale ──refresh──▶ ready
```

**A read never waits on a write.** The first repository question on an unindexed
project starts `graphify extract --code-only` in the background and returns grep
results immediately. A cold extract of a large repository takes minutes, and the
caller is often part-way through answering out loud; a correct answer four
minutes late is a worse failure than an incomplete one now. The next question
benefits from the build this one started.

**Asking is the only trigger.** Opening a Project's room reads the persisted
state and starts nothing. Vowe indexes a repository because somebody wanted to
know something about it.

`stale` is not an error state. A slightly-behind graph keeps serving while
`graphify update` runs — it only ever orients, and the source and the diff are
authoritative anyway.

## Staleness without a watcher

Vowe has no filesystem watcher and does not need one. Two signals:

- **`file_changed` events.** The workers Vowe observes are the ones doing the
  editing, and the adapters already normalize their `Edit`/`Write` tool calls
  into events. Marking is immediate so the UI tells the truth straight away;
  refreshing waits out a quiet period, because a worker mid-edit produces bursts
  and re-indexing each one would cost far more than the change is worth.
- **A moved `HEAD`.** `indexedCommit` is compared on each request, which catches
  a `git pull` or a branch switch that no observed session performed.

Refresh is always `graphify update`, never a full `extract`.

## Memory admission

Conservative, and it fails closed. Two gates, and the default at every step is
no.

```
grounded in the repository?        ← at least one symbol: or repo: ref
   no  → reject
   yes → decision model
           unavailable / null / error  → DO NOT remember
           noul >= 0.7                 → remember
           otherwise                   → reject
```

The first gate is **structural, not linguistic**. An answer built only from the
trace, an event, the transcript or the diff is about *this worker, right now* —
"what command is it running?" is answerable, useful, and worthless tomorrow.
Testing the refs rather than the wording means the rule holds however the
question happened to be phrased, and it rejects that class of question before
the model is consulted at all.

The second gate is the decision model, asked something stricter than "is this
durable":

> Would this still plausibly help an engineer understand this repository in a
> future, unrelated coding session?

The threshold is `0.7`, not the `0.5` the observer uses to decide whether to
explore a window. The two decisions are not symmetric: exploring one window too
many costs a few tokens once, while remembering one thing too many costs every
future search in this repository for as long as the project exists.

**This departs, on purpose, from the `DecisionRouter` convention that every call
site carries its own deterministic fallback.** The deterministic fallback here
*is* "do not remember". Stated plainly: **with no decision model configured,
Vowe records corrections and nothing else.** A sparse memory costs a
rediscovery, which you pay once. A polluted memory costs every search, and there
is no way back out of it.

The model decides *whether*. It never writes the memory.

## Recording, and corrections

```
grounded answer → admission → ProjectMemoryStore   ← canonical
                                   └→ mirror: graphify save-result / reflect
```

Recording happens in the harness, after the answer has been delivered — never
during, and never awaited, so nothing a listener does can delay an answer
somebody is waiting to hear. The mirror is best-effort: one that throws, hangs
or is absent changes nothing about what Vowe remembers.

Corrections **bypass admission entirely**. Somebody has told Vowe it was wrong,
and there is no version of "is that worth keeping?" worth asking a model. They
also reflect immediately rather than waiting for a batch: a correction that has
not propagated leaves the superseded answer standing in the lessons file, which
is worse than never having recorded either.

A correction is a new record that supersedes an old one, never an edit. The
superseded record stops appearing in results — that is the whole point of
recording one — but stays in the file, because how Vowe came to believe the
right thing is part of what happened.

Corrections are never inferred. Recording one is an explicit act.

## Retrieved, not injected

Neither the graph nor the memory is ever put into an observer's context. That
would recreate exactly the context-bloat problem the harness exists to avoid.
They are external stores, and the model gets only what it asks for.

## Graphify is detected, never installed

Graphify is a Python tool. It cannot be a dependency of this workspace, so Vowe
probes for it and degrades around it:

```bash
uv tool install graphifyy      # the PyPI package is `graphifyy`; the binary is `graphify`
```

Extraction runs `--code-only` by default: local AST, deterministic, **no API
key**. A version floor is enforced by asserting rather than resolving, since
there is no lockfile to pin a Python tool into. A desktop app launched from
Finder inherits a minimal `PATH`, so if the bare name is not found Vowe also
looks in `~/.local/bin` before giving up.

See `.env.example` for `VOWE_GRAPHIFY_BIN`, `VOWE_GRAPHIFY_MIN_VERSION`,
`VOWE_GRAPHIFY_DISABLE` and `VOWE_GRAPHIFY_BACKEND`.

### What the documentation gets wrong

Four things were settled by running the binary rather than reading about it, and
the adapter depends on all four:

| Claim | Reality |
|---|---|
| `--out DIR` is the output directory | It is the **parent**; Graphify creates `DIR/graphify-out/` |
| `GRAPHIFY_OUT` is interchangeable with `--out` | It names the `graphify-out` directory itself, and is the only thing `update` honours |
| `save-result` and `reflect` inherit the output root | They take `--memory-dir`, defaulting to a path relative to the working directory — which would be the user's repository |
| `reflect --if-stale` exists | It does not. Deciding when reflection is worth running is Vowe's job |

Nodes *do* carry line numbers, as `"L42"` in `source_location`, which the
documentation says not to count on. Vowe uses them when present and copes when
they are not.

## The one place that knows about node-link

`packages/knowledge-graphify/src/graph-reader.ts`, and nowhere else. It reads
`graph.json`, tolerates `links` versus `edges`, missing source files, absent
line numbers and the underscore-prefixed flags the AST extractor uses in place
of a type field, and normalizes all of it into shapes Vowe defines. Everything
above it sees `ProjectKnowledgeHit` and `ProjectKnowledgeResult`.

Retrieval is lexical matching plus one behavioural hop, behind a `Retrieval`
interface. It is the *initial implementation*, not the abstraction — embeddings
or a learned ranker would replace it without touching anything above.

The hop is what earns its place. Asking how two classes connect should surface
the function between them, which no amount of matching on the question will
find. Nesting edges (`contains`, `method`) are free to cross, because the real
extractor makes a method its own node and charging a hop to step from a class
into its own method stops the search one short of the answer.

## What project knowledge is not, yet

- **No embeddings and no vector store.** Retrieval is lexical and the graph is
  deterministic. Both are behind interfaces if that changes.
- **No graph visualization and no memory browser.** The Project Room shows a
  status pill. This is infrastructure for answering questions, not a second
  application bolted onto the side of the first.
- **No project-level Vo,** and no cross-session orchestration.
- **No automatic correction inference.** Somebody has to say Vowe was wrong.
- **No traversal routing.** One question maps to one query. Paths, god nodes,
  affected-set analysis and the rest stay unused until an evaluation shows the
  plain query is insufficient.
- **No semantic extraction by default.** Docs, schemas and PDFs need a model
  key; `VOWE_GRAPHIFY_BACKEND` opts in.

See [context navigation](context-navigation.md) for the toolset this sits
behind, and [projects](projects.md) for the hierarchy it belongs to.
