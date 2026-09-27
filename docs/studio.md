# Studio

See [Vowe North Star](north-star.md) for the canonical implementation sequence that places Studio at the beginning of the Design → Build → Oversee loop.

**PROJECT HOME** asks *what is going on?* **STUDIO** asks *what should this system become?*

Studio is a place to work on a system design, not chat about one. The system being designed fills the room as a small drawn model: parts, the links between them, and the occasional responsibility under discussion. The conversation is a rail beside it. When a design question depends on what the implementation actually does, Vowe checks the repository by asking a coding harness a read-only question. The grounded finding and the files it rests on open in the Workbench, which rises as a sheet beneath the design.

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
       └ <design_move> block of JSON ops at the end of the turn's text
  ▼
DesignTurnResult { reply, move? } ─▶ one transaction: reply entry + revision (model, move) + layout
```

`StudioService` holds a design store, a project lookup, a way to open attachments, and the consultant. Studio can't instruct a worker or change project memory because nothing in its object graph reaches them. It holds no `SessionRegistry`, adapter, `ControlChannel`, `ProjectKnowledgeService` or `LiveBridge`. A test asserts that no source file in `core/src/studio/` imports any of them.

The agent is stateless between turns. Everything it knows arrives in `DesignTurn`, and everything it can do arrives in `DesignCapabilities`. A later context source, such as project representation or related designs, becomes a new field. A later capability, such as cheap structural lookup, becomes a new method.

## The design model

`core/studio/model.ts` is import-free and shared with the renderer through `@vowe/core/studio-model`.

- **Parts, links and duties** with stable ids. A rename never changes an id, so selection, layout and revert survive it. Duties (responsibilities) are optional and sparse. The agent writes them as `{"op":"responsibility",…}`, and the model stores them as `duty`.
- **A small system grammar**, all optional on a part:
  - `kind`: one of `client`, `service`, `store`, `queue`, `external`, `group`. A worker is a service, a cache is a store, and a model provider is external. An unknown kind parses as unspecified; the op is not refused.
  - `technology`: `{ name, key? }`. `name` is the design's word. `key` is presentation metadata that may be corrected or canonicalised later. A change to the key alone is not a design change, and nothing keys on it. `technologyKey()` derives a slug on read and never stores it.
  - `within`: the id of a `group`. Groups don't nest. A group that still holds parts keeps its kind. Removing a group leaves its parts outside it, and revert restores them inside.

  The prompt keeps parts at whiteboard altitude (never classes, files or functions) and keeps responsibilities rare.
- **A brief.** `projectMarkdown` writes each part with its kind and technology inside its boundary, plus its responsibilities, connections, reasoning and what it changes about today. A later Design → Build can read it without the conversation.
- **Two worlds in one model.** An element's fields are the proposed system, which is what the canvas draws. `today` is what the repository has now, stamped with the `RepositoryBasis` (worktree, `HEAD`, dirty) of the consultation that established it. A part's `today` also records its kind and technology when it was grounded with them. Anything unrecorded reads as the design says, never as a difference. When nothing in a design has been checked (no finding, no answered consultation, no attachment), `StudioService` drops any `today: true` the agent claims. A design begun from an idea therefore can't say anything exists in the repository. Removing something that exists today retires it rather than deleting it. This is what a later reconciliation with landed work, or divergence detection, will read. Neither is built.
- **Moves.** One closed op set (`design`, `part`, `link`, `duty`, `remove`, `revert`) is the only way the design changes. A sentence to Vowe and a gesture on the canvas end as the same `DesignMove { id, ops, summary, author, via }`. `revert{move}` undoes one move element by element, and never undoes anything changed since.
- **Layout is view state.** `layout.ts` places new parts beside their relations and never moves what is placed. Dragging pins a part, and tidy re-lays out the unpinned ones. None of it is a move, enters history or reaches the agent.
- **Boundaries are drawn, not placed.** A group takes no slot while it holds parts: the canvas draws it around them. `layout.ts` keeps each group whole — members touching, nothing else inside, no two groups overlapping — and corrects only what breaks that: a part that joins moves in beside the others, a part that leaves steps out along its row, and a layout with nothing to correct comes back unchanged. A link to a group places its other end as if it linked each member. An empty group waits in a slot of its own and is drawn there as a small outline. A new part sits a row beneath the nearest part that feeds it, so a store written by two services sits beside the first. Tidy moves an external that is outside every group and not pinned to the edge of the drawing, keeping its row and the side it leaned toward.
- **Drawn quietly.** In the renderer, a kind changes a card's silhouette slightly and never adds a label; a part with no kind, or one it does not know, is the plain service card. A technology is a small monochrome mark (from Simple Icons, CC0, where one exists) and its name, both secondary to the part's name. Marks are found by key, name, alias or first word, so `technology.key` stays presentation metadata. Dropping a part well inside a boundary, or well outside its own, is a `within` move; anything less decisive only rearranges.

## Canvas gestures

`StudioService.manipulate` commits a canvas move with no model turn: a `developer_move` entry and a revision. Cosmetic gestures (rename, drag, tidy) are silent. After a semantic move (relocating a responsibility, revert), the service asks `SystemDesignAgent.consider`, a small call with no tools, which usually answers nothing. When it answers, the note is kept as an append-only `companion_note` entry anchored to an element and move. It is drawn on the canvas, not in the thread, and a later move supersedes it.

## Persistence

Migration `016_studio` adds three tables:

- **`designs`**
- **`design_entries`**: the conversation. Repository checks are `consult` checks on the reply's receipt.
- **`design_revisions`**: append-only. `summary` records why the design changed and `entry_id` records the reply or canvas move that explains it. Migration `017_studio_model` adds `model_json` (the authoritative snapshot) and `move_json` (the move that made it). `document` is still written, as the model's Markdown projection. Studio 0 revisions keep both new columns NULL and are shown as documents until the next turn draws them.
- **`designs.layout_json`** (017): where each part sits. Updated in place, and deliberately not history.

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

The reply streams from every round of the tool loop. The move streams op by op. It travels as a delimited text block holding one JSON op per line, rather than as a tool argument, because a gateway may buffer a tool's input and deliver it all at once. That was measured through the OpenRouter endpoint, including with `eager_input_streaming`. `design-text.ts` reads a line only once its newline arrives and applies the same split to the final text, so the ops the canvas previewed and the ops committed are the same. A round that sends nothing for two minutes fails the turn rather than hanging on a silent stream.
