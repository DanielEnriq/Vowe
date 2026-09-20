# Projects

A **Project** is the durable parent of agent sessions:

```
All Projects  →  Project  →  Session  →  Observation
```

Today a Project is a **Git repository**. Several agents working in the same
codebase belong to the same Project, whichever worktree or subdirectory each one
happens to be in.

This exists for navigation, not intelligence. Vowe used to show a flat list of
agent processes, which answered "is anything running?" — the right question when
there was one agent, and the wrong one once several work in one repository while
others work elsewhere.

## Identity

One `git rev-parse` answers the grouping question:

```bash
git rev-parse --path-format=absolute --git-common-dir --show-toplevel
```

| Run from | `--git-common-dir` | `--show-toplevel` |
|---|---|---|
| the repository | `…/Vowe/.git` | `…/Vowe` |
| a linked worktree | `…/Vowe/.git` | `/tmp/feature-branch` |

**The common directory is identical across every worktree; the toplevel is not.**
So the common directory is the *identity* and the toplevel is the *location*,
and worktree grouping falls out of the data rather than needing to be detected.

`--path-format=absolute` is load-bearing. Without it the main worktree reports a
bare relative `.git` while a linked one reports an absolute path, and two
sessions in the same repository would not compare equal.

### Identity and location are never conflated

They coincide for a session in the main worktree and diverge for every other
one, so they are separate types:

```ts
interface ProjectIdentity {   // canonical, shared by the whole repository
  key: string;                // the grouping key
  name: string;
  repoRoot: string;           // the MAIN worktree, never a linked one
  gitCommonDir?: string;
  remoteUrl?: string;         // metadata; deliberately not canonicalized
}

interface SessionLocation {   // one session's own position
  worktreePath: string;
  branch?: string;
  isPrimaryWorktree: boolean;
}
```

`repoRoot` is derived from `gitCommonDir` (`…/Vowe/.git` → `…/Vowe`), **not**
from the session's own toplevel. Taking it from the session would make a
project's identity depend on which of its sessions happened to be discovered
first — a bug that would only appear once someone used a worktree.

The name comes from the same place, so a session in a worktree called `feature`
still reports its project as `Vowe`.

### The id

`git:<sha256(gitCommonDir)>`, truncated. Derived rather than allocated, so it is
stable across restarts without a lookup, and opaque, so the filesystem path
stays metadata rather than becoming the user-facing identity.

Display names are disambiguated **only when they collide**: two unrelated `api`
repositories become `services/api` and `vendor/api`, while a unique name is left
alone.

## Outside Git

An agent working outside a repository is normal and must not break anything. The
fallback is deliberately simple: the directory is the project, identified by its
realpath (`path:<sha256(realpath)>`) and named by its basename.

Symlinks are resolved, so `/tmp/x` and `/private/tmp/x` are one project rather
than two.

A session with **no working directory at all** gets `projectId: null`. It is
still listed, in a quiet "No project" group — a session Vowe cannot place is not
a session it drops.

## How sessions attach

Adapters report *where* a session is; Vowe decides what that means. The Claude
Code adapter sets `cwd` and `projectId: null`, and knows nothing about projects.

Assignment happens in `SessionRegistry.absorb()`, the single funnel every
discovered session already passes through:

```
session cwd → resolve repository → find or create Project → stamp the session
```

The session carries the result: `projectId`, plus `worktree` and `branch` when
it is in a linked worktree.

### Resolution runs on change, not on every pass

Reconciliation runs for every session every few seconds. Shelling out to git on
that cadence would be waste, so there are two guards:

1. A known session whose `cwd` is unchanged and which already has a `projectId`
   is skipped entirely — one string comparison, no async work at all.
2. Everything else is memoized by directory, so rediscovering twenty sessions
   across three repositories costs three git invocations rather than twenty.

Failures are cached too: a directory that cannot be read is not re-probed every
five seconds.

## Persistence

`projects.json`, beside `sessions.json` under the app's data directory.

**Identity only.** No membership, no counts, no activity timestamp:

```json
{
  "id": "git:a1247f04614efa44",
  "name": "Vowe",
  "repoRoot": "/Users/dev/projects/Vowe",
  "gitCommonDir": "/Users/dev/projects/Vowe/.git",
  "remoteUrl": "https://github.com/…/Vowe.git",
  "createdAt": "2026-09-20T05:40:00.960Z"
}
```

A session's `projectId` is the single record of membership, and counts, status
and last activity are recomputed from the sessions on every read. There is one
source of truth, so a project's view of its work is incapable of disagreeing
with the sessions themselves — and nothing needs invalidating when a session
finishes.

Finished sessions keep their `projectId` and stay in the index. They move into
**Recent** under the same Project and survive restart; nothing is deleted when
work completes.

## What a Project is not, yet

Deliberately **not** implemented in this slice:

- **No project-level Vo.** The Project Room's header leaves room for
  "Ask Vo about this project…", but there is no such conversation yet.
- **No `ProjectObserver`.** Observation remains per session. Nothing reads
  several sessions together.
- **No project summary.** The Project Room is composed from session state that
  already exists — task names, status, the latest interpreted activity, relative
  times. **No model is called to render it.**
- **No repository indexing, semantic graph, embeddings or project memory.**

The hierarchy is the point. Adding project-level intelligence later should be
additive: a `ProjectObserver` reading the L1 notes its sessions already produce,
reached from a place that already exists in the navigation.

See [the observation harness](observer-harness.md) for what happens inside a
single session.
