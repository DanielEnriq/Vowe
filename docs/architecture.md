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
        │                 │ INTERPRETER  │─────▶│  COMPANION   │
        │                 │ heuristic /  │      │ answers from │
        │                 │ LLM          │      │ stored state │
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

**Companion** — `CompanionService`, constructed with an `EventStore` and
optionally an `LlmClient`. It holds no adapter, no registry and no transport.
Asking Vowe a question cannot reach the coding agent because there is nothing
in the object graph to reach it with.

**Control channel** — `SessionRegistry.sendInstruction()`, which owns the
adapters. A separate IPC handler (`vowe:agent:send-instruction`) and a separate
button ("Send to agent") in the UI.

The separation is verifiable, not decorative: ask a question containing a unique
marker, then grep the worker's transcript for that marker. It is not there.

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

## Persistence

`NdjsonEventStore` writes append-only NDJSON under
`<userData>/vowe/`:

```
sessions.json                        session index
adapters/<provider>.json             opaque adapter state
sessions/<id>/events.ndjson          normalized events, raw payload included
sessions/<id>/semantic.ndjson        semantic state history
sessions/<id>/conversation.ndjson    companion conversation
```

Rebuilt into memory at startup; a truncated final line from an interrupted
write is tolerated. `appendEvent` is idempotent on `rawRef`, so re-reading a
transcript after a restart cannot duplicate history.

The `EventStore` interface exists so this becomes SQLite when whole streams in
memory stops being reasonable. Nothing outside the store knows the format.
