# Local-only Projects

## Problem

Tracking a repo requires an `origin` remote ([home.ts:58](../../src/server/home.ts)),
because the back half of the factory — PR gate, review flow, merge-verified
Done — has exactly one implementation and it is GitHub-shaped. A repo that
will never be shared or pushed anywhere cannot be tracked at all, even though
the worktree machinery (bare clone, ticket branches, ahead-counts) already
operates purely against the local checkout.

## Goal

A Project can be tracked from a local repo with no `origin` remote. Tickets
run the full loop — claim, worktree, phases, gates, review, Done — with the
merge landing on the local target branch instead of via a GitHub PR.

## Non-goals

- Converting a local-only Project to a GitHub-backed one later (separate
  ticket if ever wanted; the seam is `Repo.githubRemote` going from null to
  a value).
- Any change to GitHub-backed Projects' behavior.
- Supporting non-`origin` remote names.

## Design

A Project is **local-only** iff its Repo's `githubRemote` is null. No new
flag — the absence of the remote *is* the mode. Decided at track time,
immutable for now.

### Track time (`home.ts`)

- `remote get-url origin` failing no longer throws `StateError`; it yields
  `githubRemote: null`.
- Dedup: `trackedByRemote` is skipped for remote-less repos (it already
  returns null on missing remote); `trackedByPath` remains the only identity.
  The "one remote = one Project" invariant is untouched for repos that have
  remotes.

### Schema / types

- `Repo.githubRemote: string | null` (migration: existing rows unchanged).
- Every `repoSlug(repo.githubRemote)` call site must be audited: for a null
  remote the call must be unreachable (gate skipped, path branched) — never
  a runtime throw.

### Worktrees (`worktrees.ts`)

No changes. The bare clone's `origin` is the local checkout already;
`fetch origin`, branch-from-`refs/remotes/origin/<targetBranch>`, and
ahead-counts all work as-is. This is the reason the feature is cheap.

### Gate battery (`gates.ts`)

For a local-only Repo:

- `branch-recorded`: check the branch exists in the bare clone instead of
  via `github.branchExists`.
- `pr-fresh`: **skip** with `reason: "local-only project"` — skip is the
  established "not applicable, determined by facts" outcome and is distinct
  from pass, so the record stays honest.
- `suite`, `demo-fresh`, `ac-check`: unchanged — nothing GitHub in them.

### Review flow (`reviews.ts`, `verdicts.ts`)

The review wizard reads the latest Run, not the PR, for phases/ACs — audit
for PR-number reads and branch them to "diff of ticket branch vs
`origin/<targetBranch>` in the bare clone." The Manual Walkthrough is
already PR-free.

### Merge / Done

New local merge path, used where the GitHub merge would be triggered:

- Merge the ticket branch into `<targetBranch>` **in the user's checkout**
  (not the bare clone — the user's working copy is the source of truth the
  bare clone fetches from). Fast-forward or merge commit; on conflict the
  merge aborts cleanly (no half-merge) and the pass verdict fails with a
  StateError — the same surface a conflicting PR presents, leaving the
  reviewer the existing choices (fail/reverify). *(As built: this replaced
  the spec's original auto-bounce-on-conflict, for symmetry with the GitHub
  path.)* When the target branch is not checked out, only a fast-forward is
  possible; anything else is refused with instructions rather than touching
  the user's working tree.
- `Ticket.prNumber` stays null for local-only tickets; Done's definition for
  them is "merge commit reachable from `<targetBranch>`."

### Done sweep (`sweep.ts`)

The reap-safety check "PR verifiably merged on the remote" becomes, for
local-only tickets, "ticket branch's tip is an ancestor of the local
`<targetBranch>`." The kb/-preservation half of the check is unchanged.

### UI

- Home's clone-from-GitHub path is unaffected; the pick-local-folder path
  simply stops erroring on remote-less repos.
- Board/ticket surfaces that render a PR link render nothing (not a dead
  link) when `prNumber` is null.

## Acceptance criteria

1. Tracking a repo with no `origin` remote succeeds and creates a Project;
   the Repo row has `githubRemote = null`.
2. Tracking the same path twice reopens the existing Project (dedup by path).
3. A ticket on a local-only Project runs to Verifying: worktree created,
   branch based on the local target branch, phases executed.
4. Gate battery on a local-only ticket: `pr-fresh` records `skip` with a
   local-only reason; `branch-recorded` passes against the bare clone;
   `suite`/`ac-check` behave as on GitHub projects.
5. Passing gates + review moves the ticket to Done and the ticket branch is
   merged into the local target branch in the user's checkout; a merge
   conflict bounces the ticket instead of half-merging.
6. Done sweep reaps a local-only ticket's worktree only when the branch tip
   is an ancestor of the local target branch, and preserves kb/ evidence
   per the existing rule.
7. GitHub-backed Projects: full existing test suite unchanged (no behavior
   drift).
8. No code path calls `repoSlug`/`github.*` with a null remote (grep +
   type-level: call sites take `string`, not `string | null`).

## Open question (pre-implementation)

Whether Done-merge should also push the bare clone's view forward
immediately or rely on the next claim's `fetch origin` — recommend the
latter (fetch-on-claim already reconciles; no new sync machinery).
