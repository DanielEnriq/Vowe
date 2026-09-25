# Project voice architecture

## Trace before implementation

- `VoPanel.useVo` owns microphone, WebRTC negotiation, output audio, mute, and measured playback. `startLive` crosses preload/IPC only for the authenticated SDP exchange. SessionRoom currently replaces its conversation with VoiceStage.
- Main constructs one `LiveBridge`, one `DelegatedQuestionRunner`, and one `ContextNavigator`. The bridge receives observation notes silently and policy-approved surface updates separately.
- `OpenAiLiveTransport` uses the installed SDK's `client.live.create` with client delegation and a server-side SidebandWS. Provider events normalize to transcript fragments, delegation requests, closure, and errors. Audio travels between renderer and provider; credentials stay in main.
- `LiveConversationRecorder` assembles fragments, serializes writes, deduplicates by provider/session/speaker/start offset, and records playback/interruption separately from semantic entries. A delegated full answer is stored once; its short spoken rendition becomes a delivery of that entry.
- Typed session Ask and voice delegation call `DelegatedQuestionRunner.answer`. Typed Project Ask calls `answerProject` on that same instance, using project-scoped navigator read tools, project roster, previous project turns, and the same investigator. Neither investigation path can control workers.
- `ProjectSpace` owns Home, Conversation, investigation subscription, and Workbench. `ProjectRoom` is current project state. ProjectConversation is durable history. Evidence clicks resolve through the same `openArtifact` API and Workbench reducer as session evidence.
- Presence already supports joining, listening, thinking, and speaking, including measured audio and reduced-motion behavior. Its prior priority made connected listening hide investigation thinking.

## Scope of this change

Extend the existing bridge/recorder to project scope, seed voice from the current ProjectBrief and durable Project Conversation, and delegate through answerProject. Reuse entry origin and delivery semantics; project deliveries follow the existing separate project-conversation storage boundary. No new model, agent, model-facing tool, retrieval system, semantic memory, or worker-control capability.

Project Home keeps its orientation visible. The same connection survives Home/Conversation navigation and ends when leaving the project. Grounded work uses the shared progress UI and artifact surfacing. Captions are transient; completed turns live in Conversation.

Voice remains observational. Explicit worker instructions must use the existing session instruction UI and its provider checks; this change grants voice no write capability.

## Delivery and connection details

- The additive `009_project_delivery` migration keeps project deliveries beside the existing project conversation table, using the same `ConversationDelivery` fields and store APIs. Entry plus delivery writes are transactional, provider origins deduplicate, and project subscribers run after commit.
- Project questions may reference an already persisted voice utterance. The investigator does not insert that question twice. Both typed and voice follow-ups use the shared delivery-aware context formatter.
- A spoken delivery is recorded as started before handing the concise answer to Live. A new question or call end before speech cancels that delivery. Interrupted transcript text is not presented to the investigator as proof that every word was heard.
- Playback measurements serialize behind entry writes. The recorded interruption status survives later call shutdown and links to the interrupting user turn.
- Duplicate delegation IDs are ignored. Late investigation results remain available in Conversation but are not spoken into an ended/replaced call or over a newer question. Connection generations prevent a late handshake from reopening an ended call.
- The adapter waits for the installed SDK socket to open and reports later socket loss. SDK `send` queues during connection, so construction alone was not evidence of a successful attachment. This follows the same one-session sideband arrangement described in [OpenAI server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls).

## Design

Retain the existing system typeface, reading measure, and theme tokens: dark pane `#0e0f11`, dark field `#131417`, dark ink `#e9e9ec`, light ink `#23262b`, and secondary ink `#52565d`. Keep Home content left-aligned and put Talk beside Ask. The existing point-cloud presence carries the voice state. No new animation or waveform; reduced motion continues through the existing presence renderer. A bounded live caption and the shared investigation timeline coexist with current project state; settled transcript content belongs in Conversation.

## Verification

Final checks passed: 842 tests across 84 files, workspace typecheck, package builds, desktop build, and `git diff --check`. Changes are uncommitted.

Automated coverage includes orientation without investigation, mixed typed/voice history, project-scoped read-tool execution and progress, one persisted question/answer, separate written/spoken text, interrupted follow-up context, delivery duration ordering, restart/deduplication, write rollback, stale-result suppression, setup cancellation, and sideband failure/timeout.

In the real Electron app, verified the Talk control on Home, recoverable microphone-denied behavior, Conversation → Home return, real evidence opening in Workbench, light Home with both panels open, and dark Home with both panels closed. The existing database migrated successfully and existing typed history remained readable.

Live microphone capture returned NotAllowedError / Permission denied before connection setup. Actual spoken orientation, grounded speech, audible follow-up/barge-in, and persistence of a real microphone exchange remain unverified. The Mac then locked during final panel checks; the original light preference could not yet be restored. Deterministic provider tests do not substitute for these missing live audio checks.
