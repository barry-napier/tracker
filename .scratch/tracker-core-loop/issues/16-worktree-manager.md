# Implement the repo and worktree manager

Type: task
Status: closed (superseded)

## Question

Build the git layer per [Worktree lifecycle and claim/lease semantics](08-worktree-lifecycle.md): bare clone per repo at `<app-data>/repos/<repo>.git` created on registration, fetch-on-claim, worktree add at `<app-data>/worktrees/<repo>--<trk-id>` cut from the target branch on first claim, branch naming (conventional-commit type + external-ref id, TRK fallback), as-is re-claim reuse with tree-state summary (branch, ahead-by, dirty count), the Done-column sweep behind the merged-and-artifacts-persisted predicate, and startup orphan reaping. Done when create/re-claim/sweep/reap each work against a real scratch repo.

Constraint from [Recap doc and dogfood report formats](11-recap-dogfood-formats.md) (2026-07-18): at worktree creation, add `kb/` and `checks/` to the worktree's `.git/info/exclude` — workflow-generated files never reach the branch or the target repo's `.gitignore`.

## Superseded (2026-07-18)

Superseded by vertical slices: claim/create → [25](25-claim-cuts-worktree.md); re-claim reuse → [30](30-bounce-machinery.md); startup orphan handling → [41](41-crash-policy-sweeps.md); Done sweep → [42](42-done-sweep.md).
