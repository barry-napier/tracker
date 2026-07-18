# Evidence gates live outside the workflow graph

Workflows are user-buildable, so the obvious composable move is to make verification steps nodes the builder can place. We keep gates orchestrator-side instead: whatever workflow ran, completion sends the ticket to Verifying and the fixed gate battery judges the outcome against the acceptance criteria and the ticket's value statement. Workflow phases exist to perform the work and to produce evidence artifacts — insight into what was understood and decided — not to verify it. This preserves the trust model (agent results cannot be self-reported) across any user-built workflow: users customize how work gets done, never whether it gets checked.

The `gate requirements` column on `workflow_nodes` remains in the schema for future per-node gating but is unused in v1. The prototype's fine-grained verify phases (thermo-audit, ci-check, verify-*) predate the gate battery and are absorbed by it, not ported as nodes.

Considered: gates as workflow nodes (rejected — a user could build a workflow with no verification, dissolving the agent/orchestrator boundary); a single agent-side pre-flight verify node (rejected — redundant work per run and blurs the same boundary).
