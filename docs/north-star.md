# Vowe North Star

This is the canonical Vowe implementation direction from here. The important product model is a coherent path from a 30-minute feature to multi-week organizational work, without making sessions, PRs, or tickets the fundamental unit.

> **Vowe maintains continuity from the change a developer intends, through however many agents and sessions it takes to build it, to the software and shared understanding that ultimately exist.**

Studio is where that continuity begins.

## Canonical implementation sequence

## Phase 1 — DESIGN

**Make the change understandable before an agent builds it.**

The durable idea is:

> **Studio is Vowe's representation of the change the developer is trying to make true.**

That change can be tiny or huge.

```text
small feature
"Add CSV export"

medium feature
"Make document processing async"

large change
"Build realtime collaboration"

architecture initiative
"Replace project/session understanding"
```

Studio should draw **only the neighborhood necessary to reason about the change**. It is not trying to model the entire company architecture every time.

Phase 1 itself is:

```text
1A — Artifact-first experience
      ✓ canvas becomes the product
      ✓ conversation becomes secondary
      ✓ selection / motion / manipulation
      ✓ focused Studio shell

1B — System-design grammar
      ✓ client / service / store / queue / external / group
      ✓ technology identity
      ✓ grouping
      ✓ cheap-model system-design behavior

1C — Semantic × Visual Integration        ← WE ARE HERE
      kinds become visually meaningful
      technology becomes tasteful identity
      groups become real system boundaries
      group-aware layout
      semantic manipulation becomes spatial

1D — Grounded repository understanding
      improve Start from Code
      coding harness returns conceptual system view + evidence
      attempt one broad cold-start consultation instead of two
      lower cost + latency
      stop leaking class/module vocabulary into Studio

1E — Direct authoring + delight
      add things directly
      connect them
      group them
      manipulate responsibilities
      beautiful technology/component insertion
      make Studio independently excellent to use
```

After 1E, stop expanding the design tool for its own sake.

Studio is good enough when a developer can think:

> **“I can see the change I want, manipulate it, and Vowe understands what I mean.”**

Then we cross the worker boundary.

---

## Phase 2 — BUILD

### Turn intent into an evolving implementation path

The recent insight matters enormously:

> **A coding-agent session is not the unit of work.**

Neither is a PR.

The thing the developer is trying to accomplish might take:

```text
1 slice → 1 session

or

3 slices → 4 sessions → 2 PRs

or

9 slices → 12 sessions → a week of work
```

Vowe should own the **piece of work** above those temporary executions.

Conceptually:

```text
PROJECT
   │
   └── PIECE OF WORK / CHANGE
         │
         ├── intent
         ├── Studio design
         ├── implementation path
         ├── discoveries
         ├── current state
         │
         └── execution slices
                ├── session
                ├── session
                └── ...
```

These are conceptual responsibilities, not final database nouns.

### 2A — Design → implementation brief

From Studio:

**Build this →**

Vowe compiles:

```text
why we're doing this

desired system/change

selected scope

important constraints

decisions already made

relevant repository facts

deliberately unresolved questions

verification expectations
```

And sends that to Claude Code / Codex / Cursor / whichever coding harness is appropriate.

The critical instruction remains:

> **This describes intent. Inspect the repository yourself and choose the correct implementation. If repository reality contradicts the design, surface that rather than forcing it.**

The developer should no longer have to manually translate a design discussion into a giant coding-agent prompt.

### 2B — Decompose work into coherent build slices

Vowe determines:

> **What is the next independently understandable and verifiable piece of progress?**

Not:

> Which architecture box gets an agent?

For example:

```text
Make document processing async

Slice 1
Establish async boundary
API + queue + job persistence

Slice 2
Build processing path
worker + model + result writing

Slice 3
Complete lifecycle
result retrieval + retries + verification
```

A slice can cross several system components.

And importantly, this is **not a static master plan**.

```text
desired change
      ↓
next slice
      ↓
coding session
      ↓
discoveries
      ↓
re-evaluate remaining path
      ↓
next slice
```

If Slice 1 discovers the repository already has a useful job abstraction, Vowe changes Slices 2 and 3.

This is how real software work behaves.

### 2C — Multi-session continuity

One slice might itself need more than one coding session.

