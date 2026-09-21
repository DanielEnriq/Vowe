# Vowe — Product UI Contract

**Status:** Slice 0 / implementation contract
**Code baseline:** `main` after merged PR #1 (`e05b1af`)
**Design baseline:** approved Claude Design direction as of 2026-09-21

Rule:

> Every meaningful thing rendered in production must either map to a real existing source of truth, be defined as a reconstructible projection over existing state, or be explicitly marked as a new/deferred capability.

Generated Claude Design code is a visual/interaction reference, not application architecture.

---

## 1. Non-negotiable architectural boundaries

These rules outrank any generated UI implementation.

- **Asking and instructing remain separate execution paths.** `askCompanion()` and `sendInstruction()` stay separate IPC calls / code paths. Never collapse them into `sendMessage({ mode: "ask" | "agent" })`. Persisted roles stay distinct: `user_question / companion_answer` (never reach the worker) vs. `user_instruction / instruction_result` (do).
- **Text and voice share one grounded investigator.** Both typed Ask and voice delegation converge on `DelegatedQuestionRunner`. Presentation can differ; intelligence must not fork.
- **Observation continues independently of conversation.** No UI state (voice, workbench, Ask, worker instruction, investigation) may imply pausing continuous observation.
- **Raw trace is evidence, not default UI.** Trace descends: `conversation → artifact → basis/checked items → worker activity → raw event`. Raw trace stays available but does not define the main Session Room.
- **Project knowledge remains external/retrievable.** The UI presents knowledge status; it does not alter the underlying repository-navigation/memory architecture, and project knowledge is not dumped into every conversation context.

---

## 2. Classification system

Every design concept must be assigned one of:

| Class | Meaning |
|---|---|
| **A — Exists** | Capability already exists; redesign changes presentation only. |
| **B — Derivable** | Data exists; needs a new read model/projection. No new intelligence loop. |
| **C — New capability** | Assumes behavior/state that doesn't exist yet. Needs a real contract before rendering. |
| **D — Future seam** | May reserve space/affordance, but is not implemented in this redesign. |

No production component may ship with fake data to simulate B/C/D. Design concepts not yet built in v1 must be **omitted or disabled honestly**, never faked:

- Project Ask — omit until project-level investigator exists
- Project Voice — omit until project Live scope exists
- "What has it learned?" browser — preserve future seam, no fake page
- Multiple geometric presence forms — ship only the implemented point-cloud
- Voice picker — omit until Live transport accepts persisted selection
- Global behavior sliders — omit until they map to real policy
- Automatic artifact surfacing — manual artifact/workbench first
- Point-at-code synchronization — explicit artifact link first
- Return checkpoints, worker-intent auto-detection, direct permission approval, autonomous orchestration, authentication — later

---

## 3. Design-to-code contract matrix

### Global shell / navigation

| Concept | Class | Contract |
|---|---|---|
| Project-first navigation | A | Restyle/recompose existing project/session selection model; do not replace it. |
| Expandable sessions beneath Project | A | Preserve existing `ProjectSidebar` grouping logic. |
| New task `+` | A | Keep `launchSession()` behavior; redesign affordance later. |
| Human task/session title | B | One deterministic display-title helper over `task` + `displayLabel`. No model title-generation. |
| User row in sidebar | C | Add local `UserProfile`, not cloud auth. |
| "Your Vowe" row | C | Reads global `PresenceProfile`; opens Presence Studio. |

### Project Room

`ProjectRoom` stays a deterministic aggregation: no model call, no project observer, no cross-session reasoning.

| Concept | Class | Contract |
|---|---|---|
| Project identity | A | No new Project entity. |
| Current work | B | Render via `ProjectBrief.active`. |
| Recently finished | B | Render via `ProjectBrief.recent` — any non-active session, newest first, capped. |
| Synthesis headline | B | Deterministic v1 (see §5). No Project LLM. |
| `Needs You` | C-small | Strict attention projector (see §6). |
| `Latest from Vowe` | B | Select latest meaningful project signal (see §7). |
| Repository-known indicator | A/B | Subtle status only, from `getProjectKnowledge(projectId)`. |
| Full knowledge browser | D | Preserve future seam only. |
| Project-level text/voice conversation | D | Current investigator/Live are session-scoped; do not fake project-level. |
| Direct approval from `Needs You` | D | First implementation opens the relevant session instead. |

