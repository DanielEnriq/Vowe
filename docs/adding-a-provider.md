# Adding a second provider

Nothing in `@vowe/core` or the UI knows that Claude Code exists. A second
provider is a new package implementing `AgentAdapter` plus one line of wiring.

## 1. Implement `AgentAdapter`

```ts
interface AgentAdapter {
  readonly provider: string
  discoverSessions(): Promise<AgentSession[]>
  getSession(providerSessionId: string): Promise<AgentSession | null>
  subscribeToEvents(providerSessionId, onEvent): Unsubscribe
  sendInstruction(providerSessionId, text): Promise<InstructionResult>
  launchSession?(options): Promise<AgentSession>   // optional
  interrupt?(providerSessionId): Promise<void>     // optional
  dispose?(): Promise<void>
}
```

Keep every provider-specific identifier, file path, protocol and event shape
inside the package. The rest of the application only sees `AgentSession` and
`NormalizedEvent`.

## 2. Compute capabilities per session, not per provider

This is the part most likely to be got wrong. Do not declare
`sendInstruction: true` because the provider *has* an API — decide per session,
on every discovery pass, based on what is true of that session right now
(is the process alive? do we own it? can it be resumed?). `sendInstruction`
should throw `CapabilityUnsupportedError` with a human-readable reason when it
cannot deliver; the UI surfaces that reason directly.

## 3. Derive `task` from evidence

`task` is what the worker is trying to accomplish, in the developer's words,
read out of the session itself. Never a role, never a guess. If nothing is
known yet, `null` is correct, and `displayLabel` falls back through the
provider's own title, its working directory, then a short id.

## 4. Map onto `NormalizedEventKind` — and keep the raw record

Map what you recognize. For anything else emit `kind: 'unknown'` with the raw
payload attached and a `rawRef` that can address it later. Do not drop an event
because the mapping is incomplete; do not invent a kind to avoid `unknown`.

If the provider has no stable physical address for a record, synthesize a
deterministic one (`rawRef.source` plus a monotonic offset) — the store uses it
for idempotent append, so it must be stable across restarts.

## 5. Register it

```ts
registry.registerAdapter(new MyProviderAdapter());
```

in `apps/desktop/src/main/index.ts`. The session list, detail view, event
inspector, interpretation and companion all work immediately; they were never
told how many providers there are.

## What a Codex or Cursor adapter will probably lack

- **A complete on-disk event stream.** The Claude Code adapter is unusually
  lucky: every session writes a full transcript, so observation is uniform and
  history is available retroactively. A provider that only streams over an API
  will observe sessions it launched much better than ones it discovers, and may
  not be able to reconstruct history at all. Expect `observe` itself to become
  a per-session capability rather than always true.
- **Control over sessions it did not start.** Editor-embedded agents are the
  hardest case; assume `sendInstruction: false` for foreign sessions until
  proven otherwise.
- **A stable session identifier.** If the provider has no durable id, the
  adapter must mint one and persist the mapping in its adapter state
  (`EventStore.getAdapterState` / `setAdapterState`).
- **A task statement.** Some providers start from a UI action with no prompt
  text. `task: null` plus a good `displayLabel` is the honest answer.
