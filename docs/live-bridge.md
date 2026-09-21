# The live bridge

Vo is the product-facing conversational identity: the relationship with the
human. It is **not** the observer. The observer follows the coding agent; Vo
talks to the person.

```
worker trace → ObserverRunner → L1 understanding → LiveBridge → GPT Live ↔ user
```

Everything vendor-specific sits behind `LiveTransport`
(`packages/core/src/live/live-transport.ts`), implemented for OpenAI's GPT-Live
in `@vowe/live-openai`. Core never imports a voice SDK, for the same reason it
never imports a coding-agent SDK.

## Two connections to one conversation

This is the arrangement that makes the rest work.

**The renderer owns the audio.** It holds the microphone, plays what comes back,
and negotiates a peer connection directly with the provider. The SDP offer
passes through the main process only because the exchange needs an API key, and
the key must never reach a browser context.

```
renderer                     main                      provider
   │  RTCPeerConnection        │                           │
   │  getUserMedia             │                           │
   │  dataChannel('oai-events')│                           │
   │──── SDP offer ───────────▶│                           │
   │                           │──── live.create ─────────▶│
   │                           │◀─── SDP answer + id ──────│
   │◀─── SDP answer ───────────│                           │
   │◀═════════════ audio, direct ══════════════════════════▶│
                               │◀─── sideband ────────────▶│
```

**The backend attaches a second connection.** A server-side sideband to the same
session, by its id. That is how the observation harness reaches a conversation
whose audio never passes through this process at all. It is opened through the
official SDK's own sideband socket rather than a hand-built WebSocket.

If the attach fails, the bridge says so and carries on. The user can still talk
to Vo; they just will not get proactive updates, and the UI states that. A
conversation the backend cannot observe is degraded, not broken.

## Three ways in, and they are different things

| Channel | Effect | Used for |
|---|---|---|
| `session.thinking.append` | Vo now knows this. It will not say it, but can use it when asked | Quiet observer context |
| `session.commentary.append` | Vo should communicate this, in its own words | An approved interruption; a delegated answer |
| `session.instructions.append` | Changes how Vo behaves | Standing direction |

Each takes plain text with a 500-token ceiling per append.

### Quiet context

Every new L1 note goes to `thinking`. Silently.

This is the difference between an assistant that can answer "what is it doing?"
instantly and one that has to go and find out every time. It is also exactly why
the note is not spoken: the developer asked to be told about *developments*, not
about every window.

> Targeted tests pass and the worker is now running the full suite.

Vo will not volunteer that. Ask it what is happening, and it already knows.

### Proactive communication

A candidate that `CommunicationPolicy` approved goes to `commentary`, with the
reason it mattered now. Vo phrases it; Vowe decided it was worth saying.

> Hey Daniel, I think something weird is going on.

`queue` holds an approved update until the developer next speaks, so a held
thought arrives in conversation rather than out of nowhere.

## Delegated questions

The session runs with client delegation: when Vo decides a question needs real
work, it hands it to Vowe rather than guessing.

Voice is not the only way in. `DelegatedQuestionRunner` is Vowe's one grounded
investigator, and the typed **Ask Vowe** composer reaches the same instance
through `CompanionService`:

```
       text ──▶ CompanionService ──┐
                                   ├──▶ DelegatedQuestionRunner
      voice ──▶ LiveBridge ────────┘
```

Everything below this line is therefore about both. The bridge's only special
responsibility is reconstructing the question, because the provider does not
send it.

**The delegation event does not carry the user's utterance.** That is by design —
Vo is not the author of the question. So the bridge accumulates
`session.input_transcript.delta` and `session.output_transcript.delta`
throughout the conversation, and reconstructs the question from that buffer.
That is the only reason the buffer exists.

Lifecycle:

```
user speaks
   → Vo decides it needs the backend
   → session.delegation.created  (id only, no text)
   → bridge reconstructs the question from the transcript
   → DelegatedQuestionRunner: search_context / open_context / get_diff
   → answer, in two forms
   → session.commentary.append(spokenAnswer, delegationId)
   → Vo says it naturally
```

Observation continues throughout. Nothing about this pauses the trace loop.

### Two forms of one answer

```ts
interface DelegatedAnswer {
  spokenAnswer: string;   // concise, conversational — the only thing sent to Live
  fullAnswer: string;     // detailed, grounded, with references
  refs: ContextRef[];
}
```

**This is an architectural rule, not a workaround for a token limit.**

Voice and text want different things. A 1,200-token technical explanation is the
right artifact to read and the wrong thing to hear: it cannot be interrupted
cleanly, and it buries the answer. So the backend produces both. Only
`spokenAnswer` is sent to the live model. The full account is persisted as a
conversation entry with its references and rendered in Vowe's own window.

Both forms are produced on every investigation, including one that arrived by
being typed. That is not waste — it is what keeps the two modalities honest
about being one engine, and the typed path never receives the spoken form
anyway: the main process drops it at the IPC boundary rather than trusting the
renderer to ignore it.

Long answers are **never** split across consecutive `commentary` appends to make
Vo read everything aloud. If the developer wants more, they ask, and the next
turn investigates again and gives another focused spoken answer. Progressive
disclosure, not a monologue.

The 500-token ceiling is an upper bound, not a target — spoken answers should
normally be far shorter.

## Vo's prompt

Short, and about conversation only: personality, backchannels, interruptions,
and an explicit delegation policy. It says that background updates are what Vo
knows, that quiet updates are context rather than announcements, and that
anything needing older work, source, diffs, command output or careful reasoning
goes to the backend first.

No agent-trace workflow appears in it. Windows, references, tools and evidence
belong in Vowe's backend prompts, where they can change without changing how the
conversation sounds.

## What is deliberately not sent

Everything leaving Vowe for the voice provider goes through one chokepoint,
`toLiveText`, which collapses whitespace and enforces the ceiling. It is the one
place to look to answer "what does Vowe send to a third party?"

**Sent:** L1 note prose, surface-update messages and their `whyNow`, spoken
answers, and the standing session context.

**Not sent, ever:**

- raw trace records,
- file contents,
- diffs,
- command output,
- credentials or tokens,
- absolute filesystem paths.

None of these reach the chokepoint, because no caller passes them. The observer's
raw material stays in Vowe; only what Vowe *understood* crosses the boundary.

Note the provider's own caveat, which applies here: quiet context can still
influence later speech, so `thinking` is not a secrecy boundary. It is for things
that are fine to say but not worth saying unprompted — never for things that must
not be said.

## Without a voice credential

Vowe starts, discovers sessions, observes them, builds windows, writes notes,
raises candidates, and decides on them. The UI says plainly that Vo voice is
unavailable and why. Observation does not depend on voice and never did.

The SDK's sideband socket depends on `ws`, an optional peer dependency, and is
imported lazily for the same reason — a missing optional dependency should
degrade one feature, not stop the application.
