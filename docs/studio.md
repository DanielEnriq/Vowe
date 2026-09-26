# Studio

**PROJECT HOME** asks *what is going on?* **STUDIO** asks *what should this system become?*

Studio is a design conversation with a living design document beside it. When a design question depends on what the implementation actually does, Vowe checks the repository by asking a coding harness a read-only question. The grounded finding and the files it rests on open in the Workbench.

Vowe owns system-design intelligence. Coding harnesses are the repository experts it consults.

## Boundary

```
StudioService (core/studio)                 orchestration, persistence, limits, validation, cancel
  │  loads design state → DesignTurn
  │  hands over DesignCapabilities { consultRepository }   (traced, receipted, capped, abortable)
  ▼
SystemDesignAgent (core interface)          every design decision
  └ AnthropicSystemDesignAgent (llm)        one streamed tool loop
       ├ consult_repository ─▶ RepositoryConsultant (core port)
       │                         └ ClaudeCodeConsultant (adapter-claude-code)
       └ <design_revision> block at the end of the turn's text
  ▼
DesignTurnResult { reply, revision? } ─▶ one transaction: reply entry + revision
```

`StudioService` holds a design store, a project lookup, a way to open attachments, and the consultant. Studio can't instruct a worker or change project memory because nothing in its object graph reaches them. It holds no `SessionRegistry`, adapter, `ControlChannel`, `ProjectKnowledgeService` or `LiveBridge`. A test asserts that no source file in `core/src/studio/` imports any of them.

The agent is stateless between turns. Everything it knows arrives in `DesignTurn`, and everything it can do arrives in `DesignCapabilities`. A later context source, such as project representation or related designs, becomes a new field. A later capability, such as cheap structural lookup, becomes a new method.

## Persistence

Migration `016_studio` adds three tables:

- **`designs`**
- **`design_entries`**: the conversation. Repository checks are `consult` checks on the reply's receipt.
- **`design_revisions`**: append-only. `summary` records why the design changed and `entry_id` records the reply that explains it. The previous design is the revision with `ord - 1`.

Consultations have no table of their own. The receipt is the human account, and the `studio` run's `tool_call` / `tool_result` hold the full request and finding.

None of this is project truth:

- Project Ask never reads these tables.
- Nothing is admitted to project memory.
- Nothing reaches voice.

For every revision, the record Stage 2 will study can be rebuilt from existing rows (`studio-service.test.ts`, "can reconstruct every design change"):

- the developer turn
- the design before and after
- the consultations and their findings
- the reply
- the reason the design changed

## Consultation: read-only in fact

`ClaudeCodeConsultant` runs Claude Code in-process through the Agent SDK with these settings:

| Setting | Effect |
|---|---|
| `tools: ['Read','Grep','Glob']` plus `disallowedTools` | No shell, no edits, no web access, no subagents. |
| `permissionMode: 'dontAsk'` | Anything that would need permission is denied. |
| `settingSources: []`, `settings: { autoMemoryEnabled: false }` | No user, project or local settings, so repository hooks never run. The developer's auto-memory is neither read nor written. `CLAUDE.md` is still an ordinary file the harness may read. |
| `strictMcpConfig`, `mcpServers: {}` | No MCP servers. |
| `persistSession: false` | No transcript, so the consultation can't be resumed in Claude Code or discovered by Vowe as a worker. |
| `maxTurns`, `maxBudgetUsd`, wall-clock timeout, the turn's abort | Bounded in steps, spend and time, and stops when the turn is cancelled. |

These guarantees were verified against the installed SDK (0.3.277) with a live probe (`consultant.live.test.ts`, opt-in with `VOWE_LIVE_CONSULT=1`):

- Reads and searches outside `repoRoot` are denied by every route tried: an absolute path, `../`, a symlinked file, and a symlinked directory. Searching the root does not follow symlinks out.
- The repository is byte-for-byte unchanged afterwards.
- Nothing is written under `~/.claude/projects`. Before auto-memory was disabled, an empty `memory/` directory appeared there. That is why auto-memory is off.

Citations are then resolved against the real path of `repoRoot`. Anything that escapes it or does not exist is dropped. When a design turn commits, a `ref:` link in the reply or document stays a link only if a consultation or an attachment in this design returned it.

## Streaming

The reply streams from every round of the tool loop. The revised design streams as the model writes it. It travels as a delimited text block rather than a tool argument, because a gateway may buffer a tool's input and deliver the whole document at once. That was measured through the OpenRouter endpoint, including with `eager_input_streaming`. `design-text.ts` splits the text as it arrives and applies the same split to the final text, so the streamed view and the committed result are the same text.
