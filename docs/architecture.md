# Architecture

Vowe observes coding-agent sessions, maintains an understanding of what each
one is doing, lets you converse about that work, and — separately and
explicitly — lets you instruct the worker.

Task 1 implements one complete vertical slice with one real provider. Every
application-level concept is provider-independent.

## The four boundaries

The product's central claim is that these are four different things. In the
code they are four different objects, with deliberately different reach.

```
┌──────────────┐   writes transcript    ┌──────────────┐
│    WORKER    │ ─────────────────────▶ │   OBSERVER   │
│ Claude Code  │                        │ adapter tail │
│   process    │ ◀───────────────────── │ + normalizer │
└──────────────┘   Agent SDK            └──────┬───────┘
        ▲                                      │ NormalizedEvent (+ raw)
        │                                      ▼
        │                              ┌──────────────┐
        │                              │  EventStore  │
        │                              └──────┬───────┘
        │                                     │
        │                          ┌──────────┴──────────┐
        │                          ▼                     ▼
        │                 ┌──────────────┐      ┌──────────────┐
        │                 │ INTERPRETER  │      │  COMPANION   │
        │                 │ heuristic /  │      │ fronts the   │
        │                 │ LLM          │      │ investigator │
        │                 └──────────────┘      └──────────────┘
        │
        │  ┌──────────────────┐
        └──│ CONTROL CHANNEL  │  registry.sendInstruction → adapter
           └──────────────────┘
```

**Worker** — the real coding agent. Only `@vowe/adapter-claude-code` knows it
exists.

**Observer** — the adapter's transcript tailer and normalizer. Produces
`NormalizedEvent`s that always carry the provider's original record (`raw`) and
its physical address (`rawRef`).

**Companion** — `CompanionService`, constructed with an `EventStore` and the
one `DelegatedQuestionRunner`. It is a facade: a typed question and a question
delegated from Vo reach the *same* investigator instance, with the same three
read tools and the same hook into project memory. It holds no adapter, no
registry and no transport. Asking Vowe a question cannot reach the coding agent
because there is nothing in the object graph to reach it with.

**Control channel** — `SessionRegistry.sendInstruction()`, which owns the
adapters. A separate IPC handler (`vowe:agent:send-instruction`) and a separate
button ("Send to agent") in the UI.

The separation is verifiable, not decorative: ask a question containing a unique
marker, then grep the worker's transcript for that marker. It is not there.

## Projects

Sessions have a durable parent:

```
Project  →  AgentSession  →  Observation
```

A Project is a Git repository, resolved from a session's `cwd` and assigned in
`SessionRegistry.absorb()` — the adapter reports where a session is and knows
nothing about projects. Stored project state is identity only; membership lives
on the sessions and every aggregate is derived.

This changes nothing about the boundaries below: observation, companion and
control all still operate per session. See [Projects](projects.md).

## Packages

| Package | Responsibility | May import |
|---|---|---|
| `@vowe/core` | Session model, capabilities, normalized events, registry, store, interpretation, companion, the `LlmClient` interface | nothing provider- or vendor-specific |
| `@vowe/adapter-claude-code` | One provider adapter | `@vowe/core`, `@anthropic-ai/claude-agent-sdk` |
| `@vowe/llm` | `AnthropicLlmClient` | `@vowe/core`, `@anthropic-ai/sdk` |
| `@vowe/desktop` | Electron shell, IPC, React UI | all of the above |

`@vowe/core` never names a provider and never imports a model vendor SDK.
`@vowe/llm` is the only place `@anthropic-ai/sdk` appears.

## Domain model

`AgentSession` (`packages/core/src/types/session.ts`) carries `id`, `provider`,
`providerSessionId`, `attachMode`, `task`, `displayLabel`, `cwd`, `status`,
timestamps, `capabilities` and `semanticState`.

`task` is derived from observation — the developer's own opening words — never
from a predefined role. Nothing in the system assumes how many sessions exist
or what they are called.

### Capabilities are per session, computed every discovery pass

Providers are not uniformly controllable, and the same provider is not
uniformly controllable across sessions. `SessionCapabilities`
(`observe`, `sendInstruction`, `interrupt`, `resume`) is recomputed from the
session's current `attachMode`, and `sendInstruction` re-checks it at call time
because a session can change mode at any moment.

## Normalized events

`NormalizedEventKind` is a small common vocabulary: `session_started`,
`agent_message`, `user_instruction`, `tool_started/finished`,
`command_started/finished`, `file_changed`, `test_started/finished`,
`permission_requested`, `session_waiting`, `session_finished`, `unknown`.

Two invariants:

1. **Raw evidence is never discarded.** Every event carries `raw` plus a
   `rawRef` giving the source file, byte offset and line.
2. **Failure to classify is not a reason to drop.** An unrecognized record
   becomes `unknown` and is stored like any other. An explicit deny-list filters
   records that are known CLI bookkeeping (UI mode flips, cost counters); that
   list is a decision, not a fallthrough.

## Interpretation

`SemanticInterpreter` has two implementations:

- `HeuristicInterpreter` — deterministic, always available, needs no
  credentials. This is the floor the product degrades to.
- `LlmSemanticInterpreter` — computes the heuristic result first, then asks the
  `LlmClient` to improve it, and returns the heuristic result if the model
  fails. A slow or broken model can never leave a session with no state.

