# Preview environments

Type: grilling
Status: open

## Question

How does Tracker spin up a running app from a ticket's branch so the human can manually walk the acceptance criteria during review? Decide: per-project run configuration (command, port, readiness check — set once per project, since repos are arbitrary but adapters are out of scope), whether the preview runs from the ticket's worktree or a fresh checkout, lifecycle (start from review wizard, stop on verdict), port allocation across concurrent previews, and how the wizard's Manual Walkthrough step links to it.
