# Claude Code adapter — assumptions and limits

Verified against Claude Code CLI **2.1.277** on macOS.

## What this adapter assumes about Claude Code

All of it is isolated in `packages/adapter-claude-code/src/paths.ts`,
`live-sessions.ts` and `transcript.ts`.

| Assumption | Where | If it breaks |
|---|---|---|
| Sessions append a JSONL transcript at `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | `paths.ts`, `adapter.ts` | Discovery and observation stop; nothing else is affected |
| Transcripts are append-only and each line is one JSON record | `transcript.ts` | The reader resets its cursor when a file shrinks; malformed lines are skipped |
| The filename stem is the provider session id | `adapter.ts#findTranscripts` | Sessions would be misidentified |
| Live sessions are listed as `~/.claude/sessions/<pid>.json` with `{sessionId, cwd, status, name, procStart}` | `live-sessions.ts` | Every session would look idle, so Vowe would offer to resume sessions that are actually running |
| A record's `cwd`, `timestamp`, `isMeta`, `isSidechain` fields mean what they appear to | `adapter.ts#applyMeta` | Task/cwd derivation degrades; events still flow |
| `ai-title` records carry the CLI's own session title | `adapter.ts#applyMeta` | Long prompts would be used as list labels |
| Agent SDK `query()` accepts an `AsyncIterable` prompt and `resume: <sessionId>` | `control.ts` | Control breaks; observation is unaffected |

The adapter does **not** decode the cwd-slug directory naming scheme — it finds
transcripts by filename, so that encoding can change freely.

## Three attach modes

Discovery merges three sources: the live-session registry, transcripts on disk
touched within the last 2 days, and Vowe's own table of launched sessions.

| Mode | Meaning | observe | sendInstruction | interrupt | resume |
|---|---|:--:|:--:|:--:|:--:|
| `managed` | Vowe launched it and holds the streaming input queue | ✅ | ✅ Agent SDK streaming input | ✅ | ✅ |
| `external-idle` | Discovered, no live process | ✅ | ✅ Agent SDK `resume` | ❌ | ✅ |
| `external-live` | Running under a process Vowe does not own | ✅ | ❌ | ❌ | ❌ |

### Why `external-live` cannot be instructed

Claude Code exposes no public way to deliver a message into a session that is
already running in someone else's terminal. There is a private peer channel
(`/tmp/cc-socks/<pid>.sock` with a token in `~/.claude/sessions/*.key`), but it
is undocumented, auth-gated and implemented inside a compiled binary. Building
on it would break on CLI updates.

So the adapter reports `sendInstruction: false` and the UI explains why, rather
than pretending. This is the case that made per-session capabilities necessary
in the first place.

A live process check (`process.kill(pid, 0)`) guards the registry file, because
treating a dead session as live would wrongly deny the developer control.

## Observation is one path for all three modes

Even for sessions Vowe launched, events come from tailing the transcript, not
from the Agent SDK message stream. One normalization pipeline means one thing
to trust, and it means a managed session and a foreign session produce
identical event histories.

The reader stops at the last complete newline, so a record being written while
we read is picked up whole on the next pass. The pump runs every 750ms.

## Normalization notes

- `Bash` becomes `command_started`, or `test_started` when the command matches a
  test-runner pattern.
- `Edit` / `Write` / `MultiEdit` / `NotebookEdit` become `file_changed`.
- `AskUserQuestion` / `ExitPlanMode` become `session_waiting`.
- `thinking` blocks are not events — they are the agent's private reasoning.
- The first non-meta user record becomes `session_started` and supplies `task`.
- Records in the deny-list (`attachment`, `mode`, `cost-state`,
  `file-history-*`, …) produce no events. Everything else that is not
  recognized becomes `unknown` and is stored with its raw payload.

## Permission mode for sessions Vowe starts

Launched and resumed sessions run with `permissionMode: 'auto'`, so Claude
Code's own classifier approves routine actions and stops on risky ones. This is
a constructor option on `ClaudeCodeAdapter`.

## Known limitations

- A session discovered mid-flight is read from the beginning of its transcript,
  so its full history is ingested at first attach. Idempotent append on `rawRef`
  makes this safe but not free on very large transcripts.
- Transcript cursors are in-memory. After a restart the file is re-read from
  byte 0 and duplicates are dropped by the store rather than avoided.
- The 2-day discovery window is a constructor option, not a user setting.