---

## 4. `ProjectBrief` read model

```ts
interface ProjectBrief {
  projectId: string;

  headline: string;
  detailLines: string[];

  active: ProjectSessionSummary[];
  /**
   * Named `recent`, not `recentlyFinished`: it holds every non-active session,
   * and an idle or resumable one has not finished. No time window.
   */
  recent: ProjectSessionSummary[];

  needsAttention: AttentionItem[];

  latestSignal: ProjectSignal | null;

  knowledge: ProjectKnowledgeSummary;

  updatedAt: string;
}

interface ProjectSessionSummary {
  sessionId: string;
  title: string;

  status: AgentSession["status"];
  currentActivity: string | null;

  provider: string;
  branch: string | null;

  lastActivityAt: string;
  needsAttention: boolean;
}

interface ProjectSignal {
  sessionId: string;
  text: string;
  refs: ContextRef[];
  at: string;
}

interface ProjectKnowledgeSummary {
  status: "unindexed" | "indexing" | "ready" | "stale" | "error" | "unavailable";
  updatedAt?: string;
}
```

Derived from `Project + AgentSessions + SemanticState + Observation notes/SurfaceUpdates + RepoIndexState`. Not persisted as canonical history — must be reconstructible.

---

## 5. Project synthesis semantics (headline)

```text
no active work                              → "Everything's quiet."
active work + no actionable attention       → "Everything is moving." / "Nothing needs you right now."
one actionable attention item               → "One thing needs you."
multiple attention items                    → "{N} things need you."
all currently tracked work finished         → "Work is complete."
```

`detailLines`: at most 1–3 current factual statements derived from active session summaries. No new model call.

---

## 6. `Needs You` attention contract

Meaning: if the developer opens this item, there is a useful decision, answer, approval, or intervention they can provide. This is stricter than the current SessionDetail behavior (which treats every `permission_requested` and every `session_waiting` as attention).

```ts
type AttentionKind = "permission" | "decision" | "blocked" | "risk";

interface AttentionItem {
  id: string;
  projectId: string;
  sessionId: string;

  kind: AttentionKind;
  summary: string;

  refs: ContextRef[];

  createdAt: string;
  resolvedAt?: string;
}
```

Admission rules:

```text
permission_requested                                   → attention
worker explicitly waiting for a human answer/decision   → attention
ordinary idle / resumable / waiting state                → NOT attention
interesting progress                                     → NOT attention
completion                                                → NOT attention
```

If resolution can't be determined reliably, default action is `Open session`, not `Approve once` — until a real provider-control contract exists.

---

## 7. `Latest from Vowe` selection

```text
latest meaningful SurfaceUpdate across project sessions
    ↓ fallback
latest non-empty WindowNote.notableChange
    ↓
omit if nothing meaningful exists
```

No new summarizer. This is a pull surface (shown when the developer opens the Project Room), distinct from proactive-interruption policy.

---

## 8. Project knowledge display

Show only a confidence signal, e.g. `● Vowe knows this repository`. Do not expose backend implementation details (symbol counts, memory counts, graph status) by default. Full knowledge browser is **D — Future**.

---

## 9. Session Room decomposition

```text
SessionRoom
├── SessionHeader
├── ConversationCanvas
│   ├── SpeakerRun
│   ├── WorkerMilestone
│   └── GroundingReceipt
├── SessionComposer
├── WorkbenchHost
└── VoiceStage
```

### Conversation

| Concept | Class | Contract |
|---|---|---|
| Persisted user/Vowe conversation | A | Reuse `ConversationEntry`. |
| Grounded answer refs | A | `ConversationEntry.refs` already preserves grounding refs. |
| Speaker-run identity | C-UI | Derived from `role + UserProfile + PresenceProfile`. |
| Meaningful worker milestones | B | Selectively derive from NormalizedEvents (see §10). |
| `Investigating…` pending state | A | Reuse existing pending-investigation UI. |
| Detailed live progress ("Checking diff…") | C-later | Requires investigator progress events; do not fake. |
| Return checkpoint | C-later | Requires attention-cursor + delta projection (see §13). |

