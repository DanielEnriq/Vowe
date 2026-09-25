# Working in Vowe

Vowe is an Electron desktop companion for coding agents. It observes worker
sessions, interprets their activity, answers grounded questions, and provides a
live voice interface. Sending an instruction to a worker is a separate action
from asking Vowe a question.

## Start here

- Follow the current request's scope. For an architecture investigation, trace
  executable call sites and report findings without implementing fixes.
- Check the working tree before editing. Preserve unrelated local changes.
- Treat implementation and the installed dependency behavior as evidence;
  comments and documents describe intent and may be stale.
- Read the relevant documents when they clarify a boundary, rather than reading
  every document before following the code.

## Workspace map

- `apps/desktop/src/main/index.ts`: service construction, shared instances,
  Electron IPC handlers, and events sent to the renderer.
- `apps/desktop/src/shared/ipc.ts` and `apps/desktop/src/preload/index.ts`: the
  desktop API contract and its bridge into the browser context.
- `apps/desktop/src/renderer/`: React UI, hooks, and pure state transformations.
- `packages/core/src/`: provider-independent interfaces and application behavior.
  Key areas are `delegation`, `context`, `observation`, `interpretation`,
  `communication`, `execution`, `live`, `knowledge`, `store`, and `workbench`.
- `packages/llm/src/`: Anthropic model adapters, prompts, and model-facing tools.
- `packages/adapter-claude-code/src/`: worker discovery, transcript normalization,
  and the explicit worker control path.
- `packages/decision-jev/src/`: structured decisions behind `DecisionRouter`.
- `packages/live-openai/src/`: OpenAI Live transport and sideband integration.
- `packages/knowledge-graphify/src/`: Graphify CLI integration and local graph
  retrieval behind `ProjectKnowledgeProvider`.
- `packages/replay/src/`: replay, synthetic fixtures, and sanitization utilities.

## Boundaries to preserve

- Typed session Ask and delegated voice questions share
  `DelegatedQuestionRunner`. Project Ask uses its project-scoped entry point.
- Investigation receives read tools through `ContextNavigator`. Keep worker
  control out of that path; it belongs to the explicit instruction flow.
- Keep provider SDK details in their integration packages and expose contracts
  through core. Keep credentials in the main process or provider adapters.
- Renderer runtime imports must be browser-safe. Use type imports from the core
  package root and the existing safe subpath exports for runtime helpers.
  `packages/core/src/context/refs.ts` must remain free of imports.
- Observation windows/notes and semantic interpretation are separate pipelines.
  Follow both callers before assuming one updates the other's state.
- Distinguish a conversation entry, a delivery attempt, an investigation
  receipt, and a run/trace. They represent different facts and commit at
  different times. Streamed UI state is transient.
- Context references are addresses. Repository files and current diffs may
  change between reads; a reopened artifact is not a historical snapshot.
- Preserve deterministic behavior when optional providers are unavailable.

## Development and verification

Use pnpm 10 and a Node runtime with `node:sqlite` support. The local development
runtime used for this investigation is Node 24.

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm exec vitest run packages/core/test/<relevant-file>.test.ts
pnpm run build:packages
pnpm --filter @vowe/desktop run build
```

- Workspace TypeScript uses strict NodeNext modules and `.js` extensions in
  relative source imports. Follow existing conventions.
- Vitest resolves workspace packages to TypeScript sources, so focused tests do
  not require rebuilding package output first.
- Test meaningful behavior at the changed boundary. For agent-loop changes,
  verify the actual request history, tool execution, stop behavior, and final
  result as well as streamed deltas. Inspect installed SDK semantics when a
  helper owns the loop.
- For persistence changes, verify write ordering, reload behavior, and failure
  handling. For renderer changes, check the relevant state tests and inspect
  the UI when appearance or interaction changes.
- Prefer fake providers and temporary stores for local verification. Live
  provider probes and replay with a real model can incur charges and are not
  prerequisites for ordinary tests.
- Use `.env.example` for configuration names; keep credentials and unsanitized
  worker transcripts out of committed files and reports.

## Reporting

Explain observed behavior with concrete file/function references. Separate
confirmed behavior, reproducible defects, likely causes, and questions requiring
runtime evidence. State what was verified and what remains unverified. Do not
present an intended invariant as a working guarantee without checking its caller
and implementation.