Or the developer might deliberately stop one harness and continue with another.

Vowe carries forward:

```text
what we're building

what has already happened

what was learned

which decisions remain valid

what this next session is responsible for

what it should not reopen

what counts as done
```

So Tuesday's coding session doesn't need:

> “Okay, yesterday Claude did this…”

Vowe was there.

The session is temporary.

**The work persists.**

---

## Phase 3 — OVERSEE

### Stay connected while agents execute without requiring the developer to watch them

Now the observation system we've already built becomes much more valuable.

Instead of:

> Claude is editing `foo.ts`.

Vowe can say:

> **The async-boundary slice is implemented and being verified.**

Instead of:

> Agent session #5 ended.

Vowe can say:

> **Team Invitations has completed token persistence and email delivery. Acceptance is the current slice.**

The unit of awareness becomes **the work**, not the agent.

### 3A — Interpret execution relative to intent

Vowe already sees execution evidence.

Now it maps that evidence onto:

```text
piece of work
      ↓
build slice
      ↓
design elements
```

So Studio itself can eventually express:

```text
what we designed
what is being built
what appears complete
what is unverified
```

Without turning into a project-management board.

### 3B — Work talks back to Design

This is crucial.

Implementation discovers:

> The existing auth lifecycle makes this boundary impossible without duplicating state.

That's not merely an agent update.

It changes the thing we're trying to build.

So:

```text
DESIGN
   ↓
BUILD
   ↓
DISCOVERY
   ↓
Vowe recognizes design consequence
   ↓
STUDIO
   ↓
human revises design
   ↓
remaining build path changes
```

That is the loop.

### 3C — Reconcile desired and actual worlds

Eventually Vowe understands:

```text
CURRENT SYSTEM A
      ↓
DESIRED CHANGE
      ↓
agent work
      ↓
CURRENT SYSTEM B
```

Things designed in Studio gradually become actual repository reality.

If they converge, great.

If they don't:

> “The implementation now keeps retry state in the API, while the design moved that responsibility to the Worker.”

That's meaningful.

Vowe isn't doing code review merely at the diff level.

It's detecting **intent drift**.

---

## This works at every scale

The scaling property is important enough to preserve explicitly.

### Small professional feature

```text
"Add rate limiting"

Studio:
3–4 relevant parts

Build:
1 slice

Execution:
1–2 sessions

Duration:
hour(s)
```

Maybe:

```text
Clients
   ↓
Rate Limit ─── Redis
   ↓
Public API
```

Then Build.

### Medium piece of work

```text
"Add team invitations"

Studio:
5–7 parts

Build:
3 slices

Execution:
3–5 sessions

Duration:
1–3 days
```

### Large initiative

```text
"Build realtime collaboration"

Studio:
larger system + focused sub-designs

Build:
8–10 evolving slices

Execution:
many sessions / perhaps many PRs

Duration:
week(s)
```

Vowe still presents:

> **the work**

rather than a pile of sessions.

---

## Phase 4 — TEAM / ORGANIZATION

### Personal Vowes over shared software work

This is where the same model becomes organizational.

The key principle remains:

> **Your Vowe is personal. Its understanding can be collective.**

A person's Vowe understands:

```text
what I'm working on
what I've seen
where I left off
what needs my judgment
```

while shared project understanding can know:

```text
what work exists
how changes relate
dependencies
design decisions
discoveries
actual implementation state
```

subject to permissions.

This is emphatically **not an employee-monitoring layer**.

The shared object is the **work and its relationships**, not “what Alice did for 3 hours.”

---

## External tools connect into this model; they do not define it

This is where something like **Linear MCP** becomes useful — but only as one small example of a much larger connection architecture.

Suppose the developer has a Linear ticket:

> ENG-412: Add team invitations.

Vowe can connect it to the actual piece of work:

```text
Linear ticket
declared request / acceptance context
        │
        ▼
VOWE WORK
"Team Invitations"
        │
        ├── Studio design
        ├── implementation path
        ├── coding sessions
        ├── discoveries
        ├── PRs
        └── current status
```

The Linear ticket is **not** the semantic root.

It's one source/reference.

The ticket might seed:

- description;
- acceptance criteria;
- ownership;
- priority;
- links to related tickets.

Then the real work develops shape that Linear never contained.