---

## 10. Worker milestones — inclusion rules

Only events that materially change the human's understanding enter the conversation.

```text
include: test suite finished, session finished, permission requested,
         worker explicitly waiting on human, meaningful session-status transition

exclude: opened file, grep, tool_started, ordinary command, every file_changed
```

Excluded events remain visible in worker activity / trace.

---

## 11. Composer contract

Single composer with a **destination** selector, not an Ask/Agent mode toggle:

```text
Vowe        → askCompanion()
Claude Code → sendInstruction()
```

UI unifies presentation; execution paths remain separate (§1).

**Context attachments (File / diff / paste)** — **C, new capability**. Requires extending the ask contract:

```ts
interface AskCompanionInput {
  sessionId: string;
  question: string;
  contextRefs?: ContextRef[];
}
```

Do not render attachment chips the backend ignores.

**"Sounds like an instruction" suggestion** — **D — Future**, requires an intent classifier; not required for the redesigned composer.

---

## 12. Workbench

Do not invent a new evidence ontology. `ContextRef` remains the canonical address; define only a display projection.

```ts
type ArtifactKind =
  | "source"
  | "diff"
  | "test_failure"
  | "worker_activity"
  | "project_memory"
  | "basis"
  | "raw_event";

interface WorkbenchArtifact {
  id: string;

  kind: ArtifactKind;

  title: string;
  subtitle?: string;

  sourceRef?: ContextRef;

  content: ArtifactContent;

  focus?: {
    startLine?: number;
    endLine?: number;
    eventIds?: string[];
  };
}
```

### `ArtifactResolver` (main/core-side)

```ts
interface ArtifactResolver {
  resolve(ref: ContextRef): Promise<WorkbenchArtifact>;
}
```

```text
ContextRef → ContextNavigator / EventStore / get_diff → WorkbenchArtifact
```

New renderer IPC: `openArtifact(ref: ContextRef): Promise<WorkbenchArtifact>`.

### `WorkbenchState` (renderer-local, ephemeral, session-scoped)

```ts
interface WorkbenchState {
  activeId: string | null;
  items: WorkbenchArtifact[];
  pinnedId: string | null;
  open: boolean;
}
```

Rules:

```text
artifact opened by user                → add + activate
artifact surfaced by Vowe              → add + activate, unless current artifact pinned
pinned active artifact                 → Vowe may add new artifact but may not replace active
close workbench                        → artifacts remain temporarily on desk
session switch                         → desk is session-scoped
```

No cross-restart persistence required in v1.

Inline "point to artifact" from prose (e.g. "this insertion branch") is **C-small / post-workbench**:

```ts
interface ArtifactPointer {
  ref: ContextRef;
  startLine?: number;
  endLine?: number;
}
```

Ship explicit links first (`↗ file.ts · 84–96`); add prose-hover sync afterward. Do not block Workbench v1 on it.

---

## 13. Investigation receipt / grounding

Extend the existing `DelegatedQuestionRunner` ref collection into an ordered, truthful receipt:

```ts
interface InvestigationReceipt {
  durationMs: number;
  checks: InvestigationCheck[];
}

interface InvestigationCheck {
  kind: "search" | "open" | "diff";
  label: string;
  refs: ContextRef[];
}

interface ConversationEntry {
  // ...existing fields
  refs?: ContextRef[];
  investigation?: InvestigationReceipt;
}
```

Only observable retrieval actions go here. Never chain-of-thought, model hypotheses, prompts, or hidden reasoning.

---

## 14. Return checkpoints (C — later, not v1-blocking)

```ts
interface SessionAttentionCursor {
  sessionId: string;
  lastMeaningfullyViewedAt: string;
  lastViewedSeq: number;
}
```

```text
events/notes since last attention → meaningful changes only → return checkpoint
```

