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

Credentials go in a local `.env`:

```bash
cp .env.example .env     # then fill in what you have
```

Every value is optional and Vowe degrades around each missing one:

| Missing | What still works |
|---|---|
| Model key | Discovery, ingestion, windows, deterministic status — notes just say nothing interpreted them |
| `OPENAI_API_KEY` | Everything except talking to Vo. The UI says so. Observation is unaffected |
| Decision key | Everything; each decision falls back to something deterministic |

`.env` is gitignored, and anything already exported still wins over it, so
`VOWE_LLM_MODEL=… pnpm dev` remains a one-off override. See
[`.env.example`](.env.example) for every option.

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
VOWE_LLM_MODEL=anthropic/claude-opus-5   # when capability beats latency
VOWE_LLM_EFFORT=medium                   # low | medium | high
```

Delegated questions always take one step more effort than routine observation:
someone is waiting on that answer out loud, and it is the call most likely to be
wrong if rushed.

## What it does

- Discovers Claude Code sessions dynamically — zero, one or many, running or
  finished, started by you in a terminal or started from Vowe.
- **Groups them by repository.** Sessions in the same Git repo — including
  across worktrees and subdirectories — appear under one Project, with no
  configuration. Each Project has a room showing its current and recent work.
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
                               live bridge, project knowledge — and every
                               vendor-facing interface
packages/adapter-claude-code/  the one provider adapter
packages/llm/                  AnthropicLlmClient (the only Anthropic SDK import)
packages/decision-jev/         structured decisions behind DecisionRouter
packages/live-openai/          GPT-Live behind LiveTransport
packages/knowledge-graphify/   code graphs behind ProjectKnowledgeProvider
packages/replay/               dev only: sanitizer, fixtures, tuning harness
apps/desktop/                  Electron main + preload + React renderer
docs/                          architecture, the harness, navigation, the
                               bridge, project knowledge
```

## Docs

- [Architecture](docs/architecture.md) — the four boundaries and how the code
  enforces them.
- [Projects](docs/projects.md) — how sessions group by repository, worktree
  identity, the non-Git fallback, and what project-level intelligence is
  deliberately not doing yet.
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
- [Project knowledge](docs/project-knowledge.md) — the code graph versus what
  Vowe has learned, which of the two Vowe owns, how memory admission stays
  conservative, and why source and diff remain authoritative.
- [The live bridge](docs/live-bridge.md) — WebRTC, the sideband, quiet context
  versus proactive speech, delegated questions, and what is deliberately never
  sent to the voice provider.

## Tests

```bash
pnpm test        # 177 tests, no credentials required
                 # (+3 more when Graphify is installed)
pnpm replay packages/replay/fixtures/repeated-failures.synthetic.jsonl

# Against the real provider, once .env has a key:
pnpm replay packages/replay/fixtures/repeated-failures.synthetic.jsonl --observer llm
pnpm --filter @vowe/live-openai run probe    # does GPT-Live accept our session?
```