`InterpretationRunner` debounces: a pass runs once a session has been quiet for
15s, or immediately after 25 unprocessed events.

Every `SemanticState` carries `provenance.eventIds`. The UI resolves those back
to stored events, each expandable to its raw record. That is how you check what
evidence produced Vowe's description of a session.

## The observation harness

The interpretation layer above is a *snapshot*: one debounced pass over recent
events, overwriting a single state object. It answers "what is this session
doing right now?" and nothing else.

Following long work needs something different — bounded windows, an
understanding that accumulates, a way to look things up, and a decision about
whether any of it is worth interrupting a human about. That is the observation
harness, and it is additive: `SemanticState` and `InterpretationRunner` are
unchanged and still drive the interpreted-state panel.

```
L0 native trace → WindowBuilder → ObserverRunner → L1 notes
                                       ↓
                             CommunicationPolicy
                                       ↓
                                  LiveBridge → Vo ↔ user
```

Three new boundaries, each with deliberately different reach:

| Object | Holds | Cannot |
|---|---|---|
| `ObserverRunner` | store, navigator, observation model | reach a worker — no adapter, no registry |
| `DelegatedQuestionRunner` | store, navigator, model | surface anything, or reach a worker |
| `LiveBridge` | transport, observation service, delegated runner | read the trace itself |
| `CompanionService` | store, delegated runner | anything the runner cannot |

There is **one** `DelegatedQuestionRunner`, constructed once in the application
wiring and handed to both `CompanionService` and `LiveBridge`:

```
       text ──▶ CompanionService ──┐
                                   ├──▶ DelegatedQuestionRunner ──▶ ContextNavigator
      voice ──▶ LiveBridge ────────┘
```

Typing a question and speaking it have access to the same intelligence.
Modality decides presentation — the short spoken form versus the full written
one — never reasoning capability. One instance is also why memory admission
needs no per-modality wiring: there is a single `onAnswer`, and nothing
downstream of it asks how the question arrived.

`DecisionRouter` and `LiveTransport` join `AgentAdapter` and `LlmClient` as
interfaces whose implementations live in their own packages, so `@vowe/core`
still imports no vendor SDK at all.

See [the observation harness](observer-harness.md),
[context navigation](context-navigation.md) and [the live bridge](live-bridge.md).

## Persistence

`SqliteEventStore` is the canonical local database. One file under
`<userData>/vowe/`, opened with `node:sqlite` — no dependency, no ORM:

```
vowe.sqlite            the whole of Vowe's durable history
vowe.sqlite-wal/-shm   write-ahead log, removed on a clean shutdown
profile.json           who the developer is        (configuration, not history)
presence.json          who Vowe is                 (configuration, not history)
projects/<id>/         project knowledge — a directory, and staying one
```

Tables: `projects`, `sessions`, `events`, `semantic_states`,
`conversation_entries`, `conversation_deliveries`, `windows`, `window_notes`,
`surface_updates`, `observation_state`. Columns carry anything ordered, filtered
or looked up; JSON carries payloads only ever read whole — `raw`, `detail`,
`capabilities`, `refs`, `provenance`, `investigation`, `decision`.

Windows store ranges, never material: the raw trace stays where the provider
wrote it, and `observation_state` is what lets a restart resume rather than
reinterpret.

Reads are real queries, not a cache. `node:sqlite` is synchronous, which is what
lets `EventStore` keep its original shape — synchronous reads, async writes —
without holding whole sessions in memory the way NDJSON had to.

`appendEvent` is idempotent on `rawRef`, enforced by a unique index rather than
a set held in memory, so re-reading a transcript after a restart cannot
duplicate history. Its `seq` is assigned inside the insert, under SQLite's write
lock, which is what keeps it gap-free without a counter that could drift.

`PRAGMA journal_mode = WAL`, `synchronous = FULL`, `foreign_keys = ON`. Full
durability is deliberate: `onConversationChanged` promises in writing that an
entry is durable and readable before a listener hears about it, and the
notification fires after `COMMIT` returns.

### Migrations

An ordered list in `store/sqlite/migrations.ts`, recorded in a
`schema_migrations` table — `001_initial_store`, then
`002_conversation_delivery`. Each runs inside its own transaction together with
the row recording it, so a failure leaves the schema and the version untouched
rather than half-applied, and says which migration failed. A shipped migration's
SQL is frozen: it describes the database an older Vowe actually wrote, and
regenerating it from the current types would make migrating forward untestable.

### Conversation and delivery

A `ConversationEntry` is the complete semantic turn. A `ConversationDelivery` is
what happened while communicating it. An answer interrupted halfway through
being spoken is **one** entry holding the full text plus one delivery recording
how far the audio got — never a truncated entry, and never a second copy of the
answer. That is also what lets a turn stay persisted exactly once as voice grows
up: a surface that did not write the entry attaches a delivery to it.

### Starting over

There is no importer and no legacy reader. A directory still holding the old
NDJSON files opens as an empty database, and those files are left exactly where
they are — startup never deletes anything. To start clean, call `resetDatabase`
or delete `vowe.sqlite*` by hand.

Still deliberately file-backed: `profile.json` and `presence.json` are
configuration with no history worth keeping, and `projects/<id>/` holds a code
graph and project memory that an external tool reads and writes.