Do not implement until core redesigned Session Room is real.

---

## 15. Voice

| Concept | Class | Contract |
|---|---|---|
| Presence click starts/ends Voice | A/UI | Call existing `join()` / `end()`. |
| Large voice-stage orb | C visual | Same `VowePresence` component, larger size. |
| Mute | A | Existing `toggleMute()`. |
| Live listening/speaking visual state | C-small | Derive from local mic/output audio or provider events. |
| Full live transcript in renderer | C | `useVo` doesn't currently expose transcript. |
| Voice automatically surfaces artifact | C | Requires backend/render signal tying answer/ref to workbench. |
| Voice highlights code while speaking | D/C-later | Requires timing/alignment signal. |
| Project-level voice | D | Session-scoped Live remains first release. |

**Voice conversation persistence:** treat full persistence of all ordinary voice turns (not just delegated technical questions) into the same durable thread as text as **C — New capability** unless code inspection proves it already exists. Do not visually imply durable voice history until that path is real.

---

## 16. Vowe Presence

One implementation everywhere — no separate Project/Voice/Studio orb implementations:

```tsx
<VowePresence profile={profile} state={state} size={size} audio={audioState} />
```

```ts
type PresenceSize = "signature" | "compact" | "project" | "voice" | "studio";

type PresenceState =
  | "idle" | "observing" | "joining" | "listening"
  | "thinking" | "speaking" | "attention" | "unavailable";
```

### Presence Studio (C — new capability)

```ts
interface PresenceProfile {
  form: "point-cloud"; // schema stays extensible (mesh/knot/halo…) but only point-cloud ships now
  material: "silver" | "obsidian" | "matrix" | "plasma";
  motion: "calm" | "fluid" | "reactive";
  accent?: string;
}
```

Persist globally under existing Electron `userData`.

### Behavior customization

- Appearance profile: real.
- Existing per-session plain-language communication preference (`setCommunicationPreference`): real, keep.
- Additional global temperament sliders (Quiet↔Proactive, Concise↔Exploratory, Professional↔Casual): **D — Future** unless a real backend behavior mapping is defined. Never ship cosmetic sliders that do nothing.

---

## 17. User profile / identity

```ts
interface UserProfile {
  displayName: string;
  avatarUri?: string;
}
```

Store locally; default display name `"You"` until customized. Cloud authentication is **D — Future**, only introduced when Vowe gains cloud sync, multi-device state, teams, shared projects, or hosted billing/accounts. Do not add OAuth just to render an avatar.

Speaker-run identity rules (backed by `ConversationEntry.role + UserProfile + PresenceProfile`):

```text
new user speaker run          → show identity once
consecutive user messages     → no repeated avatar/name
new Vowe speaker run          → subtle signature once
consecutive Vowe messages     → do not repeat
```

Presence material may influence the Vowe signature but must not theme the whole application.

---

## 18. New core/main contracts

```text
ProjectBriefService
ArtifactResolver
InvestigationReceipt
UserProfileStore
PresenceProfileStore
ReturnCheckpointService   // later
```

Explicitly **do not introduce** for this redesign:

```text
ProjectAgent
ProjectObserver
ContextBroker
Orchestrator
VectorStore
```

---

## 19. IPC additions required before UI transplant

```ts
getProjectBrief(projectId: string): Promise<ProjectBrief>;

openArtifact(ref: ContextRef): Promise<WorkbenchArtifact>;

getUserProfile(): Promise<UserProfile>;
setUserProfile(profile: UserProfile): Promise<void>;

getPresenceProfile(): Promise<PresenceProfile>;
setPresenceProfile(profile: PresenceProfile): Promise<void>;
```

If composer attachments ship:

```ts
askCompanion(input: {
  sessionId: string;
  question: string;
  contextRefs?: ContextRef[];
}): Promise<AskResult>;
```

If investigation receipts ship: no additional fetch API needed — `ConversationEntry` carries the receipt.

Conversation-change notification (currently missing — typed Ask re-reads after the answer returns):

```ts
onConversationChanged(listener: (sessionId: string) => void): () => void;
```

