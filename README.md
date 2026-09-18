# Vowe

A desktop companion for coding agents. You keep using your coding agents
normally; Vowe watches those sessions, keeps an understanding of what each one
is doing, lets you ask about the work without disturbing it, and — as a
separate, explicit action — lets you send the worker a new instruction.

This repository is **task 1**: one complete vertical slice with one real
provider (Claude Code), with the session model, registry, event pipeline,
interpretation and UI all provider-independent.

## Run it

```bash
pnpm install
pnpm dev            # builds the packages, then launches the Electron app
```

Optional, for interpretation and question answering:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Without it the app still starts, discovers sessions, ingests and stores events,
and shows deterministic status — it just says plainly that no LLM is
configured.

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

## Layout

```
packages/core/                 provider-independent model, registry, store,
                               interpretation, companion, LlmClient interface
packages/adapter-claude-code/  the one provider adapter
packages/llm/                  AnthropicLlmClient (the only vendor SDK import)
apps/desktop/                  Electron main + preload + React renderer
docs/                          architecture, adapter assumptions, adding a provider
```

## Docs

- [Architecture](docs/architecture.md) — the four boundaries and how the code
  enforces them.
- [Claude Code adapter](docs/adapters/claude-code.md) — every assumption it
  makes, the three attach modes, and what breaks if the CLI changes.
- [Adding a provider](docs/adding-a-provider.md) — the cleanest path to a
  second adapter.
