# Ticket dependencies gate the claim, not the promote

Tickets carry "blocked by" edges (`ticket_deps`) so an initiative breakdown can land in dependency order without the human hand-scheduling promotions. The gate lives in one place: `claimNextTicket` skips any ticket with a blocker not yet `done`. Promote stays the deliberate intent action — a blocked ticket may be promoted at once and simply waits in Todo; the blocker reaching Done emits the same `ticket.updated` every state change does, which wakes the pool and makes the dependent claimable with zero extra machinery.

Acyclicity is by construction, not traversal: an edge may only point at a ticket that already exists (API `blockedBy` takes real ids; a breakdown's tickets may only reference earlier positions in the same batch). No cycle can be written, so nothing ever has to detect one.

Considered: promote-gating (rejected — it turns the human back into the scheduler the feature exists to replace, and auto-promote-on-unblock would need repo/provider decisions no one made); a general DAG with cycle detection (rejected — write-order already proves acyclicity); workflow-graph-style labeled edges between tickets (rejected — tickets need exactly one relation, "waits for").