Needed so delegated voice answers and future persisted voice turns update the Session Room without polling.

If live voice UI later needs non-delegated transcript state: add a dedicated Live conversation/state event contract rather than parsing provider-private details throughout React.

---

## 20. Persistence layout

```text
vowe/
  sessions.json
  projects.json

  profile.json
  presence.json

  sessions/
    <session>/
      conversation.ndjson
      ...

  projects/
    <project>/
      knowledge/
        ...
```

One persistent Vowe identity — Presence settings never live inside individual sessions or Projects.

---

## 21. Refresh / subscription behavior

Project Room re-fetches `getProjectBrief(projectId)` on:

```text
onSessionsChanged
onObservationChanged
onProjectKnowledgeChanged
```

Renderer must not manually recompute project synthesis from multiple stores.

Session Room reacts to: session events, observation changes, conversation changes (via `onConversationChanged`, §19), live status.

---

## 22. Component migration map

| Current component | Disposition |
|---|---|
| `App.tsx` | Becomes `AppShell`; retain selection/session/project refresh logic. |
| `ProjectSidebar` | Retain grouping behavior; new visual treatment; add user/Your Vowe region. |
| `ProjectRoom` | Replace presentation; bind to `ProjectBrief`; keep deterministic-aggregation concept. |
| `SessionDetail` | Decompose into Session Room primitives; do not preserve as monolith. |
| `SemanticPanel` | Remove as standalone panel; data absorbed into header/ProjectBrief/conversation context. |
| `ObservationPanel` | Remove from primary UI; keep behind secondary settings/debug surfaces. |
| `EventInspector` | Keep — becomes the deep worker-activity/raw-event artifact path inside Workbench. |
| `VoPanel` / `VoBar` | Preserve `useVo` transport logic; replace visuals with `VowePresence + VoiceStage`. |
| `NewSessionSheet` | Retain managed-launch behavior; restyle later. |
| `ui.tsx` | Reuse initially; refactor only once new primitives stabilize. |
| `styles.css` | Expect full rewrite; no domain semantics should live here. |

---

## 23. Slice 0 acceptance criteria

1. Every meaningful visible concept in the approved design is classified A/B/C/D.
2. Every A/B concept names its real source of truth.
3. Every C concept has a proposed typed contract and ownership boundary.
4. Every D concept is explicitly excluded from the first build.
5. No production UI requirement depends on mock data.
6. Project identity is reused rather than rebuilt.
7. Asking Vowe and instructing a worker remain separate code paths.
8. Text and voice continue sharing one investigator.
9. Workbench uses `ContextRef` rather than inventing a parallel evidence system.
10. Project Room can be implemented without creating a project-level agent.
11. Presence Studio can be implemented without introducing authentication.
12. The approved design can be implemented incrementally without requiring a rewrite of observer, project knowledge, control, or Live architecture.

---

## 24. Implementation slicing

```text
Slice 1 — Product-state primitives
  ProjectBrief, ProjectSignal, Needs-You projection,
  UserProfile, PresenceProfile persistence
  (no broad UI redesign yet)

Slice 2 — Workbench substrate
  ArtifactResolver, artifact DTOs, InvestigationReceipt,
  generic artifact IPC, conversation-changed event
  (current UI keeps working)

Slice 3 — Presence
  VowePresence, point-cloud renderer, state API, material/motion presets,
  Presence Studio — prove one renderer across signature/compact/project/voice/studio
  before rewiring the full application

Slice 4 — Production UI transplant
  Replace ProjectSidebar visuals, ProjectRoom, SessionDetail, composer,
  conversation, Workbench, voice presentation — bound to Slices 1–3 contracts

Slice 5 — Intelligent polish (only after core redesigned app is real)
  automatic artifact surfacing, inline pointing, return checkpoints,
  speaker signatures, worker-instruction suggestion, full durable voice transcript
```

Next narrow scope after this document: **Slice 1 only** — `ProjectBrief` + Needs You + Latest Signal + local `UserProfile`/`PresenceProfile` persistence. Do not touch the redesigned renderer yet.
