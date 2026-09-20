# Vowe

A desktop companion for coding agents. You keep using your coding agents
normally; Vowe watches those sessions, keeps an understanding of what each one
is doing, lets you ask about the work without disturbing it, and — as a
separate, explicit action — lets you send the worker a new instruction.

Task 1 built one complete vertical slice with one real provider (Claude Code).
Task 2 adds the **observation harness**: something that follows a coding agent's
trace continuously in bounded windows, keeps an understanding that can be traced
back to evidence, decides against the developer's own stated preference whether
anything is worth interrupting them about, and — through **Vo** — holds a live
voice conversation about it while the work carries on.

## Run it

```bash
pnpm install
pnpm dev            # builds the packages, then launches the Electron app
```

Optional credentials, each of which the app degrades around rather than
requiring:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # interpretation, observation, answers
export OPENAI_API_KEY=sk-...            # Vo's voice
export TYPESAFE_API_KEY=...             # structured decisions
```

Any of them can be absent. Without a model key the app still discovers sessions,
ingests events and shows deterministic status. Without a voice key everything
works except talking to Vo, and the UI says so. Without a decision key every
decision falls back to something deterministic.

To reach a model through a gateway rather than the first-party API:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
export VOWE_LLM_BASE_URL=https://openrouter.ai/api
export VOWE_LLM_MODEL=anthropic/claude-sonnet-5
export VOWE_JEV_BASE_URL=https://openrouter.ai/api/alpha/decisions
export VOWE_JEV_MODEL=typesafe/jev-1.13
```

### Speed

Observation is the hot path — one model call per window, continuously, while
someone waits to hear whether anything happened. So the defaults favour latency:
Claude Sonnet 5 at `low` effort. Measured on the synthetic fixture (25 records,
2 windows, both investigated with tools):

| Model | Effort | Time |
|---|---|---|
| `claude-sonnet-5` | `low` (default) | 22s |
| `claude-sonnet-5` | `medium` | 31s |
| `claude-opus-5` | `medium` | 44s |

Both levers are env-configurable, and `pnpm replay ... --observer llm` is how to
re-measure after changing either:

```bash
export VOWE_LLM_MODEL=anthropic/claude-opus-5   # when capability beats latency
export VOWE_LLM_EFFORT=medium                   # low | medium | high
```

Delegated questions always take one step more effort than routine observation:
someone is waiting on that answer out loud, and it is the call most likely to be
wrong if rushed.

## What it does

- Discovers Claude Code sessions dynamically — zero, one or many, running or
  finished, started by you in a terminal or started from Vowe.
- Ingests each session's events into a normalized stream that always keeps the
  provider's original record.
- Maintains an evolving description of what each session appears to be doing,
  with provenance back to the events that produced it.
- **Ask Vowe** answers from observed state. It never reaches the coding agent.
- **Send to agent** delivers an instruction to the real worker, and is disabled
  with an explanation when that session cannot receive one.
- **Observes a session continuously**, dividing its trace into ordered windows
  and keeping a running understanding of each, resuming from a stored cursor
  rather than reinterpreting after a restart.
- **Raises things worth saying** and evaluates them against one plain-language
  preference per session — "only tell me if something looks weird".
- **Talks**, through Vo, while the coding agent keeps working and the observer
  keeps up. Either side continues while the other is busy.

## Layout

```
packages/core/                 provider-independent model, registry, store,
                               interpretation, companion, observation harness,
                               context navigation, communication policy,
                               live bridge — and every vendor-facing interface
packages/adapter-claude-code/  the one provider adapter
packages/llm/                  AnthropicLlmClient (the only Anthropic SDK import)
packages/decision-jev/         structured decisions behind DecisionRouter
packages/live-openai/          GPT-Live behind LiveTransport
packages/replay/               dev only: sanitizer, fixtures, tuning harness
apps/desktop/                  Electron main + preload + React renderer
docs/                          architecture, the harness, navigation, the bridge
```

## Docs

- [Architecture](docs/architecture.md) — the four boundaries and how the code
  enforces them.
- [Claude Code adapter](docs/adapters/claude-code.md) — every assumption it
  makes, the three attach modes, and what breaks if the CLI changes.
- [Adding a provider](docs/adding-a-provider.md) — the cleanest path to a
  second adapter.
- [The observation harness](docs/observer-harness.md) — L0 to windows to L1
  notes to a decision to speak, and the concurrency model that lets observation
  and conversation run at once.
- [Context navigation](docs/context-navigation.md) — what `search_context`,
  `open_context`, `get_diff` and `surface_update` mean, and how future indexing
  improves them without changing their contracts.
- [The live bridge](docs/live-bridge.md) — WebRTC, the sideband, quiet context
  versus proactive speech, delegated questions, and what is deliberately never
  sent to the voice provider.

## Tests

```bash
pnpm test        # 81 tests, no credentials required
pnpm replay packages/replay/fixtures/repeated-failures.synthetic.jsonl
```