And Vowe could eventually reflect a useful summary back:

> Team Invitations: acceptance flow complete; revocation remains; implementation discovered expiry should live in existing auth storage.

Maybe that becomes a comment/update through the Linear connection.

But the Linear representation remains only one projection.

## Linear is one connector in a much larger picture

Conceptually:

```text
                    VOWE WORK

        declared intent / external context
                     ▲
                     │
 Linear ─────────────┤
 Jira ───────────────┤
 docs/specs ─────────┤
 Slack ──────────────┤
                     │
                     │
                     ▼
                  STUDIO
               desired change
                     │
                     ▼
             CODING HARNESSES
                     │
                     ▼
                   WORK
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
        GitHub       CI       runtime
      PR/commits   verification deployment
          │          │          │
          └──────────┼──────────┘
                     ▼
             VOWE UNDERSTANDING
```

Potential connections over time might include:

- Linear / Jira / issue systems → declared work;
- GitHub / GitLab → commits, PRs, review, merge;
- Slack → explicit team communication;
- Docs / Notion → specs and rationale;
- CI → verification state;
- cloud/deployment systems → whether it actually shipped;
- observability/incidents → outcomes after shipping;
- coding harnesses → execution and discovery.

But none should become **the source of truth for what work means**.

Vowe connects them.

## This also handles organizational reality better than tickets

A ticket might map:

```text
one ticket
    ↓
one Vowe change
```

Often.

But it doesn't have to.

You can also get:

```text
one ticket
    ↓
several pieces of work
```

or:

```text
several tickets
    ↓
one architectural change
```

or:

```text
one piece of work
    ↓
3 PRs
8 coding sessions
2 engineers
```

That's why:

> **ticket ≠ work**
>
> **PR ≠ work**
>
> **session ≠ work**

They're all artifacts/episodes related to the work.

That distinction is foundational.

---

## Eventually the organization can ask different questions over the same substrate

Developer:

> What should I do next on Team Invitations?

Tech lead:

> What changed in the auth work this week?

Engineer joining:

> Why is invitation state stored here?

Manager:

> Which pieces of the release actually need engineering attention?

Reviewer:

> What did this PR implement relative to the intended design?

Vowe doesn't need a separate database for every audience.

It maintains the work and produces appropriate projections.

---

## And this connects back to Project Representation

We had previously positioned Project Representation as Phase 1.

Studio has given us a more productive path toward it.

Rather than stopping current implementation to invent the universal semantic memory model, we are now naturally generating:

```text
human intent
design state
design Moves
repo findings
implementation slices
session evidence
discoveries
actual resulting code
human corrections
```

That becomes an incredibly rich corpus from which the deeper durable Project Representation can emerge.

So the broader memory work now belongs **throughout and after Design → Build → Oversee**, rather than as a giant isolated subsystem we must finish first.

Each phase earns the semantic structures the next one needs.

---

## The implementation loop

Keep this loop pinned:

```text
                   HUMAN
                     │
             "make X true"
                     │
                     ▼
                  DESIGN
                 Studio
                     │
                     ▼
                  BUILD
         evolving implementation path
                     │
                     ▼
             coding session(s)
                     │
                     ▼
                 OVERSEE
        Vowe understands execution
                     │
              ┌──────┴───────┐
              ▼              ▼
           progress       discovery
              │              │
              │              ▼
              │            DESIGN
              │           may change
              │              │
              └──────┬───────┘
                     ▼
                 next slice
                     │
                    ...
                     │
                     ▼
              ACTUAL SYSTEM
```

At company scale, external systems simply attach around this loop.

## Current implementation marker

```text
PHASE 1 — DESIGN

1A  Artifact-first Studio              ✓
1B  System-design grammar              ✓
1C  Semantic × Visual Integration      ← CURRENT
1D  Grounded repository abstraction    next / parallel candidate
1E  Direct authoring + delight         after 1C/1D

PHASE 2 — BUILD
     design → adaptive slices → sessions

PHASE 3 — OVERSEE
     sessions → work understanding → design feedback

PHASE 4 — TEAM / ORGANIZATION
     personal lenses over connected shared work

LATER / EMERGENT
     durable Project Representation
     cross-project understanding
     learned engineering procedures
     coordination / orchestration earned from understanding
```
