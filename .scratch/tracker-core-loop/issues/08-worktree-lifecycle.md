# Worktree lifecycle and claim/lease semantics

Type: grilling
Status: open
Blocked by: 05

## Question

How are worktrees and claims managed for the 3-worker pool? Decide: worktree location and naming (prototype: `<repos-dir>/<repo>--<ticket-id>`, cut from the project's target branch), branch naming (`<type>/<ticket-id>-<slug>`), when worktrees are created and destroyed (on claim / on merge / on bounce), claim/lease semantics (prototype shows claim + lease-released events — lease duration? stale-lease recovery after crash or app quit?), what happens to a worktree when a ticket bounces back to In Progress, and disk hygiene for abandoned worktrees.
